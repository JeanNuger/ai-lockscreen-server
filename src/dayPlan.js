const { STYLE_IDS: ALL_STYLE_IDS } = require('./constants');
// The app ships only the Aurora (A) and Grain wash (G) backgrounds: a style_id of a removed family (O) is
// unknown to the phone and would turn the phrase into a background-only frame.
// A9 (smoky) and G4 (graphite) are retired too (task 26): 16 backgrounds, enough for 12 different ones in a window.
const RETIRED_STYLE_IDS = new Set(['A9', 'G4']);
const STYLE_IDS = ALL_STYLE_IDS.filter((id) => /^[AG]\d$/.test(id) && !RETIRED_STYLE_IDS.has(id));
const { validateLockScreenText } = require('./textFilter');
const { loadSentArchive, findRepeat, recordSentContent, loadShownFacts, isFactShown } = require('./sentPhrases');
const { loadSeenPhrases, loadLearnedWords, deviceReportsShown } = require('./seenMemory');
const { _test: planner } = require('./slotPlanner');
const { _test: generator } = require('./contentGenerator');
const db = require('./db');

// The whole day in ONE model call (GET /api/v1/day): 4 windows x 12 phrases in the fixed order of
// PRODUCT_REBUILD_PLAN.md section 4, written as one monologue. Facts come only from the daily bank
// (src/dailyContentBank.js); jokes, thoughts, wishes, horoscope, tips and ideas are the model's own.
//
// Model: gpt-6-luna with reasoning "none" (tests 23-24). Both are env-overridable.

const MAX_LEN = 70;
const DEFAULT_MAX_CHARS = 60;
const WINDOW_ORDER = ['morning', 'day', 'evening', 'night'];
const DAY_MODEL_DEFAULT = 'gpt-6-luna';
const DAY_EFFORT_DEFAULT = 'none';
const DAY_TIMEOUT_MS = 75000;
const DAY_MAX_ATTEMPTS = 2;
const REPAIR_TIMEOUT_MS = 30000;
const DAY_MAX_COMPLETION_TOKENS = 20000;
// Pairs that always go together: if one half is missing the other is dropped (quiz question +
// answer; word of the day, see WORD_SLOTS).
const QUIZ_PAIRS = [['d4', 'd6'], ['e9', 'e11'], ['n4', 'n6']];
const WORD_SLOTS = { teach: 'm7', recall: 'n8', answer: 'n9' };
const REPAIR_EXEMPT = new Set(['greeting_name', 'goodnight_care']);

const S = (window, position, type, topic, extra = {}) => ({
  window, position, type, topic, max_chars: DEFAULT_MAX_CHARS, ...extra,
});

