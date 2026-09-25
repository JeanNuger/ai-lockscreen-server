// Resolves weather for the incoming request's IP address — server-side only,
// no GPS/location permission on the client (see PRODUCT_REBUILD_PLAN.md §5.1:
// "погода — по IP-адресу входящего запроса, без GPS/геолокации на телефоне").
// Two independent third-party calls, both free/keyless:
//   1. ipwho.is: IP -> approximate country + city + latitude/longitude
//   2. Open-Meteo: lat/lon -> current weather
// A failed IP lookup degrades to no geo/weather; a failed weather lookup still
// keeps the approximate country/city from the IP lookup when available. Either
// path avoids failing the /batch request — same principle as
// src/deviceSignals.js: this is enrichment context for the AI prompt, not a
// required field.
//
// Was ip-api.com until 2026-09-10 — replaced because ip-api.com's free tier
// ToS explicitly excludes commercial use ("strictly limited for a
// non-commercial purpose"), a real risk for a paid Google Play product.
// ipwho.is's own FAQ states "Commercial use is allowed on all plans,
// including Free" (verified 2026-09-10, see PRODUCT_REBUILD_PLAN.md §5.1
// for the full comparison against ipapi.co/ipinfo.io/freeipapi.com that led
// to this choice). Free tier: 1000 requests/day, no API key. At this
// project's current scale (single-digit registered devices, 4 fetch windows/
// day/device) that's nowhere near the limit; revisit if the user base grows
// toward roughly 250 devices (1000 / 4 windows), either with ipwho.is's paid
// tier or the weather-cache item already in the Post-MVP roadmap.

const IPWHOIS_TIMEOUT_MS = 2000;
const OPEN_METEO_TIMEOUT_MS = 2000;

// WMO weather codes (used by Open-Meteo) collapsed into short human-readable
// descriptions — only the buckets relevant to a passing lock-screen glance,
// not full meteorological precision.
const WEATHER_CODE_DESCRIPTIONS = {
  0: 'clear',
  1: 'mostly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'rime fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'heavy drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  80: 'rain showers',
  81: 'heavy rain showers',
  82: 'violent rain showers',
  95: 'thunderstorm',
};

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
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
// (127.0.0.1, ::1, 192.168.x.x, etc.) — ipwho.is can't geolocate these, so
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

/**
 * @param {string} ip - the requesting client's IP (req.ip, with Express
 *   'trust proxy' configured so this is the real client, not the reverse proxy)
 * @returns {Promise<{countryCode: string|null, city: string|null, temperatureC?: number, description?: string|null} | null>}
 */
