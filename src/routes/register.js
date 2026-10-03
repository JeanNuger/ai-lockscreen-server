const express = require('express');
const db = require('../db');
const { getCityById } = require('../cities');
const { cleanLanguageCode } = require('../dayRotation');
const { _test: { SUPPORTED_LANGUAGES } } = require('../contentGenerator');

const router = express.Router();

const upsertStatement = db.prepare(`
  INSERT INTO devices (
    device_id, name, gender, birth_date, interests, timezone, learning_language,
    city_geoname_id, city_name, city_country_code, city_lat, city_lon, updated_at
  )
  VALUES (
    @device_id, @name, @gender, @birth_date, @interests, @timezone, @learning_language,
    @city_geoname_id, @city_name, @city_country_code, @city_lat, @city_lon, datetime('now')
  )
  ON CONFLICT(device_id) DO UPDATE SET
    name = excluded.name,
    gender = excluded.gender,
    birth_date = excluded.birth_date,
    interests = excluded.interests,
    timezone = excluded.timezone,
    -- a re-register without the field keeps the language chosen earlier
    learning_language = COALESCE(excluded.learning_language, devices.learning_language),
    city_geoname_id = excluded.city_geoname_id,
    city_name = excluded.city_name,
    city_country_code = excluded.city_country_code,
    city_lat = excluded.city_lat,
    city_lon = excluded.city_lon,
    updated_at = datetime('now')
`);

// POST /api/v1/register
// body: { device_id, name?, gender?, birth_date?, interests?: string[], timezone?, city_geoname_id?, learning_language? }
// (personal_goal/tone were dropped from the app; old clients may still send them -- ignored.
// The devices columns stay in the table, they are just no longer written.)
// Stores/updates the survey answers for a device. No auth beyond the device_id
// itself — see PRODUCT_REBUILD_PLAN.md §3 ("В MVP не входит: сложные аккаунты").
//
// city_geoname_id: optional id from GET /api/v1/cities/search or
// /cities/suggest (see routes/cities.js). Name/country/lat/lon are resolved
// from the server's own city database (src/cities.js), never trusting
// client-supplied coordinates — an unknown/invalid id is silently ignored
// (stored as "no city", same as if the field were omitted) rather than
// failing the whole request, per product decision.
router.post('/register', (req, res, next) => {
  try {
    const { device_id, name, gender, birth_date, interests, timezone, city_geoname_id, learning_language } = req.body || {};

    if (!device_id || typeof device_id !== 'string') {
      return res.status(400).json({ error: 'device_id is required' });
    }

    const city = city_geoname_id !== undefined && city_geoname_id !== null
      ? getCityById(city_geoname_id)
      : null;

    upsertStatement.run({
      device_id,
      // name || null: same "falsy in, NULL stored" normalization every other
      // optional field here already gets — an empty string from the client
      // (e.g. IdentificationActivity's name field left blank) is stored as
      // NULL, not as an empty-string row value.
      name: name || null,
      gender: gender || null,
      birth_date: birth_date || null,
      interests: Array.isArray(interests) ? JSON.stringify(interests) : null,
      timezone: timezone || null,
      learning_language: cleanLanguageCode(learning_language, SUPPORTED_LANGUAGES),
      city_geoname_id: city ? city.id : null,
      city_name: city ? city.name : null,
      city_country_code: city ? city.countryCode : null,
      city_lat: city ? city.lat : null,
      city_lon: city ? city.lon : null,
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
