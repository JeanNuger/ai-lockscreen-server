const { BATCH_SIZE } = require('./constants');

// Rebuilt content matrix (see HANDOFF_2 "kind/smart/attentive companion"
// rebuild, task dated after commit 82ce638): mandatory named anchors
// (greeting_name/goodnight_care), a telemetry-reaction type (context_signal),
// and a leaner, less lifehack-dominated creative pool. Dead poetic types
// (playful_thought/tiny_imagined_scene/reflective_observation/language_play/
// everyday_observation) and never-implemented types (personal_context,
// foreign_word_or_expression, the old city_event) are removed outright
// rather than kept as unreachable declarations -- createCandidate below
// silently coerces any candidate.type not in this list to 'unusual_fact',
// so a stale/removed type name would otherwise fail quietly instead of
// loudly.
const CONTENT_TYPES = [
  'greeting_name',
  'goodnight_care',
  'weather_lifehack',
  'context_signal',
  'holiday_today',
  'history_today',
  'word_learning',
  'learning_recall',
  'science_tech',
  'money_economics',
  'unusual_fact',
  'country_fact',
  'good_news',
  'city_afisha',
  'everyday_lifehack',
  'smart_humor_observation',
  'free_ai_thought',
  'culture',
  'seasonal',
  'phone_trend',
  'age_context',
];

// Per-type length hint, sent to OpenAI alongside each slot (see
// buildContextPrompt in contentGenerator.js) so the model can vary how much
// it says per slot instead of writing all 12 phrases at the same ultra-short
// length. 'short' (~10-20 chars) / 'medium' (~21-40 chars) are rough ranges;
// 'long' (~41-60 chars) is a PERMISSION to say more when the content genuinely
// earns it, never an instruction to pad a finished thought -- see
// buildSystemPrompt's own explanation of these ranges. None of this is a hard
// cap: the only hard cap is LOCK_SCREEN_TEXT_MAX_LENGTH (70), enforced
// separately by validateFinalBatch/the JSON schema regardless of hint.
// Chosen per type by what genuinely benefits from more room (history_today/
// word_learning/science_tech/country_fact/good_news/money_economics/
// unusual_fact/culture carry a real fact worth spelling out) vs. what should
// stay punchy (greeting_name/goodnight_care/smart_humor_observation) vs.
// everything else defaulting to medium. This alone is what gives a batch
// natural length variety across its 12 slots -- BATCH_SIZE slots are drawn
// from a mix of types already (TYPE_CAPS/the competitive lottery), so a
// mostly-fixed per-type hint mix naturally yields a mix of short/medium/long
// without any extra "exactly N short" selection logic; the system prompt
// additionally asks the model to keep long a minority of the batch even when
// several long-hinted slots are present, since the type mix alone can't
// guarantee that count on every batch.
const TYPE_LENGTH_HINTS = {
  greeting_name: 'short',
  goodnight_care: 'short',
  smart_humor_observation: 'short',
  weather_lifehack: 'medium',
  holiday_today: 'medium',
  free_ai_thought: 'medium',
  context_signal: 'medium',
  age_context: 'medium',
  phone_trend: 'medium',
  seasonal: 'medium',
  everyday_lifehack: 'medium',
  city_afisha: 'medium',
  learning_recall: 'medium',
  history_today: 'long',
  word_learning: 'long',
  science_tech: 'long',
  country_fact: 'long',
  good_news: 'long',
  money_economics: 'long',
  unusual_fact: 'long',
  culture: 'long',
};

function lengthHintForType(type) {
  return TYPE_LENGTH_HINTS[type] || 'medium';
}

const FACTUAL_TYPES = new Set([
  'weather_lifehack',
  'context_signal',
  'holiday_today',
  'history_today',
  'word_learning',
  'learning_recall',
  'science_tech',
  'money_economics',
  'unusual_fact',
  'country_fact',
  'good_news',
  'phone_trend',
  'age_context',
]);

