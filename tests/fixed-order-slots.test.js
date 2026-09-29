// Fixed-order rebuild, step 1 (owner-approved 12-topic-per-window matrix).
// Covers:
//   1. With a rich enough input (real data for every Daily-Bank/profile/
//      weather-grounded type in the matrix), planSlots() for each of the
//      four windows returns EXACTLY FIXED_ORDER_BY_WINDOW[window], in that
//      exact order -- no scoring, no shuffling, no drops.
//   2. Every MODEL_ONLY_TYPES entry for a window is still present even with
//      a completely empty Daily Bank and a bare-minimum device (owner
//      requirement: "модельные слоты доступны всегда").
//   3. word_recall_same_batch (morning) carries the same word as the
//      word_learning slot in the same batch.
//   4. gender_tip/city_fact degrade to a usable candidate with no facts
//      when there's nothing to ground them in, rather than being skipped.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-fixed-order-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');

const db = require('../src/db');
const { BATCH_SIZE } = require('../src/constants');
const {
  planSlots,
  FIXED_ORDER_BY_WINDOW,
  MODEL_ONLY_TYPES,
  _test: plannerTest,
} = require('../src/slotPlanner');

function typesOf(slots) {
  return slots.map((slot) => slot.type);
}

const dateContext = {
  date: '2026-09-29',
  weekday: 'Tuesday',
  time: '08:00',
  tomorrow_date: '2026-09-30',
  tomorrow_weekday: 'Wednesday',
};

// One bank item per category the CONTENT_TYPES/mapBankItemType mapping
// understands (see slotPlanner.js), so every Daily-Bank-grounded type in
// every window's fixed order has a real candidate to pick.
const richBankItems = [
  { category: 'holiday', content_text: 'World Kindness Day', tags: ['global'] },
  { category: 'on_this_day', content_text: 'In 1969, the first ARPANET message was sent.', tags: ['global', 'history'] },
  { category: 'humor', content_text: 'Autocorrect is a comedian with no filter.', tags: ['global'] },
  { category: 'idiom', content_text: 'Break the ice', tags: ['global'] },
  { category: 'statistic', content_text: 'Honey never spoils.', tags: ['global'] },
  { category: 'quote', content_text: '"Be yourself." -- Oscar Wilde', tags: ['global'] },
  { category: 'science', content_text: 'Octopuses have three hearts.', tags: ['global'] },
  { category: 'technology', content_text: 'The first computer mouse was made of wood.', tags: ['global'] },
  { category: 'economics', content_text: 'Compound interest grows exponentially over time.', tags: ['global'] },
  { category: 'fact', content_text: 'Bananas are botanically berries.', tags: ['global'] },
  { category: 'country_fact', content_text: 'Kazakhstan is the largest landlocked country.', tags: ['global'] },
  { category: 'good_news', content_text: 'A rare species was rediscovered after 30 years.', tags: ['global'] },
];

function richDevice(deviceId) {
  return {
    device_id: deviceId,
    name: 'Aruzhan',
    birth_date: '1995-05-20',
    gender: 'female',
  };
}

function richInput(window, deviceId, extra = {}) {
  return {
    device: richDevice(deviceId),
    window,
    dateContext,
    weather: { temperatureC: 18, city: 'Almaty', description: 'clear', countryCode: 'KZ' },
    signals: { region: 'KZ' },
    bankItems: richBankItems,
    phoneTrends: { unlocks_vs_yesterday: 'higher', steps_vs_yesterday: 'lower' },
    recallCandidate: window === 'night'
      ? { id: 1, word_key: 'break-the-ice', word_text: 'Break the ice' }
      : null,
    ...extra,
  };
}

function testExactOrderWithRichData() {
  for (const window of Object.keys(FIXED_ORDER_BY_WINDOW)) {
    const input = richInput(window, `rich-${window}-device`);
    const planned = planSlots(input, { seed: `rich-${window}-seed` });
    assert.deepStrictEqual(
      typesOf(planned.slots),
      FIXED_ORDER_BY_WINDOW[window],
      `${window}: with full data every position must be filled in exactly the owner-specified order`
    );
    assert.strictEqual(planned.slots.length, BATCH_SIZE, `${window}: must be exactly ${BATCH_SIZE} slots with full data`);
    assert.strictEqual(
      new Set(planned.slots.map((s) => s.slot_id)).size,
      planned.slots.length,
      `${window}: slot_ids must be unique`
    );
  }
}

