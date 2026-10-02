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

const TODAY = '2026-10-01';

// localDate = the device's local date of the morning batch that taught the word
// (null = a row from before that column existed).
function insertLearnedWord(deviceId, wordKey, wordText, localDate) {
  db.prepare('INSERT OR IGNORE INTO devices (device_id) VALUES (?)').run(deviceId);
  db.prepare(`
    INSERT INTO device_learning_memory (device_id, word_key, word_text, learned_local_date)
    VALUES (?, ?, ?, ?)
  `).run(deviceId, wordKey, wordText, localDate);
  return db.prepare('SELECT id FROM device_learning_memory WHERE device_id = ? AND word_key = ?')
    .get(deviceId, wordKey).id;
}

// The date generateBatch will recall for, computed the same way from the real clock:
// before 05:00 local the night still belongs to the previous day.
function expectedRecallDate(timeZone) {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date());
  return time < '05:00' ? '2026-09-30' : TODAY;
}

function wordLearningSlot(slotId, word, contentKey = slotId) {
  return { slot_id: slotId, type: 'word_learning', facts: { word }, content_key: contentKey, id: contentKey };
}

function learningRecallSlot(slotId, memoryId, word = 'irrelevant') {
  return { slot_id: slotId, type: 'learning_recall', facts: { word }, learning_memory_id: memoryId };
}

