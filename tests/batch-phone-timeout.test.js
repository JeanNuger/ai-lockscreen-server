// A phone that gives up waiting (its own read/call timeout) must not lose the batch:
//   1. The server keeps generating after the client disconnects and stores the batch.
//   2. The phone's next request for the same device/window/date is answered from that
//      stored batch, with NO new generation (no new OpenAI call).
//   3. A retry that arrives while the first generation is still running joins it instead of
//      starting a second one.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-phone-timeout-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requestJson(server, pathName) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${pathName}`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, json: body ? JSON.parse(body) : null }));
    }).on('error', reject);
  });
}

// Sends the request and hangs up after `giveUpAfterMs`, like a phone whose timeout fired.
function requestAndGiveUp(server, pathName, giveUpAfterMs) {
  const port = server.address().port;
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}${pathName}`);
    req.on('error', () => {});
    setTimeout(() => {
      req.destroy();
      resolve();
    }, giveUpAfterMs);
  });
}

async function withRoute(generateBatchImpl, callback) {
  const originalLoad = Module._load;
  delete require.cache[require.resolve('../src/routes/batch')];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../contentGenerator') {
      return {
        generateBatch: generateBatchImpl,
        resolveLocalDateContext: () => ({
          dateContext: { date: '2026-09-30', weekday: 'Wednesday', time: '07:30', tomorrow_date: '2026-10-01', tomorrow_weekday: 'Thursday' },
          unavailableReason: null,
        }),
      };
    }
    if (request === '../weather') {
      return {
        resolveGeolocation: async () => null,
        resolveWeather: async () => null,
        resolveWeatherByCoords: async () => null,
      };
    }
    if (request === '../adminMessages') return { consumePendingMessages: () => [] };
    return originalLoad.call(this, request, parent, isMain);
  };
  let server;
  try {
    const app = express();
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

function slowGenerator(counter, delayMs) {
  return async () => {
    counter.calls += 1;
    await sleep(delayMs);
    return {
      phrases: [{ text: `generated ${counter.calls}`, style_id: 'A1' }],
      source: 'openai',
      context: '{}',
      trace: { meta: {}, whole_batch_fallback: { flag: false } },
    };
  };
}

async function testBatchIsSavedAfterThePhoneGivesUp() {
  db.prepare('INSERT INTO devices (device_id, timezone) VALUES (?, ?)').run('timeout-device', 'Asia/Almaty');
  const counter = { calls: 0 };
  await withRoute(slowGenerator(counter, 400), async (server) => {
    const pathName = '/api/v1/batch?device_id=timeout-device&window=morning&timezone=Asia%2FAlmaty';

    // The phone hangs up after 60 ms; generation takes 400 ms.
    await requestAndGiveUp(server, pathName, 60);
    assert.strictEqual(counter.calls, 1, 'generation started');
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS c FROM content_batches WHERE device_id = ?').get('timeout-device').c, 0,
      'nothing stored yet while generation is still running'
    );

    await sleep(700);
    const stored = db.prepare('SELECT phrases, source FROM content_batches WHERE device_id = ?').all('timeout-device');
    assert.strictEqual(stored.length, 1, 'the finished batch is stored even though the phone is gone');
    assert.strictEqual(stored[0].source, 'openai');

    // The phone asks again: served from the stored batch, no new generation.
    const retry = await requestJson(server, pathName);
    assert.strictEqual(retry.statusCode, 200);
    assert.deepStrictEqual(retry.json.phrases, [{ text: 'generated 1', style_id: 'A1' }]);
    assert.strictEqual(counter.calls, 1, 'the retry must not start a new generation (no new OpenAI call)');
  });
}

async function testRetryDuringGenerationJoinsIt() {
  db.prepare('INSERT INTO devices (device_id, timezone) VALUES (?, ?)').run('join-device', 'Asia/Almaty');
  const counter = { calls: 0 };
  await withRoute(slowGenerator(counter, 400), async (server) => {
    const pathName = '/api/v1/batch?device_id=join-device&window=morning&timezone=Asia%2FAlmaty';
    await requestAndGiveUp(server, pathName, 60);
    // Second request arrives while the first generation is still running.
    const joined = await requestJson(server, pathName);
    assert.strictEqual(joined.statusCode, 200);
    assert.deepStrictEqual(joined.json.phrases, [{ text: 'generated 1', style_id: 'A1' }]);
    assert.strictEqual(counter.calls, 1, 'a retry during generation joins it instead of calling OpenAI again');
  });
}

async function main() {
  await testBatchIsSavedAfterThePhoneGivesUp();
  await testRetryDuringGenerationJoinsIt();
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('batch-phone-timeout.test.js: all assertions passed');
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
