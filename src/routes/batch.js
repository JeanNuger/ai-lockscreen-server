const express = require('express');
const db = require('../db');
const { WINDOWS } = require('../constants');
const { generateBatch, resolveLocalDateContext, addDaysToDateString } = require('../contentGenerator');
const { consumePendingMessages } = require('../adminMessages');
const { parseDeviceSignals } = require('../deviceSignals');
const { computePhoneTrends, recordPhoneSignalSample } = require('../phoneAnalytics');
const { resolveWeather, resolveGeolocation, resolveWeatherByCoords } = require('../weather');
const { countryForTimezone } = require('../timezoneCountry');

const router = express.Router();
const inFlightBatchRequests = new Map();
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
  VALUES (?, ?, ?, 0, ?, ?, ?)
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
    AND supports_morning_pack = 0
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
// source: 'city' when the device has picked a city (weather/country resolved
// from src/cities.js, no IP lookup at all — see the hasCity branch in the
// route handler below), 'ip' for the ordinary IP-geolocation path. Threaded
// into trace.meta.weather_status.source for admin/debugging visibility.
function buildWeatherStatus(geo, weather, locationMismatch, source) {
  const geoStatus = source === 'city' ? 'skipped' : !geo ? 'skipped' : geo.success === false ? 'failed' : 'ok';
  const weatherStatus = locationMismatch
    ? 'skipped_mismatch'
    : weather && typeof weather.temperatureC === 'number'
      ? 'ok'
      : 'failed';
  // The exact reason a weather lookup failed (see weather.js's WEATHER_FAILED
  // log line): http_429, timeout, network_error:<code>, no_coordinates, ...
  const failureReason = weatherStatus !== 'failed'
    ? undefined
    : weather && weather.weatherFailure
      ? weather.weatherFailure
      : weather ? 'no_temperature' : 'no_geolocation';
  return {
    geo: geoStatus,
    weather: weatherStatus,
    provider: 'met.no',
    ...(failureReason ? { reason: failureReason } : {}),
    source: source === 'city' ? 'city' : 'ip',
    country: weather && typeof weather.countryCode === 'string' && weather.countryCode
      ? weather.countryCode
      : geo && typeof geo.country_code === 'string' && geo.country_code
        ? geo.country_code
        : null,
    city: weather && typeof weather.city === 'string' && weather.city
      ? weather.city
      : geo && typeof geo.city === 'string' && geo.city
        ? geo.city
        : null,
  };
}

// Whether this device has picked a city in the survey (see routes/register.js
// / src/cities.js) — when true, weather/country resolve from that city's own
// coordinates/country instead of IP geolocation, and the IP-vs-timezone
// mismatch check is skipped entirely (there's no IP-derived country to
// compare against a mismatch in the first place). Per product decision, a
// chosen city always outranks IP — see PRODUCT_REBUILD_PLAN.md.
function deviceHasCity(device) {
  return Boolean(
    device
    && device.city_geoname_id != null
    && typeof device.city_lat === 'number'
    && typeof device.city_lon === 'number'
  );
}

