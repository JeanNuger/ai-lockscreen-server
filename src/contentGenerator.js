const { STYLE_IDS, BATCH_SIZE } = require('./constants');
const {
  selectBankItemsForDevice,
  recordShownCategories,
  getBankDateString,
  BANK_CATEGORIES,
} = require('./dailyContentBank');
const {
  getRecentContentMemory,
  recordShownContentMemory,
} = require('./contentMemory');
const {
  getRecallCandidate,
  recordLearnedWords,
  recordRecalledWords,
} = require('./learningMemory');
const { planSlots, planMorningPack, MORNING_FIXED_TYPES } = require('./slotPlanner');
const {
  validateLockScreenText,
} = require('./textFilter');

// Absolute hard cap, backed by a real on-device measurement of the Android
// lock-screen text area (TextWallpaperService.java's safe zone / StaticLayout
// wrapping at the current font size/width) -- text this long or shorter is
// guaranteed to fit without visual overflow, regardless of length_hint below.
// This is the ONLY number server-side validation (isUnusableLockScreenText/
// rejectionReasonForText, via textFilter.js's validateLockScreenText) ever
// enforces -- never lowered, never used to slice/truncate a phrase.
const LOCK_SCREEN_TEXT_MAX_LENGTH = 70;

// Model used for the ordinary batch, its repair round, and the morning pack
// (all three go through createOpenAiBatch below) -- overridable via env so a
// model swap doesn't need a code change. Daily Bank generation
// (dailyContentBank.js's gpt-4o + web_search call) is a separate, unrelated
// OpenAI call and is not affected by either of these.
const OPENAI_BATCH_MODEL = process.env.OPENAI_BATCH_MODEL || 'gpt-5-mini';
// gpt-5-mini is a reasoning model: this controls how much hidden reasoning
// it does before writing the JSON phrases. 'low' was chosen over the
// default (unset, effectively 'medium') after a real side-by-side compare --
// 'medium' spent most of its output tokens (and most of its latency) on
// reasoning tokens never seen by the user, for no measurable gain in phrase
// quality over 'low'. Not passed to non-gpt-5 models (see createOpenAiBatch).
const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || 'low';

// `focus` (content-improvement follow-up, req 3 "усилить различие между
// morning/day/evening/night") is a short, data-only mood/topic steer for the
// currently-selected, non-fixed-type slots (everyday_lifehack/
// smart_humor_observation/city_afisha/context_signal/warm_wish and friends --
// greeting_name/goodnight_care/weather_lifehack/holiday_today/history_today/
// word_learning already have their own explicit per-type instructions in
// buildSystemPrompt and are unaffected). Travels inside now.window (see
// buildContextPrompt) as ordinary JSON data, not a system-prompt change, so
// buildSystemPrompt stays a pure function of languageCode only -- the
// existing OpenAI-side prompt-cache rationale for that (see buildSystemPrompt's
// own comment) is preserved unchanged; only ONE static instruction line
// (added there) tells the model to read this field.
const WINDOW_CONTEXT = {
  morning: { id: 'morning', range: '05:00-11:00', focus: 'старт дня, лёгкая энергия, ненавязчивое планирование' },
  day: { id: 'day', range: '11:00-15:00', focus: 'рабочий темп, фокус, бытовые наблюдения' },
  evening: { id: 'evening', range: '15:00-20:00', focus: 'переключение с дел, восстановление, итоги дня' },
  night: { id: 'night', range: '20:00-05:00', focus: 'спокойные мягкие мысли, минимум активного тона и советов' },
};

// The 10 languages product/DoD calls for (locale-driven generation task).
// Each entry names the language for the SYSTEM_PROMPT and a scriptCheck
// regex used to catch full-phrase language drift (see isValidLanguageText
// below) — not a translation-quality check, just "does this phrase contain
// at least one character from the script this language is expected to use".
// Latin-script languages (en/fr/es/pt/de/it) share one scriptCheck: this
// mirrors the previous English-only heuristic, which could only ever tell
// "Latin vs. not-Latin" apart too — distinguishing e.g. French from Italian
// text is not attempted, same scope boundary as before.
const SUPPORTED_LANGUAGES = {
  en: { name: 'English', scriptCheck: /\p{Script=Latin}/u },
  fr: { name: 'French', scriptCheck: /\p{Script=Latin}/u },
  es: { name: 'Spanish', scriptCheck: /\p{Script=Latin}/u },
  pt: { name: 'Portuguese', scriptCheck: /\p{Script=Latin}/u },
  de: { name: 'German', scriptCheck: /\p{Script=Latin}/u },
  ru: { name: 'Russian', scriptCheck: /\p{Script=Cyrillic}/u },
  zh: { name: 'Chinese', scriptCheck: /\p{Script=Han}/u },
  ja: { name: 'Japanese', scriptCheck: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u },
  ko: { name: 'Korean', scriptCheck: /\p{Script=Hangul}/u },
  it: { name: 'Italian', scriptCheck: /\p{Script=Latin}/u },
};
const DEFAULT_LANGUAGE_CODE = 'en';

// Resolves the target generation language from the client's system_language
// signal (see deviceSignals.js — already an ISO 639-1 code like "ru", "zh",
// validated there against /^[A-Za-z-]+$/). Anything missing or not in
// SUPPORTED_LANGUAGES falls back to English, per DoD point 2 — this covers
// both "client didn't send the signal" (older app version) and "client sent
// a real language we don't support yet" (e.g. Arabic) the same way.
function resolveTargetLanguageCode(signals) {
  const raw = signals && typeof signals.system_language === 'string'
    ? signals.system_language.toLowerCase()
    : null;
  return raw && SUPPORTED_LANGUAGES[raw] ? raw : DEFAULT_LANGUAGE_CODE;
}

function pickRandomStyle() {
  return STYLE_IDS[Math.floor(Math.random() * STYLE_IDS.length)];
}

