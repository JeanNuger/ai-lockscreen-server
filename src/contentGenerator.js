const { STYLE_IDS, BATCH_SIZE } = require('./constants');

// FALLBACK_PHRASES stay English-only — this is the offline/failure path (no
// OPENAI_API_KEY configured, the OpenAI call itself fails, or an individual
// phrase fails its language check below), not the primary path being
// localized here. Translating this list into all 10 supported languages is
// a deliberate scope cut, not an oversight — see PRODUCT_REBUILD_PLAN.md's
// note on this exact tradeoff. Known consequence: a device whose language
// isn't English will see English fallback text (for the whole batch, on a
// full OpenAI outage; or for just the substituted phrase(s), on a
// language-check failure) rather than no content — this is intentionally
// the "some content, wrong language" degradation, not "no content".
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

// The 10 languages product/DoD calls for (locale-driven generation task).
// Each entry names the language for the SYSTEM_PROMPT and a scriptCheck
// regex used to catch full-phrase language drift (see isValidLanguageText
// below) — not a translation-quality check, just "does this phrase contain
// at least one character from the script this language is expected to use".
// Latin-script languages (en/fr/es/pt/de/it) share one scriptCheck: this
// mirrors the previous English-only heuristic, which could only ever tell
// "Latin vs. not-Latin" apart too — distinguishing e.g. French from Italian
// text is not attempted, same scope boundary as before.
const SUPPORTED_LANGUAGES = {
  en: { name: 'English', scriptCheck: /\p{Script=Latin}/u },
  fr: { name: 'French', scriptCheck: /\p{Script=Latin}/u },
  es: { name: 'Spanish', scriptCheck: /\p{Script=Latin}/u },
  pt: { name: 'Portuguese', scriptCheck: /\p{Script=Latin}/u },
  de: { name: 'German', scriptCheck: /\p{Script=Latin}/u },
  ru: { name: 'Russian', scriptCheck: /\p{Script=Cyrillic}/u },
  zh: { name: 'Chinese', scriptCheck: /\p{Script=Han}/u },
  ja: { name: 'Japanese', scriptCheck: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u },
  ko: { name: 'Korean', scriptCheck: /\p{Script=Hangul}/u },
  it: { name: 'Italian', scriptCheck: /\p{Script=Latin}/u },
};
const DEFAULT_LANGUAGE_CODE = 'en';

// Resolves the target generation language from the client's system_language
// signal (see deviceSignals.js — already an ISO 639-1 code like "ru", "zh",
// validated there against /^[A-Za-z-]+$/). Anything missing or not in
// SUPPORTED_LANGUAGES falls back to English, per DoD point 2 — this covers
// both "client didn't send the signal" (older app version) and "client sent
// a real language we don't support yet" (e.g. Arabic) the same way.
function resolveTargetLanguageCode(signals) {
  const raw = signals && typeof signals.system_language === 'string'
    ? signals.system_language.toLowerCase()
    : null;
  return raw && SUPPORTED_LANGUAGES[raw] ? raw : DEFAULT_LANGUAGE_CODE;
}

function pickRandomStyle() {
  return STYLE_IDS[Math.floor(Math.random() * STYLE_IDS.length)];
}

function pickRandomFallbackPhrase() {
  return FALLBACK_PHRASES[Math.floor(Math.random() * FALLBACK_PHRASES.length)];
}

