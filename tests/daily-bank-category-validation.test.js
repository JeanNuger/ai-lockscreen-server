// Bank v3 parsing and saving: parseBankItems() DROPS any item whose category is not in BANK_CATEGORIES
// (with a warning), never silently coerces it; strips search citations; keeps the country as a tag; sets
// aside "NONE:" notes; the missing-required-category warnings; the post-save summary; and an end-to-end
// generateDailyBank() with a mocked OpenAI response (no real calls).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-bank-category-validation-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const { BANK_CATEGORIES, generateDailyBank, getBankDateString, _test: bankTest } = require('../src/dailyContentBank');

const { parseBankItems, logMissingRequiredCategories, logBankSummary } = bankTest;

function withCapturedConsole(fn) {
  const warnCalls = [];
  const logCalls = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args) => warnCalls.push(args.join(' '));
  console.log = (...args) => logCalls.push(args.join(' '));
  try {
    fn();
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
  return { warnCalls, logCalls };
}

async function withCapturedConsoleAsync(fn) {
  const warnCalls = [];
  const logCalls = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  const originalError = console.error;
  console.warn = (...args) => warnCalls.push(args.join(' '));
  console.log = (...args) => logCalls.push(args.join(' '));
  console.error = () => {};
  let value;
  try {
    value = await fn();
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
    console.error = originalError;
  }
  return { value, warnCalls, logCalls };
}

function rowsForDate(bankDate) {
  return db.prepare('SELECT bank_date, category, content_text, tags FROM daily_content_bank WHERE bank_date = ? ORDER BY id ASC')
    .all(bankDate);
}

