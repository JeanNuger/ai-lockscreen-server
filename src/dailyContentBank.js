const db = require('./db');
const { countryForTimezone } = require('./timezoneCountry');
const { loadShownFacts, isFactShown } = require('./sentPhrases');

// Fixed category set for daily_content_bank rows (bank v3, whole-day scheme).
// The bank is built once a day with web search and holds EVERY fact the whole-day
// call (src/dayPlan.js) may use: date-bound items (holiday, on_this_day, born_today,
// good_news) and fresh verified facts (science ... quote). Jokes, thoughts, wishes,
// horoscope, tips and ideas are not in the bank: the model writes those itself.
const BANK_CATEGORIES = [
  'holiday',
  'on_this_day',
  'born_today',
  'good_news',
  'science',
  'animals',
  'space',
  'nature',
  'tech',
  'unusual',
  'country_kz',
  'city_astana',
  'money',
  'brain',
  'word_origin',
  'tradition',
  'how_it_works',
  'quote',
];
// The four categories the old /batch planner (slotPlanner.js) knows how to use. The old /batch
// endpoint stays alive for the installed app, so it keeps selecting only these.
const LEGACY_BANK_CATEGORIES = ['holiday', 'on_this_day', 'born_today', 'good_news'];

// Model of the daily bank call (Responses API + web_search) and its reasoning effort.
// Read at call time so a test can override them.
const BANK_MODEL_DEFAULT = 'gpt-6.1-sol';
const BANK_EFFORT_DEFAULT = 'low';
const BANK_RETENTION_DAYS = 45;
const BANK_FACTS_HISTORY_DAYS = 30;
const BANK_FACTS_HISTORY_MAX = 400;
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

const selectRecentBankTextsStatement = db.prepare(`
  SELECT content_text FROM daily_content_bank
  WHERE bank_date >= ? AND bank_date < ?
  ORDER BY bank_date DESC, id DESC
  LIMIT ?
`).pluck();

const pruneOldBankStatement = db.prepare(`
  DELETE FROM daily_content_bank WHERE bank_date < ?
`);

// Facts of the bank over the last BANK_FACTS_HISTORY_DAYS days (not including bankDate itself),
// newest first: the "do not repeat" list of the bank prompt.
function loadRecentBankFacts(bankDate, days = BANK_FACTS_HISTORY_DAYS, limit = BANK_FACTS_HISTORY_MAX) {
  const from = addDaysToDateString(bankDate, -days);
  if (!from) {
    return [];
  }
  return selectRecentBankTextsStatement.all(from, bankDate, limit);
}

function buildBankPrompt(bankDate, countryCodes = collectHolidayCountryCodes(), recentFacts = loadRecentBankFacts(bankDate)) {
  const otherCountries = countryCodes.filter((code) => code !== 'KZ');
  return `Search the web (today is ${bankDate}) and build a content bank for ${bankDate} for a phone lock-screen app.
Return STRICTLY a JSON array (no wrapper, no markdown) of objects: {"category": one of [${BANK_CATEGORIES.join(', ')}], "country": ISO code or "global" or "", "text": "..."}.
This is a one-shot automated job: never ask questions or propose stages, just do the work and return the final array. Use as many searches as needed to cover every category; never output placeholder or "no data" items. Every "text" is ONE short self-contained sentence in English, at most 12 words, with no invented numbers: every number, name and date must be confirmed by a search result. If you cannot verify it, leave it out. Do not put links or citations inside the text.

DATE-BOUND (all for ${bankDate} exactly):
- holiday (REQUIRED): (a) a holiday of Kazakhstan on ${bankDate} — professional, national or commemorative (country "KZ"); (b) an international day of the UN or UNESCO on ${bankDate} (country "global"). Keep searching for both (Kazakh sources, UN/UNESCO calendars). If after thorough search one truly does not exist, output an item with category holiday, country "KZ" or "global", and text starting "NONE:" saying so — but search first. Also, for each of these other countries, its own official or widely observed holiday on ${bankDate}, if any (never invent): ${otherCountries.join(', ')}.
- on_this_day: 6 real events that happened on ${bankDate} in past years, start the text with the year. Different countries; at least one from Kazakhstan or Central Asia and at least one from Europe or Asia; not only the USA.
- born_today: 6 real people born on ${bankDate}, give the year of birth. Different countries; at least one from Kazakhstan or Central Asia and at least one from Europe or Asia; not only the USA.
- good_news: 4 genuinely positive, verifiable developments from the last few days.
FRESH VERIFIED FACTS: little-known and surprising, NOT school-level (no "octopuses have three hearts", no "ice floats", no "Neptune was found by maths" — the kind every pupil knows). Prefer facts a smart adult would say "I didn't know that" about.
- science 6, animals 6, space 5, nature 5, tech 5, unusual 5, money 4 (money explained simply), brain 4 (brain and psychology, well-established findings only), word_origin 4 (where a word came from, say which language), tradition 4 (unusual tradition of one country, name it), how_it_works 4 (how a familiar thing works), quote 4 (a real short quote with its author, at most 12 words besides the author).
- country_kz 5: facts about Kazakhstan. city_astana 5: facts about Astana. Country "KZ".
Avoid politics, commercial "days of X", self-help and generic wishes. Do not repeat anything from this list of the last ${BANK_FACTS_HISTORY_DAYS} days: ${JSON.stringify(recentFacts)}.
Never return an empty array. Respond with the JSON array only.`;
}

