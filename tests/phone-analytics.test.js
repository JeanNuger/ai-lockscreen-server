const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-phone-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const { STYLE_IDS } = require('../src/constants');
const {
  computePhoneTrends,
  recordPhoneSignalSample,
  _test: phoneTest,
} = require('../src/phoneAnalytics');

function insertDevice(deviceId = 'phone-device') {
  db.prepare('INSERT OR IGNORE INTO devices (device_id, timezone, created_at) VALUES (?, ?, ?)')
    .run(deviceId, 'Asia/Almaty', '2026-09-17 00:00:00');
  return {
    device_id: deviceId,
    timezone: 'Asia/Almaty',
    created_at: '2026-09-17 00:00:00',
  };
}

function insertSample({
  deviceId = 'phone-device',
  window = 'day',
  localDate = '2026-09-19',
  unlocks = null,
  steps = null,
  recordedAt = '2026-09-19 06:00:00',
} = {}) {
  db.prepare(`
    INSERT INTO phone_signal_samples (
      device_id,
      window,
      device_local_date,
      recorded_at,
      unlocks_since_last_batch,
      steps_since_last_batch
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(deviceId, window, localDate, recordedAt, unlocks, steps);
}

function countSamples() {
  return db.prepare('SELECT COUNT(*) AS count FROM phone_signal_samples').get().count;
}

function requestJson(server, pathName) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${pathName}`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
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

async function withMockedBatchRoute(generateBatchImpl, callback) {
  const originalLoad = Module._load;
  delete require.cache[require.resolve('../src/routes/batch')];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../contentGenerator') {
      // resolveLocalDateContext is also required directly by routes/batch.js
      // (used to compute the morning pack's target_date up front, before
      // generateBatch runs) -- the real implementation is fine to reuse here
      // since this test module doesn't touch dates itself.
      return {
        generateBatch: generateBatchImpl,
        resolveLocalDateContext: require('../src/contentGenerator').resolveLocalDateContext,
      };
    }
    if (request === '../weather') {
      // resolveGeolocation is also required directly by routes/batch.js now
      // (resolved once per request and shared with getOrGenerateMorningPack)
      // -- mocked to null here, same "no geo" behavior a private/local test
      // IP would already produce.
      return { resolveWeather: async () => null, resolveGeolocation: async () => null };
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
    return await callback(server);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/routes/batch')];
  }
}

async function main() {
  assert.deepStrictEqual(
    phoneTest.sanitizePhoneSignalSample({
      unlocks_since_last_batch: 12,
      steps_since_last_batch: 3456,
      battery_level: 73,
      ambient_light: 10,
      screen_on_duration_seconds: 83,
    }),
    { unlocks_since_last_batch: 12, steps_since_last_batch: 3456 },
    'sanitize must keep only valid unlock/step integers'
  );

  assert.deepStrictEqual(
    phoneTest.sanitizePhoneSignalSample({
      unlocks_since_last_batch: -1,
      steps_since_last_batch: 1.5,
    }),
    {},
    'negative and non-integer values must be ignored'
  );

  const device = insertDevice();
  const now = new Date('2026-09-20T06:00:00Z');
  assert.deepStrictEqual(
    computePhoneTrends(device, 'day', { unlocks_since_last_batch: 20, steps_since_last_batch: 1000 }, { now }),
    {},
    'no trend without yesterday same-window history'
  );

  insertSample({ window: 'morning', localDate: '2026-09-19', unlocks: 10, steps: 1000 });
  assert.deepStrictEqual(
    computePhoneTrends(device, 'day', { unlocks_since_last_batch: 20, steps_since_last_batch: 2000 }, { now }),
    {},
    'different window history must be ignored'
  );

  insertSample({ window: 'day', localDate: '2026-09-19', unlocks: 10, steps: 1000 });
  assert.deepStrictEqual(
    computePhoneTrends(device, 'day', { unlocks_since_last_batch: 14 }, { now }),
    { unlocks_vs_yesterday: 'higher' },
    'unlock higher threshold must produce semantic trend'
  );
  assert.deepStrictEqual(
    computePhoneTrends(device, 'day', { unlocks_since_last_batch: 6 }, { now }),
    { unlocks_vs_yesterday: 'lower' },
    'unlock lower threshold must produce semantic trend'
  );
  assert.deepStrictEqual(
    computePhoneTrends(device, 'day', { unlocks_since_last_batch: 8 }, { now }),
    {},
    'unlock normal range must not produce a trend'
  );
  assert.deepStrictEqual(
    computePhoneTrends(device, 'day', { steps_since_last_batch: 1600 }, { now }),
    { steps_vs_yesterday: 'higher' },
    'steps higher threshold must produce semantic trend'
  );
  assert.deepStrictEqual(
    computePhoneTrends(device, 'day', { steps_since_last_batch: 400 }, { now }),
    { steps_vs_yesterday: 'lower' },
    'steps lower threshold must produce semantic trend'
  );

  insertDevice('tiny-baseline-device');
  insertSample({ deviceId: 'tiny-baseline-device', window: 'day', localDate: '2026-09-19', unlocks: 0, steps: 20 });
  assert.deepStrictEqual(
    computePhoneTrends(
      { device_id: 'tiny-baseline-device', timezone: 'Asia/Almaty' },
      'day',
      { unlocks_since_last_batch: 10, steps_since_last_batch: 1000 },
      { now }
    ),
    {},
    'tiny or zero baselines must not create a trend'
  );

  const trends = computePhoneTrends(device, 'day', {
    unlocks_since_last_batch: 14,
    steps_since_last_batch: 1600,
  }, { now });
  assert.deepStrictEqual(trends, {
    unlocks_vs_yesterday: 'higher',
    steps_vs_yesterday: 'higher',
  });
  assert(!JSON.stringify(trends).match(/\b(?:14|1600|10|1000)\b/), 'phoneTrends must contain no raw counts');

  insertDevice('retention-device');
  insertSample({
    deviceId: 'retention-device',
    window: 'day',
    localDate: '2026-07-01',
    unlocks: 5,
    steps: 500,
    recordedAt: "datetime('now', '-46 days')",
  });
  db.prepare(`
    UPDATE phone_signal_samples
    SET recorded_at = datetime('now', '-46 days')
    WHERE device_id = ?
  `).run('retention-device');
  assert(recordPhoneSignalSample(
    { device_id: 'retention-device', timezone: 'Asia/Almaty' },
    'day',
    { unlocks_since_last_batch: 7, steps_since_last_batch: 700 }
  ), 'successful sample recording should return true');
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS count FROM phone_signal_samples WHERE device_id = ?').get('retention-device').count,
    1,
    '>45-day samples must be pruned after successful write'
  );

  insertDevice('route-success-device');
  let generateCalls = 0;
  await withMockedBatchRoute(async () => {
    generateCalls += 1;
    return {
      phrases: Array.from({ length: 12 }, (_, index) => ({
        text: `Route phrase ${index + 1}`,
        style_id: STYLE_IDS[index],
      })),
      source: 'openai',
      context: '{}',
    };
  }, async (server) => {
    const before = countSamples();
    const response = await requestJson(
      server,
      '/api/v1/batch?device_id=route-success-device&window=day&unlocks_since_last_batch=9&steps_since_last_batch=900'
    );
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.json.phrases.length, 12);
    assert.strictEqual(generateCalls, 1, '/batch must call generation exactly once');
    assert.strictEqual(countSamples(), before + 1, 'successful generation must persist current sample');
  });

  insertDevice('route-failure-device');
  await withMockedBatchRoute(async () => {
    throw new Error('mock generation failed');
  }, async (server) => {
    const before = countSamples();
    const response = await requestJson(
      server,
      '/api/v1/batch?device_id=route-failure-device&window=day&unlocks_since_last_batch=9&steps_since_last_batch=900'
    );
    assert.strictEqual(response.statusCode, 500);
    assert.strictEqual(countSamples(), before, 'failed generation must not persist current sample');
  });
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
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