async function main() {
  const bankDate = '2026-09-22';

  // --- an unknown category is dropped, not coerced ---
  {
    const raw = JSON.stringify([
      { category: 'art', country: 'global', text: 'A fact about art that must be dropped.' },
      { category: 'film', country: 'global', text: 'A fact about film that must be dropped.' },
      { category: 'fact', country: 'global', text: 'A fact about fact that must be dropped.' },
    ]);
    const { warnCalls } = withCapturedConsole(() => {
      const { rows } = parseBankItems(raw, bankDate);
      assert.strictEqual(rows.length, 0, 'every item with an unknown category must be dropped');
    });
    for (const name of ['art', 'film', 'fact']) {
      assert(warnCalls.some((line) => line.includes(`"${name}"`)), `a warning naming "${name}" must be logged`);
    }
  }

  // --- a valid category is kept; country becomes the tag; every row gets the bank date ---
  {
    const raw = JSON.stringify([
      { category: 'good_news', country: 'global', text: 'A real good news item.' },
      { category: 'holiday', country: 'kz', text: 'A Kazakhstan holiday.' },
      { category: 'science', country: '', text: 'A science fact.' },
    ]);
    let parsed;
    const { warnCalls } = withCapturedConsole(() => { parsed = parseBankItems(raw, bankDate); });
    assert.strictEqual(warnCalls.length, 0, 'a fully valid response must not warn');
    assert.deepStrictEqual(parsed.rows.map((r) => [r.category, r.tags, r.bank_date]), [
      ['good_news', ['global'], bankDate],
      ['holiday', ['KZ'], bankDate],
      ['science', [], bankDate],
    ]);
  }

  // --- search citations are stripped, placeholders and duplicates dropped, NONE notes set aside ---
  {
    const raw = JSON.stringify([
      { category: 'tech', country: 'global', text: 'GPS needs four satellites. ([site](https://example.com/a?utm_source=openai))' },
      { category: 'tech', country: 'global', text: 'GPS needs four satellites.' },
      { category: 'space', country: 'global', text: '(no verifiable space facts)' },
      { category: 'holiday', country: 'KZ', text: 'NONE: No official Kazakhstan holiday falls on that date.' },
      { category: 'holiday', country: 'global', text: 'NONE: No UN day falls on that date.' },
    ]);
    const parsed = parseBankItems(raw, bankDate);
    assert.deepStrictEqual(parsed.rows.map((r) => r.content_text), ['GPS needs four satellites.']);
    assert.deepStrictEqual(parsed.noneNotes.map((n) => n.country), ['KZ', 'global']);
    assert.strictEqual(bankTest.stripCitations('Text [a](http://b) end'), 'Text end');
  }

  // --- the required holidays are reported when missing, and silent when present ---
  {
    const present = [
      { category: 'holiday', content_text: 'x', tags: ['KZ'] },
      { category: 'holiday', content_text: 'x2', tags: ['global'] },
      { category: 'on_this_day', content_text: 'x', tags: [] },
      { category: 'born_today', content_text: 'x', tags: [] },
    ];
    const silent = withCapturedConsole(() => logMissingRequiredCategories(present, bankDate, []));
    assert.strictEqual(silent.warnCalls.length, 0, 'no warnings when everything required is present');

    const missing = withCapturedConsole(() => logMissingRequiredCategories(
      [{ category: 'holiday', content_text: 'x', tags: ['RU'] }],
      bankDate,
      [{ category: 'holiday', country: 'KZ', text: 'NONE: x' }]
    ));
    assert(missing.warnCalls.some((l) => l.includes('on_this_day')));
    assert(missing.warnCalls.some((l) => l.includes('born_today')));
    assert(missing.warnCalls.some((l) => l.includes('no Kazakhstan holiday') && l.includes('model reported none')));
    assert(missing.warnCalls.some((l) => l.includes('no international day')));
  }

  // --- logBankSummary prints total + per-date/category breakdown ---
  {
    const items = [
      { category: 'tech', bank_date: '2026-09-22', content_text: 'x' },
      { category: 'tech', bank_date: '2026-09-22', content_text: 'x' },
      { category: 'science', bank_date: '2026-09-22', content_text: 'x' },
    ];
    const { logCalls } = withCapturedConsole(() => logBankSummary(items));
    assert(logCalls[0].includes('3 rows'), `first line must state the total row count, got: ${logCalls[0]}`);
    const line = logCalls.find((l) => l.startsWith('2026-09-22:'));
    assert(line && line.includes('tech=2') && line.includes('science=1'), `date line malformed: ${line}`);
  }

  // --- end to end: generateDailyBank() with a mocked response mixing valid categories with junk ---
  {
    const junkCategories = ['art', 'film', 'english', 'geography', 'history', 'literature', 'music', 'mythology'];
    for (const junk of junkCategories) {
      assert(!BANK_CATEGORIES.includes(junk), `sanity: "${junk}" must not be a real BANK_CATEGORIES entry`);
    }
    const todayBankDate = getBankDateString();
    // an older day that must survive, and a stale one (older than the retention) that must be pruned
    const insertRow = db.prepare('INSERT INTO daily_content_bank (bank_date, category, content_text, tags) VALUES (?, ?, ?, ?)');
    insertRow.run('2026-01-01', 'science', 'Stale fact.', '[]');
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    insertRow.run(yesterday, 'science', 'Yesterday fact that must not be repeated.', '[]');

    const mockItems = [
      ...junkCategories.map((category, i) => ({ category, country: 'global', text: `Junk ${category} item ${i}.` })),
      { category: 'good_news', country: 'global', text: 'Real good news item.' },
      { category: 'born_today', country: 'RU', text: 'Real born_today item.' },
    ];
    const seenParams = [];
    bankTest.setBankClientFactory(() => ({
      responses: {
        create: async (params) => {
          seenParams.push(params);
          return {
            output_text: JSON.stringify(mockItems),
            usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, output_tokens_details: { reasoning_tokens: 7 } },
            output: [{ type: 'web_search_call' }, { type: 'web_search_call' }],
          };
        },
      },
    }));
    process.env.OPENAI_API_KEY = 'test-key-category-validation';

    try {
      const { value: result, warnCalls: warns, logCalls: logs } = await withCapturedConsoleAsync(() => generateDailyBank());

      assert.strictEqual(result.error, null);
      assert.strictEqual(result.savedCount, 2, 'only the 2 valid-category items must be counted as saved');
      const stored = rowsForDate(todayBankDate);
      assert.deepStrictEqual(stored.map((r) => r.category).sort(), ['born_today', 'good_news']);
      assert.strictEqual(stored.find((r) => r.category === 'born_today').tags, '["RU"]');
      for (const junk of junkCategories) {
        assert(warns.some((line) => line.includes(junk)), `a warning naming "${junk}" must have been logged`);
      }
      assert(logs.some((line) => line.includes('2 rows')), 'the summary log must report exactly 2 saved rows');

      // model, search tool, reasoning effort and the 30-day "do not repeat" list
      assert.strictEqual(seenParams.length, 1, 'exactly one model call');
      assert.strictEqual(seenParams[0].model, 'gpt-6.1-sol');
      assert.deepStrictEqual(seenParams[0].tools, [{ type: 'web_search' }]);
      assert.deepStrictEqual(seenParams[0].reasoning, { effort: 'low' });
      assert(seenParams[0].input.includes('Yesterday fact that must not be repeated.'), 'the last 30 days of bank facts are in the prompt');
      assert(!seenParams[0].input.includes('Stale fact.'), 'facts older than 30 days are not');
      assert(logs.some((line) => line.startsWith('OPENAI_USAGE scope=daily_bank') && line.includes('reasoning_tokens=7') && line.includes('searches=2')));

      // an older day stays, the stale one is pruned, a same-day rerun replaces instead of appending
      assert.strictEqual(rowsForDate(yesterday).length, 1, "yesterday's bank must be kept");
      assert.strictEqual(rowsForDate('2026-01-01').length, 0, 'a bank older than the retention is pruned');
      const { value: second } = await withCapturedConsoleAsync(() => generateDailyBank());
      assert.strictEqual(second.savedCount, 2);
      assert.strictEqual(rowsForDate(todayBankDate).length, 2, 'a same-day rerun must replace, not append');
    } finally {
      bankTest.setBankClientFactory(null);
      delete process.env.OPENAI_API_KEY;
    }
  }

  // --- a failed call leaves the stored bank untouched ---
  {
    const todayBankDate = getBankDateString();
    const before = rowsForDate(todayBankDate).length;
    bankTest.setBankClientFactory(() => ({ responses: { create: async () => { throw new Error('boom'); } } }));
    process.env.OPENAI_API_KEY = 'test-key-category-validation';
    try {
      const { value: result } = await withCapturedConsoleAsync(() => generateDailyBank());
      assert.strictEqual(result.savedCount, 0);
      assert.strictEqual(result.error, 'boom');
      assert.strictEqual(rowsForDate(todayBankDate).length, before, 'a failed call must not touch the stored bank');
    } finally {
      bankTest.setBankClientFactory(null);
      delete process.env.OPENAI_API_KEY;
    }
  }
  console.log('daily-bank-category-validation tests passed');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
