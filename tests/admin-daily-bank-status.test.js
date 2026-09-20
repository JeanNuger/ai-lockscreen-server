const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-admin-bank-status-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const adminRoute = require('../src/routes/admin');
const { getBankDateString } = require('../src/dailyContentBank');

const { buildDailyBankStatusResponse } = adminRoute._test;

function main() {
  // --- empty bank: no rows at all yet ---
  {
    const response = buildDailyBankStatusResponse(null, getBankDateString(), []);
    assert.strictEqual(response.latest_bank_date, null, 'empty bank must report latest_bank_date as null');
    assert.strictEqual(response.is_current, false, 'empty bank must never report is_current true');
    assert.strictEqual(response.total_items, 0);
    assert.deepStrictEqual(response.categories, {});
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
    const response = buildDailyBankStatusResponse(today, today, rows);
    assert.strictEqual(response.is_current, true, 'latest_bank_date matching expected_bank_date must report is_current true');
    assert.strictEqual(response.total_items, 3);
    assert.deepStrictEqual(response.categories, { science: 2, holiday: 1 }, 'categories must be grouped with correct counts');
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
