const db = require('./db');
const EVERGREEN_CONTENT_BANK = require('./evergreenContentBank');

// Fixed category set for daily_content_bank rows. Step 2 (personalization,
// not this task) will filter/select by these when building a device's batch,
// so the set is small and stable rather than whatever labels the model feels
// like inventing per call. As of Phase 5, the category IS the semantic
// classifier SlotPlanner maps directly off of (see mapBankItemType) -- the
// model, not server-side keyword/regex inference, owns this classification.
const BANK_CATEGORIES = [
  'holiday',
  'on_this_day',
  'humor',
  'idiom',
  'statistic',
  'quote',
  'science',
  'technology',
  'economics',
  'fact',
  'country_fact',
  'good_news',
];

// Bank categories that are NOT tied to a specific calendar date, so a static
// evergreen catalog item is an acceptable substitute when today's live bank
// has none. holiday/on_this_day are deliberately excluded -- they require
// date-verified web-search accuracy (see buildBankPrompt) that no static
// catalog entry could honestly claim; if today's bank lacks them, the
// product prefers omitting them over risking a stale/wrong date claim.
// good_news is excluded for the same reason: it is a claim about a recent,
// current development, and a static catalog entry could only ever present
// old news as if it were new -- omitting it on a day the live bank has none
// is correct, not a gap to paper over. country_fact IS included: it is not
// date-sensitive, only country-sensitive, so a static entry is honest as
// long as it is genuinely tagged with a real country -- no fabricated
// country_fact entries are added to the seed catalog just to fill this
// category (see evergreenContentBank.js); if none exist for a given
// country, selectBankItemsForDevice simply has nothing to offer there.
const EVERGREEN_COMPATIBLE_CATEGORIES = new Set([
  'humor',
  'idiom',
  'statistic',
  'quote',
  'science',
  'technology',
  'economics',
  'fact',
  'country_fact',
]);

// How many bank items to ask the model for. Not a hard contract with the
// model -- generateDailyBank() below accepts whatever valid array it gets
// back, even if shorter or longer than this.
const TARGET_BANK_SIZE = 35;
const BANK_TIMEZONE = 'Asia/Almaty';

const insertBankItemStatement = db.prepare(`
  INSERT INTO daily_content_bank (bank_date, category, content_text, tags)
  VALUES (?, ?, ?, ?)
`);

const selectBankRowsForDateStatement = db.prepare(`
  SELECT id, category, content_text, tags FROM daily_content_bank WHERE bank_date = ?
`);

const selectShownCategoriesStatement = db.prepare(`
  SELECT category FROM device_shown_categories WHERE device_id = ? AND shown_date = ?
`);

const insertShownCategoryStatement = db.prepare(`
  INSERT OR IGNORE INTO device_shown_categories (device_id, shown_date, category)
  VALUES (?, ?, ?)
`);

const DEFAULT_SELECTION_COUNT = 5;

