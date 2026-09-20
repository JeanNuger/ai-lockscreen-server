const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-learning-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const { BATCH_SIZE, STYLE_IDS } = require('../src/constants');
const {
  MIN_RECALL_AGE_DAYS,
  MAX_RECALL_AGE_DAYS,
  getRecallCandidate,
  recordLearnedWords,
  recordRecalledWords,
} = require('../src/learningMemory');
const {
  planSlots,
  _test: plannerTest,
} = require('../src/slotPlanner');
const {
  generateBatch,
  _test: contentTest,
} = require('../src/contentGenerator');
const { getBankDateString } = require('../src/dailyContentBank');

const insertLearnedWordAtStatement = db.prepare(`
  INSERT INTO device_learning_memory (device_id, word_key, word_text, learned_at)
  VALUES (?, ?, ?, datetime('now', ?))
`);

function insertLearnedWordDaysAgo(deviceId, wordKey, wordText, daysAgo) {
  db.prepare('INSERT OR IGNORE INTO devices (device_id) VALUES (?)').run(deviceId);
  insertLearnedWordAtStatement.run(deviceId, wordKey, wordText, `-${daysAgo} days`);
  return db.prepare('SELECT id FROM device_learning_memory WHERE device_id = ? AND word_key = ?')
    .get(deviceId, wordKey).id;
}

function wordLearningSlot(slotId, word, contentKey = slotId) {
  return { slot_id: slotId, type: 'word_learning', facts: { word }, content_key: contentKey, id: contentKey };
}

function learningRecallSlot(slotId, memoryId, word = 'irrelevant') {
  return { slot_id: slotId, type: 'learning_recall', facts: { word }, learning_memory_id: memoryId };
}

