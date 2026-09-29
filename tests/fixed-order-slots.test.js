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
//   5. (step 3) culture/science_fact/technology_fact/country_fact/
//      money_economics/unusual_fact/smart_humor_observation/
//      everyday_lifehack/warm_wish/poetic_thought/word_learning also fall
//      back to a model-only candidate (not skipped) when today's Daily Bank
//      has no matching item.
//   6. (step 3) phone_trend's topic differs between evening and night.
//   7. (step 3) with a completely empty Daily Bank AND an empty profile,
//      every window still produces EXACTLY 12 slots -- every position that
//      used to be silently dropped now gets spare_fact instead, and every
//      substitution is logged as SLOT_SPARE.
//   8. (step 3) greeting_name/goodnight_care get an explicit no-name topic
//      when device.name is absent.
//   9. (step 3) born_today is Daily-Bank-grounded (not model-only) and
//      falls back to spare_fact, like the other newly-covered types, when
//      the bank has none.
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
const {
  MODEL_ONLY_FALLBACK_TYPES,
  WORD_LEARNING_MODEL_ONLY_TOPIC,
  SPARE_FACT_FALLBACK_TYPES,
  NAME_ABSENT_TOPIC_BY_TYPE,
} = plannerTest;

function withCapturedWarnings(fn) {
  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args.join(' '));
  try {
    const result = fn();
    return { result, warnCalls };
  } finally {
    console.warn = originalWarn;
  }
}

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
  { category: 'born_today', content_text: 'Marie Curie was born on this day.', tags: ['global'] },
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

// everyday_lifehack/smart_humor_observation/warm_wish/poetic_thought are
// members of MODEL_ONLY_FALLBACK_TYPES but already have a pre-existing,
// unrelated non-bank fallback (SYNTHETIC_POOL, source='creative') that
// selectBestCandidateForType finds even with an empty bank -- so the NEW
// model-only fallback this test otherwise checks for never actually fires
// for them (their candidate is never null to begin with). Checked
// separately below (presence only, not source).
const SYNTHETIC_POOL_BACKED_TYPES = new Set(['everyday_lifehack', 'smart_humor_observation', 'warm_wish', 'poetic_thought']);

