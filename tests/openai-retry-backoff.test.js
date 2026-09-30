// Owner-specified retry/backoff for the primary OpenAI call (ordinary batch
// and morning pack): 60s per attempt, at most 2 attempts (1 retry after a 1s
// pause) on transient failures -- network errors, timeouts, 429, 5xx, and a broken/off-schema
// response (parse_or_schema_error) -- but never on 400/401/403 or a missing
// key, where retrying can't help. Drives this entirely through the real
// generateBatch() (see contentGenerator.js's callOpenAiBatchWithRetry),
// mocking only the `openai` package's chat.completions.create call. Each
// attempt (success or failure) logs one OPENAI_ATTEMPT scope=batch line --
// never AI_BATCH_ERROR, which stays reserved for the final give-up/other
// failure reasons -- so a mid-retry success is never mistaken for a
// reportable error.
//   1. one 500 then a success -> the batch is generated normally, 2 calls,
//      each primary call made with a 60s timeout.
//   2. a 401 -> no retry at all, 1 call, empty fallback batch.
//   3. two 500s in a row (every attempt fails) -> empty fallback batch,
//      exactly 2 calls (1 initial + 1 retry), no more.
//   4. a timeout (no HTTP status) is retried once, then the batch is empty.
const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-retry-backoff-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');

const db = require('../src/db');
const { STYLE_IDS } = require('../src/constants');
const { generateBatch } = require('../src/contentGenerator');

