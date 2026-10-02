// TEST ONLY (task 24, v3 of scripts/daily-test.js: fixed day and bank instructions, gpt-6-luna variants)
// (task 23 text follows): "whole day in one call" scheme. Nothing here is wired into the server.
//
//   node scripts/daily-test.js probe              tiny call per model (checks parameters, ~cents)
//   node scripts/daily-test.js bank               builds bank v2 once (web search, shared by all models)
//   node scripts/daily-test.js day <model> <run>  one 48-phrase day for one model
//   node scripts/daily-test.js report             writes the per-model files and the summary table
//
// The OpenAI key comes from the local .env and is never printed. Every call is added to a spend
// ledger (OUT_DIR/ledger.json); a call is refused once the total reaches BUDGET_USD.
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const OpenAI = require('openai');

const OUT_DIR = process.env.DAILY_TEST_OUT || 'C:\\reports\\daily_test_2026-10-03';
const TODAY = '2026-10-02';
const TARGET_DATE = '2026-10-03'; // the day that is being planned (tomorrow)
const BUDGET_USD = 3;
const MAX_LEN = 70;

// Prices per 1M tokens, standard tier, from developers.openai.com/api/docs/pricing (2026-10-02).
const PRICES = {
  'gpt-5-mini': { in: 0.25, out: 2 },
  'gpt-6-astra': { in: 10, out: 50 },
  'gpt-6-luna': { in: 0.1, out: 0.5 },
  'gpt-6.1-sol': { in: 2, out: 10 },
  'gpt-4o': { in: 2.5, out: 10 },
};
const BATCH_DISCOUNT = 0.5;
// Reasoning depth per model: the cheapest allowed for the "strongest" model, none for the
// non-reasoning writer, the production setting (low) for the current one.
const VARIANTS = { L0: { model: 'gpt-6-luna', effort: 'none' }, L1: { model: 'gpt-6-luna', effort: 'low' } };

const COUNTRIES = ['KZ', 'RU', 'UZ', 'KG', 'BY', 'UA', 'AZ', 'AM', 'GE', 'TJ', 'TM', 'MD'];

const BANK_CATEGORIES = [
  'holiday', 'on_this_day', 'born_today', 'good_news',
  'science', 'animals', 'space', 'nature', 'tech', 'unusual', 'country_kz', 'city_astana',
  'money', 'brain', 'word_origin', 'tradition', 'how_it_works', 'quote',
];

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = (name) => path.join(OUT_DIR, name);
const readJson = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch (e) { return fallback; }
};
const writeJson = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value, null, 2));

// ---------- spend ledger ----------
function ledger() { return readJson('ledger.json', { calls: [] }); }
function spent() { return ledger().calls.reduce((s, c) => s + c.usd, 0); }
function costOf(model, inTok, outTok) {
  const p = PRICES[model];
  return (inTok * p.in + outTok * p.out) / 1e6;
}
function record(label, model, usage) {
  const inTok = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outTok = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const reasoning = (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens)
    || (usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens) || 0;
  const entry = { label, model, in: inTok, out: outTok, reasoning, usd: costOf(model, inTok, outTok) };
  const l = ledger();
  l.calls.push(entry);
  writeJson('ledger.json', l);
  return entry;
}
function guardBudget(nextEstimate) {
  const total = spent();
  if (total + nextEstimate > BUDGET_USD) {
    console.error(`BUDGET STOP: spent $${total.toFixed(3)}, next call ~$${nextEstimate.toFixed(2)}, limit $${BUDGET_USD}`);
    process.exit(2);
  }
}

function client() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing in .env');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 300000 });
}