function finalizeBatchTrace(trace, batchId, requestMs, locationMismatch, weatherStatus) {
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
        weather_status: weatherStatus || null,
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

// A whole-batch fallback (empty phrases -- see contentGenerator.js's
// buildLoggedFallbackResult) is NEVER reused, no matter how many of them
// pile up for this key: the server has no ready-made phrases to hand back a
// second time, so every request after a fallback must try OpenAI again,
// instead of quietly serving an empty batch from cache. Rows are ordered
// DESC by id, so this returns the most recent real ('openai', non-fallback)
// batch, or null if there isn't one yet.
function selectReusableBatch(deviceId, window, localDate) {
  if (!deviceId || !window || !localDate) {
    return null;
  }
  const rows = selectReusableBatchStatement.all(deviceId, window, localDate);
  return rows.find((row) => isReusableNormalBatch(row)) || null;
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

function batchCacheKey(deviceId, window, localDate) {
  return [deviceId, window, localDate].join('|');
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

function buildResponseBody({ phrases, device }) {
  return appendProfileRequired({ phrases }, device);
}

function responseFromCachedBatch(row, { device, window, localDate, requestStartMs }) {
  const adminPhrases = consumePendingMessages(device.device_id);
  const phrases = [...parseBatchPhrases(row), ...adminPhrases];
  const traceJson = buildCacheHitTrace(row, window, localDate, Date.now() - requestStartMs);
  logBatchTrace(traceJson);
  return buildResponseBody({ phrases, device });
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
router.get('/batch', async (req, res, next) => {
  // Observation-only: total wall-clock time for the whole request, logged
  // into [batch-trace]'s meta.request_ms below -- covers everything (device
  // lookup, weather/geo resolution, generation, DB writes), not just generateBatch's own work (see contentGenerator.js's
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

    const { dateContext } = resolveLocalDateContext(device.timezone, requestLocalDate);
    // localDate here is the REUSE-KEY date, not necessarily today's plain
    // calendar date -- see nightReuseKeyDate's own comment for why the
    // 'night' window needs this distinction. Used only for the batch
    // reuse/cache lookup, the cache key, the stored content_batches.local_date
    // column, and the cache-hit trace's local_date field below -- never
    // passed to generateBatch itself (that still gets the raw
    // requestLocalDate/device-local "today", unaffected).
    const localDate = nightReuseKeyDate(window, dateContext);
    const cacheKey = batchCacheKey(device_id, window, localDate);

    const cachedBatch = selectReusableBatch(device_id, window, localDate);
    if (cachedBatch) {
      recordPhoneSignalSample(device, window, signals);
      return res.status(200).json(responseFromCachedBatch(cachedBatch, {
        device,
        window,
        localDate,
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
        requestStartMs,
      }));
    }

    const hasCity = deviceHasCity(device);
    // The forecast is for the user's LOCAL date (see weather.js).
    const weatherLocalDate = dateContext && typeof dateContext.date === 'string' ? dateContext.date : null;

    const generationPromise = (async () => {
      // City outranks IP entirely (see deviceHasCity/PRODUCT_REBUILD_PLAN.md):
      // no ipwho.is call at all in this branch, weather comes from the
      // city's own coordinates, and there's no IP-derived country to run the
      // IP-vs-timezone sanity check against (that check exists specifically
      // to catch a wrong IP geolocation, which is moot once the country isn't
      // coming from IP in the first place).
      let geo = null;
      let locationMismatch = null;
      let weather;

      if (hasCity) {
        weather = await resolveWeatherByCoords(device.city_lat, device.city_lon, {
          countryCode: device.city_country_code,
          city: device.city_name,
          localDate: weatherLocalDate,
          timeZone: device.timezone,
        });
      } else {
        // Geolocation is resolved ONCE per request and shared between the
        // current-weather lookup (resolveWeather, needed by the ordinary batch)
        // and the day-forecast lookup inside getOrGenerateMorningPack
        // (resolveWeatherForecast, needed by the pack) — see weather.js's
        // resolveGeolocation. Without this, two concurrent branches each doing
        // their own IP geolocation lookup would double the ipwho.is calls for
        // every request.
        geo = await resolveGeolocation(req.ip);

        // IP-vs-timezone sanity check (see resolveLocationMismatch above). Uses
        // whichever timezone we actually have for this device right now
        // (requestTimezone if this request just sent one, else the previously
        // stored device.timezone -- device.timezone was already updated from
        // requestTimezone above when present, so this single field always holds
        // the freshest value either way).
        locationMismatch = resolveLocationMismatch(geo, device.timezone);

        // On a mismatch, IP-based weather must NOT be used at all (it would be
        // describing the wrong city/country entirely) -- skip the Open-Meteo
        // call altogether rather than fetching and discarding it. `weather` still
        // carries the TIMEZONE's country code (never the IP's) so downstream
        // country-dependent content selection (Daily Bank country_fact
        // eligibility, the `now.country` prompt field -- see contentGenerator.js)
        // uses the correct country per the product decision, without needing a
        // second country-plumbing path through generateBatch/generateMorningPack.
        weather = locationMismatch
          ? { countryCode: locationMismatch.tz_country, countrySource: 'timezone' }
          : await resolveWeather(req.ip, geo, { localDate: weatherLocalDate, timeZone: device.timezone });

        if (locationMismatch) {
          // Only the resolved countries are logged here -- never the raw IP
          // (per this project's IP-privacy rule; see weather.js's own comment
          // on the same principle).
          console.warn(
            `LOCATION_MISMATCH ip_country=${locationMismatch.ip_country} tz_country=${locationMismatch.tz_country}`
          );
        }
      }

      const phoneTrends = computePhoneTrends(device, window, signals);

      const { phrases, source, context, trace } = await generateBatch(device, window, signals, weather, phoneTrends, {
        localDate: requestLocalDate,
      });

      const adminPhrases = consumePendingMessages(device_id);
      const combinedPhrases = [...phrases, ...adminPhrases];

      const insertResult = insertBatchStatement.run(
        device_id,
        window,
        localDate,
        JSON.stringify(combinedPhrases),
        source,
        context || null
      );
      const weatherStatus = buildWeatherStatus(geo, weather, locationMismatch, hasCity ? 'city' : 'ip');
      const traceJson = finalizeBatchTrace(trace, insertResult.lastInsertRowid, Date.now() - requestStartMs, locationMismatch, weatherStatus);
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
        responseBody: buildResponseBody({ phrases: combinedPhrases, device }),
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
module.exports._test = { resolveLocationMismatch, buildWeatherStatus, finalizeBatchTrace, nightReuseKeyDate, deviceHasCity };
