// TEST ONLY (task 23): "whole day in one call" scheme. Nothing here is wired into the server.
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

const OUT_DIR = process.env.DAILY_TEST_OUT || 'C:\\reports\\daily_test_2026-10-02';
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
const EFFORT = { 'gpt-5-mini': 'low', 'gpt-6-astra': 'low', 'gpt-6-luna': 'none' };

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
  S('morning', 2, 'weather_advice', 'What to wear or take tomorrow, from the weather block. Advice only, no numbers.'),
  S('morning', 3, 'horoscope', 'Light, kind note for the zodiac sign. No health/money/fate predictions.'),
  S('morning', 4, 'holiday', 'Holiday today: the local (user country) one first; if none, the international one. From bank category holiday.', { bank: 'holiday' }),
  S('morning', 5, 'on_this_day', '"On this day in <year> ..." from bank category on_this_day.', { bank: 'on_this_day' }),
  S('morning', 6, 'numerology', 'Name the personal day number and its light meaning today.'),
  S('morning', 7, 'word_of_day', 'A rare but real word of the user\'s language and its meaning (your own choice, not in already_seen / learned_words). Remember it.', { max_chars: 65 }),
  S('morning', 8, 'phone_yesterday', 'ONE recap of yesterday from phone_yesterday, e.g. he walked a lot yesterday - repeat it? No exact numbers, friendly, not judging.'),
  S('morning', 9, 'quote', 'A short quote with its author, from bank category quote.', { bank: 'quote' }),
  S('morning', 10, 'word_recall', 'Recall the word from morning slot 7: "remember what X means?" (ask, do not answer).', { ref: 'morning-7' }),
  S('morning', 11, 'lifehack', 'One concrete, slightly surprising, doable trick.'),
  S('morning', 12, 'warm_wish', 'One sincere, specific wish for the day ahead.'),

  S('day', 1, 'humor', 'Your own light, clever everyday joke.'),
  S('day', 2, 'science_fact', 'Bank category science.', { bank: 'science' }),
  S('day', 3, 'country_fact', 'Fact about Kazakhstan, bank category country_kz.', { bank: 'country_kz' }),
  S('day', 4, 'quiz_question', 'A quiz question built on a bank fact (any category except holiday/born_today). The answer comes in day slot 6.', { max_chars: 55 }),
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
  S('evening', 6, 'born_today', 'Who was born on this day, bank category born_today.', { bank: 'born_today' }),
  S('evening', 7, 'city_fact', 'Fact about Astana, bank category city_astana.', { bank: 'city_astana' }),
  S('evening', 8, 'dinner_idea', 'A dinner idea that takes 15 minutes. Concrete dish.'),
  S('evening', 9, 'quiz_question', 'A quiz question built on a bank fact. The answer comes in evening slot 11.', { bank: 'any', max_chars: 55 }),
  S('evening', 10, 'how_it_works', 'How something familiar works, bank category how_it_works.', { bank: 'how_it_works' }),
  S('evening', 11, 'quiz_answer', 'The answer to evening slot 9: one or two words, nothing else.', { max_chars: 30, ref: 'evening-9' }),
  S('evening', 12, 'evening_idea', 'An idea of how to spend the evening.'),

  S('night', 1, 'humor', 'Your own light joke, calmer.'),
  S('night', 2, 'science_fact', 'A second science fact, bank category science (a different one from day 2).', { bank: 'science' }),
  S('night', 3, 'watch_or_read', 'What to watch or read: one real, well-known title with a few words on why.'),
  S('night', 4, 'quiz_question', 'A quiz question built on a bank fact. The answer comes in night slot 6.', { bank: 'any', max_chars: 55 }),
  S('night', 5, 'tradition', 'An unusual tradition of another country, bank category tradition.', { bank: 'tradition' }),
  S('night', 6, 'quiz_answer', 'The answer to night slot 4: one or two words, nothing else.', { max_chars: 30, ref: 'night-4' }),
  S('night', 7, 'poetic_thought', 'A quiet poetic image, gentle, not pompous.'),
  S('night', 8, 'word_recall', 'Recall the word of the day from morning slot 7 with its meaning.', { ref: 'morning-7' }),
  S('night', 9, 'nature_fact', 'Bank category nature.', { bank: 'nature' }),
  S('night', 10, 'word_languages', 'How the morning word\'s MEANING is said in two or three other languages. Only languages you are certain about.', { ref: 'morning-7' }),
  S('night', 11, 'tomorrow_task', 'One small doable thing for tomorrow.'),
  S('night', 12, 'goodnight', '"Good night" with the name.'),
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
This is a one-shot automated job: never ask questions or propose stages, just do the work and return the final array. Use as many searches as needed to cover every category; never output placeholder or "no data" items — if a category cannot be verified, output fewer items for it. Every "text" is ONE short self-contained sentence in English, at most 12 words, with no invented numbers: every number, name and date must be confirmed by a search result. If you cannot verify it, leave it out.

