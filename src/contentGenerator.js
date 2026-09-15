const { STYLE_IDS, BATCH_SIZE } = require('./constants');
const {
  selectBankItemsForDevice,
  recordShownCategories,
  getShownCategories,
  getUtcDateString,
  BANK_CATEGORIES,
} = require('./dailyContentBank');

// FALLBACK_PHRASES: the offline/failure path (no OPENAI_API_KEY configured,
// the OpenAI call itself fails, the whole batch comes back empty, or an
// individual phrase fails its language check below). Translated into all 10
// supported languages so this path degrades in the device's own language
// instead of always falling back to English — same phrases, same warm/
// short/glanceable tone, translated by hand per language rather than
// machine-generated at request time (this list must work with zero API
// calls). Keyed by the same language codes as SUPPORTED_LANGUAGES; callers
// select a language's array by indexing FALLBACK_PHRASES[languageCode] (see
// pickRandomFallbackPhrase/buildFallbackBatch below). 12 phrases per
// language, matching BATCH_SIZE -- buildFallbackBatch's slice(0, BATCH_SIZE)
// would otherwise silently cap below BATCH_SIZE if a language's list were
// shorter.
const FALLBACK_PHRASES = {
  en: [
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
    'One thing at a time is still progress',
    'A quiet moment counts too',
  ],
  fr: [
    'Une bonne journée commence avec vous',
    'Vous vous en sortez mieux que vous ne le pensez',
    'Respirez profondément',
    'Les petits pas mènent aux grands changements',
    "Aujourd'hui est un bon jour pour essayer quelque chose de nouveau",
    "N'oubliez pas d'appeler quelqu'un que vous aimez",
    'Souriez — juste parce que',
    'Un peu d\'eau ne fait jamais de mal',
    'Vous avez déjà parcouru beaucoup de chemin',
    'Accordez-vous un peu de repos si vous en avez besoin',
    'Un pas à la fois, c\'est déjà avancer',
    'Un moment de calme compte aussi',
  ],
  es: [
    'Un buen día empieza contigo',
    'Lo estás haciendo mejor de lo que crees',
    'Respira profundamente',
    'Los pequeños pasos llevan a grandes cambios',
    'Hoy es un gran día para probar algo nuevo',
    'No olvides llamar a alguien que quieres',
    'Sonríe — solo porque sí',
    'Un poco de agua nunca hace daño',
    'Ya has recorrido un largo camino',
    'Date un pequeño descanso si lo necesitas',
    'Un paso a la vez también es progreso',
    'Un momento de calma también cuenta',
  ],
  pt: [
    'Um bom dia começa com você',
    'Você está indo melhor do que pensa',
    'Respire fundo',
    'Pequenos passos levam a grandes mudanças',
    'Hoje é um ótimo dia para experimentar algo novo',
    'Não se esqueça de ligar para alguém que você ama',
    'Sorria — só porque sim',
    'Um pouco de água nunca faz mal',
    'Você já percorreu um longo caminho',
    'Dê a si mesmo um descanso se precisar',
    'Um passo de cada vez também é progresso',
    'Um momento de calma também conta',
  ],
  de: [
    'Ein guter Tag beginnt mit dir',
    'Du machst das besser, als du denkst',
    'Atme tief durch',
    'Kleine Schritte führen zu großen Veränderungen',
    'Heute ist ein guter Tag, um etwas Neues auszuprobieren',
    'Vergiss nicht, jemanden anzurufen, den du liebst',
    'Lächle — einfach so',
    'Ein bisschen Wasser schadet nie',
    'Du hast schon einen weiten Weg zurückgelegt',
    'Gönn dir eine kleine Pause, wenn du sie brauchst',
    'Ein Schritt nach dem anderen ist auch Fortschritt',
    'Ein ruhiger Moment zählt auch',
  ],
  ru: [
    'Хороший день начинается с тебя',
    'У тебя получается лучше, чем ты думаешь',
    'Сделай глубокий вдох',
    'Маленькие шаги ведут к большим переменам',
    'Сегодня отличный день, чтобы попробовать что-то новое',
    'Не забудь позвонить тому, кого любишь',
    'Улыбнись — просто так',
    'Немного воды никогда не помешает',
    'Ты уже прошёл долгий путь',
    'Позволь себе немного отдохнуть, если нужно',
    'Один шаг за раз — тоже движение вперёд',
    'Тихая минута тоже на счету',
  ],
  zh: [
    '美好的一天从你开始',
    '你做得比想象中更好',
    '深呼吸一下',
    '小小的步伐带来大大的改变',
    '今天很适合尝试一些新事物',
    '别忘了给你爱的人打个电话',
    '微笑吧——不为什么',
    '喝点水总没坏处',
    '你已经走了很长的路',
    '如果需要,给自己一点休息时间',
    '一次做一件事,也是进步',
    '安静的片刻也很重要',
  ],
  ja: [
    '良い一日はあなたから始まる',
    '思っているより、うまくやれています',
    '深呼吸してみましょう',
    '小さな一歩が大きな変化につながる',
    '今日は何か新しいことに挑戦するのにぴったりの日',
    '大切な人に電話するのを忘れずに',
    '理由なんてなくても、笑顔で',
    '水を少し飲むのも悪くない',
    'あなたはもうずいぶん頑張ってきました',
    '必要なら、少し休んでもいい',
    '一つずつでも、それは前進です',
    '静かなひとときも大切です',
  ],
  ko: [
    '좋은 하루는 당신에게서 시작됩니다',
    '생각보다 잘하고 있어요',
    '심호흡을 해보세요',
    '작은 발걸음이 큰 변화를 만듭니다',
    '오늘은 새로운 걸 시도해보기 좋은 날이에요',
    '사랑하는 사람에게 전화하는 걸 잊지 마세요',
    '그냥 한번 웃어보세요',
    '물 한 잔도 나쁘지 않아요',
    '당신은 이미 먼 길을 걸어왔어요',
    '필요하다면 잠시 쉬어가도 괜찮아요',
    '한 번에 하나씩도 발전이에요',
    '조용한 순간도 소중해요',
  ],
  it: [
    'Una buona giornata inizia con te',
    'Stai andando meglio di quanto pensi',
    'Fai un respiro profondo',
    'I piccoli passi portano a grandi cambiamenti',
    'Oggi è un ottimo giorno per provare qualcosa di nuovo',
    'Non dimenticare di chiamare qualcuno che ami',
    'Sorridi — così, senza motivo',
    "Un po' d'acqua non fa mai male",
    'Hai già fatto molta strada',
    'Concediti un po\' di riposo se ne hai bisogno',
    'Un passo alla volta è comunque un progresso',
    'Anche un momento di calma conta',
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
Give each of the ${BATCH_SIZE} phrases a different style_id from the enum -- do not reuse the same style_id twice within this batch.

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
      console.log(`DEBUG_LOG_BATCH_COUNTS phrases.length=${phrases.length} cleaned.length=${cleaned.length}`);
      if (phrases.length !== cleaned.length) {
        const dropped = phrases.filter((p) => !(p && typeof p.text === 'string' && p.text.trim().length > 0));
        console.log(`DEBUG_LOG_BATCH_COUNTS dropped=${JSON.stringify(dropped)}`);
      }
      console.log(`DEBUG_LOG_BATCH_COUNTS used_categories=${JSON.stringify(parsed.used_categories)}`);
    }

    if (cleaned.length === 0) {
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
    return { phrases: buildFallbackBatch(languageCode), source: 'fallback', context };
  }
}

module.exports = { generateBatch, buildFallbackBatch };