// The 48 slots. Changes against the plan of 30.09 (task 25):
//  - word of the day: morning 7 teaches the word and its meaning; night 8 asks "do you remember what
//    "..." means?"; night 9 answers "Right: ... is ..." (night 8 + 9 always together).
//  - the "word in other languages" slot and the morning "remember the word?" slot are gone:
//    morning 10 is an unusual fact, night 10 is the nature fact moved from night 9.
//  - holiday (morning 4): local, else international, else an interesting fact (see buildDaySlots).
//  - phone data: only morning 8, about yesterday (dropped when the phone sent nothing).
function slotDefinitions() {
  return [
    S('morning', 1, 'greeting_name', 'Warm good-morning greeting with the name.'),
    S('morning', 2, 'weather_advice', 'What to wear or take TODAY, from the weather block ("today rain - take an umbrella"). Advice only, no numbers.'),
    S('morning', 3, 'horoscope', 'Light, kind note for the zodiac sign. No health/money/fate predictions.'),
    S('morning', 4, 'holiday', 'Holiday today, from the item given in "bank_item" (use exactly that item).'),
    S('morning', 5, 'on_this_day', '"On this day in <year> ..." from bank category on_this_day.', { bank: 'on_this_day' }),
    S('morning', 6, 'numerology', 'Name the personal day number and its light meaning today.'),
    S('morning', 7, 'word_of_day', 'Teach a rare but real word of the user\'s language and its meaning, in one phrase (your own choice, not in already_seen / learned_words). Also return it in "word_of_day".'),
    S('morning', 8, 'phone_yesterday', 'ONE recap of yesterday from the phone block, e.g. "yesterday you walked a lot - repeat it?". No numbers, friendly, not judging; do not say "data".'),
    S('morning', 9, 'quote', 'A short quote with its author, from bank category quote.', { bank: 'quote' }),
    S('morning', 10, 'unusual_fact', 'An unusual fact, bank category unusual.', { bank: 'unusual' }),
    S('morning', 11, 'lifehack', 'One concrete, slightly surprising, doable trick.'),
    S('morning', 12, 'warm_wish', 'One sincere, specific wish for the day ahead.'),

    S('day', 1, 'humor', 'Your own light, clever everyday joke.'),
    S('day', 2, 'science_fact', 'Bank category science.', { bank: 'science' }),
    S('day', 3, 'country_fact', 'Fact about Kazakhstan, bank category country_kz.', { bank: 'country_kz' }),
    S('day', 4, 'quiz_question', 'A quiz question on a bank fact of category animals or nature. The answer comes in day slot 6.'),
    S('day', 5, 'number_of_day', 'One surprising number with what it means; from a bank fact that contains a number.', { bank: 'any' }),
    S('day', 6, 'quiz_answer', 'The answer to day slot 4: one or two words, nothing else.', { max_chars: 30, ref: 'd4' }),
    S('day', 7, 'word_origin', 'Where a word came from, bank category word_origin.', { bank: 'word_origin' }),
    S('day', 8, 'animal_fact', 'Bank category animals.', { bank: 'animals' }),
    S('day', 9, 'tech_fact', 'Bank category tech.', { bank: 'tech' }),
    S('day', 10, 'money_simple', 'Money in simple words, bank category money.', { bank: 'money' }),
    S('day', 11, 'brain_psychology', 'Bank category brain.', { bank: 'brain' }),
    S('day', 12, 'thought', 'A thought of your own, fresh angle, not a poster slogan.'),

    S('evening', 1, 'good_news', 'Bank category good_news.', { bank: 'good_news' }),
    S('evening', 2, 'animal_fact', 'Another animal fact, bank category animals (a different one from day 8).', { bank: 'animals' }),
    S('evening', 3, 'unusual_fact', 'Bank category unusual (a different one from morning 10).', { bank: 'unusual' }),
    S('evening', 4, 'gender_tip', 'A tip for the user\'s gender (profile gender). No stereotypes, no lecturing.'),
    S('evening', 5, 'space_fact', 'Bank category space.', { bank: 'space' }),
    S('evening', 6, 'born_today', 'Start "On this day was born ..." (in the user\'s language) - one person from bank category born_today. Never "today was born".', { bank: 'born_today' }),
    S('evening', 7, 'city_fact', 'Fact about the user\'s city (Astana), bank category city_astana.', { bank: 'city_astana' }),
    S('evening', 8, 'dinner_idea', 'A dinner idea that takes 15 minutes. Concrete dish.'),
    S('evening', 9, 'quiz_question', 'A quiz question on a bank fact of category tech, space or how_it_works (a different topic and answer from day 4). The answer comes in evening slot 11.'),
    S('evening', 10, 'how_it_works', 'How something familiar works, bank category how_it_works.', { bank: 'how_it_works' }),
    S('evening', 11, 'quiz_answer', 'The answer to evening slot 9: one or two words, nothing else.', { max_chars: 30, ref: 'e9' }),
    S('evening', 12, 'evening_idea', 'An idea of how to spend the evening.'),

    S('night', 1, 'humor', 'A calm joke of your own that plays on the evening idea (evening slot 12).', { ref: 'e12' }),
    S('night', 2, 'science_fact', 'A second science fact, bank category science (a different one from day 2).', { bank: 'science' }),
    S('night', 3, 'watch_or_read', 'What to watch or read: one real, well-known title with a few words on why.'),
    S('night', 4, 'quiz_question', 'A quiz question on a bank fact of category unusual, tradition or word_origin (a different topic and answer from the other quizzes). The answer comes in night slot 6.'),
    S('night', 5, 'tradition', 'An unusual tradition of another country, bank category tradition.', { bank: 'tradition' }),
    S('night', 6, 'quiz_answer', 'The answer to night slot 4: one or two words, nothing else.', { max_chars: 30, ref: 'n4' }),
    S('night', 7, 'poetic_thought', 'A quiet poetic image, gentle, not pompous.'),
    S('night', 8, 'word_recall', 'Ask, do not answer: "Do you remember what “<the word of morning slot 7>” means?" in the user\'s language.', { ref: 'm7' }),
    S('night', 9, 'word_answer', 'The answer to night slot 8: "Right: <word> is <meaning>" in the user\'s language.', { ref: 'm7' }),
    S('night', 10, 'nature_fact', 'Bank category nature.', { bank: 'nature' }),
    S('night', 11, 'tomorrow_task', 'One small doable thing for tomorrow (here "tomorrow" is allowed).'),
    S('night', 12, 'goodnight_care', '"Good night" with the name; may return to the morning wish (morning slot 12).', { ref: 'm12' }),
  ].map((slot, index) => ({
    slot_id: `${slot.window[0]}${slot.position}`,
    order: index + 1,
    ...slot,
  }));
}

