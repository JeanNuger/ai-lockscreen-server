// Owner decision: a rejected slot now gets up to 2 regenerate (repair)
// attempts before it is dropped, not 1. This covers exactly the three cases
// the decision calls out, all driven through the real generateBatch():
//   1. a slot fails the first repair attempt but passes the second -> it
//      ends up in the final batch;
//   2. a slot fails both repair attempts -> it is dropped, and one
//      SLOT_DROPPED_AFTER_REPAIR log line names its type and reason;
//   3. every rejected slot is fixed on the first repair attempt -> no
//      second repair call is ever made (only 2 OpenAI calls total: the
//      first pass + one repair round).
// In all three cases, slot 0 (index 0 of whatever planSlots actually
// produces for this device/window) is the one under test; every other slot
// is always answered with valid, unique text on every call so only slot 0's
// outcome drives the assertions.
const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-repair-attempts-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');

const db = require('../src/db');
const { STYLE_IDS } = require('../src/constants');
const { generateBatch, _test: contentTest } = require('../src/contentGenerator');

const OVERLONG_TEXT = 'x'.repeat(contentTest.LOCK_SCREEN_TEXT_MAX_LENGTH + 20);

function otherSlotsText(slot, index, callCount) {
  return `Concrete filler call${callCount} slot${index} ${slot.slot_id}`;
}

function insertDevice(deviceId) {
  db.prepare(`
    INSERT INTO devices (device_id, name, gender, birth_date, timezone, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(deviceId, 'Nurlan', 'male', '1992-06-10', 'Asia/Almaty', '2026-09-01 00:00:00');
}

function captureConsole(callback) {
  const originalWarn = console.warn;
  const originalLog = console.log;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  console.log = () => {};
  return Promise.resolve()
    .then(callback)
    .then((result) => {
      console.warn = originalWarn;
      console.log = originalLog;
      return { result, warnings };
    })
    .catch((err) => {
      console.warn = originalWarn;
      console.log = originalLog;
      throw err;
    });
}

// slot0Behavior(callCount) -> text for slot 0 on that OpenAI call (1 = first
// pass, 2 = repair round 1, 3 = repair round 2, if it happens at all).
function withMockedOpenAi(slot0Behavior, run) {
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
                const payload = JSON.parse(requestBody.messages[1].content);
                const thisCall = callCount;
                return {
                  choices: [{
                    message: {
                      content: JSON.stringify({
                        phrases: payload.slots.map((slot, index) => ({
                          slot_id: slot.slot_id,
                          text: index === 0 ? slot0Behavior(thisCall) : otherSlotsText(slot, index, thisCall),
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

// --- Case 1: fails the first repair attempt, passes the second ------------
async function testFailsFirstAttemptPassesSecond() {
  process.env.OPENAI_API_KEY = 'test-key-repair-pass-second';
  const deviceId = 'repair-pass-second-device';
  insertDevice(deviceId);
  try {
    await withMockedOpenAi(
      (callCount) => (callCount <= 2 ? OVERLONG_TEXT : 'A concrete fixed line for slot zero'),
      async (getCallCount) => {
        const result = await runBatch(deviceId);
        assert.strictEqual(getCallCount(), 3, 'first pass + 2 repair attempts must all fire when the slot only passes on the second attempt');
        assert(
          result.phrases.some((p) => p.text === 'A concrete fixed line for slot zero'),
          'the slot fixed on the second repair attempt must be present in the final batch'
        );
      }
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
}

// --- Case 2: fails both repair attempts -> dropped -------------------------
async function testFailsBothAttemptsIsDropped() {
  process.env.OPENAI_API_KEY = 'test-key-repair-drop-both';
  const deviceId = 'repair-drop-both-device';
  insertDevice(deviceId);
  try {
    await withMockedOpenAi(
      () => OVERLONG_TEXT,
      async (getCallCount) => {
        const { result, warnings } = await captureConsole(() => runBatch(deviceId));
        assert.strictEqual(getCallCount(), 3, 'first pass + 2 repair attempts must all fire, even though none of them fix the slot');
        assert(
          !result.phrases.some((p) => p.text === OVERLONG_TEXT),
          'a slot that fails both repair attempts must not appear in the final batch'
        );
        assert(
          warnings.some((line) => line.startsWith('SLOT_DROPPED_AFTER_REPAIR') && line.includes('reason=too_long')),
          'dropping the slot after both repair attempts must log one SLOT_DROPPED_AFTER_REPAIR line with its reason'
        );
      }
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
}

// --- Case 3: fixed on the first repair attempt -> no second repair call ---
async function testFixedOnFirstAttemptSkipsSecondCall() {
  process.env.OPENAI_API_KEY = 'test-key-repair-no-second-call';
  const deviceId = 'repair-no-second-call-device';
  insertDevice(deviceId);
  try {
    await withMockedOpenAi(
      (callCount) => (callCount === 1 ? OVERLONG_TEXT : 'A concrete fixed line on the first repair attempt'),
      async (getCallCount) => {
        const result = await runBatch(deviceId);
        assert.strictEqual(getCallCount(), 2, 'everything fixed on the first repair attempt must never trigger a second regenerate call');
        assert(
          result.phrases.some((p) => p.text === 'A concrete fixed line on the first repair attempt'),
          'the slot fixed on the first repair attempt must be present in the final batch'
        );
      }
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
}

async function main() {
  await testFailsFirstAttemptPassesSecond();
  await testFailsBothAttemptsIsDropped();
  await testFixedOnFirstAttemptSkipsSecondCall();
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('repair-two-attempts.test.js: all assertions passed');
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