// Markdown links the search tool sometimes leaves in the text: "([site](https://...))" or "[site](https://...)".
function stripCitations(text) {
  return String(text)
    .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '')
    .replace(/\s*\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parses the model's answer into rows for daily_content_bank. Every row belongs to `bankDate` (the
// bank is built per day). The country goes into `tags` as ["KZ"] / ["global"], the shape the old
// country filter (isBankItemAllowedForCountry) already reads. "NONE:" items (the model reporting that a
// required holiday does not exist) are not stored: they are returned in `noneNotes` for the log.
// An unknown category drops the row with a warning, never silently re-labelled.
function parseBankItems(rawText, bankDate) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const match = rawText && rawText.match(/\[[\s\S]*\]/);
    if (!match) {
      throw err;
    }
    parsed = JSON.parse(match[0]);
  }
  const array = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.items) ? parsed.items : null;
  if (!array) {
    throw new Error('response did not contain a JSON array of bank items');
  }

  const rows = [];
  const noneNotes = [];
  const seenTexts = new Set();
  for (const item of array) {
    const rawItemText = item && (typeof item.text === 'string' ? item.text : item.content_text);
    if (typeof rawItemText !== 'string') {
      continue;
    }
    const text = stripCitations(rawItemText);
    if (!text || text.startsWith('(')) {
      continue;
    }
    if (!BANK_CATEGORIES.includes(item.category)) {
      console.warn(`generateDailyBank: dropping bank item with unknown category "${item.category}"`);
      continue;
    }
    const country = typeof item.country === 'string' ? item.country.trim() : '';
    if (/^none:/i.test(text)) {
      noneNotes.push({ category: item.category, country: country || null, text });
      continue;
    }
    const key = text.toLowerCase();
    if (seenTexts.has(key)) {
      continue;
    }
    seenTexts.add(key);
    const tag = /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : country ? country.toLowerCase() : null;
    rows.push({
      bank_date: bankDate,
      category: item.category,
      content_text: text,
      tags: tag ? [tag] : [],
    });
  }
  return { rows, noneNotes };
}

