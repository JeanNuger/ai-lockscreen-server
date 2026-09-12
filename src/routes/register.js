const express = require('express');
const db = require('../db');

const router = express.Router();

const upsertStatement = db.prepare(`
  INSERT INTO devices (device_id, name, gender, birth_date, interests, personal_goal, tone, timezone, updated_at)
  VALUES (@device_id, @name, @gender, @birth_date, @interests, @personal_goal, @tone, @timezone, datetime('now'))
  ON CONFLICT(device_id) DO UPDATE SET
    name = excluded.name,
    gender = excluded.gender,
    birth_date = excluded.birth_date,
    interests = excluded.interests,
    personal_goal = excluded.personal_goal,
    tone = excluded.tone,
    timezone = excluded.timezone,
    updated_at = datetime('now')
`);

// POST /api/v1/register
// body: { device_id, name?, gender?, birth_date?, interests?: string[], personal_goal?, tone?, timezone? }
// Stores/updates the survey answers for a device. No auth beyond the device_id
// itself — see PRODUCT_REBUILD_PLAN.md §3 ("В MVP не входит: сложные аккаунты").
router.post('/register', (req, res, next) => {
  try {
    const { device_id, name, gender, birth_date, interests, personal_goal, tone, timezone } = req.body || {};

    if (!device_id || typeof device_id !== 'string') {
      return res.status(400).json({ error: 'device_id is required' });
    }

    upsertStatement.run({
      device_id,
      // name || null: same "falsy in, NULL stored" normalization every other
      // optional field here already gets — an empty string from the client
      // (e.g. IdentificationActivity's name field left blank) is stored as
      // NULL, not as an empty-string row value, matching gender/personal_goal/
      // tone's existing behavior exactly.
      name: name || null,
      gender: gender || null,
      birth_date: birth_date || null,
      interests: Array.isArray(interests) ? JSON.stringify(interests) : null,
      personal_goal: personal_goal || null,
      tone: tone || null,
      timezone: timezone || null,
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