// Returns `count` distinct style_ids (Fisher-Yates shuffle of the full 27-value
// STYLE_IDS, then take the first `count`) -- used wherever a batch needs several
// different backgrounds guaranteed with no repeats.
// count must not exceed STYLE_IDS.length (27); BATCH_SIZE (12) leaves comfortable
// headroom.
function pickUniqueStyles(count) {
  const shuffled = [...STYLE_IDS];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

function pickFirstUnusedStyle(usedStyles) {
  return STYLE_IDS.find((id) => !usedStyles.has(id)) || pickRandomStyle();
}

function safeTrace(fn) {
  try {
    return fn();
  } catch (err) {
    console.warn(`BATCH_TRACE_ERROR stage=collect error=${err.name || 'Error'}`);
    return null;
  }
}

function plannedSourceForSlot(slot) {
  if (!slot || !slot.source) {
    return 'generic';
  }
  if (slot.source === 'daily_bank') {
    return 'bank';
  }
  if (slot.source === 'profile' || slot.source === 'learning_memory') {
    return 'profile';
  }
  if (slot.source === 'weather' || slot.source === 'device_signal' || slot.source === 'phone_analytics' || slot.source === 'date_context') {
    return 'signal';
  }
  return 'generic';
}

function isFixedPositionSlot(window, slot, position) {
  if (!slot) {
    return false;
  }
  if (window === 'morning') {
    return MORNING_FIXED_TYPES.includes(slot.type);
  }
  if (window === 'night' && slot.type === 'goodnight_care') {
    return position === BATCH_SIZE;
  }
  if (window === 'night' && slot.type === 'learning_recall') {
    return position === BATCH_SIZE - 1;
  }
  return false;
}

function hasProfileValue(device, field) {
  return Boolean(device && typeof device[field] === 'string' && device[field].trim());
}

function buildInitialTrace(device, window, languageCode, dateContext) {
  return {
    meta: {
      batch_id: null,
      device_id: device && device.device_id ? device.device_id : null,
      profile_present: {
        name: hasProfileValue(device, 'name'),
        birth_date: hasProfileValue(device, 'birth_date'),
        gender: hasProfileValue(device, 'gender'),
      },
      window,
      lang: languageCode,
      model: OPENAI_BATCH_MODEL,
      local_date: dateContext && dateContext.date ? dateContext.date : null,
      timestamp: new Date().toISOString(),
      // Filled in by recordGenerationMs() right before this trace is
      // returned to the caller -- null here just means "not yet measured",
      // never a real observed value of zero.
      generation_ms: null,
    },
    planned: [],
    first_pass: [],
    repair: { called: false, sent_slot_ids: [], results: [] },
    fallback: [],
    whole_batch_fallback: { flag: false, reason: null },
    style_dedupe: [],
    final: [],
    summary: {},
  };
}

function markWholeBatchFallback(trace, reason) {
  safeTrace(() => {
    if (!trace) {
      return;
    }
    trace.whole_batch_fallback = { flag: true, reason: reason || 'unknown' };
  });
}

function tracePlannedSlots(trace, window, slots) {
  safeTrace(() => {
    if (!trace || !Array.isArray(slots)) {
      return;
    }
    trace.planned = slots.map((slot, index) => ({
      position: index + 1,
      slot_id: slot.slot_id,
      type: slot.type,
      is_fixed_position: isFixedPositionSlot(window, slot, index + 1),
      planned_source: plannedSourceForSlot(slot),
      bank_category: slot.bank_category || null,
      // facts: surfaced here (not just sent to OpenAI) so the derived facts
      // that never reach the model as raw numbers -- e.g. the morning pack's
      // weather_lifehack bands (rain_chance/uv_level/morning_temp_band/
      // day_temp_band, see slotPlanner.js's planMorningPack) -- are still
      // observable in the [batch-trace]/[pack-trace] log line and in tests,
      // without needing to intercept the OpenAI request payload.
      facts: slot.facts || {},
    }));
  });
}

function traceResultsFromCollected(collected, slots) {
  if (!collected || !Array.isArray(slots)) {
    return [];
  }
  const acceptedBySlot = new Map((collected.accepted || []).map((item) => [item.slot_id, item]));
  const rejectedBySlot = new Map();
  for (const detail of collected.rejectedDetails || []) {
    if (detail && detail.slot_id && !rejectedBySlot.has(detail.slot_id)) {
      rejectedBySlot.set(detail.slot_id, detail);
    }
  }
  return slots.map((slot) => {
    const accepted = acceptedBySlot.get(slot.slot_id);
    if (accepted) {
      return {
        slot_id: slot.slot_id,
        status: 'accepted',
        text: accepted.text,
        reason: null,
      };
    }
    const rejected = rejectedBySlot.get(slot.slot_id);
    if (rejected) {
      return {
        slot_id: slot.slot_id,
        status: 'rejected',
        text: rejected.text,
        // The exact sub-reason with numbers (e.g. "too_long:93>70") when one
        // was computed, not just the coarse "basic_quality" bucket -- see
        // collectUsablePhrases' reject() and rejectionReasonForText.
        reason: rejected.detail || rejected.reason,
      };
    }
    return {
      slot_id: slot.slot_id,
      status: 'missing',
      text: null,
      reason: 'missing',
    };
  });
}

// Reassigns any duplicate style_id within a batch to one not yet used in that
// same batch, walked in order -- keeps each phrase's own style_id whenever it's
// still free within the batch, only touches actual repeats. 27 style_ids vs
// BATCH_SIZE (12) leaves comfortable headroom, so an unused one is always
// available. This is the hard guarantee; buildSystemPrompt's "don't repeat
// style_id" instruction above is only a soft ask to the model, not relied on
// alone.
function dedupeStyleIds(items) {
  const used = new Set();
  return items.map((item) => {
    if (!used.has(item.style_id)) {
      used.add(item.style_id);
      return item;
    }
    const available = STYLE_IDS.filter((id) => !used.has(id));
    const replacement = available[Math.floor(Math.random() * available.length)];
    used.add(replacement);
    return { ...item, style_id: replacement };
  });
}

function normalizeTextForDedupe(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isUnusableLockScreenText(text, slotType = null) {
  const filterResult = validateLockScreenText(text, { maxLength: LOCK_SCREEN_TEXT_MAX_LENGTH, slotType });
  return !filterResult.ok;
}

// Returns { reason, detail } (both null if the text passes), never a bare
// string -- `reason` is the coarse bucket used for aggregate counts
// (rejectionReasons in collectUsablePhrases, unchanged from before), `detail`
// is the exact sub-reason with numbers where the check computed one (e.g.
// "too_long:93>70") so the batch trace doesn't
// collapse every basic_quality rejection into the same opaque label. See
// textFilter.js's validateLockScreenText for where `detail` is computed.
function rejectionReasonForText(text, languageCode, validationContext = {}, slotType = null) {
  const filterResult = validateLockScreenText(text, { maxLength: LOCK_SCREEN_TEXT_MAX_LENGTH, slotType });
  if (!filterResult.ok) return { reason: filterResult.reason, detail: filterResult.detail || filterResult.reason };
  return { reason: null, detail: null };
}

function incrementReason(reasonCounts, reason) {
  if (!reason) {
    return;
  }
  reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
}

const MORNING_ANCHOR_TYPES = new Set([
  'greeting_name',
  'holiday_today',
  'history_today',
  'word_learning',
  'weather_lifehack',
  'daily_horoscope',
  'daily_numerology',
]);

// expectedSlots may be an array of slot_id strings (legacy shape) or an
// array of slot objects ({slot_id, type, ...}) -- accepting both means every
// existing caller/test that passed plain slot_id strings keeps working
// unchanged, while callers that pass the real slot objects (both production
// call sites now do, see assembleBatchFromGeneratedPhrases/
// regenerateRejectedSlots) additionally get per-slot `type` threaded down to
// rejectionReasonForText.
function collectUsablePhrases(phrases, languageCode, validationContext = {}, expectedSlots = null) {
  if (!Array.isArray(phrases)) {
    return null;
  }

  const expectedSlotIds = Array.isArray(expectedSlots)
    ? expectedSlots.map((slot) => (typeof slot === 'string' ? slot : slot && slot.slot_id))
    : null;
  const slotTypeById = new Map();
  if (Array.isArray(expectedSlots)) {
    for (const slot of expectedSlots) {
      if (slot && typeof slot === 'object' && typeof slot.slot_id === 'string') {
        slotTypeById.set(slot.slot_id, slot.type || null);
      }
    }
  }

  const seenTexts = new Set();
  const seenSlotIds = new Set();
  const expectedSlotSet = Array.isArray(expectedSlotIds) ? new Set(expectedSlotIds) : null;
  const accepted = [];
  const rejectedSlotIds = new Set();
  const rejectedDetails = [];
  let rejectedCount = 0;
  const rejectionReasons = {};
  const reject = (reason, slotId, text, detail = null) => {
    rejectedCount += 1;
    incrementReason(rejectionReasons, reason);
    if (typeof slotId === 'string') {
      rejectedDetails.push({
        slot_id: slotId,
        reason,
        // Exact sub-reason with numbers (e.g. "too_long:93>70") where one was
        // computed -- falls back to `reason` itself for checks that don't
        // have extra numbers to report (duplicate/slot_id/schema/language).
        detail: detail || reason,
        text: typeof text === 'string' ? text : null,
      });
    }
    if (expectedSlotSet && typeof slotId === 'string' && expectedSlotSet.has(slotId)) {
      rejectedSlotIds.add(slotId);
    }
  };
  for (const phrase of phrases) {
    if (!phrase || typeof phrase.text !== 'string') {
      reject('schema', phrase && phrase.slot_id);
      continue;
    }
    if (expectedSlotSet) {
      if (typeof phrase.slot_id !== 'string' || !expectedSlotSet.has(phrase.slot_id) || seenSlotIds.has(phrase.slot_id)) {
        reject('slot_id', phrase.slot_id);
        continue;
      }
      seenSlotIds.add(phrase.slot_id);
    }
    const text = phrase.text.trim();
    const slotType = typeof phrase.slot_id === 'string' ? (slotTypeById.get(phrase.slot_id) || null) : null;
    const { reason, detail } = rejectionReasonForText(text, languageCode, validationContext, slotType);
    if (reason) {
      reject(reason, phrase.slot_id, text, detail);
      continue;
    }
    if (languageCode && !isValidLanguageText(text, languageCode)) {
      reject('language', phrase.slot_id, text);
      continue;
    }

    const normalized = normalizeTextForDedupe(text);
    if (seenTexts.has(normalized)) {
      reject('duplicate', phrase.slot_id, text);
      continue;
    }
    seenTexts.add(normalized);

    accepted.push({
      slot_id: phrase.slot_id,
      text,
      style_id: STYLE_IDS.includes(phrase.style_id) ? phrase.style_id : null,
    });
  }

  if (expectedSlotSet) {
    const acceptedSlotIds = new Set(accepted.map((item) => item.slot_id));
    for (const slotId of expectedSlotSet) {
      if (!acceptedSlotIds.has(slotId)) {
        rejectedSlotIds.add(slotId);
      }
    }
  }

  return { accepted, rejectedCount, inputCount: phrases.length, rejectionReasons, rejectedSlotIds: [...rejectedSlotIds], rejectedDetails };
}

function cleanUsablePhrases(phrases, languageCode, validationContext = {}) {
  const collected = collectUsablePhrases(phrases, languageCode, validationContext);
  if (!collected) {
    return null;
  }
  const styled = assignUniqueStyleIds(collected.accepted);
  const finalChecked = validateFinalBatch(styled);
  return finalChecked ? styled : null;
}

function assignUniqueStyleIds(items, styleTrace = null) {
  const usedStyles = new Set();
  return items.map((item) => {
    const originalStyle = item.style_id || null;
    const style_id = STYLE_IDS.includes(item.style_id) && !usedStyles.has(item.style_id)
      ? item.style_id
      : pickFirstUnusedStyle(usedStyles);
    usedStyles.add(style_id);
    if (styleTrace && originalStyle !== style_id) {
      styleTrace.push({
        slot_id: item.slot_id || null,
        from: originalStyle,
        to: style_id,
      });
    }
    return { ...item, style_id };
  });
}

// Accepts 1..BATCH_SIZE items, not only exactly BATCH_SIZE -- a slot still
// rejected after the one repair round is now dropped from the batch rather
// than papered over with any generic filler content (see
// assembleByExpectedSlotOrder's dropMissing param), so a real successful
// batch can legitimately come up short. "Nothing usable at all" (0 items) is
// the only case left, handled by the caller treating a null
// assembleByExpectedSlotOrder result as failure before this function is even
// reached in that case, and ultimately surfacing as an empty phrase list --
// the server never fills in with generic filler text.
// slotTypeById (optional Map<slot_id, type>) is threaded into
// isUnusableLockScreenText so the goodnight_care blocked-phrase exemption
// (see textFilter.js) still applies on this final re-check, not just on
// collectUsablePhrases' first-pass check -- otherwise an accepted
// goodnight_care phrase using "пусть" would pass collectUsablePhrases only
// to be rejected again right here, with no slot type available to explain
// why it should be allowed.
function validateFinalBatch(items, slotTypeById = null) {
  if (!Array.isArray(items) || items.length < 1 || items.length > BATCH_SIZE) {
    return false;
  }
  const seenTexts = new Set();
  const seenStyles = new Set();
  for (const item of items) {
    const slotType = slotTypeById && item && typeof item.slot_id === 'string'
      ? slotTypeById.get(item.slot_id) || null
      : null;
    if (!item || typeof item.text !== 'string' || isUnusableLockScreenText(item.text, slotType)) {
      return false;
    }
    if (!STYLE_IDS.includes(item.style_id) || seenStyles.has(item.style_id)) {
      return false;
    }
    seenStyles.add(item.style_id);
    const normalized = normalizeTextForDedupe(item.text);
    if (seenTexts.has(normalized)) {
      return false;
    }
    seenTexts.add(normalized);
  }
  return true;
}

function compactFactText(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim().replace(/\s+/g, ' ');
  return text || null;
}

function missingAnchorReason(slot) {
  if (!slot || !MORNING_ANCHOR_TYPES.has(slot.type)) {
    return null;
  }
  if (slot.type === 'greeting_name') {
    return null;
  }
  const facts = slot.facts || {};
  if (slot.type === 'holiday_today' || slot.type === 'history_today') {
    return compactFactText(facts.text) ? null : 'missing_grounded_text';
  }
  if (slot.type === 'word_learning') {
    return compactFactText(facts.word || facts.text) ? null : 'missing_grounded_word';
  }
  if (slot.type === 'weather_lifehack') {
    return facts.temp_band || facts.condition_lean ? null : 'missing_weather_facts';
  }
  if (slot.type === 'daily_horoscope') {
    return compactFactText(facts.zodiac_sign) ? null : 'missing_zodiac_sign';
  }
  if (slot.type === 'daily_numerology') {
    return Number.isFinite(facts.personal_day_number) ? null : 'missing_personal_day_number';
  }
  return null;
}

function summarizeFactsForLog(slot) {
  const facts = slot && slot.facts ? slot.facts : {};
  return Object.keys(facts).sort().join(',') || 'none';
}

function logMissingMorningAnchor(slot, validationContext, reason) {
  console.warn(
    `MISSING_MORNING_ANCHOR date=${validationContext && validationContext.dateContext ? validationContext.dateContext.date : 'unknown'} type=${slot && slot.type ? slot.type : 'unknown'} reason=${reason || 'unknown'} facts=${summarizeFactsForLog(slot)} category=${slot && slot.bank_category ? slot.bank_category : 'none'}`
  );
}

function logMissingSlotPhrase(slot, validationContext) {
  if (slot && MORNING_ANCHOR_TYPES.has(slot.type)) {
    const missingReason = missingAnchorReason(slot);
    if (missingReason) {
      logMissingMorningAnchor(slot, validationContext, missingReason);
    }
  }
}

// dropMissing: see assembleBatchFromGeneratedPhrases's own comment on the
// param -- when true, a slot with no accepted generated text is simply
// omitted from the result. The result can then be anywhere from 0 to
// expectedSlots.length items long; the caller (assembleBatchFromGeneratedPhrases)
// treats 0 as "nothing usable" (falls through to null, same as any other
// assembly failure) and anything else as a valid, possibly-shorter-than-
// BATCH_SIZE batch (see validateFinalBatch's updated 1..BATCH_SIZE range
// check).
function assembleByExpectedSlotOrder(generated, languageCode, expectedSlots, validationContext = {}, rejectedDetails = [], traceParts = null, dropMissing = false) {
  const generatedBySlot = new Map(generated.map((item) => [item.slot_id, item]));

  const result = expectedSlots.map((slot) => {
    const generatedItem = generatedBySlot.get(slot.slot_id);
    if (generatedItem) {
      return generatedItem;
    }
    logMissingSlotPhrase(slot, validationContext);
    if (dropMissing) {
      return null;
    }
    return null;
  });

  if (dropMissing) {
    const usable = result.filter(Boolean);
    if (usable.length === 0) {
      return null;
    }
    return assignUniqueStyleIds(usable, traceParts ? traceParts.styleDedupe : null);
  }

  if (result.some((item) => !item)) {
    return null;
  }
  return assignUniqueStyleIds(result, traceParts ? traceParts.styleDedupe : null);
}

// No longer pads a short batch with generic filler text -- the server has no
// pool of ready-made phrases to draw from any more. Returns exactly what the
// model generated (styles assigned/deduped as before); the batch can
// legitimately come back shorter than BATCH_SIZE.
function fillWithFallbackPhrases(generated, languageCode, traceParts = null) {
  return assignUniqueStyleIds(generated, traceParts ? traceParts.styleDedupe : null);
}

// dropMissing (default false, so every existing direct caller/test keeps the
// old behavior unchanged): when true, a slot that has no accepted generated
// text is left OUT of the assembled batch entirely -- see generateBatch's
// two production call sites, which both now pass true. Only the real runtime
// flow opts into this; direct unit tests of this function (content-
// quality.test.js, slot-planner.test.js) still exercise the default path.
function assembleBatchFromGeneratedPhrases(phrases, languageCode, validationContext = {}, expectedSlots = null, traceParts = null, dropMissing = false) {
  const collected = collectUsablePhrases(phrases, languageCode, validationContext, expectedSlots);
  if (!collected) {
    return null;
  }
  if (traceParts && Array.isArray(expectedSlots) && !traceParts.firstPass) {
    traceParts.firstPass = traceResultsFromCollected(collected, expectedSlots);
  }
  const generated = collected.accepted.slice(0, BATCH_SIZE);
  const fallbackFillCount = BATCH_SIZE - generated.length;
  const assembled = Array.isArray(expectedSlots)
    ? assembleByExpectedSlotOrder(generated, languageCode, expectedSlots, validationContext, collected.rejectedDetails, traceParts, dropMissing)
    : fallbackFillCount > 0
      ? fillWithFallbackPhrases(generated, languageCode, traceParts)
      : assignUniqueStyleIds(generated, traceParts ? traceParts.styleDedupe : null);

  const slotTypeById = Array.isArray(expectedSlots)
    ? new Map(expectedSlots.filter((slot) => slot && typeof slot.slot_id === 'string').map((slot) => [slot.slot_id, slot.type || null]))
    : null;
  if (!assembled || !validateFinalBatch(assembled, slotTypeById)) {
    return {
      phrases: null,
      generatedCount: generated.length,
      // generatedSlotIds/rejectedSlotIds are included even on this failure
      // branch (previously omitted) -- generateBatch's repair gate reads
      // assembly.rejectedSlotIds to decide whether to attempt repair, and
      // with dropMissing (see B5) an all-rejected first pass lands exactly
      // here (assembled is null because zero slots were usable), so without
      // these fields repair could never fire for the very case it exists
      // for: every slot rejected on first pass.
      generatedSlotIds: generated.map((item) => item.slot_id),
      rejectedCount: collected.rejectedCount,
      fallbackFillCount,
      reason: 'final_assembly_fallback',
      rejectionReasons: collected.rejectionReasons,
      rejectedSlotIds: collected.rejectedSlotIds,
      rejectedDetails: collected.rejectedDetails,
    };
  }

  return {
    phrases: assembled,
    generatedCount: generated.length,
    generatedSlotIds: generated.map((item) => item.slot_id),
    rejectedCount: collected.rejectedCount,
    fallbackFillCount,
    rejectionReasons: collected.rejectionReasons,
    rejectedSlotIds: collected.rejectedSlotIds,
    rejectedDetails: collected.rejectedDetails,
    acceptedSlotIds: generated.map((item) => item.slot_id),
    fallbackDetails: traceParts && traceParts.fallback ? traceParts.fallback : [],
    styleDedupeChanges: traceParts && traceParts.styleDedupe ? traceParts.styleDedupe : [],
    reason: fallbackFillCount === 0
      ? 'success'
      : dropMissing
        ? 'partial_drop_after_repair'
        : generated.length === 0
          ? 'all_invalid_fallback'
          : 'partial_validation_fill',
  };
}

// Morning-pack-only assembly: reuses collectUsablePhrases (identical
// validation) but never fills missing/rejected slots with anything. Returns
// the accepted subset unordered (slot order is restored by the caller, which
// walks packSlots itself) plus everything needed to drive a repair pass
// identical to the ordinary batch's.
function assemblePackFromGeneratedPhrases(phrases, languageCode, validationContext, packSlots, traceParts = null) {
  // Pass the slot OBJECTS (not bare slot_id strings) into collectUsablePhrases
  // so it can build slotTypeById and thread .type down into
  // rejectionReasonForText -- needed so slot-type-dependent checks (the
  // goodnight_care blocked-phrase exemption, and any future ones) apply
  // inside the pack path exactly as they do for the ordinary batch path, and
  // so real rejectionReasonForText/detail values propagate into the trace.
  const collected = collectUsablePhrases(phrases, languageCode, validationContext, packSlots);
  if (!collected) {
    return { phrases: [], rejectedSlotIds: packSlots.map((slot) => slot.slot_id), rejectedDetails: [], rejectionReasons: {} };
  }
  if (traceParts && !traceParts.firstPass) {
    traceParts.firstPass = traceResultsFromCollected(collected, packSlots);
  }
  return {
    phrases: collected.accepted,
    rejectedSlotIds: collected.rejectedSlotIds,
    rejectedDetails: collected.rejectedDetails,
    rejectionReasons: collected.rejectionReasons,
  };
}

function formatRejectionReasons(rejectionReasons) {
  if (!rejectionReasons || Object.keys(rejectionReasons).length === 0) {
    return '';
  }
  return Object.entries(rejectionReasons)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reasonName, count]) => ` rejected_${reasonName}=${count}`)
    .join('');
}