DATE-BOUND (all for ${TARGET_DATE} exactly):
- holiday: for EACH of these countries, that country's own official or widely observed holiday or national day on ${TARGET_DATE} (skip a country with none, never invent): ${COUNTRIES.join(', ')}. Set "country" to the code. Plus 2 international observance days (UN/UNESCO/WHO or similar), country "global".
- on_this_day: 4 real events that happened on ${TARGET_DATE} in past years; start the text with the year.
- born_today: 4 real, well-known people born on ${TARGET_DATE}; give the year of birth.
- good_news: 4 genuinely positive, verifiable developments from the last few days.
FRESH VERIFIED FACTS (little-known and surprising beats textbook-famous):
- science 6, animals 6, space 5, nature 5, tech 5, unusual 5, money 4 (money explained simply), brain 4 (brain and psychology, well-established findings only), word_origin 4 (where a word came from, say which language), tradition 4 (unusual tradition of one country, name it), how_it_works 4 (how a familiar thing works), quote 4 (a real short quote with its author, at most 12 words besides the author).
- country_kz 5: facts about Kazakhstan. city_astana 5: facts about Astana. Country "KZ".
Avoid politics, commercial "days of X", self-help and generic wishes. Do not repeat what is already in this list of the last 30 days: ${JSON.stringify(prev)}.
Never return an empty array: even if some items are hard to verify, return every verified item you did find (at least 60 in total). Respond with the JSON array only.`;
}

async function cmdBank() {
  if (fs.existsSync(file('bank_v2.json'))) { console.log('bank_v2.json exists, reuse'); return; }
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
  writeJson('bank_v2.json', { model: bankModel, date: TARGET_DATE, seconds, searches, usage: entry, items });
  writeJson('bank_history_30d.json', [...previousBankFacts(), ...items.map((i) => i.text)]);
  console.log(`bank: ${items.length} items, ${searches} searches, ${seconds}s, $${entry.usd.toFixed(4)} (tokens only)`);
}

// ---------- day call ----------
function dayInstructions() {
  return `You are the voice of a kind, clever AI that lives on the user's phone lock screen. Every glance at the phone shows one short line. You entertain, inform, support, teach and notice things, like a smart warm friend — never a motivational poster or a textbook.

THE DAY IS ONE MONOLOGUE
- You write the user's whole day in one go: 4 windows (morning, day, evening, night) x 12 phrases, 48 in total, in the fixed slot order you receive. It is one day of one conversation: you may and should come back to what was said earlier (the morning word in the evening, the morning wish at night, a callback to a joke) — but never repeat a text.
- Phone data is for yesterday only and is used once, in the morning slot "phone_yesterday", as a recap. Do not mention the phone anywhere else.
- Advice to rest or sleep: at most ONE in the whole day and only with a clear reason in the data. Otherwise none.
- Tone by window: morning — a fresh start; day — light, curious; evening — calmer, cultural; night — quiet and warm.

LANGUAGE AND VOICE
- Write natively in the language "lang". Never translate word for word. Translate all names (holidays, people, places, titles) into that language.
- Address the user informally. Use the name only in greeting, the goodnight slot and at most two other phrases.
- Never talk about yourself, never say you are an AI. No lecturing, no commands (except weather advice). No exact temperatures. No empty truisms: after reading, the user learned something, smiled, got a concrete tip, or felt a sincere warm word.
- Jokes, thoughts, wishes, horoscope, tips, ideas are your own; do not translate jokes or quotes literally.

