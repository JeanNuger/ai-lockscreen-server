const db = require('./db');
const { countryForTimezone } = require('./timezoneCountry');
const { loadShownFacts, isFactShown } = require('./sentPhrases');

// Fixed category set for daily_content_bank rows. Step 2 (personalization,
// not this task) will filter/select by these when building a device's batch,
// so the set is small and stable rather than whatever labels the model feels
// like inventing per call. The bank holds ONLY topics tied to a date or to
// current events (holiday, on_this_day, born_today, good_news); every
// evergreen topic (humor, science, technology, statistics, quotes, country
// facts, economics, words) is written by the model itself in the batch call,
// which is told what the device has already seen (see seenMemory.js).
const BANK_CATEGORIES = [
  'holiday',
  'on_this_day',
  'born_today',
  'good_news',
];

// How many bank items to ask the model for. Not a hard contract with the
// model -- generateDailyBank() below accepts whatever valid array it gets
// back, even if shorter or longer than this. Raised 35 -> 50 (fixed-order
// rebuild step 2): the "holiday" ask now covers up to 20 countries across 3
// prepared dates instead of one shared item per date, so the old 35 target
// undersold how much real content this one call is now expected to return.
const TARGET_BANK_SIZE = 50;
const BANK_TIMEZONE = 'Asia/Almaty';
const DATE_SENSITIVE_CATEGORIES = new Set(['holiday', 'on_this_day', 'born_today']);

const insertBankItemStatement = db.prepare(`
  INSERT INTO daily_content_bank (bank_date, category, content_text, tags)
  VALUES (?, ?, ?, ?)
`);

const deleteBankItemsForDateStatement = db.prepare(`
  DELETE FROM daily_content_bank WHERE bank_date = ?
`);

// Kept in sync with DATE_SENSITIVE_CATEGORIES by hand (SQL IN can't
// reference a JS Set) -- born_today added, fixed-order rebuild step 3.
const selectDateSensitiveBankDatesStatement = db.prepare(`
  SELECT DISTINCT bank_date FROM daily_content_bank
  WHERE category IN ('holiday', 'on_this_day', 'born_today')
  ORDER BY bank_date ASC
`);

// Atomically replaces every daily_content_bank row for bankDate with a
// freshly generated, already-parsed/validated set. Only ever called once a
// complete valid `rows` array exists -- generateDailyBank() never calls this
// until after a successful OpenAI response has been parsed, so a failed
// request, a malformed response, or a parse/validation failure never reaches
// here and the existing bank for that date is left completely untouched.
// The delete+insert pair runs inside one better-sqlite3 transaction (a
// single SQLite transaction under the hood): if anything inside throws,
// SQLite rolls back the whole thing, so a same-day rerun either fully
// replaces today's bank or leaves the previous one intact -- never a partial
// state, and never an append/duplicate (see HANDOFF_2 idempotency fix).
const replaceBankItemsForDate = db.transaction((bankDate, rows) => {
  deleteBankItemsForDateStatement.run(bankDate);
  for (const row of rows) {
    insertBankItemStatement.run(bankDate, row.category, row.content_text, JSON.stringify(row.tags));
  }
});

const replaceBankItemsForDates = db.transaction((bankDates, rows) => {
  for (const bankDate of bankDates) {
    deleteBankItemsForDateStatement.run(bankDate);
  }
  for (const row of rows) {
    insertBankItemStatement.run(row.bank_date, row.category, row.content_text, JSON.stringify(row.tags));
  }
});

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
// born_today added (fixed-order rebuild, step 3): without a guaranteed pick,
// it would only be offered some of the time (selectBankItemsForDevice's
// shuffled, count-limited non-guaranteed round below), which would make
// evening's born_today position fall back to spare_fact far more often than
// "the bank genuinely has no one born today" alone would justify.
const GUARANTEED_SELECTION_CATEGORIES = ['holiday', 'on_this_day', 'born_today'];

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

