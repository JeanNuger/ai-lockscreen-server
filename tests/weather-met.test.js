// Weather via MET Norway Locationforecast 2.0 (src/weather.js), all on mocked HTTP:
//   1. Parsing: the user's LOCAL date is summarised (day max/min, UV, rain chance from
//      MET's probability or derived from amounts outside the Nordic region, description),
//      and the planner turns it into rain_chance / uv_level / morning_temp_band /
//      day_temp_band.
//   2. Request rules: User-Agent (default + WEATHER_USER_AGENT), coordinates rounded (<= 4
//      decimals), cache by rounded coordinates, Expires respected, If-Modified-Since + 304.
//   3. A device with a chosen city uses the city's coordinates, never IP geolocation; a
//      device without one falls back to IP.
//   4. Service failures: exact reason logged and reported (http_429, timeout, network
//      error, invalid json), stale cache used, failed coordinates not hammered.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-weather-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;
delete process.env.WEATHER_USER_AGENT;

const db = require('../src/db');
const weather = require('../src/weather');
const { _test: planner } = require('../src/slotPlanner');

const TZ = 'Asia/Almaty'; // UTC+5, no DST
const LOCAL_DATE = '2026-09-30';

// One hourly MET entry.
function hour(timeIso, { temp, uv, symbol = 'clearsky_day', amount = 0, prob }) {
  const next1 = { summary: { symbol_code: symbol }, details: { precipitation_amount: amount } };
  if (prob !== undefined) next1.details.probability_of_precipitation = prob;
  const instant = { air_temperature: temp };
  if (uv !== undefined) instant.ultraviolet_index_clear_sky = uv;
  return { time: timeIso, data: { instant: { details: instant }, next_1_hours: next1 } };
}

// 24 hourly entries covering LOCAL_DATE in Asia/Almaty (2026-09-29T19:00Z .. 2026-09-30T18:00Z)
// plus two decoys just outside the local day, with extreme values that must be ignored.
function metBody({ prob, rainy = false, warmDay = true } = {}) {
  const entries = [];
  entries.push(hour('2026-09-29T18:00:00Z', { temp: 99, uv: 15, symbol: 'heavyrain', amount: 20, prob: 100 }));
  for (let h = 0; h < 24; h += 1) {
    const utc = new Date(Date.UTC(2026, 8, 29, 19 + h));
    const isMorning = h < 6;
    const temp = isMorning ? 2 + h * 0.5 : (warmDay ? 12 + Math.min(h, 14) : 5);
    entries.push(hour(utc.toISOString().replace('.000Z', 'Z'), {
      temp,
      uv: h >= 8 && h <= 16 ? 6 : 0,
      symbol: rainy && h === 14 ? 'rain' : 'partlycloudy_day',
      amount: rainy && h === 14 ? 2.4 : 0,
      prob,
    }));
  }
  entries.push(hour('2026-09-30T19:00:00Z', { temp: -40, uv: 15, symbol: 'snow', amount: 20, prob: 100 }));
  return { type: 'Feature', properties: { timeseries: entries } };
}

function fakeResponse(status, body, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (lower[name.toLowerCase()] !== undefined ? lower[name.toLowerCase()] : null) },
    json: async () => {
      if (body === '__invalid__') throw new SyntaxError('Unexpected token < in JSON');
      return body;
    },
  };
}

