// Guarantees after the morning-pack / personal_goal / tone cleanup:
//   1. POST /register ignores personal_goal and tone (old clients may still send them):
//      the request succeeds and nothing is written to those columns.
//   2. GET /batch ignores the old supports_morning_pack / pack_date_held parameters: the
//      response is the ordinary one, with no batch_id and no morning_pack.
//   3. The ordinary morning batch is unaffected by the removal: fixed position order is kept
//      and the weather slot carries the forecast bands (day/morning temperature, rain, UV)
//      from weather.js.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-cleanup-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const { planSlots } = require('../src/slotPlanner');

function request(server, method, pathName, body) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: pathName, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, json: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(mountBatch, callback) {
  const originalLoad = Module._load;
  delete require.cache[require.resolve('../src/routes/batch')];
  Module._load = function patchedLoad(name, parent, isMain) {
    if (mountBatch && name === '../contentGenerator') {
      return {
        generateBatch: async () => ({ phrases: [{ text: 'hello', style_id: 'A1' }], source: 'openai', context: '{}', trace: { meta: {}, whole_batch_fallback: { flag: false } } }),
        resolveLocalDateContext: () => ({
          dateContext: { date: '2026-09-30', weekday: 'Wednesday', time: '07:30', tomorrow_date: '2026-10-01', tomorrow_weekday: 'Thursday' },
          unavailableReason: null,
        }),
      };
    }
    if (mountBatch && name === '../weather') {
      return { resolveGeolocation: async () => null, resolveWeather: async () => null, resolveWeatherByCoords: async () => null };
    }
    if (mountBatch && name === '../adminMessages') return { consumePendingMessages: () => [] };
    return originalLoad.call(this, name, parent, isMain);
  };
  let server;
  try {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', require('../src/routes/register'));
    app.use('/api/v1', require('../src/routes/batch'));
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    return await callback(server);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/routes/batch')];
  }
}

async function testRegisterIgnoresGoalAndTone() {
  await withServer(false, async (server) => {
    const result = await request(server, 'POST', '/api/v1/register', {
      device_id: 'old-client',
      name: 'Aika',
      gender: 'female',
      birth_date: '1995-04-12',
      interests: ['sport'],
      personal_goal: 'productivity',
      tone: 'humorous',
      timezone: 'Asia/Almaty',
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.json.ok, true);
    const row = db.prepare('SELECT name, gender, birth_date, personal_goal, tone FROM devices WHERE device_id = ?').get('old-client');
    assert.strictEqual(row.name, 'Aika', 'the real profile fields are still stored');
    assert.strictEqual(row.personal_goal, null, 'personal_goal is no longer written');
    assert.strictEqual(row.tone, null, 'tone is no longer written');

    // Updating an existing device does not resurrect them either.
    db.prepare("UPDATE devices SET personal_goal = 'legacy', tone = 'legacy' WHERE device_id = 'old-client'").run();
    await request(server, 'POST', '/api/v1/register', { device_id: 'old-client', name: 'Aika', personal_goal: 'calm', tone: 'formal' });
    const after = db.prepare('SELECT personal_goal, tone FROM devices WHERE device_id = ?').get('old-client');
    assert.strictEqual(after.personal_goal, 'legacy', 'existing column values are left untouched');
    assert.strictEqual(after.tone, 'legacy');
  });
}

async function testOldPackParametersAreIgnored() {
  await withServer(true, async (server) => {
    const plain = await request(server, 'GET', '/api/v1/batch?device_id=pack-flag&window=morning&timezone=Asia%2FAlmaty');
    const flagged = await request(server, 'GET', '/api/v1/batch?device_id=pack-flag&window=morning&timezone=Asia%2FAlmaty&supports_morning_pack=1&pack_date_held=2026-09-30');
    assert.strictEqual(flagged.statusCode, 200);
    assert.strictEqual(flagged.json.morning_pack, undefined, 'no morning_pack in the response any more');
    assert.strictEqual(flagged.json.batch_id, undefined, 'no batch_id in the response any more');
    assert.deepStrictEqual(flagged.json.phrases, plain.json.phrases, 'the flagged request gets the ordinary batch (served from the same cache)');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM content_batches WHERE device_id = ?').get('pack-flag').c, 1,
      'the flag no longer creates a second, separate batch');
  });
}

function testOrdinaryMorningBatchKeepsOrderAndForecastBands() {
  const forecast = {
    countryCode: 'KZ', city: 'Astana', forecast: true, provider: 'met.no',
    temperatureC: 24, temperatureMinC: 4, description: 'rain', precipitationProbabilityMax: 70, uvIndexMax: 8,
  };
  const { slots } = planSlots({
    device: { device_id: 'order-device', name: 'Aika', birth_date: '1995-04-12', timezone: 'Asia/Almaty' },
    window: 'morning',
    dateContext: { date: '2026-09-30', weekday: 'Wednesday', time: '07:30' },
    weather: forecast,
    bankItems: [
      { id: 1, category: 'holiday', content_text: 'День примера отмечают сегодня.' },
      { id: 2, category: 'on_this_day', content_text: 'В этот день случилось что-то важное.' },
      { id: 3, category: 'idiom', content_text: 'Ни пуха ни пера — пожелание удачи.' },
    ],
    phoneTrends: {},
    signals: {},
  }, {});
  const types = slots.map((slot) => slot.type);
  const expectedStart = ['greeting_name', 'weather_lifehack', 'daily_horoscope', 'holiday_today', 'history_today', 'daily_numerology', 'word_learning'];
  assert.deepStrictEqual(types.slice(0, expectedStart.length), expectedStart, 'the seven morning slots keep their fixed order');

  const weather = slots.find((slot) => slot.type === 'weather_lifehack');
  assert.strictEqual(weather.facts.day_temp_band, 'mild', 'day band from the forecast max');
  assert.strictEqual(weather.facts.morning_temp_band, 'cold', 'morning band from the forecast min');
  assert.strictEqual(weather.facts.rain_chance, 'high');
  assert.strictEqual(weather.facts.uv_level, 'high');
  assert(weather.constraints.includes('no_digits'), 'numbers still stay out of the text');
}

async function main() {
  await testRegisterIgnoresGoalAndTone();
  await testOldPackParametersAreIgnored();
  testOrdinaryMorningBatchKeepsOrderAndForecastBands();
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('cleanup-guarantees.test.js: all assertions passed');
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
