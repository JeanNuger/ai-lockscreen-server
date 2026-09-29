// Owner-specified retry/backoff for the primary OpenAI call (ordinary batch
// and morning pack): up to 3 retries (1s/2s/3s pauses) on transient
// failures -- network errors, timeouts, 429, 5xx, and a broken/off-schema
// response (parse_or_schema_error) -- but never on 400/401/403 or a missing
// key, where retrying can't help. Drives this entirely through the real
// generateBatch() (see contentGenerator.js's callOpenAiBatchWithRetry),
// mocking only the `openai` package's chat.completions.create call. Each
// attempt (success or failure) logs one OPENAI_ATTEMPT scope=batch line --
// never AI_BATCH_ERROR, which stays reserved for the final give-up/other
// failure reasons -- so a mid-retry success is never mistaken for a
// reportable error.
//   1. two 500s then a success -> the batch is generated normally, 3 calls.
//   2. a 401 -> no retry at all, 1 call, empty fallback batch.
//   3. four 500s in a row (every attempt fails) -> empty fallback batch,
//      exactly 4 calls (1 initial + 3 retries), no more.
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
              create: async (requestBody) => {
                callCount += 1;
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

// --- Case 1: two 500s, then success -> batch is present --------------------
async function testTwo500sThenSuccess() {
  process.env.OPENAI_API_KEY = 'test-key-retry-two-500s';
  const deviceId = 'retry-two-500s-device';
  insertDevice(deviceId);
  try {
    await withMockedOpenAi(
      (callCount) => (callCount <= 2
        ? { error: makeError({ name: 'InternalServerError', status: 500, message: 'server had a problem' }) }
        : null),
      async (getCallCount) => {
        const { result, lines } = await captureConsole(() => runBatch(deviceId));
        assert.strictEqual(getCallCount(), 3, 'must retry exactly twice (3 total calls) before succeeding on the 3rd');
        assert(result.phrases.length > 0, 'a batch must be produced once the 3rd attempt succeeds');
        assert(
          lines.some((l) => l.startsWith('OPENAI_ATTEMPT scope=batch result=openai_error') && l.includes('attempt=1/4') && l.includes('err_status=500')),
          'attempt 1 failure must be logged as OPENAI_ATTEMPT scope=batch result=openai_error attempt=1/4 err_status=500'
        );
        assert(
          lines.some((l) => l.startsWith('OPENAI_ATTEMPT scope=batch result=openai_error') && l.includes('attempt=2/4') && l.includes('err_status=500')),
          'attempt 2 failure must be logged as OPENAI_ATTEMPT scope=batch result=openai_error attempt=2/4 err_status=500'
        );
        assert(
          lines.some((l) => l.startsWith('OPENAI_ATTEMPT scope=batch result=success') && l.includes('attempt=3/4')),
          'attempt 3 success must be logged as OPENAI_ATTEMPT scope=batch result=success attempt=3/4'
        );
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
          lines.some((l) => l.startsWith('OPENAI_ATTEMPT scope=batch result=openai_error') && l.includes('attempt=1/4') && l.includes('err_status=401')),
          'the single failed attempt must be logged as OPENAI_ATTEMPT scope=batch result=openai_error attempt=1/4 err_status=401'
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

// --- Case 3: 4 failures in a row -> empty batch, exactly 4 attempts --------
async function testFourFailuresExhaustsRetries() {
  process.env.OPENAI_API_KEY = 'test-key-retry-four-failures';
  const deviceId = 'retry-four-failures-device';
  insertDevice(deviceId);
  try {
    await withMockedOpenAi(
      () => ({ error: makeError({ name: 'InternalServerError', status: 500, message: 'server had a problem' }) }),
      async (getCallCount) => {
        const { result, lines } = await captureConsole(() => runBatch(deviceId));
        assert.strictEqual(getCallCount(), 4, 'must attempt exactly 4 times (1 initial + 3 retries), never more');
        assert.strictEqual(result.phrases.length, 0, 'exhausting all retries must fall back to an empty batch');
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          assert(
            lines.some((l) => l.startsWith('OPENAI_ATTEMPT scope=batch result=openai_error') && l.includes(`attempt=${attempt}/4`) && l.includes('err_status=500')),
            `attempt ${attempt} failure must be logged as OPENAI_ATTEMPT scope=batch result=openai_error attempt=${attempt}/4`
          );
        }
        assert(
          lines.some((l) => l.startsWith('AI_BATCH_RESULT') && l.includes('reason=openai_error')),
          'AI_BATCH_RESULT must report reason=openai_error once all 4 attempts fail'
        );
      }
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
}

async function main() {
  await testTwo500sThenSuccess();
  await test401NoRetry();
  await testFourFailuresExhaustsRetries();
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
