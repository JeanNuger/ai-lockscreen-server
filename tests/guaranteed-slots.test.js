// Regression coverage for the guaranteed-slot planner change: holiday_today,
// history_today, weather_lifehack, and word_learning must occupy a slot in
// EVERY batch where content for them exists, instead of competing in the
// priority+random lottery like everything else. Runs planSlots() directly
// (no OpenAI calls) across many different seeds/device ids/windows to prove
// this holds every time, not just probabilistically.
const assert = require('assert');
const { BATCH_SIZE } = require('../src/constants');
const { planSlots, _test: plannerTest } = require('../src/slotPlanner');

const baseInput = {
  device: { device_id: 'guaranteed-device' },
  window: 'day',
  dateContext: {
    date: '2026-09-21',
    weekday: 'Monday',
    time: '12:00',
    tomorrow_date: '2026-09-22',
    tomorrow_weekday: 'Tuesday',
  },
  weather: { temperatureC: 20, city: 'Almaty', description: 'clear' },
  bankItems: [
    { id: 1, category: 'holiday', content_text: 'Today is a real holiday.', tags: ['global'] },
    { id: 2, category: 'on_this_day', content_text: 'Something happened on this day.', tags: ['global'] },
    { id: 3, category: 'idiom', content_text: 'break the ice -- to ease tension', tags: ['global'] },
    // Plenty of high-volume competitive content so the guaranteed types have
    // real competition to win against -- if the guarantee mechanism were
    // broken (still just weighted-random), some of the 30 runs below would
    // miss one of the 4 guaranteed types by chance.
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
  // 1. Direct list/priority check requested by the task.
  assert.deepStrictEqual(
    plannerTest.GUARANTEED_TYPES,
    ['word_learning', 'holiday_today', 'history_today', 'weather_lifehack'],
    'guaranteed type list must match the agreed set'
  );

  // 2. Repeated batches across many seeds (simulates many devices/windows)
  // must all include all 4 guaranteed types when content exists for them.
  const RUN_COUNT = 30;
  for (let i = 0; i < RUN_COUNT; i++) {
    const planned = planSlots(baseInput, { seed: `guaranteed-run-${i}` });
    assert.strictEqual(planned.slots.length, BATCH_SIZE, `run ${i} must still return ${BATCH_SIZE} slots`);
    const types = slotTypes(planned.slots);
    for (const guaranteedType of plannerTest.GUARANTEED_TYPES) {
      assert(
        types.has(guaranteedType),
        `run ${i} (seed guaranteed-run-${i}) is missing guaranteed type "${guaranteedType}" -- guarantee is not holding`
      );
    }
  }

  // 3. Missing content for one guaranteed type (no weather this time) must
  // NOT produce an empty/broken slot -- it simply falls out of the
  // guaranteed set and the other 3 remain guaranteed.
  const noWeatherInput = { ...baseInput, weather: null };
  for (let i = 0; i < 10; i++) {
    const planned = planSlots(noWeatherInput, { seed: `no-weather-run-${i}` });
    assert.strictEqual(planned.slots.length, BATCH_SIZE);
    const types = slotTypes(planned.slots);
    assert(!types.has('weather_lifehack'), `run ${i} must not have a weather slot when there is no weather data`);
    for (const guaranteedType of ['word_learning', 'holiday_today', 'history_today']) {
      assert(types.has(guaranteedType), `run ${i} is missing guaranteed type "${guaranteedType}" even though weather alone was withheld`);
    }
  }

  // 4. Type caps still respected: a guaranteed pick plus a second,
  // independently-won competitive pick of the same type must never together
  // exceed that type's existing cap (DEFAULT_TYPE_CAP = 2 for these types).
  const duplicateHolidayInput = {
    ...baseInput,
    bankItems: [
      ...baseInput.bankItems,
      { id: 12, category: 'holiday', content_text: 'A second, different holiday item for today.', tags: ['global'] },
    ],
  };
  for (let i = 0; i < 10; i++) {
    const planned = planSlots(duplicateHolidayInput, { seed: `dup-holiday-run-${i}` });
    const holidayCount = planned.slots.filter((slot) => slot.type === 'holiday_today').length;
    assert(holidayCount >= 1 && holidayCount <= 2, `run ${i}: holiday_today count (${holidayCount}) must respect its existing cap of 2 even with a guaranteed pick`);
  }

  // 5. Edge case sanity: GUARANTEED_TYPES (4) can never exceed BATCH_SIZE, so
  // selectGuaranteedSlots' defensive truncation-by-priority is exercised
  // directly here rather than left completely untested.
  const overflowCandidates = plannerTest.GUARANTEED_TYPES.map((type, index) =>
    plannerTest.createCandidate({ id: `overflow_${type}`, type, priority: 100 - index, facts: {} }));
  const truncated = plannerTest.selectGuaranteedSlots(overflowCandidates, 2, () => 0, { contentKeys: new Set(), topicKeys: new Set() });
  assert.strictEqual(truncated.length, 2, 'truncation must cut guaranteed picks down to the slots actually available');
  assert.deepStrictEqual(
    truncated.map((c) => c.type),
    [overflowCandidates[0].type, overflowCandidates[1].type],
    'truncation must keep the highest-priority guaranteed types first'
  );

  console.log('guaranteed-slots.test.js: all assertions passed');
}

main();
