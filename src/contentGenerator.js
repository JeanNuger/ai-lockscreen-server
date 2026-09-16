const { STYLE_IDS, BATCH_SIZE } = require('./constants');
const {
  selectBankItemsForDevice,
  recordShownCategories,
  getShownCategories,
  getBankDateString,
  BANK_CATEGORIES,
} = require('./dailyContentBank');

const LOCK_SCREEN_TEXT_MAX_LENGTH = 140;

// FALLBACK_PHRASES: the offline/failure path (no OPENAI_API_KEY configured,
// the OpenAI call itself fails, the whole batch comes back unusable, or an
// individual phrase fails its language check below). Translated into all 10
// supported languages so this path degrades in the device's own language
// instead of always falling back to English. The fallback copy is deliberately
// short, neutral, one-way, question-free, and non-factual: it must preserve
// the product character without pretending to know personal context. Keyed by
// the same language codes as SUPPORTED_LANGUAGES; callers select a language's
// array by indexing FALLBACK_PHRASES[languageCode] (see
// pickRandomFallbackPhrase/buildFallbackBatch below). 12 phrases per language,
// matching BATCH_SIZE -- buildFallbackBatch's slice(0, BATCH_SIZE) would
// otherwise silently cap below BATCH_SIZE if a language's list were shorter.
const FALLBACK_PHRASES = {
  en: [
    'A useful next move can stay simple',
    'One clear detail is enough to start',
    'The day has room for a sharper angle',
    'Keep the useful part and leave the clutter',
    'A small improvement still changes the shape',
    'There is probably one thing worth doing first',
    'Good timing beats extra effort',
    'A clean start fits any kind of day',
    'Notice the part that is already working',
    'The next action does not need ceremony',
    'A lighter version of the plan may work better',
    'Stay with the thing that actually matters',
  ],
  fr: [
    'Le prochain geste utile peut rester simple',
    'Un détail clair suffit pour commencer',
    'La journée laisse place à un angle plus net',
    'Gardez l’utile et laissez le bruit',
    'Une petite amélioration change déjà la forme',
    'Il y a sûrement une chose à faire en premier',
    'Le bon moment vaut mieux que l’effort en plus',
    'Un départ net convient à toute journée',
    'Remarquez la partie qui fonctionne déjà',
    'La prochaine action n’a pas besoin de cérémonie',
    'Une version plus légère du plan peut mieux marcher',
    'Restez avec ce qui compte vraiment',
  ],
  es: [
    'El próximo movimiento útil puede ser simple',
    'Un detalle claro basta para empezar',
    'El día tiene espacio para un ángulo más preciso',
    'Quédate con lo útil y deja el ruido',
    'Una pequeña mejora también cambia la forma',
    'Probablemente hay una cosa que conviene hacer primero',
    'El buen momento vale más que el esfuerzo extra',
    'Un comienzo limpio encaja en cualquier día',
    'Fíjate en la parte que ya funciona',
    'La siguiente acción no necesita ceremonia',
    'Una versión más ligera del plan puede funcionar mejor',
    'Quédate con lo que de verdad importa',
  ],
  pt: [
    'O próximo movimento útil pode ser simples',
    'Um detalhe claro basta para começar',
    'O dia tem espaço para um ângulo mais preciso',
    'Fique com o útil e deixe o ruído',
    'Uma pequena melhoria também muda a forma',
    'Provavelmente há uma coisa que vale fazer primeiro',
    'Bom timing vale mais que esforço extra',
    'Um começo limpo combina com qualquer dia',
    'Repare na parte que já está funcionando',
    'A próxima ação não precisa de cerimônia',
    'Uma versão mais leve do plano pode funcionar melhor',
    'Fique com o que realmente importa',
  ],
  de: [
    'Der nächste nützliche Schritt kann einfach bleiben',
    'Ein klares Detail reicht für den Anfang',
    'Der Tag hat Platz für einen schärferen Blick',
    'Behalte das Nützliche und lass den Lärm weg',
    'Eine kleine Verbesserung verändert schon die Form',
    'Wahrscheinlich gibt es eine Sache zuerst',
    'Gutes Timing schlägt zusätzliche Anstrengung',
    'Ein klarer Anfang passt zu jedem Tag',
    'Beachte den Teil, der schon funktioniert',
    'Die nächste Aktion braucht keine Zeremonie',
    'Eine leichtere Version des Plans kann besser passen',
    'Bleib bei dem, was wirklich zählt',
  ],
  ru: [
    'Следующий полезный ход может быть простым',
    'Одной ясной детали достаточно для начала',
    'В дне есть место для более точного угла',
    'Оставь полезное, а шум можно не брать с собой',
    'Маленькое улучшение тоже меняет форму',
    'Скорее всего, есть одна вещь, с которой стоит начать',
    'Хороший момент иногда важнее лишнего усилия',
    'Чистый старт подходит любому дню',
    'Заметь ту часть, которая уже работает',
    'Следующему действию не нужна церемония',
    'Более лёгкая версия плана может сработать лучше',
    'Держись того, что действительно важно',
  ],
  zh: [
    '下一个有用动作可以很简单',
    '一个清楚细节就足够开始',
    '今天还容得下一个更准的角度',
    '留下有用的部分，把杂音放下',
    '一点小改进也会改变整体形状',
    '也许先做那一件最值得的事',
    '好的时机胜过额外用力',
    '干净的开头适合任何一天',
    '注意已经在运转的那一部分',
    '下一个动作不需要仪式感',
    '计划的轻量版本可能更好用',
    '留在真正重要的事情上',
  ],
  ja: [
    '次の役に立つ一手はシンプルでいい',
    '始めるには一つのはっきりした細部で足ります',
    '今日にはまだ別の見方を置く余地があります',
    '役に立つ部分だけ残して、雑音は置いていきます',
    '小さな改善でも形は変わります',
    'まず手をつける価値のある一つがあります',
    '余分な努力より、よいタイミングが効きます',
    'すっきりした始まりはどんな日にも合います',
    'もう動いている部分に目を向けます',
    '次の行動に大げさな準備はいりません',
    '軽い版の計画のほうが合うこともあります',
    '本当に大事なものに寄せていきます',
  ],
  ko: [
    '다음 유용한 움직임은 단순해도 됩니다',
    '분명한 세부 하나면 시작하기에 충분합니다',
    '오늘에는 더 날카로운 각도를 둘 공간이 있습니다',
    '쓸모 있는 부분만 남기고 소음은 덜어냅니다',
    '작은 개선도 전체 모양을 바꿉니다',
    '먼저 할 만한 한 가지가 있을 가능성이 큽니다',
    '좋은 타이밍은 추가 노력보다 강합니다',
    '깔끔한 시작은 어떤 하루에도 어울립니다',
    '이미 작동하는 부분을 봅니다',
    '다음 행동에 거창한 준비는 필요 없습니다',
    '계획의 가벼운 버전이 더 잘 맞을 수 있습니다',
    '정말 중요한 쪽에 머뭅니다',
  ],
  it: [
    'La prossima mossa utile può restare semplice',
    'Un dettaglio chiaro basta per iniziare',
    'La giornata ha spazio per un angolo più preciso',
    'Tieni la parte utile e lascia il rumore',
    'Un piccolo miglioramento cambia già la forma',
    'Probabilmente c’è una cosa da fare per prima',
    'Il tempismo giusto batte lo sforzo in più',
    'Un inizio pulito sta bene in ogni giornata',
    'Nota la parte che sta già funzionando',
    'La prossima azione non ha bisogno di cerimonie',
    'Una versione più leggera del piano può funzionare meglio',
    'Resta con ciò che conta davvero',
  ],
};

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

