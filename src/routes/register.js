const express = require('express');
const db = require('../db');
const { getCityById } = require('../cities');

const router = express.Router();

const upsertStatement = db.prepare(`
  INSERT INTO devices (
    device_id, name, gender, birth_date, interests, personal_goal, tone, timezone,
    city_geoname_id, city_name, city_country_code, city_lat, city_lon, updated_at
  )
  VALUES (
    @device_id, @name, @gender, @birth_date, @interests, @personal_goal, @tone, @timezone,
    @city_geoname_id, @city_name, @city_country_code, @city_lat, @city_lon, datetime('now')
  )
  ON CONFLICT(device_id) DO UPDATE SET
    name = excluded.name,
    gender = excluded.gender,
    birth_date = excluded.birth_date,
    interests = excluded.interests,
    personal_goal = excluded.personal_goal,
    tone = excluded.tone,
    timezone = excluded.timezone,
    city_geoname_id = excluded.city_geoname_id,
    city_name = excluded.city_name,
    city_country_code = excluded.city_country_code,
    city_lat = excluded.city_lat,
    city_lon = excluded.city_lon,
    updated_at = datetime('now')
`);

// POST /api/v1/register
// body: { device_id, name?, gender?, birth_date?, interests?: string[], personal_goal?, tone?, timezone?, city_geoname_id? }
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
    const { device_id, name, gender, birth_date, interests, personal_goal, tone, timezone, city_geoname_id } = req.body || {};

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
      // NULL, not as an empty-string row value, matching gender/personal_goal/
      // tone's existing behavior exactly.
      name: name || null,
      gender: gender || null,
      birth_date: birth_date || null,
      interests: Array.isArray(interests) ? JSON.stringify(interests) : null,
      personal_goal: personal_goal || null,
      tone: tone || null,
      timezone: timezone || null,
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
