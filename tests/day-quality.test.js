// Quality of the day (task 28): one fact once a day, strictly its own category and its own date, a useful foreign
// word and a modern word of the day, a real tip for men or women, themes instead of texts (subjects and a stop
// list in the bank), and the new quiz (question with 2-3 options, the very next slot the answer with its reason).
// The model and the weather are mocked: no real calls.
const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-quality-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '../weather') {
    return { resolveGeolocation: async () => ({ success: true }), resolveWeather: async () => ({ countryCode: 'KZ' }), resolveWeatherByCoords: async () => ({ countryCode: 'KZ' }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const dayPlan = require('../src/dayPlan');
const bank = require('../src/dailyContentBank');
const rotation = require('../src/dayRotation');

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
          const word = isRepair ? (overrides.repairForeignWord || 'Entschlossenheit') : (overrides.foreignWord || `Palabra${payload.date}`);
          const body = {
            phrases: payload.slots.map((slot) => ({
              slot_id: slot.slot_id,
              text: `Строка ${slot.slot_id} ${slot.type}`,
              bank_id: 'b999999', // whatever the model writes, the fact of the slot is the one the server gave it
              echoes: '',
            })),
            word_of_day: 'Зыбкий',
            foreign_word: word,
          };
          return { choices: [{ message: { content: JSON.stringify(body) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        },
      },
    },
  }));
}

function addDevice(id, fields = {}) {
  db.prepare(`
    INSERT OR REPLACE INTO devices (device_id, name, gender, birth_date, timezone, city_name, city_country_code, interests)
    VALUES (?, 'Baur', ?, '1990-02-05', 'Asia/Almaty', 'Astana', 'KZ', ?)
  `).run(id, fields.gender === undefined ? 'male' : fields.gender, fields.interests ? JSON.stringify(fields.interests) : null);
  return db.prepare('SELECT * FROM devices WHERE device_id = ?').get(id);
}

function addBank(rows, date) {
  const insert = db.prepare('INSERT INTO daily_content_bank (bank_date, category, content_text, tags, subject) VALUES (?, ?, ?, ?, ?)');
  for (const [category, text, tags, subject] of rows) insert.run(date, category, text, JSON.stringify(tags || []), subject === undefined ? null : subject);
}

// A bank where every fact has its own subject; `extra` rows are added on top.
function seedBank(date, { extra = [], skip = [] } = {}) {
  const rows = [['holiday', `Holiday of ${date}.`, ['KZ'], `holiday ${date}`]];
  const per = { on_this_day: 2, born_today: 2, good_news: 2, science: 3, animals: 4, space: 3, nature: 3, tech: 3, unusual: 3, money: 2, brain: 2, word_origin: 2, tradition: 3, how_it_works: 3, quote: 2 };
  for (const [category, n] of Object.entries(per)) {
    if (skip.includes(category)) continue;
    for (let i = 1; i <= n; i += 1) rows.push([category, `${category} fact ${i} of ${date} with 5 numbers.`, [], `${category}-subject-${i}`]);
  }
  rows.push(['country_fact', 'KZ country fact 7.', ['KZ'], 'kz-country'], ['city_fact', 'Astana city fact 3.', ['KZ', 'city:astana'], 'astana-city']);
  rows.push(['watch_read', 'KZ film one.', ['KZ'], 'kz-film']);
  for (const key of rotation.INTEREST_KEYS) rows.push([`interest_${key}`, `Interest ${key} fact of 42 things.`, [], `interest-${key}`]);
  addBank(rows.concat(extra), date);
}

async function generate(device, date, bankOverride) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await dayPlan.generateDay({
      device: db.prepare('SELECT * FROM devices WHERE device_id = ?').get(device.device_id),
      languageCode: 'ru', dateContext: { date }, weather: null, countryCode: 'KZ', phoneYesterday: null,
      bank: bankOverride || bank.selectBankRowsForDay(date),
    });
  } finally {
    Object.assign(console, original);
  }
}

const ids = (day) => day.phrases.map((p) => p.slot_id);
const slotOf = (call, id) => call.payload.slots.find((s) => s.slot_id === id);

