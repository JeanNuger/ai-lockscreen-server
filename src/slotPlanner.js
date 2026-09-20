const { BATCH_SIZE } = require('./constants');

const CONTENT_TYPES = [
  'greeting',
  'weather',
  'holiday',
  'history_today',
  'science',
  'country_fact',
  'word_learning',
  'learning_recall',
  'foreign_word_or_expression',
  'humor',
  'everyday_lifehack',
  'technology',
  'money_economics',
  'culture',
  'unusual_fact',
  'riddle',
  'everyday_observation',
  'playful_thought',
  'tiny_imagined_scene',
  'reflective_observation',
  'language_play',
  'good_news',
  'seasonal',
  'phone_trend',
  'personal_context',
  'age_context',
  'gender_context',
  'city_event',
  'free_ai_thought',
  'goodnight',
];

const FACTUAL_TYPES = new Set([
  'weather',
  'holiday',
  'history_today',
  'science',
  'country_fact',
  'word_learning',
  'learning_recall',
  'foreign_word_or_expression',
  'technology',
  'money_economics',
  'culture',
  'unusual_fact',
  'good_news',
  'phone_trend',
  'age_context',
  'gender_context',
  'city_event',
]);

const SYNTHETIC_POOL = [
  {
    id: 'synthetic_free_ai_thought_1',
    type: 'free_ai_thought',
    priority: 45,
    facts: {},
    source: 'creative',
    constraints: ['standalone_observation', 'no_user_facts'],
  },
  {
    id: 'synthetic_free_ai_thought_2',
    type: 'free_ai_thought',
    priority: 38,
    facts: {},
    source: 'creative',
    constraints: ['brief_unexpected_observation', 'no_user_facts'],
  },
  {
    id: 'synthetic_free_ai_thought_3',
    type: 'free_ai_thought',
    priority: 31,
    facts: {},
    source: 'creative',
    constraints: ['tiny_everyday_observation', 'no_user_facts'],
  },
  {
    id: 'synthetic_humor_1',
    type: 'humor',
    priority: 34,
    facts: {},
    source: 'creative',
    constraints: ['situational_not_mocking', 'localize_naturally'],
  },
  {
    id: 'synthetic_humor_2',
    type: 'humor',
    priority: 26,
    facts: {},
    source: 'creative',
    constraints: ['gentle_observational_humor', 'no_user_facts'],
  },
  {
    id: 'synthetic_everyday_lifehack_1',
    type: 'everyday_lifehack',
    priority: 33,
    facts: {},
    source: 'creative',
    constraints: ['practical_household_or_style_tip', 'one_sentence', 'no_command_tone'],
  },
  {
    id: 'synthetic_riddle_1',
    type: 'riddle',
    priority: 20,
    facts: {},
    source: 'creative',
    constraints: ['no_answer_required', 'not_a_question'],
  },
  {
    id: 'synthetic_riddle_2',
    type: 'riddle',
    priority: 17,
    facts: {},
    source: 'creative',
    constraints: ['answer_embedded_or_implied', 'not_a_question'],
  },
  {
    id: 'synthetic_everyday_observation_1',
    type: 'everyday_observation',
    priority: 29,
    facts: {},
    source: 'creative',
    constraints: ['ordinary_object_or_routine', 'no_user_facts', 'no_physical_context_claims'],
  },
  {
    id: 'synthetic_playful_thought_1',
    type: 'playful_thought',
    priority: 27,
    facts: {},
    source: 'creative',
    constraints: ['lightly_playful', 'no_external_facts', 'not_motivational'],
  },
  {
    id: 'synthetic_tiny_imagined_scene_1',
    type: 'tiny_imagined_scene',
    priority: 24,
    facts: {},
    source: 'creative',
    constraints: ['clearly_imagined', 'no_user_or_location_assumptions', 'one_sentence'],
  },
  {
    id: 'synthetic_reflective_observation_1',
    type: 'reflective_observation',
    priority: 21,
    facts: {},
    source: 'creative',
    constraints: ['no_question', 'no_advice', 'no_therapy_language'],
  },
  {
    id: 'synthetic_language_play_1',
    type: 'language_play',
    priority: 15,
    facts: {},
    source: 'creative',
    constraints: ['only_if_natural_in_target_language', 'no_required_answer', 'avoid_untranslatable_puns'],
  },
];