function logBatchResult({ generatedCount, rejectedCount, fallbackFillCount, reason, rejectionReasons }) {
  console.log(
    `AI_BATCH_RESULT generated_count=${generatedCount} rejected_count=${rejectedCount} fallback_fill_count=${fallbackFillCount} reason=${reason}${formatRejectionReasons(rejectionReasons)}`
  );
}

function summarizeTrace(trace, slots, rejectionReasons = {}) {
  safeTrace(() => {
    if (!trace) {
      return;
    }
    const finalSourceCounts = {};
    for (const item of trace.final || []) {
      const source = item.final_source || 'unknown';
      finalSourceCounts[source] = (finalSourceCounts[source] || 0) + 1;
    }
    const genericTypes = new Set(['everyday_lifehack', 'smart_humor_observation', 'warm_wish', 'poetic_thought']);
    const plannedGenericCount = Array.isArray(slots)
      ? slots.filter((slot) => genericTypes.has(slot.type)).length
      : 0;
    const fallbackGenericCount = (trace.fallback || []).filter((item) => item.pool === 'fallback_generic').length;
    trace.summary = {
      final_source_counts: finalSourceCounts,
      rejection_reasons: rejectionReasons || {},
      generic_total: plannedGenericCount + fallbackGenericCount,
      language_mismatch_count: (trace.fallback || []).filter((item) => item.language_matches_user === false).length,
    };
  });
}

