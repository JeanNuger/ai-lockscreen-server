// Regression coverage for window-aware FIXED slots (replaces the earlier
// "guaranteed anywhere in the batch, any window" design): morning positions
// 1-5 must be the strict sequence greeting_name -> weather_lifehack ->
// holiday_today -> history_today -> word_learning; day/evening must never
// offer these 4 types as candidates at all; night must never offer them
// either, and its second-to-last slot must be learning_recall (if a
// candidate exists) with goodnight_care last. Runs planSlots() directly (no
// OpenAI calls) across many seeds to prove this holds every time, not just
// probabilistically.
const assert = require('assert');
const { BATCH_SIZE } = require('../src/constants');
const { planSlots, _test: plannerTest } = require('../src/slotPlanner');

const WINDOW_RESTRICTED_TYPES = ['weather_lifehack', 'holiday_today', 'history_today', 'word_learning'];

const baseInput = {
  device: { device_id: 'guaranteed-device' },
  window: 'morning',
  dateContext: {
    date: '2026-09-21',
    weekday: 'Monday',
    time: '08:00',
    tomorrow_date: '2026-09-22',
    tomorrow_weekday: 'Tuesday',
  },
  weather: { temperatureC: 20, city: 'Almaty', description: 'clear' },
  bankItems: [
    { id: 1, category: 'holiday', content_text: 'Today is a real holiday.', tags: ['global'] },
    { id: 2, category: 'on_this_day', content_text: 'Something happened on this day.', tags: ['global'] },
    { id: 3, category: 'idiom', content_text: 'break the ice -- to ease tension', tags: ['global'] },
    // Plenty of high-volume competitive content so the fixed types have real
    // competition to win against -- if the fixed-position mechanism were
    // broken (still just weighted-random), some of the runs below would miss
    // one of the 4 fixed types by chance, or land it out of sequence.
    { id: 4, category: 'quote', content_text: 'A quote to fill a slot.', tags: ['global'] },
    { id: 5, category: 'fact', content_text: 'A fact to fill a slot.', tags: ['global'] },
    { id: 6, category: 'statistic', content_text: 'A statistic to fill a slot.', tags: ['global'] },
    { id: 7, category: 'science', content_text: 'A science fact to fill a slot.', tags: ['global'] },
    { id: 8, category: 'economics', content_text: 'An economics fact to fill a slot.', tags: ['global'] },
    { id: 9, category: 'country_fact', content_text: 'A country fact to fill a slot.', tags: ['global', 'KZ'] },
    { id: 10, category: 'good_news', content_text: 'Good news to fill a slot.', tags: ['global'] },
    { id: 11, category: 'technology', content_text: 'A technology fact to fill a slot.', tags: ['global'] },
  ],
};

function slotTypes(slots) {
  return new Set(slots.map((slot) => slot.type));
}