function recordingFetch(handler) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {}, signal: options.signal });
    return handler(String(url), options, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function captureWarnings(callback) {
  const original = console.warn;
  const lines = [];
  console.warn = (message) => lines.push(String(message));
  return Promise.resolve().then(callback).then((result) => {
    console.warn = original;
    return { result, lines };
  }).catch((err) => {
    console.warn = original;
    throw err;
  });
}

function reset() {
  weather._test.setFetch(null);
  weather._test.resetCache();
  weather._test.setTimeoutMs(6000);
  delete process.env.WEATHER_USER_AGENT;
}

// --- 1. Parsing ----------------------------------------------------------------
function testParsesLocalDateSummary() {
  const summary = weather._test.summarizeForDate(weather._test.parseMetTimeseries(metBody({ rainy: true })), LOCAL_DATE, TZ);
  assert.strictEqual(summary.temperatureC, 26, 'day max comes from the local day only (decoys ignored)');
  assert.strictEqual(summary.temperatureMinC, 2, 'day min comes from the local day only');
  assert.strictEqual(summary.uvIndexMax, 6);
  assert.strictEqual(summary.description, 'rain', 'the most significant symbol of the day');
  assert.strictEqual(summary.precipitationSource, 'derived_from_amount', 'no probability outside the Nordic region');
  assert.strictEqual(summary.precipitationProbabilityMax, 80, '2.4 mm within one hour is a heavy burst -> high chance');

  // Moderate day (1.2 mm spread over two hours) and a drizzle-only day.
  const moderate = weather._test.parseMetTimeseries(metBody()).map((entry) => ({ ...entry }));
  const inLocalDay = moderate.filter((entry) => entry.t >= Date.UTC(2026, 8, 29, 19) && entry.t < Date.UTC(2026, 8, 30, 19));
  inLocalDay[10].period = { ...inLocalDay[10].period, amount: 0.6, symbol: 'rain' };
  inLocalDay[11].period = { ...inLocalDay[11].period, amount: 0.6, symbol: 'rain' };
  assert.strictEqual(weather._test.summarizeForDate(moderate, LOCAL_DATE, TZ).precipitationProbabilityMax, 65);
  inLocalDay[10].period = { ...inLocalDay[10].period, amount: 0.1, symbol: 'lightrain' };
  inLocalDay[11].period = { ...inLocalDay[11].period, amount: 0, symbol: 'partlycloudy_day' };
  assert.strictEqual(weather._test.summarizeForDate(moderate, LOCAL_DATE, TZ).precipitationProbabilityMax, 40);

  const dry = weather._test.summarizeForDate(weather._test.parseMetTimeseries(metBody()), LOCAL_DATE, TZ);
  assert.strictEqual(dry.precipitationProbabilityMax, 5, 'a dry day derives a low chance');

  const withProbability = weather._test.summarizeForDate(weather._test.parseMetTimeseries(metBody({ prob: 45 })), LOCAL_DATE, TZ);
  assert.strictEqual(withProbability.precipitationSource, 'met_probability');
  assert.strictEqual(withProbability.precipitationProbabilityMax, 45, 'MET probability is used as is when present');

  assert.strictEqual(weather._test.summarizeForDate(weather._test.parseMetTimeseries(metBody()), '2026-11-01', TZ), null,
    'a date outside the forecast has no summary');
}

function testBandsMatchPlannerFacts() {
  const rainyForecast = { ...weather._test.summarizeForDate(weather._test.parseMetTimeseries(metBody({ rainy: true })), LOCAL_DATE, TZ), city: 'Astana' };
  const { facts, constraints } = planner.buildForecastWeatherLifehack(rainyForecast);
  assert.strictEqual(facts.day_temp_band, 'mild', 'max 26C -> mild');
  assert.strictEqual(facts.morning_temp_band, 'cold', 'min 2C -> cold');
  assert.strictEqual(facts.rain_chance, 'high', '80% derived -> high');
  assert.strictEqual(facts.uv_level, 'moderate', 'UV 6 -> moderate');
  assert.strictEqual(facts.condition_lean, 'rain');
  assert(constraints.includes('suggest_umbrella_or_rain_protection'));
  assert(constraints.includes('suggest_layered_clothing_cold_morning_warmer_day'));
  assert(constraints.includes('no_digits'), 'numbers must stay out of the phrase text');
}

// --- 2. Request rules and caching ------------------------------------------------
async function testRequestRulesAndCaching() {
  reset();
  const fetchMock = recordingFetch(async () => fakeResponse(200, metBody(), {
    'Last-Modified': 'Wed, 30 Sep 2026 07:40:55 GMT',
    Expires: new Date(Date.now() + 30 * 60 * 1000).toUTCString(),
  }));
  weather._test.setFetch(fetchMock);

  const first = await weather.resolveWeatherByCoords(51.180123, 71.446789, { countryCode: 'KZ', city: 'Astana', localDate: LOCAL_DATE, timeZone: TZ });
  assert.strictEqual(first.forecast, true);
  assert.strictEqual(typeof first.temperatureC, 'number');
  assert.strictEqual(fetchMock.calls.length, 1);
  const call = fetchMock.calls[0];
  assert(call.url.startsWith('https://api.met.no/weatherapi/locationforecast/2.0/complete?'), 'the complete variant');
  const params = new URL(call.url).searchParams;
  for (const key of ['lat', 'lon']) {
    const decimals = (params.get(key).split('.')[1] || '').length;
    assert(decimals <= 4, `${key} must have at most 4 decimals, got ${params.get(key)}`);
  }
  assert.strictEqual(params.get('lat'), '51.18');
  assert.strictEqual(params.get('lon'), '71.45');
  assert.strictEqual(call.headers['User-Agent'], 'ai-lockscreen-server/1.0 volaris.kz', 'default User-Agent');

  // Same rounded coordinates (a different device in the same area): served from cache, no request.
  await weather.resolveWeatherByCoords(51.1841, 71.4499, { countryCode: 'KZ', city: 'Astana', localDate: LOCAL_DATE, timeZone: TZ });
  assert.strictEqual(fetchMock.calls.length, 1, 'nearby coordinates share one cache entry within the TTL');

  // Past the TTL: revalidate with If-Modified-Since; a 304 keeps the cached body.
  weather._test.expireCache(weather._test.CACHE_TTL_MS + 60 * 1000);
  fetchMock.calls.length = 0;
  const revalidating = recordingFetch(async () => fakeResponse(304, null, { Expires: new Date(Date.now() + 30 * 60 * 1000).toUTCString() }));
  weather._test.setFetch(revalidating);
  const again = await weather.resolveWeatherByCoords(51.18, 71.45, { countryCode: 'KZ', city: 'Astana', localDate: LOCAL_DATE, timeZone: TZ });
  assert.strictEqual(revalidating.calls.length, 1);
  assert.strictEqual(revalidating.calls[0].headers['If-Modified-Since'], 'Wed, 30 Sep 2026 07:40:55 GMT');
  assert.strictEqual(again.temperatureC, first.temperatureC, 'a 304 reuses the cached forecast');

  // Custom User-Agent from the environment.
  reset();
  process.env.WEATHER_USER_AGENT = 'my-app/2.0 me@example.com';
  const uaFetch = recordingFetch(async () => fakeResponse(200, metBody()));
  weather._test.setFetch(uaFetch);
  await weather.resolveWeatherByCoords(43.25, 76.95, { localDate: LOCAL_DATE, timeZone: TZ });
  assert.strictEqual(uaFetch.calls[0].headers['User-Agent'], 'my-app/2.0 me@example.com');
  reset();
}

async function testExpiresIsRespected() {
  reset();
  const farExpires = new Date(Date.now() + 5 * 60 * 60 * 1000).toUTCString();
  const fetchMock = recordingFetch(async () => fakeResponse(200, metBody(), { Expires: farExpires }));
  weather._test.setFetch(fetchMock);
  await weather.resolveWeatherByCoords(50.0, 60.0, { localDate: LOCAL_DATE, timeZone: TZ });
  // 4 hours later: past the 3h TTL but still before Expires -> no new request.
  weather._test.expireCache(4 * 60 * 60 * 1000);
  await weather.resolveWeatherByCoords(50.0, 60.0, { localDate: LOCAL_DATE, timeZone: TZ });
  assert.strictEqual(fetchMock.calls.length, 1, 'must not repeat a request before the Expires time');
  reset();
}

// --- 3. City coordinates beat IP, through the real route -------------------------
async function withRoute(fetchHandler, callback) {
  reset();
  const originalLoad = Module._load;
  delete require.cache[require.resolve('../src/routes/batch')];
  const captured = { weatherArg: null };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../contentGenerator') {
      return {
        generateBatch: async (device, window, signals, weatherArg) => {
          captured.weatherArg = weatherArg;
          return { phrases: [], source: 'ai', context: null, trace: { meta: {}, planned: [], final: [] } };
        },
        resolveLocalDateContext: () => ({
          dateContext: { date: LOCAL_DATE, weekday: 'Wednesday', time: '07:30', tomorrow_date: '2026-10-01', tomorrow_weekday: 'Thursday' },
          unavailableReason: null,
        }),
      };
    }
    if (request === '../morningPack') {
      return {
        computeTargetDate: (window, dateContext) => (dateContext ? dateContext.date : null),
        getExistingMorningPack: () => null,
        getOrGenerateMorningPack: async () => null,
      };
    }
    if (request === '../adminMessages') return { consumePendingMessages: () => [] };
    return originalLoad.call(this, request, parent, isMain);
  };
  const fetchMock = recordingFetch(fetchHandler);
  weather._test.setFetch(fetchMock);
  let server;
  try {
    const app = express();
    app.set('trust proxy', true);
    app.use('/api/v1', require('../src/routes/batch'));
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    return await callback(server, fetchMock, captured);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/routes/batch')];
    reset();
  }
}

