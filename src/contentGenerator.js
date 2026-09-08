const { STYLE_IDS, BATCH_SIZE } = require('./constants');

const FALLBACK_PHRASES = [
  'A good day starts with you',
  "You're doing better than you think",
  'Take a deep breath',
  'Small steps lead to big changes',
  'Today is a great day to try something new',
  "Don't forget to call someone you love",
  'Smile — just because',
  'A little water never hurts',
  "You've already come a long way",
  'Give yourself a little rest if you need it',
];

function pickRandomStyle() {
  return STYLE_IDS[Math.floor(Math.random() * STYLE_IDS.length)];
}

function pickRandomFallbackPhrase() {
  return FALLBACK_PHRASES[Math.floor(Math.random() * FALLBACK_PHRASES.length)];
}

// Heuristic Latin-script check for language reliability: SYSTEM_PROMPT demands
// English, but gpt-4o-mini occasionally drifts into another language on an
// individual phrase within an otherwise-English batch (observed in practice
// for Russian, not theoretical). Requires at least one Latin letter and
// rejects any Cyrillic letter — short lock-screen phrases have no legitimate
// reason to mix in Cyrillic text.
function isValidEnglishText(text) {
  return /[a-zA-Z]/.test(text) && !/[а-яА-ЯёЁ]/.test(text);
}

// Date/day-of-week is deliberately NOT a client-sent signal (see
// PRODUCT_REBUILD_PLAN.md server contract docs) — the server already has the
// device's IANA timezone (e.g. "Asia/Almaty") from /register
// (TimeZone.getDefault().getID() on the Android side), so it can compute the
// device's local date/weekday itself rather than trusting/parsing a second
// client-sent value that would just have to agree with the timezone anyway.
// Returns null if there's no timezone on file yet, or it's not a timezone
// Intl recognizes (Intl.DateTimeFormat throws RangeError on an invalid one).
function getLocalDateContext(timezone) {
  if (!timezone) {
    return null;
  }
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
    });
    const parts = formatter.formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    const weekday = get('weekday');
    if (!weekday) {
      return null;
    }
    return { date, weekday };
  } catch (err) {
    return null;
  }
}

function buildFallbackBatch() {
  const shuffled = [...FALLBACK_PHRASES].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, BATCH_SIZE).map((text) => ({
    text,
    style_id: pickRandomStyle(),
  }));
}

// Builds the user-context prompt sent to the model. Deliberately excludes
// anything not already agreed in PRODUCT_REBUILD_PLAN.md §5.1 — no location,
// no notification/app data (see the plan's data-source list).
//
// `signals` (optional) holds whichever device signals the client sent with
// this /batch request — see src/deviceSignals.js. Each is appended only if
// present; a device that didn't send a signal (older client, permission not
// granted, sensor unavailable) simply doesn't get that line, same as the
// existing survey fields above. Phrased descriptively, not as raw numbers
// handed to the model, so the model reads them as loose context rather than
// literal instructions — consistent with the system prompt's "don't be too
// literal" guidance below.
//
// system_language/region are personalization context only, same as every
// other field here (gender, interests, timezone, etc.) — they do NOT select
// the output language. Generated text is always English (see SYSTEM_PROMPT);
// a locale-driven output language is a distinct, larger future feature, not
// implemented by this signal.
function buildContextPrompt(device, window, signals, weather) {
  const parts = [];
  if (device.gender) parts.push(`gender: ${device.gender}`);
  if (device.birth_date) parts.push(`birth date: ${device.birth_date}`);
  if (device.interests) {
    try {
      const interests = JSON.parse(device.interests);
      if (Array.isArray(interests) && interests.length) {
        parts.push(`interests: ${interests.join(', ')}`);
      }
    } catch (_) {
      // malformed stored JSON — skip rather than fail the whole request
    }
  }
  if (device.personal_goal) parts.push(`personal goal: ${device.personal_goal}`);
  if (device.tone) parts.push(`tone: ${device.tone}`);
  if (device.timezone) {
    parts.push(`timezone: ${device.timezone}`);
    const dateContext = getLocalDateContext(device.timezone);
    if (dateContext) {
      parts.push(`device local date: ${dateContext.date} (${dateContext.weekday})`);
    }
  }
  parts.push(`time of day: ${window}`);

  if (signals) {
    if (signals.battery_level !== undefined) {
      parts.push(`phone battery level: ${signals.battery_level}%`);
    }
    if (signals.ambient_light !== undefined) {
      parts.push(`ambient light: ${signals.ambient_light} lux`);
    }
    if (signals.screen_on_duration_seconds !== undefined) {
      parts.push(`screen was last on for: ${signals.screen_on_duration_seconds} sec`);
    }
    if (signals.steps_since_last_batch !== undefined) {
      parts.push(`steps since last window: ${signals.steps_since_last_batch}`);
    }
    if (signals.unlocks_since_last_batch !== undefined) {
      parts.push(`unlocks since last window: ${signals.unlocks_since_last_batch}`);
    }
    if (signals.system_language !== undefined) {
      parts.push(`device system language: ${signals.system_language}`);
    }
    if (signals.region !== undefined) {
      parts.push(`device region: ${signals.region}`);
    }
  }

  if (weather) {
    const weatherBits = [];
    if (weather.city) weatherBits.push(weather.city);
    weatherBits.push(`${Math.round(weather.temperatureC)}°C`);
    if (weather.description) weatherBits.push(weather.description);
    parts.push(`weather: ${weatherBits.join(', ')}`);
  }

  return parts.join('; ');
}