function traceFinalAssembly(trace, assembly, slots, repairedSlotIds = new Set()) {
  safeTrace(() => {
    if (!trace || !assembly || !Array.isArray(assembly.phrases) || !Array.isArray(slots)) {
      return;
    }
    const plannedPositionBySlot = new Map(slots.map((slot, index) => [slot.slot_id, index + 1]));
    const typeBySlot = new Map(slots.map((slot) => [slot.slot_id, slot.type]));
    const fallbackBySlot = new Map((assembly.fallbackDetails || []).map((item) => [item.slot_id, item]));
    trace.fallback = assembly.fallbackDetails || trace.fallback || [];
    trace.style_dedupe = assembly.styleDedupeChanges || trace.style_dedupe || [];
    trace.final = assembly.phrases.map((item, index) => {
      const fallback = fallbackBySlot.get(item.slot_id);
      const finalSource = fallback
        ? fallback.pool
        : repairedSlotIds.has(item.slot_id)
          ? 'openai_repair'
          : 'openai_first';
      return {
        position: index + 1,
        slot_id: item.slot_id || null,
        type: typeBySlot.get(item.slot_id) || null,
        final_source: finalSource,
        text: item.text,
        style_id: item.style_id,
        moved: plannedPositionBySlot.has(item.slot_id)
          ? plannedPositionBySlot.get(item.slot_id) !== index + 1
          : true,
      };
    });
  });
}

// dateContext (last param, optional): carried through onto the returned
// object only -- never serialized into the HTTP response itself (routes/
// batch.js only ever reads `.phrases`/`.source`/`.context`/`.trace` off the
// old shape, so this is purely additive) -- added so routes/batch.js can
// compute the morning-pack target_date without recomputing
// resolveLocalDateContext a second time. Omitted (undefined) by every
// pre-existing call site that doesn't pass it, which is harmless.
// generationStartMs (last param, optional): epoch-ms captured at the very
// start of generateBatch/generateMorningPack, observation-only -- when
// present, records trace.meta.generation_ms (total wall-clock time for this
// generation attempt, including any repair round) right before returning.
// Never affects what's returned to the client (routes/batch.js's HTTP
// response), only the trace object. Omitted (undefined) is a no-op, same
// "purely additive" convention as dateContext above.
function recordGenerationMs(trace, generationStartMs) {
  safeTrace(() => {
    if (trace && trace.meta && typeof generationStartMs === 'number') {
      trace.meta.generation_ms = Date.now() - generationStartMs;
    }
  });
}

// The server has no ready-made phrase pool to fall back to any more -- when
// OpenAI can't be reached or its response can't be used at all, the batch is
// simply empty (never filled with generic filler text). Each such failure is
// still logged with its reason (AI_BATCH_RESULT below) and flagged in the
// trace (markWholeBatchFallback), but the phrase list itself comes back
// empty; see routes/batch.js's selectReusableBatch for why an empty result
// like this is also never cached for reuse -- the next request always tries
// OpenAI again.
function buildLoggedFallbackResult(languageCode, context, reason, rejectedCount = 0, trace = null, slots = [], dateContext = null, generationStartMs = null) {
  logBatchResult({
    generatedCount: 0,
    rejectedCount,
    fallbackFillCount: 0,
    reason,
  });
  markWholeBatchFallback(trace, reason);
  summarizeTrace(trace, slots, {});
  recordGenerationMs(trace, generationStartMs);
  return { phrases: [], source: 'fallback', context, trace, dateContext };
}

function buildLoggedOpenAiResult(assembly, context, trace = null, slots = [], repairedSlotIds = new Set(), dateContext = null, generationStartMs = null) {
  logBatchResult(assembly);
  traceFinalAssembly(trace, assembly, slots, repairedSlotIds);
  summarizeTrace(trace, slots, assembly.rejectionReasons);
  recordGenerationMs(trace, generationStartMs);
  const phrases = assembly.phrases.map((item) => ({ text: item.text, style_id: item.style_id }));
  return { phrases, source: 'openai', context, trace, dateContext };
}

function parseOpenAiBatchResponse(response) {
  const content = response &&
    response.choices &&
    response.choices[0] &&
    response.choices[0].message &&
    response.choices[0].message.content;
  const parsed = JSON.parse(content);
  if (!parsed || !Array.isArray(parsed.phrases)) {
    throw new Error('response did not contain phrases array');
  }
  return parsed;
}

function buildBatchResponseFormat(name, count) {
  return {
    type: 'json_schema',
    json_schema: {
      name,
      strict: true,
      schema: {
        type: 'object',
        properties: {
          phrases: {
            type: 'array',
            minItems: count,
            maxItems: count,
            items: {
              type: 'object',
              properties: {
                slot_id: { type: 'string' },
                // No `maxLength` here -- deliberately (see LOCK_SCREEN_TEXT_MAX_LENGTH's
                // own comment for the full incident history). A prior attempt
                // used a smaller "soft target" (60) here specifically to stop
                // the model from treating the real 70-char cap as a target,
                // but production showed the model instead treated *that*
                // number as its new target and got cut off mid-WORD at ~56-60
                // chars across many phrases (e.g. "...хранилища стале",
                // "...жела", "...окружающ") -- any maxLength value in this
                // schema, soft or hard, ends up read by the model as a length
                // goal to aim for rather than a limit to respect, and OpenAI's
                // Structured Outputs strict mode does not actually enforce it
                // as a hard decode-time constraint anyway (confirmed against
                // OpenAI's own docs), so it bought no real safety in exchange
                // for that risk. The model must now finish its thought with no
                // length signal in the schema at all; length_hint (short/
                // medium/long) in the per-slot payload plus buildSystemPrompt's
                // own prose instructions are the only length guidance it gets.
                // LOCK_SCREEN_TEXT_MAX_LENGTH (70) remains the real hard cap,
                // enforced ONLY after generation, server-side, by
                // isUnusableLockScreenText/rejectionReasonForText -- never in
                // this schema, and never via slice/substring.
                text: { type: 'string' },
                style_id: { type: 'string', enum: STYLE_IDS },
              },
              required: ['slot_id', 'text', 'style_id'],
              additionalProperties: false,
            },
          },
        },
        required: ['phrases'],
        additionalProperties: false,
      },
    },
  };
}

// gpt-5-family reasoning models don't take `temperature` and use
// `reasoning_effort` for hidden reasoning depth; neither is relevant to
// gpt-4o-mini or older models. Detected by model name prefix rather than a
// fixed list so a future gpt-5.x/gpt-6-family OPENAI_BATCH_MODEL still gets
// this without a code change. Also gates a would-be max_tokens ->
// max_completion_tokens rename for this family -- moot today since neither
// call here sends max_tokens/temperature at all.
const IS_REASONING_MODEL = /^gpt-5/i.test(OPENAI_BATCH_MODEL);

async function createOpenAiBatch(client, context, languageCode, count = BATCH_SIZE, schemaName = 'lock_screen_batch') {
  const params = {
    model: OPENAI_BATCH_MODEL,
    response_format: buildBatchResponseFormat(schemaName, count),
    messages: [
      { role: 'system', content: buildSystemPrompt(languageCode) },
      { role: 'user', content: context },
    ],
  };
  if (IS_REASONING_MODEL) {
    params.reasoning_effort = OPENAI_REASONING_EFFORT;
  }
  return client.chat.completions.create(params);
}

