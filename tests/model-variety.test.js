// Variety comes from the model, not from server filters:
//   1. The "already seen" block (last 3 days of phrases, cut to 150, plus every learned
//      word) is in the batch prompt and in the repair prompt.
//   2. Evergreen topics are model-only slots: no facts from the Daily Bank, only a topic.
//   3. The Daily Bank collects only the 4 date/news-bound categories.
//   4. OpenAI token usage is logged for every call.
const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-variety-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const { STYLE_IDS } = require('../src/constants');
const { planSlots } = require('../src/slotPlanner');
const { generateBatch, _test: contentTest } = require('../src/contentGenerator');
const { BANK_CATEGORIES, _test: bankTest } = require('../src/dailyContentBank');
const { loadSeenBlock, SEEN_MAX_PHRASES, SEEN_INSTRUCTION } = require('../src/seenMemory');

const DEVICE = 'variety-device';
db.prepare('INSERT INTO devices (device_id, name, timezone, created_at) VALUES (?, ?, ?, ?)')
  .run(DEVICE, 'Aika', 'Asia/Almaty', '2026-09-01 00:00:00');

function insertBatch(phrases, deliveredModifier) {
  db.prepare(`
    INSERT INTO content_batches (device_id, window, local_date, phrases, source, delivered_at)
    VALUES (?, 'day', '2026-09-30', ?, 'openai', datetime('now', ?))
  `).run(DEVICE, JSON.stringify(phrases.map((text) => ({ text, style_id: 'A1' }))), deliveredModifier);
}

