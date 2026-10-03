const db = require('./db');
const {
  getBankDateString, addDaysToDateString, collectActiveLocations, cityTag, createBankClient,
} = require('./dailyContentBank');
const { isFridayDate } = require('./dayRotation');

// The weekend events poster (task 31): on Fridays, in the daily cron, ONE web-search call per city of the active
// devices that looks only for events of the coming Saturday and Sunday on the local listing sites. The common
// bank (src/dailyContentBank.js) no longer asks for the poster. The events are stored as bank rows of category
// "afisha" under the bank date of the Friday, with the tags the day plan reads:
//   [country, "city:<name>", "date:YYYY-MM-DD", "kind:<kind>", "age:<audience>", "time:HH:MM"?]
// and the title as `subject`. src/dayPlan.js hands the events of the day and the city to the model.

const AFISHA_KINDS = ['theatre', 'cinema', 'concert', 'sport', 'standup', 'exhibition', 'family'];
const AFISHA_AUDIENCES = ['kids', 'family', '18+', 'all'];
const KIND_LABELS = {
  theatre: 'theatre', cinema: 'cinema', concert: 'concert', sport: 'sport', standup: 'stand-up',
  exhibition: 'exhibition', family: 'family event',
};
const AUDIENCE_LABELS = { kids: 'for children', family: 'family', '18+': '18+', all: 'all ages' };
const KIND_SYNONYMS = {
  film: 'cinema', movie: 'cinema', premiere: 'cinema', premiere_film: 'cinema', theater: 'theatre', play: 'theatre', opera: 'theatre',
  ballet: 'theatre', music: 'concert', concerts: 'concert', sports: 'sport', match: 'sport', comedy: 'standup', 'stand-up': 'standup',
  stand_up: 'standup', exhibit: 'exhibition', museum: 'exhibition', kids: 'family', children: 'family', child: 'family',
};
const AUDIENCE_SYNONYMS = {
  children: 'kids', child: 'kids', kid: 'kids', '0+': 'kids', '6+': 'kids', '12+': 'family', '16+': 'all', '18': '18+', '21+': '18+',
  adults: '18+', adult: '18+', everyone: 'all', 'all ages': 'all', any: 'all', '': 'all',
};

const insertEventStatement = db.prepare(`
  INSERT INTO daily_content_bank (bank_date, category, content_text, tags, subject)
  VALUES (?, 'afisha', ?, ?, ?)
`);
const deleteCityEventsStatement = db.prepare(`
  DELETE FROM daily_content_bank WHERE bank_date = ? AND category = 'afisha' AND tags LIKE ?
`);
const replaceCityEvents = db.transaction((bankDate, city, rows) => {
  deleteCityEventsStatement.run(bankDate, `%"${cityTag(city.name)}"%`);
  for (const row of rows) {
    insertEventStatement.run(bankDate, row.content_text, JSON.stringify(row.tags), row.subject);
  }
});

// Saturday and Sunday after the Friday `bankDate`.
function weekendDatesFor(bankDate) {
  return [addDaysToDateString(bankDate, 1), addDaysToDateString(bankDate, 2)];
}

const LOCAL_SITES = {
  KZ: 'For Kazakhstan search first: Ticketon (ticketon.kz), Kino.kz (kino.kz), Sxodim (sxodim.com) and the sites of the theatres, philharmonics, concert halls, stadiums, clubs and museums of the city.',
};