// rejectedDetails (optional, from assembly.rejectedDetails) carries the
// original rejected text and exact reason/detail per slot_id (see
// collectUsablePhrases' rejectedDetails) -- B3: the repair request must show
// the model what it actually got wrong, not just ask it to "try again"
// blind. Falls back to sending no original_text/rejection_reason for a slot
// this array doesn't cover (defensive only; every rejected slot should have
// a matching entry).
async function regenerateRejectedSlots(client, basePayload, slots, rejectedSlotIds, languageCode, validationContext, trace = null, rejectedDetails = []) {
  if (!Array.isArray(rejectedSlotIds) || rejectedSlotIds.length === 0) {
    return null;
  }
  const rejectedSlotSet = new Set(rejectedSlotIds);
  const repairSlots = slots.filter((slot) => rejectedSlotSet.has(slot.slot_id));
  if (repairSlots.length === 0) {
    return null;
  }
  safeTrace(() => {
    if (trace) {
      trace.repair.called = true;
      trace.repair.sent_slot_ids = repairSlots.map((slot) => slot.slot_id);
    }
  });
  // Most recent rejection per slot_id -- rejectedDetails can contain more
  // than one entry per slot across passes, last one wins (most recent
  // attempt for that slot).
  const rejectionBySlot = new Map();
  for (const detail of Array.isArray(rejectedDetails) ? rejectedDetails : []) {
    if (detail && typeof detail.slot_id === 'string') {
      rejectionBySlot.set(detail.slot_id, detail);
    }
  }
  const repairPayload = {
    ...basePayload,
    repair: 'rewrite_only_these_rejected_slots',
    // repair_instructions is deliberately plain, model-facing English/Russian
    // prose data (not a schema field) -- see buildSystemPrompt's own repair
    // clause, which tells the model how to read original_text/
    // rejection_reason/max_length_chars below: preserve the meaning/fact,
    // rewrite to fix the specific violation.
    slots: repairSlots.map((slot) => {
      const rejection = rejectionBySlot.get(slot.slot_id) || null;
      return {
        slot_id: slot.slot_id,
        type: slot.type,
        facts: slot.facts || {},
        constraints: slot.constraints || [],
        interest_hint: slot.interest_hint || undefined,
        gender_lean_hint: slot.gender_lean_hint || undefined,
        // B3: the exact text that got rejected, why (detail carries the
        // numbers, e.g. "too_long:93>70"), and the hard limit it must now
        // respect -- so the model fixes THIS violation while preserving the
        // original meaning, instead of generating blind.
        original_text: rejection ? rejection.text : undefined,
        rejection_reason: rejection ? (rejection.detail || rejection.reason) : undefined,
        max_length_chars: LOCK_SCREEN_TEXT_MAX_LENGTH,
      };
    }),
  };
  const response = await createOpenAiBatch(
    client,
    JSON.stringify(repairPayload),
    languageCode,
    repairSlots.length,
    'lock_screen_repair'
  );
  const parsed = parseOpenAiBatchResponse(response);
  const repaired = collectUsablePhrases(
    parsed.phrases,
    languageCode,
    validationContext,
    repairSlots
  );
  safeTrace(() => {
    if (trace) {
      trace.repair.results = traceResultsFromCollected(repaired, repairSlots);
    }
  });
  return repaired && repaired.accepted.length > 0 ? repaired.accepted : null;
}

function extractUsedCategoriesFromSlots(slots) {
  return Array.isArray(slots)
    ? slots
      .map((slot) => slot.bank_category)
      .filter((category) => BANK_CATEGORIES.includes(category))
    : [];
}

// Generalizes the old isValidEnglishText heuristic to any of the 10
// supported languages: SYSTEM_PROMPT demands a specific target language, but
// gpt-4o-mini occasionally drifts into another language on an individual
// phrase within an otherwise-correct batch (observed in practice for
// Russian, not theoretical). Checks only for "at least one character in the
// expected script" — a full-phrase drift into a different script family
// (e.g. Chinese requested, English-only text came back) has none, so it's
// caught; it does not try to catch drift between languages that share a
// script (e.g. French text when Italian was requested), same limitation the
// original English/Cyrillic-only check had.
function isValidLanguageText(text, languageCode) {
  const language = SUPPORTED_LANGUAGES[languageCode] || SUPPORTED_LANGUAGES[DEFAULT_LANGUAGE_CODE];
  return language.scriptCheck.test(text);
}

function weekdayForDateString(date) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'long',
    }).format(new Date(`${date}T00:00:00Z`));
  } catch (err) {
    return null;
  }
}

function addDaysToDateString(date, days) {
  const instant = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(instant.getTime())) {
    return null;
  }
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

// Date/day-of-week is deliberately NOT a client-sent signal (see
// PRODUCT_REBUILD_PLAN.md server contract docs) — the server already has the
// device's IANA timezone (e.g. "Asia/Almaty") from /register
// (TimeZone.getDefault().getID() on the Android side), so it can compute the
// device's local date/weekday itself rather than trusting/parsing a second
// client-sent value that would just have to agree with the timezone anyway.
// Returns {dateContext, unavailableReason}. dateContext is null if there's no
// timezone on file yet, or it's not a timezone Intl recognizes.
function isValidDateString(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && !Number.isNaN(new Date(`${date}T00:00:00Z`).getTime());
}

function resolveLocalDateContext(timezone, forcedLocalDate = null) {
  if (!timezone) {
    return { dateContext: null, unavailableReason: 'missing_timezone' };
  }
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const computedDate = `${get('year')}-${get('month')}-${get('day')}`;
    const date = isValidDateString(forcedLocalDate) ? forcedLocalDate : computedDate;
    const weekday = date === computedDate ? get('weekday') : weekdayForDateString(date);
    const time = `${get('hour')}:${get('minute')}`;
    const tomorrowDate = addDaysToDateString(date, 1);
    const tomorrowWeekday = tomorrowDate ? weekdayForDateString(tomorrowDate) : null;
    if (!weekday || !time || !tomorrowDate || !tomorrowWeekday) {
      return { dateContext: null, unavailableReason: 'invalid_timezone' };
    }
    return {
      dateContext: {
        date,
        weekday,
        time,
        tomorrow_date: tomorrowDate,
        tomorrow_weekday: tomorrowWeekday,
      },
      unavailableReason: null,
    };
  } catch (err) {
    return { dateContext: null, unavailableReason: 'invalid_timezone' };
  }
}

function getLocalDateContext(timezone) {
  return resolveLocalDateContext(timezone).dateContext;
}

// Same shape as resolveLocalDateContext's dateContext, but for an arbitrary
// calendar date (the morning pack's target_date) rather than "now" in some
// timezone -- weekday-of-a-calendar-date is timezone-independent (see
// weekdayForDateString's own UTC-anchored implementation), so this needs no
// timezone input at all. No `time` field: the pack is generated the evening
// before for a future morning, so "now.time" has no honest value to report
// (see buildContextPrompt, which simply omits now.time when dateContext.time
// is undefined) -- and context_signal (the one type that reads dateContext.time)
// is never a pack slot type anyway.
function buildTargetDateContext(targetDate) {
  if (!isValidDateString(targetDate)) {
    return null;
  }
  const weekday = weekdayForDateString(targetDate);
  const tomorrowDate = addDaysToDateString(targetDate, 1);
  const tomorrowWeekday = tomorrowDate ? weekdayForDateString(tomorrowDate) : null;
  if (!weekday || !tomorrowDate || !tomorrowWeekday) {
    return null;
  }
  return { date: targetDate, weekday, tomorrow_date: tomorrowDate, tomorrow_weekday: tomorrowWeekday };
}

// Formats `instant` as the calendar date (YYYY-MM-DD) it falls on within
// `timezone` — the building block both getLocalDateContext (today's date)
// and getDaysSinceInstall (below) use, so "what calendar day is this" is
// computed the same way in both places, consistently in the device's own
// timezone rather than server UTC. Returns null if timezone is missing/not
// recognized by Intl (same convention as getLocalDateContext).
function getLocalCalendarDate(instant, timezone) {
  if (!timezone) {
    return null;
  }
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(instant);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch (err) {
    return null;
  }
}

// Days elapsed between a device's first appearance in the system
// (devices.created_at — set once at row creation by db/index.js's
// DEFAULT (datetime('now')), never touched again by register.js's
// ON CONFLICT update) and now, counted in the device's own local calendar
// days (see PRODUCT_REBUILD_PLAN.md §5.1) — not server UTC days, so the
// count doesn't roll over an hour or two before/after the user's actual
// local midnight, and not raw elapsed hours/24h periods either.
//
// The day of registration itself is day 0, not day 1 — a device that
// registered 10 minutes ago should read as "just installed" in the prompt,
// not "1 day in". Implemented by converting both createdAtUtc and "now" to
// calendar-date strings in the device's timezone (getLocalCalendarDate
// above) and diffing those as UTC midnights: since both are already
// timezone-adjusted calendar dates at that point, the ms difference divides
// out to an exact whole-day count with no further DST/offset arithmetic
// needed.
//
// Returns null (same "not enough info yet" convention as
// getLocalDateContext) if there's no timezone on file, or createdAtUtc is
// missing/unparseable — e.g. the very first /batch call for a brand-new
// device, made with the pre-insert `device` stub from routes/batch.js that
// has no created_at yet.
function getDaysSinceInstall(createdAtUtc, timezone) {
  if (!createdAtUtc || !timezone) {
    return null;
  }
  // SQLite's datetime('now') stores 'YYYY-MM-DD HH:MM:SS' as UTC but with no
  // 'Z'/offset suffix — append one explicitly so Date parses it as UTC
  // rather than as local server time.
  const installInstant = new Date(`${createdAtUtc.replace(' ', 'T')}Z`);
  if (Number.isNaN(installInstant.getTime())) {
    return null;
  }
  const installDate = getLocalCalendarDate(installInstant, timezone);
  const nowDate = getLocalCalendarDate(new Date(), timezone);
  if (!installDate || !nowDate) {
    return null;
  }
  const daysDiff = Math.round(
    (Date.parse(`${nowDate}T00:00:00Z`) - Date.parse(`${installDate}T00:00:00Z`)) / 86400000
  );
  // Floored at 0 defensively (should not go negative in practice — both
  // dates come from the same device's own timezone conversion — but a
  // negative "days since install" would be a confusing thing to hand the
  // model if clock skew or an edge case ever produced one).
  return daysDiff >= 0 ? daysDiff : 0;
}