function addDaysToDateString(date, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function getPreparedBankDates(bankDate = getBankDateString()) {
  return [
    addDaysToDateString(bankDate, -1),
    bankDate,
    addDaysToDateString(bankDate, 1),
  ].filter(Boolean);
}

// Countries this task's holiday coverage always asks for, regardless of
// device data -- the app's core Central Asian/CIS market (owner-specified
// list). Included even on a day with zero registered devices at all, so the
// bank's holiday coverage never degrades to nothing for these countries
// just because the `devices` table is empty/thin.
const ALWAYS_INCLUDED_HOLIDAY_COUNTRIES = ['KZ', 'RU', 'UZ', 'KG', 'BY', 'UA', 'AZ', 'AM', 'GE', 'TJ', 'TM', 'MD'];
// Hard cap on how many countries go into ONE bank-generation request --
// keeps the prompt (and the model's web-search fan-out) bounded regardless
// of how many distinct countries the device base ever grows to. The 12
// ALWAYS_INCLUDED_HOLIDAY_COUNTRIES count against this same cap, so at most
// (20 - 12) = 8 additional device-derived countries are ever added.
const MAX_HOLIDAY_COUNTRIES = 20;

const selectDeviceLocationsStatement = db.prepare(`
  SELECT timezone, city_country_code FROM devices
`);

// Same two-step resolution routes/batch.js already uses for weather/country
// (PRODUCT_REBUILD_PLAN.md: a device's own picked city outranks IP/timezone):
// city_country_code (set at registration when the device picked a city --
// see routes/register.js) first, else countryForTimezone(device.timezone).
// Returns null (not 'unknown') when neither resolves, so callers can filter
// with a plain truthiness check.
function resolveDeviceCountryCode(device) {
  const cityCountry = normalizeCountryCode(device && device.city_country_code);
  if (cityCountry) {
    return cityCountry;
  }
  const timezoneCountry = countryForTimezone(device && device.timezone);
  return timezoneCountry && timezoneCountry !== 'unknown' ? timezoneCountry : null;
}

// Builds the country list buildBankPrompt asks for holiday coverage on:
// ALWAYS_INCLUDED_HOLIDAY_COUNTRIES first, then every OTHER distinct country
// resolved from a real device (see resolveDeviceCountryCode), most-devices-
// first, until MAX_HOLIDAY_COUNTRIES is reached. A device whose country
// can't be resolved at all (no city, unrecognized timezone) contributes
// nothing here -- it isn't an error, there's just no country to ask for.
function collectHolidayCountryCodes() {
  const counts = new Map();
  for (const device of selectDeviceLocationsStatement.all()) {
    const country = resolveDeviceCountryCode(device);
    if (!country) {
      continue;
    }
    counts.set(country, (counts.get(country) || 0) + 1);
  }
  const deviceCountriesByPopularity = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([country]) => country);

  const result = [];
  const seen = new Set();
  for (const country of [...ALWAYS_INCLUDED_HOLIDAY_COUNTRIES, ...deviceCountriesByPopularity]) {
    if (seen.has(country) || result.length >= MAX_HOLIDAY_COUNTRIES) {
      continue;
    }
    result.push(country);
    seen.add(country);
  }
  return result;
}

