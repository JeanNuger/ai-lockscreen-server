// One step of scripts/prompt-test.js, run in its own process so that every run gets its own
// database and its own environment (DATABASE_PATH is read when src/db is first required).
//
//   node scripts/prompt-test-child.js bank <dbFile>
//       generates the daily bank with the prompt selected by CHEAPER_PROMPT into <dbFile>
//   node scripts/prompt-test-child.js run <bankDbFile> <outJsonFile> <window>
//       copies the bank database, adds the test device, generates ONE batch for <window>
//       and writes what happened (tokens, rejections, texts) to <outJsonFile>
//
// The OpenAI key comes from the local .env and is never printed.
const fs = require('fs');
const os = require('os');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const [mode, first, second, third] = process.argv.slice(2);

function capture(fn) {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const grab = (line) => lines.push(String(line));
  console.log = (...args) => grab(args.join(' '));
  console.warn = (...args) => grab(args.join(' '));
  console.error = (...args) => grab(args.join(' '));
  const restore = () => Object.assign(console, originals);
  return fn().then((value) => { restore(); return { value, lines }; }, (err) => { restore(); throw err; });
}

async function bank(dbFile) {
  process.env.DATABASE_PATH = dbFile;
  const { generateDailyBank } = require('../src/dailyContentBank');
  const { value, lines } = await capture(() => generateDailyBank());
  fs.writeFileSync(`${dbFile}.bank.json`, JSON.stringify({ result: value, lines }, null, 2));
  const db = require('../src/db');
  const rows = db.prepare('SELECT category, content_text FROM daily_content_bank').all();
  fs.writeFileSync(`${dbFile}.bank-rows.json`, JSON.stringify(rows, null, 2));
  console.log(`bank: saved=${value.savedCount} error=${value.error || 'none'} rows=${rows.length}`);
  db.close();
  process.exit(value.error ? 1 : 0);
}

async function run(bankDbFile, outFile, window) {
  const runDb = path.join(os.tmpdir(), `prompt-test-run-${process.pid}-${Date.now()}.db`);
  fs.copyFileSync(bankDbFile, runDb);
  process.env.DATABASE_PATH = runDb;

  const db = require('../src/db');
  const { generateBatch, resolveLocalDateContext } = require('../src/contentGenerator');

  const timezone = 'Asia/Almaty';
  db.prepare(`
    INSERT INTO devices (device_id, name, gender, birth_date, interests, timezone, city_name, city_country_code, created_at)
    VALUES ('prompt-test-device', 'Баур', 'male', '1990-02-05', ?, ?, 'Астана', 'KZ', '2026-09-01 00:00:00')
  `).run(JSON.stringify(['interest_work', 'interest_self_development']), timezone);
  const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get('prompt-test-device');

  // Night recalls today's morning word; seed the same word for every variant so the night batch
  // carries a learning_recall slot in all of them.
  const { dateContext } = resolveLocalDateContext(timezone);
  const recallDate = dateContext.time < '05:00' ? null : dateContext.date;
  if (recallDate) {
    db.prepare(`
      INSERT INTO device_learning_memory (device_id, word_key, word_text, learned_local_date)
      VALUES (?, 'seed-word', ?, ?)
    `).run(device.device_id, 'Слово: «эгрегор» — коллективный дух группы людей', recallDate);
  }

  const weather = { temperatureC: 9, description: 'light rain', city: 'Астана', countryCode: 'KZ', forecast: true };
  const signals = { system_language: 'ru', region: 'KZ' };

  const started = Date.now();
  const { value: result, lines } = await capture(() => generateBatch(device, window, signals, weather, {}, {}));
  const seconds = (Date.now() - started) / 1000;

  const usage = [];
  for (const line of lines) {
    const m = line.match(/^OPENAI_USAGE scope=(\S+) .*?prompt_tokens=(\d+) completion_tokens=(\d+) reasoning_tokens=(\d+)/);
    if (m) {
      usage.push({ scope: m[1], prompt: Number(m[2]), completion: Number(m[3]), reasoning: Number(m[4]) });
    }
  }
  const firstPass = (result.trace && result.trace.first_pass) || [];
  const tooLongFirstPass = firstPass.filter((p) => p.status === 'rejected' && /^too_long/.test(String(p.reason || ''))).length;
  const rejectedFirstPass = firstPass.filter((p) => p.status !== 'accepted').map((p) => ({
    slot_id: p.slot_id, status: p.status, reason: p.reason, length: p.text ? p.text.length : null,
  }));
  const plannedSlots = JSON.parse(result.context).slots;
  const final = (result.trace && result.trace.final) || [];

  fs.writeFileSync(outFile, JSON.stringify({
    window,
    source: result.source,
    seconds,
    usage,
    repairRequests: usage.filter((u) => u.scope === 'lock_screen_repair').length,
    tooLongFirstPass,
    rejectedFirstPass,
    plannedSlots: plannedSlots.length,
    finalPhrases: result.phrases.length,
    dropped: plannedSlots.length - result.phrases.length,
    longerThan70: result.phrases.filter((p) => p.text.length > 70).length,
    final: final.map((f) => ({ position: f.position, type: f.type, text: f.text, final_source: f.final_source })),
    planned: plannedSlots.map((s, i) => ({ position: i + 1, type: s.type, max_chars: s.max_chars === undefined ? null : s.max_chars })),
    logTail: lines.filter((l) => /^(AI_BATCH_RESULT|OPENAI_ATTEMPT|PAIR_DROPPED|AI_BATCH_ERROR)/.test(l)),
  }, null, 2));
  db.close();
  fs.rmSync(runDb, { force: true });
}

(async () => {
  if (!process.env.OPENAI_API_KEY) {
    console.error('NO_OPENAI_KEY');
    process.exit(2);
  }
  if (mode === 'bank') {
    await bank(first);
  } else if (mode === 'run') {
    await run(first, second, third);
  } else {
    console.error('usage: bank <dbFile> | run <bankDbFile> <outJsonFile> <window>');
    process.exit(64);
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
