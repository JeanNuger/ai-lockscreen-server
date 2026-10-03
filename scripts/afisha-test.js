// TEST ONLY (task 31): one real run of the weekend poster search against a THROWAWAY database.
//
//   node scripts/afisha-test.js [bankDate YYYY-MM-DD] [city:CC ...]
//
// Default: the Friday before this weekend, the two days after it, cities Astana:KZ and Almaty:KZ. Prints the
// OPENAI_USAGE scope=afisha lines, the AFISHA_COUNTS lines, a token price estimate and every event found
// (title, kind, venue, date and time, audience, source), and writes them to OUT_DIR/afisha_<bankDate>.json.
// The OpenAI key comes from the local .env and is never printed.
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const OUT_DIR = process.env.AFISHA_TEST_OUT || path.join(os.tmpdir(), 'afisha_test');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-afishatest-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');

const db = require('../src/db');
const { generateAfisha, weekendDatesFor } = require('../src/afishaSearch');

// gpt-6.1-sol, per 1M tokens (see scripts/daily-test-v3.js); the web-search tool calls are billed separately.
const PRICE_IN = 2;
const PRICE_OUT = 10;

async function main() {
  const bankDate = process.argv[2] || '2026-10-02';
  const cities = (process.argv.length > 3 ? process.argv.slice(3) : ['Astana:KZ', 'Almaty:KZ'])
    .map((entry) => ({ name: entry.split(':')[0], country: entry.split(':')[1] }));
  const dates = weekendDatesFor(bankDate);
  console.log(`bank_date=${bankDate} weekend=${dates.join(',')} cities=${cities.map((c) => c.name).join(',')}`);

  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); original(...args); };
  const outcome = await generateAfisha({ bankDate, dates, cities });
  console.log = original;

  let promptTokens = 0;
  let completionTokens = 0;
  let searches = 0;
  for (const line of lines.filter((l) => l.startsWith('OPENAI_USAGE scope=afisha '))) {
    const num = (name) => Number((line.match(new RegExp(`${name}=(\\d+)`)) || [])[1] || 0);
    promptTokens += num('prompt_tokens');
    completionTokens += num('completion_tokens');
    searches += num('searches');
  }
  console.log(`TOTAL prompt_tokens=${promptTokens} completion_tokens=${completionTokens} searches=${searches} ESTIMATED_TOKEN_COST_USD=${((promptTokens * PRICE_IN + completionTokens * PRICE_OUT) / 1e6).toFixed(3)} (tokens only; the web searches are billed on top)`);

  const all = [];
  for (const result of outcome.results) {
    console.log(`\n=== ${result.city}: ${result.savedCount} events${result.error ? ` (${result.error})` : ''}, rejected ${result.rejected.length}`);
    for (const row of result.rows) {
      const e = row.event;
      console.log(`- ${e.title} | ${e.kind} | ${e.venue} | ${e.date}${e.time ? ` ${e.time}` : ''} | ${e.audience} | ${e.source}`);
      all.push({ city: result.city, ...e });
    }
    for (const r of result.rejected) console.log(`  rejected (${r.reason}): ${r.title}`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `afisha_${bankDate}.json`), JSON.stringify(all, null, 2));
  console.log(`\nevents written to ${path.join(OUT_DIR, `afisha_${bankDate}.json`)}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