// Local holiday (item tagged with the user's country) -> international day ("global") -> null.
// Items are daily_content_bank rows {id, category, content_text, tags}.
function pickHoliday(bankRows, countryCode) {
  const holidays = (bankRows || []).filter((row) => row.category === 'holiday');
  const country = typeof countryCode === 'string' ? countryCode.toUpperCase() : null;
  const tagsOf = (row) => (Array.isArray(row.tags) ? row.tags : parseTagsLoose(row.tags));
  const local = country ? holidays.filter((row) => tagsOf(row).includes(country)) : [];
  if (local.length > 0) {
    return { row: local[0], kind: 'local' };
  }
  const international = holidays.filter((row) => tagsOf(row).includes('global'));
  if (international.length > 0) {
    return { row: international[0], kind: 'international' };
  }
  return null;
}

function parseTagsLoose(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

// The slots of one device's day. Drops slots that have nothing to stand on: the weather advice
// without a forecast, the phone recap without phone data. The holiday slot takes the local holiday,
// else the international day, else becomes an interesting fact from the bank (type unusual_fact,
// holiday_replaced = true), so a "no holiday today" phrase can never be written.
function buildDaySlots({ holiday, hasWeather, hasPhone }) {
  const slots = [];
  let holidayReplaced = false;
  for (const def of slotDefinitions()) {
    if (def.type === 'weather_advice' && !hasWeather) continue;
    if (def.type === 'phone_yesterday' && !hasPhone) continue;
    if (def.type === 'holiday') {
      if (holiday) {
        slots.push({ ...def, bank_item: { id: `b${holiday.row.id}`, text: holiday.row.content_text }, holiday_kind: holiday.kind });
      } else {
        holidayReplaced = true;
        slots.push({
          ...def,
          type: 'unusual_fact',
          topic: 'An interesting, surprising fact from the bank, category unusual or science (not the same as other slots).',
          bank: 'unusual',
          holiday_replaced: true,
        });
      }
      continue;
    }
    slots.push({ ...def });
  }
  slots.holidayReplaced = holidayReplaced;
  return slots;
}

// ---- model input ----

function computeAge(birthDate) {
  const dob = birthDate ? new Date(birthDate) : null;
  if (!dob || Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDay = (now.getUTCMonth() - dob.getUTCMonth()) || (now.getUTCDate() - dob.getUTCDate());
  if (monthDay < 0) age -= 1;
  return age >= 0 ? age : null;
}

// Bands only, never exact temperatures (plan section 2: weather = advice, no digits).
function weatherForPayload(weather) {
  const built = weather && weather.forecast === true ? planner.buildForecastWeatherLifehack(weather) : null;
  if (!built) return null;
  const f = built.facts;
  const out = {};
  for (const key of ['day_temp_band', 'morning_temp_band', 'rain_chance', 'uv_level', 'condition_lean']) {
    if (f[key]) out[key] = f[key];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function dayInstructions(languageName) {
  return `You are the voice of a kind, clever AI that lives on the user's phone lock screen. Every glance at the phone shows one short line. You entertain, inform, support, teach and notice things, like a smart warm friend — never a motivational poster or a textbook.

THE DAY IS ONE MONOLOGUE
- This is one day of one conversation with one person. You write all of it in one go: 4 windows (morning, day, evening, night) x 12 phrases, in the fixed slot order you receive.
- Make 3–4 callbacks during the day: in the evening or at night come back to something said in the morning or day (the morning wish, the evening idea turning into a night joke about it, and so on). Mark each callback in the "echoes" field of the later phrase with the slot_id it returns to; otherwise "". Never repeat a text; a callback is a new line that plays on the earlier one.
- Phone data is for yesterday only and is used once, in the morning slot "phone_yesterday". Do not mention the phone anywhere else.
- Advice to rest or sleep: at most ONE in the whole day and only with a clear reason in the data. Otherwise none.
- Tone by window: morning — a fresh start; day — light, curious; evening — calmer, cultural; night — quiet and warm.

TIME
- Write as the person will read it at that moment. The planned date is TODAY for them: say "today" / "this morning", never "tomorrow" (morning weather: "today rain — take an umbrella"). "Tomorrow" (and words derived from it, like "tomorrow's") is allowed only in the night slot "tomorrow_task".

LANGUAGE AND VOICE
- Write natively in ${languageName}. Never translate word for word. Translate every name (holidays, people, places, titles) into that language and write it in that language's script.
- Address the user informally. Use the name only in greeting, the goodnight slot and at most two other phrases.
- Never talk about yourself, never say you are an AI. No lecturing, no commands (except weather advice). No exact temperatures. No empty truisms: after reading, the user learned something, smiled, got a concrete tip, or felt a sincere warm word.
- Never mention the words "list", "bank", "data", "according to data", "source" or anything about where the facts came from.
- Jokes, thoughts, wishes, horoscope, tips, ideas are your own; do not translate jokes or quotes literally.

FACTS
- Facts (science, history, animals, space, holidays, people, traditions, quotes, etc.) come ONLY from "bank" (use the item's meaning; the bank_id field of your answer is the id of the item you used, or "" if the slot is your own). Never invent facts, names, dates or numbers.
- A bank text is raw material, not text to translate: retell it briefly in your own words, keep the one striking detail. Do not use the same bank item twice in this day.
- The holiday slot comes with its own "bank_item": use exactly that item and return its id. Never write that there is no holiday.
- Born-today slot: start with "on this day was born ..." in the user's language, never "today was born".
- Quizzes: the three quizzes of the day have different topics and different answers. The question must be answerable from the bank fact; the answer slot gives just the answer.
- Word of the day: morning slot "word_of_day" teaches one rare real word of the user's language with its meaning; return the bare word in "word_of_day". Night slot "word_recall" asks "do you remember what «word» means?" and night slot "word_answer" answers "Right: word — meaning" (both in the user's language, naming the same word).
- "already_seen" (last 3 days) and "learned_words" are what the user already read and learned: do not repeat those facts, jokes, ideas or words, even in different words.
- Slots with "ref" refer to an earlier slot of this day; slots with "bank": a category name — pick an item of that category (for "any": any category except holiday and born_today).

LENGTH
- Every slot has "max_chars" (60; 30 for one-word quiz answers): never exceed it, counting spaces. Aim for 40–55 characters. The absolute limit is ${MAX_LEN}, longer phrases are discarded. Count before answering; if over, drop details, never cut the end of a thought.

OUTPUT
Only JSON matching the schema: one phrase per slot, in slot order, with slot_id, text, bank_id and echoes; plus "word_of_day".`;
}

function dayResponseFormat(count) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'lock_screen_day',
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
                text: { type: 'string' },
                bank_id: { type: 'string' },
                echoes: { type: 'string' },
              },
              required: ['slot_id', 'text', 'bank_id', 'echoes'],
              additionalProperties: false,
            },
          },
          word_of_day: { type: 'string' },
        },
        required: ['phrases', 'word_of_day'],
        additionalProperties: false,
      },
    },
  };
}

function repairResponseFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'lock_screen_day_repair',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          phrases: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                slot_id: { type: 'string' },
                text: { type: 'string' },
                bank_id: { type: 'string' },
                echoes: { type: 'string' },
              },
              required: ['slot_id', 'text', 'bank_id', 'echoes'],
              additionalProperties: false,
            },
          },
          word_of_day: { type: 'string' },
        },
        required: ['phrases', 'word_of_day'],
        additionalProperties: false,
      },
    },
  };
}

function bankIdOf(row) {
  return `b${row.id}`;
}

function buildDayPayload({ device, languageCode, dateContext, weatherBands, phoneYesterday, bankRows, slots, seenPhrases, learnedWords, countryCode }) {
  const profile = {};
  if (device.name) profile.name = device.name;
  if (device.gender) profile.gender = device.gender;
  const age = computeAge(device.birth_date);
  if (age !== null) profile.age = age;
  const zodiac = planner.zodiacSignForBirthDate(device.birth_date);
  if (zodiac) profile.zodiac = zodiac;
  const personalDay = dateContext ? planner.personalDayNumberForBirthDate(device.birth_date, dateContext.date) : null;
  if (personalDay) profile.numerology = { personal_day_number: personalDay };
  if (device.city_name) profile.city = device.city_name;
  if (countryCode) profile.country = countryCode;

  const payload = {
    lang: languageCode,
    date: dateContext ? dateContext.date : undefined,
    weekday: dateContext ? dateContext.weekday : undefined,
    profile,
    weather_today: weatherBands || undefined,
    phone_yesterday: phoneYesterday || undefined,
    bank: bankRows.map((row) => ({
      id: bankIdOf(row),
      category: row.category,
      country: (Array.isArray(row.tags) ? row.tags : parseTagsLoose(row.tags))[0] || '',
      text: row.content_text,
    })),
    learned_words: learnedWords,
    slots: slots.map((slot) => {
      const out = {
        slot_id: slot.slot_id,
        window: slot.window,
        type: slot.type,
        topic: slot.topic,
        max_chars: slot.max_chars,
      };
      if (slot.bank) out.bank = slot.bank;
      if (slot.ref) out.ref = slot.ref;
      if (slot.bank_item) out.bank_item = slot.bank_item;
      return out;
    }),
    // Last: the variable, per-device part (what this person already read).
    already_seen: seenPhrases,
  };
  return payload;
}

// ---- model call ----

let clientFactory = null;

