const express = require('express');

// TEMPORARY diagnostic route — added to test whether the OpenAI Responses API
// web_search tool works with this project's existing OPENAI_API_KEY and
// what response.usage looks like for pricing purposes. Remove this whole
// file and its require() in server.js once the test is done; not meant to
// stay in production.
//
// Guarded by a shared secret (INTERNAL_TEST_SECRET env var) rather than the
// admin session, since this is meant to be one URL the owner can open
// directly in a browser. A wrong/missing secret returns 404, not 401/403 —
// deliberately indistinguishable from a route that doesn't exist, so a
// probing request can't even confirm this endpoint is here.
const router = express.Router();

const TEST_PROMPT = 'What are today\'s notable holidays, one "on this day" historical fact, and one interesting psychology fact? Keep it brief, list format.';

router.get('/internal/test-websearch', async (req, res) => {
  const expected = process.env.INTERNAL_TEST_SECRET;
  const provided = req.query.secret;
  if (!expected || !provided || provided !== expected) {
    return res.status(404).send('Not found');
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(200).type('text/plain').send('OPENAI_API_KEY is not configured on this server.');
  }

  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey });

  async function tryModel(model) {
    const response = await client.responses.create({
      model,
      tools: [{ type: 'web_search' }],
      input: TEST_PROMPT,
    });
    return response;
  }

  const lines = [];
  let response;
  let usedModel = 'gpt-4o-search-preview';
  try {
    response = await tryModel(usedModel);
  } catch (err) {
    lines.push(`gpt-4o-search-preview failed: ${err.status || ''} ${err.message}`);
    if (err.error) {
      lines.push(`details: ${JSON.stringify(err.error)}`);
    }
    usedModel = 'gpt-4o';
    try {
      response = await tryModel(usedModel);
    } catch (err2) {
      lines.push(`gpt-4o also failed: ${err2.status || ''} ${err2.message}`);
      if (err2.error) {
        lines.push(`details: ${JSON.stringify(err2.error)}`);
      }
      return res.status(200).type('text/plain').send(lines.join('\n'));
    }
  }

  lines.push(`model used: ${usedModel}`);
  lines.push('');
  lines.push('--- output_text ---');
  lines.push(response.output_text || '(empty)');
  lines.push('');
  lines.push('--- usage (full) ---');
  lines.push(JSON.stringify(response.usage, null, 2));

  res.status(200).type('text/plain').send(lines.join('\n'));
});

module.exports = router;
