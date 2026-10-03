// Day scheme v2 (task 27): the order of the 48 topics (weekday / weekend), the learning language and the
// "remember? -> right" pair, the interest circle, the weekend poster (Saturday and Sunday only, replaced
// when there are no events), facts about the user's own country and city, and the bank side (active
// locations, the poster asked for on Fridays only, tags of city and date, category counts in the log).
// The model and the weather are mocked: no real calls.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-dayv2-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '../weather') {
    return {
      resolveGeolocation: async () => ({ success: true, country_code: 'KZ' }),
      resolveWeather: async () => ({ countryCode: 'KZ' }),
      resolveWeatherByCoords: async () => ({ countryCode: 'KZ' }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const dayPlan = require('../src/dayPlan');
const dayRoute = require('../src/routes/day');
const rotation = require('../src/dayRotation');
const bank = require('../src/dailyContentBank');
const { applyWordPairRule } = dayPlan;

// ---- fake model ----
let modelCalls;

function installModel(overrides = {}) {
  modelCalls = [];
  dayPlan._test.setClientFactory(() => ({
    chat: {
      completions: {
        create: async (params) => {
          const isRepair = params.response_format.json_schema.name === 'lock_screen_day_repair';
          const payload = JSON.parse(params.messages[1].content);
          modelCalls.push({ params, payload, isRepair });
          const bankIdFor = (slot) => {
            if (slot.bank_item) return slot.bank_item.id;
            if (slot.bank && slot.bank !== 'any') {
              const row = payload.bank.find((item) => item.category === slot.bank);
              return row ? row.id : '';
            }
            return '';
          };
          const foreignWord = typeof overrides.foreignWord === 'function' ? overrides.foreignWord(payload, isRepair) : (overrides.foreignWord || `Palabra-${payload.date}`);
          const body = {
            phrases: payload.slots.map((slot) => ({
              slot_id: slot.slot_id,
              text: isRepair ? `Исправлено ${slot.slot_id}` : `Строка ${payload.date} ${slot.slot_id} ${slot.type}`,
              bank_id: bankIdFor(slot),
              echoes: '',
            })),
            word_of_day: 'Serendipity',
            foreign_word: foreignWord,
          };
          return { choices: [{ message: { content: JSON.stringify(body) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        },
      },
    },
  }));
}

function addDevice(id, fields = {}) {
  db.prepare(`
    INSERT OR REPLACE INTO devices (device_id, name, gender, birth_date, timezone, city_name, city_country_code, interests, learning_language)
    VALUES (?, 'Baur', 'male', ?, 'Asia/Almaty', ?, ?, ?, ?)
  `).run(id, fields.birth || '1990-02-05', fields.city || null, fields.country || null,
    fields.interests ? JSON.stringify(fields.interests) : null, fields.learning || null);
  return db.prepare('SELECT * FROM devices WHERE device_id = ?').get(id);
}

function addBank(rows, date) {
  const insert = db.prepare('INSERT INTO daily_content_bank (bank_date, category, content_text, tags) VALUES (?, ?, ?, ?)');
  for (const [category, text, tags] of rows) insert.run(date, category, text, JSON.stringify(tags || []));
}

// A bank with everything for Kazakhstan / Astana and Germany / Berlin and two facts per interest.
function seedBank(date, { skipInterests = [] } = {}) {
  const rows = [['holiday', 'The UN marks an international day.', ['global']]];
  for (const category of ['on_this_day', 'born_today', 'good_news', 'science', 'animals', 'space', 'nature', 'tech', 'unusual', 'money',
    'brain', 'word_origin', 'tradition', 'how_it_works', 'quote']) {
    rows.push([category, `Plain ${category} fact one ${date}.`, []], [category, `Plain ${category} fact two ${date}.`, []]);
  }
  rows.push(['country_fact', `KZ country fact ${date}.`, ['KZ']], ['country_fact', `DE country fact ${date}.`, ['DE']]);
  rows.push(['city_fact', `Astana city fact ${date}.`, ['KZ', 'city:astana']], ['city_fact', `Berlin city fact ${date}.`, ['DE', 'city:berlin']]);
  rows.push(['watch_read', `KZ film ${date}.`, ['KZ']], ['watch_read', `DE film ${date}.`, ['DE']], ['watch_read', `World series ${date}.`, ['global']]);
  for (const key of rotation.INTEREST_KEYS) {
    if (skipInterests.includes(key)) continue;
    rows.push([`interest_${key}`, `Interest ${key} fact one ${date}.`, []], [`interest_${key}`, `Interest ${key} fact two ${date}.`, []]);
  }
  addBank(rows, date);
}

async function generate(device, date, extra = {}) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.join(' '));
  try {
    const result = await dayPlan.generateDay({
      device: db.prepare('SELECT * FROM devices WHERE device_id = ?').get(device.device_id),
      languageCode: extra.languageCode || 'ru',
      learningLanguage: extra.learningLanguage,
      dateContext: { date },
      weather: null,
      countryCode: device.city_country_code || 'KZ',
      phoneYesterday: null,
      bank: bank.selectBankRowsForDay(date),
    });
    return { result, lines };
  } finally {
    Object.assign(console, original);
  }
}

const typeOf = (result, slotId) => (result.phrases.find((p) => p.slot_id === slotId) || {}).type;
const idsOf = (result) => result.phrases.map((p) => p.slot_id);

function get(server, pathName) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}${pathName}`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (err) { reject(err); } });
    }).on('error', reject);
  });
}

async function withServer(callback) {
  const app = express();
  app.use('/api/v1', dayRoute);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { return await callback(server); } finally { await new Promise((resolve) => server.close(resolve)); }
}

async function main() {
  // ================= 1. the order of the 48 topics, weekdays and weekends =================
  {
    const slotsFor = (flags) => dayPlan.buildDaySlots({ holiday: null, hasWeather: true, hasPhone: true, ...flags });
    const types = (slots) => slots.map((s) => `${s.slot_id}:${s.type}`);
    const weekday = slotsFor({});
    assert.strictEqual(weekday.length, 48);
    const expectedOrder = {
      morning: ['greeting_name', 'weather_advice', 'horoscope', 'unusual_fact', 'on_this_day', 'numerology', 'word_of_day', 'phone_yesterday',
        'quote', 'foreign_word', 'lifehack', 'warm_wish'],
      day: ['humor', 'science_fact', 'country_fact', 'quiz_question', 'number_of_day', 'quiz_answer', 'word_origin', 'animal_fact',
        'tech_fact', 'money_simple', 'brain_psychology', 'thought'],
      evening: ['good_news', 'foreign_recall', 'foreign_answer', 'gender_tip', 'space_fact', 'born_today', 'city_fact', 'dinner_idea',
        'quiz_question', 'how_it_works', 'quiz_answer', 'evening_idea'],
      night: ['humor', 'interest_fact', 'watch_or_read', 'quiz_question', 'tradition', 'quiz_answer', 'poetic_thought', 'word_recall',
        'word_answer', 'nature_fact', 'tomorrow_task', 'goodnight_care'],
    };
    for (const window of ['morning', 'day', 'evening', 'night']) {
      assert.deepStrictEqual(weekday.filter((s) => s.window === window).map((s) => s.type), expectedOrder[window], `weekday ${window}`);
    }
    // weekend with events: day 3 and day 12 are the poster, everything else is the same
    const weekend = slotsFor({ weekend: true, afishaCount: 4 });
    assert.strictEqual(weekend.length, 48);
    assert.deepStrictEqual(types(weekend).filter((t, i) => t !== types(weekday)[i]), ['d3:afisha', 'd12:afisha_evening']);
    // weekend without events: the weekday topics
    assert.deepStrictEqual(types(slotsFor({ weekend: true, afishaCount: 0 })), types(weekday));
    // a weekday never gets the poster, even if the bank has events
    assert.deepStrictEqual(types(slotsFor({ weekend: false, afishaCount: 9 })), types(weekday));
    // one event is enough for day 3 only, day 12 needs a second one
    assert.deepStrictEqual(types(slotsFor({ weekend: true, afishaCount: 1 })).filter((t, i) => t !== types(weekday)[i]), ['d3:afisha']);
    // slots without anything to stand on are dropped, never invented
    const bare = slotsFor({ hasCountryFacts: false, hasCityFacts: false, hasWatchRead: false, interest: null });
    assert.deepStrictEqual(types(weekday).filter((t) => !types(bare).includes(t)).sort(),
      ['d3:country_fact', 'e7:city_fact', 'n2:interest_fact', 'n3:watch_or_read']);
  }

  // ================= 2. the learning language and the remember -> right pair =================
  {
    const supported = require('../src/contentGenerator')._test.SUPPORTED_LANGUAGES;
    const resolve = (fields) => rotation.resolveLearningLanguage({ supported, ...fields });
    assert.strictEqual(resolve({ userLanguageCode: 'ru' }), 'en', 'default: English');
    assert.strictEqual(resolve({ userLanguageCode: 'en' }), 'es', 'an English-speaking user learns Spanish by default');
    assert.strictEqual(resolve({ userLanguageCode: 'ru', stored: 'fr' }), 'fr', 'the profile value');
    assert.strictEqual(resolve({ userLanguageCode: 'ru', stored: 'fr', requested: 'de' }), 'de', 'the request outranks the profile');
    assert.strictEqual(resolve({ userLanguageCode: 'ru', requested: 'ru' }), 'en', 'learning your own language is replaced by the default');
    assert.strictEqual(resolve({ userLanguageCode: 'en', requested: 'en' }), 'es');
    assert.strictEqual(resolve({ userLanguageCode: 'ru', requested: 'xx' }), 'en', 'an unknown code is ignored');
    assert.strictEqual(resolve({ userLanguageCode: 'ru', requested: 'EN' }), 'en');

    seedBank('2026-10-05'); // Monday
    seedBank('2026-10-06');
    installModel();
    const device = addDevice('dev-lang', { city: 'Astana', country: 'KZ' });
    const { result } = await generate(device, '2026-10-05');
    const byId = Object.fromEntries(result.phrases.map((p) => [p.slot_id, p]));
    assert.strictEqual(modelCalls[0].payload.learning_language, 'English', 'the payload names the learning language');
    assert.strictEqual(byId.m10.type, 'foreign_word');
    assert.strictEqual(byId.e2.type, 'foreign_recall');
    assert.strictEqual(byId.e3.type, 'foreign_answer');
    for (const id of ['m10', 'e2', 'e3']) assert.strictEqual(byId[id].learning_language, 'en', `${id} is labelled with the language`);
    assert.strictEqual(byId.e2.requires_shown_text, byId.m10.text, 'the recall needs the morning phrase to have been shown');
    assert.strictEqual(byId.e3.requires_shown_text, byId.m10.text);
    assert.strictEqual(byId.m10.requires_shown_text, undefined);
    assert.strictEqual(result.foreign_word, 'Palabra-2026-10-05');
    assert.strictEqual(byId.n8.requires_shown_text, byId.m7.text, 'the word-of-the-day pair is independent of it');
    const system = modelCalls[0].params.messages[0].content;
    for (const needle of ['foreign_recall', 'foreign_answer', 'learned_foreign_words', 'do you remember how to say']) {
      assert(system.includes(needle), `instruction must contain: ${needle}`);
    }

    // the word is kept per device and language and never taught again
    assert.deepStrictEqual(db.prepare('SELECT language, word_text, learned_local_date FROM device_foreign_words WHERE device_id = ?').all('dev-lang').map((r) => ({ ...r })),
      [{ language: 'en', word_text: 'Palabra-2026-10-05', learned_local_date: '2026-10-05' }]);
    installModel({ foreignWord: 'Palabra-2026-10-05' }); // the model offers the same word again, also after the repair
    const again = (await generate(device, '2026-10-06')).result;
    assert.deepStrictEqual(modelCalls[0].payload.learned_foreign_words, ['Palabra-2026-10-05']);
    assert.strictEqual(modelCalls.filter((c) => c.isRepair).length, 1, 'a repeated foreign word goes to the repair call');
    assert.deepStrictEqual(modelCalls[1].payload.slots.map((s) => s.slot_id).sort(), ['e2', 'e3', 'm10'], 'the whole trio is rewritten');
    assert(!idsOf(again).includes('m10') && !idsOf(again).includes('e2') && !idsOf(again).includes('e3'), 'still a repeat: nothing is taught, no recall, no answer');
    assert.strictEqual(again.foreign_word, null);
    assert.strictEqual(db.prepare('SELECT COUNT(*) FROM device_foreign_words WHERE device_id = ?').pluck().get('dev-lang'), 1);
    // a different language of the same device has its own list
    installModel({ foreignWord: 'Palabra-2026-10-05' });
    seedBank('2026-10-07');
    const french = (await generate(device, '2026-10-07', { learningLanguage: 'fr' })).result;
    assert.strictEqual(typeOf(french, 'm10'), 'foreign_word', 'the same word in another language is new');
    assert.strictEqual(french.learning_language, 'fr');

    // the profile value is used without a request value; an English user defaults to Spanish
    const profile = addDevice('dev-lang-profile', { learning: 'de' });
    installModel();
    await generate(profile, '2026-10-05');
    assert.strictEqual(modelCalls[0].payload.learning_language, 'German');
    const english = addDevice('dev-lang-en');
    installModel();
    await generate(english, '2026-10-05', { languageCode: 'en' });
    assert.strictEqual(modelCalls[0].payload.learning_language, 'Spanish');

    // the pair is served only when the morning word was shown (same rule as the word of the day)
    const word = 'Line 2026-10-05 m10 foreign_word';
    const sample = [
      { slot_id: 'm10', text: word },
      { slot_id: 'e2', text: 'Remember?', requires_shown_text: word },
      { slot_id: 'e3', text: 'Right', requires_shown_text: word },
      { slot_id: 'n8', text: 'Recall', requires_shown_text: 'the morning word' },
      { slot_id: 'n12', text: 'Bye' },
    ];
    const ids = (list) => list.map((p) => p.slot_id);
    addDevice('dev-old-app');
    assert.deepStrictEqual(ids(applyWordPairRule(sample, 'dev-old-app', '19:00')), ['m10', 'e2', 'e3', 'n8', 'n12'], 'an app that never reports keeps the pairs');
    addDevice('dev-reporter');
    db.prepare('INSERT INTO shown_phrases (device_id, text, shown_at, local_date) VALUES (?, ?, ?, ?)')
      .run('dev-reporter', 'something else', new Date().toISOString(), '2026-10-05');
    assert.deepStrictEqual(ids(applyWordPairRule(sample, 'dev-reporter', '19:00')), ['m10', 'n12'], 'neither morning phrase was shown: both pairs go');
    assert.deepStrictEqual(ids(applyWordPairRule(sample, 'dev-reporter', '09:00')), ['m10', 'e2', 'e3', 'n8', 'n12'], 'before the afternoon the pairs stay');
    db.prepare('INSERT INTO shown_phrases (device_id, text, shown_at, local_date) VALUES (?, ?, ?, ?)')
      .run('dev-reporter', word, new Date().toISOString(), '2026-10-05');
    assert.deepStrictEqual(ids(applyWordPairRule(sample, 'dev-reporter', '19:00')), ['m10', 'e2', 'e3', 'n12'], 'the foreign pair stays once its word was shown, the other one goes alone');

    // /day?learning_language= is stored on the device and used
    await withServer(async (server) => {
      addDevice('dev-http', { city: 'Astana', country: 'KZ' });
      installModel();
      const res = await get(server, '/api/v1/day?device_id=dev-http&timezone=Asia/Almaty&local_date=2026-10-06&system_language=ru&learning_language=it');
      assert.strictEqual(modelCalls[0].payload.learning_language, 'Italian');
      assert.strictEqual(db.prepare('SELECT learning_language FROM devices WHERE device_id = ?').pluck().get('dev-http'), 'it');
      assert(res.phrases.filter((p) => p.type.startsWith('foreign_')).every((p) => p.learning_language === 'it'), 'the response carries learning_language on the foreign phrases');
      assert(res.phrases.every((p) => p.type), 'every phrase has a type');
    });
  }

  // ================= 3. the interest circle =================
  {
    for (const date of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']) seedBank(date);
    // no valid interests chosen: all 12 in the order of the circle, one a day, the pointer is kept per device
    const device = addDevice('dev-circle', { city: 'Astana', country: 'KZ', interests: ['sport', 'work'] }); // old survey keys
    installModel();
    const seen = [];
    for (const date of ['2026-10-12', '2026-10-13', '2026-10-14']) {
      const { result } = await generate(device, date);
      assert.strictEqual(typeOf(result, 'n2'), 'interest_fact');
      const phrase = result.phrases.find((p) => p.slot_id === 'n2');
      assert.strictEqual(phrase.interest, result.interest, 'the phrase carries the interest key');
      seen.push(phrase.interest);
    }
    assert.deepStrictEqual(seen, ['technology', 'science_space', 'history'], 'the next interest every day');
    assert.strictEqual(rotation.loadLastInterest('dev-circle'), 'history', 'the pointer is stored per device');
    assert.strictEqual(rotation.loadLastInterest('dev-main-none'), null);
    // the fact comes from the bank of that interest
    const lastCall = modelCalls[modelCalls.length - 1];
    const n2Slot = lastCall.payload.slots.find((s) => s.slot_id === 'n2');
    assert.strictEqual(n2Slot.interest, 'history');
    assert(/^Interest history fact/.test(n2Slot.bank_item.text), 'the bank fact of the interest');
    assert(!lastCall.payload.bank.some((row) => row.category.startsWith('interest_') && row.category !== 'interest_history'), 'other interests are not offered');

    // the circle of the device's own list, wrapping round
    const own = addDevice('dev-own', { city: 'Astana', country: 'KZ', interests: ['food', 'technology', 'sport_health'] });
    const order = [];
    for (const date of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']) {
      order.push((await generate(own, date)).result.interest);
    }
    assert.deepStrictEqual(order, ['technology', 'sport_health', 'food', 'technology'], 'in the order of the circle of 12, then round again');
    assert.deepStrictEqual(rotation.interestCircle(['technology', 'food'], 'food'), ['technology', 'food']);
    assert.deepStrictEqual(rotation.interestCircle(['technology', 'food', 'auto'], 'technology'), ['food', 'auto', 'technology']);
    assert.deepStrictEqual(rotation.interestCircle(['technology', 'auto'], 'history'), ['auto', 'technology'], 'a pointer outside the list goes on from its place');
    assert.deepStrictEqual(rotation.deviceInterestKeys({ interests: '["auto","nonsense","food"]' }), ['food', 'auto']);
    assert.strictEqual(rotation.deviceInterestKeys({ interests: null }).length, 12);

    // an interest without a usable fact is skipped (not stuck on), and its turn is not lost for good
    addDevice('dev-skip', { city: 'Astana', country: 'KZ', interests: ['technology', 'science_space', 'history'] });
    db.prepare('DELETE FROM daily_content_bank WHERE bank_date = ? AND category = ?').run('2026-10-14', 'interest_science_space');
    rotation.recordInterest('dev-skip', 'technology', '2026-10-13');
    const skipped = (await generate({ device_id: 'dev-skip', city_country_code: 'KZ' }, '2026-10-14')).result;
    assert.strictEqual(skipped.interest, 'history', 'science_space has no fact today: the next one is used');
    assert.strictEqual(rotation.loadLastInterest('dev-skip'), 'history');
    // nothing at all for the device's interests: the slot is dropped and the pointer stays
    addDevice('dev-none', { city: 'Astana', country: 'KZ', interests: ['auto'] });
    db.prepare('DELETE FROM daily_content_bank WHERE bank_date = ? AND category = ?').run('2026-10-15', 'interest_auto');
    const none = (await generate({ device_id: 'dev-none', city_country_code: 'KZ' }, '2026-10-15')).result;
    assert(!idsOf(none).includes('n2') && none.interest === null);
    assert.strictEqual(rotation.loadLastInterest('dev-none'), null);

    // a fact the device has seen is not offered again (the second fact of the interest is used)
    const system = modelCalls[0].params.messages[0].content;
    assert(/never advice to buy, sell, invest or save/.test(system), 'money: facts and concepts only');
    assert(/never medical advice, treatment, diets/.test(system), 'health: no medical advice');
    const prompt = bank.buildBankPrompt('2026-10-12', ['KZ'], []);
    assert(/interest_money_business: only facts and explanations of concepts, never advice to buy, sell or invest/.test(prompt));
    assert(/interest_sport_health: only facts, never medical advice/.test(prompt));
    for (const key of rotation.INTEREST_KEYS) assert(prompt.includes(`interest_${key}`), `the bank asks for ${key}`);
    assert(/3 fresh facts for each/.test(prompt));
  }

  // ================= 4. the weekend poster: Saturday and Sunday only, replaced when there are no events =================
  {
    // Friday 2026-10-16: the bank run with the events for both days; later banks have none of their own
    const events = [
      ['afisha', 'Hamlet at the Opera House, 2026-10-17, 19:00, 16+.', ['KZ', 'city:astana', 'date:2026-10-17']],
      ['afisha', 'Stand-up show at Arena, 2026-10-17, 20:00.', ['KZ', 'city:astana', 'date:2026-10-17']],
      ['afisha', 'Football match at Central Stadium, 2026-10-18, 16:00.', ['KZ', 'city:astana', 'date:2026-10-18']],
      ['afisha', 'Concert in Almaty, 2026-10-17, 19:00.', ['KZ', 'city:almaty', 'date:2026-10-17']],
    ];
    seedBank('2026-10-16');
    addBank(events, '2026-10-16');
    seedBank('2026-10-17');
    seedBank('2026-10-18');
    seedBank('2026-10-19');
    const device = addDevice('dev-poster', { city: 'Astana', country: 'KZ' });
    installModel();

    // Friday itself: no poster, though the bank holds events
    const friday = (await generate(device, '2026-10-16')).result;
    assert.strictEqual(typeOf(friday, 'd3'), 'country_fact');
    assert.strictEqual(typeOf(friday, 'd12'), 'thought');
    assert(!modelCalls[0].payload.bank.some((row) => row.category === 'afisha'), 'no events are offered on a weekday');

    // Saturday: the poster, only this city's events of this day (read back from Friday's bank)
    const saturday = (await generate(device, '2026-10-17')).result;
    assert.strictEqual(typeOf(saturday, 'd3'), 'afisha');
    assert.strictEqual(typeOf(saturday, 'd12'), 'afisha_evening');
    const offered = modelCalls[modelCalls.length - 1].payload.bank.filter((row) => row.category === 'afisha').map((row) => row.text).sort();
    assert.deepStrictEqual(offered, ['Hamlet at the Opera House, 2026-10-17, 19:00, 16+.', 'Stand-up show at Arena, 2026-10-17, 20:00.'],
      'the events of the user\'s city for exactly this day');
    const d3 = modelCalls[modelCalls.length - 1].payload.slots.find((s) => s.slot_id === 'd3');
    assert.strictEqual(d3.bank, 'afisha');
    assert(/suits the user's age/.test(d3.topic), 'the model chooses the event with the age in mind');
    assert.strictEqual(modelCalls[modelCalls.length - 1].payload.profile.age >= 0, true, 'the age is in the profile');
    assert(/fits the user's age/.test(modelCalls[modelCalls.length - 1].params.messages[0].content));

    // Sunday: one event is left, which is enough for day 3 only
    const sunday = (await generate(addDevice('dev-poster2', { city: 'Astana', country: 'KZ' }), '2026-10-18')).result;
    assert.strictEqual(typeOf(sunday, 'd3'), 'afisha');
    assert.strictEqual(typeOf(sunday, 'd12'), 'thought', 'day 12 needs a second event');

    // a weekend without events (another city, or none stored): the weekday topics
    const berlin = addDevice('dev-poster-berlin', { city: 'Berlin', country: 'DE' });
    const noEvents = (await generate(berlin, '2026-10-17')).result;
    assert.strictEqual(typeOf(noEvents, 'd3'), 'country_fact');
    assert.strictEqual(typeOf(noEvents, 'd12'), 'thought');
    assert.strictEqual(noEvents.phrases.length, 48 - 1 /* no phone */ - 1 /* no weather */, 'the replaced slots stay filled');
    seedBank('2026-10-24');
    seedBank('2026-10-25');
    const later = (await generate(device, '2026-10-24')).result; // Saturday, events were only built for the Saturday before
    assert.strictEqual(typeOf(later, 'd3'), 'country_fact', 'old events never reach another weekend');

    // the bank asks for the poster on Fridays only, for the cities of the active devices
    db.prepare('INSERT INTO day_plans (device_id, local_date, phrases, source) VALUES (?, ?, ?, ?)').run('dev-poster', '2026-10-15', '[]', 'openai');
    const fridayPrompt = bank.buildBankPrompt('2026-10-16', ['KZ'], [], { countries: ['KZ'], cities: [{ name: 'Astana', country: 'KZ' }, { name: 'Berlin', country: 'DE' }] });
    assert(fridayPrompt.includes('afisha (REQUIRED today'), 'Friday asks for the events');
    assert(fridayPrompt.includes('2026-10-17') && fridayPrompt.includes('2026-10-18'), 'for Saturday and Sunday');
    assert(fridayPrompt.includes('Astana (KZ), Berlin (DE)'), 'in the cities of the active devices');
    assert(/theatre, cinema, concerts, sport, stand-up/.test(fridayPrompt));
    assert(/never invent/.test(fridayPrompt));
    for (const day of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-17', '2026-10-18']) {
      const prompt = bank.buildBankPrompt(day, ['KZ'], [], { countries: ['KZ'], cities: [{ name: 'Astana', country: 'KZ' }] });
      assert(!prompt.includes('afisha'), `${day} does not ask for events`);
    }
  }

  // ================= 5. facts about the user's own country and city =================
  {
    seedBank('2026-10-20');
    const astana = addDevice('dev-astana', { city: 'Astana', country: 'KZ' });
    const berlin = addDevice('dev-berlin', { city: 'Berlin', country: 'DE' });
    const paris = addDevice('dev-paris', { city: 'Paris', country: 'FR' });
    installModel();
    const a = (await generate(astana, '2026-10-20')).result;
    const b = (await generate(berlin, '2026-10-20')).result;
    const p = (await generate(paris, '2026-10-20')).result;
    const offered = (call) => call.payload.bank.filter((row) => ['country_fact', 'city_fact', 'watch_read'].includes(row.category)).map((row) => row.text).sort();
    assert.deepStrictEqual(offered(modelCalls[0]), ['Astana city fact 2026-10-20.', 'KZ country fact 2026-10-20.', 'KZ film 2026-10-20.'], 'Astana: its city, its country, its films');
    assert.deepStrictEqual(offered(modelCalls[1]), ['Berlin city fact 2026-10-20.', 'DE country fact 2026-10-20.', 'DE film 2026-10-20.'], 'Berlin: not the Kazakh facts');
    assert(a.phrases.find((x) => x.slot_id === 'e7') && b.phrases.find((x) => x.slot_id === 'e7'));
    assert.strictEqual(typeOf(a, 'e7'), 'city_fact');
    // Paris has no city and no country fact in the bank: those slots are dropped, the films fall back to the world-famous ones
    assert.deepStrictEqual(offered(modelCalls[2]), ['World series 2026-10-20.']);
    assert(!idsOf(p).includes('d3') && !idsOf(p).includes('e7'), 'no fact about Paris or France: nothing is made up');
    assert(idsOf(p).includes('n3'));
    // a user whose city is not given gets the country facts but no city fact
    const nameless = addDevice('dev-nocity', { country: 'KZ' });
    const n = (await generate(nameless, '2026-10-20')).result;
    assert(idsOf(n).includes('d3') && !idsOf(n).includes('e7'));
    // the same city name in another case still matches
    const shouting = addDevice('dev-shout', { city: 'ASTANA', country: 'KZ' });
    assert(idsOf((await generate(shouting, '2026-10-20')).result).includes('e7'));
    // old Kazakhstan-only rows (country_kz / city_astana) still serve Kazakhstan and Astana
    addBank([['holiday', 'A day.', ['global']], ['country_kz', 'Old KZ fact.', ['KZ']], ['city_astana', 'Old Astana fact.', ['KZ']]], '2026-10-21');
    const legacy = dayPlan.bankRowsForUser(bank.selectBankRowsForDay('2026-10-21').rows, { countryCode: 'KZ', cityName: 'Astana', date: '2026-10-21' });
    assert.deepStrictEqual(legacy.filter((r) => r.category !== 'holiday').map((r) => [r.category, r.content_text]).sort(), [['city_fact', 'Old Astana fact.'], ['country_fact', 'Old KZ fact.']]);
    assert.deepStrictEqual(dayPlan.bankRowsForUser(bank.selectBankRowsForDay('2026-10-21').rows, { countryCode: 'DE', cityName: 'Berlin' }).filter((r) => r.category !== 'holiday'), []);

    // the bank side: the cities and countries of the ACTIVE devices
    const insertPlan = db.prepare('INSERT OR IGNORE INTO day_plans (device_id, local_date, phrases, source) VALUES (?, ?, ?, ?)');
    for (const id of ['dev-berlin', 'dev-paris']) insertPlan.run(id, '2026-10-20', '[]', 'openai');
    const idle = addDevice('dev-idle', { city: 'Tokyo', country: 'JP' }); // never asked for a day: not active
    assert(idle);
    // active = got a day plan or a batch in the last 14 days (the plans above are dated "now" by created_at)
    const locations = bank.collectActiveLocations();
    assert(locations.countries.includes('KZ') && locations.countries.includes('DE') && locations.countries.includes('FR'), 'countries of active devices');
    assert(!locations.countries.includes('JP'), 'an inactive device adds nothing');
    assert.deepStrictEqual(locations.cities.map((c) => `${c.name}/${c.country}`).sort().filter((c) => /Berlin|Paris|Astana/.test(c)),
      ['Astana/KZ', 'Berlin/DE', 'Paris/FR'], 'cities of active devices, Astana always in');
    const capped = bank.collectActiveLocations({ maxCountries: 2, maxCities: 1 });
    assert.strictEqual(capped.countries.length, 2);
    assert.strictEqual(capped.cities.length, 1);
    const prompt = bank.buildBankPrompt('2026-10-20', ['KZ'], [], { countries: ['KZ', 'DE'], cities: [{ name: 'Berlin', country: 'DE' }] });
    assert(prompt.includes('country_fact: for EACH of these countries: KZ, DE: 3 facts'));
    assert(prompt.includes('city_fact: for EACH of these cities: Berlin (DE): 3 facts'));
    assert(/watch_read: for EACH of these countries: KZ, DE: 3 real, well-known films, series or books/.test(prompt));
    assert(/Never invent a title/.test(prompt));
    assert(!/country_kz|city_astana/.test(prompt), 'the old Kazakhstan-only categories are no longer asked for');

    // parsing keeps country, city and event date as tags
    const parsed = bank.cityTag('Astana');
    assert.strictEqual(parsed, 'city:astana');
    const { rows } = bank._test.parseBankItems(JSON.stringify([
      { category: 'city_fact', country: 'de', city: 'Berlin', date: '', text: 'Berlin has a fact.' },
      { category: 'afisha', country: 'KZ', city: 'Astana', date: '2026-10-17', text: 'Hamlet at the Opera House.' },
      { category: 'interest_food', country: '', city: '', date: '', text: 'A food fact.' },
      { category: 'watch_read', country: 'global', text: 'A world film.' },
      { category: 'afisha', city: 'Astana', date: 'someday', text: 'An event with no country.' },
    ]), '2026-10-16');
    assert.deepStrictEqual(rows.map((r) => r.tags), [['DE', 'city:berlin'], ['KZ', 'city:astana', 'date:2026-10-17'], [], ['global'], ['global', 'city:astana']]);
    assert.strictEqual(bank._test.parseBankItems('[{"category":"interest_nonsense","text":"x"}]', '2026-10-16').rows.length, 0, 'an unknown interest is dropped');

    // the log: the number of records of every category (the price line is OPENAI_USAGE scope=daily_bank)
    const lines = [];
    const log = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    bank._test.logBankCategoryCounts(rows, '2026-10-16');
    console.log = log;
    assert(lines[0].startsWith('BANK_CATEGORY_COUNTS total=5 '));
    assert(/city_fact=1/.test(lines[0]) && /afisha=1|afisha=2/.test(lines[0]) && /interest_food=1/.test(lines[0]) && /interest_auto=0/.test(lines[0]) && /country_fact=0/.test(lines[0]));
    lines.length = 0;
    console.log = (...a) => lines.push(a.join(' '));
    bank._test.logBankCategoryCounts(rows, '2026-10-15'); // a Thursday: events are not asked for
    console.log = log;
    assert(!/afisha=/.test(lines[0]));
  }

  // ================= 6. the whole bank run: price line and counts in the log, rows saved with their tags =================
  {
    const lines = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    process.env.OPENAI_API_KEY = 'test-key';
    const today = bank.getBankDateString();
    const items = [
      { category: 'holiday', country: 'KZ', text: 'A Kazakh day.' },
      { category: 'holiday', country: 'global', text: 'An international day.' },
      { category: 'city_fact', country: 'KZ', city: 'Astana', text: 'Astana fact.' },
      { category: 'interest_travel', text: 'Travel fact.' },
    ];
    bank._test.setBankClientFactory(() => ({
      responses: {
        create: async () => ({
          output_text: JSON.stringify(items),
          output: [{ type: 'web_search_call' }, { type: 'web_search_call' }],
          usage: { input_tokens: 12000, output_tokens: 6000, total_tokens: 18000, output_tokens_details: { reasoning_tokens: 1000 } },
        }),
      },
    }));
    console.log = console.warn = console.error = (...a) => lines.push(a.join(' '));
    const outcome = await bank.generateDailyBank();
    Object.assign(console, original);
    bank._test.setBankClientFactory(null);
    delete process.env.OPENAI_API_KEY;
    assert.strictEqual(outcome.savedCount, 4);
    assert(lines.some((l) => l.startsWith('OPENAI_USAGE scope=daily_bank ') && /prompt_tokens=12000/.test(l) && /searches=2/.test(l)), 'the price line');
    assert(lines.some((l) => l.startsWith('BANK_CATEGORY_COUNTS total=4 ') && /holiday=2/.test(l) && /city_fact=1/.test(l) && /interest_travel=1/.test(l)), 'the counts per category');
    const saved = db.prepare('SELECT tags FROM daily_content_bank WHERE bank_date = ? AND category = ?').pluck().get(today, 'city_fact');
    assert.deepStrictEqual(JSON.parse(saved), ['KZ', 'city:astana']);
  }

  console.log('day-v2 tests passed');
}

main()
  .catch((err) => {
    Module._load = originalLoad;
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    dayPlan._test.setClientFactory(null);
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