function getClient() {
  if (clientFactory) {
    return clientFactory();
  }
  const OpenAI = require('openai');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function dayModel() {
  return process.env.OPENAI_DAY_MODEL || DAY_MODEL_DEFAULT;
}

function dayEffort() {
  return String(process.env.OPENAI_DAY_REASONING_EFFORT || DAY_EFFORT_DEFAULT).trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  const status = err && typeof err.status === 'number' ? err.status : null;
  return status === null || status === 429 || (status >= 500 && status < 600);
}

// Same line as the batch's usage log, one per call (scope=day, scope=day_repair).
function logDayUsage(scope, response) {
  const usage = response && response.usage;
  if (!usage) return null;
  const cached = usage.prompt_tokens_details && Number.isFinite(usage.prompt_tokens_details.cached_tokens)
    ? usage.prompt_tokens_details.cached_tokens : 0;
  const reasoning = usage.completion_tokens_details && Number.isFinite(usage.completion_tokens_details.reasoning_tokens)
    ? usage.completion_tokens_details.reasoning_tokens : 0;
  console.log(`OPENAI_USAGE scope=${scope} model=${dayModel()} prompt_tokens=${usage.prompt_tokens} completion_tokens=${usage.completion_tokens} reasoning_tokens=${reasoning} total_tokens=${usage.total_tokens} cached_tokens=${cached} reasoning_effort=${dayEffort()}`);
  return { prompt: usage.prompt_tokens, completion: usage.completion_tokens, reasoning };
}

async function callModel(messages, responseFormat, timeoutMs) {
  const params = {
    model: dayModel(),
    messages,
    response_format: responseFormat,
    max_completion_tokens: DAY_MAX_COMPLETION_TOKENS,
    reasoning_effort: dayEffort(),
  };
  return getClient().chat.completions.create(params, { timeout: timeoutMs, maxRetries: 0 });
}

function parseDayResponse(response) {
  const content = response && response.choices && response.choices[0] && response.choices[0].message
    && response.choices[0].message.content;
  const parsed = JSON.parse(content);
  if (!parsed || !Array.isArray(parsed.phrases)) {
    throw new Error('response did not contain phrases array');
  }
  return parsed;
}

async function callDayWithRetry(messages, count) {
  let lastErr = null;
  for (let attempt = 1; attempt <= DAY_MAX_ATTEMPTS; attempt += 1) {
    const startedMs = Date.now();
    try {
      const response = await callModel(messages, dayResponseFormat(count), DAY_TIMEOUT_MS);
      const usage = logDayUsage('day', response);
      const parsed = parseDayResponse(response);
      console.log(`OPENAI_ATTEMPT scope=day result=success attempt=${attempt}/${DAY_MAX_ATTEMPTS} duration_ms=${Date.now() - startedMs}`);
      return { parsed, usage, ms: Date.now() - startedMs };
    } catch (err) {
      lastErr = err;
      console.error(`OPENAI_ATTEMPT scope=day result=error attempt=${attempt}/${DAY_MAX_ATTEMPTS} duration_ms=${Date.now() - startedMs} err_name=${err.name || 'Error'} err_status=${err.status || 'none'} err_message="${String(err.message || '').replace(/\s+/g, ' ').slice(0, 200)}"`);
      const retry = err instanceof SyntaxError || err.message === 'response did not contain phrases array' || isRetryable(err);
      if (!retry || attempt === DAY_MAX_ATTEMPTS) break;
      await sleep(1000);
    }
  }
  throw lastErr || new Error('openai_retry_exhausted');
}

// ---- validation ----

function languageOk(text, languageCode) {
  const language = generator.SUPPORTED_LANGUAGES[languageCode];
  return !language || language.scriptCheck.test(text);
}

// Returns a reason string or null. Hard checks only (length, empty, exact repeat of something already
// sent to this device, wrong script); style and meaning are the model's job.
function rejectionReason(text, slot, languageCode, archive) {
  const result = validateLockScreenText(text, { maxLength: MAX_LEN, slotType: slot.type });
  if (!result.ok) return result.detail || result.reason;
  if (!languageOk(text, languageCode)) return 'wrong_language';
  if (findRepeat(archive, text, REPAIR_EXEMPT.has(slot.type) ? slot.type : null)) return 'repeat_of_sent';
  return null;
}

// Slots that must be rewritten together with a rejected one, so a pair stays consistent.
function repairGroup(slotId, slotIds) {
  // A rejected word recall/answer is rewritten as a pair (the taught word itself stays); a rejected
  // teaching phrase takes the whole word trio with it.
  const groups = [...QUIZ_PAIRS, [WORD_SLOTS.recall, WORD_SLOTS.answer],
    [WORD_SLOTS.teach, WORD_SLOTS.recall, WORD_SLOTS.answer]];
  const out = new Set([slotId]);
  for (const group of groups) {
    if (group.includes(slotId) && (group[0] !== WORD_SLOTS.teach || slotId === WORD_SLOTS.teach)) {
      group.forEach((id) => slotIds.has(id) && out.add(id));
    }
  }
  return [...out];
}

async function repairRejected({ rejected, accepted, slotsById, languageName, payloadBase, languageCode, archive }) {
  const slotIds = new Set(slotsById.keys());
  const group = new Set();
  for (const slotId of Object.keys(rejected)) repairGroup(slotId, slotIds).forEach((id) => group.add(id));
  const items = [...group].map((slotId) => {
    const slot = slotsById.get(slotId);
    const item = {
      slot_id: slotId,
      type: slot.type,
      topic: slot.topic,
      max_chars: slot.max_chars,
    };
    if (slot.bank_item) item.bank_item = slot.bank_item;
    if (slot.ref && accepted[slot.ref]) item.referenced_phrase = accepted[slot.ref].text;
    if (rejected[slotId]) {
      item.original_text = rejected[slotId].text;
      item.rejection_reason = rejected[slotId].reason;
    } else if (accepted[slotId]) {
      item.keep_consistent_with_original_text = accepted[slotId].text;
    }
    return item;
  });
  const messages = [
    {
      role: 'system',
      content: `Rewrite the listed lock-screen phrases in ${languageName}. For each slot with "rejection_reason": fix exactly that problem and keep the meaning (too_long: shorten to max_chars, drop details, never cut the end of a thought; repeat_of_sent: say it differently; wrong_language: write it in the right language). A slot with "keep_consistent_with_original_text" is the other half of a pair: rewrite it to fit its partner. Do not repeat original_text. Facts only from the given bank_item/bank, never invented. Return JSON: phrases (one per slot, with slot_id, text, bank_id, echoes) and word_of_day (the word of the day if the word slots are included, else "").`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        lang: payloadBase.lang,
        profile: payloadBase.profile,
        bank: payloadBase.bank,
        learned_words: payloadBase.learned_words,
        slots: items,
        already_seen: payloadBase.already_seen,
      }),
    },
  ];
  const startedMs = Date.now();
  const response = await callModel(messages, repairResponseFormat(), REPAIR_TIMEOUT_MS);
  const usage = logDayUsage('day_repair', response);
  const parsed = parseDayResponse(response);
  const fixed = new Map();
  for (const item of parsed.phrases) {
    if (item && typeof item.slot_id === 'string' && group.has(item.slot_id) && typeof item.text === 'string') {
      fixed.set(item.slot_id, item);
    }
  }
  return { fixed, word: typeof parsed.word_of_day === 'string' ? parsed.word_of_day.trim() : '', usage, ms: Date.now() - startedMs, requested: group.size };
}