// Computes the user's age in whole years from device.birth_date (an
// ISO-ish date string from the client, e.g. "1990-05-20"). Returns null if
// birth_date is missing or unparseable, so callers can omit the field
// entirely rather than send a garbage value to the model.
function computeAge(birthDate) {
  if (!birthDate) {
    return null;
  }
  const dob = new Date(birthDate);
  if (Number.isNaN(dob.getTime())) {
    return null;
  }
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDay = (now.getUTCMonth() - dob.getUTCMonth()) || (now.getUTCDate() - dob.getUTCDate());
  if (monthDay < 0) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}

// Builds the compact slot-based user payload sent to the model. The planner
// has already decided WHAT the batch should cover; this payload asks OpenAI
// only to write one phrase for each selected slot.
//
// languageCode: the already-resolved target language (resolveTargetLanguageCode's
// output) — reported in `now.language` as a human name so the model doesn't
// have to map an ISO code itself.
// slots: exactly BATCH_SIZE planner-selected editorial tasks. The full
// candidate pool/bank is deliberately not sent.
function windowContextFor(window) {
  return WINDOW_CONTEXT[window] || { id: window };
}

function buildContextPrompt(device, window, signals, weather, languageCode, slots, dateContext) {
  const profile = {};
  if (device.name) profile.name = device.name;
  if (device.gender) profile.gender = device.gender;
  const age = computeAge(device.birth_date);
  if (age !== null) profile.age = age;

  // `language` is the resolved GENERATION target (resolveTargetLanguageCode's
  // output, e.g. falls back to English if the device's own language isn't
  // supported) -- not the same thing as the device's raw system_language
  // signal, so we also surface `device_language` below whenever the two
  // differ, otherwise the model would have no way to know a fallback
  // happened. `timezone` itself is deliberately NOT included here (unlike
  // the old "; "-joined context) -- the model only ever needs the derived
  // date/weekday/days_since_install below, not the raw IANA string.
  const now = { language: SUPPORTED_LANGUAGES[languageCode].name, window: windowContextFor(window) };
  if (signals && signals.system_language && signals.system_language !== languageCode) {
    now.device_language = signals.system_language;
  }
  const ipCountryCode = weather && typeof weather.countryCode === 'string' && weather.countryCode
    ? weather.countryCode
    : null;
  if (ipCountryCode) {
    now.country = ipCountryCode;
    // Normally this country came from the IP geolocation lookup
    // (resolveWeather -> weather.countryCode). On an IP-vs-timezone mismatch
    // (routes/batch.js's resolveLocationMismatch), the caller instead passes
    // a `weather` object carrying the TIMEZONE's country code and
    // `countrySource: 'timezone'`, so this label stays accurate rather than
    // claiming an IP-derived value that was deliberately overridden.
    now.country_source = weather && weather.countrySource === 'timezone' ? 'timezone' : 'ip_approximate';
    if (signals && signals.region !== undefined && signals.region !== ipCountryCode) {
      now.device_region = signals.region;
    }
  } else if (signals && signals.region !== undefined) {
    now.country = signals.region;
    now.country_source = 'device_locale';
  }
  if (device.timezone) {
    if (dateContext) {
      now.date = dateContext.date;
      now.weekday = dateContext.weekday;
      now.time = dateContext.time;
      now.tomorrow = [dateContext.tomorrow_date, dateContext.tomorrow_weekday];
    }
    const daysSinceInstall = getDaysSinceInstall(device.created_at, device.timezone);
    if (daysSinceInstall !== null) {
      now.days_since_install = daysSinceInstall;
    }
  }

  const ctx = {
    lang: languageCode,
    profile,
    now,
    slots: Array.isArray(slots)
      ? slots.map((slot) => ({
        slot_id: slot.slot_id,
        type: slot.type,
        facts: slot.facts || {},
        constraints: slot.constraints || [],
        // Target length for this specific slot (see TYPE_LENGTH_HINTS in
        // slotPlanner.js) -- 'short'/'medium'/'long' are targets the model
        // should aim for, not the hard cap; LOCK_SCREEN_TEXT_MAX_LENGTH (70)
        // is enforced separately regardless of this hint (see
        // buildSystemPrompt/validateFinalBatch).
        length_hint: slot.length_hint || 'medium',
        // Only present on the small, server-selected subset of slots
        // SlotPlanner picked as interest-aware (see selectInterestAwareSlots
        // in slotPlanner.js) -- omitted (not even an empty/false value) for
        // every other slot, so this never grows the per-slot payload shape
        // for the common case, and never carries the user's full interests
        // list, only the one compact tag relevant to this specific slot.
        interest_hint: slot.interest_hint || undefined,
        // Same shape/timing as interest_hint, but from selectGenderLeanSlot
        // -- present on at most ONE slot in the whole batch (see that
        // function's own comment for why a hard single-slot cap matters
        // here specifically: gender must stay rare, not a recurring theme).
        gender_lean_hint: slot.gender_lean_hint || undefined,
      }))
      : [],
  };
  if (Object.keys(profile).length === 0) delete ctx.profile;

  return JSON.stringify(ctx);
}

// Builds the SYSTEM_PROMPT for a specific target language. Function of
// languageCode only (no country code) so the static prefix is byte-identical
// across every request in the same language regardless of which device's
// country happens to be set -- country code now travels only in the per-request
// context (buildContextPrompt's `now.country`), which lets an OpenAI-side
// prompt cache match this whole prefix across users of the same language
// instead of missing on the old regionCode-conditional branch.
//
// The "occasional country fact" instruction is therefore now unconditional
// static text (previously only appended when a region was present) -- it's
// a no-op on a request with no region in context, and still deliberately
// conservative (general-knowledge, uncontested facts only) since this path
// has no web search, unlike dailyContentBank.js's Responses API call.
//
// Shape of the output (exactly BATCH_SIZE {slot_id, text, style_id} objects)
// is enforced via the Structured Outputs json_schema passed to the API call
// in generateBatch, not described in this text -- see the call site for why.
function buildSystemPrompt() {
  return `You are the voice of a kind, clever AI that lives on the user's phone lock screen. Every time they glance at their phone, you show one short line. Your goal: make them curious about what you will say next. You entertain, inform, support, teach, and notice things for them — like a smart, warm friend, never like a motivational poster or a textbook.

LANGUAGE
- Write every phrase in the language given in "lang", natively. Never translate word for word.
- Facts may arrive in English. Retell them naturally in the target language.
- Never translate jokes, idioms or quotes literally. For a joke, write your own light joke on the same theme. For word_learning, if the idiom is foreign, use a real common expression of the target language with a similar meaning.

HARD LIMIT
- Each phrase is at most ${LOCK_SCREEN_TEXT_MAX_LENGTH} characters, counting spaces. Longer phrases are discarded. Aim for 25–60.
- If a fact is too long, keep only its most striking part.

VOICE
- Address the user informally (ты / du / tu / tú).
- Use the name only in greeting_name and at most one other phrase per batch.
- Never talk about yourself: no "I", no gendered self-reference, never mention being an AI.
- Do not lecture, command or moralize — except weather advice.
- No empty truisms. Test: after reading, the user learned something new, smiled, got a concrete useful tip, or felt a sincere warm word. If none — rewrite.
- No numbers from phone signals. No exact temperatures.

FACTS
- Use only facts given in the slot. Never invent names, dates, numbers or events.
- Dry numbers only if the number itself is surprising.

SLOT TYPES
- greeting_name: warm morning greeting with the name; may include a light wish.
- weather_lifehack: practical advice from the facts (umbrella, layers, sunglasses, hat). No numbers.
- daily_horoscope: light, kind, symbolic note; name the sign. No health, money or fate predictions.
- holiday_today: name the holiday, local one of the user's country first; friendly touch.
- history_today: the year and what happened, vividly.
- daily_numerology: the personal day number and its light meaning today; name the number.
- word_learning: a real expression in the target language and its meaning.
- learning_recall: remind an expression from recent days and its meaning.
- science_tech, good_news, unusual_fact, country_fact: the most surprising part, simply.
- culture: a short famous quote with the author, or a cultural fact.
- smart_humor_observation: your own light, clever everyday joke. Never a translated anecdote.
- everyday_lifehack: one concrete, slightly surprising, doable trick. Not obvious advice.
- warm_wish: one sincere, specific, kind wish. Not a greeting-card cliché.
- poetic_thought: a short evening image — stars, autumn, city lights. Gentle, not pompous.
- goodnight_care: a calm, warm goodnight line.
- phone_trend, context_signal: a gentle observation about the user's day. No numbers, no advice.

WRITING STYLE (no sample phrases are given on purpose; never copy wording from anywhere):
- One short thought per phrase, natural spoken language, informal tone.
- Concrete and specific: a real fact, a doable tip or a precise observation. Nothing that could fit any day or any person.
- Weather: everyday wording about what to wear or take, no exact numbers, no orders.
- Humor: light, about familiar everyday situations; no translated jokes, no joke setups about yourself.
- Facts: the most surprising concrete detail; no dry statistics or forecasts.
- Greetings and wishes: warm and personal, not greeting-card phrases; use a name only if it is in the provided profile.
- Avoid: empty motivation, clichés, obvious health advice, formal commands.

WINDOW
now.window sets the mood: morning — start of the day; day — light, curious; evening — calmer, cultural; night — quiet and warm.

REPAIR MODE
If the payload has "repair": "rewrite_only_these_rejected_slots", each slot has original_text, rejection_reason and max_length_chars. Fix exactly that problem, keep the meaning. For too_long, shorten without cutting the thought.

OUTPUT
Only JSON matching the schema: one phrase per slot, in slot order, with its slot_id.`;
}