function get(server, pathName, headers = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, json: body ? JSON.parse(body) : null }));
    }).on('error', reject);
  });
}

function insertDevice(deviceId, city) {
  db.prepare(`
    INSERT INTO devices (device_id, name, timezone, city_geoname_id, city_name, city_country_code, city_lat, city_lon)
    VALUES (@device_id, 'Aika', @tz, @id, @name, @cc, @lat, @lon)
  `).run({ device_id: deviceId, tz: TZ, id: city ? 1526384 : null, name: city ? 'Astana' : null, cc: city ? 'KZ' : null, lat: city ? city.lat : null, lon: city ? city.lon : null });
}

const metOk = () => fakeResponse(200, metBody({ rainy: true }));

async function testCityCoordinatesBeatIp() {
  insertDevice('weather-city', { lat: 51.1801, lon: 71.446 });
  await withRoute(async (url) => {
    if (url.includes('ipwho.is')) {
      return fakeResponse(200, { success: true, country_code: 'DE', city: 'Berlin', latitude: 52.52, longitude: 13.405 });
    }
    return metOk();
  }, async (server, fetchMock, captured) => {
    await get(server, `/api/v1/batch?device_id=weather-city&window=morning&timezone=Asia%2FAlmaty`, { 'X-Forwarded-For': '8.8.8.8' });
    assert(!fetchMock.calls.some((c) => c.url.includes('ipwho.is')), 'a device with a city must never trigger IP geolocation');
    const metCalls = fetchMock.calls.filter((c) => c.url.includes('api.met.no'));
    assert.strictEqual(metCalls.length, 1);
    const params = new URL(metCalls[0].url).searchParams;
    assert.strictEqual(params.get('lat'), '51.18', 'MET is asked about the CITY, not the IP location');
    assert.strictEqual(params.get('lon'), '71.45');
    assert.strictEqual(captured.weatherArg.countryCode, 'KZ');
    assert.strictEqual(captured.weatherArg.city, 'Astana');
    assert.strictEqual(captured.weatherArg.forecast, true);
    assert.strictEqual(typeof captured.weatherArg.temperatureC, 'number');
    const row = db.prepare('SELECT trace_json FROM content_batches WHERE device_id = ?').get('weather-city');
    const status = JSON.parse(row.trace_json).meta.weather_status;
    assert.strictEqual(status.weather, 'ok');
    assert.strictEqual(status.source, 'city');
    assert.strictEqual(status.reason, undefined, 'no failure reason when weather is fine');
  });
}