// Generalizes the old isValidEnglishText heuristic to any of the 10
// supported languages: SYSTEM_PROMPT demands a specific target language, but
// gpt-4o-mini occasionally drifts into another language on an individual
// phrase within an otherwise-correct batch (observed in practice for
// Russian, not theoretical). Checks only for "at least one character in the
// expected script" — a full-phrase drift into a different script family
// (e.g. Chinese requested, English-only text came back) has none, so it's
// caught; it does not try to catch drift between languages that share a
// script (e.g. French text when Italian was requested), same limitation the
// original English/Cyrillic-only check had.
function isValidLanguageText(text, languageCode) {
  const language = SUPPORTED_LANGUAGES[languageCode] || SUPPORTED_LANGUAGES[DEFAULT_LANGUAGE_CODE];
  return language.scriptCheck.test(text);
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

// Formats `instant` as the calendar date (YYYY-MM-DD) it falls on within
// `timezone` — the building block both getLocalDateContext (today's date)
// and getDaysSinceInstall (below) use, so "what calendar day is this" is
// computed the same way in both places, consistently in the device's own
// timezone rather than server UTC. Returns null if timezone is missing/not
// recognized by Intl (same convention as getLocalDateContext).
function getLocalCalendarDate(instant, timezone) {
  if (!timezone) {
    return null;
  }
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(instant);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch (err) {
    return null;
  }
}

// Days elapsed between a device's first appearance in the system
// (devices.created_at — set once at row creation by db/index.js's
// DEFAULT (datetime('now')), never touched again by register.js's
// ON CONFLICT update) and now, counted in the device's own local calendar
// days (see PRODUCT_REBUILD_PLAN.md §5.1) — not server UTC days, so the
// count doesn't roll over an hour or two before/after the user's actual
// local midnight, and not raw elapsed hours/24h periods either.
//
// The day of registration itself is day 0, not day 1 — a device that
// registered 10 minutes ago should read as "just installed" in the prompt,
// not "1 day in". Implemented by converting both createdAtUtc and "now" to
// calendar-date strings in the device's timezone (getLocalCalendarDate
// above) and diffing those as UTC midnights: since both are already
// timezone-adjusted calendar dates at that point, the ms difference divides
// out to an exact whole-day count with no further DST/offset arithmetic
// needed.
//
// Returns null (same "not enough info yet" convention as
// getLocalDateContext) if there's no timezone on file, or createdAtUtc is
// missing/unparseable — e.g. the very first /batch call for a brand-new
// device, made with the pre-insert `device` stub from routes/batch.js that
// has no created_at yet.
function getDaysSinceInstall(createdAtUtc, timezone) {
  if (!createdAtUtc || !timezone) {
    return null;
  }
  // SQLite's datetime('now') stores 'YYYY-MM-DD HH:MM:SS' as UTC but with no
  // 'Z'/offset suffix — append one explicitly so Date parses it as UTC
  // rather than as local server time.
  const installInstant = new Date(`${createdAtUtc.replace(' ', 'T')}Z`);
  if (Number.isNaN(installInstant.getTime())) {
    return null;
  }
  const installDate = getLocalCalendarDate(installInstant, timezone);
  const nowDate = getLocalCalendarDate(new Date(), timezone);
  if (!installDate || !nowDate) {
    return null;
  }
  const daysDiff = Math.round(
    (Date.parse(`${nowDate}T00:00:00Z`) - Date.parse(`${installDate}T00:00:00Z`)) / 86400000
  );
  // Floored at 0 defensively (should not go negative in practice — both
  // dates come from the same device's own timezone conversion — but a
  // negative "days since install" would be a confusing thing to hand the
  // model if clock skew or an edge case ever produced one).
  return daysDiff >= 0 ? daysDiff : 0;
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
// region is personalization context only, same as gender/interests/timezone
// above — it does not select the output language. system_language, by
// contrast, now ALSO drives the output language directly (see
// resolveTargetLanguageCode/buildSystemPrompt below) — it's still included
// here as a context line too, redundant with the system prompt's own
// language instruction, but harmless and consistent with how every other
// signal is surfaced to the model.
function buildContextPrompt(device, window, signals, weather) {
  const parts = [];
  if (device.name) parts.push(`name: ${device.name}`);
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
    // Placed here (not in the `signals` block below) because it's derived
    // from device.created_at + device.timezone, the same devices-table
    // fields the two lines above already use — not a per-request signal the
    // client sends, like battery_level/ambient_light/etc. are.
    const daysSinceInstall = getDaysSinceInstall(device.created_at, device.timezone);
    if (daysSinceInstall !== null) {
      parts.push(`days since install: ${daysSinceInstall}`);
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

// Builds the SYSTEM_PROMPT for a specific target language. Was a fixed
// English-only template constant before this task; now a function of
// languageCode so each request's prompt names its own resolved target
// language (see resolveTargetLanguageCode) instead of always saying
// "English" regardless of who's asking.
function buildSystemPrompt(languageCode) {
  const languageName = SUPPORTED_LANGUAGES[languageCode].name;
  return `You are a generator of short phrases for a phone lock screen (live wallpaper).
Return a JSON object with a "phrases" field — an array of exactly ${BATCH_SIZE} objects.
Each object: {"text": "a short phrase in ${languageName}, up to 80 characters", "style_id": one of [${STYLE_IDS.join(', ')}]}.
Phrases should be warm, short, varied in topic (no repeats), suitable for a brief glance at a lock screen — not pushy, no ads, no questions that require an answer.
Take the user's context into account if it's provided, but don't be too literal / don't echo personal data back in the text.
If a name is given in the context, you may address the user by it in some of the phrases for a personal touch — but not in every phrase, and never as a rule to force into all of them; most phrases should read naturally without it, so it doesn't feel repetitive or scripted.
IMPORTANT: every phrase "text" must be entirely in ${languageName}, without a single word or letter in any other language — do not switch to another language for individual words or whole phrases, even if it seems stylistically fitting.
Respond with JSON only, no explanations.`;
}

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
  const languageCode = resolveTargetLanguageCode(signals);

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
        { role: 'system', content: buildSystemPrompt(languageCode) },
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
    // the target-language script check for a random local fallback phrase,
    // rather than retrying the whole OpenAI call — a full retry would double the token
    // cost and latency of every batch that has even one bad phrase, for a
    // failure mode this cheap per-phrase substitution already fixes. The
    // batch is still reported as 'openai' since it's still mostly
    // AI-generated; only the substitution count is logged for visibility.
    let invalidCount = 0;
    const languageChecked = cleaned.map((p) => {
      if (isValidLanguageText(p.text, languageCode)) {
        return p;
      }
      invalidCount += 1;
      // Substituted with an English FALLBACK_PHRASES entry regardless of
      // languageCode -- see the FALLBACK_PHRASES comment above: translating
      // that list is an explicit, documented scope cut, so a substitution
      // for a non-English batch will be in English, not silently wrong in a
      // way nobody decided on.
      return { text: pickRandomFallbackPhrase(), style_id: p.style_id };
    });
    if (invalidCount > 0) {
      console.warn(`Replaced ${invalidCount}/${cleaned.length} OpenAI phrase(s) that failed the ${SUPPORTED_LANGUAGES[languageCode].name}-language check (target=${languageCode})`);
    }

    return { phrases: languageChecked, source: 'openai', context };
  } catch (err) {
    console.error('OpenAI batch generation failed, using fallback:', err.message);
    return { phrases: buildFallbackBatch(), source: 'fallback', context };
  }
}

module.exports = { generateBatch, buildFallbackBatch };
