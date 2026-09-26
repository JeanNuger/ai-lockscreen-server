const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-batch-reuse-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');

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
        try {
          resolve({ statusCode: res.statusCode, json: body ? JSON.parse(body) : null });
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

function makePhrase(label) {
  return { text: label, style_id: 'A1' };
}

async function withMockedBatchRoute(generateBatchImpl, callback) {
  const originalLoad = Module._load;
  delete require.cache[require.resolve('../src/routes/batch')];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../contentGenerator') {
      return {
        generateBatch: generateBatchImpl,
        resolveLocalDateContext: (timezone, forcedLocalDate) => ({
          dateContext: {
            date: forcedLocalDate || '2026-09-26',
            weekday: 'Saturday',
            time: '08:00',
            tomorrow_date: '2026-09-27',
            tomorrow_weekday: 'Sunday',
          },
          unavailableReason: null,
        }),
      };
    }
    if (request === '../weather') {
      return {
        resolveGeolocation: async () => ({ success: true, country_code: 'KZ' }),
        resolveWeather: async () => ({ countryCode: 'KZ', temperatureC: 18, description: 'clear' }),
      };
    }
    if (request === '../morningPack') {
      return {
        computeTargetDate: (window, dateContext) => (dateContext ? dateContext.date : null),
        getExistingMorningPack: () => null,
        getOrGenerateMorningPack: async () => null,
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
      res.status(500).json({ error: err.message });
    });
    server = await new Promise((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
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

function insertFullDevice(deviceId) {
  db.prepare(`
    INSERT INTO devices (device_id, name, gender, birth_date, timezone)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      name = excluded.name,
      gender = excluded.gender,
      birth_date = excluded.birth_date,
      timezone = excluded.timezone
  `).run(deviceId, 'Aruzhan', 'female', '1995-04-12', 'Asia/Almaty');
}

function memoryCount(deviceId) {
  return db.prepare('SELECT COUNT(*) AS c FROM device_content_memory WHERE device_id = ?').get(deviceId).c;
}

async function testSecondRequestReusesBatchAndTrace() {
  const deviceId = 'reuse-device';
  insertFullDevice(deviceId);
  let calls = 0;
  const logs = [];
  const originalLog = console.log;
  console.log = (message) => {
    logs.push(String(message));
  };
  try {
    await withMockedBatchRoute(async (device, window) => {
      calls += 1;
      db.prepare('INSERT INTO device_content_memory (device_id, content_key) VALUES (?, ?)')
        .run(device.device_id, `generated-${calls}`);
      return {
        phrases: [makePhrase(`generated ${window} ${calls}`)],
        source: 'openai',
        context: '{}',
        trace: { meta: {}, whole_batch_fallback: { flag: false } },
      };
    }, async (server) => {
      const pathName = `/api/v1/batch?device_id=${deviceId}&window=morning&timezone=Asia%2FAlmaty&local_date=2026-09-26&supports_morning_pack=1`;
      const first = await requestJson(server, pathName);
      const second = await requestJson(server, pathName);

      assert.strictEqual(first.statusCode, 200);
      assert.strictEqual(second.statusCode, 200);
      assert.strictEqual(calls, 1, 'second request with the same key must not call generateBatch/OpenAI');
      assert.deepStrictEqual(second.json.phrases, first.json.phrases, 'cached response must reuse the same phrases');
      assert.strictEqual(second.json.batch_id, first.json.batch_id, 'cached response must reuse the original batch id');
      assert.strictEqual(memoryCount(deviceId), 1, 'content memory must not be written again on cache hit');
      const cacheTrace = logs.find((line) => line.includes('"cache_hit":true'));
      assert(cacheTrace, 'cache hit must emit a [batch-trace] log line');
      assert(cacheTrace.includes(`"reused_batch_id":${first.json.batch_id}`), 'cache trace must include reused_batch_id');
    });
  } finally {
    console.log = originalLog;
  }
}

async function testDifferentWindowOrDateGeneratesNormally() {
  const deviceId = 'different-key-device';
  insertFullDevice(deviceId);
  let calls = 0;
  await withMockedBatchRoute(async (device, window) => {
    calls += 1;
    return {
      phrases: [makePhrase(`generated ${window} ${calls}`)],
      source: 'openai',
      context: '{}',
      trace: { meta: {}, whole_batch_fallback: { flag: false } },
    };
  }, async (server) => {
    await requestJson(server, `/api/v1/batch?device_id=${deviceId}&window=morning&timezone=Asia%2FAlmaty&local_date=2026-09-26`);
    await requestJson(server, `/api/v1/batch?device_id=${deviceId}&window=day&timezone=Asia%2FAlmaty&local_date=2026-09-26`);
    await requestJson(server, `/api/v1/batch?device_id=${deviceId}&window=morning&timezone=Asia%2FAlmaty&local_date=2026-09-27`);
    assert.strictEqual(calls, 3, 'different window or date must use a different cache key');
  });
}

async function testWholeBatchFallbackAllowsOneRetry() {
  const deviceId = 'fallback-retry-device';
  insertFullDevice(deviceId);
  let calls = 0;
  await withMockedBatchRoute(async () => {
    calls += 1;
    if (calls === 1) {
      return {
        phrases: [makePhrase('fallback one')],
        source: 'fallback',
        context: '{}',
        trace: { meta: {}, whole_batch_fallback: { flag: true, reason: 'openai_error' } },
      };
    }
    return {
      phrases: [makePhrase(`retry ${calls}`)],
      source: 'openai',
      context: '{}',
      trace: { meta: {}, whole_batch_fallback: { flag: false } },
    };
  }, async (server) => {
    const pathName = `/api/v1/batch?device_id=${deviceId}&window=evening&timezone=Asia%2FAlmaty&local_date=2026-09-26`;
    const first = await requestJson(server, pathName);
    const second = await requestJson(server, pathName);
    const third = await requestJson(server, pathName);
    assert.strictEqual(calls, 2, 'one retry after whole-batch fallback is allowed, third request reuses');
    assert.notDeepStrictEqual(second.json.phrases, first.json.phrases, 'second request after fallback must regenerate');
    assert.deepStrictEqual(third.json.phrases, second.json.phrases, 'third request must reuse the retry result');
  });
}

async function testConcurrentRequestsShareOneGeneration() {
  const deviceId = 'concurrent-cache-device';
  insertFullDevice(deviceId);
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await withMockedBatchRoute(async () => {
    calls += 1;
    await gate;
    return {
      phrases: [makePhrase('concurrent result')],
      source: 'openai',
      context: '{}',
      trace: { meta: {}, whole_batch_fallback: { flag: false } },
    };
  }, async (server) => {
    const pathName = `/api/v1/batch?device_id=${deviceId}&window=night&timezone=Asia%2FAlmaty&local_date=2026-09-26`;
    const firstPromise = requestJson(server, pathName);
    const secondPromise = requestJson(server, pathName);
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.strictEqual(calls, 1, 'concurrent requests with one key must share one generation');
    assert.deepStrictEqual(second.json.phrases, first.json.phrases);
  });
}

async function testProfileRequiredFlag() {
  const incompleteDeviceId = 'profile-required-device';
  const completeDeviceId = 'profile-complete-device';
  db.prepare('INSERT OR IGNORE INTO devices (device_id, timezone) VALUES (?, ?)')
    .run(incompleteDeviceId, 'Asia/Almaty');
  insertFullDevice(completeDeviceId);

  await withMockedBatchRoute(async () => ({
    phrases: [makePhrase('profile test')],
    source: 'openai',
    context: '{}',
    trace: { meta: {}, whole_batch_fallback: { flag: false } },
  }), async (server) => {
    const missing = await requestJson(server, `/api/v1/batch?device_id=${incompleteDeviceId}&window=day&timezone=Asia%2FAlmaty&local_date=2026-09-26`);
    const complete = await requestJson(server, `/api/v1/batch?device_id=${completeDeviceId}&window=day&timezone=Asia%2FAlmaty&local_date=2026-09-26`);
    assert.strictEqual(missing.json.profile_required, true, 'missing name/birth_date must set profile_required');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(complete.json, 'profile_required'),
      false,
      'complete profile must omit profile_required'
    );
  });
}

// The 'night' window spans midnight: a request at 19:30 on day D (the night
// just starting) and a "recovery" request at 02:00 on day D+1 (still the
// same night, clock already past midnight, but the phone's own local_date
// has genuinely rolled over) must reuse the SAME batch -- not regenerate
// just because the calendar date advanced between the two requests. Uses a
// dedicated inline mock (not withMockedBatchRoute, which hardcodes a fixed
// time/date) so resolveLocalDateContext can return a realistic, different
// time/date pair per request, matching what the two real requests would
// actually send.
async function testNightWindowReuseKeyCrossesMidnight() {
  const deviceId = 'night-midnight-device';
  insertFullDevice(deviceId);
  let calls = 0;
  const originalLoad = Module._load;
  delete require.cache[require.resolve('../src/routes/batch')];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../contentGenerator') {
      return {
        generateBatch: async (device, window) => {
          calls += 1;
          return {
            phrases: [makePhrase(`night ${calls}`)],
            source: 'openai',
            context: '{}',
            trace: { meta: {}, whole_batch_fallback: { flag: false } },
          };
        },
        resolveLocalDateContext: (timezone, forcedLocalDate) => {
          const isPostMidnight = forcedLocalDate === '2026-09-27';
          return {
            dateContext: {
              date: forcedLocalDate,
              weekday: isPostMidnight ? 'Sunday' : 'Saturday',
              // The evening request is at 19:30 (night just starting); the
              // recovery request is at 02:00 the next calendar day (still
              // the same night, past midnight).
              time: isPostMidnight ? '02:00' : '19:30',
              tomorrow_date: isPostMidnight ? '2026-09-28' : '2026-09-27',
              tomorrow_weekday: isPostMidnight ? 'Monday' : 'Sunday',
            },
            unavailableReason: null,
          };
        },
        addDaysToDateString: (date, days) => {
          const instant = new Date(`${date}T00:00:00Z`);
          instant.setUTCDate(instant.getUTCDate() + days);
          return instant.toISOString().slice(0, 10);
        },
      };
    }
    if (request === '../weather') {
      return {
        resolveGeolocation: async () => ({ success: true, country_code: 'KZ' }),
        resolveWeather: async () => ({ countryCode: 'KZ', temperatureC: 18, description: 'clear' }),
      };
    }
    if (request === '../morningPack') {
      return {
        computeTargetDate: (window, dateContext) => (dateContext ? dateContext.date : null),
        getExistingMorningPack: () => null,
        getOrGenerateMorningPack: async () => null,
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
      res.status(500).json({ error: err.message });
    });
    server = await new Promise((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });

    // Evening request: local_date=2026-09-26, local time 19:30.
    const evening = await requestJson(
      server,
      `/api/v1/batch?device_id=${deviceId}&window=night&timezone=Asia%2FAlmaty&local_date=2026-09-26`
    );
    // Recovery request the next calendar day: local_date=2026-09-27, local
    // time 02:00 -- still logically the same night.
    const recovery = await requestJson(
      server,
      `/api/v1/batch?device_id=${deviceId}&window=night&timezone=Asia%2FAlmaty&local_date=2026-09-27`
    );

    assert.strictEqual(calls, 1, 'a post-midnight recovery request for the same night must reuse the batch, not regenerate');
    assert.deepStrictEqual(recovery.json.phrases, evening.json.phrases, 'recovery response must reuse the same phrases');
    assert.strictEqual(recovery.json.batch_id, evening.json.batch_id, 'recovery response must reuse the same batch id');
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/routes/batch')];
  }
}

async function main() {
  await testSecondRequestReusesBatchAndTrace();
  await testDifferentWindowOrDateGeneratesNormally();
  await testWholeBatchFallbackAllowsOneRetry();
  await testConcurrentRequestsShareOneGeneration();
  await testProfileRequiredFlag();
  await testNightWindowReuseKeyCrossesMidnight();
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('batch-reuse-cache.test.js: all assertions passed');
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
