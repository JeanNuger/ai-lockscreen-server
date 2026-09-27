const express = require('express');
const { searchCities, nearestCity } = require('../cities');
const { resolveGeolocation, isPrivateOrLocalIp } = require('../weather');

const router = express.Router();

// GET /api/v1/cities/search?q=...&lang=...
// Returns up to 10 GeoNames cities whose name/asciiname/alternatename starts
// with q (case-insensitive), sorted by population descending. `name` in each
// result is whichever name string actually matched the query, falling back
// to the city's primary name -- see src/cities.js's searchCities.
router.get('/cities/search', (req, res, next) => {
  try {
    const { q } = req.query;
    res.status(200).json(searchCities(typeof q === 'string' ? q : ''));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/cities/suggest
// Suggests the nearest known city to the requesting IP's geolocation, purely
// as a prefill hint for the survey's city picker -- the user still chooses
// (see PRODUCT_REBUILD_PLAN.md: "подсказка — по IP"). Never logs the raw IP
// (project-wide convention, see weather.js), only the resolved suggestion.
router.get('/cities/suggest', async (req, res, next) => {
  try {
    if (isPrivateOrLocalIp(req.ip)) {
      return res.status(200).json({ city: null });
    }
    const geo = await resolveGeolocation(req.ip);
    if (!geo || typeof geo.latitude !== 'number' || typeof geo.longitude !== 'number') {
      return res.status(200).json({ city: null });
    }
    const city = nearestCity(geo.latitude, geo.longitude);
    if (!city) {
      return res.status(200).json({ city: null });
    }
    res.status(200).json({
      city: {
        geoname_id: city.id,
        name: city.name,
        country_code: city.countryCode,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