function main() {
  // 1. Direct list check requested by the task: the approved fixed sequence.
  assert.deepStrictEqual(
    plannerTest.MORNING_FIXED_TYPES,
    ['greeting_name', 'weather_lifehack', 'holiday_today', 'history_today', 'word_learning'],
    'morning fixed-position sequence must match the agreed 1-5 order'
  );
  assert.deepStrictEqual(
    [...plannerTest.MORNING_ONLY_TYPES].sort(),
    WINDOW_RESTRICTED_TYPES.slice().sort(),
    'weather/holiday/history/word_learning must be the exact morning-only type set'
  );

  // 2. Morning: positions 1-5 must be the EXACT strict sequence, every run,
  // when content for all 4 restricted types exists -- not just "present
  // somewhere," the literal index order.
  const RUN_COUNT = 30;
  for (let i = 0; i < RUN_COUNT; i++) {
    const planned = planSlots(baseInput, { seed: `morning-run-${i}` });
    assert.strictEqual(planned.slots.length, BATCH_SIZE, `run ${i} must still return ${BATCH_SIZE} slots`);
    const firstFive = planned.slots.slice(0, 5).map((slot) => slot.type);
    assert.deepStrictEqual(
      firstFive,
      plannerTest.MORNING_FIXED_TYPES,
      `run ${i} (seed morning-run-${i}): positions 1-5 must be exactly ${JSON.stringify(plannerTest.MORNING_FIXED_TYPES)}, got ${JSON.stringify(firstFive)}`
    );
    // None of the 4 restricted types may appear a second time in positions 6-12.
    const rest = planned.slots.slice(5).map((slot) => slot.type);
    for (const restrictedType of WINDOW_RESTRICTED_TYPES) {
      assert(
        !rest.includes(restrictedType),
        `run ${i}: "${restrictedType}" must not appear a second time outside its fixed position`
      );
    }
  }

  // 3. day/evening: the 4 restricted types must never be candidates at all,
  // even though the same rich bankItems/weather input is supplied.
  for (const window of ['day', 'evening']) {
    for (let i = 0; i < 10; i++) {
      const planned = planSlots({ ...baseInput, window }, { seed: `${window}-run-${i}` });
      assert.strictEqual(planned.slots.length, BATCH_SIZE);
      const types = slotTypes(planned.slots);
      for (const restrictedType of WINDOW_RESTRICTED_TYPES) {
        assert(
          !types.has(restrictedType),
          `${window} run ${i}: "${restrictedType}" must never be a candidate outside morning`
        );
      }
    }
  }

  // 4. night: the 4 restricted types must never appear either; when a
  // learning_recall candidate exists it must sit at the second-to-last
  // position (index BATCH_SIZE - 2), with goodnight_care last.
  {
    const nightInput = {
      ...baseInput,
      window: 'night',
      device: { device_id: 'guaranteed-night-device', name: 'Aruzhan' },
    };
    for (let i = 0; i < 10; i++) {
      const planned = planSlots(nightInput, { seed: `night-run-${i}` });
      assert.strictEqual(planned.slots.length, BATCH_SIZE);
      const types = planned.slots.map((slot) => slot.type);
      for (const restrictedType of WINDOW_RESTRICTED_TYPES) {
        assert(!types.includes(restrictedType), `night run ${i}: "${restrictedType}" must never be a candidate at night`);
      }
      assert.strictEqual(types[BATCH_SIZE - 1], 'goodnight_care', `night run ${i}: last slot must be goodnight_care`);
    }

    // With an actual recall candidate available, it must land exactly
    // second-to-last, every run.
    const nightWithRecall = {
      ...nightInput,
      recallCandidate: { id: 777, word_key: 'recall-key', word_text: 'a previously taught word' },
    };
    for (let i = 0; i < 10; i++) {
      const planned = planSlots(nightWithRecall, { seed: `night-recall-run-${i}` });
      const types = planned.slots.map((slot) => slot.type);
      assert.strictEqual(
        types[BATCH_SIZE - 2],
        'learning_recall',
        `night-with-recall run ${i}: second-to-last slot must be learning_recall, got ${JSON.stringify(types)}`
      );
      assert.strictEqual(types[BATCH_SIZE - 1], 'goodnight_care', `night-with-recall run ${i}: last slot must still be goodnight_care`);
    }

    // Without a candidate, the position is simply not reserved -- no broken/
    // empty slot, goodnight_care still lands last, batch still completes.
    for (let i = 0; i < 5; i++) {
      const planned = planSlots(nightInput, { seed: `night-no-recall-run-${i}` });
      assert.strictEqual(planned.slots.length, BATCH_SIZE);
      assert(!planned.slots.some((slot) => slot.type === 'learning_recall'), `night-no-recall run ${i}: must not invent a learning_recall slot with no candidate`);
      assert.strictEqual(planned.slots[BATCH_SIZE - 1].type, 'goodnight_care', `night-no-recall run ${i}: goodnight_care must still be last`);
    }
  }

  // 5. Missing content for one morning-fixed type (no weather this time)
  // must NOT produce an empty/broken slot or shift the sequence with a gap
  // -- the remaining fixed types simply occupy the earlier positions.
  const noWeatherInput = { ...baseInput, weather: null };
  for (let i = 0; i < 10; i++) {
    const planned = planSlots(noWeatherInput, { seed: `no-weather-run-${i}` });
    assert.strictEqual(planned.slots.length, BATCH_SIZE);
    const firstFour = planned.slots.slice(0, 4).map((slot) => slot.type);
    assert.deepStrictEqual(
      firstFour,
      ['greeting_name', 'holiday_today', 'history_today', 'word_learning'],
      `no-weather run ${i}: fixed sequence must condense, not leave a gap, got ${JSON.stringify(firstFour)}`
    );
    assert(!slotTypes(planned.slots).has('weather_lifehack'), `no-weather run ${i} must not have a weather slot when there is no weather data`);
  }

  // 6. Type caps still respected: the fixed-position pick plus a second,
  // independently-won competitive pick of the SAME type must never together
  // exceed that type's existing cap (DEFAULT_TYPE_CAP = 2 for holiday_today).
  // This is a direct regression test for the fixedTypeCounts seeding fix in
  // slotPlanner.js (without it, a duplicate bank item could slip past the cap).
  const duplicateHolidayInput = {
    ...baseInput,
    bankItems: [
      ...baseInput.bankItems,
      { id: 12, category: 'holiday', content_text: 'A second, different holiday item for today.', tags: ['global'] },
    ],
  };
  for (let i = 0; i < 15; i++) {
    const planned = planSlots(duplicateHolidayInput, { seed: `dup-holiday-run-${i}` });
    const holidayCount = planned.slots.filter((slot) => slot.type === 'holiday_today').length;
    assert(
      holidayCount >= 1 && holidayCount <= 2,
      `run ${i}: holiday_today count (${holidayCount}) must respect its existing cap of 2 even with a fixed-position pick already using one`
    );
    assert.strictEqual(planned.slots[2].type, 'holiday_today', `run ${i}: position 3 (index 2) must still be the fixed holiday_today slot`);
  }

  // 7. selectGuaranteedSlots is now parameterized by `types` rather than
  // reading a module-level constant -- direct sanity check that the
  // defensive truncation-by-priority still works when called explicitly.
  const overflowTypes = ['word_learning', 'holiday_today', 'history_today', 'weather_lifehack'];
  const overflowCandidates = overflowTypes.map((type, index) =>
    plannerTest.createCandidate({ id: `overflow_${type}`, type, priority: 100 - index, facts: {} }));
  const truncated = plannerTest.selectGuaranteedSlots(overflowCandidates, overflowTypes, 2, () => 0, { contentKeys: new Set(), topicKeys: new Set() });
  assert.strictEqual(truncated.length, 2, 'truncation must cut guaranteed picks down to the slots actually available');
  assert.deepStrictEqual(
    truncated.map((c) => c.type),
    [overflowCandidates[0].type, overflowCandidates[1].type],
    'truncation must keep the highest-priority types first'
  );

  // 8. GUARANTEED_TYPES_BY_WINDOW is currently empty for every window (all
  // restricted/recall types are handled via fixed positions instead) -- a
  // direct assertion so a future edit can't silently reintroduce the
  // double-counting bug this replaced without a test noticing.
  for (const window of ['morning', 'day', 'evening', 'night']) {
    assert.deepStrictEqual(
      plannerTest.guaranteedTypesForWindow(window),
      [],
      `guaranteedTypesForWindow('${window}') must be empty -- these types are fixed-position now, not a separate guarantee`
    );
  }

  console.log('guaranteed-slots.test.js: all assertions passed');
}

main();
