// Regression coverage for the OLD window-aware fixed-slot mechanism inside
// planSlots() (fixedMorning/fixedNightRecall/mandatoryLast -- the
// MORNING_FIXED_TYPES-prefix + night's learning_recall-second-to-last
// design). Fixed-order rebuild, step 1 (owner-approved 12-topic matrix per
// window, see slotPlanner.js's FIXED_ORDER_BY_WINDOW) replaces this
// mechanism as the ACTUAL production behavior for morning/day/evening/night
// -- planSlots() now takes a completely different code path for all four
// real windows (see planSlots' own "if (fixedOrder) {...return...}" early
// branch), so the old mechanism this file covered is no longer reachable
// through planSlots() with any real window name.
//
// The old code itself is intentionally NOT deleted yet (owner decision --
// cleanup is a separate step), so this file keeps testing what's still
// directly testable: the retained constants and the pure helper functions
// the old mechanism was built from. The old integration-level guarantees
// ("morning's first 5-7 positions are exactly this sequence via planSlots",
// "night's second-to-last slot is learning_recall via planSlots") are no
// longer true of real production windows and have been REMOVED from this
// file rather than left failing -- the equivalent, CURRENT guarantee (all
// 12 positions per window, in the owner-approved order) is covered instead
// by tests/fixed-order-slots.test.js.
const assert = require('assert');
const { FIXED_ORDER_BY_WINDOW, _test: plannerTest } = require('../src/slotPlanner');

const WINDOW_RESTRICTED_TYPES = ['weather_lifehack', 'holiday_today', 'history_today', 'word_learning', 'daily_horoscope', 'daily_numerology'];

function main() {
  // 1. Direct list check: MORNING_FIXED_TYPES/MORNING_ONLY_TYPES themselves
  // are unchanged (still used by planMorningPack's MORNING_PACK_ORDER and
  // by the retained-but-unreachable-for-real-windows old planSlots code).
  assert.deepStrictEqual(
    plannerTest.MORNING_FIXED_TYPES,
    ['greeting_name', 'weather_lifehack', 'daily_horoscope', 'holiday_today', 'history_today', 'daily_numerology', 'word_learning'],
    'MORNING_FIXED_TYPES must be unchanged by the fixed-order rebuild'
  );
  assert.deepStrictEqual(
    [...plannerTest.MORNING_ONLY_TYPES].sort(),
    WINDOW_RESTRICTED_TYPES.slice().sort(),
    'MORNING_ONLY_TYPES must be unchanged by the fixed-order rebuild'
  );

  // 2. selectGuaranteedSlots is a pure function, independent of planSlots'
  // window branching -- direct sanity check that the defensive
  // truncation-by-priority still works when called explicitly.
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

  // 3. GUARANTEED_TYPES_BY_WINDOW is still empty for every window -- the
  // fixed-order rebuild didn't touch this mechanism, it just made it (like
  // the rest of the old selection code) unreachable for real windows.
  for (const window of ['morning', 'day', 'evening', 'night']) {
    assert.deepStrictEqual(
      plannerTest.guaranteedTypesForWindow(window),
      [],
      `guaranteedTypesForWindow('${window}') must still be empty`
    );
  }

  // 4. planSlots() for every real window now takes the fixed-order branch,
  // not the old fixedMorning/fixedNightRecall/mandatoryLast code -- direct
  // proof that the two are mutually exclusive as designed (FIXED_ORDER_BY_
  // WINDOW covers exactly the same four window names the old mechanism used
  // to special-case, so the old code's window checks -- input.window ===
  // 'morning'/'night' -- can now never be reached in production).
  for (const window of ['morning', 'day', 'evening', 'night']) {
    assert(
      Object.prototype.hasOwnProperty.call(FIXED_ORDER_BY_WINDOW, window),
      `FIXED_ORDER_BY_WINDOW must define window "${window}" so planSlots() never falls through to the old mechanism for it`
    );
  }

  console.log('guaranteed-slots.test.js: all assertions passed');
}

main();