// ---------- profile and inputs ----------
const PROFILE = {
  name: 'Баур', gender: 'male', birth_date: '1990-02-05', age: 36, zodiac: 'Aquarius',
  city: 'Астана', country: 'KZ', language: 'ru',
};
function reduceNum(n) { // numerology reduction (keeps 11, 22)
  while (n > 9 && n !== 11 && n !== 22) n = String(n).split('').reduce((a, d) => a + Number(d), 0);
  return n;
}
function numerology() {
  const personalYear = reduceNum(5 + 2 + reduceNum(2026));
  const personalMonth = reduceNum(personalYear + 10);
  return { personal_day_number: reduceNum(personalMonth + 3) };
}
// Synthetic: the test database has no real phone history. Yesterday = 2026-10-01.
const PHONE_YESTERDAY = {
  date: '2026-10-01', steps: 11800, steps_usual_weekday: 7400, unlocks: 96, unlocks_usual: 70,
  longest_screen_free_hours: 3.5, first_unlock: '07:10', last_unlock: '23:40',
};
const LEARNED_WORDS = ['рачительный', 'сермяжный', 'бирюзовый', 'эфемерный', 'лаконичный'];

function alreadySeen() {
  // The last prompt test (C:\reports) holds real phrases written for the same profile; they stand in
  // for "the last 3 days" (no production history is read).
  try {
    const j = JSON.parse(fs.readFileSync('C:\\reports\\prompt_test_2026-10-02.json', 'utf8'));
    const texts = [];
    for (const run of j.C || []) for (const f of run.final || []) texts.push(f.text);
    return [...new Set(texts)].slice(0, 150);
  } catch (e) { return []; }
}

async function weatherTomorrow() {
  try {
    const { resolveWeatherByCoords } = require('../src/weather');
    const w = await resolveWeatherByCoords(51.1694, 71.4491, {
      countryCode: 'KZ', city: 'Astana', localDate: TARGET_DATE, timeZone: 'Asia/Almaty',
    });
    if (!w.forecast) return { source: 'met.no', failure: w.weatherFailure };
    // advice-only: the model gets bands, not exact numbers (plan section 2)
    const t = w.temperatureC;
    const band = t < 0 ? 'freezing' : t < 8 ? 'cold' : t < 15 ? 'cool' : t < 22 ? 'mild' : t < 28 ? 'warm' : 'hot';
    return {
      source: 'met.no', temperature_band: band, description: w.description,
      rain_chance: w.precipitationProbabilityMax >= 60 ? 'high' : w.precipitationProbabilityMax >= 30 ? 'some' : 'low',
      uv: w.uvIndexMax >= 6 ? 'high' : 'moderate_or_low', raw_for_report: w,
    };
  } catch (e) { return { source: 'met.no', failure: e.message }; }
}