/**
 * Generates the "morning pack" -- a fixed, mandatory 7-slot set (see
 * planMorningPack/MORNING_FIXED_TYPES) for a specific target_date, as a
 * SEPARATE OpenAI call from the ordinary batch. Reuses createOpenAiBatch/
 * regenerateRejectedSlots/collectUsablePhrases/assignUniqueStyleIds -- the
 * exact same generation, repair and style-assignment machinery the ordinary
 * batch path uses -- but never falls back to server-authored or fact-derived
 * text and never pads the result: a slot that can't be grounded, or fails
 * validation and repair, is simply dropped.
 *
 * Never throws -- every failure path (no candidates, no API key, OpenAI
 * error, parse error, everything rejected) returns `{ phrases: [], trace }`
 * so the caller can safely treat that as "no pack this time" without any
 * special-casing, and a failure here must never be allowed to affect the
 * ordinary batch response (see routes/batch.js, which wraps this whole call
 * in its own try/catch as a second line of defense).
 *
 * @param {object} device - row from the devices table (or a stub {device_id})
 * @param {string} targetDate - YYYY-MM-DD, the calendar date the pack is FOR
 * @param {object} [signals] - device signals (resolves target language)
 * @param {object} [weather] - resolveWeather() result, reused only for its
 *   countryCode (prompt context), not for weather facts
 * @param {object} [weatherForecast] - resolveWeatherForecast() result for
 *   targetDate (same shape as resolveWeather's), used for weather_lifehack facts
 * @returns {Promise<{phrases: Array<{slot_id, type, text, style_id}>, trace: object|null}>}
 */
async function generateMorningPack(device, targetDate, signals, weather, weatherForecast) {
  // Observation-only: total wall-clock time for this pack generation attempt
  // (including the one repair round, if any) -- see recordGenerationMs()'s
  // own comment. Captured here, before any work, so it covers everything
  // this function does, not just the OpenAI call itself.
  const generationStartMs = Date.now();
  const languageCode = resolveTargetLanguageCode(signals);
  const targetDateContext = buildTargetDateContext(targetDate);
  if (!targetDateContext) {
    return { phrases: [], trace: null };
  }

  const countryCode = weather && typeof weather.countryCode === 'string' && weather.countryCode
    ? weather.countryCode
    : signals && typeof signals.region === 'string'
      ? signals.region
      : null;

  // count=0: GUARANTEED_SELECTION_CATEGORIES (holiday/on_this_day/idiom)
  // inside selectBankItemsForDevice are always picked first when available,
  // ahead of `count` -- passing 0 asks for exactly those 3 guaranteed
  // categories and nothing else, since the pack only ever needs
  // holiday_today/history_today/word_learning from the bank. deviceLocalDate
  // is intentionally targetDate here (not "today"), so the date-sensitive
  // holiday/on_this_day lookup resolves against target_date -- see rule 3e.
  const bankItems = selectBankItemsForDevice(
    device.device_id,
    getBankDateString(),
    targetDate,
    device.gender,
    countryCode,
    0
  );

  const packSlots = planMorningPack({ device, targetDateContext, weatherForecast, bankItems });

  const trace = {
    kind: 'morning_pack',
    meta: {
      pack_id: null,
      device_id: device && device.device_id ? device.device_id : null,
      target_date: targetDate,
      lang: languageCode,
      model: OPENAI_BATCH_MODEL,
      timestamp: new Date().toISOString(),
      generation_ms: null,
    },
    planned: [],
    first_pass: [],
    repair: { called: false, sent_slot_ids: [], results: [] },
    fallback: [],
    final: [],
    summary: {},
  };
  tracePlannedSlots(trace, 'morning', packSlots);

  if (packSlots.length === 0) {
    trace.summary = { reason: 'no_pack_candidates' };
    recordGenerationMs(trace, generationStartMs);
    return { phrases: [], trace };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    trace.summary = { reason: 'no_api_key' };
    recordGenerationMs(trace, generationStartMs);
    return { phrases: [], trace };
  }

  // window is hard-coded 'morning' here regardless of the actual request
  // window (rule 3e) -- the pack is always framed as tomorrow/today's
  // morning, never "tonight"/"this evening", since that's when it will
  // actually be shown.
  const context = buildContextPrompt(device, 'morning', signals, weather, languageCode, packSlots, targetDateContext);
  const validationContext = {
    dateContext: targetDateContext,
    signals,
    weather,
    contextFlags: { traffic: false },
  };

  let client;
  let response;
  try {
    const OpenAI = require('openai');
    client = new OpenAI({ apiKey });
    response = await createOpenAiBatch(client, context, languageCode, packSlots.length, 'lock_screen_morning_pack');
  } catch (err) {
    console.error(`PACK_ERROR reason=openai_error error=${err.name || 'Error'}`);
    trace.summary = { reason: 'openai_error' };
    recordGenerationMs(trace, generationStartMs);
    return { phrases: [], trace };
  }

  let parsed;
  try {
    parsed = parseOpenAiBatchResponse(response);
  } catch (err) {
    console.error(`PACK_ERROR reason=parse_or_schema_error error=${err.name || 'Error'}`);
    trace.summary = { reason: 'parse_or_schema_error' };
    recordGenerationMs(trace, generationStartMs);
    return { phrases: [], trace };
  }

  const traceParts = { firstPass: null };
  let assembly = assemblePackFromGeneratedPhrases(parsed.phrases, languageCode, validationContext, packSlots, traceParts);
  safeTrace(() => {
    trace.first_pass = traceParts.firstPass || [];
  });

  const repairedSlotIds = new Set();
  if (assembly.rejectedSlotIds.length > 0) {
    try {
      const basePayload = JSON.parse(context);
      const repaired = await regenerateRejectedSlots(
        client,
        basePayload,
        packSlots,
        assembly.rejectedSlotIds,
        languageCode,
        validationContext,
        trace,
        assembly.rejectedDetails
      );
      if (repaired && repaired.length > 0) {
        for (const item of repaired) {
          repairedSlotIds.add(item.slot_id);
        }
        const merged = assembly.phrases.concat(repaired);
        assembly = assemblePackFromGeneratedPhrases(merged, languageCode, validationContext, packSlots, {});
      }
    } catch (err) {
      console.error(`PACK_ERROR reason=slot_regeneration_error error=${err.name || 'Error'}`);
    }
  }

  // Rule: a slot still missing after repair is dropped -- never filled with
  // server-authored text or raw grounded facts. Slot order here is restored
  // by walking packSlots itself, so a dropped slot never disturbs the
  // relative order of the ones that remain.
  const acceptedBySlot = new Map(assembly.phrases.map((item) => [item.slot_id, item]));
  const finalUnstyled = [];
  for (const slot of packSlots) {
    const generatedItem = acceptedBySlot.get(slot.slot_id);
    if (generatedItem) {
      finalUnstyled.push({
        slot_id: generatedItem.slot_id,
        text: generatedItem.text,
        style_id: generatedItem.style_id,
        _source: repairedSlotIds.has(slot.slot_id) ? 'openai_repair' : 'openai_first',
      });
      continue;
    }
    logMissingSlotPhrase(slot, validationContext);
    // dropped -- no entry pushed, pack simply gets shorter.
  }
  trace.fallback = [];

  if (finalUnstyled.length === 0) {
    trace.final = [];
    trace.summary = { reason: 'all_slots_dropped' };
    recordGenerationMs(trace, generationStartMs);
    return { phrases: [], trace };
  }

  const styleDedupe = [];
  const styled = assignUniqueStyleIds(
    finalUnstyled.map(({ slot_id, text, style_id }) => ({ slot_id, text, style_id })),
    styleDedupe
  );
  trace.style_dedupe = styleDedupe;

  const sourceBySlot = new Map(finalUnstyled.map((item) => [item.slot_id, item._source]));
  const typeBySlot = new Map(packSlots.map((slot) => [slot.slot_id, slot.type]));

  trace.final = styled.map((item, index) => ({
    position: index + 1,
    slot_id: item.slot_id,
    type: typeBySlot.get(item.slot_id) || null,
    final_source: sourceBySlot.get(item.slot_id) || 'unknown',
    text: item.text,
    style_id: item.style_id,
  }));
  const finalSourceCounts = {};
  for (const item of trace.final) {
    finalSourceCounts[item.final_source] = (finalSourceCounts[item.final_source] || 0) + 1;
  }
  trace.summary = {
    planned_count: packSlots.length,
    kept_count: styled.length,
    final_source_counts: finalSourceCounts,
  };

  // Memory bookkeeping (rule 5): reuse the exact same recording calls the
  // ordinary batch path uses, at generation time, for the pack's own slots.
  // shown_categories is recorded for every KEPT slot (mirrors generateBatch,
  // which records for every PLANNED slot regardless of source -- a dropped
  // pack slot was never shown, so it's excluded here, unlike the ordinary
  // path where every planned slot always ends up shown one way or another).
  // content_memory/learning_memory are recorded only for genuinely
  // OpenAI-generated slots (openai_first/openai_repair).
  const keptSlots = packSlots.filter((slot) => sourceBySlot.has(slot.slot_id));
  const openaiSlotIds = [...sourceBySlot.entries()]
    .filter(([, source]) => source === 'openai_first' || source === 'openai_repair')
    .map(([slotId]) => slotId);
  const usedCategories = extractUsedCategoriesFromSlots(keptSlots);
  recordShownCategories(device.device_id, targetDate, usedCategories);
  recordShownContentMemory(device.device_id, keptSlots, openaiSlotIds);
  recordLearnedWords(device.device_id, keptSlots, openaiSlotIds);
  recordRecalledWords(device.device_id, keptSlots, openaiSlotIds);

  const phrases = styled.map((item) => ({
    slot_id: item.slot_id,
    type: typeBySlot.get(item.slot_id) || null,
    text: item.text,
    style_id: item.style_id,
  }));

  recordGenerationMs(trace, generationStartMs);
  return { phrases, trace };
}

