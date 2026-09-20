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
      plannerTest.createCandidate({ id: 'recent-content', type: 'science', priority: 50, facts: { text: 'Recent' } }),
      { contentKeys: new Set(['recent-content']), topicKeys: new Set() }
    ),
    45,
    'recent content_key must receive an anti-repeat penalty'
  );
  assert.strictEqual(
    plannerTest.antiRepeatPenalty(
      plannerTest.createCandidate({ id: 'weather_current_safe', type: 'weather', priority: 50, facts: { temperature_c: 20 } }),
      { contentKeys: new Set(['weather_current_safe']), topicKeys: new Set() }
    ),
    0,
    'contextual weather content must not receive normal content cooldown'
  );

  // Uses type: 'riddle' (TYPE_CAPS.riddle = 1) rather than 'science' (default
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
    recentContentMemory: [{ content_key: 'recent_riddle' }],
    candidates: [
      plannerTest.createCandidate({ id: 'recent_riddle', type: 'riddle', priority: 50, facts: { text: 'recent' } }),
      plannerTest.createCandidate({ id: 'fresh_riddle', type: 'riddle', priority: 50, facts: { text: 'fresh' } }),
    ],
  });
  const riddleSlots = freshVsRecent.slots.filter((slot) => slot.type === 'riddle');
  assert.strictEqual(riddleSlots.length, 1, 'riddle type cap (1) must still apply with anti-repeat candidates present');
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
      type: index % 2 === 0 ? 'science' : 'technology',
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
      plannerTest.createCandidate({ ...bankCandidateDay2, type: 'riddle' }),
      plannerTest.createCandidate({ id: 'unrelated_fresh_riddle', type: 'riddle', priority: 50, facts: { text: 'fresh' } }),
    ],
  });
  const topicRiddleSlots = freshVsRecentTopic.slots.filter((slot) => slot.type === 'riddle');
  assert.strictEqual(topicRiddleSlots.length, 1, 'riddle type cap must still apply in the topic_key scenario');
  assert.strictEqual(topicRiddleSlots[0].id, 'unrelated_fresh_riddle', 'topic_key match on a DIFFERENT content_key/row id must still lose the capped slot to genuinely fresh content');

  const morning = planSlots({ ...baseInput, window: 'morning' }, { seed: 'morning-seed' });
  assert.strictEqual(morning.slots[0].type, 'greeting', 'morning first slot must be greeting');

  const night = planSlots({ ...baseInput, window: 'night' }, { seed: 'night-seed' });
  assert.strictEqual(night.slots[night.slots.length - 1].type, 'goodnight', 'night last slot must be goodnight');

  const noLegacyProfileInput = {
    ...baseInput,
    device: { device_id: 'planner-device', name: 'Aruzhan', birth_date: '1995-05-20', gender: 'female' },
  };
  assert.deepStrictEqual(
    planSlots(baseInput, { seed: 'legacy-profile-seed' }).slots,
    planSlots(noLegacyProfileInput, { seed: 'legacy-profile-seed' }).slots,
    'planner must not depend on personal_goal/tone/interests'
  );

  const candidates = collectCandidates(baseInput);
  assert(candidates.some((candidate) => candidate.source === 'daily_bank' && candidate.type === 'history_today'), 'on_this_day bank item must become history_today candidate');
  assert(candidates.some((candidate) => candidate.source === 'daily_bank' && candidate.type === 'science'), 'a science-category bank item must become a science candidate (Phase 5: direct mapping, not keyword inference)');

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
    assert(count <= 2, `planner must avoid excessive concentration of one type: ${type}=${count}`);
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
  assert.strictEqual(bankCandidate.type, 'holiday');
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
  assert(/^Good morning\./.test(morningRejected.phrases[0].text), 'morning greeting fallback must be greeting-specific');

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
  assert(/^Good night\./.test(nightRejected.phrases[nightRejected.phrases.length - 1].text), 'night fallback must be goodnight-specific');

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
  assert((sparseCounts.get('riddle') || 0) <= 1, 'empty-input planner must cap riddle at 1');
  assert((sparseCounts.get('humor') || 0) <= 2, 'empty-input planner must cap humor at 2');
  assert((sparseCounts.get('free_ai_thought') || 0) <= 2, 'empty-input planner must cap free_ai_thought at 2');
  assert(
    new Set(sparseCreativeOnly.slots.map((slot) => slot.type)).size >= 6,
    'creative fallback strategy must include enough different non-factual intents'
  );
  assert.deepStrictEqual(sparseCreativeOnly.slots, sparseCreativeOnlyAgain.slots, 'empty-input planner must be deterministic for the same seed');
  assert.deepStrictEqual(
    sparseCreativeOnly.slots.map((slot) => slot.id),
    sparseCreativeOnlyAgain.slots.map((slot) => slot.id),
    'creative filler IDs must be stable across independent planning calls'
  );

  const weatherSlots = planSlots(baseInput, { seed: 'weather-constraint-seed' }).slots;
  const weatherSlot = weatherSlots.find((slot) => slot.type === 'weather');
  assert(weatherSlot, 'planner should include weather slot when weather facts are available');
  assert(weatherSlot.constraints.includes('do_not_state_exact_temperature'), 'weather slot must explicitly forbid exact temperature output');
  assert(/never state exact temperature/i.test(contentTest.buildSystemPrompt('en')), 'prompt must forbid exact weather temperature output');

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
    assert(!('interests' in (payload.profile || {})), 'OpenAI payload must not include interests');
    const payloadText = JSON.stringify(payload);
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
