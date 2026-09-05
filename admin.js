const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('../db');
const { requireAdminAuth } = require('../adminAuth');
const { STYLE_IDS } = require('../constants');

const router = express.Router();

// --- Login / logout ---

router.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'admin', 'login.html'));
});

router.post('/login', (req, res) => {
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

module.exports = router;
