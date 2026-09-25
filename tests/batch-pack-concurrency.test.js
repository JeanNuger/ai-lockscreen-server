// Proves routes/batch.js actually runs the ordinary batch's OpenAI call and
// the morning pack's OpenAI call CONCURRENTLY (Promise.all), not
// sequentially. Mocks `openai` so every chat.completions.create call takes a
// fixed artificial delay, then hits the real /api/v1/batch route end to end
// (real generateBatch/generateMorningPack/planSlots/planMorningPack code, only
// the network-facing pieces are mocked) and asserts the TOTAL wall-clock time
// for the request is close to ONE call's delay, not the sum of both -- if
// this were still sequential (pack generated only after generateBatch
// finishes, as it was before this task), the request would take roughly
// 2x DELAY_MS.
//
// No weather.js mocking is needed: the test HTTP client connects over
// loopback, so req.ip is 127.0.0.1/::1 -- weather.js's own
// isPrivateOrLocalIp() guard short-circuits before any network call, so
// resolveWeather/resolveGeolocation/resolveWeatherForecast all resolve
// near-instantly without needing a mock.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-batch-pack-concurrency-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
process.env.OPENAI_API_KEY = 'test-key-concurrency';

const db = require('../src/db');
const { STYLE_IDS } = require('../src/constants');

function insertDevice(deviceId) {
  db.prepare(`
    INSERT INTO devices (device_id, name, gender, birth_date, timezone, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(deviceId, 'Aika', 'female', '1996-05-01', 'UTC', '2026-01-01 00:00:00');
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

const DELAY_MS = 300;

// Must stay comfortably under LOCK_SCREEN_TEXT_MAX_LENGTH (70 chars) -- a
// too-long mock phrase would trigger this content's own internal repair
// round (a second, sequential OpenAI call within generateBatch itself),
// which would confound this test's timing assertion with something that has
// nothing to do with batch/pack concurrency.
function genericPhrase(slot, index) {
  return `A calm thought about ${slot.type.replace(/_/g, ' ')}, part ${index}`.slice(0, 65);
}

async function testBatchAndPackRunConcurrently() {
  insertDevice('concurrency-device');

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'openai') {
      return class MockOpenAI {
        constructor() {
          this.chat = {
            completions: {
              create: async (requestBody) => {
                // The artificial per-call delay -- both the batch call and
                // the pack call go through this same mock, so if they run
                // concurrently their delays overlap; if sequential, they add up.
                await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
                const payload = JSON.parse(requestBody.messages[1].content);
                const phrases = payload.slots.map((slot, index) => ({
                  slot_id: slot.slot_id,
                  text: genericPhrase(slot, index),
                  style_id: STYLE_IDS[index % STYLE_IDS.length],
                }));
                return { choices: [{ message: { content: JSON.stringify({ phrases }) } }] };
              },
            },
          };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[require.resolve('../src/routes/batch')];
  const router = require('../src/routes/batch');
  const app = express();
  app.use('/api/v1', router);
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  let server;
  try {
    server = await new Promise((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });

    const start = Date.now();
    const response = await requestJson(
      server,
      '/api/v1/batch?device_id=concurrency-device&window=morning&timezone=UTC&supports_morning_pack=1'
    );
    const elapsed = Date.now() - start;

    assert.strictEqual(response.statusCode, 200, 'batch request must succeed');
    assert(Array.isArray(response.json.phrases) && response.json.phrases.length > 0, 'ordinary batch phrases must be present');
    assert(response.json.morning_pack, 'a morning pack must have been generated');
    assert(
      Array.isArray(response.json.morning_pack.phrases) && response.json.morning_pack.phrases.length > 0,
      'morning pack must contain phrases'
    );

    // The actual proof of parallelism (not just an assumption): sequential
    // generation would take roughly 2 * DELAY_MS (each generator waits out
    // its own OpenAI call before the other one even starts). Concurrent
    // generation overlaps both delays, so the whole request should complete
    // close to a single DELAY_MS.
    assert(
      elapsed < DELAY_MS * 1.7,
      `expected concurrent batch+pack generation to take close to one call's delay (~${DELAY_MS}ms), took ${elapsed}ms -- looks sequential`
    );
    assert(
      elapsed >= DELAY_MS,
      `sanity check: elapsed (${elapsed}ms) must be at least one call's delay (${DELAY_MS}ms)`
    );

    console.log(`[batch-pack-concurrency] elapsed=${elapsed}ms delay_per_call=${DELAY_MS}ms (sequential would be ~${DELAY_MS * 2}ms)`);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/routes/batch')];
  }
}

async function main() {
  await testBatchAndPackRunConcurrently();
}

main()
  .then(() => {
    console.log('[batch-pack-concurrency] all scenarios passed');
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
