// Resolves weather for the incoming request's IP address — server-side only,
// no GPS/location permission on the client (see PRODUCT_REBUILD_PLAN.md §5.1:
// "погода — по IP-адресу входящего запроса, без GPS/геолокации на телефоне").
// Two independent third-party calls, both free/keyless:
//   1. ip-api.com: IP -> city + lat/lon
//   2. Open-Meteo: lat/lon -> current weather
// Either step failing (timeout, bad IP, rate limit, service down) degrades to
// no weather rather than failing the /batch request — same principle as
// src/deviceSignals.js: this is enrichment context for the AI prompt, not a
// required field.
//
// KNOWN LIMITATION (flagged for a pre-launch decision, not fixed here):
// ip-api.com's free tier ToS excludes commercial use. Fine for development/
// testing now; needs a paid ip-api.com plan or a different provider before
// this ships in a commercial product (Google Play).

const IP_API_TIMEOUT_MS = 2000;
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
// (127.0.0.1, ::1, 192.168.x.x, etc.) — ip-api.com can't geolocate these, so
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
 * @returns {Promise<{city: string, temperatureC: number, description: string} | null>}
 */
async function resolveWeather(ip) {
  if (isPrivateOrLocalIp(ip)) {
    return null;
  }

  const geo = await fetchWithTimeout(
    `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,lat,lon`,
    IP_API_TIMEOUT_MS
  );
  if (!geo || geo.status !== 'success' || typeof geo.lat !== 'number' || typeof geo.lon !== 'number') {
    return null;
  }

  const weather = await fetchWithTimeout(
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current_weather=true`,
    OPEN_METEO_TIMEOUT_MS
  );
  const current = weather && weather.current_weather;
  if (!current || typeof current.temperature !== 'number') {
    return null;
  }

  return {
    city: geo.city || null,
    temperatureC: current.temperature,
    description: WEATHER_CODE_DESCRIPTIONS[current.weathercode] || null,
  };
}

module.exports = { resolveWeather };
