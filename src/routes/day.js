const express = require('express');
const db = require('../db');
const { resolveLocalDateContext, addDaysToDateString, _test: generatorTest } = require('../contentGenerator');
const { parseDeviceSignals } = require('../deviceSignals');
const { resolveWeather, resolveGeolocation, resolveWeatherByCoords } = require('../weather');
const { selectBankRowsForDay } = require('../dailyContentBank');
const { generateDay, applyWordPairRule } = require('../dayPlan');
const { cleanLanguageCode } = require('../dayRotation');
const { parseYesterdayPhoneData, recordPhoneDay, buildPhoneYesterday } = require('../phoneDay');
const { _test: batchHelpers } = require('./batch');

const router = express.Router();
const inFlightDayRequests = new Map();

const getDeviceStatement = db.prepare('SELECT * FROM devices WHERE device_id = ?');
const insertStubDeviceStatement = db.prepare('INSERT OR IGNORE INTO devices (device_id) VALUES (?)');
const updateDeviceTimezoneStatement = db.prepare(
  'UPDATE devices SET timezone = ?, updated_at = datetime(\'now\') WHERE device_id = ?'
);
const updateDeviceLearningLanguageStatement = db.prepare(
  'UPDATE devices SET learning_language = ?, updated_at = datetime(\'now\') WHERE device_id = ?'
);
const selectDayPlanStatement = db.prepare(`
  SELECT id, phrases, source, trace_json FROM day_plans WHERE device_id = ? AND local_date = ?
`);
const insertDayPlanStatement = db.prepare(`
  INSERT OR IGNORE INTO day_plans (device_id, local_date, phrases, source, trace_json)
  VALUES (?, ?, ?, ?, ?)
`);

// Night (20:00-05:00) spans midnight: a request at 02:00 belongs to the day that started the evening
// before, not to the new calendar date, as long as that day's plan exists. Without it (new install in
// the small hours) the new date is planned: its morning is only a few hours away.
const NIGHT_ENDS = '05:00';

function cleanOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanLocalDate(value) {
  const cleaned = cleanOptionalString(value);
  return cleaned && /^\d{4}-\d{2}-\d{2}$/.test(cleaned) ? cleaned : null;
}

function parsePhrases(row) {
  try {
    const phrases = JSON.parse(row.phrases);
    return Array.isArray(phrases) ? phrases : [];
  } catch (err) {
    return [];
  }
}

function hasRequiredProfile(device) {
  return Boolean(device
    && typeof device.name === 'string' && device.name.trim()
    && typeof device.birth_date === 'string' && device.birth_date.trim());
}

function buildResponseBody({ phrases, device, date, source }) {
  const body = { date, source, phrases };
  if (!hasRequiredProfile(device)) {
    body.profile_required = true;
  }
  return body;
}

// The forecast and the country of the user's day: the picked city outranks IP geolocation (same rule
// as /batch, see routes/batch.js).
async function resolveDayWeather(device, ip, localDate) {
  if (batchHelpers.deviceHasCity(device)) {
    return resolveWeatherByCoords(device.city_lat, device.city_lon, {
      countryCode: device.city_country_code,
      city: device.city_name,
      localDate,
      timeZone: device.timezone,
    });
  }
  const geo = await resolveGeolocation(ip);
  const mismatch = batchHelpers.resolveLocationMismatch(geo, device.timezone);
  if (mismatch) {
    return { countryCode: mismatch.tz_country, countrySource: 'timezone' };
  }
  return resolveWeather(ip, geo, { localDate, timeZone: device.timezone });
}