const TYPE_CAPS = {
  riddle: 1,
  humor: 2,
  free_ai_thought: 2,
  phone_trend: 1,
  learning_recall: 1,
};

const DEFAULT_TYPE_CAP = 2;

const CREATIVE_FILLER_BLUEPRINTS = [
  { id: 'creative_filler_free_ai_thought_standalone_v1', type: 'free_ai_thought', constraints: ['standalone_observation', 'no_user_facts'] },
  { id: 'creative_filler_humor_gentle_observational_v1', type: 'humor', constraints: ['gentle_observational_humor', 'no_user_facts'] },
  { id: 'creative_filler_everyday_lifehack_v1', type: 'everyday_lifehack', constraints: ['practical_household_or_style_tip', 'one_sentence', 'no_command_tone'] },
  { id: 'creative_filler_riddle_no_answer_v1', type: 'riddle', constraints: ['no_answer_required', 'not_a_question'] },
  { id: 'creative_filler_everyday_object_v1', type: 'everyday_observation', constraints: ['ordinary_object_or_routine', 'no_user_facts', 'no_physical_context_claims'] },
  { id: 'creative_filler_playful_light_v1', type: 'playful_thought', constraints: ['lightly_playful', 'no_external_facts', 'not_motivational'] },
  { id: 'creative_filler_tiny_scene_v1', type: 'tiny_imagined_scene', constraints: ['clearly_imagined', 'no_user_or_location_assumptions', 'one_sentence'] },
  { id: 'creative_filler_reflective_observation_v1', type: 'reflective_observation', constraints: ['no_question', 'no_advice', 'no_therapy_language'] },
  { id: 'creative_filler_language_play_v1', type: 'language_play', constraints: ['only_if_natural_in_target_language', 'no_required_answer', 'avoid_untranslatable_puns'] },
];

const CONTENT_MEMORY_EXEMPT_TYPES = new Set([
  'greeting',
  'goodnight',
  'weather',
  'seasonal',
  'phone_trend',
  'age_context',
  'gender_context',
]);

function hashString(input) {
  let hash = 2166136261;
  const value = String(input || '');
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRng(seed) {
  let state = hashString(seed) || 1;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    state >>>= 0;
    return state / 4294967296;
  };
}

function shuffle(items, rng) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function stableCandidateId(prefix, text) {
  return `${prefix}_${hashString(text).toString(36)}`;
}

function createCandidate(candidate) {
  const id = candidate.id;
  return {
    id,
    content_key: candidate.content_key || id,
    topic_key: candidate.topic_key || null,
    type: CONTENT_TYPES.includes(candidate.type) ? candidate.type : 'unusual_fact',
    priority: Number.isFinite(candidate.priority) ? candidate.priority : 10,
    facts: candidate.facts || {},
    source: candidate.source || 'editorial',
    eligibility: candidate.eligibility || {},
    cooldown: candidate.cooldown || {},
    constraints: Array.isArray(candidate.constraints) ? candidate.constraints : [],
    group: candidate.group || null,
    bank_category: candidate.bank_category || null,
    // Server-only reference to a device_learning_memory row (Phase 4 recall).
    // Never included in the OpenAI payload (see addSlotIds/buildContextPrompt) --
    // used only by the post-generation hook to mark the right row recalled.
    learning_memory_id: Number.isFinite(candidate.learning_memory_id) ? candidate.learning_memory_id : null,
  };
}