// ---------- 48 slots, fixed order (plan section 4) ----------
// Deviations from the plan, as the task asks:
//  morning 8  "days until weekend" -> yesterday's phone recap (tomorrow is Saturday, so it was moot)
//  evening 2  phone slot  -> animal fact;  night 2 phone slot -> second science fact
const S = (window, n, type, topic, extra = {}) => ({ window, n, type, topic, max_chars: 60, ...extra });
const SLOTS = [
  S('morning', 1, 'greeting_name', 'Warm good-morning greeting with the name.'),
  S('morning', 2, 'weather_advice', 'What to wear or take TODAY, from the weather block ("today rain - take an umbrella"). Advice only, no numbers.'),
  S('morning', 3, 'horoscope', 'Light, kind note for the zodiac sign. No health/money/fate predictions.'),
  S('morning', 4, 'holiday', 'Holiday today: the holiday of the user\'s country (KZ) first; if none, the international day. From bank category holiday. Never say there is none.', { bank: 'holiday' }),
  S('morning', 5, 'on_this_day', '"On this day in <year> ..." from bank category on_this_day.', { bank: 'on_this_day' }),
  S('morning', 6, 'numerology', 'Name the personal day number and its light meaning today.'),
  S('morning', 7, 'word_of_day', 'A rare but real word of the user\'s language and its meaning (your own choice, not in already_seen / learned_words). Remember it.'),
  S('morning', 8, 'phone_yesterday', 'ONE recap of yesterday from the phone block, e.g. "yesterday you walked a lot - repeat it?". No exact numbers, friendly, not judging; do not say "data".'),
  S('morning', 9, 'quote', 'A short quote with its author, from bank category quote.', { bank: 'quote' }),
  S('morning', 10, 'word_recall', 'Recall the word from morning slot 7: "remember what X means?" (ask, do not answer).', { ref: 'morning-7' }),
  S('morning', 11, 'lifehack', 'One concrete, slightly surprising, doable trick.'),
  S('morning', 12, 'warm_wish', 'One sincere, specific wish for the day ahead.'),

  S('day', 1, 'humor', 'Your own light, clever everyday joke.'),
  S('day', 2, 'science_fact', 'Bank category science.', { bank: 'science' }),
  S('day', 3, 'country_fact', 'Fact about Kazakhstan, bank category country_kz.', { bank: 'country_kz' }),
  S('day', 4, 'quiz_question', 'A quiz question on a bank fact of category animals or nature. The answer comes in day slot 6.', { max_chars: 60 }),
  S('day', 5, 'number_of_day', 'One surprising number with what it means; from a bank fact that contains a number.', { bank: 'any' }),
  S('day', 6, 'quiz_answer', 'The answer to day slot 4: one or two words, nothing else.', { max_chars: 30, ref: 'day-4' }),
  S('day', 7, 'word_origin', 'Where a word came from, bank category word_origin.', { bank: 'word_origin' }),
  S('day', 8, 'animal_fact', 'Bank category animals.', { bank: 'animals' }),
  S('day', 9, 'tech_fact', 'Bank category tech.', { bank: 'tech' }),
  S('day', 10, 'money_simple', 'Money in simple words, bank category money.', { bank: 'money' }),
  S('day', 11, 'brain_psychology', 'Bank category brain.', { bank: 'brain' }),
  S('day', 12, 'thought', 'A thought of your own, fresh angle, not a poster slogan.'),

  S('evening', 1, 'good_news', 'Bank category good_news.', { bank: 'good_news' }),
  S('evening', 2, 'animal_fact', 'Another animal fact, bank category animals (a different one from day 8).', { bank: 'animals' }),
  S('evening', 3, 'unusual_fact', 'Bank category unusual.', { bank: 'unusual' }),
  S('evening', 4, 'gender_tip', 'A tip for men (profile gender: male). No stereotypes, no lecturing.'),
  S('evening', 5, 'space_fact', 'Bank category space.', { bank: 'space' }),
  S('evening', 6, 'born_today', 'Start "On this day was born ..." (in the user language, Russian: В этот день родился/родилась) - one person from bank category born_today. Never "today was born".', { bank: 'born_today' }),
  S('evening', 7, 'city_fact', 'Fact about Astana, bank category city_astana.', { bank: 'city_astana' }),
  S('evening', 8, 'dinner_idea', 'A dinner idea that takes 15 minutes. Concrete dish.'),
  S('evening', 9, 'quiz_question', 'A quiz question on a bank fact of category tech, space or how_it_works (a different topic and answer from day 4). The answer comes in evening slot 11.', { max_chars: 60 }),
  S('evening', 10, 'how_it_works', 'How something familiar works, bank category how_it_works.', { bank: 'how_it_works' }),
  S('evening', 11, 'quiz_answer', 'The answer to evening slot 9: one or two words, nothing else.', { max_chars: 30, ref: 'evening-9' }),
  S('evening', 12, 'evening_idea', 'An idea of how to spend the evening.'),

  S('night', 1, 'humor', 'A calm joke of your own that plays on the evening idea (evening slot 12).', { ref: 'evening-12' }),
  S('night', 2, 'science_fact', 'A second science fact, bank category science (a different one from day 2).', { bank: 'science' }),
  S('night', 3, 'watch_or_read', 'What to watch or read: one real, well-known title with a few words on why.'),
  S('night', 4, 'quiz_question', 'A quiz question on a bank fact of category unusual, tradition or word_origin (a different topic and answer from the other quizzes). The answer comes in night slot 6.', { max_chars: 60 }),
  S('night', 5, 'tradition', 'An unusual tradition of another country, bank category tradition.', { bank: 'tradition' }),
  S('night', 6, 'quiz_answer', 'The answer to night slot 4: one or two words, nothing else.', { max_chars: 30, ref: 'night-4' }),
  S('night', 7, 'poetic_thought', 'A quiet poetic image, gentle, not pompous.'),
  S('night', 8, 'word_recall', 'Recall the word of the day from morning slot 7 with its meaning.', { ref: 'morning-7' }),
  S('night', 9, 'nature_fact', 'Bank category nature.', { bank: 'nature' }),
  S('night', 10, 'word_languages', 'The morning word of the day itself translated into two or three other languages. Only languages you are certain about.', { ref: 'morning-7' }),
  S('night', 11, 'tomorrow_task', 'One small doable thing for tomorrow (here "tomorrow" is allowed).'),
  S('night', 12, 'goodnight', '"Good night" with the name; may return to the morning wish (morning slot 12).', { ref: 'morning-12' }),
].map((s, i) => ({ slot_id: `${s.window[0]}${s.n}`, ...s, order: i + 1 }));

