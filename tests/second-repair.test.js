// Second repair (task 30): a phrase still longer than 70 characters after the first repair call gets ONE more
// call, only for the phrases that are still too long and their pair (quiz question + answer, word recall +
// answer). Only after the second call a phrase is dropped. Other rejections are not retried. The model is mocked.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-repair2-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const dayPlan = require('../src/dayPlan');
const bank = require('../src/dailyContentBank');

const DATE = '2026-11-10'; // Tuesday
const LONG = 'я'.repeat(80);

let calls;
// script(round, slot) -> text; round 0 = the day call, 1 = first repair, 2 = second repair
function installModel(script) {
  calls = [];
  dayPlan._test.setClientFactory(() => ({
    chat: {
      completions: {
        create: async (params) => {
          const isRepair = params.response_format.json_schema.name === 'lock_screen_day_repair';
          const payload = JSON.parse(params.messages[1].content);
          const round = isRepair ? calls.filter((c) => c.isRepair).length + 1 : 0;
          calls.push({ isRepair, round, payload, system: params.messages[0].content });
          const body = {
            phrases: payload.slots.map((slot) => ({
              slot_id: slot.slot_id,
              text: script(round, slot.slot_id) ?? `Строка ${slot.slot_id} раунд ${round}`,
              bank_id: '', echoes: '',
            })),
            word_of_day: 'Зыбкий',
            foreign_word: 'reluctant',
          };
          return { choices: [{ message: { content: JSON.stringify(body) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        },
      },
    },
  }));
}

function seed() {
  const insert = db.prepare('INSERT INTO daily_content_bank (bank_date, category, content_text, tags, subject) VALUES (?, ?, ?, ?, ?)');
  insert.run(DATE, 'holiday', 'A day.', '["global"]', 'day');
  for (const category of ['animals', 'nature', 'tech', 'space', 'how_it_works', 'unusual', 'tradition', 'word_origin', 'science', 'money', 'brain', 'quote', 'good_news', 'born_today', 'on_this_day']) {
    for (let i = 1; i <= 4; i += 1) insert.run(DATE, category, `${category} fact ${i} with 7 numbers`, '[]', `${category}-${i}`);
  }
}

async function generate(id) {
  db.prepare("INSERT OR REPLACE INTO devices (device_id, name, gender, birth_date, timezone) VALUES (?, 'Baur', 'male', '1990-02-05', 'Asia/Almaty')").run(id);
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await dayPlan.generateDay({
      device: db.prepare('SELECT * FROM devices WHERE device_id = ?').get(id),
      languageCode: 'ru', dateContext: { date: DATE }, weather: null, countryCode: 'KZ', phoneYesterday: null,
      bank: bank.selectBankRowsForDay(DATE),
    });
  } finally {
    Object.assign(console, original);
  }
}

const repairs = () => calls.filter((c) => c.isRepair);
const slotIds = (call) => call.payload.slots.map((s) => s.slot_id).sort();
const textOf = (day, id) => (day.phrases.find((p) => p.slot_id === id) || {}).text;

async function main() {
  seed();

  // 1. fixed by the first repair: no second call
  installModel((round, id) => (id === 'd2' && round === 0 ? LONG : undefined));
  let day = await generate('r1');
  assert.strictEqual(repairs().length, 1);
  assert(textOf(day, 'd2').includes('раунд 1'));

  // 2. still too long after the first repair: a second call, only for that phrase; then it is kept
  installModel((round, id) => (id === 'd2' && round <= 1 ? LONG : (id === 'm3' && round === 0 ? LONG : undefined)));
  day = await generate('r2');
  assert.strictEqual(calls.length, 3, 'day call + two repair calls');
  assert.deepStrictEqual(slotIds(repairs()[0]), ['d2', 'm3']);
  assert.deepStrictEqual(slotIds(repairs()[1]), ['d2'], 'the second call is only for what is still too long (m3 was fixed)');
  assert(textOf(day, 'd2').includes('раунд 2'), 'the second repair fixed it');
  assert(textOf(day, 'm3').includes('раунд 1'));
  assert(!day.dropped.some((d) => d.slot_id === 'd2'));
  assert.strictEqual(day.repair.rounds, 2);
  assert(/55-60 characters/.test(repairs()[0].system) && /55-60 characters/.test(repairs()[1].system), 'the repair target is 55-60 characters');

  // 3. still too long after the second call: dropped, and no third call
  installModel((round, id) => (id === 'd2' ? LONG : undefined));
  day = await generate('r3');
  assert.strictEqual(repairs().length, 2, 'never a third call');
  assert.strictEqual(textOf(day, 'd2'), undefined);
  assert(day.dropped.some((d) => d.slot_id === 'd2' && /too_long/.test(d.reason)));

  // 4. a quiz pair: the second call takes the long answer together with its question
  installModel((round, id) => (id === 'e10' ? LONG : undefined));
  day = await generate('r4');
  assert.strictEqual(repairs().length, 2);
  assert.deepStrictEqual(slotIds(repairs()[0]), ['e10', 'e9']);
  assert.deepStrictEqual(slotIds(repairs()[1]), ['e10', 'e9'], 'question and answer go together');
  assert(textOf(day, 'e9') === undefined && textOf(day, 'e10') === undefined, 'a pair that stays too long is dropped whole');
  assert(textOf(day, 'd4') && textOf(day, 'd5') && textOf(day, 'n4') && textOf(day, 'n5'), 'other pairs stay');
  // ... and the pair is kept when the second call fixes it
  installModel((round, id) => (id === 'e10' && round <= 1 ? LONG : undefined));
  day = await generate('r4b');
  assert(textOf(day, 'e9') && textOf(day, 'e10').includes('раунд 2'));

  // 5. the word pair: the long answer takes its recall along in the second call
  installModel((round, id) => (id === 'n9' && round <= 1 ? LONG : undefined));
  day = await generate('r5');
  assert.deepStrictEqual(slotIds(repairs()[1]), ['n8', 'n9']);
  assert(textOf(day, 'n8') && textOf(day, 'n9').includes('раунд 2'));

  // 6. other rejections (empty, wrong script) are repaired once and not retried
  installModel((round, id) => (id === 'd2' ? (round === 0 ? 'x'.repeat(10) : '') : undefined)); // wrong script, then empty
  day = await generate('r6');
  assert.strictEqual(repairs().length, 1, 'only too-long phrases get the second call');
  assert.strictEqual(textOf(day, 'd2'), undefined);

  // 7. a long phrase and a not-too-long rejection together: round 2 only for the long one
  installModel((round, id) => {
    if (id === 'd2') return round === 0 ? 'x'.repeat(10) : (round === 1 ? '' : undefined);
    if (id === 'm3') return round <= 1 ? LONG : undefined;
    return undefined;
  });
  day = await generate('r7');
  assert.deepStrictEqual(slotIds(repairs()[1]), ['m3'], 'the empty d2 is not sent again');
  assert(textOf(day, 'm3').includes('раунд 2') && textOf(day, 'd2') === undefined);

  console.log('second-repair tests passed');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => {
    dayPlan._test.setClientFactory(null);
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