FACTS
- Facts (science, history, animals, space, holidays, people, traditions, quotes, etc.) come ONLY from "bank" (use the item's meaning; the bank_id field of your answer is the id of the item you used, or "" if the slot is your own). Never invent facts, names, dates or numbers. If the bank has nothing suitable for a slot, write a short own line that needs no facts; do not make anything up.
- A bank text is raw material, not text to translate: retell it briefly in your own words, keep the one striking detail.
- "already_seen" (last 3 days) and "learned_words" are what the user already read and learned: do not repeat those facts, jokes, ideas or words, even in different words. Do not use the same bank item twice in this day.
- Slots with "ref" refer to an earlier slot of this day; slots with "bank": a category name — pick an item of that category (for "any": any category except holiday and born_today; "holiday": prefer the item whose country matches the user's country, else a "global" one).

LENGTH
- Every slot has "max_chars": never exceed it, counting spaces. Aim for 40–60 characters; the absolute limit is ${MAX_LEN}, longer phrases are discarded. Count before answering; if over, drop details, never cut the end of a thought.

OUTPUT
Only JSON matching the schema: one phrase per slot, in slot order, with its slot_id.`;
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
            properties: { slot_id: { type: 'string' }, text: { type: 'string' }, bank_id: { type: 'string' } },
            required: ['slot_id', 'text', 'bank_id'], additionalProperties: false,
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
    bank: bank.items.map((i) => ({ id: i.id, category: i.category, country: i.country, text: i.text })),
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

function modelParams(model, messages, schema) {
  const p = { model, messages, response_format: schema, max_completion_tokens: 20000 };
  if (EFFORT[model]) p.reasoning_effort = EFFORT[model];
  return p;
}

async function cmdProbe() {
  for (const model of Object.keys(EFFORT)) {
    guardBudget(0.05);
    try {
      const r = await client().chat.completions.create({
        model, reasoning_effort: EFFORT[model], max_completion_tokens: 2000,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      });
      const e = record(`probe:${model}`, model, r.usage);
      console.log(`${model} ok -> "${r.choices[0].message.content}" effort=${EFFORT[model]} $${e.usd.toFixed(6)}`);
    } catch (err) {
      console.log(`${model} FAILED: ${err.status || ''} ${err.message}`);
    }
  }
}

async function cmdDay(model, runNo) {
  if (!PRICES[model]) throw new Error(`unknown model ${model}`);
  const bank = readJson('bank_v2.json', null);
  if (!bank) throw new Error('run "bank" first');
  const weather = await weatherTomorrow();
  const payload = buildDayPayload(bank, weather);
  const messages = [
    { role: 'system', content: dayInstructions() },
    { role: 'user', content: JSON.stringify(payload) },
  ];
  guardBudget(model === 'gpt-6-astra' ? 0.8 : 0.2);

  const t0 = Date.now();
  let r;
  try {
    r = await client().chat.completions.create(modelParams(model, messages, DAY_SCHEMA));
  } catch (err) {
    console.log(`FAILED ${model} run ${runNo}: ${err.status || ''} ${err.message}`);
    process.exit(1);
  }
  const seconds = (Date.now() - t0) / 1000;
  const usage = record(`day:${model}:${runNo}`, model, r.usage);
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
      { role: 'system', content: `Rewrite each rejected lock-screen phrase so that it fits max_chars (counting spaces), keeping its meaning and language (${PROFILE.language}). Drop details, never cut the end of the thought. Return JSON {"phrases":[{"slot_id","text","bank_id"}]} for exactly these slots.` },
      { role: 'user', content: JSON.stringify(tooLong.map((p) => ({ slot_id: p.slot_id, original_text: p.text, length: p.len, max_chars: Math.min(bySlot.get(p.slot_id).max_chars, MAX_LEN) }))) },
    ];
    const rt0 = Date.now();
    const rr = await client().chat.completions.create(modelParams(model, repairMessages, {
      type: 'json_schema',
      json_schema: {
        name: 'repair', strict: true,
        schema: { type: 'object', properties: { phrases: { type: 'array', items: { type: 'object', properties: { slot_id: { type: 'string' }, text: { type: 'string' }, bank_id: { type: 'string' } }, required: ['slot_id', 'text', 'bank_id'], additionalProperties: false } } }, required: ['phrases'], additionalProperties: false },
      },
    }));
    const re = record(`repair:${model}:${runNo}`, model, rr.usage);
    const fixed = new Map(JSON.parse(rr.choices[0].message.content).phrases.map((p) => [p.slot_id, p]));
    repair = { count: tooLong.length, seconds: (Date.now() - rt0) / 1000, usd: re.usd, in: re.in, out: re.out, reasoning: re.reasoning };
    for (const p of firstPass) {
      if (fixed.has(p.slot_id)) { p.repaired_from = p.text; p.text = fixed.get(p.slot_id).text; p.len = [...p.text].length; }
    }
  }

  const result = {
    model, run: runNo, effort: EFFORT[model] || null, seconds, finish_reason: choice.finish_reason,
    usage: { in: usage.in, out: usage.out, reasoning: usage.reasoning, usd: usage.usd },
    first_pass_too_long: tooLong.length, repair,
    weather: weather.raw_for_report || weather,
    phrases: firstPass.map((p) => ({ ...p, window: bySlot.get(p.slot_id) ? bySlot.get(p.slot_id).window : '?', type: bySlot.get(p.slot_id) && bySlot.get(p.slot_id).type })),
  };
  writeJson(`run_${model}_${runNo}.json`, result);
  console.log(`${model} run ${runNo}: ${phrases.length} phrases, ${seconds.toFixed(1)}s, in=${usage.in} out=${usage.out} reasoning=${usage.reasoning} $${usage.usd.toFixed(4)}, tooLong=${tooLong.length}, finish=${choice.finish_reason}; total spent $${spent().toFixed(3)}`);
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
  const bank = readJson('bank_v2.json', null);
  const models = Object.keys(EFFORT);
  const lines = [];
  const rows = [];
  for (const model of models) {
    const runs = [1, 2].map((n) => readJson(`run_${model}_${n}.json`, null)).filter(Boolean);
    if (!runs.length) continue;
    const md = [`# ${model} — день ${TARGET_DATE} (reasoning: ${EFFORT[model] || 'n/a'})`, ''];
    for (const run of runs) {
      md.push(`## Прогон ${run.run}: ${run.seconds.toFixed(1)} с, вход ${run.usage.in}, выход ${run.usage.out}, reasoning ${run.usage.reasoning}`, '');
      let win = '';
      for (const p of run.phrases) {
        if (p.window !== win) { win = p.window; md.push(`### ${win}`, '', '| # | слот | длина | текст |', '|---|---|---|---|'); }
        const mark = p.repaired_from ? ` (исправлено; было ${[...p.repaired_from].length}: «${p.repaired_from}»)` : '';
        md.push(`| ${p.slot_id} | ${p.type} | ${p.len}${p.len > MAX_LEN ? ' ❗' : ''} | ${p.text}${mark} |`);
      }
      md.push('');
    }
    fs.writeFileSync(file(`${model}.md`), md.join('\n'));

    const avg = (f) => runs.reduce((s, r) => s + f(r), 0) / runs.length;
    const dayUsd = avg((r) => r.usage.usd + (r.repair ? r.repair.usd : 0));
    const langErr = runs.reduce((s, r) => s + r.phrases.filter((p) => languageIssues(p.text).length).length, 0);
    rows.push({
      model, runs: runs.length, in: avg((r) => r.usage.in), out: avg((r) => r.usage.out),
      reasoning: avg((r) => r.usage.reasoning), seconds: avg((r) => r.seconds),
      tooLong: avg((r) => r.first_pass_too_long), repairUsd: avg((r) => (r.repair ? r.repair.usd : 0)),
      stillLong: runs.reduce((s, r) => s + r.phrases.filter((p) => p.len > MAX_LEN).length, 0),
      langErr, dayUsd, month: dayUsd * 30, monthBatch: dayUsd * 30 * BATCH_DISCOUNT,
      incomplete: runs.filter((r) => r.phrases.length !== SLOTS.length || r.finish_reason !== 'stop').length,
    });
  }
  if (bank) {
    const md = [`# Банк v2 на ${bank.date}`, '', `Вызов: ${bank.model} + web_search, ${bank.seconds.toFixed(0)} с, поисков: ${bank.searches}, токены вход/выход: ${bank.usage.in}/${bank.usage.out}, $${bank.usage.usd.toFixed(4)} (только токены; плата за вызовы поиска не включена).`, ''];
    for (const cat of BANK_CATEGORIES) {
      const items = bank.items.filter((i) => i.category === cat);
      md.push(`## ${cat} (${items.length})`, '');
      for (const i of items) md.push(`- ${i.id}${i.country ? ` [${i.country}]` : ''}: ${i.text} (${i.text.split(/\s+/).length} слов)`);
      md.push('');
    }
    fs.writeFileSync(file('bank_v2.md'), md.join('\n'));
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
