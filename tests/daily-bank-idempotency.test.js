// Regression coverage for the same-day-rerun idempotency fix: a successful
// generateDailyBank() rerun for a bank_date that already has rows must
// REPLACE them atomically, never append/duplicate, and any failure before
// that point must leave the existing bank completely untouched. Tests the
// extracted replaceBankItemsForDate() transaction directly -- zero real
// OpenAI calls anywhere in this file (OPENAI_API_KEY is never set).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-bank-idempotency-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const { _test: bankTest } = require('../src/dailyContentBank');

const { replaceBankItemsForDate } = bankTest;

function rowsForDate(bankDate) {
  return db.prepare('SELECT bank_date, category, content_text, tags FROM daily_content_bank WHERE bank_date = ? ORDER BY id ASC')
    .all(bankDate);
}

function allRows() {
  return db.prepare('SELECT bank_date, category, content_text FROM daily_content_bank ORDER BY bank_date ASC, id ASC').all();
}

function main() {
  // --- first generation stores a bank normally ---
  {
    const items = [
      { category: 'holiday', content_text: 'First-run holiday item.', tags: ['global'] },
      { category: 'science', content_text: 'First-run science item.', tags: ['global'] },
    ];
    replaceBankItemsForDate('2026-09-22', items);
    const stored = rowsForDate('2026-09-22');
    assert.strictEqual(stored.length, 2, 'first generation must store exactly the generated items');
    assert.deepStrictEqual(
      stored.map((r) => r.content_text),
      ['First-run holiday item.', 'First-run science item.']
    );
  }

  // --- rows from OTHER bank_dates are untouched by a replace on a different date ---
  {
    replaceBankItemsForDate('2026-09-21', [
      { category: 'fact', content_text: 'Yesterday item, must survive untouched.', tags: ['global'] },
    ]);
    const before = rowsForDate('2026-09-21');
    assert.strictEqual(before.length, 1);

    // Replacing TODAY's date must not touch yesterday's rows at all.
    replaceBankItemsForDate('2026-09-22', [
      { category: 'holiday', content_text: 'Second-run holiday item.', tags: ['global'] },
    ]);
    const yesterdayAfter = rowsForDate('2026-09-21');
    assert.deepStrictEqual(yesterdayAfter, before, 'a replace for a different bank_date must not affect other dates at all');
  }

  // --- successful rerun for the SAME bank_date REPLACES old rows, does not append ---
  {
    const secondRunItems = [
      { category: 'humor', content_text: 'Second-run humor item.', tags: ['global'] },
      { category: 'country_fact', content_text: 'Second-run country fact.', tags: ['KZ'] },
      { category: 'good_news', content_text: 'Second-run good news.', tags: ['global'] },
    ];
    replaceBankItemsForDate('2026-09-22', secondRunItems);

    const stored = rowsForDate('2026-09-22');
    assert.strictEqual(stored.length, 3, 'a rerun for the same bank_date must replace, leaving only the new item count');
    assert.deepStrictEqual(
      stored.map((r) => r.content_text).sort(),
      secondRunItems.map((r) => r.content_text).sort(),
      'only the new run\'s items must remain for that bank_date'
    );
    // Explicitly confirm none of the earlier runs' content survived.
    assert(!stored.some((r) => r.content_text === 'First-run holiday item.'), 'first-run item must be gone after replace');
    assert(!stored.some((r) => r.content_text === 'Second-run holiday item.'), 'the intermediate second-run-before-this item must also be gone after this replace');
  }

  // --- no duplicate same-day rows remain after a successful rerun ---
  {
    const totalTodayRows = rowsForDate('2026-09-22').length;
    assert.strictEqual(totalTodayRows, 3, 'exactly one generation worth of rows must exist for today, no duplicates accumulated across reruns');
  }

  // --- a failure INSIDE the transaction must roll back completely, leaving
  // the previous bank for that date fully intact (nothing partially deleted
  // or partially inserted) ---
  {
    const beforeFailure = rowsForDate('2026-09-22');
    assert.strictEqual(beforeFailure.length, 3, 'sanity check: bank exists before the failing rerun attempt');

    let threw = false;
    try {
      replaceBankItemsForDate('2026-09-22', [
        { category: 'fact', content_text: 'This one is fine.', tags: ['global'] },
        // A row whose content_text is not a string makes JSON.stringify(tags)
        // irrelevant but insertBankItemStatement.run() itself will throw on
        // this malformed row (content_text is NOT NULL TEXT in the schema),
        // simulating a mid-batch failure after some rows would otherwise
        // already have been inserted.
        { category: 'fact', content_text: null, tags: ['global'] },
      ]);
    } catch (err) {
      threw = true;
    }
    assert(threw, 'a malformed row must cause replaceBankItemsForDate to throw, not silently partially succeed');

    const afterFailure = rowsForDate('2026-09-22');
    assert.deepStrictEqual(
      afterFailure,
      beforeFailure,
      'a failed/thrown replace must leave the previous bank for that date completely unchanged (transaction rolled back)'
    );
  }

  // --- overall: no cross-date leakage, no accumulation, final state is clean ---
  {
    const everything = allRows();
    const todayCount = everything.filter((r) => r.bank_date === '2026-09-22').length;
    const yesterdayCount = everything.filter((r) => r.bank_date === '2026-09-21').length;
    assert.strictEqual(todayCount, 3, 'today must still have exactly the last successful run\'s rows');
    assert.strictEqual(yesterdayCount, 1, 'yesterday must still have exactly its own untouched row');
  }
}

main();
db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('daily-bank-idempotency.test.js: all assertions passed');