async function main() {
  // ================= 1. one fact, one phrase =================
  seedBank('2026-10-14'); // Wednesday
  installModel();
  {
    const device = addDevice('q-once2');
    const day = await generate(device, '2026-10-14');
    const slots = modelCalls[0].payload.slots;
    const items = slots.filter((s) => s.bank_item);
    // every fact of the day is in exactly one slot, except that a quiz question and its answer share theirs
    const byId = new Map();
    for (const slot of items) byId.set(slot.bank_item.id, (byId.get(slot.bank_item.id) || []).concat(slot.slot_id));
    for (const [id, users] of byId) {
      const quiz = users.every((u) => ['d4', 'd5', 'e9', 'e10', 'n4', 'n5'].includes(u));
      assert(users.length === 1 || (quiz && users.length === 2), `${id} used by ${users.join(',')}`);
    }
    assert.deepStrictEqual(byId.get(slotOf(modelCalls[0], 'd4').bank_item.id), ['d4', 'd5'], 'the answer shares its question\'s fact');
    // the quizzes are not built on any fact that another phrase of the day uses
    const quizIds = new Set(['d4', 'e9', 'n4'].map((id) => slotOf(modelCalls[0], id).bank_item.id));
    for (const slot of items) if (!['d4', 'd5', 'e9', 'e10', 'n4', 'n5'].includes(slot.slot_id)) assert(!quizIds.has(slot.bank_item.id), `${slot.slot_id} reuses a quiz fact`);
    // the recorded fact of a phrase is the server's, not whatever id the model wrote
    const shown = db.prepare('SELECT COUNT(*) FROM device_shown_facts WHERE device_id = ?').pluck().get('q-once2');
    assert(shown >= 20, `used facts are recorded (${shown})`);
    assert(day.phrases.every((p) => p.text.length <= 70));

    // two facts about one subject never go into one day
    seedBank('2026-10-15', { extra: [['animals', 'Octopus-like second fact about frogs.', [], 'animals-subject-1'], ['nature', 'Another nature fact about frogs again.', [], 'animals-subject-1']] });
    await generate(addDevice('q-subject'), '2026-10-15');
    const subjects = slotsWithItems(modelCalls[modelCalls.length - 1]).map((s) => String(s.bank_item.subject).toLowerCase());
    const quizShared = new Set(['d5', 'e10', 'n5']);
    const counted = slotsWithItems(modelCalls[modelCalls.length - 1]).filter((s) => !quizShared.has(s.slot_id)).map((s) => s.bank_item.subject).filter(Boolean);
    assert.strictEqual(new Set(counted).size, counted.length, `no subject twice in a day: ${subjects.join(',')}`);
  }
  function slotsWithItems(call) { return call.payload.slots.filter((s) => s.bank_item); }

  // ================= 2. strictly its own category =================
  {
    const slots = (call) => call.payload.slots;
    const call = modelCalls[0];
    const catOf = (id) => slotOf(call, id).bank_item.category;
    assert.strictEqual(catOf('e1'), 'good_news', 'the good news is a good_news fact');
    assert.strictEqual(catOf('d2'), 'science');
    assert.strictEqual(catOf('d8'), 'animals');
    assert.strictEqual(catOf('n2'), 'interest_technology', 'the interest slot takes its interest');
    // the number of the day and the quizzes never take interest_* facts, whatever has a digit
    for (const s of slots(call)) {
      if (s.slot_id !== 'n2' && s.bank_item) assert(!s.bank_item.category.startsWith('interest_'), `${s.slot_id} took ${s.bank_item.category}`);
    }
    assert(/\d/.test(slotOf(call, 'd6').bank_item.text), 'the number of the day has a number in it');
    assert.strictEqual(slotOf(call, 'd6').type, 'number_of_day');

    // no good_news rows: the slot goes (the poster / interest rows never stand in for it)
    seedBank('2026-10-16', { skip: ['good_news'] });
    addBank([['afisha', 'Hamlet at the Opera, 2026-10-17.', ['KZ', 'city:astana', 'date:2026-10-17'], 'hamlet']], '2026-10-16');
    const noNews = await generate(addDevice('q-nonews'), '2026-10-16');
    assert(!ids(noNews).includes('e1'), 'no good_news fact: no good news phrase');
    assert(!JSON.stringify(modelCalls[modelCalls.length - 1].payload.slots).includes('Hamlet'), 'the poster is not offered on a weekday');
    // the number of the day with only interest facts holding digits: no phrase
    db.prepare('DELETE FROM daily_content_bank WHERE bank_date = ?').run('2026-10-16');
    addBank([['holiday', 'A day.', ['global'], 'day'], ['science', 'A science fact without digits.', [], 's1'], ['interest_food', 'Interest food fact with 12 cooks.', [], 'f1']], '2026-10-16');
    const noNumber = await generate(addDevice('q-nonumber'), '2026-10-16');
    assert(!ids(noNumber).includes('d6'), 'an interest fact is never the number of the day');
    // the poster takes afisha rows only, on a weekend
    seedBank('2026-10-17');
    addBank([['afisha', 'Hamlet at the Opera, 2026-10-17.', ['KZ', 'city:astana', 'date:2026-10-17'], 'hamlet'], ['afisha', 'Stand-up at Arena, 2026-10-17.', ['KZ', 'city:astana', 'date:2026-10-17'], 'standup']], '2026-10-16');
    await generate(addDevice('q-poster'), '2026-10-17');
    const poster = modelCalls[modelCalls.length - 1];
    assert.strictEqual(slotOf(poster, 'd3').type, 'afisha');
    assert.strictEqual(slotOf(poster, 'd3').bank_item.category, 'afisha');
    assert.strictEqual(slotOf(poster, 'd12').bank_item.category, 'afisha');
    assert.notStrictEqual(slotOf(poster, 'd3').bank_item.id, slotOf(poster, 'd12').bank_item.id, 'two different events');
    assert.notStrictEqual(slotOf(poster, 'e1').bank_item.category, 'afisha', 'an event is never the good news');
  }

  // ================= 3. strictly its own date =================
  {
    // Friday's bank only: on Saturday there is no holiday, no "on this day", no "born today"
    db.prepare('DELETE FROM daily_content_bank').run();
    seedBank('2026-10-23'); // Friday
    const rows = bank.selectBankRowsForDay('2026-10-24').rows; // Saturday: nothing of that date was built
    for (const category of ['holiday', 'on_this_day', 'born_today']) assert(!rows.some((r) => r.category === category), `${category} of another date is not served`);
    assert(rows.some((r) => r.category === 'science'), 'the facts of the nearest bank are still served');
    const sat = await generate(addDevice('q-date'), '2026-10-24');
    const call = modelCalls[modelCalls.length - 1];
    assert.strictEqual(slotOf(call, 'm4').type, 'unusual_fact', 'no holiday of the day: an interesting fact stands in');
    assert(!ids(sat).includes('m5') && !ids(sat).includes('e6'), 'no "on this day" and no "born today" without a bank of that date');
    assert(!JSON.stringify(call.payload).includes('Holiday of 2026-10-23'), 'Friday\'s holiday never reaches Saturday');
    // with a bank of its own date they are there
    seedBank('2026-10-24');
    const sat2 = await generate(addDevice('q-date2'), '2026-10-24');
    const call2 = modelCalls[modelCalls.length - 1];
    assert.strictEqual(slotOf(call2, 'm4').type, 'holiday');
    assert(slotOf(call2, 'm4').bank_item.text.includes('2026-10-24'));
    assert(ids(sat2).includes('m5') && ids(sat2).includes('e6'));
    assert(slotOf(call2, 'm5').bank_item.text.includes('2026-10-24') && slotOf(call2, 'e6').bank_item.text.includes('2026-10-24'));
    // rows of another bank date passed in by a caller are dropped inside the generator as well
    const mixed = bank.selectBankRowsForDay('2026-10-24');
    mixed.rows = mixed.rows.concat([{ id: 777777, bank_date: '2026-10-23', category: 'holiday', content_text: 'Yesterday\'s holiday.', tags: '["global"]', subject: null }]);
    await generate(addDevice('q-date3'), '2026-10-24', mixed);
    assert(!JSON.stringify(modelCalls[modelCalls.length - 1].payload).includes('Yesterday'), 'a holiday row of another date is dropped');
  }

  // ================= 4. the foreign word: useful, intermediate, any language =================
  {
    seedBank('2026-10-27');
    const learningFor = (code) => db.prepare('UPDATE devices SET learning_language = ? WHERE device_id = ?').run(code, 'q-foreign');
    addDevice('q-foreign');
    // a beginner word is rejected, repaired, and when the repair is no better the whole trio goes
    for (const [lang, basic] of [['en', 'hello'], ['es', 'Hola'], ['fr', 'bonjour'], ['de', 'danke'], ['ja', 'こんにちは'], ['zh', '你好'], ['it', 'ciao'], ['ko', '안녕하세요'], ['pt', 'obrigado']]) {
      learningFor(lang);
      installModel({ foreignWord: basic, repairForeignWord: basic });
      db.prepare('DELETE FROM device_foreign_words').run();
      const day = await generate({ device_id: 'q-foreign' }, '2026-10-27');
      assert(!ids(day).includes('m10') && !ids(day).includes('e2') && !ids(day).includes('e3'), `${lang}: "${basic}" is a beginner word, nothing is taught`);
      assert.strictEqual(modelCalls.filter((c) => c.isRepair).length, 1, `${lang}: one repair call`);
      db.prepare('DELETE FROM sent_phrases').run();
      db.prepare('DELETE FROM device_shown_facts').run();
    }
    // a repair that finds a real word saves the trio
    learningFor('en');
    installModel({ foreignWord: 'cat', repairForeignWord: 'reluctant' });
    const fixed = await generate({ device_id: 'q-foreign' }, '2026-10-27');
    assert(ids(fixed).includes('m10') && ids(fixed).includes('e2') && ids(fixed).includes('e3'));
    assert.strictEqual(fixed.foreign_word, 'reluctant');
    // a good word is taught at once
    db.prepare('DELETE FROM sent_phrases').run();
    db.prepare('DELETE FROM device_foreign_words').run();
    installModel({ foreignWord: 'reluctant' });
    assert.strictEqual((await generate({ device_id: 'q-foreign' }, '2026-10-27')).foreign_word, 'reluctant');
    assert.strictEqual(modelCalls.filter((c) => c.isRepair).length, 0);
    const system = modelCalls[0].params.messages[0].content;
    assert(/intermediate \(B1-B2\) word of it, for an adult/.test(system) && /never a beginner word such as hello, thanks, cat, water/.test(system));
    assert(/B1-B2/.test(slotOf(modelCalls[0], 'm10').topic) && /never a beginner word/.test(slotOf(modelCalls[0], 'm10').topic));
    assert(dayPlan.BASIC_FOREIGN_WORDS.has('привет') && dayPlan.BASIC_FOREIGN_WORDS.has('hola'));
  }

  // ================= 5. the word of the day is modern =================
  {
    const system = modelCalls[0].params.messages[0].content;
    assert(/modern, useful word of the user's language that widens an adult's vocabulary/.test(system));
    assert(/never archaic, obsolete, dialect or slang/.test(system));
    const topic = slotOf(modelCalls[0], 'm7').topic;
    assert(/modern, useful word/.test(topic) && /not archaic, obsolete, dialect or slang/.test(topic));
  }

  // ================= 6. the tip for men or women =================
  {
    const tip = dayPlan.slotDefinitions().find((d) => d.slot_id === 'e4');
    assert.strictEqual(tip.type, 'gender_tip');
    assert.strictEqual(tip.ref, 'm11', 'compared with the morning lifehack');
    assert(/really about being a man \(profile gender male\) or a woman \(female\)/.test(tip.topic));
    assert(/Not a general lifehack, not a repeat of the morning lifehack/.test(tip.topic));
    assert.strictEqual(dayPlan.slotDefinitions().find((d) => d.slot_id === 'm11').type, 'lifehack');
    const withGender = (gender) => dayPlan.buildDaySlots({ holiday: null, hasWeather: true, hasPhone: true, gender }).some((s) => s.slot_id === 'e4');
    assert(withGender('male') && withGender('female'));
    assert(!withGender('non_binary') && !withGender(''), 'no man/woman to write for: no tip');
    assert(dayPlan.buildDaySlots({ holiday: null, hasWeather: true, hasPhone: true }).some((s) => s.slot_id === 'e4'), 'unknown to the caller: kept');
    seedBank('2026-10-28');
    const woman = await generate(addDevice('q-woman', { gender: 'female' }), '2026-10-28');
    assert(ids(woman).includes('e4'));
    const nb = await generate(addDevice('q-nb', { gender: 'non_binary' }), '2026-10-28');
    assert(!ids(nb).includes('e4'));
    assert(/never a general lifehack and never a repeat of the morning lifehack/.test(modelCalls[0].params.messages[0].content));
  }

  // ================= 7. themes, not texts: subjects and the stop list =================
  {
    const { rows } = bank._test.parseBankItems(JSON.stringify([
      { category: 'animals', country: '', subject: 'Tree frog', text: 'Tree frogs survive winter frozen solid.' },
      { category: 'animals', subject: 'octopus', text: 'Octopuses have three hearts.' },
      { category: 'science', subject: 'Gallium', text: 'A metal that melts in the hand.' },
      { category: 'science', subject: 'honey', text: 'Honey found in tombs was still edible and never spoils.' },
      { category: 'space', subject: 'Venus', text: 'A day on Venus is longer than its year.' },
      { category: 'animals', subject: 'wombat', text: 'Wombats produce cube-shaped droppings.' },
      { category: 'animals', subject: 'butterfly', text: 'Butterflies taste with their feet.' },
      { category: 'animals', subject: 'Axolotl', text: 'An axolotl regrows whole limbs.' },
      { category: 'science', subject: 'Recent thing', text: 'Something about a recent thing.' },
      { category: 'good_news', subject: 'reef', text: 'A reef was restored.' },
    ]), '2026-10-29', ['recent thing']);
    assert.deepStrictEqual(rows.map((r) => r.subject), ['Tree frog', 'Axolotl', 'reef'], 'worn-out topics and recent subjects are dropped, the subject is kept');
    assert.strictEqual(bank.STOPLIST_TOPICS.length >= 15, true);
    for (const needle of ['octopus', 'gallium', 'honey that never spoils', 'Venus', 'wombat', 'butterflies tasting']) {
      assert(bank.STOPLIST_TOPICS.some((t) => t.name.includes(needle)), `stop list has ${needle}`);
    }
    // saved with the subject, and read back as the subjects of the last 60 days
    addBank([['science', 'Recent text one.', [], 'Tardis'], ['science', 'Recent text two.', [], 'tardis'], ['animals', 'Old text.', [], 'Dodo']], '2026-09-20');
    addBank([['animals', 'Ancient text.', [], 'Ancientbird']], '2026-07-01');
    const subjects = bank.loadRecentSubjects('2026-10-29');
    assert(subjects.map((s) => s.toLowerCase()).includes('tardis') && subjects.includes('Dodo'));
    assert.strictEqual(subjects.filter((s) => s.toLowerCase() === 'tardis').length, 1, 'each subject once');
    assert(!subjects.includes('Ancientbird'), 'older than 60 days is not asked for');
    const prompt = bank.buildBankPrompt('2026-10-29', ['KZ'], [], { countries: ['KZ'], cities: [] }, ['Tardis', 'Dodo']);
    assert(prompt.includes('"subject"') && prompt.includes('["Tardis","Dodo"]'), 'the subjects of the last 60 days go into the prompt');
    assert(/Do NOT take any of these objects as the subject of an item/.test(prompt));
    assert(/at least 12 of the science, animals, space, nature, tech, unusual, money and how_it_works facts carry one verified, striking number/.test(prompt), 'the bank asks for numbers (the number of the day needs them)');
    assert(/gallium melting in a hand/.test(prompt) && /honey that never spoils/.test(prompt) && /day on Venus longer than its year/.test(prompt));
    assert(/wombats/.test(prompt) && /butterflies tasting with their feet/.test(prompt) && /octopus/.test(prompt));

    // the whole run: the prompt carries the saved subjects, the new rows are saved with theirs
    const prompts = [];
    process.env.OPENAI_API_KEY = 'test-key';
    bank._test.setBankClientFactory(() => ({
      responses: {
        create: async (params) => {
          prompts.push(params.input);
          return { output_text: JSON.stringify([{ category: 'holiday', country: 'KZ', subject: 'a day', text: 'A day.' }, { category: 'animals', subject: 'Okapi', text: 'Okapi tongues reach their own ears.' }, { category: 'animals', subject: 'Tardis', text: 'A repeat of an old subject.' }]), output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        },
      },
    }));
    const lines = console.log; console.log = () => {};
    const outcome = await bank.generateDailyBank({ bankDate: '2026-10-30' });
    console.log = lines;
    bank._test.setBankClientFactory(null);
    delete process.env.OPENAI_API_KEY;
    assert.strictEqual(outcome.savedCount, 2, 'the repeated subject was not saved');
    assert(prompts[0].includes('"Tardis"') && prompts[0].includes('"Dodo"'));
    assert.deepStrictEqual(db.prepare('SELECT subject FROM daily_content_bank WHERE bank_date = ? ORDER BY id').pluck().all('2026-10-30'), ['a day', 'Okapi']);
  }

  // ================= 8. the new quiz =================
  {
    const defs = dayPlan.slotDefinitions();
    const at = (id) => defs.find((d) => d.slot_id === id);
    for (const [q, a, next] of [['d4', 'd5', 'd6'], ['e9', 'e10', 'e11'], ['n4', 'n5', 'n6']]) {
      assert.strictEqual(at(q).type, 'quiz_question');
      assert.strictEqual(at(a).type, 'quiz_answer', `${a} answers ${q} at once`);
      assert.strictEqual(at(a).ref, q);
      assert.strictEqual(at(q).max_chars, 66);
      assert.strictEqual(at(a).max_chars, 66);
      assert(/2-3 answer options inside the phrase, at most 66 characters/.test(at(q).topic));
      assert(/full phrase with a short explanation, at most 66 characters/.test(at(a).topic));
      assert(!/quiz/.test(at(next).type), 'the slot after the pair is a normal topic');
    }
    assert.deepStrictEqual(['d6', 'e11', 'n6'].map((id) => at(id).type), ['number_of_day', 'how_it_works', 'tradition']);
    assert.deepStrictEqual(dayPlan.QUIZ_PAIRS, [['d4', 'd5'], ['e9', 'e10'], ['n4', 'n5']]);
    seedBank('2026-11-03');
    installModel();
    await generate(addDevice('q-quiz'), '2026-11-03');
    const system = modelCalls[0].params.messages[0].content;
    assert(/2-3 answer options inside the phrase \(up to 66 characters\)/.test(system));
    assert(system.includes('Which frog survives winter frozen: tree frog, pond frog or toad?'));
    assert(system.includes('Answer: tree frog - in spring it thaws and hops on'));
    assert(/very next slot answers with a full phrase and a short explanation/.test(system));
    assert(/different topics and different answers/.test(system));
    // the categories of the three quizzes
    assert(['animals', 'nature'].includes(slotOf(modelCalls[0], 'd4').bank_item.category));
    assert(['tech', 'space', 'how_it_works'].includes(slotOf(modelCalls[0], 'e9').bank_item.category));
    assert(['unusual', 'tradition', 'word_origin'].includes(slotOf(modelCalls[0], 'n4').bank_item.category));
    // a quiz that finds no fact of its categories goes with its answer (and takes nothing from the interests)
    db.prepare('DELETE FROM daily_content_bank WHERE bank_date = ? AND category IN (\'animals\', \'nature\')').run('2026-11-03');
    const noQuiz = await generate(addDevice('q-noquiz'), '2026-11-03');
    assert(!ids(noQuiz).includes('d4') && !ids(noQuiz).includes('d5'), 'a pair without a fact is dropped whole');
    assert(ids(noQuiz).includes('e9') && ids(noQuiz).includes('e10'));
    // a rejected question is rewritten with its answer (and the other way round), and a pair that stays bad is dropped
    seedBank('2026-11-04');
    dayPlan._test.setClientFactory(() => ({
      chat: { completions: { create: async (params) => {
        const payload = JSON.parse(params.messages[1].content);
        const isRepair = params.response_format.json_schema.name === 'lock_screen_day_repair';
        modelCalls.push({ params, payload, isRepair });
        return { choices: [{ message: { content: JSON.stringify({
          phrases: payload.slots.map((slot) => ({ slot_id: slot.slot_id, text: slot.slot_id === 'e10' ? 'я'.repeat(80) : `Строка ${slot.slot_id}`, bank_id: '', echoes: '' })),
          word_of_day: 'Зыбкий', foreign_word: 'reluctant' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      } } },
    }));
    modelCalls = [];
    const bad = await generate(addDevice('q-badpair'), '2026-11-04');
    const repair = modelCalls.find((c) => c.isRepair);
    assert.deepStrictEqual(repair.payload.slots.map((s) => s.slot_id).sort(), ['e10', 'e9'], 'a bad answer is rewritten together with its question');
    assert(!ids(bad).includes('e9') && !ids(bad).includes('e10'), 'a pair that stays bad is dropped together');
    assert(ids(bad).includes('d4') && ids(bad).includes('d5') && ids(bad).includes('n4') && ids(bad).includes('n5'), 'the other pairs stay');
  }

  console.log('day-quality tests passed');
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
