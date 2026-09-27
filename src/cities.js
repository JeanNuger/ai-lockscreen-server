// In-memory city database, loaded once from the compact data file built by
// scripts/build-cities-db.js (src/data/cities.dat, sourced from GeoNames'
// cities15000 dump, CC BY 4.0 -- see README.md for attribution).
//
// Backs the city-picker survey step (device chooses its own city; IP is only
// a suggestion -- see PRODUCT_REBUILD_PLAN.md) and, once a device has picked
// a city, lets weather/country content use that city instead of IP
// geolocation (see routes/batch.js).
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, 'data', 'cities.dat');

// One row per city: [geoname_id, name, asciiname, alternatenames("|"-joined),
// country_code, lat, lon, timezone, population] -- see
// scripts/build-cities-db.js for how this file is produced.
function loadCities() {
  if (!fs.existsSync(DATA_PATH)) {
    return [];
  }
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  const cities = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    const [geonameId, name, asciiname, alternatenames, countryCode, lat, lon, timezone, population] = fields;
    cities.push({
      id: Number(geonameId),
      name,
      asciiname,
      alternateNames: alternatenames ? alternatenames.split('|') : [],
      countryCode,
      lat: Number(lat),
      lon: Number(lon),
      timezone: timezone || null,
      population: Number(population) || 0,
    });
  }
  return cities;
}

const cities = loadCities();
const citiesById = new Map(cities.map((city) => [city.id, city]));

// Returns the specific name string (city.name, asciiname, or one of its
// alternatenames) that matched the query as a case-insensitive prefix, or
// null if none of this city's names match -- lets the search endpoint report
// back "the name that matched the query, else the primary name" per its
// contract.
function matchedNameForQuery(city, lowerQuery) {
  if (city.name.toLowerCase().startsWith(lowerQuery)) return city.name;
  if (city.asciiname && city.asciiname.toLowerCase().startsWith(lowerQuery)) return city.asciiname;
  for (const alt of city.alternateNames) {
    if (alt.toLowerCase().startsWith(lowerQuery)) return alt;
  }
  return null;
}

const SEARCH_RESULT_LIMIT = 10;

// GET /api/v1/cities/search's query logic: case-insensitive prefix match on
// name/asciiname/alternatenames, sorted by population descending, capped at
// SEARCH_RESULT_LIMIT. `lang` is accepted for forward compatibility with a
// future per-language alternatename tagging, but cities15000's alternatenames
// column carries no language tag to filter on, so it currently has no effect
// on matching.
function searchCities(query /* , lang */) {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (!trimmed) {
    return [];
  }
  const lowerQuery = trimmed.toLowerCase();
  const matches = [];
  for (const city of cities) {
    const matchedName = matchedNameForQuery(city, lowerQuery);
    if (matchedName) {
      matches.push({ city, matchedName });
    }
  }
  matches.sort((a, b) => b.city.population - a.city.population);
  return matches.slice(0, SEARCH_RESULT_LIMIT).map(({ city, matchedName }) => ({
    geoname_id: city.id,
    name: matchedName,
    country_code: city.countryCode,
  }));
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

// Haversine great-circle distance in kilometers -- plenty precise for
// "nearest city among ~34k GeoNames entries", not survey-grade geodesy.
function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const EARTH_RADIUS_KM = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// GET /api/v1/cities/suggest's lookup: nearest GeoNames city to a given
// lat/lon (the IP geolocation's coordinates -- see routes/cities.js). Plain
// linear scan over ~34k rows, which is fast enough for an occasional
// suggestion lookup and keeps this module dependency-free (no spatial index).
function nearestCity(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || Number.isNaN(lat) || Number.isNaN(lon)) {
    return null;
  }
  let closest = null;
  let closestDistance = Infinity;
  for (const city of cities) {
    const distance = haversineDistanceKm(lat, lon, city.lat, city.lon);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = city;
    }
  }
  return closest;
}

function getCityById(geonameId) {
  const id = Number(geonameId);
  if (!Number.isFinite(id)) {
    return null;
  }
  return citiesById.get(id) || null;
}

module.exports = { searchCities, nearestCity, getCityById, _test: { cityCount: cities.length } };
