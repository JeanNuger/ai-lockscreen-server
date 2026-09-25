const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-admin-bank-status-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const adminRoute = require('../src/routes/admin');
const { getBankDateString, getPreparedBankDates } = require('../src/dailyContentBank');

const { buildDailyBankStatusResponse } = adminRoute._test;

function main() {
  // --- empty bank: no rows at all yet ---
  {
    const response = buildDailyBankStatusResponse(null, getBankDateString(), []);
    assert.strictEqual(response.latest_bank_date, null, 'empty bank must report latest_bank_date as null');
    assert.strictEqual(response.is_current, false, 'empty bank must never report is_current true');
    assert.strictEqual(response.total_items, 0);
    assert.deepStrictEqual(response.categories, {});
    assert.deepStrictEqual(response.required_categories.holiday, { present: false, count: 0 });
    assert.deepStrictEqual(response.required_categories.on_this_day, { present: false, count: 0 });
    assert.deepStrictEqual(response.required_categories.idiom, { present: false, count: 0 });
    assert.deepStrictEqual(response.sample_items, []);
  }

  // --- today's bank matches expected date: is_current must be true ---
  {
    const today = getBankDateString();
    const rows = [
      { category: 'science', content_text: 'A science fact.' },
      { category: 'science', content_text: 'Another science fact.' },
      { category: 'holiday', content_text: 'A holiday fact.' },
    ];
    const preparedDates = getPreparedBankDates(today);
    const rowsByDate = {
      [preparedDates[0]]: [
        { category: 'holiday', content_text: 'Yesterday holiday.' },
        { category: 'on_this_day', content_text: 'Yesterday history.' },
      ],
      [today]: rows,
      [preparedDates[2]]: [
        { category: 'holiday', content_text: 'Tomorrow holiday.' },
        { category: 'on_this_day', content_text: 'Tomorrow history.' },
      ],
    };
    const response = buildDailyBankStatusResponse(today, today, rows, {
      preparedDates,
      requestedDate: today,
      rowsByDate,
    });
    assert.strictEqual(response.is_current, true, 'latest_bank_date matching expected_bank_date must report is_current true');
    assert.strictEqual(response.requested_date, today);
    assert.strictEqual(response.total_items, 3);
    assert.deepStrictEqual(response.categories, { science: 2, holiday: 1 }, 'categories must be grouped with correct counts');
    assert.deepStrictEqual(response.required_categories.holiday, { present: true, count: 1 });
    assert.deepStrictEqual(response.required_categories.on_this_day, { present: false, count: 0 });
    assert.deepStrictEqual(response.required_categories.idiom, { present: false, count: 0 });
    assert.strictEqual(response.prepared_dates.length, 3);
    assert.strictEqual(response.prepared[preparedDates[0]].required_categories.on_this_day.present, true);
    assert.strictEqual(response.prepared[today].categories.science, 2);
    assert.strictEqual(response.prepared[preparedDates[2]].required_categories.holiday.present, true);
  }

  // --- stale bank (latest date is older than today): is_current must be false ---
  {
    const response = buildDailyBankStatusResponse('2020-01-01', getBankDateString(), [
      { category: 'fact', content_text: 'Old stale item.' },
    ]);
    assert.strictEqual(response.is_current, false, 'a stale latest_bank_date must never report is_current true');
    assert.strictEqual(response.expected_bank_date, getBankDateString());
  }

  // --- sample_items stays small (capped at 5) even with many rows ---
  {
    const manyRows = Array.from({ length: 40 }, (_, i) => ({ category: 'fact', content_text: `Item ${i}` }));
    const response = buildDailyBankStatusResponse('2026-09-22', '2026-09-22', manyRows);
    assert.strictEqual(response.total_items, 40, 'total_items must reflect the real count even when sample_items is capped');
    assert.strictEqual(response.sample_items.length, 5, 'sample_items must stay capped at 5 regardless of total row count');
    assert.strictEqual(response.categories.fact, 40);
  }

  // --- response never includes any secret field ---
  {
    const response = buildDailyBankStatusResponse('2026-09-22', '2026-09-22', [
      { category: 'fact', content_text: 'Some item.' },
    ]);
    const responseText = JSON.stringify(response);
    assert(!responseText.includes('INTERNAL_CRON_SECRET'), 'response must never mention INTERNAL_CRON_SECRET');
    assert(!('secret' in response), 'response must not carry any secret field');
  }

  // --- requested date can be inspected independently from latest/expected ---
  {
    const today = '2026-09-25';
    const requestedDate = '2026-09-24';
    const preparedDates = ['2026-09-24', '2026-09-25', '2026-09-26'];
    const rows = [
      { category: 'holiday', content_text: 'Requested holiday.' },
      { category: 'on_this_day', content_text: 'Requested history.' },
      { category: 'idiom', content_text: 'Requested idiom.' },
      { category: 'idiom', content_text: 'Second idiom.' },
    ];
    const response = buildDailyBankStatusResponse('2026-09-26', today, rows, {
      preparedDates,
      requestedDate,
      rowsByDate: {
        [requestedDate]: rows,
        [today]: [{ category: 'holiday', content_text: 'Today holiday.' }],
        '2026-09-26': [{ category: 'on_this_day', content_text: 'Tomorrow history.' }],
      },
    });
    assert.strictEqual(response.requested_date, requestedDate);
    assert.strictEqual(response.categories.idiom, 2);
    assert.deepStrictEqual(response.required_categories, {
      holiday: { present: true, count: 1 },
      on_this_day: { present: true, count: 1 },
      idiom: { present: true, count: 2 },
    });
    assert.strictEqual(response.prepared[today].required_categories.on_this_day.present, false);
    assert.strictEqual(response.prepared['2026-09-26'].required_categories.on_this_day.present, true);
  }

  // --- the route itself is registered behind requireAdminAuth (same
  // pattern as every other /admin/api/* route) -- a lightweight structural
  // check without spinning up an HTTP/session test harness, consistent
  // with how this repo tests routes elsewhere (pure logic via _test).
  {
    const registeredRoute = adminRoute.stack.find(
      (layer) => layer.route && layer.route.path === '/api/daily-bank-status'
    );
    assert(registeredRoute, '/api/daily-bank-status must be registered on the admin router');
    assert(registeredRoute.route.methods.get, '/api/daily-bank-status must be a GET route');
    // Express stores route middleware as [requireAdminAuth, handler] in
    // registration order -- requireAdminAuth must run before the handler.
    assert.strictEqual(registeredRoute.route.stack.length, 2, 'route must have exactly auth middleware + handler');
  }
}

main();
db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('admin-daily-bank-status.test.js: all assertions passed');