const SYSTEM_PROMPT = `You are a generator of short phrases for a phone lock screen (live wallpaper).
Return a JSON object with a "phrases" field — an array of exactly ${BATCH_SIZE} objects.
Each object: {"text": "a short phrase in English, up to 80 characters", "style_id": one of [${STYLE_IDS.join(', ')}]}.
Phrases should be warm, short, varied in topic (no repeats), suitable for a brief glance at a lock screen — not pushy, no ads, no questions that require an answer.
Take the user's context into account if it's provided, but don't be too literal / don't echo personal data back in the text.
IMPORTANT: every phrase "text" must be entirely in English, without a single word or letter in Russian or any other language — do not switch to another language for individual words or whole phrases, even if it seems stylistically fitting.
Respond with JSON only, no explanations.`;

/**
 * Generates a batch of {text, style_id} phrases for a device.
 * Falls back to a local static batch if no API key is configured or the
 * OpenAI call fails for any reason — the endpoint should never 500 just
 * because content generation had a bad day.
 *
 * @param {object} device - row from the devices table (or a stub {device_id})
 * @param {string} window - 'morning' | 'day' | 'evening' | 'night'
 * @param {object} [signals] - optional device signals from deviceSignals.js
 * @param {object} [weather] - optional weather from weather.js (resolveWeather)
 * @returns {Promise<{phrases: Array<{text: string, style_id: string}>, source: 'openai'|'fallback'}>}
 */
async function generateBatch(device, window, signals, weather) {
  const apiKey = process.env.OPENAI_API_KEY;
  const context = buildContextPrompt(device, window, signals, weather);

  if (!apiKey) {
    return { phrases: buildFallbackBatch(), source: 'fallback', context };
  }

  try {
    // Lazy require: avoids crashing at startup if the package is present but
    // no key is set yet, and keeps the fallback path dependency-free.
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey });

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: context },
      ],
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    const phrases = Array.isArray(parsed.phrases) ? parsed.phrases : [];

    // Validate style_id against the fixed set — never forward a value the
    // Android client wouldn't recognize (see constants.js comment).
    const cleaned = phrases
      .filter((p) => p && typeof p.text === 'string' && p.text.trim().length > 0)
      .map((p) => ({
        text: p.text.trim(),
        style_id: STYLE_IDS.includes(p.style_id) ? p.style_id : pickRandomStyle(),
      }));

    if (cleaned.length === 0) {
      return { phrases: buildFallbackBatch(), source: 'fallback', context };
    }

    // Language reliability: swap out only the individual phrases that failed
    // the Latin-script check for a random local fallback phrase, rather than
    // retrying the whole OpenAI call — a full retry would double the token
    // cost and latency of every batch that has even one bad phrase, for a
    // failure mode this cheap per-phrase substitution already fixes. The
    // batch is still reported as 'openai' since it's still mostly
    // AI-generated; only the substitution count is logged for visibility.
    let invalidCount = 0;
    const languageChecked = cleaned.map((p) => {
      if (isValidEnglishText(p.text)) {
        return p;
      }
      invalidCount += 1;
      return { text: pickRandomFallbackPhrase(), style_id: p.style_id };
    });
    if (invalidCount > 0) {
      console.warn(`Replaced ${invalidCount}/${cleaned.length} OpenAI phrase(s) that failed the English-language check`);
    }

    return { phrases: languageChecked, source: 'openai', context };
  } catch (err) {
    console.error('OpenAI batch generation failed, using fallback:', err.message);
    return { phrases: buildFallbackBatch(), source: 'fallback', context };
  }
}

module.exports = { generateBatch, buildFallbackBatch };