// ---------- bank v2 ----------
function previousBankFacts() {
  // Facts of the bank over the last 30 days. The test base keeps none, so this is the file the
  // previous test bank would be appended to (empty on the first run).
  const f = readJson('bank_history_30d.json', []);
  return f.slice(-400);
}

function buildBankPrompt() {
  const prev = previousBankFacts();
  return `Search the web (today is ${TODAY}) and build a content bank for ${TARGET_DATE} for a phone lock-screen app.
Return STRICTLY a JSON array (no wrapper, no markdown) of objects: {"category": one of [${BANK_CATEGORIES.join(', ')}], "country": ISO code or "global" or "", "text": "..."}.
This is a one-shot automated job: never ask questions or propose stages, just do the work and return the final array. Use as many searches as needed to cover every category; never output placeholder or "no data" items. Every "text" is ONE short self-contained sentence in English, at most 12 words, with no invented numbers: every number, name and date must be confirmed by a search result. If you cannot verify it, leave it out. Do not put links or citations inside the text.

DATE-BOUND (all for ${TARGET_DATE} exactly):
- holiday (REQUIRED): (a) a holiday of Kazakhstan on ${TARGET_DATE} — professional, national or commemorative (country "KZ"); (b) an international day of the UN or UNESCO on ${TARGET_DATE} (country "global"). Keep searching for both (Kazakh sources, UN/UNESCO calendars). If after thorough search one truly does not exist, output an item with category holiday, country "KZ" or "global", and text starting "NONE:" saying so — but search first. Also, for each of these other countries, its own official or widely observed holiday on ${TARGET_DATE}, if any (never invent): ${COUNTRIES.filter((c) => c !== 'KZ').join(', ')}.
- on_this_day: 6 real events that happened on ${TARGET_DATE} in past years, start the text with the year. Different countries; at least one from Kazakhstan or Central Asia and at least one from Europe or Asia; not only the USA.
- born_today: 6 real people born on ${TARGET_DATE}, give the year of birth. Different countries; at least one from Kazakhstan or Central Asia and at least one from Europe or Asia; not only the USA.
- good_news: 4 genuinely positive, verifiable developments from the last few days.
FRESH VERIFIED FACTS: little-known and surprising, NOT school-level (no "octopuses have three hearts", no "ice floats", no "Neptune was found by maths" — the kind every pupil knows). Prefer facts a smart adult would say "I didn't know that" about.
- science 6, animals 6, space 5, nature 5, tech 5, unusual 5, money 4 (money explained simply), brain 4 (brain and psychology, well-established findings only), word_origin 4 (where a word came from, say which language), tradition 4 (unusual tradition of one country, name it), how_it_works 4 (how a familiar thing works), quote 4 (a real short quote with its author, at most 12 words besides the author).
- country_kz 5: facts about Kazakhstan. city_astana 5: facts about Astana. Country "KZ".
Avoid politics, commercial "days of X", self-help and generic wishes. Do not repeat anything from this list of the last 30 days: ${JSON.stringify(prev)}.
Never return an empty array. Respond with the JSON array only.`;
}

