// Fixed-order rebuild, step 4: quiz_question/quiz_answer and
// word_learning/word_recall_same_batch must stay internally consistent.
// Covers, all driven through the real generateBatch():
//   1. Rejecting one half of a pair sends BOTH halves to repair together
//      (the already-accepted half is regenerated too, not kept stale).
//   2. If one half of the quiz pair never recovers after all repair
//      attempts, BOTH halves are dropped -- symmetric.
//   3. If only word_recall_same_batch fails to recover, word_learning is
//      kept -- asymmetric (losing the recall alone doesn't take the taught
//      word down with it).
//   4. If word_learning itself fails to recover, word_recall_same_batch is
//      dropped too, even if it was independently accepted.
//   5. PAIR_DROPPED is logged for cases 2 and 4, and NOT logged for case 3.
//   6. Order: quiz_question is always planned before quiz_answer,
//      word_learning always before word_recall_same_batch.
const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-pair-repair-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');

const db = require('../src/db');
const { STYLE_IDS } = require('../src/constants');
const { generateBatch, _test: contentTest } = require('../src/contentGenerator');
const { FIXED_ORDER_BY_WINDOW } = require('../src/slotPlanner');

const OVERLONG_TEXT = 'x'.repeat(contentTest.LOCK_SCREEN_TEXT_MAX_LENGTH + 20);