function insertDevice(deviceId) {
  db.prepare(`
    INSERT INTO devices (device_id, name, gender, birth_date, timezone, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(deviceId, 'Nurlan', 'male', '1992-06-10', 'Asia/Almaty', '2026-09-01 00:00:00');
}

let seenOptions = [];

function makeError({ name, status, message }) {
  const err = new Error(message);
  err.name = name;
  if (status !== undefined) {
    err.status = status;
  }
  return err;
}

function captureConsole(callback) {
  const originalError = console.error;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const lines = [];
  console.error = (message) => lines.push(String(message));
  console.log = (message) => lines.push(String(message));
  console.warn = (message) => lines.push(String(message));
  return Promise.resolve()
    .then(callback)
    .then((result) => {
      console.error = originalError;
      console.log = originalLog;
      console.warn = originalWarn;
      return { result, lines };
    })
    .catch((err) => {
      console.error = originalError;
      console.log = originalLog;
      console.warn = originalWarn;
      throw err;
    });
}

// callBehavior(callCount) -> either { error } to throw, or nothing (call
// succeeds with valid, unique, well-formed text for every slot).
function withMockedOpenAi(callBehavior, run) {
  const originalLoad = Module._load;
  let callCount = 0;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'openai') {
      return class MockOpenAI {
        constructor() {
          this.chat = {
            completions: {
              create: async (requestBody, options) => {
                callCount += 1;
                seenOptions.push(options);
                const thisCall = callCount;
                const behavior = callBehavior(thisCall);
                if (behavior && behavior.error) {
                  throw behavior.error;
                }
                const payload = JSON.parse(requestBody.messages[1].content);
                return {
                  choices: [{
                    message: {
                      content: JSON.stringify({
                        phrases: payload.slots.map((slot, index) => ({
                          slot_id: slot.slot_id,
                          text: `Concrete filler call${thisCall} slot${index} ${slot.slot_id}`,
                          style_id: STYLE_IDS[index % STYLE_IDS.length],
                        })),
                      }),
                    },
                  }],
                };
              },
            },
          };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  return run(() => callCount).finally(() => {
    Module._load = originalLoad;
  });
}

async function runBatch(deviceId) {
  return generateBatch(
    { device_id: deviceId, timezone: 'Asia/Almaty', created_at: '2026-09-01 00:00:00' },
    'day',
    { system_language: 'en' },
    null
  );
}

// --- Case 1: one 500, then success -> batch is present ---------------------
async function testOne500ThenSuccess() {
  seenOptions = [];
  process.env.OPENAI_API_KEY = 'test-key-retry-two-500s';
  const deviceId = 'retry-two-500s-device';
  insertDevice(deviceId);
  try {
    await withMockedOpenAi(
      (callCount) => (callCount <= 1
        ? { error: makeError({ name: 'InternalServerError', status: 500, message: 'server had a problem' }) }
        : null),
      async (getCallCount) => {
        const { result, lines } = await captureConsole(() => runBatch(deviceId));
        assert.strictEqual(getCallCount(), 2, 'must retry exactly once (2 total calls) before succeeding on the 2nd');
        assert(result.phrases.length > 0, 'a batch must be produced once the 2nd attempt succeeds');
        assert(
          lines.some((l) => l.startsWith('OPENAI_ATTEMPT scope=batch result=openai_error') && l.includes('attempt=1/2') && l.includes('err_status=500')),
          'attempt 1 failure must be logged as OPENAI_ATTEMPT scope=batch result=openai_error attempt=1/2 err_status=500'
        );
        assert(
          lines.some((l) => l.startsWith('OPENAI_ATTEMPT scope=batch result=success') && l.includes('attempt=2/2')),
          'attempt 2 success must be logged as OPENAI_ATTEMPT scope=batch result=success attempt=2/2'
        );
        assert(seenOptions.length >= 2, 'both primary calls must pass request options');
        for (const options of seenOptions.slice(0, 2)) {
          assert.strictEqual(options.timeout, 60000, 'each primary OpenAI attempt must wait up to 60s');
          assert.strictEqual(options.maxRetries, 0, 'the SDK must not add its own retries on top');
        }
        assert(
          !lines.some((l) => l.startsWith('AI_BATCH_ERROR')),
          'a batch that eventually succeeds must never log an AI_BATCH_ERROR line -- only OPENAI_ATTEMPT per-attempt lines'
        );
        assert(
          lines.some((l) => l.startsWith('AI_BATCH_RESULT') && !l.includes('reason=openai_error')),
          'the final AI_BATCH_RESULT line must not report openai_error once the batch succeeded'
        );
      }
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
}

// --- Case 2: 401 -> no retry at all -----------------------------------------
async function test401NoRetry() {
  process.env.OPENAI_API_KEY = 'test-key-retry-401';
  const deviceId = 'retry-401-device';
  insertDevice(deviceId);
  try {
    await withMockedOpenAi(
      () => ({ error: makeError({ name: 'AuthenticationError', status: 401, message: 'Incorrect API key provided' }) }),
      async (getCallCount) => {
        const { result, lines } = await captureConsole(() => runBatch(deviceId));
        assert.strictEqual(getCallCount(), 1, 'a 401 must never be retried -- exactly 1 call total');
        assert.strictEqual(result.phrases.length, 0, 'a 401 with no retry must fall back to an empty batch');
        assert(
          lines.some((l) => l.startsWith('OPENAI_ATTEMPT scope=batch result=openai_error') && l.includes('attempt=1/2') && l.includes('err_status=401')),
          'the single failed attempt must be logged as OPENAI_ATTEMPT scope=batch result=openai_error attempt=1/2 err_status=401'
        );
        assert(
          lines.some((l) => l.startsWith('AI_BATCH_RESULT') && l.includes('reason=openai_error')),
          'AI_BATCH_RESULT must report reason=openai_error'
        );
      }
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
}

// --- Case 3: 2 failures in a row -> empty batch, exactly 2 attempts --------
async function testTwoFailuresExhaustsRetries() {
  process.env.OPENAI_API_KEY = 'test-key-retry-two-failures';
  const deviceId = 'retry-two-failures-device';
  insertDevice(deviceId);
  try {
    await withMockedOpenAi(
      () => ({ error: makeError({ name: 'InternalServerError', status: 500, message: 'server had a problem' }) }),
      async (getCallCount) => {
        const { result, lines } = await captureConsole(() => runBatch(deviceId));
        assert.strictEqual(getCallCount(), 2, 'must attempt exactly 2 times (1 initial + 1 retry), never more');
        assert.strictEqual(result.phrases.length, 0, 'exhausting all retries must fall back to an empty batch');
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          assert(
            lines.some((l) => l.startsWith('OPENAI_ATTEMPT scope=batch result=openai_error') && l.includes(`attempt=${attempt}/2`) && l.includes('err_status=500')),
            `attempt ${attempt} failure must be logged as OPENAI_ATTEMPT scope=batch result=openai_error attempt=${attempt}/2`
          );
        }
        assert(
          lines.some((l) => l.startsWith('AI_BATCH_RESULT') && l.includes('reason=openai_error')),
          'AI_BATCH_RESULT must report reason=openai_error once both attempts fail'
        );
      }
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
}

// --- Case 4: a timeout (no HTTP status) is retried once, then gives up -----
async function testTimeoutRetriedOnce() {
  process.env.OPENAI_API_KEY = 'test-key-retry-timeout';
  const deviceId = 'retry-timeout-device';
  insertDevice(deviceId);
  try {
    await withMockedOpenAi(
      () => ({ error: makeError({ name: 'APIConnectionTimeoutError', message: 'Request timed out.' }) }),
      async (getCallCount) => {
        const { result, lines } = await captureConsole(() => runBatch(deviceId));
        assert.strictEqual(getCallCount(), 2, 'a timeout must be attempted exactly twice');
        assert.strictEqual(result.phrases.length, 0, 'two timeouts fall back to an empty batch');
        assert(
          lines.some((l) => l.startsWith('OPENAI_ATTEMPT scope=batch result=openai_error') && l.includes('attempt=2/2') && l.includes('APIConnectionTimeoutError')),
          'the second timeout must be logged as attempt=2/2'
        );
      }
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
}

async function main() {
  await testOne500ThenSuccess();
  await test401NoRetry();
  await testTwoFailuresExhaustsRetries();
  await testTimeoutRetriedOnce();
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('openai-retry-backoff.test.js: all assertions passed');
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