// ---- styles ----

// One style per phrase, different inside a window (12 phrases, 27 styles), and the first style of a
// window differs from the last of the previous one.
function assignStyleIds(phrases, rng = Math.random) {
  const result = [];
  let previous = null;
  for (const window of WINDOW_ORDER) {
    const inWindow = phrases.filter((p) => p.window === window);
    const pool = STYLE_IDS.slice();
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    if (previous && pool[0] === previous) pool.push(pool.shift());
    inWindow.forEach((phrase, i) => result.push({ ...phrase, style_id: pool[i % pool.length] }));
    if (inWindow.length > 0) previous = pool[(inWindow.length - 1) % pool.length];
  }
  return result;
}

// ---- generation ----

/**
 * Generates one device's whole day.
 *
 * input: { device, languageCode, dateContext, weather, countryCode, phoneYesterday, bank: { rows } }
 * Returns { phrases, source, reason?, word, dropped, usage, repair, slots } where phrases are
 * [{ slot_id, window, position, type, text, style_id, requires_shown_text? }]. Never throws; a failed
 * call returns { phrases: [], source: 'fallback', reason } (nothing is substituted: an empty day
 * is better than a made-up one).
 */
async function generateDay(input) {
  const startedMs = Date.now();
  const { device, languageCode, dateContext, weather, countryCode, phoneYesterday } = input;
  const languageName = (generator.SUPPORTED_LANGUAGES[languageCode] || generator.SUPPORTED_LANGUAGES.en).name;
  const fail = (reason) => ({ phrases: [], source: 'fallback', reason, word: null, dropped: [], usage: null, repair: null, slots: [] });

  if (!process.env.OPENAI_API_KEY && !clientFactory) {
    return fail('no_api_key');
  }

  // Bank rows this device may use: not already shown to it (hard filter), no leftover holiday rows
  // other than through the holiday slot.
  const shownFacts = loadShownFacts(device.device_id);
  // "NONE:" rows are the model's notes that a required day does not exist (parseBankItems never stores them);
  // ignored here too, so that a note can never be shown as a holiday.
  const allRows = ((input.bank && input.bank.rows) || []).filter((row) => !/^none:/i.test(String(row.content_text || '')));
  const holiday = pickHoliday(allRows, countryCode);
  const usableRows = allRows
    .filter((row) => !isFactShown(shownFacts, row.category, row.content_text))
    .filter((row) => row.category !== 'holiday');
  const holidayUsable = holiday && !isFactShown(shownFacts, 'holiday', holiday.row.content_text) ? holiday : null;

  const weatherBands = weatherForPayload(weather);
  const slots = buildDaySlots({ holiday: holidayUsable, hasWeather: Boolean(weatherBands), hasPhone: Boolean(phoneYesterday) });
  const slotsById = new Map(slots.map((slot) => [slot.slot_id, slot]));

  const payloadBase = buildDayPayload({
    device,
    languageCode,
    dateContext,
    weatherBands,
    phoneYesterday,
    bankRows: usableRows.concat(holidayUsable ? [holidayUsable.row] : []),
    slots,
    seenPhrases: loadSeenPhrases(device.device_id),
    learnedWords: loadLearnedWords(device.device_id),
    countryCode,
  });
  const messages = [
    { role: 'system', content: dayInstructions(languageName) },
    { role: 'user', content: JSON.stringify(payloadBase) },
  ];

  let first;
  try {
    first = await callDayWithRetry(messages, slots.length);
  } catch (err) {
    return fail(err instanceof SyntaxError ? 'parse_or_schema_error' : 'openai_error');
  }

  const archive = loadSentArchive(device.device_id);
  const accepted = {};
  const rejected = {};
  const answered = new Set();
  let word = typeof first.parsed.word_of_day === 'string' ? first.parsed.word_of_day.trim() : '';
  for (const item of first.parsed.phrases) {
    const slot = item && slotsById.get(item.slot_id);
    if (!slot || answered.has(item.slot_id) || typeof item.text !== 'string') continue;
    answered.add(item.slot_id);
    const text = item.text.trim();
    const reason = rejectionReason(text, slot, languageCode, archive);
    const entry = { text, bank_id: typeof item.bank_id === 'string' ? item.bank_id : '', echoes: typeof item.echoes === 'string' ? item.echoes : '' };
    if (reason) rejected[item.slot_id] = { ...entry, reason };
    else accepted[item.slot_id] = entry;
  }
  // A slot the model skipped entirely is missing, not rejected: it is dropped (no repair for it).
  const missing = slots.filter((slot) => !answered.has(slot.slot_id)).map((slot) => slot.slot_id);

  // ONE repair call for everything rejected (too long, repeat, wrong script) plus the other half of
  // its pair, as the plan asks. Whatever is still bad afterwards is dropped.
  let repair = null;
  if (Object.keys(rejected).length > 0) {
    const originalRejectedCount = Object.keys(rejected).length;
    try {
      const outcome = await repairRejected({ rejected, accepted, slotsById, languageName, payloadBase, languageCode, archive });
      repair = { rejected: originalRejectedCount, requested: outcome.requested, usage: outcome.usage, ms: outcome.ms };
      if (outcome.word && slotsById.has(WORD_SLOTS.teach) && (rejected[WORD_SLOTS.teach] || outcome.fixed.has(WORD_SLOTS.teach))) {
        word = outcome.word;
      }
      for (const [slotId, item] of outcome.fixed) {
        const slot = slotsById.get(slotId);
        const text = item.text.trim();
        const reason = rejectionReason(text, slot, languageCode, archive);
        delete accepted[slotId];
        if (reason) {
          rejected[slotId] = { text, bank_id: item.bank_id || '', echoes: item.echoes || '', reason };
        } else {
          delete rejected[slotId];
          accepted[slotId] = { text, bank_id: typeof item.bank_id === 'string' ? item.bank_id : '', echoes: typeof item.echoes === 'string' ? item.echoes : '' };
        }
      }
    } catch (err) {
      console.error(`OPENAI_ATTEMPT scope=day_repair result=error err_name=${err.name || 'Error'} err_status=${err.status || 'none'}`);
      repair = { rejected: originalRejectedCount, error: true };
    }
  }

  // Pairs. A quiz question and its answer stand or fall together. Night 8 + 9 (the word recall
  // and its answer) are always together and need the word taught in the morning (morning 7).
  const dropped = [];
  const drop = (slotId, reason) => {
    if (accepted[slotId]) {
      delete accepted[slotId];
      dropped.push({ slot_id: slotId, reason });
    }
  };
  for (const slotId of Object.keys(rejected)) dropped.push({ slot_id: slotId, reason: rejected[slotId].reason });
  for (const slotId of missing) dropped.push({ slot_id: slotId, reason: 'missing' });
  for (const [a, b] of QUIZ_PAIRS) {
    if (!accepted[a] || !accepted[b]) {
      drop(a, 'pair_incomplete');
      drop(b, 'pair_incomplete');
    }
  }
  if (!accepted[WORD_SLOTS.recall] || !accepted[WORD_SLOTS.answer]) {
    drop(WORD_SLOTS.recall, 'pair_incomplete');
    drop(WORD_SLOTS.answer, 'pair_incomplete');
  }
  if (slotsById.has(WORD_SLOTS.teach) && !accepted[WORD_SLOTS.teach]) {
    drop(WORD_SLOTS.recall, 'word_not_taught');
    drop(WORD_SLOTS.answer, 'word_not_taught');
    word = '';
  }
  if (dropped.length > 0) {
    console.warn(`DAY_SLOTS_DROPPED device_id=${device.device_id} ${dropped.map((d) => `${d.slot_id}:${d.reason}`).join(' ')}`);
  }

  // The word the person was taught today ("" if the teaching phrase did not survive).
  const wordTaught = accepted[WORD_SLOTS.teach] ? (word || accepted[WORD_SLOTS.teach].text) : null;

  const bankTextById = new Map(payloadBase.bank.map((row) => [row.id, row.text]));
  const taughtText = accepted[WORD_SLOTS.teach] ? accepted[WORD_SLOTS.teach].text : null;
  const ordered = slots
    .filter((slot) => accepted[slot.slot_id])
    .map((slot) => {
      const item = {
        slot_id: slot.slot_id,
        window: slot.window,
        position: slot.position,
        type: slot.type,
        text: accepted[slot.slot_id].text,
      };
      // The phone (and the server on later requests) may skip the word recall if the morning
      // word was never actually shown.
      if (taughtText && (slot.slot_id === WORD_SLOTS.recall || slot.slot_id === WORD_SLOTS.answer)) {
        item.requires_shown_text = taughtText;
      }
      return item;
    });
  const phrases = assignStyleIds(ordered);

  // Memory: the bank facts really used (so they are not offered again) and the sent texts (exact-repeat archive).
  const factSlots = slots
    .filter((slot) => accepted[slot.slot_id] && accepted[slot.slot_id].bank_id && bankTextById.has(accepted[slot.slot_id].bank_id))
    .map((slot) => ({
      slot_id: slot.slot_id,
      type: slot.type,
      source: 'daily_bank',
      facts: { text: bankTextById.get(accepted[slot.slot_id].bank_id) },
    }));
  const factSlotIds = new Set(factSlots.map((slot) => slot.slot_id));
  recordSentContent(device.device_id, factSlots.concat(slots.filter((slot) => !factSlotIds.has(slot.slot_id))), phrases);
  if (wordTaught && dateContext) {
    db.prepare('INSERT INTO device_learning_memory (device_id, word_key, word_text, learned_local_date) VALUES (?, ?, ?, ?)')
      .run(device.device_id, `day:${dateContext.date}`, wordTaught, dateContext.date);
  }

  const echoes = slots.filter((slot) => accepted[slot.slot_id] && accepted[slot.slot_id].echoes)
    .map((slot) => `${slot.slot_id}->${accepted[slot.slot_id].echoes}`);
  return {
    phrases,
    source: 'openai',
    word: wordTaught,
    dropped,
    echoes,
    usage: first.usage,
    repair,
    slots,
    generation_ms: Date.now() - startedMs,
    model_ms: first.ms,
    holiday_kind: holidayUsable ? holidayUsable.kind : 'replaced_by_fact',
  };
}

