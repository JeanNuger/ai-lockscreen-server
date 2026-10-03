const db = require('./db');
const { countryForTimezone } = require('./timezoneCountry');
const { loadShownFacts, isFactShown } = require('./sentPhrases');
const { INTEREST_KEYS, interestCategory, isFridayDate, isWeekendDate } = require('./dayRotation');

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
  'money',
  'brain',
  'word_origin',
  'tradition',
  'how_it_works',
  'quote',
  // Day scheme v2 (task 27): facts per country and per city of the active devices, real films/series/books
  // per country, the weekend events of the cities (built on Fridays only) and the facts of the 12 interests.
  'country_fact',
  'city_fact',
  'watch_read',
  'afisha',
  ...INTEREST_KEYS.map(interestCategory),
];
// country_kz / city_astana are the old Kazakhstan-only names: still accepted (rows of the last 45 days), no longer asked for.
const LEGACY_PLACE_CATEGORIES = ['country_kz', 'city_astana'];
BANK_CATEGORIES.push(...LEGACY_PLACE_CATEGORIES);
// The four categories the old /batch planner (slotPlanner.js) knows how to use. The old /batch
// endpoint stays alive for the installed app, so it keeps selecting only these.
const LEGACY_BANK_CATEGORIES = ['holiday', 'on_this_day', 'born_today', 'good_news'];

// Model of the daily bank call (Responses API + web_search) and its reasoning effort.
// Read at call time so a test can override them.
const BANK_MODEL_DEFAULT = 'gpt-6.1-sol';
const BANK_EFFORT_DEFAULT = 'low';
// 60 days: the subjects of the last 60 days go into the bank prompt as "do not take these objects".
const BANK_RETENTION_DAYS = 65;
const BANK_SUBJECTS_HISTORY_DAYS = 60;
const BANK_SUBJECTS_HISTORY_MAX = 700;
const BANK_FACTS_HISTORY_DAYS = 30;
const BANK_FACTS_HISTORY_MAX = 400;
const BANK_TIMEZONE = 'Asia/Almaty';
const DATE_SENSITIVE_CATEGORIES = new Set(['holiday', 'on_this_day', 'born_today']);