async function resolveWeather(ip) {
  if (isPrivateOrLocalIp(ip)) {
    return null;
  }

  const geo = await fetchWithTimeout(
    `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code,city,latitude,longitude`,
    IPWHOIS_TIMEOUT_MS
  );
  if (!geo || geo.success !== true) {
    return null;
  }
  const countryCode = typeof geo.country_code === 'string' && geo.country_code ? geo.country_code : null;
  const city = geo.city || null;
  if (typeof geo.latitude !== 'number' || typeof geo.longitude !== 'number') {
    return { countryCode, city };
  }

  const weather = await fetchWithTimeout(
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}&current_weather=true`,
    OPEN_METEO_TIMEOUT_MS
  );
  const current = weather && weather.current_weather;
  if (!current || typeof current.temperature !== 'number') {
    return { countryCode, city };
  }

  return {
    countryCode,
    city,
    temperatureC: current.temperature,
    description: WEATHER_CODE_DESCRIPTIONS[current.weathercode] || null,
  };
}

// --- Morning pack forecast (added for the morning-pack feature) ---
// The pack is generated the evening before for a future calendar day
// (target_date), so it needs a DAY forecast for that date rather than
// `current_weather`. Open-Meteo's `daily` parameter gives exactly that.
// Follows the same "never fail the caller, degrade to null" philosophy as
// resolveWeather above, plus a small in-memory cache -- unlike resolveWeather
// (called once per live /batch request, so a miss is cheap), the pack path
// can be hit by several requests for the same device/date in a short window
// (retries, repeated requests before the pack is stored), so caching by
// rounded coordinates + target date for a few hours avoids redundant
// Open-Meteo calls for what is, for this purpose, the same forecast.
const FORECAST_CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
const forecastCache = new Map();

// Rounds to 1 decimal degree (~11km at the equator) -- plenty precise for a
// "umbrella vs sunglasses" lock-screen lifehack, and coalesces nearby
// requests (e.g. two devices in the same city) onto the same cache entry.
function roundCoord(value) {
  return Math.round(value * 10) / 10;
}

function pruneExpiredForecastCacheEntries(now) {
  for (const [key, entry] of forecastCache) {
    if (now - entry.at >= FORECAST_CACHE_TTL_MS) {
      forecastCache.delete(key);
    }
  }
}

/**
 * @param {string} ip - the requesting client's IP (see resolveWeather)
 * @param {string} targetDate - YYYY-MM-DD, the calendar date to forecast
 * @returns {Promise<{countryCode: string|null, city: string|null, temperatureC?: number, description?: string|null} | null>}
 */
async function resolveWeatherForecast(ip, targetDate) {
  if (isPrivateOrLocalIp(ip) || typeof targetDate !== 'string' || !targetDate) {
    return null;
  }

  const geo = await fetchWithTimeout(
    `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code,city,latitude,longitude`,
    IPWHOIS_TIMEOUT_MS
  );
  if (!geo || geo.success !== true) {
    return null;
  }
  const countryCode = typeof geo.country_code === 'string' && geo.country_code ? geo.country_code : null;
  const city = geo.city || null;
  if (typeof geo.latitude !== 'number' || typeof geo.longitude !== 'number') {
    return { countryCode, city };
  }

  const now = Date.now();
  pruneExpiredForecastCacheEntries(now);
  const cacheKey = `${roundCoord(geo.latitude)},${roundCoord(geo.longitude)},${targetDate}`;
  const cached = forecastCache.get(cacheKey);
  if (cached) {
    return cached.value ? { ...cached.value, countryCode, city } : { countryCode, city };
  }

  const forecast = await fetchWithTimeout(
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}` +
      `&daily=weathercode,precipitation_probability_max,temperature_2m_max,temperature_2m_min,uv_index_max` +
      `&timezone=auto&start_date=${targetDate}&end_date=${targetDate}`,
    OPEN_METEO_TIMEOUT_MS
  );
  const daily = forecast && forecast.daily;
  const times = daily && Array.isArray(daily.time) ? daily.time : null;
  const dayIndex = times ? times.indexOf(targetDate) : -1;
  const tempMaxArr = daily && Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : null;
  const codeArr = daily && Array.isArray(daily.weathercode) ? daily.weathercode : null;

  if (dayIndex === -1 || !tempMaxArr || typeof tempMaxArr[dayIndex] !== 'number') {
    forecastCache.set(cacheKey, { at: now, value: null });
    return { countryCode, city };
  }

  // temperature_2m_max is used as the representative "for the day" figure --
  // the pack's weather_lifehack slot reasons about the day as a whole
  // (umbrella/sunglasses/warm clothes), not a single instant, and this reuses
  // the exact same temperatureBand/weatherConditionLean shaping as the
  // current-weather path (see slotPlanner.js), which only ever takes a single
  // temperatureC + description pair.
  const value = {
    temperatureC: tempMaxArr[dayIndex],
    description: (codeArr && WEATHER_CODE_DESCRIPTIONS[codeArr[dayIndex]]) || null,
  };
  forecastCache.set(cacheKey, { at: now, value });
  return { ...value, countryCode, city };
}

module.exports = { resolveWeather, resolveWeatherForecast };