function withMockOpenAi(handler, run) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'openai') {
      return class MockOpenAI {
        constructor() {
          this.chat = { completions: { create: async (body) => handler(body) } };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.OPENAI_API_KEY = 'test-key-variety';
  const restore = () => {
    Module._load = originalLoad;
    delete process.env.OPENAI_API_KEY;
  };
  return Promise.resolve(run()).then((value) => { restore(); return value; }, (err) => { restore(); throw err; });
}

function okResponse(payload, overrides = {}, usage = null) {
  const response = {
    choices: [{
      message: {
        content: JSON.stringify({
          phrases: payload.slots.map((slot, index) => ({
            slot_id: slot.slot_id,
            text: overrides[slot.slot_id] || `Fresh line number ${index + 1}`,
            style_id: STYLE_IDS[index % STYLE_IDS.length],
          })),
        }),
      },
    }],
  };
  if (usage) response.usage = usage;
  return response;
}

function testSeenBlockIsCutTo150AndLimitedToThreeDays() {
  // 5 batches x 40 phrases; plus one batch older than 3 days.
  for (let batch = 0; batch < 5; batch += 1) {
    insertBatch(Array.from({ length: 40 }, (_, i) => `Seen phrase b${batch} n${i}`), '-1 hours');
  }
  insertBatch(['Old phrase from four days ago'], '-4 days');
  db.prepare("INSERT INTO device_learning_memory (device_id, word_key, word_text) VALUES (?, 'w1', 'tsundoku')").run(DEVICE);
  db.prepare("INSERT INTO device_learning_memory (device_id, word_key, word_text) VALUES (?, 'w2', 'petrichor')").run(DEVICE);

  const seen = loadSeenBlock(DEVICE);
  assert.strictEqual(SEEN_MAX_PHRASES, 150);
  assert.strictEqual(seen.phrases.length, 150, '200 seen phrases are cut to 150');
  assert.strictEqual(seen.phrases[0], 'Seen phrase b4 n0', 'newest batch first');
  assert(!seen.phrases.includes('Old phrase from four days ago'), 'phrases older than 3 days are not included');
  assert.strictEqual(seen.learned_words, 'petrichor; tsundoku', 'all learned words, on one line');
  assert.strictEqual(seen.instruction, SEEN_INSTRUCTION);
  assert(/Do not repeat these facts, jokes, ideas or words, even in different words/.test(seen.instruction));
  assert(/pick something new/.test(seen.instruction));
  assert.strictEqual(loadSeenBlock('nobody'), null, 'a new device has no block');
}

async function testSeenBlockReachesBatchAndRepairPrompts() {
  const requests = [];
  let call = 0;
  await withMockOpenAi((body) => {
    const payload = JSON.parse(body.messages[1].content);
    requests.push(payload);
    call += 1;
    if (call === 1) {
      // slot s1 comes back far too long -> goes to repair
      return okResponse(payload, { s1: 'x'.repeat(200) });
    }
    return okResponse(payload);
  }, async () => {
    await generateBatch(
      { device_id: DEVICE, name: 'Aika', timezone: 'Asia/Almaty', created_at: '2026-09-01 00:00:00' },
      'day',
      { system_language: 'en' },
      null,
      {}
    );
  });

  assert(requests.length >= 2, 'the too-long phrase must trigger a repair call');
  const batchPayload = requests[0];
  const repairPayload = requests[1];
  assert.strictEqual(batchPayload.already_seen.phrases.length, 150, 'batch prompt carries the block, cut to 150');
  assert.strictEqual(batchPayload.already_seen.learned_words, 'petrichor; tsundoku');
  assert.strictEqual(repairPayload.repair, 'rewrite_only_these_rejected_slots');
  assert.deepStrictEqual(repairPayload.already_seen, batchPayload.already_seen, 'repair gets the same block');

  // Example for the report.
  const example = {
    instruction: batchPayload.already_seen.instruction,
    phrases: batchPayload.already_seen.phrases.slice(0, 3).concat(['... (150 in total)']),
    learned_words: batchPayload.already_seen.learned_words,
  };
  console.log('[example already_seen block]\n' + JSON.stringify(example, null, 2));
}

function testEvergreenSlotsCarryNoBankFacts() {
  const bankItems = [
    { id: 1, category: 'good_news', content_text: 'A reef was restored.', tags: ['global'] },
    { id: 2, category: 'holiday', content_text: 'World Day of Examples.', tags: ['global'] },
    { id: 3, category: 'on_this_day', content_text: 'In 1901 something happened.', tags: ['global'] },
    { id: 4, category: 'born_today', content_text: 'A well-known person was born.', tags: ['global'] },
    // leftovers of the removed categories must never reach a slot
    { id: 5, category: 'science', content_text: 'LEFTOVER_SCIENCE', tags: ['global'] },
    { id: 6, category: 'humor', content_text: 'LEFTOVER_HUMOR', tags: ['global'] },
    { id: 7, category: 'idiom', content_text: 'LEFTOVER_IDIOM', tags: ['global'] },
    { id: 8, category: 'country_fact', content_text: 'LEFTOVER_COUNTRY', tags: ['KZ'] },
    { id: 9, category: 'quote', content_text: 'LEFTOVER_QUOTE', tags: ['global'] },
  ];
  const evergreen = ['smart_humor_observation', 'science_fact', 'technology_fact', 'country_fact',
    'money_economics', 'unusual_fact', 'culture', 'word_learning'];
  const seenTypes = new Set();
  for (const window of ['morning', 'day', 'evening', 'night']) {
    const { slots } = planSlots({
      device: { device_id: 'evergreen-device', name: 'Aika', birth_date: '1995-04-12', timezone: 'Asia/Almaty' },
      window,
      dateContext: { date: '2026-09-30', weekday: 'Wednesday', time: '12:00' },
      weather: { countryCode: 'KZ', city: 'Astana', temperatureC: 10, description: 'clear' },
      bankItems,
      phoneTrends: {},
      signals: {},
    }, { seed: `evergreen-${window}` });
    for (const slot of slots) {
      assert(!/LEFTOVER_/.test(JSON.stringify(slot)), `leftover bank text must not reach a ${window} slot`);
      if (evergreen.includes(slot.type)) {
        seenTypes.add(slot.type);
        assert.strictEqual(slot.source, 'model_only', `${slot.type} must not be grounded in the bank`);
        assert.deepStrictEqual(slot.facts, {}, `${slot.type} must carry no facts`);
        assert(slot.topic, `${slot.type} must carry a topic description`);
        assert(!slot.bank_category, `${slot.type} must have no bank category`);
      }
    }
  }
  for (const type of evergreen) {
    assert(seenTypes.has(type), `${type} is expected to be planned in at least one window`);
  }

  // The date/news-bound types still come from the bank.
  const evening = planSlots({
    device: { device_id: 'evergreen-device' },
    window: 'evening',
    dateContext: { date: '2026-09-30', weekday: 'Wednesday', time: '19:00' },
    weather: null,
    bankItems,
    phoneTrends: {},
    signals: {},
  }, { seed: 'bank-types' }).slots;
  assert.strictEqual(evening.find((s) => s.type === 'good_news').facts.text, 'A reef was restored.');
  assert.strictEqual(evening.find((s) => s.type === 'born_today').facts.text, 'A well-known person was born.');
}

function testBankCollectsOnlyFourCategories() {
  assert.deepStrictEqual([...BANK_CATEGORIES].sort(), ['born_today', 'good_news', 'holiday', 'on_this_day']);
  const prompt = bankTest.buildBankPrompt('2026-09-30');
  assert(prompt.includes('one of [holiday, on_this_day, born_today, good_news]'), 'the prompt lists exactly the 4 categories');
  for (const removed of ['humor', 'science', 'technology', 'statistic', 'economics', 'quote', 'idiom', 'country_fact']) {
    assert(!prompt.includes(removed), `${removed} must not be requested in the bank prompt`);
  }
  const parsed = bankTest.parseBankItems(JSON.stringify([
    { category: 'science', content_text: 'A science fact.', tags: ['global'] },
    { category: 'good_news', content_text: 'A good thing happened.', tags: ['global'] },
  ]), '2026-09-30', ['2026-09-30']);
  assert.deepStrictEqual(parsed.map((item) => item.category), ['good_news'], 'other categories are dropped on parse');
}

async function testUsageIsLogged() {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await withMockOpenAi(
      (body) => okResponse(JSON.parse(body.messages[1].content), {}, {
        prompt_tokens: 4321, completion_tokens: 654, total_tokens: 4975, prompt_tokens_details: { cached_tokens: 1024 },
      }),
      () => generateBatch(
        { device_id: DEVICE, name: 'Aika', timezone: 'Asia/Almaty', created_at: '2026-09-01 00:00:00' },
        'evening', { system_language: 'en' }, null, {}
      )
    );
  } finally {
    console.log = originalLog;
  }
  const usage = lines.find((line) => line.startsWith('OPENAI_USAGE'));
  assert(usage, 'an OPENAI_USAGE line must be logged for the batch call');
  assert(/scope=lock_screen_batch/.test(usage) && /prompt_tokens=4321/.test(usage)
    && /completion_tokens=654/.test(usage) && /total_tokens=4975/.test(usage) && /cached_tokens=1024/.test(usage), usage);

  // a response without usage (older mocks) must not break anything
  contentTest.logOpenAiUsage('x', {});
  contentTest.logOpenAiUsage('x', null);
}

async function main() {
  testSeenBlockIsCutTo150AndLimitedToThreeDays();
  await testSeenBlockReachesBatchAndRepairPrompts();
  testEvergreenSlotsCarryNoBankFacts();
  testBankCollectsOnlyFourCategories();
  await testUsageIsLogged();
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('model-variety.test.js: all assertions passed');
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