const insertBankItemStatement = db.prepare(`
  INSERT INTO daily_content_bank (bank_date, category, content_text, tags, subject)
  VALUES (?, ?, ?, ?, ?)
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
    insertBankItemStatement.run(bankDate, row.category, row.content_text, JSON.stringify(row.tags), row.subject || null);
  }
});

const replaceBankItemsForDates = db.transaction((bankDates, rows) => {
  for (const bankDate of bankDates) {
    deleteBankItemsForDateStatement.run(bankDate);
  }
  for (const row of rows) {
    insertBankItemStatement.run(row.bank_date, row.category, row.content_text, JSON.stringify(row.tags), row.subject || null);
  }
});

const selectBankRowsForDateStatement = db.prepare(`
  SELECT id, bank_date, category, content_text, tags, subject FROM daily_content_bank WHERE bank_date = ?
`);

const selectAfishaRowsStatement = db.prepare(`
  SELECT id, bank_date, category, content_text, tags, subject FROM daily_content_bank
  WHERE category = 'afisha' AND bank_date >= ? AND bank_date <= ?
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

// Countries and cities of the devices that were active lately (a day plan or a batch in the last
// ACTIVE_DEVICE_DAYS days): the bank asks for country facts, city facts, films/books and the weekend
// events for exactly these, not only Kazakhstan and Astana (which stay in as the home market).
const ACTIVE_DEVICE_DAYS = 14;
const MAX_FACT_COUNTRIES = 12;
const MAX_FACT_CITIES = 10;

const selectActiveDevicesStatement = db.prepare(`
  SELECT d.timezone, d.city_name, d.city_country_code FROM devices d
  WHERE EXISTS (SELECT 1 FROM day_plans p WHERE p.device_id = d.device_id AND p.created_at >= datetime('now', ?))
     OR EXISTS (SELECT 1 FROM content_batches b WHERE b.device_id = d.device_id AND b.delivered_at >= datetime('now', ?))
`);

function cityTag(name) {
  return `city:${String(name || '').trim().toLowerCase()}`;
}

// -> { countries: ['KZ', ...], cities: [{ name, country }] }, most devices first, Kazakhstan / Astana always in.
function collectActiveLocations({ maxCountries = MAX_FACT_COUNTRIES, maxCities = MAX_FACT_CITIES } = {}) {
  const countryCounts = new Map([['KZ', Number.MAX_SAFE_INTEGER]]);
  const cityCounts = new Map([[`${cityTag('Astana')}|KZ`, { name: 'Astana', country: 'KZ', count: Number.MAX_SAFE_INTEGER }]]);
  const window = `-${ACTIVE_DEVICE_DAYS} days`;
  for (const device of selectActiveDevicesStatement.all(window, window)) {
    const country = resolveDeviceCountryCode(device);
    if (country) {
      countryCounts.set(country, (countryCounts.get(country) || 0) + 1);
    }
    const name = typeof device.city_name === 'string' ? device.city_name.trim() : '';
    if (name && country) {
      const key = `${cityTag(name)}|${country}`;
      const entry = cityCounts.get(key) || { name, country, count: 0 };
      entry.count += 1;
      cityCounts.set(key, entry);
    }
  }
  const countries = [...countryCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxCountries).map(([code]) => code);
  const cities = [...cityCounts.values()].sort((a, b) => b.count - a.count).slice(0, maxCities)
    .map(({ name, country }) => ({ name, country }));
  return { countries, cities };
}

const selectRecentBankTextsStatement = db.prepare(`
  SELECT content_text FROM daily_content_bank
  WHERE bank_date >= ? AND bank_date < ?
  ORDER BY bank_date DESC, id DESC
  LIMIT ?
`).pluck();

const selectRecentSubjectsStatement = db.prepare(`
  SELECT subject FROM daily_content_bank
  WHERE bank_date >= ? AND bank_date < ? AND subject IS NOT NULL AND subject != ''
  GROUP BY lower(subject)
  ORDER BY max(bank_date) DESC
  LIMIT ?
`).pluck();

// What each interest is about, in plain words (task 29): the bank prompt asks for facts clearly about this
// theme, for an ordinary adult. The key is the interest key of the app.
const INTEREST_BRIEFS = {
  technology: 'what people use every day: phones, apps, the internet, Wi-Fi, cameras, payments, smart devices, everyday gadgets (not chips, protocols or data-centre details)',
  science_space: 'discoveries about nature, the human world and the universe that an ordinary person finds wondrous: planets, stars, space missions, how life works',
  history: 'real stories of people, cities, inventions and events of the past that are fun to retell',
  nature_animals: 'wild animals, pets, plants, forests, oceans, weather and landscapes, in a way anyone can picture',
  sport_health: 'sport, athletes, records, training and healthy everyday habits (walking, water, stretching, sleep habits in plain words); NOT brain anatomy, sleep phases or medicine',
  food: 'dishes, ingredients, drinks, national cuisines, cooking at home, where a food comes from',
  travel: 'places worth visiting, how people travel, cities, landmarks, trains, planes, hotels, journey customs',
  money_business: 'how money, prices, shops, famous companies, jobs and everyday economics work, as explained concepts and facts (no financial terms of the trade)',
  family_kids: 'children, parents, family life, games and learning with kids, funny and useful things about growing up',
  film_music: 'films, series, actors, directors, songs, singers, composers and instruments that people know',
  books_art: 'writers, books, poems, painters, museums, famous works of art and the stories behind them',
  auto: 'cars and whatever people ride or drive: cars, motorbikes, bicycles, scooters, trains, buses, taxis; NOT forklifts, tractors or industrial machines',
};

// The worn-out "amazing facts" every pupil has read (task 28): never asked for, and dropped when the model
// brings them anyway. `name` goes into the prompt, `pattern` matches the subject or the text of an item.
const STOPLIST_TOPICS = [
  { name: 'octopus (three hearts, blue blood)', pattern: /\bocto(pus|pi|puses)\b/i },
  { name: 'gallium melting in a hand', pattern: /\bgallium\b/i },
  { name: 'honey that never spoils', pattern: /\bhoney\b.*\b(spoil|expire|edible|3,?000)|\b(spoil|expire)\w*\b.*\bhoney\b/i },
  { name: 'a day on Venus longer than its year', pattern: /\bvenus\b.*\b(day|year|rotat)/i },
  { name: 'wombats and cube-shaped droppings', pattern: /\bwombat/i },
  { name: 'butterflies tasting with their feet', pattern: /\bbutterfl\w+\b.*\b(taste|feet|legs)/i },
  { name: 'bananas are berries', pattern: /\bbananas?\b.*\bberr/i },
  { name: 'Great Wall visible from space', pattern: /\bgreat wall\b.*\bspace/i },
  { name: 'goldfish three-second memory', pattern: /\bgoldfish\b/i },
  { name: 'we use only 10% of the brain', pattern: /\b10 ?(%|percent)\b.*\bbrain|\bbrain\b.*\b10 ?(%|percent)/i },
  { name: 'lightning never strikes twice', pattern: /\blightning\b.*\b(twice|same place)/i },
  { name: 'sharks older than trees', pattern: /\bsharks?\b.*\b(older than|before) trees/i },
  { name: 'Eiffel Tower growing in summer', pattern: /\beiffel\b.*\b(grow|taller|expand)/i },
  { name: 'flamingos pink from their food', pattern: /\bflamingo/i },
  { name: 'hot water freezing faster (Mpemba)', pattern: /\bmpemba\b|\bhot water\b.*\bfreez\w*\b.*\bfaster/i },
  { name: 'ice floating on water', pattern: /\bice floats\b/i },
  { name: 'Neptune found by mathematics', pattern: /\bneptune\b.*\b(math|predicted|calculat)/i },
  { name: 'cows with best friends', pattern: /\bcows?\b.*\bbest friend/i },
  { name: 'koalas and fingerprints', pattern: /\bkoalas?\b.*\bfingerprint/i },
  { name: 'tardigrades surviving everything', pattern: /\btardigrade/i },
];

function normalizeSubject(subject) {
  return String(subject || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Subjects of the bank of the last BANK_SUBJECTS_HISTORY_DAYS days (not bankDate itself), newest first.
function loadRecentSubjects(bankDate, days = BANK_SUBJECTS_HISTORY_DAYS, limit = BANK_SUBJECTS_HISTORY_MAX) {
  const from = addDaysToDateString(bankDate, -days);
  if (!from) {
    return [];
  }
  return selectRecentSubjectsStatement.all(from, bankDate, limit);
}

function stoplistHit(subject, text) {
  return STOPLIST_TOPICS.find((topic) => topic.pattern.test(String(subject || '')) || topic.pattern.test(String(text || ''))) || null;
}

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

function buildBankPrompt(bankDate, countryCodes = collectHolidayCountryCodes(), recentFacts = loadRecentBankFacts(bankDate), locations = collectActiveLocations(), recentSubjects = loadRecentSubjects(bankDate)) {
  const otherCountries = countryCodes.filter((code) => code !== 'KZ');
  // The weekend events poster is not searched here: on Fridays its own call does it (src/afishaSearch.js).
  const askedCategories = BANK_CATEGORIES.filter((category) => !LEGACY_PLACE_CATEGORIES.includes(category) && category !== 'afisha');
  const cityList = locations.cities.map((city) => `${city.name} (${city.country})`).join(', ');
  return `Search the web (today is ${bankDate}) and build a content bank for ${bankDate} for a phone lock-screen app.
Return STRICTLY a JSON array (no wrapper, no markdown) of objects: {"category": one of [${askedCategories.join(', ')}], "country": ISO code or "global" or "", "city": city name or "", "date": "YYYY-MM-DD" or "", "subject": "...", "text": "..."}.
"subject" is the main object of the item in one to three English words (an animal, element, planet, person, place, word, event: "tree frog", "gallium", "Venus", "Abai"); every item has one, no two items of this run share a subject.
This is a one-shot automated job: never ask questions or propose stages, just do the work and return the final array. Use as many searches as needed to cover every category; never output placeholder or "no data" items. Every "text" is ONE short self-contained sentence in English, at most 12 words, with no invented numbers: every number, name and date must be confirmed by a search result. If you cannot verify it, leave it out. Do not put links or citations inside the text.

DATE-BOUND (all for ${bankDate} exactly):
- holiday (REQUIRED): (a) a holiday of Kazakhstan on ${bankDate} — professional, national or commemorative (country "KZ"); (b) an international day of the UN or UNESCO on ${bankDate} (country "global"). Keep searching for both (Kazakh sources, UN/UNESCO calendars). If after thorough search one truly does not exist, output an item with category holiday, country "KZ" or "global", and text starting "NONE:" saying so — but search first. Also, for each of these other countries, its own official or widely observed holiday on ${bankDate}, if any (never invent): ${otherCountries.join(', ')}.
- on_this_day: 6 real events that happened on ${bankDate} in past years, start the text with the year. Different countries; at least one from Kazakhstan or Central Asia and at least one from Europe or Asia; not only the USA.
- born_today: 6 real people born on ${bankDate}, give the year of birth. Different countries; at least one from Kazakhstan or Central Asia and at least one from Europe or Asia; not only the USA.
- good_news: 4 genuinely positive, verifiable stories from the last few days, each a clear human story or result: who did what and what came of it (a person saved, built, won, cured, restored, invented something). Written as the story itself, never as a report about a report ("in messages from ...", "it is noted that ...") and never vague.
FRESH VERIFIED FACTS: little-known and surprising, NOT school-level (no "octopuses have three hearts", no "ice floats", no "Neptune was found by maths" — the kind every pupil knows). Prefer facts a smart adult would say "I didn't know that" about.
FOR AN ORDINARY ADULT: every fact is understandable without any speciality and is one you would retell to a friend over dinner; plain words, no narrow terminology or engineering detail (not "ECC memory", not "Reed-Solomon codes", not electric forklifts, not brain anatomy).
- science 6, animals 6, space 5, nature 5, tech 5, unusual 5, money 4 (money explained simply), brain 4 (brain and psychology, well-established findings only), word_origin 4 (where a word came from, say which language), tradition 4 (unusual tradition of one country, name it), how_it_works 4 (how a familiar thing works), quote 4 (a real short quote with its author, at most 12 words besides the author).
- Numbers: at least 12 of the science, animals, space, nature, tech, unusual, money and how_it_works facts carry one verified, striking number (a size, speed, count, age, temperature, price) in the text: they feed the "number of the day".
- country_fact: for EACH of these countries: ${locations.countries.join(', ')}: 3 facts about the country itself, country = its ISO code.
- city_fact: for EACH of these cities: ${cityList}: 3 facts about the city, country = its ISO code, city = the name exactly as written in the list.
- watch_read: for EACH of these countries: ${locations.countries.join(', ')}: 3 real, well-known films, series or books that people of that country watch or read in their language (say which: film, series or book, and the title as it is known there), country = its ISO code; plus 2 world-famous ones with country "global". Never invent a title.
- The facts of the 12 interests, 3 fresh facts for each, category "interest_<key>", each clearly and obviously ABOUT its own theme (not about a neighbouring one):
${INTEREST_KEYS.map((key) => `  * ${interestCategory(key)}: ${INTEREST_BRIEFS[key]}`).join('\n')} interest_money_business: only facts and explanations of concepts, never advice to buy, sell or invest. interest_sport_health: only facts, never medical advice, treatment or diets.
Avoid politics, commercial "days of X", self-help and generic wishes. Do not repeat anything from this list of the last ${BANK_FACTS_HISTORY_DAYS} days: ${JSON.stringify(recentFacts)}.
Do NOT take any of these objects as the subject of an item (they were used in the last ${BANK_SUBJECTS_HISTORY_DAYS} days): ${JSON.stringify(recentSubjects)}.
Never use these worn-out school "amazing facts" at all: ${STOPLIST_TOPICS.map((topic) => topic.name).join('; ')}; and nothing of the same kind (every pupil has read it). Choose objects that are fresh.
Every category listed above is required with the number of items given (good_news, tradition, every interest_* ...): before answering, count them and search again for any category that is short. Never return an empty array. Respond with the JSON array only.`;
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
// recentSubjects: subjects of the last 60 days (Set of normalized strings or an array): an item about one of
// them is dropped, and so is an item of the permanent stop list (STOPLIST_TOPICS), whatever the model says.
function parseBankItems(rawText, bankDate, recentSubjects = []) {
  const recent = new Set([...recentSubjects].map(normalizeSubject));
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
    if (item.category === 'afisha') {
      continue; // the poster is made by its own search on Fridays (src/afishaSearch.js)
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
    const subject = typeof item.subject === 'string' ? item.subject.trim().slice(0, 60) : '';
    // Date-bound and place items are about the day / the city, not "amazing facts": only the facts are checked.
    const isFact = !DATE_SENSITIVE_CATEGORIES.has(item.category) && !['afisha', 'watch_read', 'country_fact', 'city_fact', 'good_news'].includes(item.category);
    if (isFact) {
      const worn = stoplistHit(subject, text);
      if (worn) {
        console.warn(`generateDailyBank: dropping worn-out topic "${worn.name}": ${text}`);
        continue;
      }
      if (subject && recent.has(normalizeSubject(subject))) {
        console.warn(`generateDailyBank: dropping repeated subject "${subject}": ${text}`);
        continue;
      }
    }
    seenTexts.add(key);
    const tag = /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : country ? country.toLowerCase() : null;
    // tags[0] stays the country ("KZ" / "global"); a city adds "city:<name>", an event day adds "date:YYYY-MM-DD".
    const city = typeof item.city === 'string' ? item.city.trim() : '';
    const eventDate = typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date.trim()) ? item.date.trim() : '';
    const tags = tag ? [tag] : [];
    if (city || eventDate) {
      if (tags.length === 0) tags.push('global');
      if (city) tags.push(cityTag(city));
      if (eventDate) tags.push(`date:${eventDate}`);
    }
    rows.push({
      bank_date: bankDate,
      category: item.category,
      content_text: text,
      tags,
      subject: subject || null,
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

// One line with the number of rows of every category the run asked for, zero where it got none
// (grep BANK_CATEGORY_COUNTS; the price of the run is the OPENAI_USAGE scope=daily_bank line).
function logBankCategoryCounts(rows, bankDate = null) {
  const counts = new Map();
  for (const row of rows) counts.set(row.category, (counts.get(row.category) || 0) + 1);
  const asked = BANK_CATEGORIES.filter((category) => !LEGACY_PLACE_CATEGORIES.includes(category)
    && category !== 'afisha');
  console.log(`BANK_CATEGORY_COUNTS total=${rows.length} ${asked.map((category) => `${category}=${counts.get(category) || 0}`).join(' ')}`);
  return counts;
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
async function generateDailyBank({ bankDate: forcedBankDate } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { savedCount: 0, error: 'OPENAI_API_KEY is not configured' };
  }

  // forcedBankDate: for test runs only (a Friday run on another day); the cron never passes it.
  const bankDate = forcedBankDate || getBankDateString();
  const countryCodes = collectHolidayCountryCodes();
  const model = process.env.BANK_MODEL || BANK_MODEL_DEFAULT;
  const effort = process.env.BANK_REASONING_EFFORT || BANK_EFFORT_DEFAULT;
  console.log(`generateDailyBank: bank_date=${bankDate} model=${model} holiday_country_codes=${countryCodes.join(',')}`);

  try {
    const client = createBankClient();
    const params = {
      model,
      tools: [{ type: 'web_search' }],
      input: buildBankPrompt(bankDate, countryCodes, undefined, undefined, loadRecentSubjects(bankDate)),
    };
    if (/^(gpt-5|gpt-6|o\d)/i.test(model)) {
      params.reasoning = { effort };
    }
    const startedMs = Date.now();
    const response = await client.responses.create(params);
    logBankUsage(model, effort, response, (Date.now() - startedMs) / 1000);

    const { rows, noneNotes } = parseBankItems(response.output_text, bankDate, loadRecentSubjects(bankDate));
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
    logBankCategoryCounts(rows, bankDate);

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
  // Holiday, "on this day" and "born today" belong to ONE local date: they are taken only from the bank of exactly
  // this date (a bank of the nearest day would give a holiday of the wrong day). The facts of the other
  // categories may come from the nearest bank.
  const rows = selectBankRowsForDateStatement.all(bankDate)
    .filter((row) => !DATE_SENSITIVE_CATEGORIES.has(row.category) || row.bank_date === deviceLocalDate);
  // The weekend events are built on Friday only: on Saturday and Sunday they are read back from the bank of
  // the last two days, only the ones for exactly this day (a row without a date tag counts for both days).
  if (isWeekendDate(deviceLocalDate)) {
    const known = new Set(rows.map((row) => row.id));
    for (const row of selectAfishaRowsStatement.all(addDaysToDateString(deviceLocalDate, -2), deviceLocalDate)) {
      const dateTag = parseTags(row.tags).find((tag) => typeof tag === 'string' && tag.startsWith('date:'));
      if (!known.has(row.id) && (!dateTag || dateTag === `date:${deviceLocalDate}`)) rows.push(row);
    }
  }
  return { bankDate, rows };
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
  collectActiveLocations,
  cityTag,
  loadRecentSubjects,
  createBankClient,
  addDaysToDateString,
  STOPLIST_TOPICS,
  INTEREST_BRIEFS,
  DATE_SENSITIVE_CATEGORIES,
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
    logBankCategoryCounts,
    resolveDeviceCountryCode,
    preferLocalHolidayRows,
    ALWAYS_INCLUDED_HOLIDAY_COUNTRIES,
    MAX_HOLIDAY_COUNTRIES,
  },
};