function buildAfishaPrompt(city, dates, today) {
  const [saturday, sunday] = dates;
  const sites = LOCAL_SITES[city.country]
    || `Find the main local event-listing and ticket sites of ${city.country} and of ${city.name} yourself (the local equivalents of Ticketon, Kino.kz and Sxodim, the cinema chains, the theatre, concert hall, stadium and museum sites of the city).`;
  return `Search the web (today is ${today}) for REAL events in ${city.name} (country ${city.country}) on ${saturday} (Saturday) and ${sunday} (Sunday) for a phone lock-screen app that shows people what is on this weekend.
SOURCES: local event-listing and ticket sites and the sites of the venues, not general news. ${sites}
WHAT TO FIND, for these two days only: theatre (kind "theatre"), cinema, especially new releases and premieres (kind "cinema"), concerts (kind "concert"), sport matches and events (kind "sport"), stand-up and comedy (kind "standup"), exhibitions (kind "exhibition"), family and children's events (kind "family").
Do not stop after theatres and concerts: look specifically for sport (the fixtures and ticket pages of the city's football, hockey, basketball, volleyball and martial-arts clubs and arenas) and for stand-up and comedy (the comedy clubs and the stand-up sections of the ticket sites).
GOAL: 10 to 20 events for the city, spread over the kinds, a mix for different ages. Fewer real events beat invented ones: an event goes in only if you found it in a search result, with its venue and a date that is exactly ${saturday} or ${sunday}. Never invent a title, a venue, a date or a time; never use an event of another day or a past event.
This is a one-shot automated job: never ask questions, just do the work. Return STRICTLY a JSON array (no wrapper, no markdown) of objects:
{"title": "...", "kind": "theatre|cinema|concert|sport|standup|exhibition|family", "venue": "...", "date": "YYYY-MM-DD", "time": "HH:MM" or "", "audience": "kids|family|18+|all", "source": "the site where you found it"}
"title" and "venue" as the listing writes them (original language, no links). "audience": "kids" for shows for small children, "family" for the whole family, "18+" for adult-only events, "all" for everyone else. One object per event and day; when a film or play runs at several times pick the evening session.
Never return an empty array unless the city truly has nothing. Respond with the JSON array only.`;
}

function normalizeKind(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (AFISHA_KINDS.includes(value)) return value;
  return KIND_SYNONYMS[value] || null;
}

function normalizeAudience(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (AFISHA_AUDIENCES.includes(value)) return value;
  return AUDIENCE_SYNONYMS[value] || 'all';
}