async function cmdBank() {
  if (fs.existsSync(file('bank_v3.json'))) { console.log('bank_v3.json exists, reuse'); return; }
  guardBudget(0.4);
  const t0 = Date.now();
  const bankModel = process.env.BANK_MODEL || 'gpt-5-mini';
  const params = { model: bankModel, tools: [{ type: 'web_search' }], input: buildBankPrompt() };
  if (/^gpt-(5|6)/.test(bankModel)) params.reasoning = { effort: process.env.BANK_EFFORT || 'medium' };
  const response = await client().responses.create(params);
  const seconds = (Date.now() - t0) / 1000;
  const entry = record('bank', bankModel, response.usage);
  const raw = response.output_text;
  fs.writeFileSync(file('bank_raw.txt'), raw);
  const m = raw.match(/\[[\s\S]*\]/);
  const items = JSON.parse(m ? m[0] : raw)
    .filter((i) => i && BANK_CATEGORIES.includes(i.category) && typeof i.text === 'string' && !i.text.trim().startsWith('('))
    .map((i, k) => ({ id: `b${k + 1}`, category: i.category, country: i.country || '', text: i.text.replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '').replace(/\s*\[[^\]]*\]\([^)]*\)/g, '').trim() }));
  const searches = (response.output || []).filter((o) => o.type === 'web_search_call').length;
  writeJson('bank_v3.json', { model: bankModel, date: TARGET_DATE, seconds, searches, usage: entry, items });
  writeJson('bank_history_30d.json', [...previousBankFacts(), ...items.map((i) => i.text)]);
  console.log(`bank: ${items.length} items, ${searches} searches, ${seconds}s, $${entry.usd.toFixed(4)} (tokens only)`);
}

// ---------- day call ----------
function dayInstructions() {
  return `You are the voice of a kind, clever AI that lives on the user's phone lock screen. Every glance at the phone shows one short line. You entertain, inform, support, teach and notice things, like a smart warm friend — never a motivational poster or a textbook.

THE DAY IS ONE MONOLOGUE
- This is one day of one conversation with one person. You write all of it in one go: 4 windows (morning, day, evening, night) x 12 phrases, 48 in total, in the fixed slot order you receive.
- Make 3–4 callbacks during the day: in the evening or at night come back to something said in the morning or day (the word of the day, the morning wish, the evening idea turning into a night joke about it). Mark each callback in the "echoes" field of the later phrase with the slot_id it returns to; otherwise "". Never repeat a text; a callback is a new line that plays on the earlier one.
- Phone data is for yesterday only and is used once, in the morning slot "phone_yesterday". Do not mention the phone anywhere else.
- Advice to rest or sleep: at most ONE in the whole day and only with a clear reason in the data. Otherwise none.
- Tone by window: morning — a fresh start; day — light, curious; evening — calmer, cultural; night — quiet and warm.

TIME
- Write as the person will read it at that moment. The planned date is TODAY for them: say "today" / "this morning", never "tomorrow" (morning weather: "today rain — take an umbrella"). "Tomorrow" is allowed only in the night slot "tomorrow_task".

LANGUAGE AND VOICE
- Write natively in the language "lang". Never translate word for word. Translate every name (holidays, people, places, titles) into that language; keep Latin letters only where the slot requires another language's word.
- Address the user informally. Use the name only in greeting, the goodnight slot and at most two other phrases.
- Never talk about yourself, never say you are an AI. No lecturing, no commands (except weather advice). No exact temperatures. No empty truisms: after reading, the user learned something, smiled, got a concrete tip, or felt a sincere warm word.
- Never mention the words "list", "bank", "data", "according to data", "source" or anything about where the facts came from.
- Jokes, thoughts, wishes, horoscope, tips, ideas are your own; do not translate jokes or quotes literally.

FACTS
- Facts (science, history, animals, space, holidays, people, traditions, quotes, etc.) come ONLY from "bank" (use the item's meaning; the bank_id field of your answer is the id of the item you used, or "" if the slot is your own). Never invent facts, names, dates or numbers.
- A bank text is raw material, not text to translate: retell it briefly in your own words, keep the one striking detail. Do not use the same bank item twice in this day.
- Holiday slot: the holiday of the user's own country first (items whose country matches); if there is none, an international day (country "global"). Never write that there is no holiday.
- Born-today slot: start with "on this day was born ..." in the user's language ("В этот день родился(лась) ..."), never "today was born".
- Quizzes: the three quizzes of the day have different topics and different answers. The question must be answerable from the bank fact; the answer slot gives just the answer.
- Word in other languages: translate the word of the day itself (not its explanation) into two or three languages you are certain about.
- "already_seen" (last 3 days) and "learned_words" are what the user already read and learned: do not repeat those facts, jokes, ideas or words, even in different words.
- Slots with "ref" refer to an earlier slot of this day; slots with "bank": a category name — pick an item of that category (for "any": any category except holiday and born_today).

LENGTH
- Every slot has "max_chars" (60): never exceed it, counting spaces. Aim for 40–55 characters. The absolute limit is ${MAX_LEN}, longer phrases are discarded. Count before answering; if over, drop details, never cut the end of a thought.

OUTPUT
Only JSON matching the schema: one phrase per slot, in slot order, with slot_id, text, bank_id and echoes.`;
}

