const express = require('express');
const { generateDailyBank } = require('../dailyContentBank');

// Cron-triggered endpoint: generates today's shared daily_content_bank rows
// (see src/dailyContentBank.js). Meant to be hit once per day (e.g. ~04:45,
// ahead of the first 05:00 batch window) by an external scheduler (Render
// Cron Job or similar) that can pass a secret query param -- same
// secret-gated / 404-on-mismatch pattern as the earlier internal test route,
// but with its own dedicated secret (INTERNAL_CRON_SECRET) rather than reusing
// INTERNAL_TEST_SECRET, since this one is meant to be long-lived, not
// deleted after a single manual test.
//
// POST rather than GET: this triggers a side effect (OpenAI call + DB writes)
// each time it's hit, which fits POST semantics better than a GET that's
// supposed to be safe/idempotent to fetch -- also makes it harder to trigger
// by accident (a stray browser prefetch, a link scanner, etc.).
const router = express.Router();

router.post('/internal/generate-daily-bank', async (req, res) => {
  const expected = process.env.INTERNAL_CRON_SECRET;
  const provided = req.query.secret;
  if (!expected || !provided || provided !== expected) {
    return res.status(404).send('Not found');
  }

  const { savedCount, error } = await generateDailyBank();

  res.status(200).json({ savedCount, error });
});

module.exports = router;
