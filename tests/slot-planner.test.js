const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-slot-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
process.env.OPENAI_API_KEY = 'test-key-slot-planner';

const db = require('../src/db');
const { BATCH_SIZE, STYLE_IDS } = require('../src/constants');
const {
  FACTUAL_TYPES,
  collectCandidates,
  planSlots,
  _test: plannerTest,
} = require('../src/slotPlanner');
const {
  generateBatch,
  _test: contentTest,
} = require('../src/contentGenerator');
const { getBankDateString } = require('../src/dailyContentBank');

function slotTypeCounts(slots) {
  const counts = new Map();
  for (const slot of slots) {
    counts.set(slot.type, (counts.get(slot.type) || 0) + 1);
  }
  return counts;
}

function validSlotPhrases(slots) {
  return slots.map((slot, index) => ({
    slot_id: slot.slot_id,
    text: `Concrete slot line ${index + 1}`,
    style_id: STYLE_IDS[index],
  }));
}

function assertFactualSlotsAreGrounded(slots) {
  for (const slot of slots) {
    if (!FACTUAL_TYPES.has(slot.type)) {
      continue;
    }
    assert(
      slot.facts && Object.keys(slot.facts).length > 0,
      `factual slot must include grounded facts: ${slot.type}`
    );
    assert.notStrictEqual(slot.source, 'creative', `factual slot must not be creative filler: ${slot.type}`);
    assert.notStrictEqual(slot.source, 'editorial', `factual slot must not be empty editorial filler: ${slot.type}`);
  }
}