const DAY_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'lock_screen_day', strict: true,
    schema: {
      type: 'object',
      properties: {
        phrases: {
          type: 'array', minItems: SLOTS.length, maxItems: SLOTS.length,
          items: {
            type: 'object',
            properties: { slot_id: { type: 'string' }, text: { type: 'string' }, bank_id: { type: 'string' }, echoes: { type: 'string' } },
            required: ['slot_id', 'text', 'bank_id', 'echoes'], additionalProperties: false,
          },
        },
      },
      required: ['phrases'], additionalProperties: false,
    },
  },
};

function buildDayPayload(bank, weather) {
  return {
    lang: 'ru',
    date: TARGET_DATE, weekday: 'Saturday',
    profile: { ...PROFILE, numerology: numerology() },
    weather_tomorrow: weather.failure ? { unavailable: true } : {
      temperature_band: weather.temperature_band, description: weather.description,
      rain_chance: weather.rain_chance, uv: weather.uv,
    },
    phone_yesterday: PHONE_YESTERDAY,
    bank: bank.items.filter((i) => !i.text.startsWith('NONE:')).map((i) => ({ id: i.id, category: i.category, country: i.country, text: i.text })),
    learned_words: LEARNED_WORDS,
    slots: SLOTS.map(({ slot_id, window, type, topic, max_chars, bank: b, ref }) => {
      const o = { slot_id, window, type, topic, max_chars };
      if (b) o.bank = b;
      if (ref) o.ref = ref;
      return o;
    }),
    already_seen: alreadySeen(),
  };
}

function modelParams(variant, messages, schema) {
  const model = VARIANTS[variant].model;
  const p = { model, messages, response_format: schema, max_completion_tokens: 20000 };
  p.reasoning_effort = VARIANTS[variant].effort;
  return p;
}

async function cmdProbe() {
  for (const model of Object.keys(VARIANTS)) {
    guardBudget(0.05);
    try {
      const r = await client().chat.completions.create({
        model, reasoning_effort: VARIANTS[model].effort, max_completion_tokens: 2000,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      });
      const e = record(`probe:${model}`, VARIANTS[model].model, r.usage);
      console.log(`${model} ok -> "${r.choices[0].message.content}" effort=${VARIANTS[model].effort} $${e.usd.toFixed(6)}`);
    } catch (err) {
      console.log(`${model} FAILED: ${err.status || ''} ${err.message}`);
    }
  }
}

