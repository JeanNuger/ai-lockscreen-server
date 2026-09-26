const express = require('express');
const db = require('../db');
const { WINDOWS } = require('../constants');
const { generateBatch, resolveLocalDateContext, addDaysToDateString } = require('../contentGenerator');
const { consumePendingMessages } = require('../adminMessages');
const { parseDeviceSignals } = require('../deviceSignals');
const { computePhoneTrends, recordPhoneSignalSample } = require('../phoneAnalytics');
const { resolveWeather, resolveGeolocation } = require('../weather');
const morningPack = require('../morningPack');
const { countryForTimezone } = require('../timezoneCountry');

const router = express.Router();
const inFlightBatchRequests = new Map();
const getOrGenerateMorningPack = morningPack.getOrGenerateMorningPack;
const getExistingMorningPack = morningPack.getExistingMorningPack || (() => null);
const computeTargetDate = morningPack.computeTargetDate || ((window, dateContext) => {
  if (!dateContext || typeof dateContext.date !== 'string') {
    return null;
  }
  return window === 'night' ? (dateContext.tomorrow_date || dateContext.date) : dateContext.date;
});

const getDeviceStatement = db.prepare('SELECT * FROM devices WHERE device_id = ?');
// Minimal stub row for devices that call /batch before ever calling /register —
// content_batches.device_id has a FOREIGN KEY into devices, so a batch can't be
// logged for a device that doesn't exist yet. INSERT OR IGNORE keeps this a
// no-op for already-registered devices instead of overwriting their survey answers.
const insertStubDeviceStatement = db.prepare(
  'INSERT OR IGNORE INTO devices (device_id) VALUES (?)'
);
const updateDeviceTimezoneStatement = db.prepare(
  'UPDATE devices SET timezone = ?, updated_at = datetime(\'now\') WHERE device_id = ?'
);
const insertBatchStatement = db.prepare(`
  INSERT INTO content_batches (device_id, window, local_date, supports_morning_pack, phrases, source, context)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const updateBatchTraceStatement = db.prepare(`
  UPDATE content_batches SET trace_json = ? WHERE id = ?
`);
const selectReusableBatchStatement = db.prepare(`
  SELECT id, phrases, source, trace_json
  FROM content_batches
  WHERE device_id = ?
    AND window = ?
    AND local_date = ?
    AND supports_morning_pack = ?
  ORDER BY id DESC
`);

function cleanOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanLocalDate(value) {
  const cleaned = cleanOptionalString(value);
  return cleaned && /^\d{4}-\d{2}-\d{2}$/.test(cleaned) ? cleaned : null;
}

// IP-vs-timezone location sanity check (production incident, batch_id 19,
// 2026-09-26): the ipwho.is geolocation of the request's IP can be wrong
// (VPN, corporate proxy, or — as in that trace — a hosting-region proxy
// artifact even after the trust-proxy fix in server.js). The phone's own
// IANA timezone (an existing, independently-sent request param -- see
// deviceSignals/the timezone query param read in the route below) gives a
// second, unrelated signal for "what country is this phone actually in".
// When the two disagree, per product decision (see this task's spec): the
// TIMEZONE's country wins for content purposes, and IP-based weather (which
// would describe the wrong city entirely) is dropped rather than
// substituted with anything else.
//
// Returns null when there's nothing to compare (no IP-resolved country, no
// mappable timezone country) or when they agree -- both treated as "no
// mismatch", i.e. fail open to the existing behavior rather than flagging a
// mismatch on missing data.
function resolveLocationMismatch(geo, timezone) {
  const ipCountry = geo && typeof geo.country_code === 'string' && geo.country_code
    ? geo.country_code.toUpperCase()
    : null;
  const tzCountry = countryForTimezone(timezone);
  if (!ipCountry || tzCountry === 'unknown') {
    return null;
  }
  if (ipCountry === tzCountry) {
    return null;
  }
  return { ip_country: ipCountry, tz_country: tzCountry };
}

// requestMs (optional): total wall-clock time for the whole /batch request
// (batch generation + pack generation running concurrently, DB writes, etc.)
// -- observation-only, see the route handler's own requestStartMs comment.
// Distinct from trace.meta.generation_ms (contentGenerator.js), which only
// covers the ordinary batch's own generateBatch() call.
function finalizeBatchTrace(trace, batchId, requestMs, locationMismatch) {
  if (!trace || typeof trace !== 'object') {
    return null;
  }
  try {
    const finalizedTrace = {
      ...trace,
      meta: {
        ...(trace.meta || {}),
        batch_id: batchId,
        request_ms: typeof requestMs === 'number' ? requestMs : null,
      },
      // Only present when the IP-resolved country and the phone timezone's
      // country disagreed for this request (see resolveLocationMismatch) --
      // absent entirely (not `null`) in the ordinary matching case, per this
      // task's spec ("matching case ... no location_mismatch field").
      ...(locationMismatch ? { location_mismatch: locationMismatch } : {}),
    };
    return JSON.stringify(finalizedTrace);
  } catch (err) {
    console.warn(`BATCH_TRACE_ERROR stage=finalize error=${err.name || 'Error'}`);
    return null;
  }
}

function logBatchTrace(traceJson) {
  if (!traceJson || process.env.BATCH_TRACE_LOG === '0') {
    return;
  }
  try {
    console.log(`[batch-trace] ${traceJson}`);
  } catch (err) {
    console.warn(`BATCH_TRACE_ERROR stage=stdout error=${err.name || 'Error'}`);
  }
}

function hasRequiredProfile(device) {
  return Boolean(device
    && typeof device.name === 'string'
    && device.name.trim()
    && typeof device.birth_date === 'string'
    && device.birth_date.trim());
}

function appendProfileRequired(responseBody, device) {
  if (!hasRequiredProfile(device)) {
    responseBody.profile_required = true;
  }
  return responseBody;
}

function parseBatchPhrases(row) {
  if (!row || typeof row.phrases !== 'string') {
    return [];
  }
  try {
    const phrases = JSON.parse(row.phrases);
    return Array.isArray(phrases) ? phrases : [];
  } catch (err) {
    return [];
  }
}

function isWholeBatchFallback(row) {
  if (!row) {
    return false;
  }
  if (row.source === 'fallback') {
    return true;
  }
  if (!row.trace_json) {
    return false;
  }
  try {
    const trace = JSON.parse(row.trace_json);
    return Boolean(trace && trace.whole_batch_fallback && trace.whole_batch_fallback.flag);
  } catch (err) {
    return false;
  }
}

function isReusableNormalBatch(row) {
  return Boolean(row && row.source === 'openai' && !isWholeBatchFallback(row));
}

function selectReusableBatch(deviceId, window, localDate, supportsMorningPack) {
  if (!deviceId || !window || !localDate) {
    return null;
  }
  const rows = selectReusableBatchStatement.all(deviceId, window, localDate, supportsMorningPack ? 1 : 0);
  if (rows.length === 0) {
    return null;
  }
  const latestNormal = rows.find((row) => isReusableNormalBatch(row));
  if (latestNormal) {
    return latestNormal;
  }
  const fallbackRows = rows.filter((row) => isWholeBatchFallback(row));
  return fallbackRows.length >= 2 ? fallbackRows[0] : null;
}

// The 'night' window spans midnight: a request at 19:30 on day D (the night
// just starting) and a "recovery" request at 02:00 on day D+1 (still the
// same night, clock already past midnight) are logically the SAME batch
// occasion and must reuse the SAME cached batch/reuse key -- not regenerate
// just because the device's calendar date rolled over between them. Uses the
// date the night STARTED: dateContext.date as-is when local time is already
// >= 05:00 (still "that evening"), else dateContext.date minus one day (the
// request landed after midnight, within the night that began the day
// before). Every other window's reuse key is unaffected -- returns
// dateContext.date unchanged for them, same as before this function existed.
function nightReuseKeyDate(window, dateContext) {
  if (!dateContext || typeof dateContext.date !== 'string') {
    return null;
  }
  if (window !== 'night') {
    return dateContext.date;
  }
  const time = typeof dateContext.time === 'string' ? dateContext.time : null;
  if (time && time < '05:00') {
    return addDaysToDateString(dateContext.date, -1);
  }
  return dateContext.date;
}

function batchCacheKey(deviceId, window, localDate, supportsMorningPack) {
  return [deviceId, window, localDate, supportsMorningPack ? 'pack' : 'plain'].join('|');
}

function buildCacheHitTrace(row, window, localDate, requestMs) {
  return JSON.stringify({
    meta: {
      cache_hit: true,
      reused_batch_id: row.id,
      window,
      local_date: localDate,
      request_ms: typeof requestMs === 'number' ? requestMs : null,
    },
  });
}

function buildResponseBody({ phrases, supportsMorningPack, batchId, morningPack, device }) {
  const responseBody = { phrases };
  if (supportsMorningPack) {
    responseBody.batch_id = batchId;
    responseBody.morning_pack = morningPack;
  }
  return appendProfileRequired(responseBody, device);
}

function responseFromCachedBatch(row, { device, window, localDate, supportsMorningPack, targetDate, requestStartMs }) {
  const adminPhrases = consumePendingMessages(device.device_id);
  const phrases = [...parseBatchPhrases(row), ...adminPhrases];
  const traceJson = buildCacheHitTrace(row, window, localDate, Date.now() - requestStartMs);
  logBatchTrace(traceJson);
  const morningPack = supportsMorningPack ? getExistingMorningPack(device.device_id, targetDate) : null;
  return buildResponseBody({
    phrases,
    supportsMorningPack,
    batchId: row.id,
    morningPack,
    device,
  });
}

// GET /api/v1/batch?device_id=...&window=morning|day|evening|night
// Optional device-signal params (see src/deviceSignals.js): battery_level,
// ambient_light, screen_on_duration_seconds, steps_since_last_batch — all
// independently optional, malformed values are ignored rather than
// rejecting the request (see deviceSignals.js for why).
// Returns { phrases: [{ text, style_id }, ...] } — see PRODUCT_REBUILD_PLAN.md §4.1.
// No client-supplied geodata is accepted or used, by design (§4.1 "без геоданных").
// Weather is the one exception, and it's resolved server-side from the request's
// own IP address (src/weather.js) — never a client-sent location — per §5.1's
// "вычисляется сервером" decision.
//
// Any pending admin messages (targeted at this device, or broadcast to all
// devices) are appended to the normal AI/fallback batch, not substituted for
// it — per product decision, an admin message is one extra phrase mixed into
// the regular rotation, not a takeover of the whole batch.
//
// Morning pack (optional, backward-compatible extension): a client that
// sends supports_morning_pack=1 additionally gets a `batch_id` and a
// `morning_pack` field in the response — see PRODUCT_REBUILD_PLAN.md and
// src/morningPack.js/src/contentGenerator.js's generateMorningPack for the
// full design. Without that param, the response is byte-identical to before
// this feature existed — no batch_id, no morning_pack key at all.
router.get('/batch', async (req, res, next) => {
  // Observation-only: total wall-clock time for the whole request, logged
  // into [batch-trace]'s meta.request_ms below -- covers everything (device
  // lookup, weather/geo resolution, concurrent batch+pack generation, DB
  // writes), not just generateBatch's own work (see contentGenerator.js's
  // separate meta.generation_ms for that).
  const requestStartMs = Date.now();
  try {
    const { device_id, window } = req.query;

    if (!device_id || typeof device_id !== 'string') {
      return res.status(400).json({ error: 'device_id is required' });
    }
    if (!WINDOWS.includes(window)) {
      return res.status(400).json({ error: `window must be one of: ${WINDOWS.join(', ')}` });
    }

    const signals = parseDeviceSignals(req.query);

    const requestTimezone = cleanOptionalString(req.query.timezone);
    const requestLocalDate = cleanLocalDate(req.query.local_date);
    const device = getDeviceStatement.get(device_id) || { device_id };
    insertStubDeviceStatement.run(device_id);
    if (requestTimezone) {
      updateDeviceTimezoneStatement.run(requestTimezone, device_id);
      device.timezone = requestTimezone;
    }

    const supportsMorningPack = req.query.supports_morning_pack === '1';
    const packDateHeld = supportsMorningPack ? cleanLocalDate(req.query.pack_date_held) : null;

    // Computed UP FRONT, before either generateBatch or the pack's own
    // generation starts — resolveLocalDateContext only needs device.timezone
    // (already resolved above) + the optional client-forced local_date, not
    // anything generateBatch computes, so the pack's target_date can be
    // known without waiting on generateBatch's result. This is what makes
    // the Promise.all below possible: previously the pack was generated
    // AFTER generateBatch finished, sequentially, reading dateContext off
    // its return value.
    const { dateContext } = resolveLocalDateContext(device.timezone, requestLocalDate);
    // localDate here is the REUSE-KEY date, not necessarily today's plain
    // calendar date -- see nightReuseKeyDate's own comment for why the
    // 'night' window needs this distinction. Used only for the batch
    // reuse/cache lookup, the cache key, the stored content_batches.local_date
    // column, and the cache-hit trace's local_date field below -- never
    // passed to generateBatch itself (that still gets the raw
    // requestLocalDate/device-local "today", unaffected) and never used for
    // the morning pack's own targetDate (computeTargetDate has its own,
    // different "next upcoming 05:00" rule for night, see morningPack.js).
    const localDate = nightReuseKeyDate(window, dateContext);
    const targetDate = supportsMorningPack ? computeTargetDate(window, dateContext) : null;
    const cacheKey = batchCacheKey(device_id, window, localDate, supportsMorningPack);

    const cachedBatch = selectReusableBatch(device_id, window, localDate, supportsMorningPack);
    if (cachedBatch) {
      recordPhoneSignalSample(device, window, signals);
      return res.status(200).json(responseFromCachedBatch(cachedBatch, {
        device,
        window,
        localDate,
        supportsMorningPack,
        targetDate,
        requestStartMs,
      }));
    }

    if (inFlightBatchRequests.has(cacheKey)) {
      const generated = await inFlightBatchRequests.get(cacheKey);
      recordPhoneSignalSample(device, window, signals);
      return res.status(200).json(responseFromCachedBatch(generated.row, {
        device,
        window,
        localDate,
        supportsMorningPack,
        targetDate,
        requestStartMs,
      }));
    }

    const generationPromise = (async () => {
      // Geolocation is resolved ONCE per request and shared between the
      // current-weather lookup (resolveWeather, needed by the ordinary batch)
      // and the day-forecast lookup inside getOrGenerateMorningPack
      // (resolveWeatherForecast, needed by the pack) — see weather.js's
      // resolveGeolocation. Without this, two concurrent branches each doing
      // their own IP geolocation lookup would double the ipwho.is calls for
      // every request.
      const geo = await resolveGeolocation(req.ip);

      // IP-vs-timezone sanity check (see resolveLocationMismatch above). Uses
      // whichever timezone we actually have for this device right now
      // (requestTimezone if this request just sent one, else the previously
      // stored device.timezone -- device.timezone was already updated from
      // requestTimezone above when present, so this single field always holds
      // the freshest value either way).
      const locationMismatch = resolveLocationMismatch(geo, device.timezone);

      // On a mismatch, IP-based weather must NOT be used at all (it would be
      // describing the wrong city/country entirely) -- skip the Open-Meteo
      // call altogether rather than fetching and discarding it. `weather` still
      // carries the TIMEZONE's country code (never the IP's) so downstream
      // country-dependent content selection (Daily Bank country_fact
      // eligibility, the `now.country` prompt field -- see contentGenerator.js)
      // uses the correct country per the product decision, without needing a
      // second country-plumbing path through generateBatch/generateMorningPack.
      const weather = locationMismatch
        ? { countryCode: locationMismatch.tz_country, countrySource: 'timezone' }
        : await resolveWeather(req.ip, geo);

      if (locationMismatch) {
        // Only the resolved countries are logged here -- never the raw IP
        // (per this project's IP-privacy rule; see weather.js's own comment
        // on the same principle).
        console.warn(
          `LOCATION_MISMATCH ip_country=${locationMismatch.ip_country} tz_country=${locationMismatch.tz_country}`
        );
      }

      const phoneTrends = computePhoneTrends(device, window, signals);

      // Batch generation and pack generation now run CONCURRENTLY rather than
      // sequentially — previously the pack's own OpenAI call(s) started only
      // after generateBatch's had fully finished, in the same request, which
      // could chain up to 4 OpenAI calls back-to-back (2 each with repair) and
      // risk a client-side timeout. A pack failure/timeout must never delay or
      // break the ordinary batch response: the pack promise's own rejection is
      // caught and turned into a resolved `null` outcome right here, so
      // Promise.all only ever waits on two promises that both always resolve.
      const batchPromise = generateBatch(device, window, signals, weather, phoneTrends, {
        localDate: requestLocalDate,
        // The 7 morning-pack types are excluded from ordinary batch planning in
        // every window once the client supports the pack — they're delivered
        // exclusively via morning_pack below (see planSlots' excludeTypes and
        // MORNING_FIXED_TYPES). No-op (undefined) when the flag is absent, so
        // the ordinary response stays byte-identical for old clients.
        excludeMorningPackTypes: supportsMorningPack,
      });

      const packPromise = supportsMorningPack
        ? getOrGenerateMorningPack({
          device,
          window,
          dateContext,
          signals,
          weather,
          ip: req.ip,
          packDateHeld,
          // On a location mismatch, force the pack's own weather-forecast
          // lookup to be skipped too (resolveWeatherForecast short-circuits to
          // null when handed a null geo explicitly) -- same "no IP-based
          // weather at all" rule as the ordinary batch's weather_lifehack
          // above, so the morning pack's weather_lifehack candidate is also
          // never created for a mismatched request (see planMorningPack).
          geo: locationMismatch ? null : geo,
        }).catch((err) => {
          // Defense in depth on top of getOrGenerateMorningPack's own
          // try/catch — a pack failure must NEVER break the ordinary batch
          // response computed concurrently below.
          console.error(`MORNING_PACK_ROUTE_ERROR error=${err.name || 'Error'}`);
          return null;
        })
        : Promise.resolve(null);

      const [{ phrases, source, context, trace }, morningPack] = await Promise.all([batchPromise, packPromise]);

      const adminPhrases = consumePendingMessages(device_id);
      const combinedPhrases = [...phrases, ...adminPhrases];

      const insertResult = insertBatchStatement.run(
        device_id,
        window,
        localDate,
        supportsMorningPack ? 1 : 0,
        JSON.stringify(combinedPhrases),
        source,
        context || null
      );
      const traceJson = finalizeBatchTrace(trace, insertResult.lastInsertRowid, Date.now() - requestStartMs, locationMismatch);
      if (traceJson) {
        updateBatchTraceStatement.run(traceJson, insertResult.lastInsertRowid);
        logBatchTrace(traceJson);
      }

      return {
        row: {
          id: insertResult.lastInsertRowid,
          phrases: JSON.stringify(combinedPhrases),
          source,
          trace_json: traceJson,
        },
        responseBody: buildResponseBody({
          phrases: combinedPhrases,
          supportsMorningPack,
          batchId: insertResult.lastInsertRowid,
          morningPack,
          device,
        }),
      };
    })();

    inFlightBatchRequests.set(cacheKey, generationPromise);
    let generated;
    try {
      generated = await generationPromise;
    } finally {
      inFlightBatchRequests.delete(cacheKey);
    }

    recordPhoneSignalSample(device, window, signals);
    res.status(200).json(generated.responseBody);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports._test = { resolveLocationMismatch, finalizeBatchTrace, nightReuseKeyDate };