function mapBankItemType(item) {
  if (!item || typeof item.category !== 'string') {
    return 'unusual_fact';
  }
  if (item.category === 'holiday') return 'holiday';
  if (item.category === 'on_this_day') return 'history_today';
  if (item.category === 'humor') return 'humor';
  // idiom bank items are already a self-contained "word/expression + meaning"
  // piece of content -- the server-selected word_learning grounding, not a
  // separate content source. foreign_word_or_expression currently has no
  // other bank category feeding it (accepted trade-off, see HANDOFF_2 Phase 4).
  if (item.category === 'idiom') return 'word_learning';
  if (item.category === 'statistic') return 'unusual_fact';
  if (item.category === 'quote') return 'culture';
  // Direct, deterministic mapping as of Phase 5 -- the Daily Bank source
  // (generateDailyBank's prompt, see dailyContentBank.js) now owns choosing
  // the precise category itself; SlotPlanner only validates/maps it, no
  // longer infers it from content_text/tags keywords.
  if (item.category === 'science') return 'science';
  if (item.category === 'technology') return 'technology';
  if (item.category === 'economics') return 'money_economics';
  if (item.category === 'fact') return 'unusual_fact';
  // country_fact/good_news added in the same direct-mapping style, no
  // keyword inference (see HANDOFF_2 content-diversity follow-up).
  if (item.category === 'country_fact') return 'country_fact';
  if (item.category === 'good_news') return 'good_news';
  return 'unusual_fact';
}