async function cmdDay(variant, runNo) {
  if (!VARIANTS[variant]) throw new Error(`unknown variant ${variant}`);
  const model = VARIANTS[variant].model;
  const bank = readJson('bank_v3.json', null);
  if (!bank) throw new Error('run "bank" first');
  const weather = await weatherTomorrow();
  const payload = buildDayPayload(bank, weather);
  const messages = [
    { role: 'system', content: dayInstructions() },
    { role: 'user', content: JSON.stringify(payload) },
  ];
  guardBudget(0.1);

  const t0 = Date.now();
  let r;
  try {
    r = await client().chat.completions.create(modelParams(variant, messages, DAY_SCHEMA));
  } catch (err) {
    console.log(`FAILED ${variant} run ${runNo}: ${err.status || ''} ${err.message}`);
    process.exit(1);
  }
  const seconds = (Date.now() - t0) / 1000;
  const usage = record(`day:${variant}:${runNo}`, model, r.usage);
  const choice = r.choices[0];
  const parsed = JSON.parse(choice.message.content);
  const phrases = parsed.phrases;

  // Count first-pass problems; one repair call for phrases over the limit.
  const bySlot = new Map(SLOTS.map((s) => [s.slot_id, s]));
  const firstPass = phrases.map((p) => ({ ...p, len: [...p.text].length }));
  const tooLong = firstPass.filter((p) => p.len > MAX_LEN);
  let repair = null;
  if (tooLong.length) {
    guardBudget(0.2);
    const repairMessages = [
      { role: 'system', content: `Rewrite each rejected lock-screen phrase so that it fits max_chars (counting spaces), keeping its meaning and language (${PROFILE.language}). Drop details, never cut the end of the thought. Return JSON {"phrases":[{"slot_id","text","bank_id","echoes"}]} for exactly these slots.` },
      { role: 'user', content: JSON.stringify(tooLong.map((p) => ({ slot_id: p.slot_id, original_text: p.text, length: p.len, max_chars: Math.min(bySlot.get(p.slot_id).max_chars, MAX_LEN) }))) },
    ];
    const rt0 = Date.now();
    const rr = await client().chat.completions.create(modelParams(variant, repairMessages, {
      type: 'json_schema',
      json_schema: {
        name: 'repair', strict: true,
        schema: { type: 'object', properties: { phrases: { type: 'array', items: { type: 'object', properties: { slot_id: { type: 'string' }, text: { type: 'string' }, bank_id: { type: 'string' }, echoes: { type: 'string' } }, required: ['slot_id', 'text', 'bank_id', 'echoes'], additionalProperties: false } } }, required: ['phrases'], additionalProperties: false },
      },
    }));
    const re = record(`repair:${variant}:${runNo}`, model, rr.usage);
    const fixed = new Map(JSON.parse(rr.choices[0].message.content).phrases.map((p) => [p.slot_id, p]));
    repair = { count: tooLong.length, seconds: (Date.now() - rt0) / 1000, usd: re.usd, in: re.in, out: re.out, reasoning: re.reasoning };
    for (const p of firstPass) {
      if (fixed.has(p.slot_id)) { p.repaired_from = p.text; p.text = fixed.get(p.slot_id).text; p.len = [...p.text].length; }
    }
  }

  const result = {
    variant, model, run: runNo, effort: VARIANTS[variant].effort, seconds, finish_reason: choice.finish_reason,
    usage: { in: usage.in, out: usage.out, reasoning: usage.reasoning, usd: usage.usd },
    first_pass_too_long: tooLong.length, repair,
    weather: weather.raw_for_report || weather,
    phrases: firstPass.map((p) => ({ ...p, window: bySlot.get(p.slot_id) ? bySlot.get(p.slot_id).window : '?', type: bySlot.get(p.slot_id) && bySlot.get(p.slot_id).type })),
  };
  writeJson(`run_${variant}_${runNo}.json`, result);
  console.log(`${variant} run ${runNo}: ${phrases.length} phrases, ${seconds.toFixed(1)}s, in=${usage.in} out=${usage.out} reasoning=${usage.reasoning} $${usage.usd.toFixed(4)}, tooLong=${tooLong.length}, finish=${choice.finish_reason}; total spent $${spent().toFixed(3)}`);
}

// ---------- report ----------
const LATIN_OK = new Set([]); // no Latin words expected in Russian phrases except loanword names
function languageIssues(text) {
  const issues = [];
  const latin = text.match(/[A-Za-z]{2,}/g);
  if (latin) issues.push(`latin:${latin.join(',')}`);
  if (/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(text)) issues.push('cjk');
  return issues;
}

