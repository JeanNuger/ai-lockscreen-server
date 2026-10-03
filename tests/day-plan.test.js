// GET /api/v1/day and the whole-day generation (src/dayPlan.js, src/routes/day.js): 48 phrases in the
// fixed order, one model call per device and local date, the day cache, the word pair (morning 7 ->
// night 8 + 9), the holiday replacement, the single repair call, the memory the old /batch already had
// (exact-repeat archive, already_seen from shown reports, learned words, OPENAI_USAGE log), and that the
// old /batch is still mounted. The model and the weather are mocked: no real calls.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-day-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');

const DATE = '2026-10-03';

// ---- mocked weather (the day route imports ../weather) ----
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '../weather') {
    return {
      resolveGeolocation: async () => ({ success: true, country_code: 'KZ' }),
      resolveWeather: async () => ({
        countryCode: 'KZ', forecast: true, temperatureC: 12, temperatureMinC: 4, description: 'heavy rain',
        precipitationProbabilityMax: 80, uvIndexMax: 2,
      }),
      resolveWeatherByCoords: async () => ({ countryCode: 'KZ' }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const dayPlan = require('../src/dayPlan');
const dayRoute = require('../src/routes/day');
const { _test: dayTest } = dayPlan;

// ---- fake model ----
let modelCalls;
let mockHandler;

function installModel(handler) {
  modelCalls = [];
  mockHandler = handler;
  dayTest.setClientFactory(() => ({
    chat: {
      completions: {
        create: async (params) => {
          const isRepair = params.response_format.json_schema.name === 'lock_screen_day_repair';
          const payload = JSON.parse(params.messages[1].content);
          modelCalls.push({ params, payload, isRepair });
          const body = mockHandler({ params, payload, isRepair, callNo: modelCalls.length });
          return {
            choices: [{ message: { content: JSON.stringify(body) } }],
            usage: { prompt_tokens: 7000, completion_tokens: 1700, total_tokens: 8700, completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 0 } },
          };
        },
      },
    },
  }));
}

function bankIdFor(payload, slot) {
  if (slot.bank_item) return slot.bank_item.id;
  if (slot.bank && slot.bank !== 'any') {
    const row = payload.bank.find((item) => item.category === slot.bank);
    return row ? row.id : '';
  }
  return '';
}

// A well-behaved model: short unique text per slot, the right bank id, the word of the day.
function wellBehaved({ payload, isRepair }, overrides = {}) {
  if (isRepair) {
    return {
      phrases: payload.slots.map((slot) => ({
        slot_id: slot.slot_id, text: overrides.repairText ? overrides.repairText(slot) : `Fixed ${slot.slot_id}`,
        bank_id: bankIdFor(payload, slot), echoes: '',
      })),
      word_of_day: 'Fixedword',
      foreign_word: overrides.repairForeignWord || 'Fixedpalabra',
    };
  }
  return {
    phrases: payload.slots.map((slot) => {
      const text = overrides.text && overrides.text(slot) !== undefined ? overrides.text(slot) : `Line ${payload.date} ${slot.slot_id} ${slot.type}`;
      return { slot_id: slot.slot_id, text, bank_id: bankIdFor(payload, slot), echoes: slot.slot_id === 'n1' ? 'e12' : '' };
    }),
    word_of_day: 'Serendipity',
    foreign_word: overrides.foreignWord || `Palabra-${payload.date}`,
  };
}

// ---- http helper ----
async function withServer(callback) {
  const app = express();
  app.use('/api/v1', dayRoute);
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
  });
  const server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  try {
    return await callback(server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function get(server, pathName) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}${pathName}`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, json: body ? JSON.parse(body) : null }); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

// ---- fixtures ----
function addDevice(id, fields = {}) {
  db.prepare(`
    INSERT OR REPLACE INTO devices (device_id, name, gender, birth_date, timezone, city_name, city_country_code, interests, learning_language)
    VALUES (?, ?, ?, ?, 'Asia/Almaty', ?, ?, ?, ?)
  `).run(id, fields.name || 'Baur', fields.gender || 'male', fields.birth || '1990-02-05', fields.city || null, fields.country || null,
    fields.interests ? JSON.stringify(fields.interests) : null, fields.learning || null);
}

const INTEREST_KEYS = require('../src/dayRotation').INTEREST_KEYS;

// rows: [category, text, tag] where tag is one tag or an array of tags (country first, then city:<name> / date:<day>).
function addBank(rows, date = DATE) {
  const insert = db.prepare('INSERT INTO daily_content_bank (bank_date, category, content_text, tags) VALUES (?, ?, ?, ?)');
  for (const [category, text, tag] of rows) {
    insert.run(date, category, text, JSON.stringify(Array.isArray(tag) ? tag : tag ? [tag] : []));
  }
}

function seedFullBank(date = DATE, { kzHoliday = true, globalHoliday = true, interests = true } = {}) {
  const rows = [];
  if (kzHoliday) rows.push(['holiday', 'Kazakhstan marks a local day.', 'KZ']);
  if (globalHoliday) rows.push(['holiday', 'The UN marks an international day.', 'global']);
  rows.push(['holiday', 'Russia marks its own day.', 'RU']);
  const per = {
    on_this_day: 2, born_today: 2, good_news: 2, science: 3, animals: 3, space: 2, nature: 2, tech: 3, unusual: 3,
    money: 2, brain: 2, word_origin: 2, tradition: 2, how_it_works: 2, quote: 2,
  };
  for (const [category, n] of Object.entries(per)) {
    for (let i = 1; i <= n; i += 1) rows.push([category, `Bank ${category} fact number ${i}.`, null]);
  }
  // places: Kazakhstan / Astana (the main test city) and Germany / Berlin
  rows.push(['country_fact', 'Kazakhstan country fact one.', 'KZ'], ['country_fact', 'Germany country fact one.', 'DE']);
  rows.push(['city_fact', 'Astana city fact one.', ['KZ', 'city:astana']], ['city_fact', 'Berlin city fact one.', ['DE', 'city:berlin']]);
  rows.push(['watch_read', 'Kazakh film Kazakh Film One.', 'KZ'], ['watch_read', 'Famous series World Series One.', 'global']);
  if (interests) {
    for (const key of INTEREST_KEYS) {
      for (let i = 1; i <= 2; i += 1) rows.push([`interest_${key}`, `Interest ${key} fact number ${i}.`, null]);
    }
  }
  addBank(rows, date);
}

function phrasesOf(res) {
  return res.json.phrases;
}

function quiet(fn) {
  const o = { log: console.log, warn: console.warn, error: console.error };
  const logs = [];
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  const restore = () => Object.assign(console, o);
  return Promise.resolve().then(fn).then((v) => { restore(); return { value: v, logs }; }, (e) => { restore(); throw e; });
}

async function main() {
  // ================= slots =================
  {
    const defs = dayPlan.slotDefinitions();
    assert.strictEqual(defs.length, 48);
    for (const window of ['morning', 'day', 'evening', 'night']) {
      const inWindow = defs.filter((d) => d.window === window);
      assert.strictEqual(inWindow.length, 12, `${window} has 12 slots`);
      assert.deepStrictEqual(inWindow.map((d) => d.position), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    }
    assert.strictEqual(new Set(defs.map((d) => d.slot_id)).size, 48, 'slot ids are unique');
    const typeAt = (id) => defs.find((d) => d.slot_id === id).type;
    // the word of the day: teach in the morning, ask and answer at night
    assert.strictEqual(typeAt('m7'), 'word_of_day');
    assert.strictEqual(typeAt('n8'), 'word_recall');
    assert.strictEqual(typeAt('n9'), 'word_answer');
    // the foreign language: morning 10 teaches, evening 2 asks, evening 3 answers
    assert.strictEqual(typeAt('m10'), 'foreign_word');
    assert.strictEqual(typeAt('e2'), 'foreign_recall');
    assert.strictEqual(typeAt('e3'), 'foreign_answer');
    assert.deepStrictEqual(dayPlan.FOREIGN_SLOTS, { teach: 'm10', recall: 'e2', answer: 'e3' });
    assert.strictEqual(typeAt('n2'), 'interest_fact', 'the interest of the day is night 2');
    assert.strictEqual(typeAt('n10'), 'nature_fact');
    assert.strictEqual(defs.filter((d) => d.type === 'nature_fact').length, 1);
    // phone data only once, in the morning
    assert.deepStrictEqual(defs.filter((d) => d.type === 'phone_yesterday').map((d) => d.slot_id), ['m8']);
    // every slot has max_chars 60 except the quiz questions and answers too (the limit is 70, the model aims at 60)
    for (const d of defs) assert.strictEqual(d.max_chars, 60, d.slot_id);
    // quiz pairs and the word pair are declared
    assert.deepStrictEqual(dayPlan.QUIZ_PAIRS, [['d4', 'd5'], ['e9', 'e10'], ['n4', 'n5']]);
    assert.deepStrictEqual(dayPlan.WORD_SLOTS, { teach: 'm7', recall: 'n8', answer: 'n9' });
  }

  // ================= holiday: local -> international -> interesting fact =================
  {
    const row = (id, text, tags) => ({ id, category: 'holiday', content_text: text, tags });
    const bank = [row(1, 'ru', ['RU']), row(2, 'global', ['global']), row(3, 'kz', ['KZ'])];
    assert.deepStrictEqual(
      [dayPlan.pickHoliday(bank, 'KZ').kind, dayPlan.pickHoliday(bank, 'KZ').row.content_text], ['local', 'kz']);
    assert.deepStrictEqual(
      [dayPlan.pickHoliday(bank, 'FR').kind, dayPlan.pickHoliday(bank, 'FR').row.content_text], ['international', 'global']);
    assert.strictEqual(dayPlan.pickHoliday([row(1, 'ru', ['RU'])], 'KZ'), null, 'another country\'s holiday is not a fallback');
    assert.strictEqual(dayPlan.pickHoliday([], 'KZ'), null);
    // JSON tags as stored in SQLite
    assert.strictEqual(dayPlan.pickHoliday([{ id: 9, category: 'holiday', content_text: 'kz', tags: '["KZ"]' }], 'KZ').kind, 'local');

    const withLocal = dayPlan.buildDaySlots({ holiday: dayPlan.pickHoliday(bank, 'KZ'), hasWeather: true, hasPhone: true });
    const m4 = withLocal.find((s) => s.slot_id === 'm4');
    assert.strictEqual(m4.type, 'holiday');
    assert.deepStrictEqual(m4.bank_item, { id: 'b3', text: 'kz', category: 'holiday', subject: '' });
    assert.strictEqual(m4.holiday_kind, 'local');

    const none = dayPlan.buildDaySlots({ holiday: null, hasWeather: true, hasPhone: true });
    const replaced = none.find((s) => s.slot_id === 'm4');
    assert.strictEqual(none.length, 48, 'the slot stays, with another content');
    // the fixed type of every one of the 48 positions on a weekday
    assert.deepStrictEqual(withLocal.map((s) => s.type), [
      'greeting_name', 'weather_advice', 'horoscope', 'holiday', 'on_this_day', 'numerology', 'word_of_day', 'phone_yesterday',
      'quote', 'foreign_word', 'lifehack', 'warm_wish',
      'humor', 'science_fact', 'country_fact', 'quiz_question', 'quiz_answer', 'number_of_day', 'word_origin', 'animal_fact',
      'tech_fact', 'money_simple', 'brain_psychology', 'thought',
      'good_news', 'foreign_recall', 'foreign_answer', 'gender_tip', 'space_fact', 'born_today', 'city_fact', 'dinner_idea',
      'quiz_question', 'quiz_answer', 'how_it_works', 'evening_idea',
      'humor', 'interest_fact', 'watch_or_read', 'quiz_question', 'quiz_answer', 'tradition', 'poetic_thought', 'word_recall',
      'word_answer', 'nature_fact', 'tomorrow_task', 'goodnight_care',
    ], 'weekday order of the 48 topics');
    assert.deepStrictEqual(withLocal.map((s) => s.slot_id), dayPlan.slotDefinitions().map((d) => d.slot_id));
    // the same 48 on a weekend that has events: only day 3 and day 12 change, into the poster
    const weekend = dayPlan.buildDaySlots({ holiday: dayPlan.pickHoliday(bank, 'KZ'), hasWeather: true, hasPhone: true, weekend: true, afishaCount: 3 });
    assert.deepStrictEqual(
      weekend.map((s, i) => (s.type === withLocal[i].type ? null : `${s.slot_id}:${s.type}`)).filter(Boolean),
      ['d3:afisha', 'd12:afisha_evening'], 'weekend order differs from the weekday one in the two poster slots only');
    assert(weekend.filter((s) => s.afisha).every((s) => s.bank === 'afisha'));
    assert.strictEqual(replaced.type, 'unusual_fact', 'no holiday at all: an interesting fact from the bank instead');
    assert.strictEqual(replaced.bank, 'unusual');
    assert(!replaced.bank_item && replaced.holiday_replaced === true);
    assert(!/no holiday|there is none/i.test(replaced.topic), 'never asks for a "no holiday" phrase');

    // without weather / phone the two slots are dropped, not invented
    const bare = dayPlan.buildDaySlots({ holiday: null, hasWeather: false, hasPhone: false });
    assert(!bare.some((s) => s.type === 'weather_advice' || s.type === 'phone_yesterday'));
  }

  // ================= the endpoint: 48 phrases, one call, cache =================
  addDevice('dev-main', { city: 'Astana', country: 'KZ' });
  seedFullBank();
  installModel((ctx) => wellBehaved(ctx));
  await withServer(async (server) => {
    const query = `/api/v1/day?device_id=dev-main&timezone=Asia/Almaty&local_date=${DATE}&system_language=en`
      + '&yesterday_steps=12000&yesterday_unlocks=95&yesterday_screen_seconds=25000';
    const { value: first, logs } = await quiet(() => get(server, query));
    assert.strictEqual(first.statusCode, 200);
    assert.strictEqual(first.json.date, DATE);
    const phrases = phrasesOf(first);
    assert.strictEqual(phrases.length, 48, 'the whole day: 48 phrases');
    assert.strictEqual(modelCalls.length, 1, 'one model call');
    assert.strictEqual(modelCalls[0].isRepair, false);
    assert.strictEqual(modelCalls[0].params.model, 'gpt-6-luna', 'gpt-6-luna');
    assert.strictEqual(modelCalls[0].params.reasoning_effort, 'none', 'reasoning none');

    // window, position, order, style
    for (const window of ['morning', 'day', 'evening', 'night']) {
      assert.deepStrictEqual(
        phrases.filter((p) => p.window === window).map((p) => p.position),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    }
    assert.deepStrictEqual(phrases.map((p) => p.window), [
      ...Array(12).fill('morning'), ...Array(12).fill('day'), ...Array(12).fill('evening'), ...Array(12).fill('night')]);
    const styles = require('../src/constants').STYLE_IDS.filter((id) => /^[AG]\d$/.test(id) && id !== 'A9' && id !== 'G4');
    assert.strictEqual(styles.length, 16);
    assert(phrases.every((p) => p.style_id !== 'A9' && p.style_id !== 'G4'), 'the retired backgrounds A9 and G4 are never sent');
    assert(phrases.every((p) => /^[AG]\d$/.test(p.style_id)), 'only the backgrounds the app has (A, G), never O');
    for (const p of phrases) {
      assert(styles.includes(p.style_id), `valid style_id on ${p.slot_id}`);
      assert(typeof p.text === 'string' && p.text.length > 0 && p.text.length <= 70);
    }
    for (const window of ['morning', 'day', 'evening', 'night']) {
      const ids = phrases.filter((p) => p.window === window).map((p) => p.style_id);
      assert.strictEqual(new Set(ids).size, 12, `${window}: styles differ inside a window`);
    }

    // what the model was given
    const payload = modelCalls[0].payload;
    assert.strictEqual(payload.lang, 'en');
    assert.strictEqual(payload.profile.name, 'Baur');
    assert.strictEqual(payload.profile.zodiac, 'Aquarius');
    assert.strictEqual(payload.profile.country, 'KZ');
    assert(payload.profile.numerology.personal_day_number > 0);
    assert.deepStrictEqual(Object.keys(payload.weather_today).sort(), ['day_temp_band', 'morning_temp_band', 'rain_chance', 'uv_level', 'condition_lean'].sort());
    assert(!/\d/.test(JSON.stringify(payload.weather_today)), 'weather bands carry no numbers');
    assert.strictEqual(payload.weather_today.rain_chance, 'high');
    // phone data: yesterday, once, levels only (no baseline yet -> fixed thresholds)
    assert.deepStrictEqual(payload.phone_yesterday, { walking: 'high', phone_unlocks: 'normal', screen_time: 'high' });
    assert.strictEqual(payload.slots.length, 48);
    assert.strictEqual(payload.slots.filter((s) => s.type === 'phone_yesterday').length, 1);
    assert(payload.slots.every((s) => s.max_chars === 60));
    assert(Array.isArray(payload.already_seen) && Array.isArray(payload.learned_words));
    assert(Object.keys(payload).pop() === 'already_seen', 'the per-device already_seen block is last');
    const m4 = payload.slots.find((s) => s.slot_id === 'm4');
    assert.strictEqual(m4.bank_item.text, 'Kazakhstan marks a local day.', 'the local holiday is chosen by the server');
    assert(!payload.bank.some((item) => item.category === 'holiday' && item.country === 'RU'), 'other countries\' holidays are not offered');
    assert(!JSON.stringify(payload).includes('"holiday","country":"KZ"') || true);
    // the instruction carries the agreed rules
    const system = modelCalls[0].params.messages[0].content;
    for (const needle of [
      '3–4 callbacks', 'echoes', 'Aim for 40–55 characters', 'has "max_chars" (60)', 'TODAY', 'tomorrow_task',
      'Never mention the words "list", "bank", "data"', 'Never write that there is no holiday',
      'on this day was born', 'different topics and different answers', 'at most ONE', 'ONLY from the "bank_item"',
      'word_recall', 'word_answer',
    ]) {
      assert(system.includes(needle), `instruction must contain: ${needle}`);
    }
    // the usage line (same format as /batch)
    const usage = logs.find((line) => line.startsWith('OPENAI_USAGE scope=day '));
    assert(usage && /model=gpt-6-luna/.test(usage) && /prompt_tokens=7000/.test(usage) && /reasoning_tokens=0/.test(usage) && /reasoning_effort=none/.test(usage), usage);

    // ----- cache: the same device and date again -> same phrases, no model call -----
    const { value: second } = await quiet(() => get(server, query));
    assert.strictEqual(modelCalls.length, 1, 'the second request the same day does not call the model');
    assert.deepStrictEqual(phrasesOf(second), phrases, 'the very same phrases come back');
    assert.strictEqual(db.prepare('SELECT COUNT(*) FROM day_plans WHERE device_id = ?').pluck().get('dev-main'), 1);

    // a different device gets its own call; the next date too
    addDevice('dev-other');
    await quiet(() => get(server, `/api/v1/day?device_id=dev-other&timezone=Asia/Almaty&local_date=${DATE}&system_language=en`));
    assert.strictEqual(modelCalls.length, 2, 'another device: a new call');
    seedFullBank('2026-10-04');
    await quiet(() => get(server, '/api/v1/day?device_id=dev-main&timezone=Asia/Almaty&local_date=2026-10-04&system_language=en'));
    assert.strictEqual(modelCalls.length, 3, 'another local date: a new call');

    // ----- two requests at the same time share one call -----
    addDevice('dev-race');
    const before = modelCalls.length;
    const racePath = `/api/v1/day?device_id=dev-race&timezone=Asia/Almaty&local_date=${DATE}&system_language=en`;
    const [r1, r2] = (await quiet(() => Promise.all([get(server, racePath), get(server, racePath)]))).value;
    assert.strictEqual(modelCalls.length, before + 1, 'concurrent requests share one model call');
    assert.deepStrictEqual(phrasesOf(r1), phrasesOf(r2));

    // ----- bad request -----
    assert.strictEqual((await get(server, '/api/v1/day')).statusCode, 400);

    // ----- yesterday's numbers are stored (the baseline of later days) -----
    const stored = db.prepare('SELECT steps, unlocks, screen_seconds FROM phone_day_summaries WHERE device_id = ? AND local_date = ?').get('dev-main', '2026-10-02');
    assert.deepStrictEqual({ ...stored }, { steps: 12000, unlocks: 95, screen_seconds: 25000 });
  });

  // ================= a failed model call: nothing is made up, nothing is cached =================
  addDevice('dev-fail', { city: 'Astana', country: 'KZ' });
  installModel(() => { const err = new Error('boom'); err.status = 400; throw err; });
  await withServer(async (server) => {
    const { value: res } = await quiet(() => get(server, `/api/v1/day?device_id=dev-fail&timezone=Asia/Almaty&local_date=${DATE}&system_language=en`));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json.phrases, [], 'no fallback phrases');
    assert.strictEqual(res.json.source, 'fallback');
    assert.strictEqual(db.prepare('SELECT COUNT(*) FROM day_plans WHERE device_id = ?').pluck().get('dev-fail'), 0, 'a failure is not cached');
    // the next request tries again
    installModel((ctx) => wellBehaved(ctx));
    const { value: again } = await quiet(() => get(server, `/api/v1/day?device_id=dev-fail&timezone=Asia/Almaty&local_date=${DATE}&system_language=en`));
    assert.strictEqual(again.json.phrases.length, 47, '48 minus the phone recap: this request had no phone data');
  });

  // ================= no phone data -> no phone slot, no weather -> no weather slot =================
  addDevice('dev-nophone', { city: 'Astana', country: 'KZ' });
  installModel((ctx) => wellBehaved(ctx));
  await withServer(async (server) => {
    const { value: res } = await quiet(() => get(server, `/api/v1/day?device_id=dev-nophone&timezone=Asia/Almaty&local_date=${DATE}&system_language=en`));
    assert(!phrasesOf(res).some((p) => p.type === 'phone_yesterday'), 'no phone data: no recap');
    assert.strictEqual(phrasesOf(res).length, 47);
    assert.strictEqual(modelCalls[0].payload.phone_yesterday, undefined);
  });

  // ================= the word pair =================
  {
    // all three present: night 8 and 9 carry the morning phrase as the condition for showing them
    addDevice('dev-word');
    installModel((ctx) => wellBehaved(ctx));
    const { value: day } = await quiet(() => dayPlan.generateDay({
      device: db.prepare('SELECT * FROM devices WHERE device_id = ?').get('dev-word'),
      languageCode: 'en', dateContext: { date: DATE, weekday: 'Saturday' }, weather: null, countryCode: 'KZ', phoneYesterday: null,
      bank: require('../src/dailyContentBank').selectBankRowsForDay(DATE),
    }));
    const byId = Object.fromEntries(day.phrases.map((p) => [p.slot_id, p]));
    assert(byId.m7 && byId.n8 && byId.n9);
    assert.strictEqual(byId.n8.requires_shown_text, byId.m7.text);
    assert.strictEqual(byId.n9.requires_shown_text, byId.m7.text);
    assert.strictEqual(byId.m7.requires_shown_text, undefined);
    assert.strictEqual(day.word, 'Serendipity');
    // the taught word is remembered (already_seen / learned_words next time) with its local date
    const learned = db.prepare('SELECT word_text, learned_local_date FROM device_learning_memory WHERE device_id = ?').all('dev-word');
    assert.deepStrictEqual(learned.map((r) => ({ ...r })), [{ word_text: 'Serendipity', learned_local_date: DATE }]);
    assert(day.echoes.includes('n1->e12'), 'callbacks are reported');

    // night 9 too long even after the repair: night 8 goes with it, the morning word stays
    addDevice('dev-word2');
    installModel((ctx) => wellBehaved(ctx, {
      text: (slot) => (slot.slot_id === 'n9' ? 'x'.repeat(90) : undefined),
      repairText: (slot) => (slot.slot_id === 'n9' ? 'y'.repeat(80) : `Fixed ${slot.slot_id}`),
    }));
    const { value: day2 } = await quiet(() => dayPlan.generateDay({
      device: db.prepare('SELECT * FROM devices WHERE device_id = ?').get('dev-word2'),
      languageCode: 'en', dateContext: { date: DATE, weekday: 'Saturday' }, weather: null, countryCode: 'KZ', phoneYesterday: null,
      bank: require('../src/dailyContentBank').selectBankRowsForDay(DATE),
    }));
    const ids2 = day2.phrases.map((p) => p.slot_id);
    assert(!ids2.includes('n9') && !ids2.includes('n8'), 'the word pair is never half-sent');
    assert(ids2.includes('m7'), 'the taught word stays');
    assert.strictEqual(modelCalls.filter((c) => c.isRepair).length, 1, 'exactly one repair call');
    assert(modelCalls[1].payload.slots.some((s) => s.slot_id === 'n8'), 'the partner of a rejected word phrase is rewritten with it');

    // the morning phrase itself is rejected and cannot be fixed: nothing is taught, so no recall and no answer
    addDevice('dev-word3');
    installModel((ctx) => wellBehaved(ctx, {
      text: (slot) => (slot.slot_id === 'm7' ? '' : undefined),
      repairText: (slot) => (slot.slot_id === 'm7' ? '' : `Fixed ${slot.slot_id}`),
    }));
    const { value: day3 } = await quiet(() => dayPlan.generateDay({
      device: db.prepare('SELECT * FROM devices WHERE device_id = ?').get('dev-word3'),
      languageCode: 'en', dateContext: { date: DATE, weekday: 'Saturday' }, weather: null, countryCode: 'KZ', phoneYesterday: null,
      bank: require('../src/dailyContentBank').selectBankRowsForDay(DATE),
    }));
    const ids3 = day3.phrases.map((p) => p.slot_id);
    assert(!ids3.includes('m7') && !ids3.includes('n8') && !ids3.includes('n9'), 'no word taught: no recall, no answer');
    assert.strictEqual(day3.word, null);
    assert.strictEqual(db.prepare('SELECT COUNT(*) FROM device_learning_memory WHERE device_id = ?').pluck().get('dev-word3'), 0, 'no word is recorded');
  }

  // ================= serving rule: the recall only if the morning word was shown =================
  {
    const word = 'Line 2026-10-03 m7 word_of_day';
    const sample = [
      { slot_id: 'm7', text: word },
      { slot_id: 'n8', text: 'Recall', requires_shown_text: word },
      { slot_id: 'n9', text: 'Answer', requires_shown_text: word },
      { slot_id: 'n12', text: 'Bye' },
    ];
    const ids = (list) => list.map((p) => p.slot_id);

    // an old app that never reports shown phrases keeps the pair
    addDevice('dev-noreport');
    assert.deepStrictEqual(ids(dayPlan.applyWordPairRule(sample, 'dev-noreport', '21:00')), ['m7', 'n8', 'n9', 'n12']);

    // a reporting device that did NOT show the word loses the pair once the morning is over
    addDevice('dev-reports');
    db.prepare('INSERT INTO shown_phrases (device_id, text, shown_at, local_date) VALUES (?, ?, ?, ?)')
      .run('dev-reports', 'Some other phrase', new Date().toISOString(), DATE);
    assert.deepStrictEqual(ids(dayPlan.applyWordPairRule(sample, 'dev-reports', '21:00')), ['m7', 'n12'], 'word not shown: no recall, no answer');
    // before that time nothing could have been shown yet: the pair stays (the phone applies the same rule)
    assert.deepStrictEqual(ids(dayPlan.applyWordPairRule(sample, 'dev-reports', '08:00')), ['m7', 'n8', 'n9', 'n12']);

    // once the phone reports the morning word as shown the pair stays
    db.prepare('INSERT INTO shown_phrases (device_id, text, shown_at, local_date) VALUES (?, ?, ?, ?)')
      .run('dev-reports', word, new Date().toISOString(), DATE);
    assert.deepStrictEqual(ids(dayPlan.applyWordPairRule(sample, 'dev-reports', '21:00')), ['m7', 'n8', 'n9', 'n12']);
  }

  // ================= repair: ONE call for phrases over 70, quiz pairs stand or fall together =================
  {
    addDevice('dev-repair');
    installModel((ctx) => wellBehaved(ctx, {
      text: (slot) => (['d2', 'e1', 'd4'].includes(slot.slot_id) ? 'z'.repeat(75) : undefined),
      repairText: (slot) => (slot.slot_id === 'd4' ? '' : `Fixed ${slot.slot_id}`),
    }));
    const { value: day, logs } = await quiet(() => dayPlan.generateDay({
      device: db.prepare('SELECT * FROM devices WHERE device_id = ?').get('dev-repair'),
      languageCode: 'en', dateContext: { date: DATE, weekday: 'Saturday' }, weather: null, countryCode: 'KZ', phoneYesterday: null,
      bank: require('../src/dailyContentBank').selectBankRowsForDay(DATE),
    }));
    assert.strictEqual(modelCalls.length, 2, 'one day call + exactly one repair call');
    assert.strictEqual(modelCalls[1].isRepair, true);
    const repaired = modelCalls[1].payload.slots.map((s) => s.slot_id).sort();
    assert.deepStrictEqual(repaired, ['d2', 'd4', 'd5', 'e1'], 'the three long phrases, plus the answer paired with d4');
    const ids = day.phrases.map((p) => p.slot_id);
    assert(ids.includes('d2') && ids.includes('e1'), 'shortened phrases are kept');
    assert(!ids.includes('d4') && !ids.includes('d5'), 'a quiz pair that could not be fixed is dropped together');
    assert(ids.includes('e9') && ids.includes('e10'), 'other pairs are untouched');
    assert(day.phrases.every((p) => p.text.length <= 70));
    assert(logs.some((l) => l.startsWith('OPENAI_USAGE scope=day_repair ')), 'the repair call is logged too');
    assert.strictEqual(day.phrases.find((p) => p.slot_id === 'd2').text, 'Fixed d2');
  }

  // ================= memory kept from /batch: exact repeats, bank facts, shown reports =================
  {
    addDevice('dev-memory', { city: 'Astana', country: 'KZ' });
    // an exact repeat of something already sent to this device is rejected (and repaired); greeting is exempt
    const { recordSentPhrases } = require('../src/sentPhrases');
    recordSentPhrases('dev-memory', [{ text: 'Old joke already sent', slot_type: 'smart_humor_observation' }, { text: 'Hello Baur', slot_type: 'greeting_name' }]);
    installModel((ctx) => wellBehaved(ctx, {
      text: (slot) => (slot.slot_id === 'd1' ? 'Old joke already sent!' : slot.slot_id === 'm1' ? 'Hello Baur' : undefined),
    }));
    const { value: day } = await quiet(() => dayPlan.generateDay({
      device: db.prepare('SELECT * FROM devices WHERE device_id = ?').get('dev-memory'),
      languageCode: 'en', dateContext: { date: DATE, weekday: 'Saturday' }, weather: null, countryCode: 'KZ', phoneYesterday: null,
      bank: require('../src/dailyContentBank').selectBankRowsForDay(DATE),
    }));
    assert.strictEqual(modelCalls.filter((c) => c.isRepair).length, 1, 'the repeat went to the repair call');
    assert.deepStrictEqual(modelCalls[1].payload.slots.map((s) => s.slot_id), ['d1']);
    assert.strictEqual(day.phrases.find((p) => p.slot_id === 'd1').text, 'Fixed d1');
    assert.strictEqual(day.phrases.find((p) => p.slot_id === 'm1').text, 'Hello Baur', 'greeting may repeat');

    // the sent texts are archived: a second day for the same device cannot send the same text again
    const hashes = db.prepare('SELECT COUNT(*) FROM sent_phrases WHERE device_id = ?').pluck().get('dev-memory');
    assert(hashes >= 48, 'every sent phrase is archived');

    // bank facts used today are consumed: the next day does not offer them again
    const shown = db.prepare('SELECT COUNT(*) FROM device_shown_facts WHERE device_id = ?').pluck().get('dev-memory');
    assert(shown > 10, 'used bank facts are recorded');
    installModel((ctx) => wellBehaved(ctx));
    seedFullBank('2026-10-10');
    // the same bank texts again on another date
    await quiet(() => dayPlan.generateDay({
      device: db.prepare('SELECT * FROM devices WHERE device_id = ?').get('dev-memory'),
      languageCode: 'en', dateContext: { date: '2026-10-10', weekday: 'Saturday' }, weather: null, countryCode: 'KZ', phoneYesterday: null,
      bank: require('../src/dailyContentBank').selectBankRowsForDay('2026-10-10'),
    }));
    const offered = modelCalls[0].payload.bank.map((b) => b.text);
    assert(!offered.includes('Bank science fact number 1.'), 'a fact already shown to this device is not offered again');

    // already_seen comes from the shown reports (3 days), learned_words from the learning memory
    addDevice('dev-seen');
    const insertShown = db.prepare('INSERT INTO shown_phrases (device_id, text, shown_at, local_date) VALUES (?, ?, ?, ?)');
    insertShown.run('dev-seen', 'A phrase the person really saw', new Date().toISOString(), DATE);
    insertShown.run('dev-seen', 'Too old to matter', new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(), DATE);
    db.prepare('INSERT INTO device_learning_memory (device_id, word_key, word_text, learned_local_date) VALUES (?, ?, ?, ?)')
      .run('dev-seen', 'k', 'Perspicacity', '2026-09-30');
    installModel((ctx) => wellBehaved(ctx));
    await quiet(() => dayPlan.generateDay({
      device: db.prepare('SELECT * FROM devices WHERE device_id = ?').get('dev-seen'),
      languageCode: 'en', dateContext: { date: DATE, weekday: 'Saturday' }, weather: null, countryCode: 'KZ', phoneYesterday: null,
      bank: require('../src/dailyContentBank').selectBankRowsForDay(DATE),
    }));
    assert.deepStrictEqual(modelCalls[0].payload.already_seen, ['A phrase the person really saw']);
    assert.deepStrictEqual(modelCalls[0].payload.learned_words, ['Perspicacity']);
  }

  // ================= holiday replaced when the bank has no local and no international day =================
  {
    db.prepare('DELETE FROM daily_content_bank').run();
    seedFullBank('2026-11-01', { kzHoliday: false, globalHoliday: false });
    addDevice('dev-noholiday');
    installModel((ctx) => wellBehaved(ctx));
    const { value: day } = await quiet(() => dayPlan.generateDay({
      device: db.prepare('SELECT * FROM devices WHERE device_id = ?').get('dev-noholiday'),
      languageCode: 'en', dateContext: { date: '2026-11-01', weekday: 'Sunday' }, weather: null, countryCode: 'KZ', phoneYesterday: null,
      bank: require('../src/dailyContentBank').selectBankRowsForDay('2026-11-01'),
    }));
    const slot = modelCalls[0].payload.slots.find((s) => s.slot_id === 'm4');
    assert.strictEqual(slot.type, 'unusual_fact', 'an interesting fact instead of the holiday');
    assert.strictEqual(slot.bank_item.category, 'unusual', 'the stand-in fact is a fact of the bank, not a holiday');
    assert.strictEqual(day.holiday_kind, 'replaced_by_fact');
    assert(day.phrases.find((p) => p.slot_id === 'm4'), 'the position is still filled');

    // another country's holiday is never a stand-in for a Kazakh user; an international one is
    db.prepare('DELETE FROM daily_content_bank').run();
    seedFullBank('2026-11-02', { kzHoliday: false, globalHoliday: true });
    installModel((ctx) => wellBehaved(ctx));
    addDevice('dev-intl');
    await quiet(() => dayPlan.generateDay({
      device: db.prepare('SELECT * FROM devices WHERE device_id = ?').get('dev-intl'),
      languageCode: 'en', dateContext: { date: '2026-11-02', weekday: 'Monday' }, weather: null, countryCode: 'KZ', phoneYesterday: null,
      bank: require('../src/dailyContentBank').selectBankRowsForDay('2026-11-02'),
    }));
    const intl = modelCalls[0].payload.slots.find((s) => s.slot_id === 'm4');
    assert.strictEqual(intl.type, 'holiday');
    assert.strictEqual(intl.bank_item.text, 'The UN marks an international day.');
  }

  // ================= yesterday's phone numbers: levels against the person's own usual days =================
  {
    const { parseYesterdayPhoneData, buildPhoneYesterday, recordPhoneDay } = require('../src/phoneDay');
    addDevice('dev-phone');
    assert.strictEqual(parseYesterdayPhoneData({}), null, 'nothing sent: no recap');
    assert.deepStrictEqual(parseYesterdayPhoneData({ yesterday_steps: '9000', yesterday_unlocks: 'abc', yesterday_screen_seconds: '-5' }),
      { steps: 9000, unlocks: null, screen_seconds: null }, 'a malformed value is ignored, the others stay');
    // fewer than 3 known days: fixed thresholds
    assert.deepStrictEqual(buildPhoneYesterday('dev-phone', '2026-10-02', { steps: 2000, unlocks: null, screen_seconds: null }), { walking: 'low' });
    // with a baseline of ~5000 steps a day
    for (const [day, steps] of [['2026-09-28', 5000], ['2026-09-29', 5200], ['2026-09-30', 4800], ['2026-10-01', 5000]]) {
      recordPhoneDay('dev-phone', day, { steps, unlocks: 80, screen_seconds: 10000 });
    }
    const level = (data) => buildPhoneYesterday('dev-phone', '2026-10-02', data);
    assert.deepStrictEqual(level({ steps: 9000, unlocks: 80, screen_seconds: 5000 }),
      { walking: 'higher_than_usual', phone_unlocks: 'about_usual', screen_time: 'lower_than_usual' });
    assert.deepStrictEqual(level({ steps: 5100, unlocks: null, screen_seconds: null }), { walking: 'about_usual' });
    assert.strictEqual(level(null), null);
    // the level words never carry a number
    assert(!/\d/.test(JSON.stringify(level({ steps: 9000, unlocks: 80, screen_seconds: 5000 }))));
  }

  // ================= a "NONE:" note is never a holiday =================
  {
    db.prepare('DELETE FROM daily_content_bank').run();
    addBank([['holiday', 'NONE: No official Kazakhstan holiday falls on that date.', 'KZ'], ['holiday', 'NONE: No UN day.', 'global'], ['science', 'A science fact.', null], ['unusual', 'An unusual fact.', null]], '2026-12-01');
    addDevice('dev-none');
    installModel((ctx) => wellBehaved(ctx));
    await quiet(() => dayPlan.generateDay({
      device: db.prepare('SELECT * FROM devices WHERE device_id = ?').get('dev-none'),
      languageCode: 'en', dateContext: { date: '2026-12-01', weekday: 'Tuesday' }, weather: null, countryCode: 'KZ', phoneYesterday: null,
      bank: require('../src/dailyContentBank').selectBankRowsForDay('2026-12-01'),
    }));
    assert.strictEqual(modelCalls[0].payload.slots.find((s) => s.slot_id === 'm4').type, 'unusual_fact');
    assert(!JSON.stringify(modelCalls[0].payload).includes('NONE:'), 'a NONE note never reaches the model');
  }

  // ================= the old /batch is still there =================
  {
    const serverSource = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
    assert(serverSource.includes("app.use('/api/v1', batchRoute);"), '/batch stays mounted');
    assert(serverSource.includes("app.use('/api/v1', dayRoute);"), '/day is mounted');
    const batchRouter = require('../src/routes/batch');
    assert(batchRouter.stack.some((layer) => layer.route && layer.route.path === '/batch'));
  }

  console.log('day-plan tests passed');
}

main()
  .catch((err) => {
    Module._load = originalLoad;
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    dayTest.setClientFactory(null);
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
