// The weekend events poster (task 31): its own search on Fridays (one web-search call per city, local listing
// sites, the events of Saturday and Sunday with kind / venue / time / audience), its storage, its log, and the
// choice of the day: the slots day 3 and day 12 get the events of the day in the user's city, filtered and ordered
// by age and interests, two slots never share an event. The model and the weather are mocked: no real calls.
const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-afisha-test-'));
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

const bank = require('../src/dailyContentBank');
const afisha = require('../src/afishaSearch');
const dayPlan = require('../src/dayPlan');

const SAT = '2026-10-17';
const SUN = '2026-10-18';
const FRI = '2026-10-16';

function quiet(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  console.log = console.warn = console.error = (...a) => lines.push(a.join(' '));
  return Promise.resolve().then(fn).then((value) => { Object.assign(console, original); return { value, lines }; },
    (err) => { Object.assign(console, original); throw err; });
}

function bankClient(answers, seen = []) {
  bank._test.setBankClientFactory(() => ({
    responses: {
      create: async (params) => {
        seen.push(params);
        const city = (params.input.match(/events in (\S+) \(country/) || [])[1];
        const answer = answers[city];
        if (answer instanceof Error) throw answer;
        return {
          output_text: typeof answer === 'string' ? answer : JSON.stringify(answer),
          output: [{ type: 'web_search_call' }, { type: 'web_search_call' }, { type: 'web_search_call' }],
          usage: { input_tokens: 60000, output_tokens: 1500, total_tokens: 61500, output_tokens_details: { reasoning_tokens: 700 } },
        };
      },
    },
  }));
  return seen;
}

const ev = (title, kind, venue, date, time, audience) => ({ title, kind, venue, date, time, audience, source: 'ticketon.kz' });

async function main() {
  const rowsOf = (date = FRI) => db.prepare("SELECT category, content_text, tags, subject FROM daily_content_bank WHERE bank_date = ? AND category = 'afisha' ORDER BY id").all(date)
    .map((r) => ({ ...r, tags: JSON.parse(r.tags) }));

  // ================= 1. what the search asks for =================
  {
    const kz = afisha.buildAfishaPrompt({ name: 'Astana', country: 'KZ' }, [SAT, SUN], FRI);
    for (const needle of ['Ticketon', 'ticketon.kz', 'Kino.kz', 'kino.kz', 'Sxodim', 'sxodim.com', 'theatres', 'stadiums', 'museums']) {
      assert(kz.includes(needle), `Kazakhstan sources: ${needle}`);
    }
    for (const kind of ['theatre', 'cinema', 'concert', 'sport', 'standup', 'exhibition', 'family']) assert(kz.includes(`"${kind}"`), `kind ${kind}`);
    assert(/premieres/.test(kz) && /stand-up and comedy/.test(kz) && /children's events/.test(kz));
    assert(kz.includes(SAT) && kz.includes(SUN) && /Saturday/.test(kz) && /Sunday/.test(kz), 'the two days');
    assert(/10 to 20 events/.test(kz), 'the goal: 10-20 events per city');
    assert(/fixtures and ticket pages of the city's football, hockey, basketball, volleyball and martial-arts clubs/.test(kz) && /comedy clubs/.test(kz), 'sport and stand-up are searched on purpose');
    assert(/never invent a title, a venue, a date or a time/i.test(kz) && /Fewer real events beat invented ones/.test(kz));
    for (const field of ['"title"', '"kind"', '"venue"', '"date"', '"time"', '"audience"']) assert(kz.includes(field), `field ${field}`);
    assert(/kids\|family\|18\+\|all/.test(kz));
    const de = afisha.buildAfishaPrompt({ name: 'Berlin', country: 'DE' }, [SAT, SUN], FRI);
    assert(!/Ticketon \(ticketon\.kz\)/.test(de) && /Find the main local event-listing and ticket sites of DE and of Berlin yourself/.test(de), 'other countries: the model finds the local sites');
    assert.deepStrictEqual(afisha.weekendDatesFor(FRI), [SAT, SUN]);
  }

  // ================= 2. parsing and checking the events =================
  {
    const city = { name: 'Astana', country: 'KZ' };
    const { rows, rejected } = afisha.parseAfishaEvents(JSON.stringify([
      ev('Hamlet', 'theatre', 'Opera House', SAT, '19:00', '18+'),
      ev('Hamlet', 'theatre', 'Opera House', SAT, '19:00', '18+'), // the same event twice
      ev('Frozen show', 'kids', 'Youth Theatre', SUN, '11:00', 'children'), // "kids" = family kind, "children" = kids audience
      ev('Derby', 'match', 'Central Stadium', SUN, 'evening', 'everyone'), // synonyms; a time that is no time
      ev('Past gig', 'concert', 'Club', '2026-10-10', '20:00', 'all'), // not these days
      ev('Mystery', 'ritual', 'Somewhere', SAT, '20:00', 'all'), // unknown kind
      ev('X', 'concert', 'Club', SAT, '20:00', 'all'), // no usable title
      { title: 'No venue', kind: 'concert', date: SAT },
      ev('Late show', 'standup', 'Dostyk Hall', SAT, '25:99', '21+'),
    ]), { city, dates: [SAT, SUN], bankDate: FRI });
    assert.deepStrictEqual(rows.map((r) => r.event.title), ['Hamlet', 'Frozen show', 'Derby', 'Late show']);
    assert.deepStrictEqual(rejected.map((r) => r.reason).sort(), ['date', 'fields', 'fields', 'kind']);
    assert.deepStrictEqual(rows[0].tags, ['KZ', 'city:astana', `date:${SAT}`, 'kind:theatre', 'age:18+', 'time:19:00']);
    assert.strictEqual(rows[0].content_text, `Hamlet — theatre, Opera House, ${SAT} 19:00, 18+`);
    assert.strictEqual(rows[0].subject, 'Hamlet');
    assert.deepStrictEqual(rows[1].tags.slice(3), ['kind:family', 'age:kids', 'time:11:00']);
    assert(rows[1].content_text.endsWith('for children'));
    assert.deepStrictEqual(rows[2].tags.slice(3), ['kind:sport', 'age:all'], 'a time that is no time is left out');
    assert.deepStrictEqual(rows[3].tags.slice(3), ['kind:standup', 'age:18+'], '21+ is an adult event');
    assert.throws(() => afisha.parseAfishaEvents('not json', { city, dates: [SAT], bankDate: FRI }));
    assert.strictEqual(afisha.parseAfishaEvents(JSON.stringify({ events: [ev('A show', 'theatre', 'Hall', SAT, '', 'all')] }), { city, dates: [SAT], bankDate: FRI }).rows.length, 1);
  }

  // ================= 3. the search call: one per city, stored, logged =================
  {
    const astana = { name: 'Astana', country: 'KZ' };
    const almaty = { name: 'Almaty', country: 'KZ' };
    db.prepare("INSERT INTO daily_content_bank (bank_date, category, content_text, tags, subject) VALUES (?, 'science', 'A science fact.', '[]', 'x')").run(FRI);
    process.env.OPENAI_API_KEY = 'test-key';
    const seen = bankClient({
      Astana: [ev('Hamlet', 'theatre', 'Opera House', SAT, '19:00', 'all'), ev('Frozen show', 'family', 'Youth Theatre', SUN, '11:00', 'kids'), ev('Derby', 'sport', 'Central Stadium', SUN, '16:00', 'all')],
      Almaty: [ev('Opera night', 'theatre', 'Abai Theatre', SAT, '18:00', 'all'), ev('Stand-up', 'standup', 'Dostyk Hall', SUN, '18:00', 'all')],
    });
    const { value: outcome, lines } = await quiet(() => afisha.generateAfisha({ bankDate: FRI, cities: [astana, almaty] }));
    assert.strictEqual(seen.length, 2, 'one call per city');
    for (const params of seen) {
      assert.strictEqual(params.model, 'gpt-6.1-sol', 'the model of the bank');
      assert.deepStrictEqual(params.tools, [{ type: 'web_search' }], 'with web search');
      assert.deepStrictEqual(params.reasoning, { effort: 'low' });
    }
    assert(seen[0].input.includes('Astana') && !seen[0].input.includes('Almaty'));
    assert.strictEqual(outcome.savedCount, 5);
    assert(lines.some((l) => l.startsWith('OPENAI_USAGE scope=afisha city=Astana ') && /prompt_tokens=60000/.test(l) && /searches=3/.test(l)), 'the price line per city');
    assert(lines.some((l) => l.startsWith('OPENAI_USAGE scope=afisha city=Almaty ')));
    assert(lines.some((l) => /^AFISHA_COUNTS city=Astana total=3 .*theatre=1 cinema=0 concert=0 sport=1 standup=0 exhibition=0 family=1/.test(l)), 'the number of events per kind');
    assert(lines.some((l) => /^AFISHA_COUNTS city=Almaty total=2 .*theatre=1 .*standup=1/.test(l)));
    assert.strictEqual(rowsOf().length, 5);
    assert.strictEqual(db.prepare("SELECT COUNT(*) FROM daily_content_bank WHERE bank_date = ? AND category = 'science'").pluck().get(FRI), 1, 'the other bank rows are untouched');

    // a second run replaces that city's events only; a failed city keeps what it had
    bankClient({ Astana: [ev('New play', 'theatre', 'Opera House', SAT, '19:00', 'all')], Almaty: new Error('boom') });
    const second = (await quiet(() => afisha.generateAfisha({ bankDate: FRI, cities: [astana, almaty] }))).value;
    assert.strictEqual(second.results[1].error, 'boom');
    assert.deepStrictEqual(rowsOf().filter((r) => r.tags.includes('city:astana')).map((r) => r.subject), ['New play']);
    assert.strictEqual(rowsOf().filter((r) => r.tags.includes('city:almaty')).length, 2, 'Almaty keeps its events');
    // an answer with nothing usable keeps the stored events too
    bankClient({ Astana: [ev('Gone', 'theatre', 'Hall', '2026-01-01', '', 'all')], Almaty: [] });
    await quiet(() => afisha.generateAfisha({ bankDate: FRI, cities: [astana, almaty] }));
    assert.strictEqual(rowsOf().length, 3);
    // no key: nothing runs
    delete process.env.OPENAI_API_KEY;
    assert.strictEqual((await afisha.generateAfisha({ bankDate: FRI, cities: [astana] })).error, 'OPENAI_API_KEY is not configured');
    process.env.OPENAI_API_KEY = 'test-key';
  }

  // ================= 4. Fridays only =================
  {
    const seen = bankClient({ Astana: [ev('Hamlet', 'theatre', 'Opera House', '2026-10-10', '19:00', 'all')] });
    const run = async (iso) => (await quiet(() => afisha.generateAfishaIfFriday(new Date(iso)))).value;
    for (const iso of ['2026-10-12T06:00:00Z', '2026-10-13T06:00:00Z', '2026-10-14T06:00:00Z', '2026-10-15T06:00:00Z', '2026-10-17T06:00:00Z', '2026-10-18T06:00:00Z']) {
      assert.strictEqual((await run(iso)).ran, false, `${iso} is not a Friday`);
    }
    assert.strictEqual(seen.length, 0, 'no call on any other day');
    // the cron runs shortly after midnight Almaty: still Thursday evening in UTC
    const friday = await run('2026-10-15T19:45:00Z'); // 00:45 on Friday 16.10 in Asia/Almaty
    assert.strictEqual(friday.ran, true);
    assert(seen.length >= 1, 'a call on Friday');
    // the cron files call it
    const cronSource = fs.readFileSync(path.join(__dirname, '../src/cron.js'), 'utf8');
    const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/internalGenerateBank.js'), 'utf8');
    assert(cronSource.includes('generateAfishaIfFriday') && routeSource.includes('generateAfishaIfFriday'));
    // and the common bank no longer asks for the poster, nor keeps poster rows it was given
    const prompt = bank.buildBankPrompt(FRI, ['KZ'], [], { countries: ['KZ'], cities: [{ name: 'Astana', country: 'KZ' }] }, []);
    assert(!/afisha/i.test(prompt), 'the bank prompt has no poster any more');
    assert.strictEqual(bank._test.parseBankItems(JSON.stringify([{ category: 'afisha', country: 'KZ', city: 'Astana', date: SAT, text: 'An event.' }]), FRI).rows.length, 0);
  }

  // ================= 5. the choice of the day =================
  {
    db.prepare('DELETE FROM daily_content_bank').run();
    const seed = [
      // [title, kind, time, audience]
      ['Morning puppet show', 'family', '11:00', 'kids'],
      ['Chagall exhibition', 'exhibition', '', 'all'],
      ['Derby match', 'sport', '15:00', 'all'],
      ['Night club gig', 'concert', '22:00', '18+'],
      ['Hamlet', 'theatre', '19:00', 'all'],
      ['Premiere film', 'cinema', '20:00', 'family'],
    ];
    const insert = db.prepare("INSERT INTO daily_content_bank (bank_date, category, content_text, tags, subject) VALUES (?, 'afisha', ?, ?, ?)");
    const idsByTitle = {};
    for (const [title, kind, time, audience] of seed) {
      const tags = ['KZ', 'city:astana', `date:${SAT}`, `kind:${kind}`, `age:${audience}`].concat(time ? [`time:${time}`] : []);
      const info = insert.run(FRI, `${title} — ${kind}, Venue, ${SAT} ${time}, ${audience}`, JSON.stringify(tags), title);
      idsByTitle[title] = `b${info.lastInsertRowid}`;
    }
    db.prepare("INSERT INTO daily_content_bank (bank_date, category, content_text, tags, subject) VALUES (?, 'country_fact', 'A fact about Kazakhstan.', '[\"KZ\"]', 'kz')").run(SAT);
    insert.run(FRI, 'Berlin show', JSON.stringify(['DE', 'city:berlin', `date:${SAT}`, 'kind:theatre', 'age:all']), 'Berlin show');
    insert.run(FRI, 'Sunday only', JSON.stringify(['KZ', 'city:astana', `date:${SUN}`, 'kind:theatre', 'age:all']), 'Sunday only');
    insert.run(FRI, 'Almaty show', JSON.stringify(['KZ', 'city:almaty', `date:${SAT}`, 'kind:theatre', 'age:all']), 'Almaty show');

    let model;
    const calls = [];
    dayPlan._test.setClientFactory(() => ({
      chat: { completions: { create: async (params) => {
        const payload = JSON.parse(params.messages[1].content);
        calls.push({ params, payload });
        return { choices: [{ message: { content: JSON.stringify({
          phrases: payload.slots.map((slot) => ({ slot_id: slot.slot_id, text: `Строка ${slot.slot_id}`, bank_id: model ? (model(slot) || '') : '', echoes: '' })),
          word_of_day: 'Зыбкий', foreign_word: 'reluctant' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      } } },
    }));
    const device = (id, birth, interests) => {
      db.prepare("INSERT OR REPLACE INTO devices (device_id, name, gender, birth_date, timezone, city_name, city_country_code, interests) VALUES (?, 'Baur', 'male', ?, 'Asia/Almaty', 'Astana', 'KZ', ?)")
        .run(id, birth, interests ? JSON.stringify(interests) : null);
      return db.prepare('SELECT * FROM devices WHERE device_id = ?').get(id);
    };
    let mainCall = 0; // the day call of the last generate (a repair call may follow it)
    const generate = async (dev) => {
      mainCall = calls.length;
      return (await quiet(() => dayPlan.generateDay({
        device: dev, languageCode: 'ru', dateContext: { date: SAT }, weather: null, countryCode: 'KZ', phoneYesterday: null,
        bank: bank.selectBankRowsForDay(SAT),
      }))).value;
    };
    const slot = (id) => calls[mainCall].payload.slots.find((s) => s.slot_id === id);
    const titles = (id) => slot(id).candidates.map((c) => c.text.split(' — ')[0]);

    // an adult without interests: no children's show, no 18+... (an adult may have 18+), only the events of this day and city
    let day = await generate(device('a-adult', '1990-02-05', null));
    assert.strictEqual(slot('d3').type, 'afisha');
    assert.strictEqual(slot('d12').type, 'afisha_evening');
    const early = titles('d3');
    const evening = titles('d12');
    assert.deepStrictEqual(early.slice().sort(), ['Chagall exhibition', 'Derby match'], 'daytime events for day 3 (no children\'s show for an adult)');
    assert.deepStrictEqual(evening.slice().sort(), ['Hamlet', 'Night club gig', 'Premiere film'], 'evening events for day 12');
    assert(!early.some((t) => evening.includes(t)), 'two slots never share an event');
    for (const t of early.concat(evening)) assert(!/Berlin|Sunday|Almaty/.test(t), 'only this day and this city');
    assert.deepStrictEqual(slot('d3').candidates[0], { id: idsByTitle['Chagall exhibition'], text: `Chagall exhibition — exhibition, Venue, ${SAT} , all`, kind: 'exhibition', audience: 'all' });
    assert.strictEqual(slot('d3').bank_item, undefined, 'the model chooses, not the server');
    assert.strictEqual(calls[mainCall].payload.profile.age >= 30, true);
    // the model's choice is the event of the phrase; the day remembers it as shown
    assert.strictEqual(day.phrases.find((p) => p.slot_id === 'd3').type, 'afisha');

    // a minor: nothing 18+
    await generate(device('a-teen', '2018-02-05', null));
    assert(![...titles('d3'), ...titles('d12')].includes('Night club gig'), 'nothing 18+ for a minor');
    assert(titles('d3').includes('Morning puppet show'), 'a child may have the children\'s show');
    // family_kids: the children's and family events come first
    await generate(device('a-family', '1985-02-05', ['family_kids']));
    assert.strictEqual(titles('d3')[0], 'Morning puppet show', 'family events first for family_kids');
    assert(titles('d3').includes('Morning puppet show'), 'a children\'s show for an adult who chose family_kids');
    assert(titles('d12').indexOf('Premiere film') >= 0);
    // sport_health: sport first; film_music: cinema first
    await generate(device('a-sport', '1985-02-05', ['sport_health']));
    assert.strictEqual(titles('d3')[0], 'Derby match');
    await generate(device('a-film', '1985-02-05', ['film_music']));
    assert.deepStrictEqual(titles('d12').slice(0, 2).sort(), ['Night club gig', 'Premiere film'], 'cinema and concerts first for film_music');
    assert.strictEqual(titles('d12')[2], 'Hamlet');
    assert.deepStrictEqual(calls[mainCall].payload.profile.interests, ['film_music'], 'the interests are in the profile');
    // the instruction tells the model how to choose
    const system = calls[mainCall].params.messages[0].content;
    assert(/"candidates", real events of today in the user's city/.test(system));
    assert(/fits the user's age \(profile age\) and interests/.test(system) && /family or children's events for family_kids, sport for sport_health/.test(system));
    assert(/first poster slot is about today and what is on during the day, the second one is something for this evening/.test(system));
    assert(/never invent an event or add details that are not in the candidate/.test(system));
    assert(/evening one, different from day slot 3/.test(slot('d12').topic) && /something on during the day/.test(slot('d3').topic));

    // the choice of the model counts when it is one of the candidates, else the first candidate
    model = (s) => (s.slot_id === 'd3' ? idsByTitle['Derby match'] : s.slot_id === 'd12' ? 'b999999' : '');
    const chosen = await generate(device('a-choice', '1990-02-05', null));
    const factIds = db.prepare('SELECT COUNT(*) FROM device_shown_facts WHERE device_id = ?').pluck().get('a-choice');
    assert(factIds >= 2, 'the chosen events are recorded as shown');
    const bankText = (id) => db.prepare('SELECT content_text FROM daily_content_bank WHERE id = ?').pluck().get(Number(id.slice(1)));
    const { factKey } = require('../src/sentPhrases')._test;
    const shownKeys = new Set(db.prepare('SELECT topic_key FROM device_shown_facts WHERE device_id = ?').pluck().all('a-choice'));
    assert(shownKeys.has(factKey(bankText(idsByTitle['Derby match']))), 'day 3: the event the model chose');
    assert(shownKeys.has(factKey(bankText(slot('d12').candidates[0].id))), 'day 12: not a candidate id, so the first candidate');
    assert(!shownKeys.has(factKey(bankText(idsByTitle['Chagall exhibition']))), 'an event nobody chose is not marked as shown');
    assert(chosen.phrases.find((p) => p.slot_id === 'd12'));
    // an event already shown to this device is not offered again
    await generate(db.prepare('SELECT * FROM devices WHERE device_id = ?').get('a-choice'));
    assert(!titles('d3').includes('Derby match'), 'a chosen event is not offered to the same device again');
    model = null;

    // one event: day 3 only (day 12 needs a second one); none: the weekday topics
    db.prepare("DELETE FROM daily_content_bank WHERE category = 'afisha' AND subject NOT IN ('Hamlet')").run();
    day = await generate(device('a-one', '1990-02-05', null));
    assert.strictEqual(slot('d3').type, 'afisha');
    assert.strictEqual(day.phrases.find((p) => p.slot_id === 'd12').type, 'thought');
    db.prepare("DELETE FROM daily_content_bank WHERE category = 'afisha'").run();
    day = await generate(device('a-none', '1990-02-05', null));
    assert.strictEqual(day.phrases.find((p) => p.slot_id === 'd3').type, 'country_fact');
    dayPlan._test.setClientFactory(null);
  }

  console.log('afisha tests passed');
}

main()
  .catch((err) => {
    Module._load = originalLoad;
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    bank._test.setBankClientFactory(null);
    delete process.env.OPENAI_API_KEY;
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