function cmdReport() {
  const bank = readJson('bank_v3.json', null);
  const rows = [];
  const FORBIDDEN = /списк|банк|данны|источник/i;
  for (const variant of Object.keys(VARIANTS)) {
    const runs = [1, 2].map((n) => readJson(`run_${variant}_${n}.json`, null)).filter(Boolean);
    if (!runs.length) continue;
    const md = [`# ${variant}: ${VARIANTS[variant].model}, reasoning ${VARIANTS[variant].effort} — день ${TARGET_DATE}`, '', '↩ = связка: возврат к сказанному раньше (по полю echoes модели).', ''];
    for (const run of runs) {
      md.push(`## Прогон ${run.run}: ${run.seconds.toFixed(1)} с, вход ${run.usage.in}, выход ${run.usage.out}, reasoning ${run.usage.reasoning}`, '');
      let win = '';
      for (const p of run.phrases) {
        if (p.window !== win) { win = p.window; md.push(`### ${win}`, '', '| # | слот | длина | текст |', '|---|---|---|---|'); }
        const mark = p.repaired_from ? ` (исправлено; было ${[...p.repaired_from].length}: «${p.repaired_from}»)` : '';
        const echo = p.echoes ? ` ↩ ${p.echoes}` : '';
        md.push(`| ${p.slot_id} | ${p.type} | ${p.len}${p.len > MAX_LEN ? ' ❗' : ''} | ${p.text}${echo}${mark} |`);
      }
      md.push('');
    }
    fs.writeFileSync(file(`${variant}.md`), md.join('\n'));
    const avg = (f) => runs.reduce((a, r) => a + f(r), 0) / runs.length;
    const sum = (f) => runs.reduce((a, r) => a + f(r), 0);
    const dayUsd = avg((r) => r.usage.usd + (r.repair ? r.repair.usd : 0));
    rows.push({
      variant, in: avg((r) => r.usage.in), out: avg((r) => r.usage.out), reasoning: avg((r) => r.usage.reasoning),
      seconds: avg((r) => r.seconds),
      over60_first: sum((r) => r.phrases.filter((p) => (p.repaired_from ? [...p.repaired_from].length : p.len) > 60).length),
      over70_first: sum((r) => r.first_pass_too_long),
      over70_final: sum((r) => r.phrases.filter((p) => p.len > MAX_LEN).length),
      over60_final: sum((r) => r.phrases.filter((p) => p.len > 60).length),
      repairUsd: avg((r) => (r.repair ? r.repair.usd : 0)),
      echoes: runs.map((r) => r.phrases.filter((p) => p.echoes).length),
      forbidden: sum((r) => r.phrases.filter((p) => FORBIDDEN.test(p.text)).length),
      zavtra_outside_n11: sum((r) => r.phrases.filter((p) => /завтра/i.test(p.text) && p.slot_id !== 'n11').length),
      noHoliday: sum((r) => r.phrases.filter((p) => /нет (официального )?праздник|праздника нет/i.test(p.text)).length),
      dayUsd, month: dayUsd * 30, monthBatch: dayUsd * 30 * BATCH_DISCOUNT,
    });
  }
  if (bank) {
    const md = [`# Банк v3 на ${bank.date}`, '', `Вызов: ${bank.model} + web_search, ${bank.seconds.toFixed(0)} с, поисков: ${bank.searches}, токены вход/выход: ${bank.usage.in}/${bank.usage.out}, $${bank.usage.usd.toFixed(4)} (только токены; плата за вызовы поиска не включена).`, ''];
    for (const cat of BANK_CATEGORIES) {
      const items = bank.items.filter((i) => i.category === cat);
      md.push(`## ${cat} (${items.length})`, '');
      for (const i of items) md.push(`- ${i.id}${i.country ? ` [${i.country}]` : ''}: ${i.text} (${i.text.split(/\s+/).length} слов)`);
      md.push('');
    }
    fs.writeFileSync(file('bank_v3.md'), md.join('\n'));
  }
  writeJson('summary.json', { rows, bankUsd: bank && bank.usage.usd, spent: spent() });
  console.log(JSON.stringify({ rows, bankUsd: bank && bank.usage.usd, spent: spent() }, null, 1));
}

const [cmd, a, b] = process.argv.slice(2);
(async () => {
  if (cmd === 'probe') await cmdProbe();
  else if (cmd === 'bank') await cmdBank();
  else if (cmd === 'day') await cmdDay(a, Number(b || 1));
  else if (cmd === 'report') cmdReport();
  else console.log('usage: probe | bank | day <model> <run> | report');
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
