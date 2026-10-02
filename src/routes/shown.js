const express = require('express');
const db = require('../db');

const router = express.Router();

const MAX_ENTRIES_PER_REQUEST = 300;
const MAX_TEXT_LENGTH = 500;

// content_batches / shown_phrases have a FOREIGN KEY into devices, so a report
// from a device the server has not seen yet gets a stub row (same as /batch).
const insertStubDeviceStatement = db.prepare(
  'INSERT OR IGNORE INTO devices (device_id) VALUES (?)'
);

// The same phone re-sending an entry (after a failed or lost response) hits
// UNIQUE(device_id, text, shown_at) and is ignored.
const insertShownStatement = db.prepare(`
  INSERT OR IGNORE INTO shown_phrases (device_id, text, shown_at, local_date)
  VALUES (?, ?, ?, ?)
`);

// shown_at may be epoch milliseconds or an ISO-8601 string; stored as UTC ISO.
function normalizeShownAt(value) {
  let date = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    date = new Date(value);
  } else if (typeof value === 'string' && value.trim()) {
    date = new Date(value.trim());
  }
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const text = typeof entry.text === 'string' ? entry.text.trim() : '';
  const shownAt = normalizeShownAt(entry.shown_at);
  const localDate = typeof entry.local_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.local_date)
    ? entry.local_date
    : null;
  if (!text || text.length > MAX_TEXT_LENGTH || !shownAt) {
    return null;
  }
  return { text, shown_at: shownAt, local_date: localDate };
}

// POST /api/v1/shown
// body: { device_id, shown: [{ text, shown_at, local_date }] }  (at most 300 entries)
// The phone reports the phrases it really showed on a lit screen. Stored in
// shown_phrases; used for the "already_seen" prompt block and to decide whether
// the night word recall may remind today's morning word (see seenMemory.js,
// learningMemory.js). Invalid entries are skipped, not fatal.
router.post('/shown', (req, res, next) => {
  try {
    const { device_id, shown } = req.body || {};
    if (!device_id || typeof device_id !== 'string') {
      return res.status(400).json({ error: 'device_id is required' });
    }
    if (!Array.isArray(shown)) {
      return res.status(400).json({ error: 'shown must be an array' });
    }
    if (shown.length > MAX_ENTRIES_PER_REQUEST) {
      return res.status(400).json({ error: `at most ${MAX_ENTRIES_PER_REQUEST} entries per request` });
    }

    const entries = shown.map(normalizeEntry).filter(Boolean);
    let saved = 0;
    const saveAll = db.transaction(() => {
      insertStubDeviceStatement.run(device_id);
      for (const entry of entries) {
        saved += insertShownStatement.run(device_id, entry.text, entry.shown_at, entry.local_date).changes;
      }
    });
    saveAll();

    res.status(200).json({ ok: true, saved, received: shown.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports._test = { normalizeEntry, normalizeShownAt, MAX_ENTRIES_PER_REQUEST };