// Creative (non-factual) synthetic candidates -- always available regardless
// of weather/bank/telemetry, so the planner can still complete a batch on a
// 'day' window with a bare-minimum device. Kept to 4 distinct types (see
// TYPE_CAPS below for why each is capped low) rather than the old wide
// poetic-leaning pool the "final purge" commit (2523b99) removed.
const SYNTHETIC_POOL = [
  {
    id: 'synthetic_free_ai_thought_1',
    type: 'free_ai_thought',
    priority: 45,
    facts: {},
    source: 'creative',
    constraints: ['practical_neutral_observation', 'no_user_facts', 'no_poetry'],
  },
  {
    id: 'synthetic_free_ai_thought_2',
    type: 'free_ai_thought',
    priority: 38,
    facts: {},
    source: 'creative',
    constraints: ['useful_everyday_observation', 'no_user_facts', 'no_poetry'],
  },
  {
    id: 'synthetic_free_ai_thought_3',
    type: 'free_ai_thought',
    priority: 31,
    facts: {},
    source: 'creative',
    constraints: ['tiny_practical_observation', 'no_user_facts', 'no_poetry'],
  },
  {
    id: 'synthetic_everyday_lifehack_1',
    type: 'everyday_lifehack',
    priority: 30,
    facts: {},
    source: 'creative',
    constraints: ['practical_household_or_style_tip', 'one_sentence', 'no_command_tone', 'no_poetry'],
  },
  {
    id: 'synthetic_everyday_lifehack_2',
    type: 'everyday_lifehack',
    priority: 24,
    facts: {},
    source: 'creative',
    constraints: ['practical_phone_or_commute_tip', 'one_sentence', 'no_command_tone', 'no_poetry'],
  },
  {
    id: 'synthetic_smart_humor_1',
    type: 'smart_humor_observation',
    priority: 28,
    facts: {},
    source: 'creative',
    constraints: ['ironic_everyday_observation', 'no_anecdote', 'no_mocking', 'one_sentence'],
  },
  {
    id: 'synthetic_smart_humor_2',
    type: 'smart_humor_observation',
    priority: 22,
    facts: {},
    source: 'creative',
    constraints: ['ironic_digital_life_observation', 'no_anecdote', 'no_mocking', 'one_sentence'],
  },
  {
    id: 'synthetic_city_afisha_1',
    type: 'city_afisha',
    priority: 16,
    facts: {},
    source: 'creative',
    // No fabricated event/film/exhibition names or dates -- there is no real
    // city-events data source wired up yet (see HANDOFF_2). Only general,
    // non-invented city-life/season observations are allowed.
    constraints: ['general_city_life_observation', 'season_appropriate', 'no_specific_event_names', 'no_fabricated_dates'],
  },
];

// Rare/one-off types (mandatory anchors, telemetry reaction) are capped at
// 1 so they stay a genuine accent, not a recurring bucket. The four
// "always available" creative types (smart_humor_observation/city_afisha/
// free_ai_thought/everyday_lifehack) are capped low but NOT at 1 each:
// with only these 4 types as guaranteed filler, a strict 1/1/1/1 (or the
// first attempt here, 1/1/1/2) sums to well under BATCH_SIZE whenever the
// real (weather/bank/telemetry) candidate pool is also sparse -- verified
// directly against the baseInput test fixture, which has only ~10
// selectable real+synthetic candidates once each singleton factual type
// (weather/age/history_today/science_tech/seasonal) is capped at 1 by
// having just 1 candidate -- that shortfall forced selectNonMandatory's
// capsExhausted escape hatch (see its own comment) to trigger even in a
// normally-populated batch, not just the genuinely-empty edge case it's
// meant for. 2/2/2/3 gives enough headroom to reach 12 from creative
// candidates alone without relying on that escape hatch in ordinary
// conditions, while still cutting everyday_lifehack down hard from the
// pre-rebuild TYPE_CAPS.everyday_lifehack = 8 (which is what let 7 of 12
// slots in a real batch turn into dry cable/container/pillow tips).
const TYPE_CAPS = {
  greeting_name: 1,
  goodnight_care: 1,
  context_signal: 1,
  smart_humor_observation: 2,
  city_afisha: 2,
  free_ai_thought: 2,
  everyday_lifehack: 3,
  phone_trend: 1,
  learning_recall: 1,
};

