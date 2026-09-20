const { BATCH_SIZE } = require('./constants');

const CONTENT_TYPES = [
  'greeting',
  'weather',
  'holiday',
  'history_today',
  'science',
  'country_fact',
  'city_fact',
  'word_learning',
  'learning_recall',
  'foreign_word_or_expression',
  'humor',
  'useful_knowledge',
  'technology',
  'money_economics',
  'culture',
  'unusual_fact',
  'riddle',
  'everyday_observation',
  'playful_thought',
  'tiny_imagined_scene',
  'gentle_wish',
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
  'city_fact',
  'word_learning',
  'learning_recall',
  'foreign_word_or_expression',
  'useful_knowledge',
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
    id: 'synthetic_gentle_wish_1',
    type: 'gentle_wish',
    priority: 22,
    facts: {},
    source: 'creative',
    constraints: ['kind', 'not_motivational_quote', 'not_coaching'],
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
};

const DEFAULT_TYPE_CAP = 2;

const CREATIVE_FILLER_BLUEPRINTS = [
  { type: 'free_ai_thought', constraints: ['standalone_observation', 'no_user_facts'] },
  { type: 'humor', constraints: ['gentle_observational_humor', 'no_user_facts'] },
  { type: 'riddle', constraints: ['no_answer_required', 'not_a_question'] },
  { type: 'everyday_observation', constraints: ['ordinary_object_or_routine', 'no_user_facts', 'no_physical_context_claims'] },
  { type: 'playful_thought', constraints: ['lightly_playful', 'no_external_facts', 'not_motivational'] },
  { type: 'tiny_imagined_scene', constraints: ['clearly_imagined', 'no_user_or_location_assumptions', 'one_sentence'] },
  { type: 'gentle_wish', constraints: ['kind', 'not_motivational_quote', 'not_coaching'] },
  { type: 'reflective_observation', constraints: ['no_question', 'no_advice', 'no_therapy_language'] },
  { type: 'language_play', constraints: ['only_if_natural_in_target_language', 'no_required_answer', 'avoid_untranslatable_puns'] },
];

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
  return {
    id: candidate.id,
    type: CONTENT_TYPES.includes(candidate.type) ? candidate.type : 'unusual_fact',
    priority: Number.isFinite(candidate.priority) ? candidate.priority : 10,
    facts: candidate.facts || {},
    source: candidate.source || 'editorial',
    eligibility: candidate.eligibility || {},
    cooldown: candidate.cooldown || {},
    constraints: Array.isArray(candidate.constraints) ? candidate.constraints : [],
    group: candidate.group || null,
    bank_category: candidate.bank_category || null,
  };
}

function mapBankItemType(item) {
  if (!item || typeof item.category !== 'string') {
    return 'unusual_fact';
  }
  if (item.category === 'holiday') return 'holiday';
  if (item.category === 'on_this_day') return 'history_today';
  if (item.category === 'humor') return 'humor';
  if (item.category === 'idiom') return 'foreign_word_or_expression';
  if (item.category === 'statistic') return 'unusual_fact';
  if (item.category === 'quote') return 'culture';

  const text = `${item.content_text || ''} ${(item.tags || []).join(' ')}`.toLowerCase();
  if (/\bscience|space|biology|physics|chemistry|astronomy\b/.test(text)) return 'science';
  if (/\btech|technology|ai|software|computer\b/.test(text)) return 'technology';
  if (/\bmoney|economy|economic|market|inflation\b/.test(text)) return 'money_economics';
  if (/\bculture|music|film|book|art\b/.test(text)) return 'culture';
  return 'unusual_fact';
}

function bankItemToCandidate(item, index = 0) {
  const text = item && typeof item.content_text === 'string' ? item.content_text.trim() : '';
  if (!text) {
    return null;
  }
  const type = mapBankItemType(item);
  return createCandidate({
    id: stableCandidateId(`bank_${type}_${index}`, text),
    type,
    priority: type === 'holiday' || type === 'history_today' ? 70 : 48,
    facts: { text },
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
  const { device = {}, window, dateContext, weather, bankItems = [], phoneTrends = {} } = input;
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

function candidateWeight(candidate, rng) {
  return candidate.priority + rng() * 20;
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

function selectNonMandatory(candidates, count, rng) {
  const selected = [];
  const typeCounts = new Map();
  const shuffled = shuffle(candidates, rng)
    .map((candidate) => ({ candidate, score: candidateWeight(candidate, rng) }))
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
    const type = blueprint.type;
    fillerIndex += 1;
    if (!canAddType(typeCounts, type)) {
      if (fillerIndex > CREATIVE_FILLER_BLUEPRINTS.length * (DEFAULT_TYPE_CAP + 2)) {
        break;
      }
      continue;
    }
    selected.push(createCandidate({
      id: `filler_${type}_${fillerIndex}`,
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
    type: candidate.type,
    facts: candidate.facts,
    source: candidate.source,
    bank_category: candidate.bank_category || undefined,
    constraints: candidate.constraints,
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

  const mandatoryFirst = input.window === 'morning'
    ? candidates.find((candidate) => candidate.type === 'greeting')
    : null;
  const mandatoryLast = input.window === 'night'
    ? candidates.find((candidate) => candidate.type === 'goodnight')
    : null;

  const mandatoryIds = new Set([mandatoryFirst, mandatoryLast].filter(Boolean).map((candidate) => candidate.id));
  const remainingCandidates = candidates.filter((candidate) => !mandatoryIds.has(candidate.id));
  const remainingCount = BATCH_SIZE - (mandatoryFirst ? 1 : 0) - (mandatoryLast ? 1 : 0);
  const middle = selectNonMandatory(remainingCandidates, remainingCount, rng);

  const ordered = [];
  if (mandatoryFirst) ordered.push(mandatoryFirst);
  ordered.push(...middle);
  if (mandatoryLast) ordered.push(mandatoryLast);

  return {
    candidates,
    slots: addSlotIds(ordered.slice(0, BATCH_SIZE)),
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
    mapBankItemType,
    normalizePhoneTrends,
  },
};