function buildBankPrompt(bankDate, preparedDates = getPreparedBankDates(bankDate), countryCodes = collectHolidayCountryCodes()) {
  return `Search the web for what's notable around ${bankDate} and put together a varied global "content bank" for a phone lock screen app.
Return STRICTLY a JSON array (no wrapper object, no explanations) of ${TARGET_BANK_SIZE} objects.
Each object: {"bank_date": "YYYY-MM-DD", "category": one of [${BANK_CATEGORIES.join(', ')}], "content_text": "a short, self-contained piece of content in English, up to 200 characters", "tags": ["lowercase", "keyword", "tags"]}.
For date-sensitive categories only ("holiday", "on_this_day", and "born_today"), include real items for EACH of these dates: ${preparedDates.join(', ')}. Set bank_date to the exact date the item belongs to.
For "holiday" specifically: for EACH of these countries, search for that country's own official or widely observed public holidays, national days, or major cultural/religious observances falling on or very near each listed date, and tag every such item with that country's ISO code: ${countryCodes.join(', ')}. If a country genuinely has no such holiday on a given date, skip it there -- never invent one. Also include, for EVERY listed date, at least one genuine international observance day (a UN/UNESCO/WHO day or similarly widely-recognized global observance falling on that date), tagged "global". Only real, search-verified holidays and observances, never commercial/marketing "days of X" with no real official or cultural standing.
Include at least one on_this_day item for every listed date.
For "born_today": for EACH of these dates, include 1-2 real, well-known people actually born on that date, verified by web search, tag "global". Never invent a person or a birth date.
For "good_news", set bank_date to ${bankDate}; include a few genuinely positive, verifiable developments from roughly the last few days. The bank holds only these four categories.
Keep the bank international and reusable for users in many countries: do not make it US-centric or Russia-centric.
Prioritize accuracy from web search -- holiday/on_this_day/born_today must match their own bank_date; good_news must be a real, recent, verifiable development; do not invent fake historical events, holidays, birth dates, or news.
Keep every content_text glanceable and self-contained (no "as mentioned above", no follow-up questions).
For global/international items, add "global" to tags. For country-specific items add the ISO country code tag such as "KZ", "FR", or "JP". Avoid country-specific politics.
Do not generate self-help, motivational coaching, psychology tips, productivity advice, or generic wishes.
Respond with the JSON array only, nothing else.`;
}

function parseBankItems(rawText, defaultBankDate, preparedDates = [defaultBankDate]) {
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
    .filter((item) => {
      // A category outside BANK_CATEGORIES used to be silently coerced to
      // 'fact' -- that let the model (or anything else writing rows the same
      // shape) invent categories that would never match any bank_category
      // isBankItemAllowedForCountry/selectBankItemsForDevice actually serves,
      // so they sat in the table looking saved while being permanently
      // invisible downstream. Dropping the row outright (with a warning) is
      // the honest behavior: we never silently store content under a
      // category it didn't actually belong to.
      if (BANK_CATEGORIES.includes(item.category)) {
        return true;
      }
      console.warn(`generateDailyBank: dropping bank item with unknown category "${item.category}"`);
      return false;
    })
    .map((item) => {
      const category = item.category;
      const suppliedDate = typeof item.bank_date === 'string' && preparedDates.includes(item.bank_date)
        ? item.bank_date
        : defaultBankDate;
      return {
        bank_date: DATE_SENSITIVE_CATEGORIES.has(category) ? suppliedDate : defaultBankDate,
        category,
        content_text: item.content_text.trim(),
        tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string') : [],
      };
    });
}

// Warns (never throws, never fabricates) when the model's response is
// missing content the product actually depends on: holiday/on_this_day/
// born_today for each prepared date (see buildBankPrompt's own request for
// exactly this). Purely diagnostic:
// generateDailyBank() still saves whatever valid items it has either way;
// selectBankItemsForDevice/slotPlanner already handle a missing category by
// omitting that slot.
function logMissingRequiredCategories(items, bankDate, preparedDates) {
  for (const date of preparedDates) {
    for (const category of DATE_SENSITIVE_CATEGORIES) {
      const present = items.some((item) => item.category === category && item.bank_date === date);
      if (!present) {
        console.warn(`generateDailyBank: missing required category "${category}" for ${date}`);
      }
    }
  }
}