async function main() {
  // --- per-device isolation ---
  insertLearnedWordDaysAgo('device-a', 'word-a', 'device A word', 5);
  assert(getRecallCandidate('device-a'), 'device-a must see its own eligible word');
  assert.strictEqual(getRecallCandidate('device-b'), null, 'device-b must not see device-a learning memory');

  // --- successful word_learning recording ---
  {
    db.prepare('INSERT OR IGNORE INTO devices (device_id) VALUES (?)').run('device-record');
    const rows = recordLearnedWords('device-record', [wordLearningSlot('s1', 'server word')], ['s1']);
    assert.strictEqual(rows, 1, 'a generated, validated word_learning slot must be recorded');
    const stored = db.prepare('SELECT word_text FROM device_learning_memory WHERE device_id = ?').get('device-record');
    assert.strictEqual(stored.word_text, 'server word');
  }

  // --- fallback word_learning must not be recorded ---
  {
    const rows = recordLearnedWords('device-fallback', [wordLearningSlot('s1', 'never stored')], []);
    assert.strictEqual(rows, 0, 'a fallback-filled (not in generatedSlotIds) word_learning slot must not be recorded');
    const count = db.prepare('SELECT COUNT(*) AS c FROM device_learning_memory WHERE device_id = ?').get('device-fallback').c;
    assert.strictEqual(count, 0);
  }

  // --- missing facts.word must be skipped, not fail, and warn ---
  {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    let rows;
    try {
      rows = recordLearnedWords('device-missing-word', [
        { slot_id: 's1', type: 'word_learning', facts: {}, content_key: 's1', id: 's1' },
      ], ['s1']);
    } finally {
      console.warn = originalWarn;
    }
    assert.strictEqual(rows, 0, 'a generated word_learning slot without facts.word must not be recorded');
    assert(warnings.some((w) => w.includes('LEARNING_MEMORY_MISSING_WORD')), 'missing facts.word must emit a concise warning');
    const count = db.prepare('SELECT COUNT(*) AS c FROM device_learning_memory WHERE device_id = ?').get('device-missing-word').c;
    assert.strictEqual(count, 0);
  }

  // --- recall eligibility window ---
  assert.strictEqual(MIN_RECALL_AGE_DAYS, 2);
  assert.strictEqual(MAX_RECALL_AGE_DAYS, 14);

  {
    insertLearnedWordDaysAgo('device-window', 'too-young', 'too young', 1);
    assert.strictEqual(getRecallCandidate('device-window'), null, 'a word learned less than 2 days ago must not be eligible');
  }

  {
    insertLearnedWordDaysAgo('device-window-2d', 'exactly-2', 'exactly two days', 2);
    const candidate = getRecallCandidate('device-window-2d');
    assert(candidate, 'a word learned exactly 2 days ago must be eligible');
    assert.strictEqual(candidate.word_key, 'exactly-2');
  }

  {
    insertLearnedWordDaysAgo('device-window-14d', 'exactly-14', 'exactly fourteen days', 14);
    const candidate = getRecallCandidate('device-window-14d');
    assert(candidate, 'a word learned exactly 14 days ago must be eligible');
    assert.strictEqual(candidate.word_key, 'exactly-14');
  }

  {
    insertLearnedWordDaysAgo('device-window-15d', 'too-old', 'too old', 15);
    assert.strictEqual(getRecallCandidate('device-window-15d'), null, 'a word learned more than 14 days ago must not be eligible');
  }

  // --- empty memory produces no recall ---
  assert.strictEqual(getRecallCandidate('device-empty'), null, 'a device with no learning memory must have no recall candidate');

  // --- deterministic oldest-eligible selection ---
  {
    insertLearnedWordDaysAgo('device-oldest', 'mid', 'mid age word', 6);
    insertLearnedWordDaysAgo('device-oldest', 'oldest', 'oldest word', 10);
    insertLearnedWordDaysAgo('device-oldest', 'youngest', 'youngest eligible word', 3);
    const candidate = getRecallCandidate('device-oldest');
    assert.strictEqual(candidate.word_key, 'oldest', 'the oldest eligible unrecalled word must be selected deterministically');
    // Re-querying must be stable (no randomness).
    assert.strictEqual(getRecallCandidate('device-oldest').word_key, 'oldest');
  }

  // --- successful recall becomes ineligible; failed/fallback recall does not mark recalled ---
  {
    const memoryId = insertLearnedWordDaysAgo('device-recall-success', 'recall-me', 'recall me', 5);
    assert(getRecallCandidate('device-recall-success'), 'word must be eligible before recall');

    // Planning/selecting alone must never mark it recalled.
    assert.strictEqual(
      recordRecalledWords('device-recall-success', [learningRecallSlot('s1', memoryId)], []),
      0,
      'a candidate that was only planned (not generated) must not be marked recalled'
    );
    assert(getRecallCandidate('device-recall-success'), 'word must still be eligible after a non-generated recall slot');

    // Fallback (present but not in generatedSlotIds) must not mark it recalled either.
    assert.strictEqual(
      recordRecalledWords('device-recall-success', [learningRecallSlot('s1', memoryId)], ['some-other-slot']),
      0,
      'a fallback-filled recall slot must not mark the word recalled'
    );
    assert(getRecallCandidate('device-recall-success'), 'word must still be eligible after a fallback recall slot');

    // A genuinely generated+validated recall slot marks it recalled.
    const marked = recordRecalledWords('device-recall-success', [learningRecallSlot('s1', memoryId)], ['s1']);
    assert.strictEqual(marked, 1, 'a generated, validated recall slot must mark the word recalled');
    assert.strictEqual(getRecallCandidate('device-recall-success'), null, 'a successfully recalled word must become ineligible for further recall');

    // At most once: recalling again must be a no-op.
    const markedAgain = recordRecalledWords('device-recall-success', [learningRecallSlot('s1', memoryId)], ['s1']);
    assert.strictEqual(markedAgain, 0, 'an already-recalled word must not be recalled a second time');
  }

  // --- learning_memory_id survives candidate -> planned slot, deterministically selected ---
  {
    const recallCandidateId = 4242;
    const candidates = [
      plannerTest.createCandidate({
        id: `learning_recall_${recallCandidateId}`,
        type: 'learning_recall',
        priority: 100,
        facts: { word: 'needle-token' },
        source: 'learning_memory',
        learning_memory_id: recallCandidateId,
      }),
      ...['science', 'technology', 'culture', 'useful_knowledge', 'money_economics', 'country_fact'].flatMap((type, i) => ([
        plannerTest.createCandidate({ id: `filler_${type}_a`, type, priority: 10, facts: { text: `filler ${type} a ${i}` } }),
        plannerTest.createCandidate({ id: `filler_${type}_b`, type, priority: 10, facts: { text: `filler ${type} b ${i}` } }),
      ])),
    ];
    const { slots } = planSlots({ device: { device_id: 'learning-slot-device' }, window: 'day' }, { seed: 'learning-recall-seed', candidates });
    const recallSlot = slots.find((slot) => slot.type === 'learning_recall');
    assert(recallSlot, 'learning_recall candidate with dominant priority must be selected');
    assert.strictEqual(recallSlot.learning_memory_id, recallCandidateId, 'learning_memory_id must survive candidate -> planned slot unchanged');

    // --- learning_memory_id must NOT appear in the OpenAI payload ---
    const promptJson = contentTest.buildContextPrompt(
      { device_id: 'learning-slot-device', timezone: 'Asia/Almaty' },
      'day',
      {},
      null,
      'en',
      slots,
      null
    );
    assert(!promptJson.includes('learning_memory_id'), 'OpenAI prompt payload must never include learning_memory_id');
    assert(promptJson.includes('needle-token'), 'the selected recall word itself must still reach the prompt as grounded facts.word');
  }

  // --- idiom Daily Bank item now produces word_learning ---
  {
    const idiomCandidate = plannerTest.bankItemToCandidate({
      id: 501,
      category: 'idiom',
      content_text: "In Japanese, 'tsundoku' means buying books you never read.",
      tags: ['global'],
    });
    assert.strictEqual(idiomCandidate.type, 'word_learning', 'idiom bank items must become word_learning candidates');
    assert.strictEqual(
      idiomCandidate.facts.word,
      "In Japanese, 'tsundoku' means buying books you never read.",
      'facts.word must carry the full self-contained bank content_text'
    );
  }

  // --- REAL end-to-end recall path: device_learning_memory -> getRecallCandidate
  // -> generateBatch (real SlotPlanner selection, no manually constructed
  // recall slot) -> OpenAI receives the recall slot with only grounded
  // facts.word -> recordRecalledWords -> the exact row gets recalled_at ->
  // no longer returned by getRecallCandidate. Must run before the next block
  // inserts any daily_content_bank rows: with no timezone/weather/age/gender
  // on this device and zero bank rows yet, collectCandidates offers only the
  // 13 fixed synthetic candidates plus this one real recall candidate --
  // TYPE_CAPS.learning_recall (1) makes its selection a guaranteed count
  // (exactly 12 candidates survive per-type caps for exactly BATCH_SIZE=12
  // slots), not a lucky seed or a hand-built slot.
  {
    const deviceId = 'learning-recall-e2e-device';
    const targetWord = 'EXACT_TARGET_RECALL_WORD';
    const targetMemoryId = insertLearnedWordDaysAgo(deviceId, 'e2e-target', targetWord, 5);
    insertLearnedWordDaysAgo(deviceId, 'e2e-too-old', 'UNRELATED_TOO_OLD_WORD', 20);
    insertLearnedWordDaysAgo(deviceId, 'e2e-too-young', 'UNRELATED_TOO_YOUNG_WORD', 1);

    assert(getRecallCandidate(deviceId), 'target word must be eligible before generateBatch runs');

    let openAiCallCount = 0;
    let capturedRequest = null;
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'openai') {
        return class MockOpenAI {
          constructor() {
            this.chat = {
              completions: {
                create: async (requestBody) => {
                  openAiCallCount += 1;
                  capturedRequest = requestBody;
                  const payload = JSON.parse(requestBody.messages[1].content);
                  return {
                    choices: [{
                      message: {
                        content: JSON.stringify({
                          phrases: payload.slots.map((slot, index) => ({
                            slot_id: slot.slot_id,
                            text: `Concrete recall e2e line ${index + 1}`,
                            style_id: STYLE_IDS[index],
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
    process.env.OPENAI_API_KEY = 'test-key-recall-e2e';

    try {
      const result = await generateBatch(
        { device_id: deviceId },
        'day',
        { system_language: 'en' },
        null,
        {}
      );

      assert.strictEqual(openAiCallCount, 1, 'generating one batch must make exactly one OpenAI call');
      assert.strictEqual(result.source, 'openai');
      assert.strictEqual(result.phrases.length, BATCH_SIZE);

      const payload = JSON.parse(capturedRequest.messages[1].content);
      const recallSlotSent = payload.slots.find((slot) => slot.type === 'learning_recall');
      assert(recallSlotSent, 'SlotPlanner must have actually selected a real learning_recall slot');
      assert.strictEqual(
        recallSlotSent.facts.word,
        targetWord,
        'OpenAI must receive exactly the stored word_text as grounded facts.word'
      );

      const payloadText = JSON.stringify(payload);
      assert(!payloadText.includes('learning_memory_id'), 'learning_memory_id must never reach the OpenAI payload');
      assert(!payloadText.includes('UNRELATED_TOO_OLD_WORD'), 'ineligible learning history must not leak into the prompt');
      assert(!payloadText.includes('UNRELATED_TOO_YOUNG_WORD'), 'ineligible learning history must not leak into the prompt');

      const updatedRow = db.prepare('SELECT recalled_at FROM device_learning_memory WHERE id = ?').get(targetMemoryId);
      assert(updatedRow.recalled_at, 'the exact recalled memory row must have recalled_at set after a real generateBatch call');

      assert.strictEqual(getRecallCandidate(deviceId), null, 'the just-recalled word must no longer be returned by getRecallCandidate');

      const untouchedOld = db.prepare('SELECT recalled_at FROM device_learning_memory WHERE device_id = ? AND word_key = ?').get(deviceId, 'e2e-too-old');
      const untouchedYoung = db.prepare('SELECT recalled_at FROM device_learning_memory WHERE device_id = ? AND word_key = ?').get(deviceId, 'e2e-too-young');
      assert.strictEqual(untouchedOld.recalled_at, null, 'unrelated ineligible history must remain untouched');
      assert.strictEqual(untouchedYoung.recalled_at, null, 'unrelated ineligible history must remain untouched');
    } finally {
      Module._load = originalLoad;
      delete process.env.OPENAI_API_KEY;
    }
  }

  // --- end-to-end: Daily Bank idiom item -> word_learning -> generated -> Learning Memory; single OpenAI call; no raw history leak ---
  {
    const bankDate = getBankDateString();
    db.prepare(`
      INSERT INTO daily_content_bank (bank_date, category, content_text, tags)
      VALUES (?, ?, ?, ?)
    `).run(bankDate, 'idiom', 'The word of the day is glasswing.', JSON.stringify(['global']));
    db.prepare('INSERT INTO devices (device_id, name, timezone, created_at) VALUES (?, ?, ?, ?)')
      .run('learning-e2e-device', 'Test', 'Asia/Almaty', '2026-09-01 00:00:00');

    // Raw learning history already on file for this device -- must never be
    // dumped wholesale into the prompt. Only the single deterministically
    // selected recall candidate's word_text may appear.
    insertLearnedWordDaysAgo('learning-e2e-device', 'unselected-1', 'UNSELECTED_HISTORY_WORD_ONE', 20); // ineligible (too old)
    insertLearnedWordDaysAgo('learning-e2e-device', 'unselected-2', 'UNSELECTED_HISTORY_WORD_TWO', 1); // ineligible (too young)

    let openAiCallCount = 0;
    let capturedRequest = null;
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'openai') {
        return class MockOpenAI {
          constructor() {
            this.chat = {
              completions: {
                create: async (requestBody) => {
                  openAiCallCount += 1;
                  capturedRequest = requestBody;
                  const payload = JSON.parse(requestBody.messages[1].content);
                  return {
                    choices: [{
                      message: {
                        content: JSON.stringify({
                          phrases: payload.slots.map((slot, index) => ({
                            slot_id: slot.slot_id,
                            text: `Concrete learning payload line ${index + 1}`,
                            style_id: STYLE_IDS[index],
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
    process.env.OPENAI_API_KEY = 'test-key-learning-memory';

    try {
      const result = await generateBatch(
        { device_id: 'learning-e2e-device', timezone: 'Asia/Almaty', created_at: '2026-09-01 00:00:00' },
        'day',
        { system_language: 'en' },
        null,
        {}
      );

      assert.strictEqual(openAiCallCount, 1, 'generating one batch must make exactly one OpenAI call');
      assert.strictEqual(result.source, 'openai');
      assert.strictEqual(result.phrases.length, BATCH_SIZE);

      const payload = JSON.parse(capturedRequest.messages[1].content);
      const payloadText = JSON.stringify(payload);
      assert(!payloadText.includes('learning_memory_id'), 'learning_memory_id must never reach the OpenAI payload');
      assert(!payloadText.includes('UNSELECTED_HISTORY_WORD_ONE'), 'ineligible/unselected learning history must not leak into the prompt');
      assert(!payloadText.includes('UNSELECTED_HISTORY_WORD_TWO'), 'ineligible/unselected learning history must not leak into the prompt');

      const wordLearningSlotSent = payload.slots.find((slot) => slot.type === 'word_learning');
      assert(wordLearningSlotSent, 'the idiom bank item must be offered to OpenAI as a word_learning slot');
      assert.strictEqual(wordLearningSlotSent.facts.word, 'The word of the day is glasswing.');

      const storedWord = db.prepare('SELECT word_text FROM device_learning_memory WHERE device_id = ? AND word_key != ? AND word_key != ?')
        .get('learning-e2e-device', 'unselected-1', 'unselected-2');
      assert(storedWord, 'a successfully generated word_learning slot must be recorded into Learning Memory');
      assert.strictEqual(storedWord.word_text, 'The word of the day is glasswing.');
    } finally {
      Module._load = originalLoad;
      delete process.env.OPENAI_API_KEY;
    }
  }
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