// Fixed-order rebuild, step 3: culture/science_fact/technology_fact/
// country_fact/money_economics/unusual_fact/word_learning now fall back to
// a genuinely NEW model-only candidate instead of being skipped, when
// today's Daily Bank has no matching item (owner requirement, this step).
// Covers every window whose fixed order actually contains one of these
// types.
function testModelOnlyFallbackTypesSurviveEmptyBank() {
  for (const window of Object.keys(FIXED_ORDER_BY_WINDOW)) {
    const input = {
      device: { device_id: `bare-fallback-${window}-device` },
      window,
      dateContext,
      bankItems: [],
    };
    const planned = planSlots(input, { seed: `bare-fallback-${window}-seed` });
    const slotByType = new Map(planned.slots.map((s) => [s.type, s]));
    for (const type of FIXED_ORDER_BY_WINDOW[window]) {
      if (!MODEL_ONLY_FALLBACK_TYPES.has(type)) {
        continue;
      }
      const slot = slotByType.get(type);
      assert(
        slot,
        `${window}: "${type}" must be present (as a model-only fallback) even with an empty Daily Bank`
      );
      if (SYNTHETIC_POOL_BACKED_TYPES.has(type)) {
        continue;
      }
      assert.strictEqual(slot.source, 'model_only', `${window}: "${type}" fallback slot must be source=model_only`);
      assert.deepStrictEqual(slot.facts, {}, `${window}: "${type}" fallback slot must have empty facts (the model invents the content)`);
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
  // No idiom bank item at all -> word_learning falls back to a model-only
  // candidate (step 3: word_learning is in MODEL_ONLY_FALLBACK_TYPES) with
  // its own topic override -- the model picks the word itself, so
  // word_recall_same_batch has no real word.word to reference and must
  // fall back to empty facts too, but BOTH slots must still be present.
  const input = {
    device: richDevice('no-word-device'),
    window: 'morning',
    dateContext,
    weather: { temperatureC: 18, city: 'Almaty', description: 'clear' },
    bankItems: richBankItems.filter((item) => item.category !== 'idiom'),
  };
  const planned = planSlots(input, { seed: 'no-word-seed' });
  const wordLearningSlot = planned.slots.find((s) => s.type === 'word_learning');
  assert(wordLearningSlot, 'word_learning must still be present (model-only fallback) with no idiom bank item');
  assert.strictEqual(wordLearningSlot.source, 'model_only', 'word_learning fallback slot must be source=model_only');
  assert.deepStrictEqual(wordLearningSlot.facts, {}, 'word_learning fallback slot must have empty facts');
  assert.strictEqual(
    wordLearningSlot.topic,
    WORD_LEARNING_MODEL_ONLY_TOPIC,
    'word_learning fallback slot must carry the model-only-specific topic override, not the default (none)'
  );
  const recallSlot = planned.slots.find((s) => s.type === 'word_recall_same_batch');
  assert(recallSlot, 'word_recall_same_batch must still be present even when word_learning has no real word');
  assert.deepStrictEqual(recallSlot.facts, {}, 'word_recall_same_batch must fall back to empty facts with no word to reference');
}

// Fixed-order rebuild, step 3: phone_trend's topic must differ between
// evening and night (both windows include it) -- see
// TOPIC_HINT_BY_WINDOW_TYPE in slotPlanner.js.
function testPhoneTrendTopicDiffersByWindow() {
  const eveningPlanned = planSlots(richInput('evening', 'phone-trend-evening-device'), { seed: 'phone-trend-evening-seed' });
  const nightPlanned = planSlots(richInput('night', 'phone-trend-night-device'), { seed: 'phone-trend-night-seed' });
  const eveningSlot = eveningPlanned.slots.find((s) => s.type === 'phone_trend');
  const nightSlot = nightPlanned.slots.find((s) => s.type === 'phone_trend');
  assert(eveningSlot, 'phone_trend must be present in evening with rich data');
  assert(nightSlot, 'phone_trend must be present in night with rich data');
  assert(eveningSlot.topic, 'phone_trend must carry a topic in evening');
  assert(nightSlot.topic, 'phone_trend must carry a topic in night');
  assert.notStrictEqual(eveningSlot.topic, nightSlot.topic, 'phone_trend topic must differ between evening and night');
  assert(/first half of the day/.test(eveningSlot.topic), 'evening phone_trend topic must match the owner-specified wording');
  assert(/gentle, non-preachy suggestion/.test(nightSlot.topic), 'night phone_trend topic must match the owner-specified wording');
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

function testCultureHasTopic() {
  const planned = planSlots(richInput('morning', 'culture-topic-device'), { seed: 'culture-topic-seed' });
  const cultureSlot = planned.slots.find((s) => s.type === 'culture');
  assert(cultureSlot, 'culture must be present with rich data');
  assert.strictEqual(cultureSlot.topic, 'A short real quote with its author.', 'culture must carry its topic hint');
}

// Owner requirement, step 3: "всегда 12 фраз" -- with a completely empty
// Daily Bank AND a bare-minimum (nameless, genderless, no birth_date)
// device, EVERY window must still produce exactly BATCH_SIZE slots. Every
// FIXED_ORDER_BY_WINDOW type is now covered by one of: MODEL_ONLY_TYPES,
// MODEL_ONLY_FALLBACK_TYPES, SPARE_FACT_FALLBACK_TYPES, or one of the
// always-present special builders (greeting_name/goodnight_care/gender_tip/
// city_fact/word_recall_same_batch).
function testAlways12SlotsWithEmptyBankAndProfile() {
  for (const window of Object.keys(FIXED_ORDER_BY_WINDOW)) {
    const input = {
      device: { device_id: `always-12-${window}-device` },
      window,
      dateContext,
      bankItems: [],
    };
    const planned = planSlots(input, { seed: `always-12-${window}-seed` });
    assert.strictEqual(
      planned.slots.length,
      BATCH_SIZE,
      `${window}: must be exactly ${BATCH_SIZE} slots with an empty Daily Bank and an empty profile, got ${planned.slots.length} (${JSON.stringify(typesOf(planned.slots))})`
    );
    // Position count/order is preserved -- each position is either its own
    // declared type (real or model-only data found) or spare_fact (that
    // type's fallback fired), never dropped, never a different type.
    const actualTypes = typesOf(planned.slots);
    FIXED_ORDER_BY_WINDOW[window].forEach((expectedType, index) => {
      const actualType = actualTypes[index];
      const isExpectedOrSpare = actualType === expectedType || (actualType === 'spare_fact' && SPARE_FACT_FALLBACK_TYPES.has(expectedType));
      assert(
        isExpectedOrSpare,
        `${window} position ${index + 1}: expected "${expectedType}" or its spare_fact substitute, got "${actualType}"`
      );
    });
  }
}

// Every SPARE_FACT_FALLBACK_TYPES substitution must log one SLOT_SPARE line
// naming the window and the ORIGINAL type that got replaced.
function testSpareFactSubstitutionsAreLogged() {
  for (const window of Object.keys(FIXED_ORDER_BY_WINDOW)) {
    const spareEligibleTypesForWindow = FIXED_ORDER_BY_WINDOW[window].filter((type) => SPARE_FACT_FALLBACK_TYPES.has(type));
    if (spareEligibleTypesForWindow.length === 0) {
      continue;
    }
    const input = {
      device: { device_id: `spare-log-${window}-device` },
      window,
      dateContext,
      bankItems: [],
    };
    const { result: planned, warnCalls } = withCapturedWarnings(() => planSlots(input, { seed: `spare-log-${window}-seed` }));
    for (const originalType of spareEligibleTypesForWindow) {
      assert(
        warnCalls.some((line) => line === `SLOT_SPARE window=${window} replaced_type=${originalType}`),
        `${window}: must log "SLOT_SPARE window=${window} replaced_type=${originalType}" when it has no candidate, got: ${JSON.stringify(warnCalls)}`
      );
      const slot = planned.slots.find((s) => s.id === `model_only_spare_fact_${originalType}`);
      assert(slot, `${window}: a spare_fact slot substituting "${originalType}" must be present`);
      assert.strictEqual(slot.type, 'spare_fact', `${window}: the substituted slot's type must be spare_fact, not "${originalType}"`);
    }
  }
}

function testGreetingAndGoodnightGetNoNameTopicWhenNameIsAbsent() {
  const morningPlanned = planSlots({
    device: { device_id: 'no-name-morning-device' },
    window: 'morning',
    dateContext,
    bankItems: [],
  }, { seed: 'no-name-morning-seed' });
  const greetingSlot = morningPlanned.slots.find((s) => s.type === 'greeting_name');
  assert(greetingSlot, 'greeting_name must be present even with no device.name');
  assert.strictEqual(greetingSlot.topic, NAME_ABSENT_TOPIC_BY_TYPE.greeting_name, 'greeting_name must carry the no-name topic when device.name is absent');

  const nightPlanned = planSlots({
    device: { device_id: 'no-name-night-device' },
    window: 'night',
    dateContext,
    bankItems: [],
  }, { seed: 'no-name-night-seed' });
  const goodnightSlot = nightPlanned.slots.find((s) => s.type === 'goodnight_care');
  assert(goodnightSlot, 'goodnight_care must be present even with no device.name');
  assert.strictEqual(goodnightSlot.topic, NAME_ABSENT_TOPIC_BY_TYPE.goodnight_care, 'goodnight_care must carry the no-name topic when device.name is absent');
}

function testGreetingAndGoodnightKeepDefaultTopicWhenNameIsKnown() {
  const morningPlanned = planSlots(richInput('morning', 'with-name-morning-device'), { seed: 'with-name-morning-seed' });
  const greetingSlot = morningPlanned.slots.find((s) => s.type === 'greeting_name');
  assert(greetingSlot, 'greeting_name must be present with rich data');
  assert.notStrictEqual(greetingSlot.topic, NAME_ABSENT_TOPIC_BY_TYPE.greeting_name, 'greeting_name must NOT use the no-name topic when the name is known');

  const nightPlanned = planSlots(richInput('night', 'with-name-night-device'), { seed: 'with-name-night-seed' });
  const goodnightSlot = nightPlanned.slots.find((s) => s.type === 'goodnight_care');
  assert(goodnightSlot, 'goodnight_care must be present with rich data');
  assert.strictEqual(
    goodnightSlot.topic,
    plannerTest.TOPIC_HINT_BY_TYPE.goodnight_care,
    'goodnight_care must keep its normal (name-known) topic when the name is known'
  );
}

function testBornTodayComesFromBankAndFallsBackToSpareFact() {
  const withBank = planSlots(richInput('evening', 'born-today-bank-device'), { seed: 'born-today-bank-seed' });
  const bornTodaySlot = withBank.slots.find((s) => s.type === 'born_today');
  assert(bornTodaySlot, 'born_today must be present with a matching Daily Bank item');
  assert.strictEqual(bornTodaySlot.source, 'daily_bank', 'born_today must come from the Daily Bank, not be model-only, when a bank item exists');

  const withoutBank = planSlots({
    device: richDevice('born-today-no-bank-device'),
    window: 'evening',
    dateContext,
    bankItems: richBankItems.filter((item) => item.category !== 'born_today'),
  }, { seed: 'born-today-no-bank-seed' });
  const spareSlot = withoutBank.slots.find((s) => s.id === 'model_only_spare_fact_born_today');
  assert(spareSlot, 'born_today must fall back to spare_fact when the Daily Bank has no born_today item');
  assert.strictEqual(spareSlot.type, 'spare_fact');
}

function main() {
  testExactOrderWithRichData();
  testModelOnlySlotsSurviveEmptyBank();
  testModelOnlyFallbackTypesSurviveEmptyBank();
  testWordRecallSameBatchUsesWordLearningWord();
  testWordRecallSameBatchDegradesGracefullyWithNoWord();
  testGenderTipAndCityFactDegradeGracefully();
  testGenderTipUsesProfileGenderWhenGiven();
  testPhoneTrendTopicDiffersByWindow();
  testCultureHasTopic();
  testAlways12SlotsWithEmptyBankAndProfile();
  testSpareFactSubstitutionsAreLogged();
  testGreetingAndGoodnightGetNoNameTopicWhenNameIsAbsent();
  testGreetingAndGoodnightKeepDefaultTopicWhenNameIsKnown();
  testBornTodayComesFromBankAndFallsBackToSpareFact();
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