const DEFAULT_TYPE_CAP = 2;

// Window-aware fixed slots (product decision, see task history): morning
// positions 1-5 are a strict sequence -- greeting_name, weather_lifehack,
// holiday_today, history_today, word_learning, in that exact order -- not
// merely "guaranteed somewhere in the batch." Night's second-to-last slot is
// learning_recall (if a candidate exists) with goodnight_care fixed last, via
// the existing separate mandatory-last mechanism in planSlots. day/evening
// use neither: weather/holiday/history/word_learning are not even candidates
// outside morning (see isCandidateAllowedInWindow), so there is nothing left
// to guarantee for them.
//
// GUARANTEED_TYPES_BY_WINDOW is deliberately empty for every window right
// now: under this plan every type that would have gone here is already
// placed at a fixed position instead (fixedMorning/fixedNightRecall in
// planSlots), so a *separate* guaranteed-but-unordered reservation on top of
// that would double-count the same candidate pool against TYPE_CAPS. The
// mechanism (selectGuaranteedSlots/guaranteedTypesForWindow) is kept in
// place, not deleted, in case a future window needs a "guaranteed, but not a
// fixed position" category without reintroducing this same bug.
const MORNING_FIXED_TYPES = ['greeting_name', 'weather_lifehack', 'holiday_today', 'history_today', 'word_learning'];
const MORNING_ONLY_TYPES = new Set(['weather_lifehack', 'holiday_today', 'history_today', 'word_learning']);
const GUARANTEED_TYPES_BY_WINDOW = {
  morning: [],
  day: [],
  evening: [],
  night: [],
};

const CREATIVE_FILLER_BLUEPRINTS = [
  { id: 'creative_filler_everyday_lifehack_v1', type: 'everyday_lifehack', constraints: ['practical_household_or_style_tip', 'one_sentence', 'no_command_tone', 'no_poetry'] },
  { id: 'creative_filler_free_ai_thought_standalone_v1', type: 'free_ai_thought', constraints: ['practical_neutral_observation', 'no_user_facts', 'no_poetry'] },
  { id: 'creative_filler_smart_humor_v1', type: 'smart_humor_observation', constraints: ['ironic_everyday_observation', 'no_anecdote', 'no_mocking', 'one_sentence'] },
  { id: 'creative_filler_city_afisha_v1', type: 'city_afisha', constraints: ['general_city_life_observation', 'season_appropriate', 'no_specific_event_names', 'no_fabricated_dates'] },
];