function insertDevice(deviceId) {
  db.prepare(`
    INSERT INTO devices (device_id, name, gender, birth_date, timezone, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(deviceId, 'Nurlan', 'male', '1992-06-10', 'Asia/Almaty', '2026-09-01 00:00:00');
}

function captureConsole(callback) {
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalLog = console.log;
  const lines = [];
  console.warn = (message) => lines.push(String(message));
  console.error = (message) => lines.push(String(message));
  console.log = () => {};
  return Promise.resolve()
    .then(callback)
    .then((result) => {
      console.warn = originalWarn;
      console.error = originalError;
      console.log = originalLog;
      return { result, lines };
    })
    .catch((err) => {
      console.warn = originalWarn;
      console.error = originalError;
      console.log = originalLog;
      throw err;
    });
}

function fillerText(slot, callNumber) {
  return `Concrete filler call${callNumber} ${slot.type} ${slot.slot_id}`;
}

// behaviorByType(type, callNumber) -> 'overlong' | 'good' | undefined
// (undefined means "use the default filler text", same as 'good'). Records
// every request payload's slots (slot_id + whether it's a repair call) so
// tests can assert exactly which slot_ids were sent to a given call.
function withMockedOpenAi(behaviorByType, run) {
  const originalLoad = Module._load;
  let callCount = 0;
  const requestLog = [];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'openai') {
      return class MockOpenAI {
        constructor() {
          this.chat = {
            completions: {
              create: async (requestBody) => {
                callCount += 1;
                const thisCall = callCount;
                const payload = JSON.parse(requestBody.messages[1].content);
                requestLog.push({
                  call: thisCall,
                  isRepair: payload.repair === 'rewrite_only_these_rejected_slots',
                  slotIds: payload.slots.map((s) => s.slot_id),
                  slotTypes: payload.slots.map((s) => s.type),
                });
                return {
                  choices: [{
                    message: {
                      content: JSON.stringify({
                        phrases: payload.slots.map((slot, index) => {
                          const behavior = behaviorByType(slot.type, thisCall);
                          const text = behavior === 'overlong'
                            ? OVERLONG_TEXT
                            : `${fillerText(slot, thisCall)}`;
                          return {
                            slot_id: slot.slot_id,
                            text,
                            style_id: STYLE_IDS[index % STYLE_IDS.length],
                          };
                        }),
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
  return run(() => callCount, () => requestLog).finally(() => {
    Module._load = originalLoad;
  });
}

async function runBatch(deviceId, window) {
  return generateBatch(
    { device_id: deviceId, timezone: 'Asia/Almaty', created_at: '2026-09-01 00:00:00' },
    window,
    { system_language: 'en' },
    null
  );
}

// --- 0: order sanity -- quiz_question before quiz_answer, word_learning
// before word_recall_same_batch, in every window that has them ---
function testPairOrderWithinFixedOrder() {
  for (const window of Object.keys(FIXED_ORDER_BY_WINDOW)) {
    const order = FIXED_ORDER_BY_WINDOW[window];
    const qIndex = order.indexOf('quiz_question');
    const aIndex = order.indexOf('quiz_answer');
    if (qIndex !== -1 || aIndex !== -1) {
      assert(qIndex !== -1 && aIndex !== -1, `${window}: quiz_question/quiz_answer must both be present or both absent`);
      assert(qIndex < aIndex, `${window}: quiz_question (position ${qIndex + 1}) must come before quiz_answer (position ${aIndex + 1})`);
    }
    const wIndex = order.indexOf('word_learning');
    const rIndex = order.indexOf('word_recall_same_batch');
    if (wIndex !== -1 || rIndex !== -1) {
      assert(wIndex !== -1 && rIndex !== -1, `${window}: word_learning/word_recall_same_batch must both be present or both absent`);
      assert(wIndex < rIndex, `${window}: word_learning (position ${wIndex + 1}) must come before word_recall_same_batch (position ${rIndex + 1})`);
    }
  }
}

// --- 1: rejecting quiz_question sends BOTH halves to repair together ------
async function testRejectedQuizQuestionSendsBothHalvesToRepair() {
  process.env.OPENAI_API_KEY = 'test-key-pair-repair-both';
  const deviceId = 'pair-repair-both-device';
  insertDevice(deviceId);
  try {
    await withMockedOpenAi(
      (type, callNumber) => (callNumber === 1 && type === 'quiz_question' ? 'overlong' : 'good'),
      async (getCallCount, getRequestLog) => {
        const { result } = await captureConsole(() => runBatch(deviceId, 'day'));
        const requestLog = getRequestLog();
        assert(getCallCount() >= 2, 'must fire at least a first pass + one repair call');
        const repairCall = requestLog.find((r) => r.isRepair);
        assert(repairCall, 'a repair call must have been made');
        assert(repairCall.slotIds.length >= 2, 'the repair call must include more than just the rejected slot');
        assert(
          repairCall.slotTypes.includes('quiz_question') && repairCall.slotTypes.includes('quiz_answer'),
          `the repair call must include BOTH quiz_question and quiz_answer, got types: ${JSON.stringify(repairCall.slotTypes)}`
        );
        // Both halves must survive, and the answer's text must be the
        // ROUND-2 regenerated one (proves it wasn't kept stale from round 1).
        const question = result.phrases.find((p) => p.text.includes('quiz_question'));
        const answer = result.phrases.find((p) => p.text.includes('quiz_answer'));
        assert(question, 'quiz_question must survive (fixed on repair)');
        assert(answer, 'quiz_answer must survive');
        assert(!answer.text.startsWith('Concrete filler call1 '), 'quiz_answer must have been REGENERATED on the repair call, not left as its call-1 text');
      }
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
}

// --- 2: quiz_question never recovers -> BOTH halves dropped ---------------
async function testQuizQuestionNeverRecoversDropsBothHalves() {
  process.env.OPENAI_API_KEY = 'test-key-pair-quiz-drop';
  const deviceId = 'pair-quiz-drop-device';
  insertDevice(deviceId);
  try {
    await withMockedOpenAi(
      (type) => (type === 'quiz_question' ? 'overlong' : 'good'),
      async () => {
        const { result, lines } = await captureConsole(() => runBatch(deviceId, 'day'));
        assert(
          !result.phrases.some((p) => p.text.includes('quiz_question')),
          'quiz_question must be absent after exhausting all repair attempts'
        );
        assert(
          !result.phrases.some((p) => p.text.includes('quiz_answer')),
          'quiz_answer must ALSO be absent even though it was always accepted -- symmetric quiz drop rule'
        );
        assert(
          lines.some((l) => l === 'PAIR_DROPPED window=day pair=quiz reason=quiz_question_missing'),
          `must log PAIR_DROPPED for the quiz pair, got: ${JSON.stringify(lines)}`
        );
      }
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
}

// --- 3: only word_recall_same_batch fails -> word_learning is kept --------
async function testOnlyRecallFailsKeepsWordLearning() {
  process.env.OPENAI_API_KEY = 'test-key-pair-recall-only';
  const deviceId = 'pair-recall-only-device';
  insertDevice(deviceId);
  try {
    await withMockedOpenAi(
      (type) => (type === 'word_recall_same_batch' ? 'overlong' : 'good'),
      async () => {
        const { result, lines } = await captureConsole(() => runBatch(deviceId, 'morning'));
        assert(
          result.phrases.some((p) => p.text.includes('word_learning')),
          'word_learning must be KEPT even though word_recall_same_batch never recovered'
        );
        assert(
          !result.phrases.some((p) => p.text.includes('word_recall_same_batch')),
          'word_recall_same_batch itself must be absent (it never recovered)'
        );
        assert(
          !lines.some((l) => l.startsWith('PAIR_DROPPED') && l.includes('pair=word')),
          `no PAIR_DROPPED should be logged for the word pair when only the recall fails, got: ${JSON.stringify(lines)}`
        );
      }
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
}

// --- 4: word_learning itself fails -> word_recall_same_batch dropped too --
async function testWordLearningFailsDropsRecallToo() {
  process.env.OPENAI_API_KEY = 'test-key-pair-word-drop';
  const deviceId = 'pair-word-drop-device';
  insertDevice(deviceId);
  try {
    await withMockedOpenAi(
      (type) => (type === 'word_learning' ? 'overlong' : 'good'),
      async () => {
        const { result, lines } = await captureConsole(() => runBatch(deviceId, 'morning'));
        assert(
          !result.phrases.some((p) => p.text.includes('word_learning')),
          'word_learning must be absent after exhausting all repair attempts'
        );
        assert(
          !result.phrases.some((p) => p.text.includes('word_recall_same_batch')),
          'word_recall_same_batch must ALSO be dropped even though it was independently accepted -- word_learning missing takes it with it'
        );
        assert(
          lines.some((l) => l === 'PAIR_DROPPED window=morning pair=word reason=word_learning_missing'),
          `must log PAIR_DROPPED for the word pair, got: ${JSON.stringify(lines)}`
        );
      }
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
}

// --- Regression: new question accepted, new answer rejected in BOTH repair
// rounds -> neither must survive, and the OLD (round-0) answer text must
// NOT be the one left stale in the final batch. Before the fix, the old
// accepted answer's entry was only removed from assembly.phrases when it
// came back in `repaired` -- filtering by `repairedIds` instead of the full
// `repairSlotIds` -- so a half that got pulled into repair (as the
// rejected question's pair partner) but failed AGAIN on every repair
// attempt never actually left assembly.phrases, and the final batch ended
// up with a freshly-regenerated question paired with a stale, no-longer-
// matching answer.
async function testAnswerRejectedInRepairDoesNotLeaveStaleOldAnswer() {
  process.env.OPENAI_API_KEY = 'test-key-pair-stale-answer-bug';
  const deviceId = 'pair-stale-answer-bug-device';
  insertDevice(deviceId);
  try {
    await withMockedOpenAi(
      (type, callNumber) => {
        if (type === 'quiz_question') {
          // Rejected on the first pass only; accepted on every repair call.
          return callNumber === 1 ? 'overlong' : 'good';
        }
        if (type === 'quiz_answer') {
          // Accepted on the first pass, then rejected on EVERY repair call
          // (both rounds) -- the exact regression scenario.
          return callNumber === 1 ? 'good' : 'overlong';
        }
        return 'good';
      },
      async (getCallCount) => {
        const { result } = await captureConsole(() => runBatch(deviceId, 'day'));
        assert(getCallCount() >= 3, 'must have fired the first pass plus two repair rounds');
        assert(
          !result.phrases.some((p) => p.text.includes('quiz_question')),
          'quiz_question must be absent (its pair partner never recovered)'
        );
        assert(
          !result.phrases.some((p) => p.text.includes('quiz_answer')),
          'quiz_answer must be absent (it was rejected on every repair attempt)'
        );
        assert(
          !result.phrases.some((p) => p.text.startsWith('Concrete filler call1 quiz_answer')),
          'the STALE round-0 (call 1) quiz_answer text must never survive into the final batch'
        );
      }
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
}

async function main() {
  testPairOrderWithinFixedOrder();
  await testRejectedQuizQuestionSendsBothHalvesToRepair();
  await testQuizQuestionNeverRecoversDropsBothHalves();
  await testOnlyRecallFailsKeepsWordLearning();
  await testWordLearningFailsDropsRecallToo();
  await testAnswerRejectedInRepairDoesNotLeaveStaleOldAnswer();
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('pair-repair-drop.test.js: all assertions passed');
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