async function testIpUsedWhenNoCity() {
  insertDevice('weather-ip', null);
  await withRoute(async (url) => {
    if (url.includes('ipwho.is')) {
      return fakeResponse(200, { success: true, country_code: 'KZ', city: 'Almaty', latitude: 43.2567, longitude: 76.9286 });
    }
    return metOk();
  }, async (server, fetchMock, captured) => {
    await get(server, `/api/v1/batch?device_id=weather-ip&window=morning&timezone=Asia%2FAlmaty`, { 'X-Forwarded-For': '8.8.8.8' });
    assert(fetchMock.calls.some((c) => c.url.includes('ipwho.is')), 'without a city the IP geolocation is used, as before');
    const metCalls = fetchMock.calls.filter((c) => c.url.includes('api.met.no'));
    assert.strictEqual(metCalls.length, 1);
    const params = new URL(metCalls[0].url).searchParams;
    assert.strictEqual(params.get('lat'), '43.26');
    assert.strictEqual(params.get('lon'), '76.93');
    assert.strictEqual(captured.weatherArg.city, 'Almaty');
    assert.strictEqual(typeof captured.weatherArg.temperatureC, 'number');
  });
}

// --- 4. Service failures ------------------------------------------------------------
async function testFailuresAreReportedWithExactReason() {
  const cases = [
    { name: 'http_429', handler: async () => fakeResponse(429, null, { 'Retry-After': '120' }) },
    { name: 'http_403', handler: async () => fakeResponse(403, null) },
    { name: 'http_503', handler: async () => fakeResponse(503, null) },
    { name: 'invalid_json', handler: async () => fakeResponse(200, '__invalid__') },
    { name: 'empty_timeseries', handler: async () => fakeResponse(200, { properties: { timeseries: [] } }) },
    {
      name: 'network_error:ENOTFOUND',
      handler: async () => { const err = new TypeError('fetch failed'); err.cause = { code: 'ENOTFOUND' }; throw err; },
    },
  ];
  for (const testCase of cases) {
    reset();
    weather._test.setFetch(recordingFetch(testCase.handler));
    const { result, lines } = await captureWarnings(() => weather.resolveWeatherByCoords(48.0 + cases.indexOf(testCase), 60.0, { countryCode: 'KZ', city: 'X', localDate: LOCAL_DATE, timeZone: TZ }));
    assert.strictEqual(result.weatherFailure, testCase.name, `reason for ${testCase.name}`);
    assert.strictEqual(result.temperatureC, undefined, 'no temperature when the service fails');
    assert.strictEqual(result.countryCode, 'KZ', 'the country still comes through');
    assert(lines.some((l) => l.startsWith('WEATHER_FAILED') && l.includes(`reason=${testCase.name}`)), `WEATHER_FAILED must log ${testCase.name}`);
  }

  // Timeout: a request that never answers is aborted and reported as a timeout.
  reset();
  weather._test.setTimeoutMs(40);
  weather._test.setFetch(async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { const err = new Error('aborted'); err.name = 'AbortError'; reject(err); });
  }));
  const timedOut = await captureWarnings(() => weather.resolveWeatherByCoords(55.0, 65.0, { localDate: LOCAL_DATE, timeZone: TZ }));
  assert.strictEqual(timedOut.result.weatherFailure, 'timeout');
  assert(timedOut.lines.some((l) => l.includes('reason=timeout')));
  reset();
}