// GET /api/v1/day?device_id=...&timezone=...&local_date=YYYY-MM-DD&system_language=ru
//     [&learning_language=en][&yesterday_steps=N&yesterday_unlocks=N&yesterday_screen_seconds=N]
// Returns the whole day, one model call per device and local date:
//   { date, source, phrases: [{ slot_id, window, position, type, text, style_id, requires_shown_text?,
//     interest? (interest_fact), learning_language? (foreign_word / foreign_recall / foreign_answer) }] }
// The phone writes the rubric of a phrase from type (+ interest / learning_language).
// The same device and date again is answered from day_plans without a model call. The night word recall
// (night 8 + 9) and the foreign-word recall (evening 2 + 3) are left out when the device reports shown
// phrases and the morning phrase they ask about was not shown.
router.get('/day', async (req, res, next) => {
  const requestStartMs = Date.now();
  try {
    const { device_id: deviceId } = req.query;
    if (!deviceId || typeof deviceId !== 'string') {
      return res.status(400).json({ error: 'device_id is required' });
    }

    const signals = parseDeviceSignals(req.query);
    const requestTimezone = cleanOptionalString(req.query.timezone);
    const requestLocalDate = cleanLocalDate(req.query.local_date);
    const device = getDeviceStatement.get(deviceId) || { device_id: deviceId };
    insertStubDeviceStatement.run(deviceId);
    if (requestTimezone) {
      updateDeviceTimezoneStatement.run(requestTimezone, deviceId);
      device.timezone = requestTimezone;
    }

    // The foreign language the user learns: a valid code on the request is stored on the device (like the
    // timezone); without one the profile's value is used, else the default of the user's language (generateDay).
    const requestLearningLanguage = cleanLanguageCode(req.query.learning_language, generatorTest.SUPPORTED_LANGUAGES);
    if (requestLearningLanguage) {
      updateDeviceLearningLanguageStatement.run(requestLearningLanguage, deviceId);
      device.learning_language = requestLearningLanguage;
    }

    const { dateContext } = resolveLocalDateContext(device.timezone, requestLocalDate);
    const localDate = (dateContext && dateContext.date) || requestLocalDate || new Date().toISOString().slice(0, 10);
    const localTime = dateContext ? dateContext.time : null;

    // Yesterday's phone numbers are stored on every request (also a cached one): they are the baseline of later days.
    const phoneData = parseYesterdayPhoneData(req.query);
    const yesterday = addDaysToDateString(localDate, -1);
    const phoneYesterday = buildPhoneYesterday(deviceId, yesterday, phoneData);
    if (phoneData) {
      recordPhoneDay(deviceId, yesterday, phoneData);
    }

    let planDate = localDate;
    // Only when the phone did not name the date: a phone that sends local_date says exactly which day it wants.
    if (localTime && localTime < NIGHT_ENDS && !requestLocalDate) {
      const previous = addDaysToDateString(localDate, -1);
      if (previous && selectDayPlanStatement.get(deviceId, previous)) {
        planDate = previous;
      }
    }

    const serve = (row, cacheHit) => {
      const phrases = applyWordPairRule(parsePhrases(row), deviceId, localTime);
      console.log(`[day] device_id=${deviceId} date=${planDate} cache_hit=${cacheHit} phrases=${phrases.length} request_ms=${Date.now() - requestStartMs}`);
      return buildResponseBody({ phrases, device, date: planDate, source: row.source });
    };

    const cached = selectDayPlanStatement.get(deviceId, planDate);
    if (cached) {
      return res.status(200).json(serve(cached, true));
    }

    const key = `${deviceId}|${planDate}`;
    if (inFlightDayRequests.has(key)) {
      const row = await inFlightDayRequests.get(key);
      return res.status(200).json(row ? serve(row, true) : buildResponseBody({ phrases: [], device, date: planDate, source: 'fallback' }));
    }

    const generation = (async () => {
      const planContext = resolveLocalDateContext(device.timezone, planDate).dateContext || dateContext;
      // A failed weather lookup only costs the weather slot, never the day.
      const weather = await resolveDayWeather(device, req.ip, planDate).catch((err) => {
        console.warn(`[day] weather_failed device_id=${deviceId} error=${err.name || 'Error'}`);
        return null;
      });
      const countryCode = (weather && typeof weather.countryCode === 'string' && weather.countryCode)
        || device.city_country_code
        || (signals && typeof signals.region === 'string' ? signals.region : null);
      const bank = selectBankRowsForDay(planDate);
      const result = await generateDay({
        device,
        languageCode: generatorTest.resolveTargetLanguageCode(signals),
        learningLanguage: requestLearningLanguage,
        dateContext: planContext,
        weather,
        countryCode: countryCode ? countryCode.toUpperCase() : null,
        phoneYesterday,
        bank,
      });
      if (result.source !== 'openai' || result.phrases.length === 0) {
        console.warn(`[day] device_id=${deviceId} date=${planDate} not cached reason=${result.reason || 'empty'}`);
        return null;
      }
      const trace = JSON.stringify({
        model_usage: result.usage,
        repair: result.repair,
        dropped: result.dropped,
        echoes: result.echoes,
        holiday_kind: result.holiday_kind,
        word: result.word,
        foreign_word: result.foreign_word,
        learning_language: result.learning_language,
        interest: result.interest,
        generation_ms: result.generation_ms,
        weather_country: countryCode || null,
      });
      insertDayPlanStatement.run(deviceId, planDate, JSON.stringify(result.phrases), result.source, trace);
      return selectDayPlanStatement.get(deviceId, planDate);
    })();

    inFlightDayRequests.set(key, generation);
    let row;
    try {
      row = await generation;
    } finally {
      inFlightDayRequests.delete(key);
    }
    if (!row) {
      return res.status(200).json(buildResponseBody({ phrases: [], device, date: planDate, source: 'fallback' }));
    }
    return res.status(200).json(serve(row, false));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports._test = { resolveDayWeather, NIGHT_ENDS };
