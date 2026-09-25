const db = require('./db');
const { generateMorningPack } = require('./contentGenerator');
const { resolveWeatherForecast } = require('./weather');

const selectPackStatement = db.prepare(`
  SELECT id, local_date, pack_json FROM morning_packs WHERE device_id = ? AND local_date = ?
`);
const insertPackStatement = db.prepare(`
  INSERT INTO morning_packs (device_id, local_date, pack_json, trace_json)
  VALUES (?, ?, ?, ?)
`);

// The pack's target_date:
//  - any window other than 'night' -> dateContext.date (today, same as the
//    rest of the codebase's date-sensitive content).
//  - window === 'night' -> the date of the NEXT upcoming 05:00 after the
//    request. dateContext.date/time are already the device's *current* local
//    calendar date/clock (see contentGenerator.js's resolveLocalDateContext),
//    so: a request at 19:30 (still before midnight) targets tomorrow's 05:00
//    -> tomorrow_date. A "recovery" request at 02:00 the next calendar day
//    (still logically "night", clock already past midnight but before 05:00)
//    targets the 05:00 later THAT SAME calendar day -> dateContext.date --
//    which is the same upcoming 05:00 a 19:30 request the evening before
//    would also have targeted (tomorrow_date from that earlier vantage
//    point), not a new, later one.
function computeTargetDate(window, dateContext) {
  if (!dateContext || typeof dateContext.date !== 'string') {
    return null;
  }
  if (window !== 'night') {
    return dateContext.date;
  }
  const time = typeof dateContext.time === 'string' ? dateContext.time : null;
  if (time && time < '05:00') {
    return dateContext.date;
  }
  return dateContext.tomorrow_date || null;
}

function rowToPackResult(row) {
  if (!row) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(row.pack_json);
  } catch (err) {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.phrases) || parsed.phrases.length === 0) {
    return null;
  }
  return { pack_id: `pack_${row.id}`, local_date: row.local_date, phrases: parsed.phrases };
}

// Resolves the morning_pack field for a supports_morning_pack=1 /batch
// request. Never throws -- every failure (weather lookup, OpenAI, DB race,
// anything) is caught and logged, returning null (no pack this time) rather
// than ever affecting the ordinary batch response this is called alongside
// (see routes/batch.js, which also wraps this call in its own try/catch as
// defense in depth).
async function getOrGenerateMorningPack({ device, window, dateContext, signals, weather, ip, packDateHeld, geo }) {
  try {
    const targetDate = computeTargetDate(window, dateContext);
    if (!targetDate) {
      return null;
    }
    // Rule 2: only returned if the phone doesn't already have this exact
    // pack cached.
    if (packDateHeld && packDateHeld === targetDate) {
      return null;
    }

    const existing = selectPackStatement.get(device.device_id, targetDate);
    if (existing) {
      return rowToPackResult(existing);
    }

    // geo (optional, from routes/batch.js's single shared resolveGeolocation
    // call for this request): reused here instead of resolveWeatherForecast
    // making its own second ipwho.is call. If the caller didn't pass it
    // (e.g. a direct test call), resolveWeatherForecast falls back to
    // resolving geolocation itself, same as before.
    const weatherForecast = geo !== undefined
      ? await resolveWeatherForecast(ip, targetDate, geo)
      : await resolveWeatherForecast(ip, targetDate);
    const { phrases, trace } = await generateMorningPack(device, targetDate, signals, weather, weatherForecast);

    if (!Array.isArray(phrases) || phrases.length === 0) {
      // Nothing usable was generated (or generation failed) -- rule 4's
      // "empty resulting pack -> morning_pack: null", not an empty array.
      // Deliberately not stored: a later request for the same
      // (device_id, target_date) will simply retry generation instead of
      // being permanently stuck with an empty pack from a transient failure.
      return null;
    }

    const packJson = JSON.stringify({ phrases });
    const traceJson = trace ? JSON.stringify(trace) : null;

    let row;
    try {
      const result = insertPackStatement.run(device.device_id, targetDate, packJson, traceJson);
      row = { id: result.lastInsertRowid };
    } catch (err) {
      // UNIQUE(device_id, local_date) race: a concurrent request for the
      // same device/target_date won the insert first. Read back its row
      // instead of failing or double-storing -- generation may have run
      // twice in this narrow race window, but persistence (and therefore
      // what every future request sees) happens exactly once.
      const race = selectPackStatement.get(device.device_id, targetDate);
      if (race) {
        return rowToPackResult(race);
      }
      throw err;
    }

    if (traceJson) {
      console.log(`[pack-trace] ${traceJson}`);
    }

    return { pack_id: `pack_${row.id}`, local_date: targetDate, phrases };
  } catch (err) {
    console.error(`MORNING_PACK_ERROR error=${err.name || 'Error'}`);
    return null;
  }
}

module.exports = {
  computeTargetDate,
  getOrGenerateMorningPack,
};