async function main() {
  const baseInput = {
    device: {
      device_id: 'planner-device',
      name: 'Aruzhan',
      birth_date: '1995-05-20',
      gender: 'female',
      interests: JSON.stringify(['work']),
      personal_goal: 'productivity',
      tone: 'humorous',
    },
    window: 'day',
    dateContext: {
      date: '2026-09-20',
      weekday: 'Sunday',
      time: '12:00',
      tomorrow_date: '2026-09-21',
      tomorrow_weekday: 'Monday',
    },
    weather: { temperatureC: 18, city: 'Almaty', description: 'rain' },
    bankItems: [
      { category: 'on_this_day', content_text: 'In 1519, Magellan set sail across the Atlantic.', tags: ['global', 'history'] },
      { category: 'science', content_text: 'Octopuses have three hearts.', tags: ['global'] },
    ],
  };

  const planned = planSlots(baseInput, { seed: 'same-seed' });
  assert.strictEqual(planned.slots.length, BATCH_SIZE, 'planner must always return 12 slots');
  assert.strictEqual(new Set(planned.slots.map((slot) => slot.slot_id)).size, BATCH_SIZE, 'slot IDs must be unique');
  assertFactualSlotsAreGrounded(planned.slots);

  assert.strictEqual(
    plannerTest.antiRepeatPenalty(
      plannerTest.createCandidate({ id: 'recent-content', type: 'science_tech', priority: 50, facts: { text: 'Recent' } }),
      { contentKeys: new Set(['recent-content']), topicKeys: new Set() }
    ),
    45,
    'recent content_key must receive an anti-repeat penalty'
  );
  assert.strictEqual(
    plannerTest.antiRepeatPenalty(
      plannerTest.createCandidate({ id: 'weather_current_safe', type: 'weather_lifehack', priority: 50, facts: { temperature_c: 20 } }),
      { contentKeys: new Set(['weather_current_safe']), topicKeys: new Set() }
    ),
    0,
    'contextual weather content must not receive normal content cooldown'
  );

  // Uses type: 'learning_recall' (TYPE_CAPS.learning_recall = 1, and NOT one of
  // CREATIVE_FILLER_BLUEPRINTS' types, so the capsExhausted overflow path in
  // selectNonMandatory's filler loop -- needed here since this test supplies
  // only 2 explicit candidates and the planner must still fill 12 -- never
  // re-adds this type past its cap) rather than 'science_tech' (default
  // cap 2, which both candidates would satisfy trivially) so this actually
  // exercises the SELECTION decision the anti-repeat penalty is meant to
  // influence. Checking final slot ORDER instead (as an earlier version of
  // this test did) doesn't work: selectNonMandatory's last line always
  // returns `shuffle(selected, rng)` (pre-existing, unrelated to Phase 3) --
  // a genuine reorder of whatever got selected, so which of two same-type
  // selected candidates appears first in `slots` is never a promise this
  // function makes, penalty or not. Set membership (was the penalized
  // candidate excluded at all?) is the only claim antiRepeatPenalty actually
  // supports.
  const freshVsRecent = planSlots({
    device: { device_id: 'memory-device' },
    window: 'day',
  }, {
    seed: 'memory-ranking-seed',
    rng: () => 0,
    recentContentMemory: [{ content_key: 'recent_riddle' }], // key name kept generic; value is what matters
    candidates: [
      plannerTest.createCandidate({ id: 'recent_riddle', type: 'learning_recall', priority: 50, facts: { text: 'recent' } }),
      plannerTest.createCandidate({ id: 'fresh_riddle', type: 'learning_recall', priority: 50, facts: { text: 'fresh' } }),
    ],
  });
  const riddleSlots = freshVsRecent.slots.filter((slot) => slot.type === 'learning_recall');
  assert.strictEqual(riddleSlots.length, 1, 'learning_recall type cap (1) must still apply with anti-repeat candidates present');
  assert.strictEqual(riddleSlots[0].id, 'fresh_riddle', 'fresh candidate must win the capped slot over recently-shown content');

  const allRecent = planSlots({
    device: { device_id: 'all-recent-device' },
    window: 'day',
  }, {
    seed: 'all-recent-seed',
    rng: () => 0,
    recentContentMemory: Array.from({ length: BATCH_SIZE }, (_, index) => ({ content_key: `recent_candidate_${index + 1}` })),
    candidates: Array.from({ length: BATCH_SIZE }, (_, index) => plannerTest.createCandidate({
      id: `recent_candidate_${index + 1}`,
      type: index % 2 === 0 ? 'science_tech' : 'unusual_fact',
      priority: 50 - index,
      facts: { text: `recent ${index + 1}` },
    })),
  });
  assert.strictEqual(allRecent.slots.length, BATCH_SIZE, 'recent candidates must remain eligible when needed to fill the batch');
  assert(
    allRecent.slots.some((slot) => slot.id && slot.id.startsWith('recent_candidate_')),
    'soft anti-repeat must not hard-exclude recent candidates'
  );

  // Daily Bank rows are freshly INSERTed every day (see dailyContentBank.js),
  // so item.id (and therefore content_key = `bank_${item.id}`) is NEVER the
  // same across two different days even for byte-identical fact text -- only
  // topic_key (a hash of the normalized text itself, independent of the row
  // id) can catch that repeat. Both claims -- "same text/type always yields
  // the same topic_key" and "a different row id does NOT defeat that match"
  // -- need their own coverage; a passing antiRepeatPenalty test alone
  // wouldn't reveal it if topic_key were left unset (as it initially was).
  const bankCandidateDay1 = plannerTest.bankItemToCandidate({ id: 101, category: 'quote', content_text: 'Same fact, different day.' });
  const bankCandidateDay2 = plannerTest.bankItemToCandidate({ id: 999, category: 'quote', content_text: '  Same fact, different day.  ' });
  assert.notStrictEqual(bankCandidateDay1.id, bankCandidateDay2.id, 'bank content_key is expected to differ across bank rows (by design)');
  assert.strictEqual(bankCandidateDay1.topic_key, bankCandidateDay2.topic_key, 'bank topic_key must be deterministic for the same fact text regardless of row id');
  const bankCandidateDifferentText = plannerTest.bankItemToCandidate({ id: 102, category: 'quote', content_text: 'A completely different fact.' });
  assert.notStrictEqual(bankCandidateDay1.topic_key, bankCandidateDifferentText.topic_key, 'different fact text must produce a different topic_key');

  // normalizeTextForTopicKey itself: case, whitespace, punctuation
  // (multi-language, not just ASCII . ! ?) and Unicode NFKC equivalence must
  // not create a new topic, but two genuinely different facts still must.
  const moonPeriod = plannerTest.normalizeTextForTopicKey('The Moon is moving away from Earth.');
  const moonBang = plannerTest.normalizeTextForTopicKey('The Moon is moving away from Earth!');
  const moonBare = plannerTest.normalizeTextForTopicKey('The Moon is moving away from Earth');
  const moonUpper = plannerTest.normalizeTextForTopicKey('THE MOON IS MOVING AWAY FROM EARTH.');
  const moonSpaced = plannerTest.normalizeTextForTopicKey('  The   Moon  is moving\taway from Earth.  ');
  const moonQuotedComma = plannerTest.normalizeTextForTopicKey('"The Moon," is moving, away from Earth."');
  assert.strictEqual(moonPeriod, moonBang, 'trailing . vs ! must normalize to the same topic_key input');
  assert.strictEqual(moonPeriod, moonBare, 'trailing punctuation vs none must normalize to the same topic_key input');
  assert.strictEqual(moonPeriod, moonUpper, 'case differences must normalize to the same topic_key input');
  assert.strictEqual(moonPeriod, moonSpaced, 'extra/irregular whitespace must normalize to the same topic_key input');
  assert.strictEqual(moonPeriod, moonQuotedComma, 'quotes and commas must normalize to the same topic_key input');
  assert.notStrictEqual(
    moonPeriod,
    plannerTest.normalizeTextForTopicKey('The Sun is moving away from Earth.'),
    'a genuinely different fact must still normalize to different text'
  );

  const punctuationBankA = plannerTest.bankItemToCandidate({ id: 201, category: 'quote', content_text: 'The Moon is moving away from Earth.' });
  const punctuationBankB = plannerTest.bankItemToCandidate({ id: 202, category: 'quote', content_text: 'The Moon is moving away from Earth!' });
  const punctuationBankC = plannerTest.bankItemToCandidate({ id: 203, category: 'quote', content_text: '"The Moon," is moving, away from Earth"' });
  assert.strictEqual(punctuationBankA.topic_key, punctuationBankB.topic_key, 'bank topic_key must ignore terminal punctuation differences (. vs !)');
  assert.strictEqual(punctuationBankA.topic_key, punctuationBankC.topic_key, 'bank topic_key must ignore quote/comma punctuation differences');

  // Unicode (Russian) must survive normalization as real letters, not get
  // stripped down to an ASCII-only (or empty) string -- the app is
  // multi-language, so an ASCII-only cleanup would silently break topic_key
  // for every non-Latin-script bank fact.
  const russianPeriod = plannerTest.normalizeTextForTopicKey('Луна медленно удаляется от Земли.');
  const russianBang = plannerTest.normalizeTextForTopicKey('ЛУНА МЕДЛЕННО УДАЛЯЕТСЯ ОТ ЗЕМЛИ!');
  assert.strictEqual(russianPeriod, russianBang, 'Russian case/punctuation differences must normalize to the same topic_key input');
  assert(/[а-яё]/.test(russianPeriod), 'Cyrillic letters must survive normalization, not be stripped to ASCII-only/empty');
  assert.notStrictEqual(russianPeriod.trim(), '', 'normalized Unicode text must not collapse to an empty string');

  const freshVsRecentTopic = planSlots({
    device: { device_id: 'topic-memory-device' },
    window: 'day',
  }, {
    seed: 'topic-ranking-seed',
    rng: () => 0,
    recentContentMemory: [{ content_key: 'unrelated_row_id', topic_key: bankCandidateDay1.topic_key }],
    candidates: [
      plannerTest.createCandidate({ ...bankCandidateDay2, type: 'learning_recall' }),
      plannerTest.createCandidate({ id: 'unrelated_fresh_riddle', type: 'learning_recall', priority: 50, facts: { text: 'fresh' } }),
    ],
  });
  const topicRiddleSlots = freshVsRecentTopic.slots.filter((slot) => slot.type === 'learning_recall');
  assert.strictEqual(topicRiddleSlots.length, 1, 'learning_recall type cap must still apply in the topic_key scenario');
  assert.strictEqual(topicRiddleSlots[0].id, 'unrelated_fresh_riddle', 'topic_key match on a DIFFERENT content_key/row id must still lose the capped slot to genuinely fresh content');

  const morning = planSlots({ ...baseInput, window: 'morning' }, { seed: 'morning-seed' });
  assert.strictEqual(morning.slots[0].type, 'greeting_name', 'morning first slot must be greeting_name');

  const night = planSlots({ ...baseInput, window: 'night' }, { seed: 'night-seed' });
  assert.strictEqual(night.slots[night.slots.length - 1].type, 'goodnight_care', 'night last slot must be goodnight_care');

  // personal_goal/tone remain removed-from-personalization (onboarding UI
  // fields, product decision) -- the planner must produce byte-identical
  // output whether or not they're present, with interests held constant.
  const noPersonalGoalToneInput = {
    ...baseInput,
    device: {
      device_id: 'planner-device',
      name: 'Aruzhan',
      birth_date: '1995-05-20',
      gender: 'female',
      interests: baseInput.device.interests,
    },
  };
  assert.deepStrictEqual(
    planSlots(baseInput, { seed: 'legacy-profile-seed' }).slots,
    planSlots(noPersonalGoalToneInput, { seed: 'legacy-profile-seed' }).slots,
    'planner must not depend on personal_goal/tone'
  );

  // interests, unlike personal_goal/tone, NOW deliberately do influence
  // planning (see the dedicated interests-personalization section below for
  // the precise, deterministic proof) -- this block only confirms a device
  // with zero interests at all (old client, or user selected none) still
  // plans a complete, valid batch, i.e. nothing breaks/degrades when the
  // field is entirely absent.
  const noInterestsAtAllInput = {
    ...baseInput,
    device: {
      device_id: 'planner-device',
      name: 'Aruzhan',
      birth_date: '1995-05-20',
      gender: 'female',
    },
  };
  const noInterestsPlanned = planSlots(noInterestsAtAllInput, { seed: 'legacy-profile-seed' });
  assert.strictEqual(noInterestsPlanned.slots.length, BATCH_SIZE, 'a device with no interests at all must still plan a full, normal batch');

  // --- interests personalization (post-selection interest_hint tagging) ---
  // Selection itself (candidateWeight/selectNonMandatory) is now completely
  // unaware of interests -- selectInterestAwareSlots only tags already-final
  // slots, so it structurally cannot override mandatory/learning-recall/
  // anti-repeat/country/factual-grounding/Daily-Bank-freshness/type-cap
  // decisions, all of which already happened before it ever runs.
  {
    const buildTaggedPool = (extra = []) => [
      plannerTest.createCandidate({ id: 'money_economics_a', type: 'money_economics', priority: 48, facts: { text: 'work fact a' } }),
      plannerTest.createCandidate({ id: 'money_economics_b', type: 'money_economics', priority: 48, facts: { text: 'work fact b' } }),
      plannerTest.createCandidate({ id: 'science_a', type: 'science_tech', priority: 48, facts: { text: 'self-development fact a' } }),
      plannerTest.createCandidate({ id: 'science_b', type: 'science_tech', priority: 48, facts: { text: 'self-development fact b' } }),
      plannerTest.createCandidate({ id: 'humor_a', type: 'smart_humor_observation', priority: 30, facts: {} }),
      plannerTest.createCandidate({ id: 'humor_b', type: 'smart_humor_observation', priority: 30, facts: {} }),
      plannerTest.createCandidate({ id: 'technology_a', type: 'science_tech', priority: 30, facts: { text: 'tech fact' } }),
      plannerTest.createCandidate({ id: 'everyday_observation_a', type: 'everyday_observation', priority: 20, facts: {} }),
      plannerTest.createCandidate({ id: 'playful_thought_a', type: 'playful_thought', priority: 20, facts: {} }),
      plannerTest.createCandidate({ id: 'tiny_imagined_scene_a', type: 'tiny_imagined_scene', priority: 20, facts: {} }),
      plannerTest.createCandidate({ id: 'gentle_wish_a', type: 'gentle_wish', priority: 15, facts: {} }),
      plannerTest.createCandidate({ id: 'language_play_a', type: 'language_play', priority: 10, facts: {} }),
      ...extra,
    ];

    // 1 & 2: multiple selected interests are distributed across at most
    // MAX_INTEREST_AWARE_SLOTS slots, not all piled onto one interest.
    const planned = planSlots(
      { device: { device_id: 'interest-hint-device', interests: JSON.stringify(['work', 'self_development']) }, window: 'day' },
      { seed: 'interest-hint-seed', candidates: buildTaggedPool() }
    );
    assert.strictEqual(planned.slots.length, BATCH_SIZE);
    const hinted = planned.slots.filter((slot) => slot.interest_hint);
    assert(hinted.length > 0, 'at least one slot should receive an interest_hint when compatible candidates exist');
    assert(hinted.length <= plannerTest.MAX_INTEREST_AWARE_SLOTS, `interest-hinted slots (${hinted.length}) must never exceed MAX_INTEREST_AWARE_SLOTS`);
    const hintValues = new Set(hinted.map((slot) => slot.interest_hint));
    assert(
      [...hintValues].every((v) => v === 'work' || v === 'self_development'),
      'only the user\'s own selected interests may ever appear as a hint'
    );
    if (hinted.length >= 2) {
      assert(hintValues.size >= 1, 'sanity: at least one distinct interest represented');
    }

    // 3: every slot NOT chosen for personalization has no interest_hint at all.
    const unhinted = planned.slots.filter((slot) => !hinted.includes(slot));
    assert(unhinted.every((slot) => slot.interest_hint === undefined), 'non-personalized slots must carry no interest_hint');

    // Direct unit-level proof of distribution across 2 distinct interests
    // when 2+ compatible slots exist for each (deterministic, no planSlots
    // randomness involved at all).
    const directHints = plannerTest.selectInterestAwareSlots(
      buildTaggedPool().map((c, i) => ({ ...c, slot_id: `s${i + 1}` })),
      JSON.stringify(['work', 'self_development'])
    );
    const distinctInterestsUsed = new Set(directHints.values());
    assert.strictEqual(distinctInterestsUsed.size, 2, 'round 1 must give each distinct compatible interest one slot before any interest gets a second');
    assert(directHints.size <= plannerTest.MAX_INTEREST_AWARE_SLOTS, 'direct call must also respect the hard cap');

    // A single selected interest CAN still fill more than one slot (up to
    // the cap) when enough compatible candidates exist -- distribution only
    // means "not always the same interest when others qualify," not "cap
    // each interest at one slot forever."
    const singleInterestHints = plannerTest.selectInterestAwareSlots(
      buildTaggedPool().map((c, i) => ({ ...c, slot_id: `s${i + 1}` })),
      JSON.stringify(['work'])
    );
    assert.strictEqual(singleInterestHints.size, 2, 'a single interest with 2 compatible candidates should use both, still within the cap');
    assert([...singleInterestHints.values()].every((v) => v === 'work'));

    // 4: a device with no interests gets a completely normal batch -- zero
    // hints, and selection is untouched (interests can no longer influence
    // scoring at all, so this is byte-identical to the pre-interests planner).
    const noInterestPlanned = planSlots(
      { device: { device_id: 'interest-hint-device-none' }, window: 'day' },
      { seed: 'interest-hint-seed', candidates: buildTaggedPool() }
    );
    assert.strictEqual(noInterestPlanned.slots.length, BATCH_SIZE);
    assert(noInterestPlanned.slots.every((slot) => slot.interest_hint === undefined), 'a device with no interests must receive zero interest_hints');
    assert.deepStrictEqual(
      noInterestPlanned.slots.map((s) => ({ id: s.id, type: s.type })),
      planned.slots.map((s) => ({ id: s.id, type: s.type })),
      'selection itself (which candidates win which slots) must be identical with vs without interests -- only the post-hoc hint differs'
    );

    // Safe degradation: malformed/empty/unknown interests never throw and
    // never assign a hint.
    assert.strictEqual(plannerTest.selectInterestAwareSlots(planned.slots, null).size, 0);
    assert.strictEqual(plannerTest.selectInterestAwareSlots(planned.slots, JSON.stringify([])).size, 0);
    assert.strictEqual(plannerTest.selectInterestAwareSlots(planned.slots, 'not valid json').size, 0);
    assert.strictEqual(plannerTest.selectInterestAwareSlots(planned.slots, JSON.stringify(['not_a_real_interest'])).size, 0);

    // 8: factual grounding wins -- an interest never invents or alters a
    // slot's facts; tagging only ever adds interest_hint, facts are the
    // exact same object/content before and after.
    for (const slot of hinted) {
      const original = planned.candidates.find((c) => c.id === slot.id);
      assert.deepStrictEqual(slot.facts, original.facts, 'an interest_hint must never change/add to a slot\'s grounded facts');
    }

    // IMPORTANT DAILY BANK RULE: an interest with NO type-compatible slot in
    // the final batch must simply be skipped, never forced onto an
    // unrelated slot.
    const noCompatiblePool = [
      plannerTest.createCandidate({ id: 'humor_only_a', type: 'humor', priority: 30, facts: {} }),
      plannerTest.createCandidate({ id: 'humor_only_b', type: 'humor', priority: 30, facts: {} }),
    ].map((c, i) => ({ ...c, slot_id: `s${i + 1}` }));
    const noCompatibleHints = plannerTest.selectInterestAwareSlots(noCompatiblePool, JSON.stringify(['work']));
    assert.strictEqual(noCompatibleHints.size, 0, 'an interest with no compatible slot in the final batch must be skipped, never forced onto an unrelated one');
  }

  const candidates = collectCandidates(baseInput);
  assert(candidates.some((candidate) => candidate.source === 'daily_bank' && candidate.type === 'history_today'), 'on_this_day bank item must become history_today candidate');
  assert(candidates.some((candidate) => candidate.source === 'daily_bank' && candidate.type === 'science_tech'), 'a science-category bank item must become a science_tech candidate (Phase 5: direct mapping, not keyword inference)');

  const noPhoneTrendCandidates = collectCandidates({
    ...baseInput,
    phoneTrends: {
      unlocks_since_last_batch: 65,
      steps_since_last_batch: 4217,
      unlocks_vs_yesterday: 'normal',
    },
  });
  assert(!noPhoneTrendCandidates.some((candidate) => candidate.type === 'phone_trend'), 'phone_trend candidate must require meaningful semantic trend facts');

  const phoneTrendCandidates = collectCandidates({
    ...baseInput,
    phoneTrends: {
      unlocks_vs_yesterday: 'higher',
      steps_vs_yesterday: 'lower',
      raw_count: 999,
    },
  });
  const phoneTrendCandidate = phoneTrendCandidates.find((candidate) => candidate.type === 'phone_trend');
  assert(phoneTrendCandidate, 'semantic phone trends must create one phone_trend candidate');
  assert.deepStrictEqual(
    phoneTrendCandidate.facts,
    { unlocks_vs_yesterday: 'higher', steps_vs_yesterday: 'lower' },
    'phone_trend candidate must keep only semantic facts'
  );
  assert(phoneTrendCandidate.constraints.includes('no_exact_counts'), 'phone_trend must explicitly forbid exact counts');

  const phoneTrendSlots = planSlots({
    device: { device_id: 'phone-trend-device' },
    window: 'day',
    dateContext: null,
    weather: null,
    bankItems: [],
    phoneTrends: { unlocks_vs_yesterday: 'higher', steps_vs_yesterday: 'lower' },
  }, { seed: 'phone-trend-seed' }).slots;
  assert(
    phoneTrendSlots.filter((slot) => slot.type === 'phone_trend').length <= 1,
    'planner must cap phone_trend at one slot per batch'
  );
  assert.strictEqual(
    phoneTrendSlots.filter((slot) => slot.type === 'phone_trend').length,
    1,
    'meaningful semantic phone trend must be reachable as a selected slot in a controlled sparse batch'
  );

  const noPhoneTrendSlots = planSlots({
    device: { device_id: 'no-phone-trend-device' },
    window: 'day',
    dateContext: null,
    weather: null,
    bankItems: [],
  }, { seed: 'phone-trend-seed' }).slots;
  assert.strictEqual(
    noPhoneTrendSlots.filter((slot) => slot.type === 'phone_trend').length,
    0,
    'planner must not select phone_trend when no semantic phoneTrends exist'
  );

  const counts = slotTypeCounts(planned.slots);
  for (const [type, count] of counts.entries()) {
    const maxAllowed = plannerTest.TYPE_CAPS[type] || 2;
    assert(count <= maxAllowed, `planner must avoid excessive concentration of one type: ${type}=${count}`);
  }

  assert.deepStrictEqual(
    planSlots(baseInput, { seed: 'repeatable-seed' }).slots,
    planSlots(baseInput, { seed: 'repeatable-seed' }).slots,
    'same seed must be reproducible'
  );

  let changedWithDifferentSeed = false;
  const seedA = JSON.stringify(planSlots(baseInput, { seed: 'seed-a' }).slots);
  for (const seed of ['seed-b', 'seed-c', 'seed-d']) {
    if (JSON.stringify(planSlots(baseInput, { seed }).slots) !== seedA) {
      changedWithDifferentSeed = true;
      break;
    }
  }
  assert(changedWithDifferentSeed, 'different seeds should be able to change non-mandatory composition/order');

  const bankCandidate = plannerTest.bankItemToCandidate(
    { category: 'holiday', content_text: 'Today is World Cleanup Day.', tags: ['global'] },
    0
  );
  assert.strictEqual(bankCandidate.type, 'holiday_today');
  assert.strictEqual(bankCandidate.bank_category, 'holiday');

  const slotSubset = planned.slots;
  const reversedAssembly = contentTest.assembleBatchFromGeneratedPhrases(
    validSlotPhrases(slotSubset).reverse(),
    'en',
    {},
    slotSubset
  );
  assert.deepStrictEqual(
    reversedAssembly.phrases.map((phrase) => phrase.text),
    slotSubset.map((slot, index) => `Concrete slot line ${index + 1}`),
    'final batch must restore expected slot order even if OpenAI response is reversed'
  );

  const assembled = contentTest.assembleBatchFromGeneratedPhrases(
    validSlotPhrases(slotSubset),
    'en',
    {},
    slotSubset
  );
  assert.strictEqual(assembled.generatedCount, BATCH_SIZE, 'valid slot-linked response must keep all phrases');
  assert.strictEqual(assembled.rejectedCount, 0);

  const partial = contentTest.assembleBatchFromGeneratedPhrases(
    [
      ...validSlotPhrases(slotSubset).slice(0, 10),
      { slot_id: slotSubset[10].slot_id, text: 'This is a question?', style_id: STYLE_IDS[10] },
      { slot_id: slotSubset[11].slot_id, text: 'Concrete surviving line', style_id: STYLE_IDS[11] },
    ],
    'en',
    {},
    slotSubset
  );
  assert.strictEqual(partial.generatedCount, 11, 'partial invalid response must preserve valid phrases');
  assert.strictEqual(partial.rejectionReasons.question, 1);
  assert.strictEqual(partial.fallbackFillCount, 1);
  assert.strictEqual(partial.phrases[10].slot_id, slotSubset[10].slot_id, 'middle slot fallback must stay in that slot position');
  assert.notStrictEqual(partial.phrases[10].text, 'This is a question?');
  assert.strictEqual(partial.phrases[9].text, 'Concrete slot line 10', 'valid phrase before rejected middle slot must not shift');
  assert.strictEqual(partial.phrases[11].text, 'Concrete surviving line', 'valid phrase after rejected middle slot must not shift');

  const morningSlots = planSlots({ ...baseInput, window: 'morning' }, { seed: 'morning-reject-seed' }).slots;
  const morningRejected = contentTest.assembleBatchFromGeneratedPhrases(
    [
      { slot_id: morningSlots[0].slot_id, text: 'Good morning?', style_id: STYLE_IDS[0] },
      ...validSlotPhrases(morningSlots).slice(1),
    ],
    'en',
    {},
    morningSlots
  );
  assert.strictEqual(morningRejected.phrases[0].slot_id, morningSlots[0].slot_id, 'rejected morning greeting fallback must remain first');
  // fallbackTextForSlot now rotates through 5 warm variants by calendar day
  // (see ANCHOR_FALLBACK_TEXT/currentFallbackSetIndex in contentGenerator.js)
  // rather than always returning the same single string, so this checks
  // "is it today's actual anchor variant", not a fixed substring.
  assert.strictEqual(
    morningRejected.phrases[0].text,
    contentTest.fallbackTextForSlot({ type: 'greeting_name' }, 'en'),
    'morning greeting fallback must be greeting-specific'
  );

  const nightSlots = planSlots({ ...baseInput, window: 'night' }, { seed: 'night-reject-seed' }).slots;
  const nightGenerated = validSlotPhrases(nightSlots);
  nightGenerated[nightGenerated.length - 1] = {
    slot_id: nightSlots[nightSlots.length - 1].slot_id,
    text: 'Good night?',
    style_id: STYLE_IDS[nightGenerated.length - 1],
  };
  const nightRejected = contentTest.assembleBatchFromGeneratedPhrases(nightGenerated, 'en', {}, nightSlots);
  assert.strictEqual(
    nightRejected.phrases[nightRejected.phrases.length - 1].slot_id,
    nightSlots[nightSlots.length - 1].slot_id,
    'rejected night goodnight fallback must remain last'
  );
  assert.strictEqual(
    nightRejected.phrases[nightRejected.phrases.length - 1].text,
    contentTest.fallbackTextForSlot({ type: 'goodnight_care' }, 'en'),
    'night fallback must be goodnight-specific'
  );

  const badSlotIds = contentTest.assembleBatchFromGeneratedPhrases(
    [
      ...validSlotPhrases(slotSubset).slice(0, 10),
      { slot_id: 'missing-slot', text: 'Concrete invalid slot line', style_id: STYLE_IDS[10] },
      { text: 'Concrete absent slot line', style_id: STYLE_IDS[11] },
    ],
    'en',
    {},
    slotSubset
  );
  assert.strictEqual(badSlotIds.rejectionReasons.slot_id, 2, 'invalid/missing slot_id must be rejected');
  assert.strictEqual(badSlotIds.generatedCount, 10);

  const sparseCreativeOnly = planSlots({
    device: { device_id: 'creative-only-device' },
    window: 'day',
    dateContext: null,
    weather: null,
    bankItems: [],
  }, { seed: 'creative-only-seed' });
  const sparseCreativeOnlyAgain = planSlots({
    device: { device_id: 'creative-only-device' },
    window: 'day',
    dateContext: null,
    weather: null,
    bankItems: [],
  }, { seed: 'creative-only-seed' });
  const sparseCounts = slotTypeCounts(sparseCreativeOnly.slots);
  assert.strictEqual(sparseCreativeOnly.slots.length, BATCH_SIZE, 'empty-input planner must still return exactly 12 slots');
  assertFactualSlotsAreGrounded(sparseCreativeOnly.slots);
  // With only the 4 creative synthetic types available (day window, no
  // weather/bank/telemetry/recall at all) and each capped at 1-2
  // (TYPE_CAPS), the normal per-type caps alone can only ever cover 5 of
  // the 12 required slots -- selectNonMandatory's capsExhausted escape
  // hatch (see its own comment in slotPlanner.js) is expected to kick in
  // here and exceed the normal caps rather than return fewer than 12
  // slots. The hard invariant that still must hold is exactly 12 total and
  // no dead/removed poetic type ever appearing (structurally impossible
  // now -- they are not in CONTENT_TYPES at all).
  assert((sparseCounts.get('everyday_lifehack') || 0) > 0, 'empty-input planner must include practical lifehack slots');
  assert(
    !sparseCreativeOnly.slots.some((slot) => ['tiny_imagined_scene', 'playful_thought', 'language_play', 'reflective_observation', 'everyday_observation'].includes(slot.type)),
    'creative fallback strategy must avoid poetic/imaginative filler types (structurally impossible: not in CONTENT_TYPES)'
  );
  assert.deepStrictEqual(sparseCreativeOnly.slots, sparseCreativeOnlyAgain.slots, 'empty-input planner must be deterministic for the same seed');
  assert.deepStrictEqual(
    sparseCreativeOnly.slots.map((slot) => slot.id),
    sparseCreativeOnlyAgain.slots.map((slot) => slot.id),
    'creative filler IDs must be stable across independent planning calls'
  );

  const weatherSlots = planSlots(baseInput, { seed: 'weather-constraint-seed' }).slots;
  const weatherSlot = weatherSlots.find((slot) => slot.type === 'weather_lifehack');
  assert(weatherSlot, 'planner should include weather slot when weather facts are available');
  assert(weatherSlot.constraints.includes('do_not_state_exact_temperature'), 'weather slot must explicitly forbid exact temperature output');
  assert(/без точных градусов/i.test(contentTest.buildSystemPrompt('en')), 'prompt must forbid exact weather temperature output');

  // 7: the static/cached system prompt must explicitly forbid revealing the
  // interest_hint personalization mechanism to the user.
  const systemPromptText = contentTest.buildSystemPrompt('en');
  assert(/interest_hint/i.test(systemPromptText), 'system prompt must document interest_hint semantics');
  assert(/незаметно/i.test(systemPromptText), 'system prompt must require invisible personalization');
  assert(/since you like/i.test(systemPromptText), 'system prompt must explicitly forbid profile-revealing phrasing like "since you like X"');
  assert(/выдуманные факты/i.test(systemPromptText), 'system prompt must forbid inventing facts/connections to satisfy an interest hint');

  const bankDate = getBankDateString();
  db.prepare(`
    INSERT INTO daily_content_bank (bank_date, category, content_text, tags)
    VALUES (?, ?, ?, ?)
  `).run(bankDate, 'fact', 'Selected science bank item.', JSON.stringify(['science', 'global']));
  db.prepare(`
    INSERT INTO daily_content_bank (bank_date, category, content_text, tags)
    VALUES (?, ?, ?, ?)
  `).run(bankDate, 'on_this_day', 'Unselected extra bank item that must not be sent wholesale.', JSON.stringify(['RU']));
  db.prepare('INSERT INTO devices (device_id, name, timezone, created_at) VALUES (?, ?, ?, ?)')
    .run('openai-slot-device', 'Aruzhan', 'Asia/Almaty', '2026-09-17 00:00:00');

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
                          text: `Concrete payload line ${index + 1}`,
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

  try {
    const result = await generateBatch(
      {
        device_id: 'openai-slot-device',
        name: 'Aruzhan',
        timezone: 'Asia/Almaty',
        created_at: '2026-09-17 00:00:00',
        interests: JSON.stringify(['work']),
        personal_goal: 'productivity',
        tone: 'humorous',
      },
      'morning',
      {
        system_language: 'en',
        battery_level: 73,
        ambient_light: 15.5,
        screen_on_duration_seconds: 83,
        unlocks_since_last_batch: 65,
        steps_since_last_batch: 4217,
      },
      { countryCode: 'KZ', city: 'Almaty', temperatureC: 12, description: 'rain' },
      { unlocks_vs_yesterday: 'higher' }
    );

    assert.strictEqual(openAiCallCount, 1, 'normal batch generation must make exactly one OpenAI call');
    assert.strictEqual(result.source, 'openai');
    assert.strictEqual(result.phrases.length, BATCH_SIZE);
    assert(!result.phrases.some((phrase) => Object.prototype.hasOwnProperty.call(phrase, 'slot_id')), 'public API phrases must not expose slot_id');

    const payload = JSON.parse(capturedRequest.messages[1].content);
    assert.strictEqual(payload.slots.length, BATCH_SIZE, 'OpenAI payload must contain only selected slots');
    assert(!JSON.stringify(payload).includes('Unselected extra bank item'), 'OpenAI payload must not include the whole candidate pool/bank');
    assert(!('personal_goal' in (payload.profile || {})), 'OpenAI payload must not include personal_goal');
    assert(!('tone' in (payload.profile || {})), 'OpenAI payload must not include tone');
    assert(!('interests' in (payload.profile || {})), 'OpenAI payload must not include the full interests list as a profile field');
    const payloadText = JSON.stringify(payload);
    // Interests personalization (this device has interests: ['work']) must
    // stay compact and bounded: the interest id MAY appear, but only inside
    // a small number of per-slot interest_hint fields (see the interests-
    // personalization section above for the full mechanism) -- never as a
    // verbose profile field, and never redundantly attached to every slot.
    const interestHintCount = (payloadText.match(/"interest_hint":/g) || []).length;
    assert(
      interestHintCount <= plannerTest.MAX_INTEREST_AWARE_SLOTS,
      `interest_hint must appear on at most ${plannerTest.MAX_INTEREST_AWARE_SLOTS} slots, found ${interestHintCount}`
    );
    for (const slot of payload.slots) {
      if ('interest_hint' in slot) {
        assert.strictEqual(slot.interest_hint, 'work', 'this device only selected the "work" interest, so any hint present must be exactly that id');
      }
    }
    for (const rawKey of [
      'battery_level',
      'ambient_light',
      'screen_on_duration_seconds',
      'unlocks_since_last_batch',
      'steps_since_last_batch',
    ]) {
      assert(!payloadText.includes(rawKey), `OpenAI payload must not include raw telemetry key: ${rawKey}`);
    }
    for (const rawValue of ['73', '15.5', '83', '65', '4217']) {
      assert(!payloadText.includes(rawValue), `OpenAI payload must not include raw telemetry value: ${rawValue}`);
    }
  } finally {
    Module._load = originalLoad;
    delete process.env.OPENAI_API_KEY;
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