const CONTENT_MEMORY_EXEMPT_TYPES = new Set([
  'greeting_name',
  'goodnight_care',
  'weather_lifehack',
  'context_signal',
  'seasonal',
  'phone_trend',
  'age_context',
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
  if (item.category === 'holiday') return 'holiday_today';
  if (item.category === 'on_this_day') return 'history_today';
  if (item.category === 'humor') return 'smart_humor_observation';
  // idiom bank items are already a self-contained "word/expression + meaning"
  // piece of content -- the server-selected word_learning grounding, not a
  // separate content source. foreign_word_or_expression currently has no
  // other bank category feeding it (accepted trade-off, see HANDOFF_2 Phase 4).
  if (item.category === 'idiom') return 'word_learning';
  if (item.category === 'statistic') return 'unusual_fact';
  if (item.category === 'quote') return 'culture';
  // science and technology bank categories both fold into one science_tech
  // content type (rebuild task) -- there was never a meaningfully different
  // prompt treatment between the two on the client side anyway.
  if (item.category === 'science') return 'science_tech';
  if (item.category === 'technology') return 'science_tech';
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
    priority: type === 'holiday_today' || type === 'history_today'
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

// Telemetry-reaction thresholds (context_signal). Battery/unlocks come
// straight from the per-request device signals (deviceSignals.js) -- NOT
// phoneAnalytics.js's 45-day trend aggregates, a separate, already-existing
// mechanism (phone_trend). Only a semantic flag ('low_battery'/
// 'many_unlocks'/'late_hour') ever becomes a candidate's facts -- the raw
// number is read here, in this function, and discarded; it is never stored
// on the candidate, so it can never reach the OpenAI payload (see
// contentGenerator.test's explicit "no raw telemetry key/value in payload"
// assertions, which this must keep satisfying).
const BATTERY_LOW_THRESHOLD = 20;
const MANY_UNLOCKS_THRESHOLD = 30;
const LATE_HOUR_START = 23;
const LATE_HOUR_END = 5;

function resolveContextSignal(signals, dateContext) {
  if (signals && typeof signals.battery_level === 'number' && signals.battery_level < BATTERY_LOW_THRESHOLD) {
    return 'low_battery';
  }
  if (signals && typeof signals.unlocks_since_last_batch === 'number' && signals.unlocks_since_last_batch > MANY_UNLOCKS_THRESHOLD) {
    return 'many_unlocks';
  }
  if (dateContext && typeof dateContext.time === 'string') {
    const hour = parseInt(dateContext.time.split(':')[0], 10);
    if (Number.isFinite(hour) && (hour >= LATE_HOUR_START || hour < LATE_HOUR_END)) {
      return 'late_hour';
    }
  }
  return null;
}

function collectCandidates(input = {}) {
  const candidates = [];
  const { device = {}, window, dateContext, weather, bankItems = [], phoneTrends = {}, recallCandidate = null, signals = {} } = input;
  const semanticPhoneTrends = normalizePhoneTrends(phoneTrends);

  if (window === 'morning') {
    const facts = {};
    if (device.name) facts.name = device.name;
    candidates.push(createCandidate({
      id: 'mandatory_morning_greeting',
      type: 'greeting_name',
      priority: 100,
      facts,
      source: 'editorial',
      constraints: ['warm', 'one_per_batch', 'no_fixed_template', 'name_if_known', 'light_send_off_for_the_day'],
    }));
  }

  if (window === 'night') {
    const facts = {};
    if (device.name) facts.name = device.name;
    candidates.push(createCandidate({
      id: 'mandatory_night_goodnight',
      type: 'goodnight_care',
      priority: 100,
      facts,
      source: 'editorial',
      constraints: ['warm', 'calm', 'no_claim_user_is_sleeping', 'name_if_known'],
    }));
  }

  if (window === 'morning' && weather && typeof weather.temperatureC === 'number') {
    const facts = { temperature_c: Math.round(weather.temperatureC) };
    if (weather.city) facts.city = weather.city;
    if (weather.description) facts.condition = weather.description;
    candidates.push(createCandidate({
      id: 'weather_current_safe',
      type: 'weather_lifehack',
      priority: 62,
      facts,
      source: 'weather',
      constraints: ['avoid_exact_right_now', 'safe_for_batch_delay', 'temperature_grounding_only', 'do_not_state_exact_temperature', 'no_digits', 'simple_clothing_umbrella_shoes_sun_advice'],
    }));
  }

  const contextSignal = resolveContextSignal(signals, dateContext);
  if (contextSignal) {
    candidates.push(createCandidate({
      id: `context_signal_${contextSignal}`,
      type: 'context_signal',
      priority: 40,
      facts: { signal: contextSignal },
      source: 'device_signal',
      constraints: ['no_exact_numbers', 'caring_not_alarming', 'no_medical_claims'],
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
  auto: 'science_tech',
  cars: 'science_tech',
  technology: 'science_tech',
  tech: 'science_tech',
  style: 'everyday_lifehack',
  fashion: 'everyday_lifehack',
  work: 'money_economics',
  family: 'culture',
  self_development: 'science_tech',
  mindfulness: 'culture',
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

// Gender-lean personalization (soft topic-weighting, product decision
// during the "kind companion" rebuild -- see task history): gender must
// stay "rare, careful, without stereotypes" (HANDOFF_2 §7's original rule).
// Implemented with EXACTLY the same post-selection-only philosophy as
// interest_hint above and for the identical reason: selection itself stays
// completely gender-blind (mandatory slots/anti-repeat/type caps/factual
// grounding can never be overridden by this), and at most ONE already-final
// slot -- never more -- gets tagged with a gender_lean_hint, only if a
// type-compatible slot already exists in this batch on its own merits.
// This makes "not exclusive, capped at 1 slot per batch" a structural
// guarantee, not a probabilistic one, and avoids the separate, more
// invasive alternative (nudging candidateWeight for every matching
// candidate) which could not cheaply guarantee the same hard cap.
const GENDER_LEAN_TYPE_MAP = {
  male: ['science_tech', 'unusual_fact', 'everyday_lifehack', 'money_economics'],
  female: ['everyday_lifehack', 'science_tech', 'culture'],
};

function normalizeGenderForLean(rawGender) {
  const value = typeof rawGender === 'string' ? rawGender.trim().toLowerCase() : '';
  return value === 'male' || value === 'female' ? value : null;
}

// Picks at most one already-selected, already-final slot whose type leans
// toward the device's gender. rng is the SAME seeded rng planSlots already
// uses for everything else, so which compatible slot (when more than one
// exists) gets the hint stays deterministic per seed, exactly like the rest
// of this module -- never Math.random() inside planSlots' own call path.
function selectGenderLeanSlot(finalSlots, rawGender, rng = Math.random) {
  const gender = normalizeGenderForLean(rawGender);
  if (!gender) {
    return null;
  }
  const leanTypes = GENDER_LEAN_TYPE_MAP[gender];
  const compatible = finalSlots.filter((slot) => leanTypes.includes(slot.type));
  if (compatible.length === 0) {
    return null;
  }
  const pick = compatible[Math.floor(rng() * compatible.length)];
  return { slotId: pick.id, gender };
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

// Picks at most one candidate per type in `types` -- the best-scored one
// (same candidateWeight formula as the lottery, so if a type somehow has more
// than one candidate the more relevant/fresher one wins the guaranteed slot,
// and any leftover of that type still gets a fair shot in the normal
// competitive round afterward). A type with zero candidates (no data for
// today/the device's local date) is simply skipped -- it falls back to
// competing normally rather than reserving an empty slot. Currently called
// with an empty `types` list for every window (see GUARANTEED_TYPES_BY_WINDOW's
// comment) -- kept generic/parameterized for a future window/type that needs
// this "guaranteed, unordered position" behavior without a fixed slot.
//
// `count` is a defensive cap, not an expected trigger: `types` can never
// realistically exceed the slots available. If it somehow did, sorting by
// priority descending before slicing keeps the highest-priority types and
// silently drops the rest back to the competitive pool instead of ever
// exceeding BATCH_SIZE.
function selectGuaranteedSlots(candidates, types, count, rng, memoryIndex) {
  const chosen = [];
  for (const type of types) {
    const best = selectBestCandidateForType(candidates, type, rng, memoryIndex);
    if (!best) continue;
    chosen.push(best);
  }
  return chosen
    .sort((a, b) => b.priority - a.priority)
    .slice(0, count);
}

function guaranteedTypesForWindow(window) {
  return GUARANTEED_TYPES_BY_WINDOW[window] || [];
}

function isCandidateAllowedInWindow(candidate, window) {
  if (!candidate) {
    return false;
  }
  if (MORNING_ONLY_TYPES.has(candidate.type)) {
    return window === 'morning';
  }
  if (candidate.type === 'learning_recall') {
    return window === 'night';
  }
  return true;
}

function selectBestCandidateForType(candidates, type, rng, memoryIndex) {
  const pool = candidates.filter((candidate) => candidate.type === type);
  if (pool.length === 0) {
    return null;
  }
  return pool
    .map((candidate) => ({ candidate, score: candidateWeight(candidate, rng, memoryIndex) }))
    .sort((a, b) => b.score - a.score)[0].candidate;
}

function selectNonMandatory(candidates, count, rng, memoryIndex = buildRecentMemoryIndex(), initialTypeCounts = new Map()) {
  const selected = [];
  const typeCounts = new Map(initialTypeCounts);
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

  // Creative filler, last resort. capsExhausted starts false so normal/rich
  // batches still respect TYPE_CAPS' diversity intent (e.g. never more than
  // 1 smart_humor_observation) even in this loop. But BATCH_SIZE slots is a
  // hard product invariant (see constants.js/validateFinalBatch in
  // contentGenerator.js) that must never fail just because a sparse/
  // degenerate input (e.g. a 'day' window with no weather/bank/telemetry/
  // recall at all) ran out of distinct safe filler types under the new,
  // deliberately tighter per-type caps (TYPE_CAPS.everyday_lifehack was
  // lowered from 8 to 2 in this same rebuild) -- once every filler
  // blueprint type has been tried enough times to hit its cap and slots are
  // STILL unfilled, this switches to ignoring the cap and just completes
  // the batch, rather than returning fewer than BATCH_SIZE slots.
  let fillerIndex = 0;
  let capsExhausted = false;
  while (selected.length < count) {
    const blueprint = CREATIVE_FILLER_BLUEPRINTS[fillerIndex % CREATIVE_FILLER_BLUEPRINTS.length];
    const blueprintUseIndex = Math.floor(fillerIndex / CREATIVE_FILLER_BLUEPRINTS.length) + 1;
    const type = blueprint.type;
    fillerIndex += 1;
    if (!capsExhausted && !canAddType(typeCounts, type)) {
      if (fillerIndex > CREATIVE_FILLER_BLUEPRINTS.length * (DEFAULT_TYPE_CAP + 2)) {
        capsExhausted = true;
      } else {
        continue;
      }
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
    length_hint: lengthHintForType(candidate.type),
    // Server-only; buildContextPrompt hand-picks {slot_id, type, facts,
    // constraints} for the OpenAI payload and does not include this field.
    learning_memory_id: candidate.learning_memory_id,
    // Set below, after selection, by selectInterestAwareSlots/
    // selectGenderLeanSlot -- for the vast majority of slots these stay
    // undefined and are dropped entirely by JSON.stringify, so a
    // non-personalized slot's payload shape is unchanged.
    interest_hint: undefined,
    gender_lean_hint: undefined,
  }));
}

function planSlots(input = {}, options = {}) {
  const rawCandidates = options.candidates || collectCandidates(input);
  const candidates = rawCandidates.filter((candidate) => isCandidateAllowedInWindow(candidate, input.window));
  const seed = options.seed || [
    input.device && input.device.device_id,
    input.window,
    input.dateContext && input.dateContext.date,
    input.dateContext && input.dateContext.time,
  ].filter(Boolean).join('|');
  const rng = options.rng || createSeededRng(seed || 'slot-planner');
  const memoryIndex = buildRecentMemoryIndex(options.recentContentMemory);
  const fixedMorning = [];
  if (input.window === 'morning') {
    const fixedIds = new Set();
    for (const type of MORNING_FIXED_TYPES) {
      const pick = selectBestCandidateForType(
        candidates.filter((candidate) => !fixedIds.has(candidate.id)),
        type,
        rng,
        memoryIndex
      );
      if (pick) {
        fixedMorning.push(pick);
        fixedIds.add(pick.id);
      }
    }
  }
  const mandatoryLast = input.window === 'night'
    ? candidates.find((candidate) => candidate.type === 'goodnight_care')
    : null;
  const fixedNightRecall = input.window === 'night'
    ? selectBestCandidateForType(candidates, 'learning_recall', rng, memoryIndex)
    : null;

  const mandatoryIds = new Set(
    [...fixedMorning, fixedNightRecall, mandatoryLast]
      .filter(Boolean)
      .map((candidate) => candidate.id)
  );
  const remainingCandidates = candidates.filter((candidate) => !mandatoryIds.has(candidate.id));
  const fixedCount = fixedMorning.length + (fixedNightRecall ? 1 : 0) + (mandatoryLast ? 1 : 0);
  const remainingCount = BATCH_SIZE - fixedCount;

  // guaranteedTypesForWindow (see GUARANTEED_TYPES_BY_WINDOW) reserves a slot
  // first, ahead of the priority+random lottery, for any type that is
  // "guaranteed somewhere in the batch" without a fixed position -- currently
  // empty for every window (see GUARANTEED_TYPES_BY_WINDOW's comment), but
  // the mechanism stays wired up for a future window/type that needs it.
  const guaranteedTypes = guaranteedTypesForWindow(input.window);
  const guaranteed = selectGuaranteedSlots(
    remainingCandidates.filter((candidate) => guaranteedTypes.includes(candidate.type)),
    guaranteedTypes,
    remainingCount,
    rng,
    memoryIndex
  );
  const guaranteedIds = new Set(guaranteed.map((candidate) => candidate.id));

  // The competitive lottery must stay aware of every type already placed at
  // a FIXED position (fixedMorning's 4 types, fixedNightRecall's
  // learning_recall) -- not just the (currently always empty) `guaranteed`
  // list above -- otherwise a second, different candidate of an
  // already-fixed type (e.g. a duplicate holiday item) could win an
  // additional slot through the lottery on top of its fixed one, exceeding
  // that type's TYPE_CAPS limit. Seeding typeCounts from all three sources
  // keeps one single, consistent cap across the whole batch.
  const fixedTypeCounts = new Map();
  for (const candidate of [...fixedMorning, ...(fixedNightRecall ? [fixedNightRecall] : []), ...guaranteed]) {
    fixedTypeCounts.set(candidate.type, (fixedTypeCounts.get(candidate.type) || 0) + 1);
  }

  const competitivePool = remainingCandidates.filter((candidate) => !guaranteedIds.has(candidate.id));
  const competitiveCount = remainingCount - guaranteed.length;
  const competitive = selectNonMandatory(competitivePool, competitiveCount, rng, memoryIndex, fixedTypeCounts);

  const middle = shuffle([...guaranteed, ...competitive], rng);

  const ordered = [];
  ordered.push(...fixedMorning);
  ordered.push(...middle);
  if (fixedNightRecall) ordered.push(fixedNightRecall);
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

  // Gender lean hint: same post-selection-only timing as interest hints
  // above, but capped at exactly one slot regardless of interests.
  const genderLean = selectGenderLeanSlot(slots, input.device && input.device.gender, rng);
  if (genderLean) {
    const slot = slots.find((s) => s.id === genderLean.slotId);
    if (slot) {
      slot.gender_lean_hint = genderLean.gender;
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
    selectGenderLeanSlot,
    resolveContextSignal,
    candidateWeight,
    INTEREST_TYPE_MAP,
    GENDER_LEAN_TYPE_MAP,
    TYPE_CAPS,
    MAX_INTEREST_AWARE_SLOTS,
    MORNING_FIXED_TYPES,
    MORNING_ONLY_TYPES,
    GUARANTEED_TYPES_BY_WINDOW,
    isCandidateAllowedInWindow,
    guaranteedTypesForWindow,
    selectGuaranteedSlots,
    selectBestCandidateForType,
    selectNonMandatory,
    TYPE_LENGTH_HINTS,
    lengthHintForType,
  },
};
