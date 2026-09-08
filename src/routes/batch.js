const express = require('express');
const db = require('../db');
const { WINDOWS } = require('../constants');
const { generateBatch } = require('../contentGenerator');
const { consumePendingMessages } = require('../adminMessages');
const { parseDeviceSignals } = require('../deviceSignals');

const router = express.Router();

const getDeviceStatement = db.prepare('SELECT * FROM devices WHERE device_id = ?');
// Minimal stub row for devices that call /batch before ever calling /register —
// content_batches.device_id has a FOREIGN KEY into devices, so a batch can't be
// logged for a device that doesn't exist yet. INSERT OR IGNORE keeps this a
// no-op for already-registered devices instead of overwriting their survey answers.
const insertStubDeviceStatement = db.prepare(
  'INSERT OR IGNORE INTO devices (device_id) VALUES (?)'
);
const insertBatchStatement = db.prepare(`
  INSERT INTO content_batches (device_id, window, phrases, source, context)
  VALUES (?, ?, ?, ?, ?)
`);

// GET /api/v1/batch?device_id=...&window=morning|day|evening|night
// Optional device-signal params (see src/deviceSignals.js): battery_level,
// ambient_light, screen_on_duration_seconds, steps_since_last_batch — all
// independently optional, malformed values are ignored rather than
// rejecting the request (see deviceSignals.js for why).
// Returns { phrases: [{ text, style_id }, ...] } — see PRODUCT_REBUILD_PLAN.md §4.1.
// No geodata is accepted or used, by design (§4.1 "без геоданных").
//
// Any pending admin messages (targeted at this device, or broadcast to all
// devices) are appended to the normal AI/fallback batch, not substituted for
// it — per product decision, an admin message is one extra phrase mixed into
// the regular rotation, not a takeover of the whole batch.
router.get('/batch', async (req, res, next) => {
  try {
    const { device_id, window } = req.query;

    if (!device_id || typeof device_id !== 'string') {
      return res.status(400).json({ error: 'device_id is required' });
    }
    if (!WINDOWS.includes(window)) {
      return res.status(400).json({ error: `window must be one of: ${WINDOWS.join(', ')}` });
    }

    const signals = parseDeviceSignals(req.query);

    const device = getDeviceStatement.get(device_id) || { device_id };
    insertStubDeviceStatement.run(device_id);

    const { phrases, source, context } = await generateBatch(device, window, signals);
    const adminPhrases = consumePendingMessages(device_id);
    const combinedPhrases = [...phrases, ...adminPhrases];

    insertBatchStatement.run(
      device_id,
      window,
      JSON.stringify(combinedPhrases),
      source,
      context || null
    );

    res.status(200).json({ phrases: combinedPhrases });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