// Human-readable confirmation of what actually got saved -- one line with
// the total, then one line per bank_date listing each category's row count.
// Deliberately built from the same `items` array that was just persisted
// (not a fresh SELECT), so this always reflects exactly what this run wrote.
function logBankSummary(items) {
  const byDate = new Map();
  for (const item of items) {
    if (!byDate.has(item.bank_date)) {
      byDate.set(item.bank_date, new Map());
    }
    const byCategory = byDate.get(item.bank_date);
    byCategory.set(item.category, (byCategory.get(item.category) || 0) + 1);
  }

  console.log(`Daily Bank saved: ${items.length} rows`);
  for (const date of [...byDate.keys()].sort()) {
    const byCategory = byDate.get(date);
    const parts = [...byCategory.keys()]
      .sort()
      .map((category) => `${category}=${byCategory.get(category)}`)
      .join(', ');
    console.log(`${date}: ${parts}`);
  }
}

/**
 * Generates today's shared content bank via a web-search-enabled OpenAI call
 * and persists each item as its own daily_content_bank row under today's
 * Asia/Almaty product-day date. Never throws -- a failed or malformed call is logged and leaves the
 * bank empty/partial for today rather than crashing the caller (the cron
 * endpoint that calls this, see src/routes/internalGenerateBank.js).
 *
 * @returns {Promise<{ savedCount: number, error: string|null, dates?: string[] }>}
 */
async function generateDailyBank() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { savedCount: 0, error: 'OPENAI_API_KEY is not configured' };
  }

  const bankDate = getBankDateString();
  const preparedDates = getPreparedBankDates(bankDate);
  const countryCodes = collectHolidayCountryCodes();
  console.log(`generateDailyBank: holiday_country_codes=${countryCodes.join(',')} count=${countryCodes.length}`);

  try {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey });

    // gpt-4o, not gpt-4o-search-preview -- confirmed by the earlier manual
    // test that the Responses API's web_search tool works with gpt-4o but
    // gpt-4o-search-preview is not a valid Responses API model.
    const response = await client.responses.create({
      model: 'gpt-4o',
      tools: [{ type: 'web_search' }],
      input: buildBankPrompt(bankDate, preparedDates, countryCodes),
    });

    const items = parseBankItems(response.output_text, bankDate, preparedDates);
    if (items.length === 0) {
      return { savedCount: 0, error: 'model returned zero usable bank items' };
    }

    logMissingRequiredCategories(items, bankDate, preparedDates);

    // Replace, not append -- a same-day rerun (manual or accidental) must
    // regenerate and replace the prepared date range, not duplicate it. Nothing before
    // this line has touched the DB, so any failure above (network error,
    // malformed JSON, zero valid items) already returned without altering
    // the existing bank.
    replaceBankItemsForDates(preparedDates, items);
    logBankSummary(items);

    return { savedCount: items.length, error: null, dates: preparedDates };
  } catch (err) {
    console.error('generateDailyBank failed:', err.message);
    return { savedCount: 0, error: err.message };
  }
}

// Accepts both a JSON-encoded tags string (live daily_content_bank rows, as
// stored in SQLite) and a plain array (handy for direct unit-test objects).
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

// Step 2: within an already-country-filtered pool of "holiday" rows (see
// isBankItemAllowedForCountry), prefer the ones actually tagged with this
// device's own country over the international/"global" ones -- picking
// among several local matches (if more than one) is still a random choice,
// same as the surrounding selection logic. Returns `rows` unchanged
// (international item(s) included) when there's no country to match against
// or no local match exists.
function preferLocalHolidayRows(rows, countryCode) {
  const targetCountry = normalizeCountryCode(countryCode);
  if (!targetCountry) {
    return rows;
  }
  const localMatches = rows.filter((row) => countryTagsFromBankItem(row).has(targetCountry));
  return localMatches.length > 0 ? localMatches : rows;
}

function dateDistanceDays(a, b) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) {
    return Number.POSITIVE_INFINITY;
  }
  const aMs = new Date(`${a}T00:00:00Z`).getTime();
  const bMs = new Date(`${b}T00:00:00Z`).getTime();
  if (Number.isNaN(aMs) || Number.isNaN(bMs)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(aMs - bMs) / (24 * 60 * 60 * 1000);
}