// ---- serving ----

const wordWasShownStatement = db.prepare('SELECT 1 FROM shown_phrases WHERE device_id = ? AND text = ? LIMIT 1').pluck();

// The night word recall (night 8 + 9) is shown only if the morning word was really shown. For a device
// that reports shown phrases, a plan requested at or after `afterTime` (local, HH:MM; the morning is
// over) loses the pair when the morning word is not among its reports. Before that time the pair stays
// (nothing could have been shown yet) and carries requires_shown_text so the phone can apply the same rule.
// A device that never reports (older app) keeps the pair.
function applyWordPairRule(phrases, deviceId, localTime, afterTime = '15:00') {
  const pair = phrases.filter((p) => p.requires_shown_text);
  if (pair.length === 0 || !deviceReportsShown(deviceId)) {
    return phrases;
  }
  if (typeof localTime === 'string' && localTime >= afterTime && wordWasShownStatement.get(deviceId, pair[0].requires_shown_text) !== 1) {
    return phrases.filter((p) => !p.requires_shown_text);
  }
  return phrases;
}

module.exports = {
  MAX_LEN,
  QUIZ_PAIRS,
  WORD_SLOTS,
  slotDefinitions,
  buildDaySlots,
  pickHoliday,
  generateDay,
  applyWordPairRule,
  assignStyleIds,
  _test: {
    setClientFactory(factory) {
      clientFactory = factory;
    },
    dayInstructions,
    buildDayPayload,
    rejectionReason,
    weatherForPayload,
    dayResponseFormat,
  },
};
