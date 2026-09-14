const { STYLE_IDS, BATCH_SIZE } = require('./constants');
const {
  selectBankItemsForDevice,
  recordShownCategories,
  getShownCategories,
  getUtcDateString,
  BANK_CATEGORIES,
} = require('./dailyContentBank');

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

// Computes the user's age in whole years from device.birth_date (an
// ISO-ish date string from the client, e.g. "1990-05-20"). Returns null if
// birth_date is missing or unparseable, so callers can omit the field
// entirely rather than send a garbage value to the model.
function computeAge(birthDate) {
  if (!birthDate) {
    return null;
  }
  const dob = new Date(birthDate);
  if (Number.isNaN(dob.getTime())) {
    return null;
  }
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDay = (now.getUTCMonth() - dob.getUTCMonth()) || (now.getUTCDate() - dob.getUTCDate());
  if (monthDay < 0) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}

// Builds the compact user-context object sent to the model, JSON-stringified
// as the user message. Deliberately excludes anything not already agreed in
// PRODUCT_REBUILD_PLAN.md §5.1 — no location, no notification/app data (see
// the plan's data-source list).
//
// Kept as a nested object (profile/now/signals/weather/today_content/
// already_shown) with only present fields included, rather than the old
// long "; "-joined sentence: shorter per request (fewer tokens for signals
// that don't apply to a given device/moment) and nothing here duplicates
// what's already fixed in the static system prompt.
//
// languageCode: the already-resolved target language (resolveTargetLanguageCode's
// output) — reported in `now.language` as a human name so the model doesn't
// have to map an ISO code itself.
// bankItems (optional): the subset of today's daily_content_bank rows chosen
// for this device by selectBankItemsForDevice (see dailyContentBank.js) --
// already filtered to categories the device hasn't seen yet today.
// shownCategories (optional): category names already shown to this device
// today (see dailyContentBank.js's getShownCategories) — listed so the model
// avoids repeating them, without re-sending the actual past phrases.
function buildContextPrompt(device, window, signals, weather, languageCode, bankItems, shownCategories) {
  const profile = {};
  if (device.name) profile.name = device.name;
  if (device.gender) profile.gender = device.gender;
  const age = computeAge(device.birth_date);
  if (age !== null) profile.age = age;
  if (device.interests) {
    try {
      const interests = JSON.parse(device.interests);
      if (Array.isArray(interests) && interests.length) {
        profile.interests = interests;
      }
    } catch (_) {
      // malformed stored JSON — skip rather than fail the whole request
    }
  }
  if (device.personal_goal) profile.personal_goal = device.personal_goal;
  if (device.tone) profile.tone = device.tone;

  // `language` is the resolved GENERATION target (resolveTargetLanguageCode's
  // output, e.g. falls back to English if the device's own language isn't
  // supported) -- not the same thing as the device's raw system_language
  // signal, so we also surface `device_language` below whenever the two
  // differ, otherwise the model would have no way to know a fallback
  // happened. `timezone` itself is deliberately NOT included here (unlike
  // the old "; "-joined context) -- the model only ever needs the derived
  // date/weekday/days_since_install below, not the raw IANA string.
  const now = { language: SUPPORTED_LANGUAGES[languageCode].name, window };
  if (signals && signals.system_language && signals.system_language !== languageCode) {
    now.device_language = signals.system_language;
  }
  if (signals && signals.region !== undefined) now.region = signals.region;
  if (device.timezone) {
    const dateContext = getLocalDateContext(device.timezone);
    if (dateContext) {
      now.date = dateContext.date;
      now.weekday = dateContext.weekday;
    }
    const daysSinceInstall = getDaysSinceInstall(device.created_at, device.timezone);
    if (daysSinceInstall !== null) {
      now.days_since_install = daysSinceInstall;
    }
  }

  const signalsOut = {};
  if (signals) {
    if (signals.steps_since_last_batch !== undefined) signalsOut.steps = signals.steps_since_last_batch;
    if (signals.unlocks_since_last_batch !== undefined) signalsOut.unlocks = signals.unlocks_since_last_batch;
    if (signals.battery_level !== undefined) signalsOut.battery_pct = signals.battery_level;
    if (signals.ambient_light !== undefined) signalsOut.ambient_light_lux = signals.ambient_light;
    if (signals.screen_on_duration_seconds !== undefined) signalsOut.screen_on_duration_sec = signals.screen_on_duration_seconds;
  }

  const ctx = { profile, now };
  if (Object.keys(profile).length === 0) delete ctx.profile;
  if (Object.keys(signalsOut).length > 0) ctx.signals = signalsOut;

  if (weather) {
    const weatherOut = { temperature_c: Math.round(weather.temperatureC) };
    if (weather.city) weatherOut.city = weather.city;
    if (weather.description) weatherOut.condition = weather.description;
    ctx.weather = weatherOut;
  }

  if (Array.isArray(bankItems) && bankItems.length > 0) {
    ctx.today_content = bankItems.map((item) => ({ category: item.category, text: item.content_text }));
  }

  if (Array.isArray(shownCategories) && shownCategories.length > 0) {
    ctx.already_shown = shownCategories;
  }

  return JSON.stringify(ctx);
}

