// Weather for the incoming request -- server-side only, no GPS/location
// permission on the client (see PRODUCT_REBUILD_PLAN.md §5.1).
//
// Two independent third-party calls:
//   1. Where: the device's chosen city (city_geoname_id -> coordinates from
//      src/cities.js) if it has one, otherwise ipwho.is (IP -> approximate
//      country + city + latitude/longitude).
//   2. What: MET Norway Locationforecast 2.0, `complete` variant
//      (https://api.met.no/weatherapi/locationforecast/2.0/complete) -> the
//      forecast for the user's LOCAL date.
//
// Was Open-Meteo until 2026-09-30 -- replaced because Open-Meteo's free API
// excludes commercial use, and because its failures were invisible (every
// error was swallowed into `null`). MET Norway data is licensed under
// NLOD 2.0 / CC BY 4.0: the app has to credit "MET Norway" (see the
// attribution note in README/the task report).
//
// MET Norway's rules, all followed here:
//   - Identify the app in User-Agent (WEATHER_USER_AGENT, default below).
//   - Coordinates truncated to at most 4 decimals (we use 2: ~1 km).
//   - Don't repeat a request before the `Expires` response header, cache
//     locally, and revalidate with `If-Modified-Since` (a 304 keeps the cached
//     body).
//   - Cache by rounded coordinates for several hours (CACHE_TTL_MS).
//
// A failed weather lookup never fails /batch: the caller gets an object with a
// `weatherFailure` reason (also logged) and the weather slot is replaced by the
// usual fallback. Same principle as src/deviceSignals.js: this is enrichment
// context for the AI prompt, not a required field.

const IPWHOIS_TIMEOUT_MS = 2000;
const DEFAULT_USER_AGENT = 'ai-lockscreen-server/1.0 volaris.kz';
const MET_ENDPOINT = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';

// A cached forecast is reused without any request for this long (or until its
// own Expires, whichever is later).
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
// If MET Norway cannot be reached, a cached forecast up to this old is still
// better than no weather at all.
const MAX_STALE_MS = 12 * 60 * 60 * 1000;
// After a failed request the same coordinates are not retried for this long.
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const COORD_DECIMALS = 2;

let metTimeoutMs = 6000;
let fetchImpl = (url, options) => fetch(url, options);

function userAgent() {
  return process.env.WEATHER_USER_AGENT || DEFAULT_USER_AGENT;
}

// --- ipwho.is (IP -> coordinates), unchanged ---------------------------------

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// req.ip reports the local loopback/private address during local development
// (127.0.0.1, ::1, 192.168.x.x, etc.) -- ipwho.is can't geolocate these, so
// skip the network call entirely rather than let it fail slowly.
function isPrivateOrLocalIp(ip) {
  if (!ip) return true;
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('192.168.') ||
    ip.startsWith('10.') ||
    ip.startsWith('172.16.') ||
    ip.startsWith('::ffff:127.') ||
    ip.startsWith('::ffff:192.168.') ||
    ip.startsWith('::ffff:10.')
  );
}

// Shared IP -> geolocation lookup (ipwho.is), resolved ONCE per request and
// reused for both the ordinary weather and the morning pack forecast -- see
// routes/batch.js. Returns the raw ipwho.is object (success/country_code/city/
// latitude/longitude), or null if the IP is private/local or the lookup failed.
async function resolveGeolocation(ip) {
  if (isPrivateOrLocalIp(ip)) {
    return null;
  }
  const geo = await fetchJsonWithTimeout(
    `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code,city,latitude,longitude`,
    IPWHOIS_TIMEOUT_MS
  );
  if (!geo || geo.success !== true) {
    return null;
  }
  return geo;
}

// --- MET Norway --------------------------------------------------------------