// Warns (never throws, never fabricates) when the bank lacks what the whole-day call depends on:
// the date-bound categories, and a Kazakhstan holiday / an international day (the model may have
// reported them as "NONE:", see parseBankItems). Purely diagnostic: whatever valid rows exist are saved.
function logMissingRequiredCategories(rows, bankDate, noneNotes = []) {
  for (const category of DATE_SENSITIVE_CATEGORIES) {
    if (!rows.some((row) => row.category === category)) {
      console.warn(`generateDailyBank: missing required category "${category}" for ${bankDate}`);
    }
  }
  const holidayTags = (row) => parseTags(row.tags);
  if (!rows.some((row) => row.category === 'holiday' && holidayTags(row).includes('KZ'))) {
    console.warn(`generateDailyBank: no Kazakhstan holiday for ${bankDate}${noneNotes.some((n) => n.country === 'KZ') ? ' (model reported none)' : ''}`);
  }
  if (!rows.some((row) => row.category === 'holiday' && holidayTags(row).includes('global'))) {
    console.warn(`generateDailyBank: no international day for ${bankDate}${noneNotes.some((n) => n.country === 'global') ? ' (model reported none)' : ''}`);
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

let bankClientFactory = null;

function createBankClient() {
  if (bankClientFactory) {
    return bankClientFactory();
  }
  const OpenAI = require('openai');
  // The whole search run takes minutes (about 3.5 on the test), so the SDK's default 10 minute
  // timeout stays and its own retries are off: a failed run simply leaves the old bank in place.
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
}

function logBankUsage(model, effort, response, seconds) {
  const usage = response && response.usage;
  if (!usage) {
    return;
  }
  const reasoning = usage.output_tokens_details && Number.isFinite(usage.output_tokens_details.reasoning_tokens)
    ? usage.output_tokens_details.reasoning_tokens
    : 0;
  const searches = (response.output || []).filter((o) => o && o.type === 'web_search_call').length;
  console.log(`OPENAI_USAGE scope=daily_bank model=${model} prompt_tokens=${usage.input_tokens} completion_tokens=${usage.output_tokens} reasoning_tokens=${reasoning} total_tokens=${usage.total_tokens} cached_tokens=0 reasoning_effort=${effort} searches=${searches} seconds=${seconds.toFixed(1)}`);
}

/**
 * Generates today's shared content bank (bank v3) with one web-search call and stores it under
 * today's Asia/Almaty product-day date, replacing that date's rows and keeping older days for
 * BANK_RETENTION_DAYS. The "do not repeat" list is the facts of the last 30 days from this same
 * table. Never throws: a failed or malformed call is logged and leaves the existing bank untouched.
 *
 * @returns {Promise<{ savedCount: number, error: string|null, dates?: string[] }>}
 */
async function generateDailyBank() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { savedCount: 0, error: 'OPENAI_API_KEY is not configured' };
  }

  const bankDate = getBankDateString();
  const countryCodes = collectHolidayCountryCodes();
  const model = process.env.BANK_MODEL || BANK_MODEL_DEFAULT;
  const effort = process.env.BANK_REASONING_EFFORT || BANK_EFFORT_DEFAULT;
  console.log(`generateDailyBank: bank_date=${bankDate} model=${model} holiday_country_codes=${countryCodes.join(',')}`);

  try {
    const client = createBankClient();
    const params = {
      model,
      tools: [{ type: 'web_search' }],
      input: buildBankPrompt(bankDate, countryCodes),
    };
    if (/^(gpt-5|gpt-6|o\d)/i.test(model)) {
      params.reasoning = { effort };
    }
    const startedMs = Date.now();
    const response = await client.responses.create(params);
    logBankUsage(model, effort, response, (Date.now() - startedMs) / 1000);

    const { rows, noneNotes } = parseBankItems(response.output_text, bankDate);
    if (rows.length === 0) {
      return { savedCount: 0, error: 'model returned zero usable bank items' };
    }

    logMissingRequiredCategories(rows, bankDate, noneNotes);
    replaceBankItemsForDate(bankDate, rows);
    const pruneBefore = addDaysToDateString(bankDate, -BANK_RETENTION_DAYS);
    if (pruneBefore) {
      pruneOldBankStatement.run(pruneBefore);
    }
    logBankSummary(rows);

    return { savedCount: rows.length, error: null, dates: [bankDate] };
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

// Only the legacy categories: the old /batch planner knows nothing about the others (they are used by
// the whole-day call, see src/dayPlan.js).
function isBankItemAllowedForCountry(row, countryCode) {
  if (!LEGACY_BANK_CATEGORIES.includes(row.category)) {
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

// The bank rows the whole-day call (src/dayPlan.js) may use for a device whose local date is
// `deviceLocalDate`: every category of the bank day nearest to that date (the bank is built once a
// day in Asia/Almaty, a device in another timezone may be a day behind or ahead). Returns
// { bankDate, rows: [{ id, category, content_text, tags }] }, rows empty when there is no bank yet.
function selectBankRowsForDay(deviceLocalDate) {
  const bankDate = resolveDateSensitiveBankDate(deviceLocalDate);
  if (!bankDate) {
    return { bankDate: null, rows: [] };
  }
  return { bankDate, rows: selectBankRowsForDateStatement.all(bankDate) };
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
  LEGACY_BANK_CATEGORIES,
  buildBankPrompt,
  collectHolidayCountryCodes,
  loadRecentBankFacts,
  selectBankRowsForDay,
  resolveDateSensitiveBankDate,
  parseTags,
  normalizeCountryCode,
  resolveDeviceCountryCode,
  _test: {
    setBankClientFactory(factory) {
      bankClientFactory = factory;
    },
    stripCitations,
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