function testModelOnlySlotsSurviveEmptyBank() {
  for (const window of Object.keys(FIXED_ORDER_BY_WINDOW)) {
    const input = {
      device: { device_id: `bare-${window}-device` },
      window,
      dateContext,
      bankItems: [],
    };
    const planned = planSlots(input, { seed: `bare-${window}-seed` });
    const producedTypes = new Set(typesOf(planned.slots));
    for (const type of FIXED_ORDER_BY_WINDOW[window]) {
      if (MODEL_ONLY_TYPES.has(type)) {
        assert(
          producedTypes.has(type),
          `${window}: model-only type "${type}" must be present even with an empty Daily Bank and bare-minimum device`
        );
      }
    }
  }
}

function testWordRecallSameBatchUsesWordLearningWord() {
  const input = richInput('morning', 'word-recall-device');
  const planned = planSlots(input, { seed: 'word-recall-seed' });
  const wordLearningSlot = planned.slots.find((s) => s.type === 'word_learning');
  const recallSlot = planned.slots.find((s) => s.type === 'word_recall_same_batch');
  assert(wordLearningSlot, 'word_learning must be present with rich data');
  assert(recallSlot, 'word_recall_same_batch must be present with rich data');
  assert.strictEqual(
    recallSlot.facts.word,
    wordLearningSlot.facts.word,
    'word_recall_same_batch must carry the exact same word as word_learning in the same batch'
  );
}

function testWordRecallSameBatchDegradesGracefullyWithNoWord() {
  // No idiom bank item at all -> word_learning has no candidate -> the
  // recall slot must still appear (it's in MODEL_ONLY territory in
  // practice, even though it's not in the MODEL_ONLY_TYPES set), just
  // without a word to reference.
  const input = {
    device: richDevice('no-word-device'),
    window: 'morning',
    dateContext,
    weather: { temperatureC: 18, city: 'Almaty', description: 'clear' },
    bankItems: richBankItems.filter((item) => item.category !== 'idiom'),
  };
  const planned = planSlots(input, { seed: 'no-word-seed' });
  assert(!planned.slots.some((s) => s.type === 'word_learning'), 'word_learning must be absent with no idiom bank item');
  const recallSlot = planned.slots.find((s) => s.type === 'word_recall_same_batch');
  assert(recallSlot, 'word_recall_same_batch must still be present even when word_learning has no candidate');
  assert.deepStrictEqual(recallSlot.facts, {}, 'word_recall_same_batch must fall back to empty facts with no word to reference');
}

function testGenderTipAndCityFactDegradeGracefully() {
  const input = {
    device: { device_id: 'no-gender-no-city-device' },
    window: 'evening',
    dateContext,
    bankItems: [],
  };
  const planned = planSlots(input, { seed: 'no-gender-city-seed' });
  const genderSlot = planned.slots.find((s) => s.type === 'gender_tip');
  const citySlot = planned.slots.find((s) => s.type === 'city_fact');
  assert(genderSlot, 'gender_tip must be present even with no device.gender');
  assert.deepStrictEqual(genderSlot.facts, {}, 'gender_tip must have empty facts when gender is unknown');
  assert(citySlot, 'city_fact must be present even with no city/country data');
  assert.deepStrictEqual(citySlot.facts, {}, 'city_fact must have empty facts when neither city nor country is known');
}

function testGenderTipUsesProfileGenderWhenGiven() {
  const input = richInput('evening', 'gender-device');
  const planned = planSlots(input, { seed: 'gender-seed' });
  const genderSlot = planned.slots.find((s) => s.type === 'gender_tip');
  assert(genderSlot, 'gender_tip must be present with rich data');
  assert.strictEqual(genderSlot.facts.gender, 'female', 'gender_tip must carry the profile gender when known');
}

function main() {
  testExactOrderWithRichData();
  testModelOnlySlotsSurviveEmptyBank();
  testWordRecallSameBatchUsesWordLearningWord();
  testWordRecallSameBatchDegradesGracefullyWithNoWord();
  testGenderTipAndCityFactDegradeGracefully();
  testGenderTipUsesProfileGenderWhenGiven();
}

try {
  main();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('fixed-order-slots.test.js: all assertions passed');
} catch (err) {
  try {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best effort cleanup
  }
  console.error(err);
  process.exit(1);
}
