const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAdminAuth } = require('../adminAuth');
const { STYLE_IDS } = require('../constants');
const { getBankDateString } = require('../dailyContentBank');

const router = express.Router();

// --- Login / logout ---

// The admin panel is publicly reachable (no network-level restriction), so a
// login endpoint without any limit is brute-forceable regardless of how
// strong bcrypt makes each individual guess — 5 attempts per 15 minutes per
// IP is enough for a real login mistake, not enough for a meaningful
// password-guessing run. Only /login is limited, not the rest of /admin —
// everything past it already requires requireAdminAuth (a valid session).
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many login attempts, try again later' },
});

router.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'admin', 'login.html'));
});

router.post('/login', loginRateLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const expectedUsername = process.env.ADMIN_USERNAME;
  const expectedHash = process.env.ADMIN_PASSWORD_HASH;

  if (!expectedUsername || !expectedHash) {
    return res.status(500).json({ error: 'admin credentials not configured on the server' });
  }
  if (
    username === expectedUsername &&
    password &&
    bcrypt.compareSync(password, expectedHash)
  ) {
    req.session.isAdmin = true;
    return res.status(200).json({ ok: true });
  }
  return res.status(401).json({ error: 'invalid username or password' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.status(200).json({ ok: true });
  });
});

// --- Dashboard page (protected) ---

router.get('/dashboard', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'admin', 'dashboard.html'));
});

// Redirect bare /admin to the dashboard (which itself redirects to /login if
// not authenticated), so "fixdolg.kz/admin" is a sensible thing to type.
router.get('/', (req, res) => res.redirect('/admin/dashboard'));

// --- JSON API (protected) ---

const recentBatchesStatement = db.prepare(`
  SELECT id, device_id, window, phrases, source, context, delivered_at
  FROM content_batches
  ORDER BY delivered_at DESC, id DESC
  LIMIT 30
`);

router.get('/api/recent-batches', requireAdminAuth, (req, res) => {
  const rows = recentBatchesStatement.all().map((row) => ({
    ...row,
    phrases: JSON.parse(row.phrases),
  }));
  res.status(200).json({ batches: rows });
});

const listDevicesStatement = db.prepare(`
  SELECT device_id, gender, birth_date, interests, personal_goal, tone, timezone, created_at, updated_at
  FROM devices
  ORDER BY updated_at DESC
  LIMIT 200
`);
const searchDevicesStatement = db.prepare(`
  SELECT device_id, gender, birth_date, interests, personal_goal, tone, timezone, created_at, updated_at
  FROM devices
  WHERE device_id LIKE ? OR gender LIKE ? OR personal_goal LIKE ? OR tone LIKE ?
  ORDER BY updated_at DESC
  LIMIT 200
`);

router.get('/api/devices', requireAdminAuth, (req, res) => {
  const { q } = req.query;
  let rows;
  if (q && typeof q === 'string' && q.trim()) {
    const like = `%${q.trim()}%`;
    rows = searchDevicesStatement.all(like, like, like, like);
  } else {
    rows = listDevicesStatement.all();
  }
  const parsed = rows.map((row) => ({
    ...row,
    interests: row.interests ? JSON.parse(row.interests) : [],
  }));
  res.status(200).json({ devices: parsed });
});

// --- Daily Bank monitoring (read-only) ---
// Render's Free plan has no Shell access, so this is the only way to check
// whether today's shared daily_content_bank actually exists without either
// triggering a real generation call (which costs a shared OpenAI web-search
// call) or getting direct DB access. Strictly SELECT-only: never generates a
// bank, never touches OpenAI, never writes to the database, never exposes
// INTERNAL_CRON_SECRET or any other secret -- only bank_date/category/
// content_text, the same non-secret fields already served to every device
// via /api/v1/batch.

const latestBankDateStatement = db.prepare(`
  SELECT bank_date FROM daily_content_bank ORDER BY bank_date DESC LIMIT 1
`);
const bankRowsForDateStatement = db.prepare(`
  SELECT category, content_text FROM daily_content_bank WHERE bank_date = ? ORDER BY id ASC
`);

// Pure response-shaping, kept separate from the DB reads/route wiring so it
// can be unit-tested directly (see tests/admin-daily-bank-status.test.js)
// without needing an HTTP/session test harness -- same split every other
// module in this codebase already uses (DB-touching code stays thin, the
// actual logic is a plain function exposed via _test).
function buildDailyBankStatusResponse(latestBankDate, expectedBankDate, rows) {
  const categories = {};
  for (const row of rows) {
    categories[row.category] = (categories[row.category] || 0) + 1;
  }
  return {
    latest_bank_date: latestBankDate,
    expected_bank_date: expectedBankDate,
    is_current: latestBankDate === expectedBankDate,
    total_items: rows.length,
    categories,
    sample_items: rows.slice(0, 5).map((row) => ({ category: row.category, content_text: row.content_text })),
  };
}

router.get('/api/daily-bank-status', requireAdminAuth, (req, res) => {
  const latestRow = latestBankDateStatement.get();
  const latestBankDate = latestRow ? latestRow.bank_date : null;
  // Same Asia/Almaty product-day date logic Daily Bank generation itself
  // uses (see dailyContentBank.js's getBankDateString) -- reused directly
  // rather than reimplemented, so this can never silently drift out of sync
  // with what generateDailyBank() actually considers "today".
  const expectedBankDate = getBankDateString();
  const rows = latestBankDate ? bankRowsForDateStatement.all(latestBankDate) : [];

  res.status(200).json(buildDailyBankStatusResponse(latestBankDate, expectedBankDate, rows));
});

// --- Admin messages (send to one device or broadcast to all) ---

const insertMessageStatement = db.prepare(`
  INSERT INTO admin_messages (target_device_id, text, style_id)
  VALUES (?, ?, ?)
`);
const listMessagesStatement = db.prepare(`
  SELECT m.id, m.target_device_id, m.text, m.style_id, m.is_active, m.created_at,
         (SELECT COUNT(*) FROM admin_message_deliveries d WHERE d.message_id = m.id) AS delivered_count
  FROM admin_messages m
  ORDER BY m.created_at DESC
  LIMIT 100
`);
const deactivateMessageStatement = db.prepare(
  'UPDATE admin_messages SET is_active = 0 WHERE id = ?'
);

router.get('/api/messages', requireAdminAuth, (req, res) => {
  res.status(200).json({ messages: listMessagesStatement.all() });
});

router.post('/api/messages', requireAdminAuth, (req, res) => {
  const { target_device_id, text, style_id } = req.body || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (!STYLE_IDS.includes(style_id)) {
    return res.status(400).json({ error: `style_id must be one of: ${STYLE_IDS.join(', ')}` });
  }

  // Empty string / "all" from the dropdown means broadcast — store as NULL.
  const target = target_device_id && target_device_id.trim() ? target_device_id.trim() : null;

  const result = insertMessageStatement.run(target, text.trim(), style_id);
  res.status(200).json({ ok: true, id: result.lastInsertRowid });
});

router.post('/api/messages/:id/deactivate', requireAdminAuth, (req, res) => {
  deactivateMessageStatement.run(req.params.id);
  res.status(200).json({ ok: true });
});

// router is an Express Router instance (a function), so it can still carry a
// _test property the same way every other module here exposes pure logic
// for direct unit testing -- app.use('/admin', require('./routes/admin'))
// is unaffected, this is purely additive.
router._test = { buildDailyBankStatusResponse };

module.exports = router;