function resolveDateSensitiveBankDate(deviceLocalDate) {
  const availableDates = selectDateSensitiveBankDatesStatement.all().map((row) => row.bank_date);
  if (availableDates.length === 0) {
    return deviceLocalDate;
  }
  if (availableDates.includes(deviceLocalDate)) {
    return deviceLocalDate;
  }
  return availableDates
    .slice()
    .sort((a, b) => dateDistanceDays(a, deviceLocalDate) - dateDistanceDays(b, deviceLocalDate))[0];
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

  const sharedRows = selectBankRowsForDateStatement
    .all(bankDate)
    .filter((row) => !DATE_SENSITIVE_CATEGORIES.has(row.category));
  const dateSensitiveDate = resolveDateSensitiveBankDate(deviceLocalDate);
  const dateSensitiveRows = selectBankRowsForDateStatement
    .all(dateSensitiveDate)
    .filter((row) => DATE_SENSITIVE_CATEGORIES.has(row.category));
  const liveBankRows = sharedRows
    .concat(dateSensitiveRows)
    .filter((row) => isBankItemAllowedForCountry(row, countryCode));
  // Hard filter: a fact already used for this device is never offered again
  // (date-sensitive categories may come back after a year -- see sentPhrases.js).
  const shownFacts = loadShownFacts(deviceId);
  const bankRows = liveBankRows.filter((row) => !isFactShown(shownFacts, row.category, row.content_text));
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
  const byCategoryAll = new Map();
  for (const row of bankRows) {
    if (!byCategoryAll.has(row.category)) {
      byCategoryAll.set(row.category, []);
    }
    byCategoryAll.get(row.category).push(row);
  }

  const selected = [];
  const selectedCategories = new Set();
  for (const category of GUARANTEED_SELECTION_CATEGORIES) {
    const rowsInCategory = byCategoryAll.get(category);
    if (!rowsInCategory || rowsInCategory.length === 0) {
      continue;
    }
    // Step 2: for "holiday" specifically, prefer a row tagged with THIS
    // device's own country over a global/other-country one, when both exist
    // -- rowsInCategory is already restricted to items allowed for this
    // country by isBankItemAllowedForCountry above (device-country-tagged +
    // untagged/"global" items only), so preferLocalHolidayRows only ever
    // narrows it further, never adds anything new. Falls back to the full
    // (already-filtered) pool -- i.e. the international item -- when no
    // local match exists, same "if none at all, skip" behavior as before
    // when rowsInCategory itself is empty.
    const pickPool = category === 'holiday' ? preferLocalHolidayRows(rowsInCategory, countryCode) : rowsInCategory;
    const pick = pickPool[Math.floor(Math.random() * pickPool.length)];
    selected.push({ id: pick.id, category: pick.category, content_text: pick.content_text });
    selectedCategories.add(category);
  }

  const shuffledCategories = [...byCategory.keys()]
    .filter((category) => !selectedCategories.has(category))
    .sort(() => Math.random() - 0.5);
  for (const category of shuffledCategories) {
    if (selected.length >= count + selectedCategories.size) {
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
  getPreparedBankDates,
  BANK_CATEGORIES,
  buildBankPrompt,
  collectHolidayCountryCodes,
  _test: {
    countryTagsFromBankItem,
    isBankItemAllowedForCountry,
    normalizeCountryCode,
    replaceBankItemsForDate,
    replaceBankItemsForDates,
    parseBankItems,
    buildBankPrompt,
    getPreparedBankDates,
    resolveDateSensitiveBankDate,
    DATE_SENSITIVE_CATEGORIES,
    logMissingRequiredCategories,
    logBankSummary,
    resolveDeviceCountryCode,
    preferLocalHolidayRows,
    ALWAYS_INCLUDED_HOLIDAY_COUNTRIES,
    MAX_HOLIDAY_COUNTRIES,
  },
};