// Deterministic, cheap (no embeddings/fuzzy matching) text normalization for
// Daily Bank topic_key generation -- two renderings of the same underlying
// fact that differ only in case, spacing, or trailing/embedded punctuation
// ("The Moon is moving away from Earth." vs "...Earth!" vs "...Earth") must
// collapse to the same topic_key, since a fresh OpenAI-web-search bank
// generation on a later day has no reason to reproduce the exact same
// punctuation. NFKC first so visually/semantically equivalent Unicode
// sequences (full-width vs half-width forms, composed vs decomposed
// accents) compare equal before case-folding. Strips Unicode punctuation
// (\p{P}, e.g. . ! ? , " « ») and symbols (\p{S}, e.g. $ + =) rather than
// an ASCII-only blacklist, since bank content is multi-language (ru, zh,
// ja, ar, etc. punctuation is not ASCII) -- \p{L}/\p{N}/\p{M} (letters,
// numbers, combining marks) and whitespace are deliberately left untouched
// so every language's actual word characters survive intact.
function normalizeTextForTopicKey(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bankItemToCandidate(item, index = 0) {
  const text = item && typeof item.content_text === 'string' ? item.content_text.trim() : '';
  if (!text) {
    return null;
  }
  const type = mapBankItemType(item);
  // content_key uses item.id (daily_content_bank's own row id) when available,
  // which is unique to that one row -- daily_content_bank rows are always
  // freshly INSERTed per bank_date (see dailyContentBank.js), so item.id never
  // repeats across different days even for the exact same fact text. That
  // makes content_key alone useless for cross-day repeat detection of bank
  // facts specifically -- topic_key is a separate, content-derived hash (same
  // formula the old id used to be, pre-content_memory) that DOES match across
  // days when the underlying fact text repeats, independent of which row id
  // carried it this time. See normalizeTextForTopicKey for why punctuation/
  // case/whitespace differences must not defeat the match.
  const normalizedText = normalizeTextForTopicKey(text);
  return createCandidate({
    id: item && item.id ? `bank_${item.id}` : stableCandidateId(`bank_${type}`, text),
    topic_key: stableCandidateId(`bank_topic_${type}`, normalizedText),
    type,
    priority: type === 'holiday' || type === 'history_today'
      ? 70
      : type === 'word_learning'
        ? 78
        : 48,
    // word_learning's facts.word must carry the server-selected word/expression
    // itself (Server = WHAT, OpenAI = HOW) -- the idiom bank item's
    // content_text already IS that self-contained word+meaning, so it is
    // reused as-is rather than parsed down to a bare token (Phase 4 decision).
    facts: type === 'word_learning' ? { word: text } : { text },
    source: 'daily_bank',
    constraints: ['use_only_given_fact', 'date_stable', 'not_encyclopedia_card'],
    bank_category: item.category,
  });
}

function computeAge(birthDate, now = new Date()) {
  if (!birthDate) {
    return null;
  }
  const dob = new Date(birthDate);
  if (Number.isNaN(dob.getTime())) {
    return null;
  }
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDay = (now.getUTCMonth() - dob.getUTCMonth()) || (now.getUTCDate() - dob.getUTCDate());
  if (monthDay < 0) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}

const PHONE_TREND_KEYS = new Set([
  'unlocks_vs_yesterday',
  'steps_vs_yesterday',
]);
const PHONE_TREND_VALUES = new Set(['higher', 'lower']);

function normalizePhoneTrends(phoneTrends = {}) {
  const normalized = {};
  if (!phoneTrends || typeof phoneTrends !== 'object' || Array.isArray(phoneTrends)) {
    return normalized;
  }
  for (const [key, value] of Object.entries(phoneTrends)) {
    if (PHONE_TREND_KEYS.has(key) && PHONE_TREND_VALUES.has(value)) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function collectCandidates(input = {}) {
  const candidates = [];
  const { device = {}, window, dateContext, weather, bankItems = [], phoneTrends = {}, recallCandidate = null } = input;
  const semanticPhoneTrends = normalizePhoneTrends(phoneTrends);

  if (window === 'morning') {
    const facts = {};
    if (device.name) facts.name = device.name;
    candidates.push(createCandidate({
      id: 'mandatory_morning_greeting',
      type: 'greeting',
      priority: 100,
      facts,
      source: 'editorial',
      constraints: ['warm', 'one_per_batch', 'no_fixed_template'],
    }));
  }

  if (window === 'night') {
    candidates.push(createCandidate({
      id: 'mandatory_night_goodnight',
      type: 'goodnight',
      priority: 100,
      facts: {},
      source: 'editorial',
      constraints: ['warm', 'calm', 'no_claim_user_is_sleeping'],
    }));
  }

  if (weather && typeof weather.temperatureC === 'number') {
    const facts = { temperature_c: Math.round(weather.temperatureC) };
    if (weather.city) facts.city = weather.city;
    if (weather.description) facts.condition = weather.description;
    candidates.push(createCandidate({
      id: 'weather_current_safe',
      type: 'weather',
      priority: 62,
      facts,
      source: 'weather',
      constraints: ['avoid_exact_right_now', 'safe_for_batch_delay', 'temperature_grounding_only', 'do_not_state_exact_temperature'],
    }));
  }

  const age = computeAge(device.birth_date);
  if (age !== null) {
    candidates.push(createCandidate({
      id: 'age_context_soft',
      type: 'age_context',
      priority: 15,
      facts: { age },
      source: 'profile',
      constraints: ['rare', 'avoid_stereotypes'],
    }));
  }

  if (device.gender) {
    candidates.push(createCandidate({
      id: 'gender_context_soft',
      type: 'gender_context',
      priority: 8,
      facts: { gender: device.gender },
      source: 'profile',
      constraints: ['rare', 'only_if_naturally_relevant', 'avoid_stereotypes'],
    }));
  }

  if (Object.keys(semanticPhoneTrends).length > 0) {
    candidates.push(createCandidate({
      id: 'phone_trend_semantic',
      type: 'phone_trend',
      priority: 28,
      facts: semanticPhoneTrends,
      source: 'phone_analytics',
      constraints: ['non_moralizing', 'no_exact_counts', 'no_psychological_claims', 'no_productivity_or_addiction_framing', 'no_causal_claims'],
    }));
  }

  // recallCandidate is resolved by the caller (learningMemory.getRecallCandidate)
  // before planSlots runs, same pattern as bankItems/recentContentMemory --
  // keeps this module DB-free. Only ever one candidate (or none): a word can
  // be recalled at most once, so there is nothing to rank among here.
  if (recallCandidate && recallCandidate.word_text) {
    candidates.push(createCandidate({
      id: `learning_recall_${recallCandidate.id}`,
      content_key: `learning_recall_${recallCandidate.id}`,
      topic_key: recallCandidate.word_key || null,
      type: 'learning_recall',
      priority: 30,
      facts: { word: recallCandidate.word_text },
      source: 'learning_memory',
      constraints: ['reference_previously_taught_word', 'no_new_fact_invention'],
      learning_memory_id: recallCandidate.id,
    }));
  }

  if (dateContext && dateContext.date) {
    candidates.push(createCandidate({
      id: 'seasonal_date_context',
      type: 'seasonal',
      priority: 18,
      facts: { date: dateContext.date, weekday: dateContext.weekday },
      source: 'date_context',
      constraints: ['date_stable', 'avoid_fake_holidays'],
    }));
  }

  for (let i = 0; i < bankItems.length; i++) {
    const candidate = bankItemToCandidate(bankItems[i], i);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  for (const candidate of SYNTHETIC_POOL) {
    candidates.push(createCandidate(candidate));
  }

  return candidates;
}

function buildRecentMemoryIndex(recentContentMemory = []) {
  const contentKeys = new Set();
  const topicKeys = new Set();
  if (!Array.isArray(recentContentMemory)) {
    return { contentKeys, topicKeys };
  }
  for (const item of recentContentMemory) {
    if (item && item.content_key) {
      contentKeys.add(item.content_key);
    }
    if (item && item.topic_key) {
      topicKeys.add(item.topic_key);
    }
  }
  return { contentKeys, topicKeys };
}

function antiRepeatPenalty(candidate, memoryIndex) {
  if (!candidate || CONTENT_MEMORY_EXEMPT_TYPES.has(candidate.type)) {
    return 0;
  }
  let penalty = 0;
  if (candidate.content_key && memoryIndex.contentKeys.has(candidate.content_key)) {
    penalty += 45;
  }
  if (candidate.topic_key && memoryIndex.topicKeys.has(candidate.topic_key)) {
    penalty += 18;
  }
  return penalty;
}

// Interests personalization (server-selects WHAT gets an interest angle,
// OpenAI only handles HOW -- same "Server = WHAT, OpenAI = HOW" split as the
// rest of this file). Deliberately NOT a selection-time score nudge (an
// earlier version of this file did that, and was replaced): a score boost
// can only make a slot MORE LIKELY to be picked, it can never guarantee the
// generated text is actually about the interest, because OpenAI never
// received the interest at all. Instead: run the exact same, completely
// unmodified candidate selection as always (this is what keeps interests
// fully subordinate to mandatory slots/learning recall/anti-repeat/country
// eligibility/factual grounding/Daily Bank freshness/type caps -- nothing
// here can touch WHICH candidates get chosen), then, only after the 12
// slots are already final, tag at most MAX_INTEREST_AWARE_SLOTS of them
// with a compact interest_hint that DOES reach the OpenAI payload for just
// those slots (see buildContextPrompt in contentGenerator.js and the static
// prompt instruction in buildSystemPrompt). See HANDOFF_2 interests
// personalization follow-up.
//
// Android currently sends the first six stable ids below; the extra aliases
// let newer clients add practical topics (auto/tech/style) without another
// server migration. Each maps to one existing content type -- used here
// purely as a compatibility check ("is this already-selected slot's type a
// genuine fit for this interest"), never to invent or force a connection a
// slot's own facts don't support.
const INTEREST_TYPE_MAP = {
  sport: 'unusual_fact',
  auto: 'technology',
  cars: 'technology',
  technology: 'technology',
  tech: 'technology',
  style: 'everyday_lifehack',
  fashion: 'everyday_lifehack',
  work: 'money_economics',
  family: 'culture',
  self_development: 'science',
  mindfulness: 'reflective_observation',
  creative_arts: 'culture',
};

// Hard, structural cap on how many of the final BATCH_SIZE slots may ever
// carry an interest_hint -- "approximately 3-4 of 12, never the whole
// batch" enforced by construction (selectInterestAwareSlots below never
// assigns more than this many hints), not left to chance.
const MAX_INTEREST_AWARE_SLOTS = 4;

function parseDeviceInterests(rawInterests) {
  if (!rawInterests) {
    return [];
  }
  if (Array.isArray(rawInterests)) {
    return rawInterests
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  }
  try {
    const parsed = JSON.parse(rawInterests);
    return Array.isArray(parsed)
      ? parsed
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
      : [];
  } catch (err) {
    return [];
  }
}

// Picks which of the already-final slots (post-selection, post-type-caps,
// post-anti-repeat -- these slots are settled) get an interest_hint, and
// which interest each one represents. Returns a Map<slot.id, interest_id>.
//
// Distribution: walks the user's interests in Android's fixed send order,
// giving each a genuinely type-compatible, not-yet-used slot before any
// interest gets a second one -- so 2 selected interests with compatible
// slots available produce 2 different hints, not the same interest twice,
// while a single selected interest can still fill up to the cap if enough
// compatible slots exist. An interest with no type-compatible slot among
// the final 12 (e.g. its mapped type didn't get selected this batch, or
// none of the selected candidates of that type have facts that genuinely
// fit) is simply skipped for this batch -- never forced onto an unrelated
// slot.
function selectInterestAwareSlots(finalSlots, rawInterests) {
  const interests = parseDeviceInterests(rawInterests);
  const hints = new Map();
  if (interests.length === 0) {
    return hints;
  }

  const slotsByType = new Map();
  for (const slot of finalSlots) {
    if (!slotsByType.has(slot.type)) {
      slotsByType.set(slot.type, []);
    }
    slotsByType.get(slot.type).push(slot);
  }

  const used = new Set();
  const assignNextRound = () => {
    let assignedAny = false;
    for (const interest of interests) {
      if (hints.size >= MAX_INTEREST_AWARE_SLOTS) {
        return assignedAny;
      }
      const compatibleType = INTEREST_TYPE_MAP[interest];
      if (!compatibleType) {
        continue;
      }
      const candidates = slotsByType.get(compatibleType) || [];
      const pick = candidates.find((slot) => !used.has(slot.id));
      if (pick) {
        hints.set(pick.id, interest);
        used.add(pick.id);
        assignedAny = true;
      }
    }
    return assignedAny;
  };

  // Round 1 distributes one slot per distinct interest before round 2+
  // lets any interest take a second/third/fourth slot, up to the cap.
  while (hints.size < MAX_INTEREST_AWARE_SLOTS && assignNextRound()) {
    // loop continues until either the cap is hit or a full round assigns nothing
  }

  return hints;
}

function candidateWeight(candidate, rng, memoryIndex = buildRecentMemoryIndex()) {
  return candidate.priority + rng() * 20 - antiRepeatPenalty(candidate, memoryIndex);
}

function typeCap(type) {
  return TYPE_CAPS[type] || DEFAULT_TYPE_CAP;
}

function canAddType(typeCounts, type) {
  return (typeCounts.get(type) || 0) < typeCap(type);
}

function recordType(typeCounts, type) {
  typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
}

function selectNonMandatory(candidates, count, rng, memoryIndex = buildRecentMemoryIndex()) {
  const selected = [];
  const typeCounts = new Map();
  const shuffled = shuffle(candidates, rng)
    .map((candidate) => ({ candidate, score: candidateWeight(candidate, rng, memoryIndex) }))
    .sort((a, b) => b.score - a.score);

  for (const entry of shuffled) {
    if (selected.length >= count) {
      break;
    }
    const type = entry.candidate.type;
    if (!canAddType(typeCounts, type)) {
      continue;
    }
    selected.push(entry.candidate);
    recordType(typeCounts, type);
  }

  let fillerIndex = 0;
  while (selected.length < count) {
    const blueprint = CREATIVE_FILLER_BLUEPRINTS[fillerIndex % CREATIVE_FILLER_BLUEPRINTS.length];
    const blueprintUseIndex = Math.floor(fillerIndex / CREATIVE_FILLER_BLUEPRINTS.length) + 1;
    const type = blueprint.type;
    fillerIndex += 1;
    if (!canAddType(typeCounts, type)) {
      if (fillerIndex > CREATIVE_FILLER_BLUEPRINTS.length * (DEFAULT_TYPE_CAP + 2)) {
        break;
      }
      continue;
    }
    selected.push(createCandidate({
      id: `filler_${blueprint.id}_${blueprintUseIndex}`,
      type,
      priority: 1,
      facts: {},
      source: 'creative',
      constraints: blueprint.constraints,
    }));
    recordType(typeCounts, type);
  }

  return shuffle(selected, rng);
}

function addSlotIds(candidates) {
  return candidates.map((candidate, index) => ({
    slot_id: `s${index + 1}`,
    id: candidate.id,
    content_key: candidate.content_key || candidate.id,
    topic_key: candidate.topic_key || undefined,
    type: candidate.type,
    facts: candidate.facts,
    source: candidate.source,
    bank_category: candidate.bank_category || undefined,
    constraints: candidate.constraints,
    // Server-only; buildContextPrompt hand-picks {slot_id, type, facts,
    // constraints} for the OpenAI payload and does not include this field.
    learning_memory_id: candidate.learning_memory_id,
    // Set below, after selection, by selectInterestAwareSlots -- for the
    // vast majority of slots this stays undefined and is dropped entirely
    // by JSON.stringify, so a non-personalized slot's payload shape is
    // byte-identical to before interests personalization existed.
    interest_hint: undefined,
  }));
}

function planSlots(input = {}, options = {}) {
  const candidates = options.candidates || collectCandidates(input);
  const seed = options.seed || [
    input.device && input.device.device_id,
    input.window,
    input.dateContext && input.dateContext.date,
    input.dateContext && input.dateContext.time,
  ].filter(Boolean).join('|');
  const rng = options.rng || createSeededRng(seed || 'slot-planner');
  const memoryIndex = buildRecentMemoryIndex(options.recentContentMemory);

  const mandatoryFirst = input.window === 'morning'
    ? candidates.find((candidate) => candidate.type === 'greeting')
    : null;
  const mandatoryLast = input.window === 'night'
    ? candidates.find((candidate) => candidate.type === 'goodnight')
    : null;

  const mandatoryIds = new Set([mandatoryFirst, mandatoryLast].filter(Boolean).map((candidate) => candidate.id));
  const remainingCandidates = candidates.filter((candidate) => !mandatoryIds.has(candidate.id));
  const remainingCount = BATCH_SIZE - (mandatoryFirst ? 1 : 0) - (mandatoryLast ? 1 : 0);
  const middle = selectNonMandatory(remainingCandidates, remainingCount, rng, memoryIndex);

  const ordered = [];
  if (mandatoryFirst) ordered.push(mandatoryFirst);
  ordered.push(...middle);
  if (mandatoryLast) ordered.push(mandatoryLast);

  const slots = addSlotIds(ordered.slice(0, BATCH_SIZE));

  // Interest hints are assigned only now, after the 12 slots are already
  // final -- selection above ran completely unaware of interests, so
  // mandatory slots/learning recall/anti-repeat/country eligibility/
  // factual grounding/Daily Bank freshness/type caps were never at risk of
  // being overridden by personalization.
  const interestHints = selectInterestAwareSlots(slots, input.device && input.device.interests);
  for (const slot of slots) {
    const hint = interestHints.get(slot.id);
    if (hint) {
      slot.interest_hint = hint;
    }
  }

  return {
    candidates,
    slots,
  };
}

module.exports = {
  CONTENT_TYPES,
  FACTUAL_TYPES,
  collectCandidates,
  planSlots,
  createSeededRng,
  _test: {
    bankItemToCandidate,
    createCandidate,
    antiRepeatPenalty,
    mapBankItemType,
    normalizePhoneTrends,
    normalizeTextForTopicKey,
    parseDeviceInterests,
    selectInterestAwareSlots,
    candidateWeight,
    INTEREST_TYPE_MAP,
    MAX_INTEREST_AWARE_SLOTS,
  },
};