function normalizeTime(raw) {
  const match = String(raw || '').trim().match(/^(\d{1,2})[:.](\d{2})/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return '';
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

// The text of an event as the day plan model reads it.
function eventText({ title, kind, venue, date, time, audience }) {
  return `${title} — ${KIND_LABELS[kind]}, ${venue}, ${date}${time ? ` ${time}` : ''}, ${AUDIENCE_LABELS[audience]}`;
}

// Parses the model's answer for one city into bank rows. Only real-looking events of the two weekend days with a
// title, a venue and a known kind are kept; duplicates (same title, venue, date) are dropped. Never throws on a bad
// item, only on an answer that is no JSON array at all. Returns { rows, rejected }.
function parseAfishaEvents(rawText, { city, dates, bankDate }) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const match = rawText && rawText.match(/\[[\s\S]*\]/);
    if (!match) throw err;
    parsed = JSON.parse(match[0]);
  }
  const array = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.events) ? parsed.events : null;
  if (!array) throw new Error('response did not contain a JSON array of events');
  const rows = [];
  const rejected = [];
  const seen = new Set();
  for (const item of array) {
    const title = item && typeof item.title === 'string' ? item.title.replace(/\s*\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim() : '';
    const venue = item && typeof item.venue === 'string' ? item.venue.replace(/\s+/g, ' ').trim() : '';
    const date = item && typeof item.date === 'string' ? item.date.trim().slice(0, 10) : '';
    const kind = item ? normalizeKind(item.kind) : null;
    if (title.length < 2 || venue.length < 2 || !kind || !dates.includes(date)) {
      rejected.push({ title, reason: !dates.includes(date) ? 'date' : !kind ? 'kind' : 'fields' });
      continue;
    }
    const key = `${title}|${venue}|${date}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const time = normalizeTime(item.time);
    const audience = normalizeAudience(item.audience);
    const tags = [city.country, cityTag(city.name), `date:${date}`, `kind:${kind}`, `age:${audience}`];
    if (time) tags.push(`time:${time}`);
    rows.push({
      bank_date: bankDate,
      category: 'afisha',
      content_text: eventText({ title: title.slice(0, 120), kind, venue: venue.slice(0, 100), date, time, audience }),
      tags,
      subject: title.slice(0, 60),
      // for the log and the review of the run only (not stored)
      event: { title, kind, venue, date, time, audience, source: typeof item.source === 'string' ? item.source.trim() : '' },
    });
  }
  return { rows, rejected };
}

function countByKind(rows) {
  const counts = {};
  for (const kind of AFISHA_KINDS) counts[kind] = 0;
  for (const row of rows) counts[row.event.kind] += 1;
  return counts;
}

function logAfishaUsage(model, effort, city, response, seconds) {
  const usage = response && response.usage;
  if (!usage) return;
  const reasoning = usage.output_tokens_details && Number.isFinite(usage.output_tokens_details.reasoning_tokens)
    ? usage.output_tokens_details.reasoning_tokens : 0;
  const searches = (response.output || []).filter((o) => o && o.type === 'web_search_call').length;
  console.log(`OPENAI_USAGE scope=afisha city=${city.name} model=${model} prompt_tokens=${usage.input_tokens} completion_tokens=${usage.output_tokens} reasoning_tokens=${reasoning} total_tokens=${usage.total_tokens} cached_tokens=0 reasoning_effort=${effort} searches=${searches} seconds=${seconds.toFixed(1)}`);
}

// One city: one web-search call, the events of the two days stored (replacing that city's events of this Friday).
// A failed or malformed call leaves what was stored before untouched. Never throws.
async function generateAfishaForCity(city, { bankDate, dates, today = bankDate }) {
  const model = process.env.BANK_MODEL || 'gpt-6.1-sol';
  const effort = process.env.BANK_REASONING_EFFORT || 'low';
  try {
    const client = createBankClient();
    const params = { model, tools: [{ type: 'web_search' }], input: buildAfishaPrompt(city, dates, today) };
    if (/^(gpt-5|gpt-6|o\d)/i.test(model)) params.reasoning = { effort };
    const startedMs = Date.now();
    const response = await client.responses.create(params);
    logAfishaUsage(model, effort, city, response, (Date.now() - startedMs) / 1000);
    const { rows, rejected } = parseAfishaEvents(response.output_text, { city, dates, bankDate });
    if (rows.length === 0) {
      console.warn(`AFISHA city=${city.name} no usable events (rejected=${rejected.length}); stored events kept`);
      return { city: city.name, savedCount: 0, rows: [], rejected, error: 'no usable events' };
    }
    replaceCityEvents(bankDate, city, rows);
    const counts = countByKind(rows);
    console.log(`AFISHA_COUNTS city=${city.name} total=${rows.length} rejected=${rejected.length} ${AFISHA_KINDS.map((kind) => `${kind}=${counts[kind]}`).join(' ')}`);
    return { city: city.name, savedCount: rows.length, rows, rejected, counts, error: null };
  } catch (err) {
    console.error(`AFISHA city=${city.name} failed: ${err.message}`);
    return { city: city.name, savedCount: 0, rows: [], rejected: [], error: err.message };
  }
}

/**
 * The poster for the weekend after the Friday `bankDate`, for every city of the active devices (or `cities`).
 * One call per city, one after the other. Returns { savedCount, results }.
 */
async function generateAfisha({ bankDate, dates, cities } = {}) {
  if (!process.env.OPENAI_API_KEY) {
    return { savedCount: 0, results: [], error: 'OPENAI_API_KEY is not configured' };
  }
  const date = bankDate || getBankDateString();
  const weekend = dates || weekendDatesFor(date);
  const list = cities || collectActiveLocations().cities;
  const results = [];
  for (const city of list) {
    results.push(await generateAfishaForCity(city, { bankDate: date, dates: weekend }));
  }
  return { savedCount: results.reduce((sum, r) => sum + r.savedCount, 0), results, error: null };
}

// The daily cron calls this after the bank: it runs on Fridays only (Asia/Almaty date, the bank date).
async function generateAfishaIfFriday(now = new Date()) {
  const bankDate = getBankDateString(now);
  if (!isFridayDate(bankDate)) {
    return { ran: false, savedCount: 0, cities: 0 };
  }
  const outcome = await generateAfisha({ bankDate });
  return { ran: true, savedCount: outcome.savedCount, cities: outcome.results.length, error: outcome.error };
}

module.exports = {
  AFISHA_KINDS,
  AFISHA_AUDIENCES,
  weekendDatesFor,
  buildAfishaPrompt,
  parseAfishaEvents,
  generateAfisha,
  generateAfishaForCity,
  generateAfishaIfFriday,
};
