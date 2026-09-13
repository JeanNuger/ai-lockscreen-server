const db = require('./db');

// Fixed category set for daily_content_bank rows. Step 2 (personalization,
// not this task) will filter/select by these when building a device's batch,
// so the set is small and stable rather than whatever labels the model feels
// like inventing per call.
const BANK_CATEGORIES = [
  'holiday',
  'fact',
  'quote',
  'on_this_day',
  'psychology',
  'advice',
  'humor',
  'idiom',
];

// How many bank items to ask the model for. Not a hard contract with the
// model -- generateDailyBank() below accepts whatever valid array it gets
// back, even if shorter or longer than this.
const TARGET_BANK_SIZE = 35;

const insertBankItemStatement = db.prepare(`
  INSERT INTO daily_content_bank (bank_date, category, content_text, tags)
  VALUES (?, ?, ?, ?)
`);

// Server's own UTC calendar date -- this bank is shared across every device
// (not personalized, see module header), so there's no single device
// timezone to anchor it to; each /batch request's own per-device local
// time-of-day window still applies at the personalization step (step 2).
function getUtcDateString(instant = new Date()) {
  return instant.toISOString().slice(0, 10);
}

function buildBankPrompt() {
  return `Search the web for what's notable about today's date and put together a varied "content bank" for a phone lock screen app.
Return STRICTLY a JSON array (no wrapper object, no explanations) of ${TARGET_BANK_SIZE} objects.
Each object: {"category": one of [${BANK_CATEGORIES.join(', ')}], "content_text": "a short, self-contained piece of content in English, up to 200 characters", "tags": ["lowercase", "keyword", "tags"]}.
Cover a genuine mix across ALL the listed categories, not just one or two -- include: any real holidays/observances for today's date, "on this day in history" facts, notable quotes, a psychology fact or insight, a practical piece of advice, something genuinely humorous, and an interesting idiom with its meaning.
Prioritize accuracy from web search for date-specific items (holiday, on_this_day) -- do not invent fake historical events or holidays.
Keep every content_text glanceable and self-contained (no "as mentioned above", no follow-up questions).
Respond with the JSON array only, nothing else.`;
}

function parseBankItems(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    // The model sometimes wraps the array in a JSON object or fences despite
    // instructions -- try to salvage a top-level array substring before
    // giving up, rather than failing on the first formatting slip.
    const match = rawText && rawText.match(/\[[\s\S]*\]/);
    if (!match) {
      throw err;
    }
    parsed = JSON.parse(match[0]);
  }

  const array = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : null;
  if (!array) {
    throw new Error('response did not contain a JSON array of bank items');
  }

  return array
    .filter((item) => item && typeof item.content_text === 'string' && item.content_text.trim().length > 0)
    .map((item) => ({
      category: BANK_CATEGORIES.includes(item.category) ? item.category : 'fact',
      content_text: item.content_text.trim(),
      tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string') : [],
    }));
}

/**
 * Generates today's shared content bank via a web-search-enabled OpenAI call
 * and persists each item as its own daily_content_bank row under today's UTC
 * date. Never throws -- a failed or malformed call is logged and leaves the
 * bank empty/partial for today rather than crashing the caller (the cron
 * endpoint that calls this, see src/routes/internalGenerateBank.js).
 *
 * @returns {Promise<{ savedCount: number, error: string|null }>}
 */
async function generateDailyBank() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { savedCount: 0, error: 'OPENAI_API_KEY is not configured' };
  }

  const bankDate = getUtcDateString();

  try {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey });

    // gpt-4o, not gpt-4o-search-preview -- confirmed by the earlier manual
    // test that the Responses API's web_search tool works with gpt-4o but
    // gpt-4o-search-preview is not a valid Responses API model.
    const response = await client.responses.create({
      model: 'gpt-4o',
      tools: [{ type: 'web_search' }],
      input: buildBankPrompt(),
    });

    const items = parseBankItems(response.output_text);
    if (items.length === 0) {
      return { savedCount: 0, error: 'model returned zero usable bank items' };
    }

    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        insertBankItemStatement.run(bankDate, row.category, row.content_text, JSON.stringify(row.tags));
      }
    });
    insertMany(items);

    return { savedCount: items.length, error: null };
  } catch (err) {
    console.error('generateDailyBank failed:', err.message);
    return { savedCount: 0, error: err.message };
  }
}

module.exports = { generateDailyBank, BANK_CATEGORIES };