// Returns `count` distinct style_ids (Fisher-Yates shuffle of the full 27-value
// STYLE_IDS, then take the first `count`) -- used wherever a batch needs several
// different backgrounds guaranteed with no repeats, e.g. buildFallbackBatch below.
// count must not exceed STYLE_IDS.length (27); BATCH_SIZE (12) leaves comfortable
// headroom.
function pickUniqueStyles(count) {
  const shuffled = [...STYLE_IDS];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

// Reassigns any duplicate style_id within a batch to one not yet used in that
// same batch, walked in order -- keeps each phrase's own style_id whenever it's
// still free within the batch, only touches actual repeats. 27 style_ids vs
// BATCH_SIZE (12) leaves comfortable headroom, so an unused one is always
// available. This is the hard guarantee; buildSystemPrompt's "don't repeat
// style_id" instruction above is only a soft ask to the model, not relied on
// alone.
function dedupeStyleIds(items) {
  const used = new Set();
  return items.map((item) => {
    if (!used.has(item.style_id)) {
      used.add(item.style_id);
      return item;
    }
    const available = STYLE_IDS.filter((id) => !used.has(id));
    const replacement = available[Math.floor(Math.random() * available.length)];
    used.add(replacement);
    return { ...item, style_id: replacement };
  });
}

function normalizeTextForDedupe(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function hasQuestionMark(text) {
  return /[?¿؟？]/.test(text);
}

function cleanUsablePhrases(phrases) {
  if (!Array.isArray(phrases)) {
    return null;
  }

  const seenTexts = new Set();
  const cleaned = [];
  for (const phrase of phrases) {
    if (!phrase || typeof phrase.text !== 'string') {
      continue;
    }
    const text = phrase.text.trim();
    if (
      text.length === 0 ||
      text.length > LOCK_SCREEN_TEXT_MAX_LENGTH ||
      hasQuestionMark(text)
    ) {
      continue;
    }

    const normalized = normalizeTextForDedupe(text);
    if (seenTexts.has(normalized)) {
      continue;
    }
    seenTexts.add(normalized);

    cleaned.push({
      text,
      style_id: STYLE_IDS.includes(phrase.style_id) ? phrase.style_id : pickRandomStyle(),
    });
  }

  return cleaned.length === BATCH_SIZE ? cleaned : null;
}

// languageCode is expected to already be a resolved, known key of
// FALLBACK_PHRASES (i.e. the output of resolveTargetLanguageCode) — the
// DEFAULT_LANGUAGE_CODE fallback here is defense in depth for a caller that
// passes something else (e.g. undefined), not the primary resolution path.
function pickRandomFallbackPhrase(languageCode) {
  const phrases = FALLBACK_PHRASES[languageCode] || FALLBACK_PHRASES[DEFAULT_LANGUAGE_CODE];
  return phrases[Math.floor(Math.random() * phrases.length)];
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

// languageCode: same contract as pickRandomFallbackPhrase — pass the
// already-resolved target language (resolveTargetLanguageCode's output);
// defaults to DEFAULT_LANGUAGE_CODE when omitted, so existing callers that
// don't pass a language (e.g. tests) keep the original English behavior.
// Uses pickUniqueStyles (not an independent pickRandomStyle() per phrase) so
// the fallback path also never repeats a style_id within one batch.
function buildFallbackBatch(languageCode = DEFAULT_LANGUAGE_CODE) {
  const phrases = FALLBACK_PHRASES[languageCode] || FALLBACK_PHRASES[DEFAULT_LANGUAGE_CODE];
  const shuffled = [...phrases].sort(() => Math.random() - 0.5);
  const styles = pickUniqueStyles(BATCH_SIZE);
  return shuffled.slice(0, BATCH_SIZE).map((text, i) => ({
    text,
    style_id: styles[i],
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
  const ipCountryCode = weather && typeof weather.countryCode === 'string' && weather.countryCode
    ? weather.countryCode
    : null;
  if (ipCountryCode) {
    now.country = ipCountryCode;
    now.country_source = 'ip_approximate';
    if (signals && signals.region !== undefined && signals.region !== ipCountryCode) {
      now.device_region = signals.region;
    }
  } else if (signals && signals.region !== undefined) {
    now.country = signals.region;
    now.country_source = 'device_locale';
  }
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

  if (weather && typeof weather.temperatureC === 'number') {
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
// languageCode only (no country code) so the static prefix is byte-identical
// across every request in the same language regardless of which device's
// country happens to be set -- country code now travels only in the per-request
// context (buildContextPrompt's `now.country`), which lets an OpenAI-side
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
  return `You are a proactive personal AI companion on a phone lock screen (live wallpaper).
The user cannot reply from the lock screen. Speak first with short one-way remarks that feel natural, personal, and context-aware -- not like a chat, trivia feed, quote app, encyclopedia, or translated joke list.
Create exactly ${BATCH_SIZE} distinct lock-screen messages in ${languageName}. Give each message a different style_id from the enum -- do not reuse the same style_id twice within this batch.

Never ask the user a question. Never request a reply, choice, confirmation, reflection, or answer. Do not end phrases with question marks. Rewrite question-shaped ideas as statements, observations, suggestions, or short remarks.

Every message must earn its place: personal, useful, situational, funny, quietly insightful, or grounded in trusted today_content. Nothing filler.
When profile/context is rich enough, about 4-5 of the ${BATCH_SIZE} messages should feel personal through one or more factors: interests, personal_goal, age/life context, name, relevant behavior/device context, weather/time, or today_content. Do not force telemetry just to hit a quota.
If profile.name is present, use the name about once in the whole batch. Do not use it more often unless there is a strong natural reason. Never invent a name.
Do not assume an unlock means the user needs to put the phone away, pause, breathe, calm down, reset, or reduce screen time. Use that kind of message only when the profile/context genuinely supports it.

profile.tone must shape the writing:
- formal: calm, polished, restrained; no slang.
- friendly: warm, natural, conversational.
- humorous: playful or witty where appropriate, but do not turn all ${BATCH_SIZE} messages into jokes.

Use interests as things the AI knows about the person, not keywords to repeat literally. Let personal_goal noticeably steer some messages: work/business + productivity should feel different from mindfulness + wellbeing. Do not make every line coaching.
Treat now.country as approximate country context: IP country first, device-locale fallback. Never infer the user's country from system language or timezone.
Use device signals only when they create a natural useful observation. Do not make psychological, medical, or moral conclusions from unlocks, steps, battery, ambient light, or screen duration. High unlock count alone does not mean addiction or anxiety. Do not repeat the same signal observation more than once.

Facts, history, holidays, and today_content are allowed, but they must not read like random encyclopedia cards. When possible, connect today_content to the user's moment or context. Do not invent factual claims that require current or precise accuracy beyond the trusted today_content supplied in context.
Humor must work directly in ${languageName}. Avoid English wordplay or puns that become meaningless after adaptation. Prefer short situational or observational humor. Humor is optional, even for humorous tone.

The ${BATCH_SIZE} messages must vary by idea and wording. Do not produce ${BATCH_SIZE} pieces of advice, ${BATCH_SIZE} facts, ${BATCH_SIZE} motivational statements, several paraphrases of the same thought, or repeated use of one interest/signal/event.
Vary the character of the batch: it should feel like ${BATCH_SIZE} natural remarks from a versatile personal AI, not a wellness or digital-detox app.
Warm or motivational generic content is allowed at most 1 out of ${BATCH_SIZE}, and only if it genuinely fits.
Never reuse a topic or category listed as already shown today for this user.
Never invent facts beyond what today's content ideas actually say.
Never invent, guess, or make up a name for the user. Only use profile.gender when it clearly improves relevance -- never as a rule applied to every phrase.
Match the given time-of-day window -- never a morning greeting in a day/evening/night batch, or vice versa.
Every phrase's text must be entirely in ${languageName}, with no words or letters from any other language, even for a single word.
Every phrase must be at most ${LOCK_SCREEN_TEXT_MAX_LENGTH} characters.
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
  const bankItems = selectBankItemsForDevice(device.device_id, getBankDateString(), deviceLocalDate, device.gender);
  const shownCategories = getShownCategories(device.device_id, deviceLocalDate);

  const context = buildContextPrompt(device, window, signals, weather, languageCode, bankItems, shownCategories);

  if (!apiKey) {
    return { phrases: buildFallbackBatch(languageCode), source: 'fallback', context };
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
                minItems: BATCH_SIZE,
                maxItems: BATCH_SIZE,
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', maxLength: LOCK_SCREEN_TEXT_MAX_LENGTH },
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
    const cleaned = cleanUsablePhrases(phrases);

    // TEMPORARY diagnostic-only logging (DEBUG_LOG_BATCH_COUNTS env var, no-op unless set) --
    // investigating the owner's real-usage report of only 2-5 distinct phrases/backgrounds
    // reaching the device per batch instead of the expected BATCH_SIZE (10). Logs counts
    // before/after the text-emptiness filter above, the dropped items themselves (with their
    // style_id, since the working hypothesis is items with a style_id outside the new 27-code
    // STYLE_IDS set silently disappearing -- note this filter does NOT actually drop on
    // style_id, it only substitutes pickRandomStyle() for an invalid one, so this logging is
    // also how we confirm/refute that hypothesis rather than assume it), and used_categories
    // for completeness. Not fixing anything here -- remove this block in a separate commit
    // once the real numbers are collected. See TASK "diagnostics: batch phrase count" report.
    if (process.env.DEBUG_LOG_BATCH_COUNTS) {
      console.log(`DEBUG_LOG_BATCH_COUNTS raw=${Array.isArray(parsed.phrases) ? parsed.phrases.length : 'not-array'}`);
      console.log(`DEBUG_LOG_BATCH_COUNTS phrases.length=${phrases.length} cleaned.length=${cleaned ? cleaned.length : 'invalid'}`);
      if (!cleaned || phrases.length !== cleaned.length) {
        const seen = new Set();
        const dropped = phrases.filter((p) => {
          if (!(p && typeof p.text === 'string')) return true;
          const text = p.text.trim();
          const normalized = normalizeTextForDedupe(text);
          const invalid = text.length === 0 ||
            text.length > LOCK_SCREEN_TEXT_MAX_LENGTH ||
            hasQuestionMark(text) ||
            seen.has(normalized);
          seen.add(normalized);
          return invalid;
        });
        console.log(`DEBUG_LOG_BATCH_COUNTS dropped=${JSON.stringify(dropped)}`);
      }
      console.log(`DEBUG_LOG_BATCH_COUNTS used_categories=${JSON.stringify(parsed.used_categories)}`);
    }

    if (!cleaned) {
      return { phrases: buildFallbackBatch(languageCode), source: 'fallback', context };
    }

    // Ensure no two phrases in this batch share the same style_id -- buildSystemPrompt
    // asks the model not to repeat style_id, but the enum constraint alone doesn't
    // prevent it (no uniqueItems equivalent in Structured Outputs), so this is the
    // actual guarantee. See dedupeStyleIds above.
    const deduped = dedupeStyleIds(cleaned);

    // Language reliability: swap out only the individual phrases that failed
    // the target-language script check for a random local fallback phrase,
    // rather than retrying the whole OpenAI call — a full retry would double the token
    // cost and latency of every batch that has even one bad phrase, for a
    // failure mode this cheap per-phrase substitution already fixes. The
    // batch is still reported as 'openai' since it's still mostly
    // AI-generated; only the substitution count is logged for visibility.
    let invalidCount = 0;
    const languageChecked = deduped.map((p) => {
      if (isValidLanguageText(p.text, languageCode)) {
        return p;
      }
      invalidCount += 1;
      // Substituted with a FALLBACK_PHRASES entry in the same resolved
      // target language, now that the list is translated (see the
      // FALLBACK_PHRASES comment above) — no longer an English-regardless-
      // of-languageCode substitution.
      return { text: pickRandomFallbackPhrase(languageCode), style_id: p.style_id };
    });
    if (invalidCount > 0) {
      console.warn(`Replaced ${invalidCount}/${cleaned.length} OpenAI phrase(s) that failed the ${SUPPORTED_LANGUAGES[languageCode].name}-language check (target=${languageCode})`);
    }

    const finalChecked = cleanUsablePhrases(languageChecked);
    if (!finalChecked) {
      return { phrases: buildFallbackBatch(languageCode), source: 'fallback', context };
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

    return { phrases: finalChecked, source: 'openai', context };
  } catch (err) {
    console.error('OpenAI batch generation failed, using fallback:', err.message);
    return { phrases: buildFallbackBatch(languageCode), source: 'fallback', context };
  }
}

module.exports = { generateBatch, buildFallbackBatch };
