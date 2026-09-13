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

const selectBankRowsForDateStatement = db.prepare(`
  SELECT category, content_text FROM daily_content_bank WHERE bank_date = ?
`);

const selectShownCategoriesStatement = db.prepare(`
  SELECT category FROM device_shown_categories WHERE device_id = ? AND shown_date = ?
`);

const insertShownCategoryStatement = db.prepare(`
  INSERT OR IGNORE INTO device_shown_categories (device_id, shown_date, category)
  VALUES (?, ?, ?)
`);

const DEFAULT_SELECTION_COUNT = 5;

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

// Random-but-varied-by-category selection for one device's batch context.
// bankDate is the server's UTC calendar date the bank was generated under
// (see getUtcDateString above); deviceLocalDate is that same device's own
// local calendar date (the caller already computes this from device.timezone
// for other purposes -- see contentGenerator.js's getLocalCalendarDate) and
// is what device_shown_categories is keyed by, since "today" for repeat-
// avoidance purposes should match the device's own day boundary, not the
// server's UTC one.
//
// Picks at most one item per category so the count items offered are spread
// across topics rather than, say, 4 quotes and 1 fact. If every category in
// today's bank has already been shown to this device today, falls back to
// treating the whole bank as available again rather than returning nothing
// -- an empty selection would silently strip bank content from every
// remaining batch that day once categories cycle out, which is worse than
// occasionally repeating a category within the same day.
function selectBankItemsForDevice(deviceId, bankDate, deviceLocalDate, count = DEFAULT_SELECTION_COUNT) {
  if (!bankDate || !deviceLocalDate) {
    return [];
  }

  const bankRows = selectBankRowsForDateStatement.all(bankDate);
  if (bankRows.length === 0) {
    return [];
  }

  const shownCategories = new Set(
    selectShownCategoriesStatement.all(deviceId, deviceLocalDate).map((row) => row.category)
  );
  const unseen = bankRows.filter((row) => !shownCategories.has(row.category));
  const pool = unseen.length > 0 ? unseen : bankRows;

  const byCategory = new Map();
  for (const row of pool) {
    if (!byCategory.has(row.category)) {
      byCategory.set(row.category, []);
    }
    byCategory.get(row.category).push(row);
  }

  const shuffledCategories = [...byCategory.keys()].sort(() => Math.random() - 0.5);
  const selected = [];
  for (const category of shuffledCategories) {
    if (selected.length >= count) {
      break;
    }
    const rowsInCategory = byCategory.get(category);
    const pick = rowsInCategory[Math.floor(Math.random() * rowsInCategory.length)];
    selected.push({ category: pick.category, content_text: pick.content_text });
  }

  return selected;
}

// Records which bank categories a device's batch actually drew from, keyed
// by the device's own local calendar date (see selectBankItemsForDevice for
// why local date, not server UTC date). INSERT OR IGNORE against the
// (device_id, shown_date, category) primary key makes this safe to call
// once per successful batch without needing to check for existing rows first.
function recordShownCategories(deviceId, deviceLocalDate, categories) {
  if (!deviceId || !deviceLocalDate || !Array.isArray(categories) || categories.length === 0) {
    return;
  }
  const uniqueCategories = [...new Set(categories)];
  const insertMany = db.transaction((cats) => {
    for (const category of cats) {
      insertShownCategoryStatement.run(deviceId, deviceLocalDate, category);
    }
  });
  insertMany(uniqueCategories);
}

module.exports = {
  generateDailyBank,
  selectBankItemsForDevice,
  recordShownCategories,
  getUtcDateString,
  BANK_CATEGORIES,
};
