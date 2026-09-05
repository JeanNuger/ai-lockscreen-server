const express = require('express');
const db = require('../db');

const router = express.Router();

const upsertStatement = db.prepare(`
  INSERT INTO devices (device_id, gender, birth_date, interests, personal_goal, tone, timezone, updated_at)
  VALUES (@device_id, @gender, @birth_date, @interests, @personal_goal, @tone, @timezone, datetime('now'))
  ON CONFLICT(device_id) DO UPDATE SET
    gender = excluded.gender,
    birth_date = excluded.birth_date,
    interests = excluded.interests,
    personal_goal = excluded.personal_goal,
    tone = excluded.tone,
    timezone = excluded.timezone,
    updated_at = datetime('now')
`);

// POST /api/v1/register
// body: { device_id, gender?, birth_date?, interests?: string[], personal_goal?, tone?, timezone? }
// Stores/updates the survey answers for a device. No auth beyond the device_id
// itself — see PRODUCT_REBUILD_PLAN.md §3 ("В MVP не входит: сложные аккаунты").
router.post('/register', (req, res, next) => {
  try {
    const { device_id, gender, birth_date, interests, personal_goal, tone, timezone } = req.body || {};

    if (!device_id || typeof device_id !== 'string') {
      return res.status(400).json({ error: 'device_id is required' });
    }

    upsertStatement.run({
      device_id,
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