async function testFailedCoordinatesAreNotHammeredAndStaleIsUsed() {
  reset();
  let mode = 'ok';
  const fetchMock = recordingFetch(async () => (mode === 'ok' ? fakeResponse(200, metBody()) : fakeResponse(500, null)));
  weather._test.setFetch(fetchMock);
  const good = await weather.resolveWeatherByCoords(52.0, 61.0, { localDate: LOCAL_DATE, timeZone: TZ });
  assert.strictEqual(typeof good.temperatureC, 'number');

  // The cache expires, MET starts failing: the stale forecast is used instead of no weather.
  weather._test.expireCache(weather._test.CACHE_TTL_MS + 1000);
  mode = 'fail';
  const stale = await captureWarnings(() => weather.resolveWeatherByCoords(52.0, 61.0, { localDate: LOCAL_DATE, timeZone: TZ }));
  assert.strictEqual(stale.result.temperatureC, good.temperatureC, 'stale forecast beats no forecast');
  assert(stale.lines.some((l) => l.startsWith('WEATHER_STALE_USED')));

  // After a failure the same coordinates are not retried straight away.
  const before = fetchMock.calls.length;
  await weather.resolveWeatherByCoords(52.0, 61.0, { localDate: LOCAL_DATE, timeZone: TZ });
  assert.strictEqual(fetchMock.calls.length, before, 'no request while the failure back-off is active');
  reset();
}

async function testRouteReportsFailureReasonAndKeepsWorking() {
  insertDevice('weather-fail', { lat: 51.1801, lon: 71.446 });
  const { lines } = await captureWarnings(() => withRoute(async () => fakeResponse(429, null), async (server, fetchMock, captured) => {
    const response = await get(server, `/api/v1/batch?device_id=weather-fail&window=morning&timezone=Asia%2FAlmaty`);
    assert.strictEqual(response.statusCode, 200, 'a weather failure must never fail /batch');
    assert.strictEqual(captured.weatherArg.temperatureC, undefined);
    assert.strictEqual(captured.weatherArg.weatherFailure, 'http_429');
    const row = db.prepare('SELECT trace_json FROM content_batches WHERE device_id = ?').get('weather-fail');
    const status = JSON.parse(row.trace_json).meta.weather_status;
    assert.strictEqual(status.weather, 'failed');
    assert.strictEqual(status.reason, 'http_429', 'the exact reason ends up in the trace');
  }));
  assert(lines.some((l) => l.startsWith('WEATHER_FAILED') && l.includes('reason=http_429')));
}

async function main() {
  testParsesLocalDateSummary();
  testBandsMatchPlannerFacts();
  await testRequestRulesAndCaching();
  await testExpiresIsRespected();
  await testCityCoordinatesBeatIp();
  await testIpUsedWhenNoCity();
  await testFailuresAreReportedWithExactReason();
  await testFailedCoordinatesAreNotHammeredAndStaleIsUsed();
  await testRouteReportsFailureReasonAndKeepsWorking();
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('weather-met.test.js: all assertions passed');
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