function roundCoord(value) {
  const factor = 10 ** COORD_DECIMALS;
  return Math.round(value * factor) / factor;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// Keeps only what the forecast summary needs, so the cache stays small.
function parseMetTimeseries(json) {
  const series = json && json.properties && Array.isArray(json.properties.timeseries)
    ? json.properties.timeseries
    : null;
  if (!series) {
    return [];
  }
  const entries = [];
  for (const item of series) {
    const t = Date.parse(item && item.time);
    if (Number.isNaN(t)) {
      continue;
    }
    const data = (item && item.data) || {};
    const instant = (data.instant && data.instant.details) || {};
    const next1 = data.next_1_hours;
    const next6 = data.next_6_hours;
    const next12 = data.next_12_hours;
    const chosen = next1 ? { hours: 1, block: next1 } : next6 ? { hours: 6, block: next6 } : null;
    const probs = [next1, next6, next12]
      .map((block) => num(block && block.details && block.details.probability_of_precipitation))
      .filter((value) => value !== undefined);
    const period = chosen
      ? {
        hours: chosen.hours,
        symbol: (chosen.block.summary && chosen.block.summary.symbol_code) || null,
        amount: num(chosen.block.details && chosen.block.details.precipitation_amount),
        tmax: num(chosen.block.details && chosen.block.details.air_temperature_max),
        tmin: num(chosen.block.details && chosen.block.details.air_temperature_min),
      }
      : null;
    const fallbackSymbol = (next12 && next12.summary && next12.summary.symbol_code) || null;
    entries.push({
      t,
      temp: num(instant.air_temperature),
      uv: num(instant.ultraviolet_index_clear_sky),
      prob: probs.length ? Math.max(...probs) : undefined,
      period,
      symbol: (period && period.symbol) || fallbackSymbol,
    });
  }
  return entries;
}

const cache = new Map();      // "lat,lon" -> { timeseries, lastModified, expiresMs, fetchedAt }
const inflight = new Map();   // "lat,lon" -> Promise
const failureUntil = new Map(); // "lat,lon" -> { until, reason }

function failureReasonFor(err) {
  if (err && err.name === 'AbortError') {
    return 'timeout';
  }
  const code = err && (err.code || (err.cause && err.cause.code));
  return `network_error:${code || (err && err.name) || 'unknown'}`;
}

async function requestMet(key, lat, lon, entry) {
  const url = `${MET_ENDPOINT}?lat=${lat.toFixed(COORD_DECIMALS)}&lon=${lon.toFixed(COORD_DECIMALS)}`;
  const headers = { 'User-Agent': userAgent(), Accept: 'application/json' };
  if (entry && entry.lastModified) {
    headers['If-Modified-Since'] = entry.lastModified;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), metTimeoutMs);
  const now = Date.now();
  try {
    let response;
    try {
      response = await fetchImpl(url, { headers, signal: controller.signal });
    } catch (err) {
      return { ok: false, reason: failureReasonFor(err) };
    }

    const expiresMs = Date.parse(response.headers.get('expires')) || 0;
    if (response.status === 304 && entry) {
      entry.fetchedAt = now;
      entry.expiresMs = expiresMs || entry.expiresMs;
      return { ok: true, timeseries: entry.timeseries, from: 'revalidated' };
    }
    if (!response.ok) {
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      return {
        ok: false,
        reason: `http_${response.status}`,
        retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0,
      };
    }
    let json;
    try {
      json = await response.json();
    } catch (err) {
      return { ok: false, reason: 'invalid_json' };
    }
    const timeseries = parseMetTimeseries(json);
    if (timeseries.length === 0) {
      return { ok: false, reason: 'empty_timeseries' };
    }
    cache.set(key, {
      timeseries,
      lastModified: response.headers.get('last-modified') || null,
      expiresMs,
      fetchedAt: now,
    });
    return { ok: true, timeseries, from: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// Returns { ok: true, timeseries, from } or { ok: false, reason }.
async function fetchMet(latitude, longitude) {
  const lat = roundCoord(latitude);
  const lon = roundCoord(longitude);
  const key = `${lat.toFixed(COORD_DECIMALS)},${lon.toFixed(COORD_DECIMALS)}`;
  const now = Date.now();
  const entry = cache.get(key);

  if (entry && now < Math.max(entry.fetchedAt + CACHE_TTL_MS, entry.expiresMs || 0)) {
    return { ok: true, timeseries: entry.timeseries, from: 'cache' };
  }
  const blocked = failureUntil.get(key);
  if (blocked && now < blocked.until) {
    return staleOrFailure(entry, now, blocked.reason);
  }
  if (inflight.has(key)) {
    return inflight.get(key);
  }

  const promise = (async () => {
    const result = await requestMet(key, lat, lon, entry);
    if (result.ok) {
      failureUntil.delete(key);
      return result;
    }
    failureUntil.set(key, {
      until: Date.now() + Math.max(FAILURE_BACKOFF_MS, result.retryAfterMs || 0),
      reason: result.reason,
    });
    return staleOrFailure(entry, Date.now(), result.reason);
  })();
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

function staleOrFailure(entry, now, reason) {
  if (entry && now < entry.fetchedAt + MAX_STALE_MS) {
    console.warn(`WEATHER_STALE_USED provider=met.no reason=${reason} age_min=${Math.round((now - entry.fetchedAt) / 60000)}`);
    return { ok: true, timeseries: entry.timeseries, from: 'stale', reason };
  }
  return { ok: false, reason };
}

// --- forecast for one local date ---------------------------------------------

function localDateOf(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ms));
  } catch (err) {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

// MET symbol_code ("lightrainshowers_day", "clearsky_night", ...) ->
// [severity, plain description]. The descriptions keep the vocabulary the
// planner's weatherConditionLean() already understands (rain/snow/sun/cloudy).
function symbolToDescription(symbolCode) {
  const code = String(symbolCode || '').replace(/_(day|night|polartwilight)$/, '');
  if (!code) return null;
  if (code.includes('thunder')) return { severity: 9, description: 'thunderstorm' };
  const heavy = code.startsWith('heavy');
  const light = code.startsWith('light');
  const strength = heavy ? 'heavy ' : light ? 'light ' : '';
  if (code.includes('sleet')) return { severity: heavy ? 8 : 7, description: 'sleet' };
  if (code.includes('snowshowers')) return { severity: 7, description: 'snow' };
  if (code.includes('snow')) return { severity: heavy ? 8 : light ? 5 : 7, description: `${strength}snow` };
  if (code.includes('rainshowers')) return { severity: heavy ? 8 : 6, description: heavy ? 'heavy rain showers' : 'rain showers' };
  if (code.includes('rain')) return { severity: heavy ? 8 : light ? 5 : 7, description: `${strength}rain` };
  if (code === 'fog') return { severity: 4, description: 'fog' };
  if (code === 'cloudy') return { severity: 3, description: 'overcast' };
  if (code === 'partlycloudy') return { severity: 2, description: 'partly cloudy' };
  if (code === 'fair') return { severity: 1, description: 'mostly clear' };
  if (code === 'clearsky') return { severity: 0, description: 'clear' };
  return null;
}

function isWetSymbol(symbolCode) {
  return /rain|snow|sleet|thunder/.test(String(symbolCode || ''));
}

// MET only publishes probability_of_precipitation for the Nordic region; for
// the rest of the world the forecast has amounts and symbols but no
// probability. In that case a coarse percentage is derived from the day's
// precipitation so the planner's rain_chance (>60 high, >=30 medium) still
// works. Derived, not measured: precipitationSource says which one it is.
function derivePrecipitationChance(dayEntries) {
  let total = 0;
  let anyWet = false;
  let heavy = false;
  for (const entry of dayEntries) {
    const period = entry.period;
    if (!period) continue;
    const amount = period.amount || 0;
    total += amount;
    if (isWetSymbol(period.symbol)) anyWet = true;
    if ((period.hours === 1 && amount >= 1) || (period.hours >= 6 && amount >= 4)
      || /heavy|thunder/.test(String(period.symbol || ''))) {
      heavy = true;
    }
  }
  if (heavy) return 80;
  if (total >= 1) return 65;
  if (total >= 0.3 || anyWet) return 40;
  if (total > 0) return 20;
  return 5;
}

// Day summary for `dateStr` (YYYY-MM-DD in `timeZone`) with the same fields the
// old Open-Meteo forecast had, so slotPlanner's bands need no new inputs:
// temperatureC = the day's max, temperatureMinC = the day's min,
// precipitationProbabilityMax, uvIndexMax (MET gives the clear-sky UV index),
// description.
function summarizeForDate(timeseries, dateStr, timeZone) {
  const targetDate = dateStr || (timeseries.length ? localDateOf(timeseries[0].t, timeZone) : null);
  const dayEntries = timeseries.filter((entry) => localDateOf(entry.t, timeZone) === targetDate);
  if (dayEntries.length === 0) {
    return null;
  }
  const temps = [];
  let uvMax;
  let probMax;
  let worst = null;
  for (const entry of dayEntries) {
    if (entry.temp !== undefined) temps.push(entry.temp);
    if (entry.period) {
      if (entry.period.tmax !== undefined) temps.push(entry.period.tmax);
      if (entry.period.tmin !== undefined) temps.push(entry.period.tmin);
    }
    if (entry.uv !== undefined && (uvMax === undefined || entry.uv > uvMax)) uvMax = entry.uv;
    if (entry.prob !== undefined && (probMax === undefined || entry.prob > probMax)) probMax = entry.prob;
    const described = symbolToDescription(entry.symbol);
    if (described && (!worst || described.severity > worst.severity)) worst = described;
  }
  if (temps.length === 0) {
    return null;
  }
  const summary = {
    temperatureC: Math.max(...temps),
    temperatureMinC: Math.min(...temps),
    description: worst ? worst.description : null,
  };
  if (probMax !== undefined) {
    summary.precipitationProbabilityMax = probMax;
    summary.precipitationSource = 'met_probability';
  } else {
    summary.precipitationProbabilityMax = derivePrecipitationChance(dayEntries);
    summary.precipitationSource = 'derived_from_amount';
  }
  if (uvMax !== undefined) {
    summary.uvIndexMax = uvMax;
  }
  return summary;
}

// Resolves { countryCode, city, forecast: true, temperatureC, ... } for the
// given coordinates and local date, or { countryCode, city, weatherFailure }
// with the exact reason (also logged) when weather is not available.
async function forecastFor(latitude, longitude, meta, targetDate) {
  const countryCode = (meta && meta.countryCode) || null;
  const city = (meta && meta.city) || null;
  const timeZone = (meta && meta.timeZone) || null;
  const result = await fetchMet(latitude, longitude);
  if (!result.ok) {
    console.warn(`WEATHER_FAILED provider=met.no reason=${result.reason} date=${targetDate || 'today'}`);
    return { countryCode, city, weatherFailure: result.reason };
  }
  const summary = summarizeForDate(result.timeseries, targetDate, timeZone);
  if (!summary) {
    console.warn(`WEATHER_FAILED provider=met.no reason=no_data_for_date date=${targetDate || 'today'}`);
    return { countryCode, city, weatherFailure: 'no_data_for_date' };
  }
  return { countryCode, city, forecast: true, provider: 'met.no', ...summary };
}

function geoMeta(geo, options) {
  return {
    countryCode: typeof geo.country_code === 'string' && geo.country_code ? geo.country_code : null,
    city: geo.city || null,
    timeZone: options && options.timeZone,
  };
}

/**
 * Weather for the /batch request itself, from the device's IP.
 * @param {string} ip - the requesting client's IP (req.ip, real client thanks to 'trust proxy')
 * @param {object|null} [precomputedGeo] - an already-resolved ipwho.is object
 *   (null = "resolved, nothing found"); omit (undefined) to resolve it here.
 * @param {{localDate?: string, timeZone?: string}} [options] - the user's local
 *   date (YYYY-MM-DD) and IANA timezone: the forecast is for that date.
 * @returns {Promise<object|null>} null when there is no usable IP/geolocation
 */
async function resolveWeather(ip, precomputedGeo, options) {
  if (isPrivateOrLocalIp(ip)) {
    return null;
  }
  const geo = precomputedGeo !== undefined ? precomputedGeo : await resolveGeolocation(ip);
  if (!geo) {
    return null;
  }
  const meta = geoMeta(geo, options);
  if (typeof geo.latitude !== 'number' || typeof geo.longitude !== 'number') {
    return { countryCode: meta.countryCode, city: meta.city, weatherFailure: 'no_coordinates' };
  }
  return forecastFor(geo.latitude, geo.longitude, meta, options && options.localDate);
}

// City-based counterpart -- used once a device has picked a city
// (device.city_geoname_id): the city's own coordinates outrank IP entirely, and
// no IP/ipwho.is call is made at all (see routes/batch.js).
// meta: { countryCode, city, localDate?, timeZone? }
async function resolveWeatherByCoords(lat, lon, meta) {
  const countryCode = (meta && meta.countryCode) || null;
  const city = (meta && meta.city) || null;
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return { countryCode, city, weatherFailure: 'no_coordinates' };
  }
  return forecastFor(lat, lon, meta, meta && meta.localDate);
}

module.exports = {
  resolveWeather,
  resolveGeolocation,
  resolveWeatherByCoords,
  isPrivateOrLocalIp,
  _test: {
    parseMetTimeseries,
    summarizeForDate,
    symbolToDescription,
    userAgent,
    CACHE_TTL_MS,
    setFetch(fn) {
      fetchImpl = fn || ((url, options) => fetch(url, options));
    },
    setTimeoutMs(ms) {
      metTimeoutMs = ms;
    },
    resetCache() {
      cache.clear();
      inflight.clear();
      failureUntil.clear();
    },
    expireCache(ageMs) {
      for (const entry of cache.values()) {
        entry.fetchedAt -= ageMs;
        if (entry.expiresMs) entry.expiresMs -= ageMs;
      }
    },
    clearFailureBackoff() {
      failureUntil.clear();
    },
  },
};
