// TEST ONLY (task 27): one real run of the daily bank of the day scheme v2 against a THROWAWAY database.
// Nothing here is wired into the server and the production database is never opened.
//
//   node scripts/bank-test-v2.js [YYYY-MM-DD]     (default: the next Friday, so the events poster is included)
//
// Creates a temp database with devices in several countries and cities (active: each has a day plan),
// runs generateDailyBank() once with web search, prints the OPENAI_USAGE scope=daily_bank line, the
// BANK_CATEGORY_COUNTS line and an estimate of the price, and writes the saved rows to OUT_DIR.
// The OpenAI key comes from the local .env and is never printed.
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const OUT_DIR = process.env.BANK_TEST_OUT || path.join(os.tmpdir(), 'bank_test_v2');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-banktest-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');

const db = require('../src/db');
const bank = require('../src/dailyContentBank');

// gpt-6.1-sol, standard tier, per 1M tokens (see scripts/daily-test-v3.js); the web-search tool calls are billed separately.
const PRICE_IN = 2;
const PRICE_OUT = 10;

function nextFriday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

async function main() {
  const bankDate = process.argv[2] || nextFriday();
  const insertDevice = db.prepare('INSERT INTO devices (device_id, timezone, city_name, city_country_code) VALUES (?, ?, ?, ?)');
  const insertPlan = db.prepare('INSERT INTO day_plans (device_id, local_date, phrases, source) VALUES (?, ?, ?, ?)');
  const devices = [
    ['t-astana', 'Asia/Almaty', 'Astana', 'KZ'],
    ['t-almaty', 'Asia/Almaty', 'Almaty', 'KZ'],
    ['t-moscow', 'Europe/Moscow', 'Moscow', 'RU'],
    ['t-berlin', 'Europe/Berlin', 'Berlin', 'DE'],
    ['t-tashkent', 'Asia/Tashkent', 'Tashkent', 'UZ'],
    ['t-nocity', 'Europe/Kyiv', null, null],
  ];
  for (const [id, tz, city, country] of devices) {
    insertDevice.run(id, tz, city, country);
    insertPlan.run(id, bankDate, '[]', 'openai');
  }
  const locations = bank.collectActiveLocations();
  console.log(`bank_date=${bankDate} countries=${locations.countries.join(',')} cities=${locations.cities.map((c) => `${c.name}/${c.country}`).join(',')}`);

  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); original(...args); };
  const outcome = await bank.generateDailyBank({ bankDate });
  console.log = original;

  console.log('outcome', JSON.stringify(outcome));
  const usage = lines.find((l) => l.startsWith('OPENAI_USAGE scope=daily_bank '));
  const num = (name) => Number((usage && usage.match(new RegExp(`${name}=(\\d+)`)) || [])[1] || 0);
  if (usage) {
    const cost = (num('prompt_tokens') * PRICE_IN + num('completion_tokens') * PRICE_OUT) / 1e6;
    console.log(`ESTIMATED_TOKEN_COST_USD=${cost.toFixed(3)} (tokens only; ${num('searches')} web searches are billed on top)`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = db.prepare('SELECT category, content_text, tags FROM daily_content_bank WHERE bank_date = ? ORDER BY category, id').all(bankDate);
  fs.writeFileSync(path.join(OUT_DIR, `bank_${bankDate}.json`), JSON.stringify(rows.map((r) => ({ ...r, tags: JSON.parse(r.tags) })), null, 2));
  console.log(`rows written to ${path.join(OUT_DIR, `bank_${bankDate}.json`)}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