// Builds the SYSTEM_PROMPT for a specific target language. Function of
// languageCode only (no regionCode) so the static prefix is byte-identical
// across every request in the same language regardless of which device's
// region happens to be set -- regionCode now travels only in the per-request
// context (buildContextPrompt's `now.region`), which lets an OpenAI-side
// prompt cache match this whole prefix across users of the same language
// instead of missing on the old regionCode-conditional branch.
//
// The "occasional country fact" instruction is therefore now unconditional
// static text (previously only appended when a region was present) -- it's
// a no-op on a request with no region in context, and still deliberately
// conservative (general-knowledge, uncontested facts only) since this path
// has no web search, unlike dailyContentBank.js's Responses API call.
//
// Shape of the output (exactly BATCH_SIZE {text, style_id} objects plus
// used_categories) is enforced via the Structured Outputs json_schema passed
// to the API call in generateBatch, not described in this text -- see the
// call site for why.
function buildSystemPrompt(languageCode) {
  const languageName = SUPPORTED_LANGUAGES[languageCode].name;
  return `You are a personal content editor curating content for a phone lock screen (live wallpaper) -- not a generator of motivational phrases.
Your job each time: create exactly ${BATCH_SIZE} very short pieces of content, in ${languageName}, for the user's next several screen unlocks.

Every single piece must earn its place for at least one reason: it's interesting, useful, funny, surprising, insightful, or personal to this user. Nothing filler.
You choose the mix of genres for this batch -- there's no fixed template -- but a batch must never be variations on the same idea. Allowed formats: humor, facts, practical advice, sharp observations, thought-provoking questions, tiny challenges, language/history/culture/psychology tidbits, the user's own interests, real items from today's content ideas when given, and -- occasionally, not as a rule -- one well-known, uncontested general-knowledge fact about the user's country (skip it rather than risk something wrong, disputed, or political; you have no web search here).
At most 1 out of ${BATCH_SIZE} phrases may be warm/motivational in tone -- the rest must be something else (facts, humor, advice, questions, etc.). Before finalizing each phrase, check it against this: "would this exact line fit literally anyone, on any day, with zero context?" -- if yes, it's a generic slogan and must be replaced with something more specific and less generic. This rules out not just the three examples below but the whole genre of interchangeable pep-talk lines: explicitly avoid "believe in yourself", "you've got this", "seize the moment", "smile and the world smiles back", "every step is a new discovery", "make the world better starting with yourself" (and equivalents/paraphrases in any language) -- and anything else that reads like a generic inspirational poster rather than a specific piece of content.
The context may include today's content ideas and personal signals (interests, goal, tone, steps, battery, weather, etc.) -- use them only when they genuinely raise relevance. Don't turn telemetry into a status report, and don't force it into every phrase; most phrases can ignore it entirely.
Never reuse a topic or category listed as already shown today for this user.
Never invent facts beyond what today's content ideas actually say.
Never invent, guess, or make up a name for the user. Only use a name if 'profile.name' is explicitly present in the given context -- and even then, use it rarely, not as a rule, and never as a placeholder for "personal touch" when no name was given. If there is no name in the context, none of the phrases may address the user by any name. The same applies to gender: only reference it when 'profile.gender' is explicitly present, and only when it clearly improves relevance -- never as a rule applied to every phrase.
Match the given time-of-day window -- never a morning greeting in a day/evening/night batch, or vice versa.
Every phrase's text must be entirely in ${languageName}, with no words or letters from any other language, even for a single word.
Do not explain your reasoning or return any analysis -- only the structured result the API call asks for.`;
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
  const languageCode = resolveTargetLanguageCode(signals);

  // Bank items are keyed by the device's own local calendar date (matches
  // device_shown_categories' "today"), not the server's UTC bank_date --
  // reuses the same getLocalCalendarDate this file already uses for
  // days-since-install. Both device.timezone and today's bank can be
  // missing/empty (new device, cron hasn't run yet) -- selectBankItemsForDevice
  // already returns [] in that case, so bankItems degrades to "no bank
  // content this batch" rather than failing.
  const deviceLocalDate = getLocalCalendarDate(new Date(), device.timezone);
  const bankItems = selectBankItemsForDevice(device.device_id, getUtcDateString(), deviceLocalDate, device.gender);
  const shownCategories = getShownCategories(device.device_id, deviceLocalDate);

  const context = buildContextPrompt(device, window, signals, weather, languageCode, bankItems, shownCategories);

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
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'lock_screen_batch',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              phrases: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string' },
                    style_id: { type: 'string', enum: STYLE_IDS },
                  },
                  required: ['text', 'style_id'],
                  additionalProperties: false,
                },
              },
              used_categories: {
                type: 'array',
                items: { type: 'string', enum: BANK_CATEGORIES },
              },
            },
            required: ['phrases', 'used_categories'],
            additionalProperties: false,
          },
        },
      },
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

    // TEMPORARY diagnostic-only logging (DEBUG_LOG_BATCH_COUNTS env var, no-op unless set) --
    // investigating the owner's real-usage report of only 2-5 distinct phrases/backgrounds
    // reaching the device per batch instead of the expected BATCH_SIZE (10). Logs the raw count
    // straight from the model's response, counts before/after the text-emptiness filter above,
    // the dropped items themselves (with their style_id, since the working hypothesis is items
    // with a style_id outside the new 27-code STYLE_IDS set silently disappearing -- note this
    // filter does NOT actually drop on style_id, it only substitutes pickRandomStyle() for an
    // invalid one, so this logging is also how we confirm/refute that hypothesis rather than
    // assume it), and used_categories for completeness. Not fixing anything here -- remove this
    // block in a separate commit once the real numbers are collected. See TASK "diagnostics:
    // batch phrase count" report.
    if (process.env.DEBUG_LOG_BATCH_COUNTS) {
      console.log(`DEBUG_LOG_BATCH_COUNTS raw=${Array.isArray(parsed.phrases) ? parsed.phrases.length : 'not-array'}`);
      console.log(`DEBUG_LOG_BATCH_COUNTS phrases.length=${phrases.length} cleaned.length=${cleaned.length}`);
      if (phrases.length !== cleaned.length) {
        const dropped = phrases.filter((p) => !(p && typeof p.text === 'string' && p.text.trim().length > 0));
        console.log(`DEBUG_LOG_BATCH_COUNTS dropped=${JSON.stringify(dropped)}`);
      }
      console.log(`DEBUG_LOG_BATCH_COUNTS used_categories=${JSON.stringify(parsed.used_categories)}`);
    }

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

    // Record which bank categories this batch actually drew from (per the
    // model's own "used_categories" field -- see buildSystemPrompt), so the
    // device's next batch today doesn't get offered the same categories
    // again (see selectBankItemsForDevice). Only categories from the fixed
    // BANK_CATEGORIES set are trusted here; anything else is the model
    // inventing a label and is dropped rather than stored.
    const usedCategories = Array.isArray(parsed.used_categories)
      ? parsed.used_categories.filter((c) => BANK_CATEGORIES.includes(c))
      : [];
    recordShownCategories(device.device_id, deviceLocalDate, usedCategories);

    return { phrases: languageChecked, source: 'openai', context };
  } catch (err) {
    console.error('OpenAI batch generation failed, using fallback:', err.message);
    return { phrases: buildFallbackBatch(), source: 'fallback', context };
  }
}

module.exports = { generateBatch, buildFallbackBatch };