// Shared product-day date for the global bank. This is deliberately one fixed
// timezone, not per-user, so the app still generates one reusable bank per day.
function getBankDateString(instant = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: BANK_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(instant);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function buildBankPrompt(bankDate) {
  return `Search the web for what's notable about ${bankDate} and put together a varied global "content bank" for a phone lock screen app.
Return STRICTLY a JSON array (no wrapper object, no explanations) of ${TARGET_BANK_SIZE} objects.
Each object: {"category": one of [${BANK_CATEGORIES.join(', ')}], "content_text": "a short, self-contained piece of content in English, up to 200 characters", "tags": ["lowercase", "keyword", "tags"]}.
Cover a genuine mix across ALL the listed categories, not just one or two -- include: real holidays/observances for ${bankDate}, "on this day in history" facts, notable quotes, interesting statistics, an interesting idiom or expression with its meaning, a fact about one specific country, a genuinely positive and recent news development, and light humor only if it localizes cleanly.
Choose "category" precisely -- it is used directly to decide what this item is, not just a label: "science" is for a science fact (physics, biology, space, chemistry, etc.); "technology" is for a technology/computing fact; "economics" is for a money/economics fact; "fact" is only for a genuinely miscellaneous interesting fact that does not belong in science, technology, or economics; "country_fact" is a fact specifically about ONE particular country (not a generic global fact), and must always carry that country's ISO code in tags; "good_news" is a genuinely positive, real, verifiable development from roughly the last few days -- never invented, never old news presented as new. Do not put a science/technology/economics fact under "fact".
Keep the bank international and reusable for users in many countries: do not make it US-centric or Russia-centric.
Prioritize accuracy from web search for date-specific items (holiday, on_this_day, good_news) -- holiday/on_this_day must match ${bankDate}; good_news must be a real, recent, verifiable development; do not invent fake historical events, holidays, or news.
Keep every content_text glanceable and self-contained (no "as mentioned above", no follow-up questions).
For global/international items, add "global" to tags. For country-specific items -- including every "country_fact" item, which must always have one -- add the ISO country code tag such as "KZ", "FR", or "JP". Avoid country-specific politics.
Do not generate self-help, motivational coaching, psychology tips, productivity advice, or generic wishes.
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
 * and persists each item as its own daily_content_bank row under today's
 * Asia/Almaty product-day date. Never throws -- a failed or malformed call is logged and leaves the
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

  const bankDate = getBankDateString();

  try {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey });

    // gpt-4o, not gpt-4o-search-preview -- confirmed by the earlier manual
    // test that the Responses API's web_search tool works with gpt-4o but
    // gpt-4o-search-preview is not a valid Responses API model.
    const response = await client.responses.create({
      model: 'gpt-4o',
      tools: [{ type: 'web_search' }],
      input: buildBankPrompt(bankDate),
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

// Accepts both a JSON-encoded tags string (live daily_content_bank rows, as
// stored in SQLite) and a plain array (the static evergreen catalog, which
// is authored as ordinary JS, not round-tripped through SQLite/JSON).
function parseTags(rawTags) {
  if (!rawTags) {
    return [];
  }
  if (Array.isArray(rawTags)) {
    return rawTags;
  }
  try {
    const parsed = JSON.parse(rawTags);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function normalizeCountryCode(countryCode) {
  return typeof countryCode === 'string' && /^[A-Za-z]{2}$/.test(countryCode)
    ? countryCode.toUpperCase()
    : null;
}

function countryTagsFromBankItem(row) {
  return new Set(
    parseTags(row.tags)
      .map((tag) => tag.trim())
      .filter((tag) => /^[A-Z]{2}$/.test(tag) && tag !== 'UN')
  );
}

function isBankItemAllowedForCountry(row, countryCode) {
  if (!BANK_CATEGORIES.includes(row.category)) {
    return false;
  }
  const targetCountry = normalizeCountryCode(countryCode);
  const itemCountries = countryTagsFromBankItem(row);
  if (itemCountries.size === 0) {
    return true;
  }
  return targetCountry ? itemCountries.has(targetCountry) : false;
}

// Static fallback for evergreen-compatible categories that have zero live
// rows in today's bank -- covers both a genuinely missing category and a
// total generateDailyBank() failure (every category ends up "missing" that
// day) without any additional OpenAI call. Never touches holiday/on_this_day
// (excluded from EVERGREEN_COMPATIBLE_CATEGORIES) and never returns an item
// for a category that already has live content today, so live rows always
// take priority. Shares isBankItemAllowedForCountry with live rows so the
// same country-tag rules apply to evergreen items.
function getEvergreenBackfillRows(liveCategoriesToday, countryCode) {
  return EVERGREEN_CONTENT_BANK
    .filter((item) => EVERGREEN_COMPATIBLE_CATEGORIES.has(item.category))
    .filter((item) => !liveCategoriesToday.has(item.category))
    .filter((item) => isBankItemAllowedForCountry(item, countryCode));
}

// Random-but-varied-by-category selection for one device's batch context.
// bankDate is the shared Asia/Almaty product-day date the bank was generated under
// (see getBankDateString above); deviceLocalDate is that same device's own
// local calendar date (the caller already computes this from device.timezone
// for other purposes -- see contentGenerator.js's getLocalCalendarDate) and
// is what device_shown_categories is keyed by, since "today" for repeat-
// avoidance purposes should match the device's own day boundary, not the
// server's UTC one. deviceGender is currently unused (kept only for call-site
// signature stability -- see HANDOFF_2 Phase 5 audit: the gender-tagged
// 'advice' preference this parameter used to drive was removed along with
// the 'advice' category itself; gender personalization now lives entirely in
// the separate gender_context profile signal, not in bank selection).
//
// Picks at most one item per category so the count items offered are spread
// across topics rather than, say, 4 quotes and 1 fact. If every category in
// today's bank has already been shown to this device today, falls back to
// treating the whole bank as available again rather than returning nothing
// -- an empty selection would silently strip bank content from every
// remaining batch that day once categories cycle out, which is worse than
// occasionally repeating a category within the same day.
//
// Live rows always take priority: the evergreen catalog only ever backfills
// an evergreen-compatible category (see EVERGREEN_COMPATIBLE_CATEGORIES)
// that has ZERO live rows for bankDate -- it never supplements or replaces a
// category that already has live content, and it never applies to
// holiday/on_this_day. This is also what makes a total generateDailyBank()
// failure degrade gracefully: every evergreen-compatible category is
// "missing" that day, so evergreen naturally backstops all of them, while
// holiday/on_this_day are simply omitted rather than guessed at.
function selectBankItemsForDevice(
  deviceId,
  bankDate,
  deviceLocalDate,
  deviceGender,
  countryCode,
  count = DEFAULT_SELECTION_COUNT
) {
  if (typeof countryCode === 'number' && count === DEFAULT_SELECTION_COUNT) {
    count = countryCode;
    countryCode = null;
  }
  if (!bankDate || !deviceLocalDate) {
    return [];
  }

  const liveBankRows = selectBankRowsForDateStatement
    .all(bankDate)
    .filter((row) => isBankItemAllowedForCountry(row, countryCode));
  const liveCategoriesToday = new Set(liveBankRows.map((row) => row.category));
  const backfillRows = getEvergreenBackfillRows(liveCategoriesToday, countryCode);
  const bankRows = liveBankRows.concat(backfillRows);
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
    selected.push({ id: pick.id, category: pick.category, content_text: pick.content_text });
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

// Returns the list of category names already shown to this device today
// (device_shown_categories for deviceId/deviceLocalDate) -- used by
// contentGenerator.js to tell the model which categories/topics to avoid
// repeating, separately from selectBankItemsForDevice's own (silent) use of
// the same table to filter which bank rows it offers.
function getShownCategories(deviceId, deviceLocalDate) {
  if (!deviceId || !deviceLocalDate) {
    return [];
  }
  return selectShownCategoriesStatement.all(deviceId, deviceLocalDate).map((row) => row.category);
}

module.exports = {
  generateDailyBank,
  getShownCategories,
  selectBankItemsForDevice,
  recordShownCategories,
  getBankDateString,
  BANK_CATEGORIES,
  EVERGREEN_COMPATIBLE_CATEGORIES,
  _test: {
    countryTagsFromBankItem,
    isBankItemAllowedForCountry,
    normalizeCountryCode,
    getEvergreenBackfillRows,
    EVERGREEN_CONTENT_BANK,
  },
};
