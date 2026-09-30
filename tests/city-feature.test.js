// Coverage for the "device picks a city" feature (see PRODUCT_REBUILD_PLAN.md):
//   1. src/cities.js search finds "Астана", "Astana", "Нью-Йорк".
//   2. src/cities.js nearestCity resolves Astana's own coordinates back to Astana.
//   3. POST /api/v1/register stores a chosen city; an unknown id is ignored, not fatal.
//   4. A device with a chosen city gets weather from that city's coordinates,
//      with NO IP geolocation call at all.
//   5. A device without a chosen city keeps the old IP-based behavior.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-city-feature-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const { searchCities, nearestCity, getCityById } = require('../src/cities');

const ASTANA_ID = 1526273;
const NEW_YORK_CITY_ID = 5128581;

function requestJson(server, pathName) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${pathName}`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = body ? JSON.parse(body) : null;
        } catch (err) {
          return reject(err);
        }
        resolve({ statusCode: res.statusCode, json });
      });
    }).on('error', reject);
  });
}

function postJson(server, pathName, payload) {
  const port = server.address().port;
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathName,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = body ? JSON.parse(body) : null;
        } catch (err) {
          return reject(err);
        }
        resolve({ statusCode: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// --- Part 1: search ---
function testSearchFindsExpectedCities() {
  const astanaResults = searchCities('Астана');
  assert(
    astanaResults.some((r) => r.geoname_id === ASTANA_ID),
    'search "Астана" must find Astana'
  );

  const astanaAsciiResults = searchCities('Astana');
  assert(
    astanaAsciiResults.some((r) => r.geoname_id === ASTANA_ID),
    'search "Astana" must find Astana'
  );

  const newYorkResults = searchCities('Нью-Йорк');
  assert(
    newYorkResults.some((r) => r.geoname_id === NEW_YORK_CITY_ID),
    'search "Нью-Йорк" must find New York City'
  );

  assert(astanaResults.length <= 10, 'search must return at most 10 results');
  for (let i = 1; i < astanaResults.length; i += 1) {
    const prevCity = getCityById(astanaResults[i - 1].geoname_id);
    const curCity = getCityById(astanaResults[i].geoname_id);
    assert(prevCity.population >= curCity.population, 'search results must be sorted by population descending');
  }

  assert.deepStrictEqual(searchCities(''), [], 'empty query must return no results');
}

// --- Part 2: suggest / nearestCity ---
function testNearestCityResolvesAstana() {
  const astana = getCityById(ASTANA_ID);
  const nearest = nearestCity(astana.lat, astana.lon);
  assert(nearest, 'nearestCity must find a result for Astana\'s own coordinates');
  assert.strictEqual(nearest.id, ASTANA_ID, 'nearestCity at Astana\'s coordinates must return Astana itself');
}

// --- Part 3: register with city_geoname_id ---
async function testRegisterStoresCityAndIgnoresUnknownId() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', require('../src/routes/register'));
  const server = await new Promise((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  try {
    const { statusCode, json } = await postJson(server, '/api/v1/register', {
      device_id: 'city-device-1',
      name: 'Nurlan',
      city_geoname_id: ASTANA_ID,
    });
    assert.strictEqual(statusCode, 200);
    assert.strictEqual(json.ok, true);

    const row = db.prepare('SELECT * FROM devices WHERE device_id = ?').get('city-device-1');
    assert.strictEqual(row.city_geoname_id, ASTANA_ID);
    assert.strictEqual(row.city_name, 'Astana');
    assert.strictEqual(row.city_country_code, 'KZ');
    assert.strictEqual(typeof row.city_lat, 'number');
    assert.strictEqual(typeof row.city_lon, 'number');

    // Unknown id must be ignored, not crash the request.
    const unknownResult = await postJson(server, '/api/v1/register', {
      device_id: 'city-device-2',
      name: 'Aika',
      city_geoname_id: 999999999,
    });
    assert.strictEqual(unknownResult.statusCode, 200);
    assert.strictEqual(unknownResult.json.ok, true);
    const row2 = db.prepare('SELECT * FROM devices WHERE device_id = ?').get('city-device-2');
    assert.strictEqual(row2.city_geoname_id, null, 'unknown city id must not be stored');
    assert.strictEqual(row2.city_name, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// --- Parts 4 & 5: batch weather resolution (city outranks IP / old IP path) ---
async function withMockedBatchRoute({ deviceRow }, callback) {
  const originalLoad = Module._load;
  delete require.cache[require.resolve('../src/routes/batch')];

  const calls = { resolveGeolocation: 0, resolveWeather: 0, resolveWeatherByCoords: [] };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../contentGenerator') {
      return {
        generateBatch: async (device, window, signals, weatherArg) => ({
          phrases: [],
          source: 'ai',
          context: null,
          trace: { meta: {}, planned: [], final: [] },
          _weather: weatherArg,
        }),
        resolveLocalDateContext: require('../src/contentGenerator').resolveLocalDateContext,
      };
    }
    if (request === '../weather') {
      return {
        resolveGeolocation: async () => {
          calls.resolveGeolocation += 1;
          return { success: true, country_code: 'DE', city: 'Berlin', latitude: 52.52, longitude: 13.405 };
        },
        resolveWeather: async () => {
          calls.resolveWeather += 1;
          return { countryCode: 'DE', city: 'Berlin', temperatureC: 10, description: 'clear' };
        },
        resolveWeatherByCoords: async (lat, lon, meta) => {
          calls.resolveWeatherByCoords.push({ lat, lon, meta });
          return { countryCode: meta.countryCode, city: meta.city, temperatureC: -5, description: 'snow' };
        },
      };
    }
    if (request === '../adminMessages') {
      return { consumePendingMessages: () => [] };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  let server;
  try {
    const app = express();
    app.use('/api/v1', require('../src/routes/batch'));
    app.use((err, req, res, next) => {
      res.status(500).json({ error: 'internal server error' });
    });
    server = await new Promise((resolve) => {
      const started = app.listen(0, () => resolve(started));
    });
    db.prepare(`
      INSERT INTO devices (
        device_id, timezone, city_geoname_id, city_name, city_country_code, city_lat, city_lon
      ) VALUES (@device_id, @timezone, @city_geoname_id, @city_name, @city_country_code, @city_lat, @city_lon)
    `).run(deviceRow);
    return await callback(server, calls);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/routes/batch')];
  }
}

async function testDeviceWithCityUsesCityWeatherNotIp() {
  await withMockedBatchRoute({
    deviceRow: {
      device_id: 'city-weather-device',
      timezone: 'Asia/Almaty',
      city_geoname_id: ASTANA_ID,
      city_name: 'Astana',
      city_country_code: 'KZ',
      city_lat: 51.1801,
      city_lon: 71.446,
    },
  }, async (server, calls) => {
    const { json } = await requestJson(
      server,
      '/api/v1/batch?device_id=city-weather-device&window=day&timezone=Asia%2FAlmaty'
    );
    assert(json.phrases !== undefined, 'response should still succeed normally');

    assert.strictEqual(calls.resolveGeolocation, 0, 'a device with a chosen city must never call IP geolocation');
    assert.strictEqual(calls.resolveWeather, 0, 'a device with a chosen city must never call the IP-based weather resolver');
    assert.strictEqual(calls.resolveWeatherByCoords.length, 1, 'weather must be resolved from the city\'s own coordinates');
    assert.strictEqual(calls.resolveWeatherByCoords[0].lat, 51.1801);
    assert.strictEqual(calls.resolveWeatherByCoords[0].lon, 71.446);
    assert.strictEqual(calls.resolveWeatherByCoords[0].meta.countryCode, 'KZ');

    const row = db.prepare('SELECT trace_json FROM content_batches WHERE device_id = ?').get('city-weather-device');
    const trace = JSON.parse(row.trace_json);
    assert.strictEqual(trace.meta.weather_status.source, 'city', 'trace.meta.weather_status.source must be "city"');
    assert.strictEqual(trace.meta.weather_status.geo, 'skipped');
  });
}

async function testDeviceWithoutCityUsesIpAsBefore() {
  await withMockedBatchRoute({
    deviceRow: {
      device_id: 'no-city-device',
      timezone: 'Asia/Almaty',
      city_geoname_id: null,
      city_name: null,
      city_country_code: null,
      city_lat: null,
      city_lon: null,
    },
  }, async (server, calls) => {
    const { json } = await requestJson(
      server,
      '/api/v1/batch?device_id=no-city-device&window=day&timezone=Asia%2FAlmaty'
    );
    assert(json.phrases !== undefined, 'response should still succeed normally');

    assert.strictEqual(calls.resolveGeolocation, 1, 'a device without a chosen city must resolve geolocation from IP, same as before');
    assert.strictEqual(calls.resolveWeatherByCoords.length, 0, 'a device without a chosen city must never use the city-coords weather path');

    const row = db.prepare('SELECT trace_json FROM content_batches WHERE device_id = ?').get('no-city-device');
    const trace = JSON.parse(row.trace_json);
    assert.strictEqual(trace.meta.weather_status.source, 'ip', 'trace.meta.weather_status.source must be "ip"');
  });
}

async function main() {
  testSearchFindsExpectedCities();
  testNearestCityResolvesAstana();
  await testRegisterStoresCityAndIgnoresUnknownId();
  await testDeviceWithCityUsesCityWeatherNotIp();
  await testDeviceWithoutCityUsesIpAsBefore();
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('city-feature.test.js: all assertions passed');
  })
  .catch((err) => {
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {
      // best effort cleanup
    }
    console.error(err);
    process.exit(1);
  });
