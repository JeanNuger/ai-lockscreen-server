// Regression coverage for the category-validation fix: parseBankItems() must
// DROP any item whose category is not in BANK_CATEGORIES (with a warning),
// never silently coerce it to 'fact' -- that used to let content sit in
// daily_content_bank forever invisible to selectBankItemsForDevice (see
// isBankItemAllowedForCountry's own category check). Also covers the new
// missing-required-category warnings and the post-save summary log. Zero
// real OpenAI calls in this file (OPENAI_API_KEY is set only for the mocked
// generateDailyBank() case below).
const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-bank-category-validation-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const { BANK_CATEGORIES, generateDailyBank, _test: bankTest } = require('../src/dailyContentBank');

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

function rowsForDate(bankDate) {
  return db.prepare('SELECT bank_date, category, content_text FROM daily_content_bank WHERE bank_date = ? ORDER BY id ASC')
    .all(bankDate);
}

async function main() {
  const bankDate = '2026-09-22';
  const preparedDates = ['2026-09-21', '2026-09-22', '2026-09-23'];

  // --- an unknown category is dropped, not coerced to 'fact' ---
  {
    const raw = JSON.stringify([
      { category: 'art', content_text: 'A fact about art that must be dropped.', tags: ['global'] },
      { category: 'film', content_text: 'A fact about film that must be dropped.', tags: ['global'] },
      { category: 'english', content_text: 'A fact about English that must be dropped.', tags: ['global'] },
    ]);
    const { warnCalls } = withCapturedConsole(() => {
      const items = parseBankItems(raw, bankDate, preparedDates);
      assert.strictEqual(items.length, 0, 'every item with an unknown category must be dropped, none coerced to fact');
    });
    assert(warnCalls.some((line) => line.includes('art')), 'a warning naming "art" must be logged');
    assert(warnCalls.some((line) => line.includes('film')), 'a warning naming "film" must be logged');
    assert(warnCalls.some((line) => line.includes('english')), 'a warning naming "english" must be logged');
  }

  // --- a valid category is kept, untouched ---
  {
    const raw = JSON.stringify([
      { category: 'science', content_text: 'A real science fact.', tags: ['global'] },
    ]);
    const { warnCalls } = withCapturedConsole(() => {
      const items = parseBankItems(raw, bankDate, preparedDates);
      assert.strictEqual(items.length, 1, 'a valid category must be kept');
      assert.strictEqual(items[0].category, 'science');
      assert.strictEqual(items[0].content_text, 'A real science fact.');
    });
    assert.strictEqual(warnCalls.length, 0, 'a fully valid response must not warn about dropped categories');
  }

  // --- a mix of valid and invalid categories: only the valid ones survive ---
  {
    const raw = JSON.stringify([
      { category: 'holiday', content_text: 'Holiday item.', bank_date: '2026-09-23', tags: ['global'] },
      { category: 'mythology', content_text: 'Mythology item, must be dropped.', tags: ['global'] },
      { category: 'fact', content_text: 'A real fact item.', tags: ['global'] },
    ]);
    let items;
    withCapturedConsole(() => { items = parseBankItems(raw, bankDate, preparedDates); });
    assert.strictEqual(items.length, 2, 'only the two valid-category items must survive');
    assert(items.every((item) => item.category !== 'mythology'), 'mythology must never appear in parsed output');
  }

  // --- holiday/on_this_day keep their own supplied bank_date (date-sensitive) ---
  {
    const raw = JSON.stringify([
      { category: 'holiday', content_text: 'Holiday for tomorrow.', bank_date: '2026-09-23', tags: ['global'] },
      { category: 'on_this_day', content_text: 'On this day for yesterday.', bank_date: '2026-09-21', tags: ['global'] },
    ]);
    let items;
    withCapturedConsole(() => { items = parseBankItems(raw, bankDate, preparedDates); });
    const holiday = items.find((item) => item.category === 'holiday');
    const onThisDay = items.find((item) => item.category === 'on_this_day');
    assert.strictEqual(holiday.bank_date, '2026-09-23', 'holiday must keep its supplied bank_date, not the default');
    assert.strictEqual(onThisDay.bank_date, '2026-09-21', 'on_this_day must keep its supplied bank_date, not the default');
  }

  // --- a non-date-sensitive category always gets defaultBankDate, even if
  // the model supplied a different (valid, prepared) date ---
  {
    const raw = JSON.stringify([
      { category: 'quote', content_text: 'A quote item with a mismatched bank_date.', bank_date: '2026-09-23', tags: ['global'] },
    ]);
    let items;
    withCapturedConsole(() => { items = parseBankItems(raw, bankDate, preparedDates); });
    assert.strictEqual(items[0].bank_date, bankDate, 'non-date-sensitive categories must always use defaultBankDate');
  }

  // --- logMissingRequiredCategories warns for each missing holiday/on_this_day
  // per prepared date, and for a missing idiom on the main date ---
  {
    const items = [
      { category: 'holiday', bank_date: '2026-09-22', content_text: 'x' },
      // on_this_day missing for every date; holiday missing for 09-21/09-23; idiom missing entirely
    ];
    const { warnCalls } = withCapturedConsole(() => {
      logMissingRequiredCategories(items, bankDate, preparedDates);
    });
    assert(warnCalls.some((l) => l.includes('holiday') && l.includes('2026-09-21')));
    assert(warnCalls.some((l) => l.includes('holiday') && l.includes('2026-09-23')));
    assert(warnCalls.some((l) => l.includes('on_this_day') && l.includes('2026-09-21')));
    assert(warnCalls.some((l) => l.includes('on_this_day') && l.includes('2026-09-22')));
    assert(warnCalls.some((l) => l.includes('on_this_day') && l.includes('2026-09-23')));
    assert(warnCalls.some((l) => l.includes('idiom') && l.includes(bankDate)));
    // holiday IS present for 2026-09-22 -- must not warn about it
    assert(!warnCalls.some((l) => l.includes('holiday') && l.includes('2026-09-22')));
  }

  // --- logMissingRequiredCategories stays silent when everything required is present ---
  {
    const items = [
      { category: 'holiday', bank_date: '2026-09-21', content_text: 'x' },
      { category: 'holiday', bank_date: '2026-09-22', content_text: 'x' },
      { category: 'holiday', bank_date: '2026-09-23', content_text: 'x' },
      { category: 'on_this_day', bank_date: '2026-09-21', content_text: 'x' },
      { category: 'on_this_day', bank_date: '2026-09-22', content_text: 'x' },
      { category: 'on_this_day', bank_date: '2026-09-23', content_text: 'x' },
      { category: 'idiom', bank_date: bankDate, content_text: 'x' },
    ];
    const { warnCalls } = withCapturedConsole(() => {
      logMissingRequiredCategories(items, bankDate, preparedDates);
    });
    assert.strictEqual(warnCalls.length, 0, 'no warnings when every required category/date combination is present');
  }

  // --- logBankSummary prints total + per-date/category breakdown ---
  {
    const items = [
      { category: 'fact', bank_date: '2026-09-22', content_text: 'x' },
      { category: 'fact', bank_date: '2026-09-22', content_text: 'x' },
      { category: 'science', bank_date: '2026-09-22', content_text: 'x' },
      { category: 'holiday', bank_date: '2026-09-23', content_text: 'x' },
      { category: 'on_this_day', bank_date: '2026-09-23', content_text: 'x' },
    ];
    const { logCalls } = withCapturedConsole(() => {
      logBankSummary(items);
    });
    assert(logCalls[0].includes('5 rows'), `first line must state the total row count, got: ${logCalls[0]}`);
    const dateLine22 = logCalls.find((l) => l.startsWith('2026-09-22:'));
    const dateLine23 = logCalls.find((l) => l.startsWith('2026-09-23:'));
    assert(dateLine22 && dateLine22.includes('fact=2') && dateLine22.includes('science=1'), `2026-09-22 line malformed: ${dateLine22}`);
    assert(dateLine23 && dateLine23.includes('holiday=1') && dateLine23.includes('on_this_day=1'), `2026-09-23 line malformed: ${dateLine23}`);
  }

  // --- end to end: generateDailyBank() with a mocked OpenAI response mixing
  // valid categories with the exact junk taxonomy seen in production
  // (art/film/english/geography/history/literature/music/mythology) must
  // never save any of the junk categories, and BANK_CATEGORIES must not
  // contain them either (sanity check on the fixture itself) ---
  {
    const junkCategories = ['art', 'film', 'english', 'geography', 'history', 'literature', 'music', 'mythology'];
    for (const junk of junkCategories) {
      assert(!BANK_CATEGORIES.includes(junk), `sanity: "${junk}" must not be a real BANK_CATEGORIES entry`);
    }

    const mockItems = [
      ...junkCategories.map((category, i) => ({ category, content_text: `Junk ${category} item ${i}.`, tags: ['global'] })),
      { category: 'fact', content_text: 'Real fact item.', tags: ['global'] },
      { category: 'quote', content_text: 'Real quote item.', tags: ['global'] },
    ];

    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'openai') {
        return class MockOpenAI {
          constructor() {
            this.responses = {
              create: async () => ({ output_text: JSON.stringify(mockItems) }),
            };
          }
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    process.env.OPENAI_API_KEY = 'test-key-category-validation';

    try {
      let result;
      // withCapturedConsole is synchronous-only; capture around this async call manually.
      const originalWarn = console.warn;
      const originalLog = console.log;
      const warns = [];
      const logs = [];
      console.warn = (...args) => warns.push(args.join(' '));
      console.log = (...args) => logs.push(args.join(' '));
      try {
        result = await generateDailyBank();
      } finally {
        console.warn = originalWarn;
        console.log = originalLog;
      }

      assert.strictEqual(result.error, null);
      assert.strictEqual(result.savedCount, 2, 'only the 2 valid-category items must be counted as saved');

      const todayBankDate = require('../src/dailyContentBank').getBankDateString();
      const stored = rowsForDate(todayBankDate);
      for (const junk of junkCategories) {
        assert(!stored.some((row) => row.category === junk), `"${junk}" must never be persisted to daily_content_bank`);
      }
      assert(stored.some((row) => row.category === 'fact'), 'the valid fact item must be persisted');
      assert(stored.some((row) => row.category === 'quote'), 'the valid quote item must be persisted');

      for (const junk of junkCategories) {
        assert(warns.some((line) => line.includes(junk)), `a warning naming "${junk}" must have been logged`);
      }
      assert(logs.some((line) => line.includes('2 rows')), 'the summary log must report exactly 2 saved rows');
    } finally {
      Module._load = originalLoad;
      delete process.env.OPENAI_API_KEY;
    }
  }
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('daily-bank-category-validation.test.js: all assertions passed');
  })
  .catch((err) => {
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {
      // best effort cleanup
    }
    console.error(err);
    process.exit(1);
  });