async function main() {
  // --- per-device isolation ---
  insertLearnedWord('device-a', 'word-a', 'device A word', TODAY);
  assert(getRecallCandidate('device-a', TODAY), 'device-a must see its own word of today');
  assert.strictEqual(getRecallCandidate('device-b', TODAY), null, 'device-b must not see device-a learning memory');

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

  // --- night recalls today's morning word ---
  {
    insertLearnedWord('device-today', 'sinkretizm', 'Синкретизм — слияние разных начал', TODAY);
    const candidate = getRecallCandidate('device-today', TODAY);
    assert(candidate, "today's morning word must be recalled");
    assert.strictEqual(candidate.word_text, 'Синкретизм — слияние разных начал');
    assert.strictEqual(getRecallCandidate('device-today', TODAY).id, candidate.id, 'stable, no randomness');
  }

  // --- an old word is never recalled, however old, and even when it is the only one ---
  {
    insertLearnedWord('device-old', 'break-the-ice', '"Break the ice" - to initiate conversation', '2026-09-20');
    insertLearnedWord('device-old', 'legacy-null-date', 'legacy row without a date', null);
    assert.strictEqual(getRecallCandidate('device-old', TODAY), null, 'an old word must never be recalled');
    assert.strictEqual(getRecallCandidate('device-old', '2026-09-30'), null, 'yesterday must not match either');

    // Today's word wins over older ones that were sitting in the queue first.
    insertLearnedWord('device-old', 'fresh', 'fresh word of today', TODAY);
    const candidate = getRecallCandidate('device-old', TODAY);
    assert.strictEqual(candidate.word_key, 'fresh', 'only the word of the asked date may be chosen');
  }

  // --- no morning word today: no candidate (the slot is dropped) ---
  assert.strictEqual(getRecallCandidate('device-empty', TODAY), null, 'a device with no learning memory must have no recall candidate');
  assert.strictEqual(getRecallCandidate('device-a', null), null, 'no date -> no candidate');
  assert.strictEqual(getRecallCandidate('device-a', undefined), null, 'no date -> no candidate');

  // --- recordLearnedWords stores the device-local date ---
  {
    db.prepare('INSERT OR IGNORE INTO devices (device_id) VALUES (?)').run('device-dated');
    recordLearnedWords('device-dated', [wordLearningSlot('w1', 'dated word')], ['w1'], [], TODAY);
    assert.strictEqual(getRecallCandidate('device-dated', TODAY).word_text, 'dated word');
    recordLearnedWords('device-dated', [wordLearningSlot('w2', 'undated word')], ['w2']);
    assert.strictEqual(getRecallCandidate('device-dated', '2026-09-30'), null, 'a row without a date is never a candidate');
  }

  // --- successful recall becomes ineligible; failed/fallback recall does not mark recalled ---
  {
    const memoryId = insertLearnedWord('device-recall-success', 'recall-me', 'recall me', TODAY);
    assert(getRecallCandidate('device-recall-success', TODAY), 'word must be eligible before recall');

    // Planning/selecting alone must never mark it recalled.
    assert.strictEqual(
      recordRecalledWords('device-recall-success', [learningRecallSlot('s1', memoryId)], []),
      0,
      'a candidate that was only planned (not generated) must not be marked recalled'
    );
    assert(getRecallCandidate('device-recall-success', TODAY), 'word must still be eligible after a non-generated recall slot');

    // Fallback (present but not in generatedSlotIds) must not mark it recalled either.
    assert.strictEqual(
      recordRecalledWords('device-recall-success', [learningRecallSlot('s1', memoryId)], ['some-other-slot']),
      0,
      'a fallback-filled recall slot must not mark the word recalled'
    );
    assert(getRecallCandidate('device-recall-success', TODAY), 'word must still be eligible after a fallback recall slot');

    // A genuinely generated+validated recall slot marks it recalled.
    const marked = recordRecalledWords('device-recall-success', [learningRecallSlot('s1', memoryId)], ['s1']);
    assert.strictEqual(marked, 1, 'a generated, validated recall slot must mark the word recalled');
    assert.strictEqual(getRecallCandidate('device-recall-success', TODAY), null, 'a successfully recalled word must become ineligible for further recall');

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
      ...['science', 'technology', 'culture', 'good_news', 'money_economics', 'country_fact'].flatMap((type, i) => ([
        plannerTest.createCandidate({ id: `filler_${type}_a`, type, priority: 10, facts: { text: `filler ${type} a ${i}` } }),
        plannerTest.createCandidate({ id: `filler_${type}_b`, type, priority: 10, facts: { text: `filler ${type} b ${i}` } }),
      ])),
    ];
    // learning_recall is now a night-only candidate (window-aware fixed
    // slots: night's second-to-last position) -- see slotPlanner.js
    // isCandidateAllowedInWindow -- so this must plan for 'night', not 'day'.
    const { slots } = planSlots({ device: { device_id: 'learning-slot-device' }, window: 'night' }, { seed: 'learning-recall-seed', candidates });
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

  // --- evergreen bank categories (idiom, quote, ...) no longer become slots ---
  {
    for (const category of ['idiom', 'quote', 'humor', 'science', 'fact']) {
      assert.strictEqual(
        plannerTest.bankItemToCandidate({ id: 501, category, content_text: 'Some evergreen text.', tags: ['global'] }),
        null,
        `${category} bank items must not become candidates any more`
      );
    }
  }

  // --- REAL end-to-end recall path: device_learning_memory -> getRecallCandidate
  // -> generateBatch (real SlotPlanner selection, no manually constructed
  // recall slot) -> OpenAI receives the recall slot with only grounded
  // facts.word -> recordRecalledWords -> the exact row gets recalled_at ->
  // no longer returned by getRecallCandidate. Must run before the next block
  // inserts any daily_content_bank rows. Content-quality rebuild
  // (requirement B): the planner no longer pads to exactly BATCH_SIZE, so
  // this only asserts the recall slot itself is genuinely selected, not a
  // specific total slot count.
  {
    const deviceId = 'learning-recall-e2e-device';
    const targetWord = 'EXACT_TARGET_RECALL_WORD';
    const recallDate = expectedRecallDate('Asia/Almaty');
    db.prepare('INSERT INTO devices (device_id, name, timezone, created_at) VALUES (?, ?, ?, ?)')
      .run(deviceId, 'Test', 'Asia/Almaty', '2026-09-01 00:00:00');
    const targetMemoryId = insertLearnedWord(deviceId, 'e2e-target', targetWord, recallDate);
    // Older words (a legacy idiom with no date, and one from an earlier day) must stay out of the recall.
    insertLearnedWord(deviceId, 'e2e-too-old', 'UNRELATED_TOO_OLD_WORD', '2026-09-10');
    insertLearnedWord(deviceId, 'e2e-legacy', 'UNRELATED_LEGACY_IDIOM', null);

    assert(getRecallCandidate(deviceId, recallDate), 'target word must be eligible before generateBatch runs');

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
      // learning_recall only competes at night now -- see isCandidateAllowedInWindow.
      const result = await generateBatch(
        { device_id: deviceId, timezone: 'Asia/Almaty', created_at: '2026-09-01 00:00:00' },
        'night',
        { system_language: 'en' },
        null,
        {},
        { localDate: TODAY }
      );

      assert.strictEqual(openAiCallCount, 1, 'generating one batch must make exactly one OpenAI call');
      assert.strictEqual(result.source, 'openai');
      // Content-quality rebuild (requirement B): no more padding to exactly
      // BATCH_SIZE -- just bounded by it.
      assert(result.phrases.length > 0 && result.phrases.length <= BATCH_SIZE);

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
      // Learned words now DO reach the prompt, but only in the "already seen" block
      // (so the model does not repeat them), never as a recall slot's facts.
      const slotsText = JSON.stringify(payload.slots);
      assert(!slotsText.includes('UNRELATED_TOO_OLD_WORD'), 'ineligible learning history must not become a slot fact');
      assert(!slotsText.includes('UNRELATED_LEGACY_IDIOM'), 'ineligible learning history must not become a slot fact');
      assert(payload.already_seen.learned_words.includes('UNRELATED_TOO_OLD_WORD'), 'learned words go into already_seen');

      const updatedRow = db.prepare('SELECT recalled_at FROM device_learning_memory WHERE id = ?').get(targetMemoryId);
      assert(updatedRow.recalled_at, 'the exact recalled memory row must have recalled_at set after a real generateBatch call');

      assert.strictEqual(getRecallCandidate(deviceId, recallDate), null, 'the just-recalled word must no longer be returned by getRecallCandidate');

      const untouchedOld = db.prepare('SELECT recalled_at FROM device_learning_memory WHERE device_id = ? AND word_key = ?').get(deviceId, 'e2e-too-old');
      const untouchedLegacy = db.prepare('SELECT recalled_at FROM device_learning_memory WHERE device_id = ? AND word_key = ?').get(deviceId, 'e2e-legacy');
      assert.strictEqual(untouchedOld.recalled_at, null, 'unrelated ineligible history must remain untouched');
      assert.strictEqual(untouchedLegacy.recalled_at, null, 'unrelated ineligible history must remain untouched');
    } finally {
      Module._load = originalLoad;
      delete process.env.OPENAI_API_KEY;
    }
  }

  // --- end-to-end: model-picked word_learning (no bank word) -> generated -> Learning Memory; single OpenAI call; no raw history leak ---
  {
    db.prepare('INSERT INTO devices (device_id, name, timezone, created_at) VALUES (?, ?, ?, ?)')
      .run('learning-e2e-device', 'Test', 'Asia/Almaty', '2026-09-01 00:00:00');

    // Raw learning history already on file for this device -- must never be
    // dumped wholesale into the prompt. Only the single deterministically
    // selected recall candidate's word_text may appear.
    insertLearnedWord('learning-e2e-device', 'unselected-1', 'UNSELECTED_HISTORY_WORD_ONE', '2026-09-10'); // an earlier day
    insertLearnedWord('learning-e2e-device', 'unselected-2', 'UNSELECTED_HISTORY_WORD_TWO', null); // legacy row, no date

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
      // word_learning only competes at morning now -- see isCandidateAllowedInWindow.
      const result = await generateBatch(
        { device_id: 'learning-e2e-device', timezone: 'Asia/Almaty', created_at: '2026-09-01 00:00:00' },
        'morning',
        { system_language: 'en' },
        null,
        {}
      );

      assert.strictEqual(openAiCallCount, 1, 'generating one batch must make exactly one OpenAI call');
      assert.strictEqual(result.source, 'openai');
      // Content-quality rebuild (requirement B): no more padding to exactly
      // BATCH_SIZE -- just bounded by it.
      assert(result.phrases.length > 0 && result.phrases.length <= BATCH_SIZE);

      const payload = JSON.parse(capturedRequest.messages[1].content);
      const payloadText = JSON.stringify(payload);
      assert(!payloadText.includes('learning_memory_id'), 'learning_memory_id must never reach the OpenAI payload');
      const slotsText = JSON.stringify(payload.slots);
      assert(!slotsText.includes('UNSELECTED_HISTORY_WORD_ONE'), 'ineligible/unselected learning history must not become a slot fact');
      assert(!slotsText.includes('UNSELECTED_HISTORY_WORD_TWO'), 'ineligible/unselected learning history must not become a slot fact');

      const wordLearningSlotSent = payload.slots.find((slot) => slot.type === 'word_learning');
      assert(wordLearningSlotSent, 'a word_learning slot must be offered to OpenAI');
      assert.strictEqual(wordLearningSlotSent.facts.word, undefined, 'the server no longer supplies the word: the model picks it');
      assert(wordLearningSlotSent.topic.includes('Pick a rare but real word'), 'the slot carries only the topic description');
      const wordLine = payload.slots.indexOf(wordLearningSlotSent) + 1;

      const storedWord = db.prepare('SELECT word_text FROM device_learning_memory WHERE device_id = ? AND word_key != ? AND word_key != ?')
        .get('learning-e2e-device', 'unselected-1', 'unselected-2');
      assert(storedWord, 'a successfully generated word_learning slot must be recorded into Learning Memory');
      assert.strictEqual(storedWord.word_text, `Concrete learning payload line ${wordLine}`, 'the generated phrase is what gets remembered as the learned word');
    } finally {
      Module._load = originalLoad;
      delete process.env.OPENAI_API_KEY;
    }
  }

  // --- morning word -> night recall, through the real generateBatch ---
  // The mock model answers every slot with a distinct line, so what the night
  // recall slot carries can be compared with what the morning batch produced.
  {
    const timeZone = 'Asia/Almaty';
    const dayDate = expectedRecallDate(timeZone);
    const originalLoad = Module._load;
    let lastPayload = null;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'openai') {
        return class MockOpenAI {
          constructor() {
            this.chat = {
              completions: {
                create: async (requestBody) => {
                  const payload = JSON.parse(requestBody.messages[1].content);
                  // Only the batch request itself; a later repair request must not overwrite it.
                  if (!lastPayload) lastPayload = payload;
                  return {
                    choices: [{
                      message: {
                        content: JSON.stringify({
                          phrases: payload.slots.map((slot, index) => ({
                            slot_id: slot.slot_id,
                            text: slot.type === 'word_learning' ? 'SINKRETIZM_WORD_OF_THE_DAY' : `${slot.type} line ${index + 1}`,
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
    process.env.OPENAI_API_KEY = 'test-key-morning-night';

    const newDevice = (id) => {
      db.prepare('INSERT INTO devices (device_id, name, timezone, created_at) VALUES (?, ?, ?, ?)')
        .run(id, 'Test', timeZone, '2026-09-01 00:00:00');
      return { device_id: id, timezone: timeZone, created_at: '2026-09-01 00:00:00' };
    };
    // generateBatch's date comes from options.localDate when given; null lets it use the real clock,
    // which is what expectedRecallDate() mirrors.
    const run = (device, window) => { lastPayload = null; return generateBatch(device, window, { system_language: 'en' }, null, {}, { localDate: TODAY }); };

    try {
      // 1. Morning batch teaches a word; the night batch of the same day recalls exactly that word,
      //    even though a much older idiom is sitting in the same device's memory.
      {
        const device = newDevice('morning-night-device');
        insertLearnedWord(device.device_id, 'old-idiom', '"Break the ice" - to initiate conversation', '2026-09-01');
        await run(device, 'morning');
        const taught = db.prepare('SELECT word_text, learned_local_date FROM device_learning_memory WHERE device_id = ? AND word_key != ?')
          .get(device.device_id, 'old-idiom');
        assert.strictEqual(taught.word_text, 'SINKRETIZM_WORD_OF_THE_DAY', 'the morning word_learning phrase is what gets remembered');
        assert.strictEqual(taught.learned_local_date, TODAY, "the row carries the device's local date");

        // Between 00:00 and 05:00 local time the night counts as the previous day (see recallDate in
        // generateBatch), so move the morning row to the date the night will ask for.
        db.prepare('UPDATE device_learning_memory SET learned_local_date = ? WHERE device_id = ? AND word_key != ?')
          .run(dayDate, device.device_id, 'old-idiom');
        await run(device, 'night');
        const recallSlot = lastPayload.slots.find((slot) => slot.type === 'learning_recall');
        assert(recallSlot, 'night must carry a learning_recall slot after a morning word');
        assert.strictEqual(recallSlot.facts.word, 'SINKRETIZM_WORD_OF_THE_DAY', "night recalls today's morning word");
        assert(!JSON.stringify(lastPayload.slots).includes('Break the ice'), 'the old idiom is never a slot fact');

        // already_seen holds the real word of the day and the old row, nothing made up.
        const learned = lastPayload.already_seen.learned_words.split('; ');
        assert(learned.includes('SINKRETIZM_WORD_OF_THE_DAY'), 'the word of the day is in already_seen');
        assert(learned.every((w) => w === '"Break the ice" - to initiate conversation' || w === 'SINKRETIZM_WORD_OF_THE_DAY'),
          'already_seen.learned_words holds only recorded words, no slot texts of other types');
      }

      // 2. Only an old word, no morning word today: the recall slot is dropped.
      {
        const device = newDevice('night-no-morning-device');
        insertLearnedWord(device.device_id, 'old-idiom', '"Break the ice" - to initiate conversation', '2026-09-28');
        insertLearnedWord(device.device_id, 'legacy', 'legacy row without a date', null);
        await run(device, 'night');
        assert(!lastPayload.slots.some((slot) => slot.type === 'learning_recall'), 'no morning word today -> no learning_recall slot');
        assert(!JSON.stringify(lastPayload.slots).includes('Break the ice'), 'the old idiom is never taken instead');
      }
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