/**
 * Generates a batch of {text, style_id} phrases for a device.
 * Falls back to a local static batch if no API key is configured or the
 * OpenAI call fails for any reason — the endpoint should never 500 just
 * because content generation had a bad day.
 *
 * @param {object} device - row from the devices table (or a stub {device_id})
 * @param {string} window - 'morning' | 'day' | 'evening' | 'night'
 * @param {object} [signals] - optional device signals from deviceSignals.js
 * @param {object} [weather] - optional weather from weather.js (resolveWeather)
 * @param {object} [phoneTrends] - semantic phone trends from phoneAnalytics.js
 * @returns {Promise<{phrases: Array<{text: string, style_id: string}>, source: 'openai'|'fallback'}>}
 */
async function generateBatch(device, window, signals, weather, phoneTrends = {}, options = {}) {
  // Observation-only: total wall-clock time for this batch generation
  // attempt (including any repair round) -- see recordGenerationMs()'s own
  // comment. Captured before any work, same convention as
  // generateMorningPack's own generationStartMs.
  const generationStartMs = Date.now();
  const apiKey = process.env.OPENAI_API_KEY;
  const languageCode = resolveTargetLanguageCode(signals);
  const { dateContext, unavailableReason } = resolveLocalDateContext(device.timezone, options.localDate);
  if (!dateContext && unavailableReason) {
    console.warn(`DATE_CONTEXT_UNAVAILABLE reason=${unavailableReason}`);
  }

  // Bank items are keyed by the device's own local calendar date (matches
  // device_shown_categories' "today"), not the server's UTC bank_date --
  // reuses the same getLocalCalendarDate this file already uses for
  // days-since-install. Both device.timezone and today's bank can be
  // missing/empty (new device, cron hasn't run yet) -- selectBankItemsForDevice
  // already returns [] in that case, so bankItems degrades to "no bank
  // content this batch" rather than failing.
  const deviceLocalDate = dateContext ? dateContext.date : null;
  const countryCode = weather && typeof weather.countryCode === 'string' && weather.countryCode
    ? weather.countryCode
    : signals && typeof signals.region === 'string'
      ? signals.region
      : null;
  const bankItems = selectBankItemsForDevice(
    device.device_id,
    getBankDateString(),
    deviceLocalDate,
    device.gender,
    countryCode
  );
  const recentContentMemory = getRecentContentMemory(device.device_id);
  const recallCandidate = getRecallCandidate(device.device_id);
  // excludeMorningPackTypes (morning-pack feature): a supports_morning_pack=1
  // request must never also offer the 7 pack types as ordinary batch slots,
  // in any window (see planSlots' excludeTypes option and MORNING_FIXED_TYPES'
  // own comment) -- left undefined for every pre-existing caller, which keeps
  // this a strict no-op / byte-identical path when the option is absent.
  const { slots } = planSlots({
    device,
    window,
    dateContext,
    weather,
    bankItems,
    phoneTrends,
    recallCandidate,
    signals,
  }, { recentContentMemory, excludeTypes: options.excludeMorningPackTypes ? MORNING_FIXED_TYPES : undefined });

  const context = buildContextPrompt(device, window, signals, weather, languageCode, slots, dateContext);
  const trace = buildInitialTrace(device, window, languageCode, dateContext);
  tracePlannedSlots(trace, window, slots);
  const validationContext = {
    dateContext,
    signals,
    weather,
    contextFlags: { traffic: false },
  };

  if (!apiKey) {
    return buildLoggedFallbackResult(languageCode, context, 'no_api_key_fallback', 0, trace, slots, dateContext, generationStartMs);
  }

  let response;
  let client;
  try {
    // Lazy require: avoids crashing at startup if the package is present but
    // no key is set yet, and keeps the fallback path dependency-free.
    const OpenAI = require('openai');
    client = new OpenAI({ apiKey });
    response = await createOpenAiBatch(client, context, languageCode);

  } catch (err) {
    console.error(`AI_BATCH_ERROR reason=openai_error error=${err.name || 'Error'}`);
    return buildLoggedFallbackResult(languageCode, context, 'openai_error', 0, trace, slots, dateContext, generationStartMs);
  }

  let parsed;
  try {
    parsed = parseOpenAiBatchResponse(response);
  } catch (err) {
    console.error(`AI_BATCH_ERROR reason=parse_or_schema_error error=${err.name || 'Error'}`);
    return buildLoggedFallbackResult(languageCode, context, 'parse_or_schema_error', 0, trace, slots, dateContext, generationStartMs);
  }

  let assembly;
  const firstPassTraceParts = { fallback: [], styleDedupe: [], firstPass: null };
  try {
    // dropMissing=true: see assembleBatchFromGeneratedPhrases' own comment.
    // Applies even before repair runs/completes -- if repair never fires (no
    // rejections), is skipped, or throws, this first-pass assembly is what
    // ships, and it must already reflect "drop, don't generic-fill" for any
    // slot that has no accepted text yet.
    assembly = assembleBatchFromGeneratedPhrases(parsed.phrases, languageCode, validationContext, slots, firstPassTraceParts, true);
    safeTrace(() => {
      trace.first_pass = firstPassTraceParts.firstPass || [];
    });
  } catch (err) {
    console.error(`AI_BATCH_ERROR reason=final_assembly_fallback error=${err.name || 'Error'}`);
    return buildLoggedFallbackResult(languageCode, context, 'final_assembly_fallback', 0, trace, slots, dateContext, generationStartMs);
  }

  if (!assembly) {
    return buildLoggedFallbackResult(languageCode, context, 'parse_or_schema_error', 0, trace, slots, dateContext, generationStartMs);
  }

  const repairedSlotIds = new Set();
  // B3 fix: previously gated on `assembly.generatedCount > 0` too, so a
  // batch where EVERY slot was rejected on first pass (generatedCount === 0
  // -- exactly the production incident this task investigates: 12/12
  // rejected, repair.called stayed false) never got a repair attempt at
  // all. Repair only needs at least one rejected slot to make sense; it
  // does not need any already-accepted slot to build on.
  if (assembly.rejectedSlotIds && assembly.rejectedSlotIds.length > 0) {
    try {
      const basePayload = JSON.parse(context);
      const repaired = await regenerateRejectedSlots(
        client,
        basePayload,
        slots,
        assembly.rejectedSlotIds,
        languageCode,
        validationContext,
        trace,
        assembly.rejectedDetails
      );
      if (repaired && repaired.length > 0) {
        for (const item of repaired) {
          repairedSlotIds.add(item.slot_id);
        }
        const acceptedSlotIds = new Set(assembly.generatedSlotIds);
        const merged = parsed.phrases
          .filter((phrase) => acceptedSlotIds.has(phrase.slot_id))
          .concat(repaired);
        const repairTraceParts = { fallback: [], styleDedupe: [], firstPass: [] };
        // dropMissing=true here too -- a slot still rejected after this one
        // repair round is dropped, not generic-filled (see B5/dropMissing's
        // own comment on assembleBatchFromGeneratedPhrases).
        const repairedAssembly = assembleBatchFromGeneratedPhrases(merged, languageCode, validationContext, slots, repairTraceParts, true);
        if (repairedAssembly && repairedAssembly.phrases) {
          repairedAssembly.reason = repairedAssembly.rejectedCount === 0
            ? 'success_after_slot_regeneration'
            : 'partial_slot_regeneration';
          assembly = repairedAssembly;
        }
      }
    } catch (err) {
      console.error(`AI_BATCH_ERROR reason=slot_regeneration_error error=${err.name || 'Error'}`);
    }
  }

  if (!assembly.phrases) {
    assembly.phrases = [];
    assembly.reason = assembly.reason || 'all_slots_dropped';
  }

  // Record planned daily-bank categories for this batch. With slot-based
  // generation the model no longer chooses categories; the server does, so the
  // repeat-avoidance signal comes from selected slots rather than model labels.
  const usedCategories = extractUsedCategoriesFromSlots(slots);
  recordShownCategories(device.device_id, deviceLocalDate, usedCategories);
  recordShownContentMemory(device.device_id, slots, assembly.generatedSlotIds);
  recordLearnedWords(device.device_id, slots, assembly.generatedSlotIds);
  recordRecalledWords(device.device_id, slots, assembly.generatedSlotIds);

  return buildLoggedOpenAiResult(assembly, context, trace, slots, repairedSlotIds, dateContext, generationStartMs);
}

module.exports = {
  generateBatch,
  generateMorningPack,
  resolveLocalDateContext,
  addDaysToDateString,
  _test: {
    cleanUsablePhrases,
    assembleBatchFromGeneratedPhrases,
    validateFinalBatch,
    resolveTargetLanguageCode,
    windowContextFor,
    resolveLocalDateContext,
    buildContextPrompt,
    buildSystemPrompt,
    SUPPORTED_LANGUAGES,
    LOCK_SCREEN_TEXT_MAX_LENGTH,
    buildBatchResponseFormat,
    isUnusableLockScreenText,
    rejectionReasonForText,
    collectUsablePhrases,
  },
};
