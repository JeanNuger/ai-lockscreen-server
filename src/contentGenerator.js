const { STYLE_IDS, BATCH_SIZE } = require('./constants');
const {
  selectBankItemsForDevice,
  recordShownCategories,
  getBankDateString,
  BANK_CATEGORIES,
} = require('./dailyContentBank');
const {
  getRecentContentMemory,
  recordShownContentMemory,
} = require('./contentMemory');
const {
  getRecallCandidate,
  recordLearnedWords,
  recordRecalledWords,
} = require('./learningMemory');
const { planSlots } = require('./slotPlanner');
const {
  hasQuestionMark,
  validateLockScreenText,
} = require('./textFilter');

const LOCK_SCREEN_TEXT_MAX_LENGTH = 65;

const WINDOW_CONTEXT = {
  morning: { id: 'morning', range: '05:00-11:00' },
  day: { id: 'day', range: '11:00-15:00' },
  evening: { id: 'evening', range: '15:00-20:00' },
  night: { id: 'night', range: '20:00-05:00' },
};

// One entry per SUPPORTED_LANGUAGES code -- covers every language the app
// actually generates in, not just ru/en, so the date/weekday guard applies
// uniformly regardless of resolveTargetLanguageCode's result. Aliases are
// deliberately minimal: just the forms needed to catch "Tomorrow is Friday"/
// "Today is Saturday" and their natural equivalents (a couple of inflected
// forms where a language needs them, e.g. Russian accusative "пятницу",
// Portuguese's short "segunda" alongside "segunda-feira") -- not a full
// grammatical case/conjugation table.
const WEEKDAY_ALIASES = {
  ru: {
    Monday: ['понедельник'],
    Tuesday: ['вторник'],
    Wednesday: ['среда', 'среду'],
    Thursday: ['четверг'],
    Friday: ['пятница', 'пятницу'],
    Saturday: ['суббота', 'субботу'],
    Sunday: ['воскресенье'],
  },
  en: {
    Monday: ['monday'],
    Tuesday: ['tuesday'],
    Wednesday: ['wednesday'],
    Thursday: ['thursday'],
    Friday: ['friday'],
    Saturday: ['saturday'],
    Sunday: ['sunday'],
  },
  fr: {
    Monday: ['lundi'],
    Tuesday: ['mardi'],
    Wednesday: ['mercredi'],
    Thursday: ['jeudi'],
    Friday: ['vendredi'],
    Saturday: ['samedi'],
    Sunday: ['dimanche'],
  },
  es: {
    Monday: ['lunes'],
    Tuesday: ['martes'],
    Wednesday: ['miércoles', 'miercoles'],
    Thursday: ['jueves'],
    Friday: ['viernes'],
    Saturday: ['sábado', 'sabado'],
    Sunday: ['domingo'],
  },
  pt: {
    Monday: ['segunda-feira', 'segunda'],
    Tuesday: ['terça-feira', 'terça', 'terca-feira', 'terca'],
    Wednesday: ['quarta-feira', 'quarta'],
    Thursday: ['quinta-feira', 'quinta'],
    Friday: ['sexta-feira', 'sexta'],
    Saturday: ['sábado', 'sabado'],
    Sunday: ['domingo'],
  },
  de: {
    Monday: ['montag'],
    Tuesday: ['dienstag'],
    Wednesday: ['mittwoch'],
    Thursday: ['donnerstag'],
    Friday: ['freitag'],
    Saturday: ['samstag'],
    Sunday: ['sonntag'],
  },
  zh: {
    Monday: ['星期一', '周一'],
    Tuesday: ['星期二', '周二'],
    Wednesday: ['星期三', '周三'],
    Thursday: ['星期四', '周四'],
    Friday: ['星期五', '周五'],
    Saturday: ['星期六', '周六'],
    Sunday: ['星期日', '星期天', '周日'],
  },
  ja: {
    Monday: ['月曜日', '月曜'],
    Tuesday: ['火曜日', '火曜'],
    Wednesday: ['水曜日', '水曜'],
    Thursday: ['木曜日', '木曜'],
    Friday: ['金曜日', '金曜'],
    Saturday: ['土曜日', '土曜'],
    Sunday: ['日曜日', '日曜'],
  },
  ko: {
    Monday: ['월요일'],
    Tuesday: ['화요일'],
    Wednesday: ['수요일'],
    Thursday: ['목요일'],
    Friday: ['금요일'],
    Saturday: ['토요일'],
    Sunday: ['일요일'],
  },
  it: {
    Monday: ['lunedì', 'lunedi'],
    Tuesday: ['martedì', 'martedi'],
    Wednesday: ['mercoledì', 'mercoledi'],
    Thursday: ['giovedì', 'giovedi'],
    Friday: ['venerdì', 'venerdi'],
    Saturday: ['sabato'],
    Sunday: ['domenica'],
  },
};

const RELATIVE_DAY_MARKERS = {
  ru: {
    today: ['сегодня'],
    tomorrow: ['завтра'],
  },
  en: {
    today: ['today'],
    tomorrow: ['tomorrow'],
  },
  fr: {
    today: ["aujourd'hui", 'aujourdhui'],
    tomorrow: ['demain'],
  },
  es: {
    today: ['hoy'],
    tomorrow: ['mañana', 'manana'],
  },
  pt: {
    today: ['hoje'],
    tomorrow: ['amanhã', 'amanha'],
  },
  de: {
    today: ['heute'],
    tomorrow: ['morgen'],
  },
  zh: {
    today: ['今天'],
    tomorrow: ['明天'],
  },
  ja: {
    today: ['今日'],
    tomorrow: ['明日'],
  },
  ko: {
    today: ['오늘'],
    tomorrow: ['내일'],
  },
  it: {
    today: ['oggi'],
    tomorrow: ['domani'],
  },
};

const BATTERY_TERMS = {
  ru: ['заряд', 'заряда', 'заряж', 'батаре', 'аккумулятор'],
  en: ['battery', 'charge'],
};

const UNLOCK_TERMS = {
  ru: ['разблокиров'],
  en: ['unlock', 'unlocks'],
};

// JS's \b is defined in terms of \w, which is ASCII-only (`[A-Za-z0-9_]`) --
// Cyrillic letters are never "word characters" to it, so a Cyrillic-only
// pattern like /\bпора\b/ never matches anything at all (found while adding
// tests for the patterns below: every RU pattern silently no-op'd). This
// builds an equivalent boundary using a lookaround against an explicit
// Latin+Cyrillic+digit+underscore class instead, so RU patterns actually
// fire. EN patterns don't need this (plain ASCII \b already works for them).
const WORD_CHARS = 'A-Za-zА-Яа-яЁё0-9_';
function ruWordBoundaryPattern(source) {
  return new RegExp(`(?<![${WORD_CHARS}])(?:${source})(?![${WORD_CHARS}])`, 'i');
}

const UNSUPPORTED_CONTEXT_PATTERNS = {
  traffic: {
    ru: ['в\\s+пробк[аеуы]', 'пробк[аеуы]'].map(ruWordBoundaryPattern),
    en: [/\btraffic\s+jam\b/i, /\bstuck\s+in\s+traffic\b/i, /\bin\s+traffic\b/i],
  },
};

const COACHING_PATTERNS = {
  ru: [
    'не\\s+забудь',
    'тебе\\s+стоит',
    'пора\\s+[а-яё]+',
    'попробуй',
    'попробовать',
    'сделай',
    'дай\\s+себе',
    'запланируй',
    'экспериментируй',
  ].map(ruWordBoundaryPattern),
  en: [
    /\bdon't\s+forget\b/i,
    /\byou\s+should\b/i,
    /\bit'?s\s+time\s+to\b/i,
    /\btry\s+(?:to\s+)?[a-z]/i,
    /\bremember\s+to\b/i,
    /\bstart\s+with\b/i,
    /\bfocus\s+on\b/i,
  ],
};

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
    'Clouds can move faster than they look from the ground',
    'City lights make rainy streets look sharper',
    'A quiet room changes the sound of small things',
    'Good coffee has a way of announcing itself early',
    'Maps hide entire stories behind thin lines',
    'Fresh air after rain has its own kind of punctuation',
    'Old buildings usually keep the best shadows',
    'A clear sky can make the city feel newly drawn',
    'Tiny routines leave bigger traces than expected',
    'Even familiar streets change with the hour',
    'A low battery icon is modern suspense in miniature',
    'Some days have better lighting than planning',
  ],
  fr: [
    'Les nuages vont parfois plus vite qu’ils n’en ont l’air',
    'La pluie rend les lumières de la ville plus nettes',
    'Une pièce calme change le bruit des petites choses',
    'Un bon café sait se faire remarquer tôt',
    'Les cartes cachent des histoires derrière de fines lignes',
    'L’air après la pluie a sa propre ponctuation',
    'Les vieux bâtiments gardent souvent les meilleures ombres',
    'Un ciel clair redessine presque la ville',
    'Les petites habitudes laissent de grandes traces',
    'Même une rue connue change selon l’heure',
    'Une batterie faible crée un suspense très moderne',
    'Certains jours ont une meilleure lumière que le programme',
  ],
  es: [
    'Las nubes a veces van más rápido de lo que parece',
    'La lluvia vuelve más nítidas las luces de la ciudad',
    'Una habitación tranquila cambia el sonido de las cosas pequeñas',
    'El buen café sabe anunciarse temprano',
    'Los mapas esconden historias detrás de líneas finas',
    'El aire después de la lluvia tiene su propia puntuación',
    'Los edificios antiguos suelen guardar las mejores sombras',
    'Un cielo claro hace que la ciudad parezca recién dibujada',
    'Las rutinas pequeñas dejan huellas más grandes de lo esperado',
    'Hasta las calles conocidas cambian con la hora',
    'Un icono de batería baja es suspenso moderno en miniatura',
    'Algunos días tienen mejor luz que planificación',
  ],
  pt: [
    'As nuvens às vezes se movem mais rápido do que parecem',
    'A chuva deixa as luzes da cidade mais nítidas',
    'Um quarto silencioso muda o som das pequenas coisas',
    'Um bom café sabe aparecer cedo',
    'Mapas escondem histórias atrás de linhas finas',
    'O ar depois da chuva tem sua própria pontuação',
    'Prédios antigos costumam guardar as melhores sombras',
    'Um céu limpo faz a cidade parecer redesenhada',
    'Pequenas rotinas deixam marcas maiores do que parecem',
    'Até ruas conhecidas mudam com a hora',
    'Um ícone de bateria baixa é suspense moderno em miniatura',
    'Alguns dias têm luz melhor que planejamento',
  ],
  de: [
    'Wolken bewegen sich oft schneller, als sie wirken',
    'Regen macht Stadtlichter schärfer',
    'Ein stiller Raum verändert den Klang kleiner Dinge',
    'Guter Kaffee meldet sich früh genug',
    'Karten verstecken Geschichten hinter dünnen Linien',
    'Luft nach Regen hat ihre eigene Zeichensetzung',
    'Alte Gebäude haben oft die besten Schatten',
    'Ein klarer Himmel lässt die Stadt neu gezeichnet wirken',
    'Kleine Routinen hinterlassen größere Spuren als gedacht',
    'Selbst bekannte Straßen ändern sich mit der Uhrzeit',
    'Ein niedriger Akkustand ist moderner Miniatur-Suspense',
    'Manche Tage haben besseres Licht als Planung',
  ],
  ru: [
    'Облака часто движутся быстрее, чем кажется с земли',
    'Дождь делает городские огни резче',
    'В тихой комнате мелкие звуки становятся заметнее',
    'Хороший кофе умеет заявить о себе заранее',
    'На картах за тонкими линиями прячутся целые истории',
    'У воздуха после дождя есть своя пунктуация',
    'Старые здания обычно хранят лучшие тени',
    'Ясное небо делает город почти заново нарисованным',
    'Маленькие привычки оставляют следы крупнее, чем кажется',
    'Даже знакомые улицы меняются вместе с часом',
    'Значок низкой батареи — маленький современный саспенс',
    'У некоторых дней освещение лучше, чем расписание',
  ],
  zh: [
    '云有时比地面上看起来移动得更快',
    '雨会让城市灯光显得更锋利',
    '安静的房间会放大小东西的声音',
    '好咖啡总会很早就有存在感',
    '地图把故事藏在细细的线后面',
    '雨后的空气有自己的标点',
    '老建筑常常留着最好的阴影',
    '晴朗的天空会让城市像刚被重新画过',
    '小习惯留下的痕迹常比想象中大',
    '熟悉的街道也会随着时间变样',
    '低电量图标是一种迷你现代悬念',
    '有些日子的光线比计划更好',
  ],
  ja: [
    '雲は地上から見るより速く動くことがあります',
    '雨は街の明かりを少し鋭く見せます',
    '静かな部屋では小さな音がよく目立ちます',
    'よいコーヒーは早い時間から存在感があります',
    '地図の細い線の奥には物語があります',
    '雨上がりの空気には独特の区切りがあります',
    '古い建物にはいい影が残りがちです',
    '澄んだ空は街を描き直したように見せます',
    '小さな習慣は思ったより大きな跡を残します',
    '見慣れた通りも時間で表情が変わります',
    '低いバッテリー表示は小さな現代サスペンスです',
    '計画より光のほうがいい日もあります',
  ],
  ko: [
    '구름은 땅에서 보는 것보다 빠르게 움직일 때가 있습니다',
    '비는 도시의 불빛을 더 선명하게 만듭니다',
    '조용한 방에서는 작은 소리가 더 또렷합니다',
    '좋은 커피는 이른 시간부터 존재감을 냅니다',
    '지도는 얇은 선 뒤에 많은 이야기를 숨깁니다',
    '비 온 뒤의 공기에는 고유한 쉼표가 있습니다',
    '오래된 건물은 대개 좋은 그림자를 품고 있습니다',
    '맑은 하늘은 도시를 새로 그린 듯 보이게 합니다',
    '작은 습관은 생각보다 큰 흔적을 남깁니다',
    '익숙한 거리도 시간에 따라 달라집니다',
    '낮은 배터리 표시는 작은 현대식 긴장감입니다',
    '어떤 날은 계획보다 빛이 더 좋습니다',
  ],
  it: [
    'Le nuvole a volte corrono più di quanto sembri',
    'La pioggia rende più nette le luci della città',
    'Una stanza silenziosa cambia il suono delle piccole cose',
    'Un buon caffè sa farsi notare presto',
    'Le mappe nascondono storie dietro linee sottili',
    'L’aria dopo la pioggia ha una punteggiatura tutta sua',
    'Gli edifici vecchi tengono spesso le ombre migliori',
    'Un cielo limpido fa sembrare la città appena disegnata',
    'Le piccole abitudini lasciano tracce più grandi del previsto',
    'Anche le strade note cambiano con l’ora',
    'L’icona della batteria bassa è suspense moderno in miniatura',
    'Certi giorni hanno una luce migliore del programma',
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

function pickFirstUnusedStyle(usedStyles) {
  return STYLE_IDS.find((id) => !usedStyles.has(id)) || pickRandomStyle();
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

function hasQuestionShapeWithoutMark(text) {
  const normalized = normalizeTextForDedupe(text).replace(/[.!…,:;]+$/g, '');
  return /^(знаешь ли|а ты|ты замечал|ты когда-нибудь|хочешь|почему бы не|как насч[её]т)(?:\s|$|[,.!…:;])/i.test(normalized);
}

function isGenericBadLockScreenPhrase(text) {
  const normalized = normalizeTextForDedupe(text).replace(/[.!…,:;]+$/g, '');
  return [
    'скорее всего, есть одна вещь, с которой стоит начать',
    'маленькие улучшения тоже меняют форму',
    'маленькое улучшение тоже меняет форму',
    'на дне есть место для более точного угла',
    'в дне есть место для более точного угла',
    'следующему действию не нужна церемония',
    'чистый старт подходит любому дню',
    'заметь ту часть, которая уже работает',
  ].includes(normalized);
}

function isUnusableLockScreenText(text) {
  const filterResult = validateLockScreenText(text, { maxLength: LOCK_SCREEN_TEXT_MAX_LENGTH });
  return (
    !filterResult.ok ||
    hasQuestionShapeWithoutMark(text) ||
    isGenericBadLockScreenPhrase(text)
  );
}

function getLanguageMap(map, languageCode) {
  return map[languageCode] || map[DEFAULT_LANGUAGE_CODE] || {};
}

function containsAnyMarker(normalized, markers) {
  return markers.some((marker) => normalized.includes(marker));
}

function detectRelativeWeekdayClaim(text, languageCode) {
  const normalized = normalizeTextForDedupe(text);
  const relativeMarkers = getLanguageMap(RELATIVE_DAY_MARKERS, languageCode);
  const weekdayAliases = getLanguageMap(WEEKDAY_ALIASES, languageCode);
  const relative = Object.keys(relativeMarkers).find((key) => containsAnyMarker(normalized, relativeMarkers[key]));
  if (!relative) {
    return null;
  }
  for (const [weekday, aliases] of Object.entries(weekdayAliases)) {
    if (containsAnyMarker(normalized, aliases)) {
      return { relative, weekday };
    }
  }
  return null;
}

function hasInvalidRelativeDateClaim(text, languageCode, validationContext = {}) {
  const claim = detectRelativeWeekdayClaim(text, languageCode);
  if (!claim) {
    return false;
  }
  const dateContext = validationContext.dateContext;
  if (!dateContext) {
    return true;
  }
  const expected = claim.relative === 'tomorrow'
    ? dateContext.tomorrow_weekday
    : dateContext.weekday;
  return expected !== claim.weekday;
}

function numberNearTerms(normalized, value, terms) {
  if (value === undefined || value === null || value < 0) {
    return false;
  }
  const escapedValue = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const termPattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!termPattern) {
    return false;
  }
  return new RegExp(`(?:${escapedValue}\\s*(?:%|[^\\n]{0,24}(?:${termPattern}))|(?:${termPattern})[^\\n]{0,24}${escapedValue})`, 'i')
    .test(normalized);
}

function hasExactTelemetryEcho(text, languageCode, validationContext = {}) {
  const normalized = normalizeTextForDedupe(text);
  const signals = validationContext.signals || {};
  if (signals.battery_level !== undefined) {
    const batteryTerms = getLanguageMap(BATTERY_TERMS, languageCode);
    if (normalized.includes(`${signals.battery_level}%`) || numberNearTerms(normalized, signals.battery_level, batteryTerms)) {
      return true;
    }
  }
  if (signals.unlocks_since_last_batch !== undefined) {
    const unlockTerms = getLanguageMap(UNLOCK_TERMS, languageCode);
    if (numberNearTerms(normalized, signals.unlocks_since_last_batch, unlockTerms)) {
      return true;
    }
  }
  return false;
}

function hasUnsupportedContextClaim(text, languageCode, validationContext = {}) {
  const hasTrafficContext = validationContext.contextFlags && validationContext.contextFlags.traffic === true;
  if (hasTrafficContext) {
    return false;
  }
  const trafficPatterns = (UNSUPPORTED_CONTEXT_PATTERNS.traffic[languageCode] || [])
    .concat(UNSUPPORTED_CONTEXT_PATTERNS.traffic[DEFAULT_LANGUAGE_CODE] || []);
  return trafficPatterns.some((pattern) => pattern.test(text));
}

function hasCoachingOrDirectiveShape(text, languageCode) {
  const patterns = (COACHING_PATTERNS[languageCode] || []).concat(COACHING_PATTERNS[DEFAULT_LANGUAGE_CODE] || []);
  return patterns.some((pattern) => pattern.test(text));
}

function rejectionReasonForText(text, languageCode, validationContext = {}) {
  const filterResult = validateLockScreenText(text, { maxLength: LOCK_SCREEN_TEXT_MAX_LENGTH });
  if (!filterResult.ok) return filterResult.reason;
  if (hasQuestionShapeWithoutMark(text)) return 'question';
  if (isGenericBadLockScreenPhrase(text)) return 'generic';
  if (hasInvalidRelativeDateClaim(text, languageCode, validationContext)) return 'date_claim';
  if (hasExactTelemetryEcho(text, languageCode, validationContext)) return 'telemetry_echo';
  if (hasUnsupportedContextClaim(text, languageCode, validationContext)) return 'unsupported_context';
  if (hasCoachingOrDirectiveShape(text, languageCode)) return 'coaching';
  return null;
}

function incrementReason(reasonCounts, reason) {
  if (!reason) {
    return;
  }
  reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
}

function collectUsablePhrases(phrases, languageCode, validationContext = {}, expectedSlotIds = null) {
  if (!Array.isArray(phrases)) {
    return null;
  }

  const seenTexts = new Set();
  const seenSlotIds = new Set();
  const expectedSlotSet = Array.isArray(expectedSlotIds) ? new Set(expectedSlotIds) : null;
  const accepted = [];
  const rejectedSlotIds = new Set();
  let rejectedCount = 0;
  const rejectionReasons = {};
  const reject = (reason, slotId) => {
    rejectedCount += 1;
    incrementReason(rejectionReasons, reason);
    if (expectedSlotSet && typeof slotId === 'string' && expectedSlotSet.has(slotId)) {
      rejectedSlotIds.add(slotId);
    }
  };
  for (const phrase of phrases) {
    if (!phrase || typeof phrase.text !== 'string') {
      reject('schema', phrase && phrase.slot_id);
      continue;
    }
    if (expectedSlotSet) {
      if (typeof phrase.slot_id !== 'string' || !expectedSlotSet.has(phrase.slot_id) || seenSlotIds.has(phrase.slot_id)) {
        reject('slot_id', phrase.slot_id);
        continue;
      }
      seenSlotIds.add(phrase.slot_id);
    }
    const text = phrase.text.trim();
    const reason = rejectionReasonForText(text, languageCode, validationContext);
    if (reason) {
      reject(reason, phrase.slot_id);
      continue;
    }
    if (languageCode && !isValidLanguageText(text, languageCode)) {
      reject('language', phrase.slot_id);
      continue;
    }

    const normalized = normalizeTextForDedupe(text);
    if (seenTexts.has(normalized)) {
      reject('duplicate', phrase.slot_id);
      continue;
    }
    seenTexts.add(normalized);

    accepted.push({
      slot_id: phrase.slot_id,
      text,
      style_id: STYLE_IDS.includes(phrase.style_id) ? phrase.style_id : null,
    });
  }

  if (expectedSlotSet) {
    const acceptedSlotIds = new Set(accepted.map((item) => item.slot_id));
    for (const slotId of expectedSlotSet) {
      if (!acceptedSlotIds.has(slotId)) {
        rejectedSlotIds.add(slotId);
      }
    }
  }

  return { accepted, rejectedCount, inputCount: phrases.length, rejectionReasons, rejectedSlotIds: [...rejectedSlotIds] };
}

function cleanUsablePhrases(phrases, languageCode, validationContext = {}) {
  const collected = collectUsablePhrases(phrases, languageCode, validationContext);
  if (!collected) {
    return null;
  }
  const styled = assignUniqueStyleIds(collected.accepted);
  const finalChecked = validateFinalBatch(styled);
  return finalChecked ? styled : null;
}

function assignUniqueStyleIds(items) {
  const usedStyles = new Set();
  return items.map((item) => {
    const style_id = STYLE_IDS.includes(item.style_id) && !usedStyles.has(item.style_id)
      ? item.style_id
      : pickFirstUnusedStyle(usedStyles);
    usedStyles.add(style_id);
    return { ...item, style_id };
  });
}

function validateFinalBatch(items) {
  if (!Array.isArray(items) || items.length !== BATCH_SIZE) {
    return false;
  }
  const seenTexts = new Set();
  const seenStyles = new Set();
  for (const item of items) {
    if (!item || typeof item.text !== 'string' || isUnusableLockScreenText(item.text)) {
      return false;
    }
    if (!STYLE_IDS.includes(item.style_id) || seenStyles.has(item.style_id)) {
      return false;
    }
    seenStyles.add(item.style_id);
    const normalized = normalizeTextForDedupe(item.text);
    if (seenTexts.has(normalized)) {
      return false;
    }
    seenTexts.add(normalized);
  }
  return true;
}

function fallbackTextForSlot(slot, languageCode) {
  if (slot && slot.type === 'goodnight') {
    if (languageCode === 'ru') return 'Спокойной ночи. Телефону тоже нужен отдых';
    return 'Good night. Even a phone needs rest';
  }
  if (slot && slot.type === 'greeting') {
    if (languageCode === 'ru') return 'Доброе утро. Один точный шаг экономит час';
    return 'Good morning. One precise step saves an hour';
  }
  return null;
}

function pickFallbackTextForSlot(slot, languageCode, seenTexts, fallbackTexts) {
  const slotFallback = fallbackTextForSlot(slot, languageCode);
  if (slotFallback) {
    const normalized = normalizeTextForDedupe(slotFallback);
    if (!isUnusableLockScreenText(slotFallback) && !seenTexts.has(normalized)) {
      return slotFallback;
    }
  }

  for (const text of fallbackTexts) {
    const trimmed = text.trim();
    const normalized = normalizeTextForDedupe(trimmed);
    if (!isUnusableLockScreenText(trimmed) && !seenTexts.has(normalized)) {
      return trimmed;
    }
  }
  return null;
}

function assembleByExpectedSlotOrder(generated, languageCode, expectedSlots) {
  const fallbackPhrases = FALLBACK_PHRASES[languageCode] || FALLBACK_PHRASES[DEFAULT_LANGUAGE_CODE];
  const shuffledFallback = [...fallbackPhrases].sort(() => Math.random() - 0.5);
  const generatedBySlot = new Map(generated.map((item) => [item.slot_id, item]));
  const seenTexts = new Set(generated.map((item) => normalizeTextForDedupe(item.text)));

  const result = expectedSlots.map((slot) => {
    const generatedItem = generatedBySlot.get(slot.slot_id);
    if (generatedItem) {
      return generatedItem;
    }
    const fallbackText = pickFallbackTextForSlot(slot, languageCode, seenTexts, shuffledFallback);
    if (!fallbackText) {
      return null;
    }
    seenTexts.add(normalizeTextForDedupe(fallbackText));
    return { slot_id: slot.slot_id, text: fallbackText, style_id: null };
  });

  if (result.some((item) => !item)) {
    return null;
  }
  return assignUniqueStyleIds(result);
}

function fillWithFallbackPhrases(generated, languageCode) {
  const result = [...generated];
  const seenTexts = new Set(result.map((item) => normalizeTextForDedupe(item.text)));
  const fallbackPhrases = FALLBACK_PHRASES[languageCode] || FALLBACK_PHRASES[DEFAULT_LANGUAGE_CODE];
  const shuffledFallback = [...fallbackPhrases].sort(() => Math.random() - 0.5);

  for (const text of shuffledFallback) {
    if (result.length >= BATCH_SIZE) {
      break;
    }
    const trimmed = text.trim();
    const normalized = normalizeTextForDedupe(trimmed);
    if (isUnusableLockScreenText(trimmed) || seenTexts.has(normalized)) {
      continue;
    }
    seenTexts.add(normalized);
    result.push({ text: trimmed, style_id: null });
  }
  if (result.length !== BATCH_SIZE) {
    return null;
  }
  return assignUniqueStyleIds(result);
}

function assembleBatchFromGeneratedPhrases(phrases, languageCode, validationContext = {}, expectedSlots = null) {
  const expectedSlotIds = Array.isArray(expectedSlots) ? expectedSlots.map((slot) => slot.slot_id) : null;
  const collected = collectUsablePhrases(phrases, languageCode, validationContext, expectedSlotIds);
  if (!collected) {
    return null;
  }
  const generated = collected.accepted.slice(0, BATCH_SIZE);
  const fallbackFillCount = BATCH_SIZE - generated.length;
  const assembled = Array.isArray(expectedSlots)
    ? assembleByExpectedSlotOrder(generated, languageCode, expectedSlots)
    : fallbackFillCount > 0
      ? fillWithFallbackPhrases(generated, languageCode)
      : assignUniqueStyleIds(generated);

  if (!assembled || !validateFinalBatch(assembled)) {
    return {
      phrases: null,
      generatedCount: generated.length,
      rejectedCount: collected.rejectedCount,
      fallbackFillCount,
      reason: 'final_assembly_fallback',
      rejectionReasons: collected.rejectionReasons,
    };
  }

  return {
    phrases: assembled,
    generatedCount: generated.length,
    generatedSlotIds: generated.map((item) => item.slot_id),
    rejectedCount: collected.rejectedCount,
    fallbackFillCount,
    rejectionReasons: collected.rejectionReasons,
    rejectedSlotIds: collected.rejectedSlotIds,
    reason: fallbackFillCount === 0
      ? 'success'
      : generated.length === 0
        ? 'all_invalid_fallback'
        : 'partial_validation_fill',
  };
}

function formatRejectionReasons(rejectionReasons) {
  if (!rejectionReasons || Object.keys(rejectionReasons).length === 0) {
    return '';
  }
  return Object.entries(rejectionReasons)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reasonName, count]) => ` rejected_${reasonName}=${count}`)
    .join('');
}

function logBatchResult({ generatedCount, rejectedCount, fallbackFillCount, reason, rejectionReasons }) {
  console.log(
    `AI_BATCH_RESULT generated_count=${generatedCount} rejected_count=${rejectedCount} fallback_fill_count=${fallbackFillCount} reason=${reason}${formatRejectionReasons(rejectionReasons)}`
  );
}

function buildLoggedFallbackResult(languageCode, context, reason, rejectedCount = 0) {
  logBatchResult({
    generatedCount: 0,
    rejectedCount,
    fallbackFillCount: BATCH_SIZE,
    reason,
  });
  return { phrases: buildFallbackBatch(languageCode), source: 'fallback', context };
}

function buildLoggedOpenAiResult(assembly, context) {
  logBatchResult(assembly);
  const phrases = assembly.phrases.map((item) => ({ text: item.text, style_id: item.style_id }));
  return { phrases, source: assembly.generatedCount > 0 ? 'openai' : 'fallback', context };
}

function buildLoggedFinalAssemblyFallback(languageCode, context, assembly) {
  logBatchResult({
    generatedCount: assembly ? assembly.generatedCount : 0,
    rejectedCount: assembly ? assembly.rejectedCount : 0,
    fallbackFillCount: BATCH_SIZE,
    reason: 'final_assembly_fallback',
    rejectionReasons: assembly ? assembly.rejectionReasons : undefined,
  });
  return { phrases: buildFallbackBatch(languageCode), source: 'fallback', context };
}

function parseOpenAiBatchResponse(response) {
  const content = response &&
    response.choices &&
    response.choices[0] &&
    response.choices[0].message &&
    response.choices[0].message.content;
  const parsed = JSON.parse(content);
  if (!parsed || !Array.isArray(parsed.phrases)) {
    throw new Error('response did not contain phrases array');
  }
  return parsed;
}

function buildBatchResponseFormat(name, count) {
  return {
    type: 'json_schema',
    json_schema: {
      name,
      strict: true,
      schema: {
        type: 'object',
        properties: {
          phrases: {
            type: 'array',
            minItems: count,
            maxItems: count,
            items: {
              type: 'object',
              properties: {
                slot_id: { type: 'string' },
                text: { type: 'string', maxLength: LOCK_SCREEN_TEXT_MAX_LENGTH },
                style_id: { type: 'string', enum: STYLE_IDS },
              },
              required: ['slot_id', 'text', 'style_id'],
              additionalProperties: false,
            },
          },
        },
        required: ['phrases'],
        additionalProperties: false,
      },
    },
  };
}

async function createOpenAiBatch(client, context, languageCode, count = BATCH_SIZE, schemaName = 'lock_screen_batch') {
  return client.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: buildBatchResponseFormat(schemaName, count),
    messages: [
      { role: 'system', content: buildSystemPrompt(languageCode) },
      { role: 'user', content: context },
    ],
  });
}

async function regenerateRejectedSlots(client, basePayload, slots, rejectedSlotIds, languageCode, validationContext) {
  if (!Array.isArray(rejectedSlotIds) || rejectedSlotIds.length === 0) {
    return null;
  }
  const rejectedSlotSet = new Set(rejectedSlotIds);
  const repairSlots = slots.filter((slot) => rejectedSlotSet.has(slot.slot_id));
  if (repairSlots.length === 0) {
    return null;
  }
  const repairPayload = {
    ...basePayload,
    repair: 'rewrite_only_these_rejected_slots',
    slots: repairSlots.map((slot) => ({
      slot_id: slot.slot_id,
      type: slot.type,
      facts: slot.facts || {},
      constraints: slot.constraints || [],
      interest_hint: slot.interest_hint || undefined,
    })),
  };
  const response = await createOpenAiBatch(
    client,
    JSON.stringify(repairPayload),
    languageCode,
    repairSlots.length,
    'lock_screen_repair'
  );
  const parsed = parseOpenAiBatchResponse(response);
  const repaired = collectUsablePhrases(
    parsed.phrases,
    languageCode,
    validationContext,
    repairSlots.map((slot) => slot.slot_id)
  );
  return repaired && repaired.accepted.length > 0 ? repaired.accepted : null;
}

function extractUsedCategoriesFromSlots(slots) {
  return Array.isArray(slots)
    ? slots
      .map((slot) => slot.bank_category)
      .filter((category) => BANK_CATEGORIES.includes(category))
    : [];
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

function weekdayForDateString(date) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'long',
    }).format(new Date(`${date}T00:00:00Z`));
  } catch (err) {
    return null;
  }
}

function addDaysToDateString(date, days) {
  const instant = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(instant.getTime())) {
    return null;
  }
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

// Date/day-of-week is deliberately NOT a client-sent signal (see
// PRODUCT_REBUILD_PLAN.md server contract docs) — the server already has the
// device's IANA timezone (e.g. "Asia/Almaty") from /register
// (TimeZone.getDefault().getID() on the Android side), so it can compute the
// device's local date/weekday itself rather than trusting/parsing a second
// client-sent value that would just have to agree with the timezone anyway.
// Returns {dateContext, unavailableReason}. dateContext is null if there's no
// timezone on file yet, or it's not a timezone Intl recognizes.
function resolveLocalDateContext(timezone) {
  if (!timezone) {
    return { dateContext: null, unavailableReason: 'missing_timezone' };
  }
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    const weekday = get('weekday');
    const time = `${get('hour')}:${get('minute')}`;
    const tomorrowDate = addDaysToDateString(date, 1);
    const tomorrowWeekday = tomorrowDate ? weekdayForDateString(tomorrowDate) : null;
    if (!weekday || !time || !tomorrowDate || !tomorrowWeekday) {
      return { dateContext: null, unavailableReason: 'invalid_timezone' };
    }
    return {
      dateContext: {
        date,
        weekday,
        time,
        tomorrow_date: tomorrowDate,
        tomorrow_weekday: tomorrowWeekday,
      },
      unavailableReason: null,
    };
  } catch (err) {
    return { dateContext: null, unavailableReason: 'invalid_timezone' };
  }
}

function getLocalDateContext(timezone) {
  return resolveLocalDateContext(timezone).dateContext;
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

// Builds the compact slot-based user payload sent to the model. The planner
// has already decided WHAT the batch should cover; this payload asks OpenAI
// only to write one phrase for each selected slot.
//
// languageCode: the already-resolved target language (resolveTargetLanguageCode's
// output) — reported in `now.language` as a human name so the model doesn't
// have to map an ISO code itself.
// slots: exactly BATCH_SIZE planner-selected editorial tasks. The full
// candidate pool/bank is deliberately not sent.
function windowContextFor(window) {
  return WINDOW_CONTEXT[window] || { id: window };
}

function buildContextPrompt(device, window, signals, weather, languageCode, slots, dateContext) {
  const profile = {};
  if (device.name) profile.name = device.name;
  if (device.gender) profile.gender = device.gender;
  const age = computeAge(device.birth_date);
  if (age !== null) profile.age = age;

  // `language` is the resolved GENERATION target (resolveTargetLanguageCode's
  // output, e.g. falls back to English if the device's own language isn't
  // supported) -- not the same thing as the device's raw system_language
  // signal, so we also surface `device_language` below whenever the two
  // differ, otherwise the model would have no way to know a fallback
  // happened. `timezone` itself is deliberately NOT included here (unlike
  // the old "; "-joined context) -- the model only ever needs the derived
  // date/weekday/days_since_install below, not the raw IANA string.
  const now = { language: SUPPORTED_LANGUAGES[languageCode].name, window: windowContextFor(window) };
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
    if (dateContext) {
      now.date = dateContext.date;
      now.weekday = dateContext.weekday;
      now.time = dateContext.time;
      now.tomorrow = [dateContext.tomorrow_date, dateContext.tomorrow_weekday];
    }
    const daysSinceInstall = getDaysSinceInstall(device.created_at, device.timezone);
    if (daysSinceInstall !== null) {
      now.days_since_install = daysSinceInstall;
    }
  }

  const ctx = {
    lang: languageCode,
    profile,
    now,
    slots: Array.isArray(slots)
      ? slots.map((slot) => ({
        slot_id: slot.slot_id,
        type: slot.type,
        facts: slot.facts || {},
        constraints: slot.constraints || [],
        // Only present on the small, server-selected subset of slots
        // SlotPlanner picked as interest-aware (see selectInterestAwareSlots
        // in slotPlanner.js) -- omitted (not even an empty/false value) for
        // every other slot, so this never grows the per-slot payload shape
        // for the common case, and never carries the user's full interests
        // list, only the one compact tag relevant to this specific slot.
        interest_hint: slot.interest_hint || undefined,
      }))
      : [],
  };
  if (Object.keys(profile).length === 0) delete ctx.profile;

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
// Shape of the output (exactly BATCH_SIZE {slot_id, text, style_id} objects)
// is enforced via the Structured Outputs json_schema passed to the API call
// in generateBatch, not described in this text -- see the call site for why.
function buildSystemPrompt(languageCode) {
  const languageName = SUPPORTED_LANGUAGES[languageCode].name;
  return `Ты — живой, наблюдательный и добрый AI-компаньон на экране блокировки. Давай короткие мысли монологом: 1 предложение, емко, полезно, разнообразно.
Язык: ${languageName}. На каждый slot_id верни ровно одну строку и уникальный style_id.
Запрет: ?, открытки вроде «пусть день будет», уют/чай/тихий свет/мысли, «верь в себя», «ты справишься», вода, коучинг, команды, выдуманные факты.
Пиши ультра-коротко (до 8 слов). Экономь слова. Смысл должен считываться за 1 секунду.
Только факты из slot/profile/now; погода житейски без точных градусов; утром можно имя 1 раз; gender/age дают только аккуратный практичный оттенок; interest_hint используй незаметно, без «since you like».
До 60 символов, hard cap ${LOCK_SCREEN_TEXT_MAX_LENGTH}. Только JSON по схеме.`;
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
 * @param {object} [phoneTrends] - semantic phone trends from phoneAnalytics.js
 * @returns {Promise<{phrases: Array<{text: string, style_id: string}>, source: 'openai'|'fallback'}>}
 */
async function generateBatch(device, window, signals, weather, phoneTrends = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const languageCode = resolveTargetLanguageCode(signals);
  const { dateContext, unavailableReason } = resolveLocalDateContext(device.timezone);
  if (!dateContext && unavailableReason) {
    console.warn(`DATE_CONTEXT_UNAVAILABLE reason=${unavailableReason}`);
  }

  // Bank items are keyed by the device's own local calendar date (matches
  // device_shown_categories' "today"), not the server's UTC bank_date --
  // reuses the same getLocalCalendarDate this file already uses for
  // days-since-install. Both device.timezone and today's bank can be
  // missing/empty (new device, cron hasn't run yet) -- selectBankItemsForDevice
  // already returns [] in that case, so bankItems degrades to "no bank
  // content this batch" rather than failing.
  const deviceLocalDate = dateContext ? dateContext.date : null;
  const countryCode = weather && typeof weather.countryCode === 'string' && weather.countryCode
    ? weather.countryCode
    : signals && typeof signals.region === 'string'
      ? signals.region
      : null;
  const bankItems = selectBankItemsForDevice(
    device.device_id,
    getBankDateString(),
    deviceLocalDate,
    device.gender,
    countryCode
  );
  const recentContentMemory = getRecentContentMemory(device.device_id);
  const recallCandidate = getRecallCandidate(device.device_id);
  const { slots } = planSlots({
    device,
    window,
    dateContext,
    weather,
    bankItems,
    phoneTrends,
    recallCandidate,
  }, { recentContentMemory });

  const context = buildContextPrompt(device, window, signals, weather, languageCode, slots, dateContext);
  const validationContext = {
    dateContext,
    signals,
    weather,
    contextFlags: { traffic: false },
  };

  if (!apiKey) {
    return buildLoggedFallbackResult(languageCode, context, 'no_api_key_fallback');
  }

  let response;
  let client;
  try {
    // Lazy require: avoids crashing at startup if the package is present but
    // no key is set yet, and keeps the fallback path dependency-free.
    const OpenAI = require('openai');
    client = new OpenAI({ apiKey });
    response = await createOpenAiBatch(client, context, languageCode);

  } catch (err) {
    console.error(`AI_BATCH_ERROR reason=openai_error error=${err.name || 'Error'}`);
    return buildLoggedFallbackResult(languageCode, context, 'openai_error');
  }

  let parsed;
  try {
    parsed = parseOpenAiBatchResponse(response);
  } catch (err) {
    console.error(`AI_BATCH_ERROR reason=parse_or_schema_error error=${err.name || 'Error'}`);
    return buildLoggedFallbackResult(languageCode, context, 'parse_or_schema_error');
  }

  let assembly;
  try {
    assembly = assembleBatchFromGeneratedPhrases(parsed.phrases, languageCode, validationContext, slots);
  } catch (err) {
    console.error(`AI_BATCH_ERROR reason=final_assembly_fallback error=${err.name || 'Error'}`);
    return buildLoggedFallbackResult(languageCode, context, 'final_assembly_fallback');
  }

  if (!assembly) {
    return buildLoggedFallbackResult(languageCode, context, 'parse_or_schema_error');
  }

  if (assembly.rejectedSlotIds && assembly.rejectedSlotIds.length > 0 && assembly.generatedCount > 0) {
    try {
      const basePayload = JSON.parse(context);
      const repaired = await regenerateRejectedSlots(
        client,
        basePayload,
        slots,
        assembly.rejectedSlotIds,
        languageCode,
        validationContext
      );
      if (repaired && repaired.length > 0) {
        const acceptedSlotIds = new Set(assembly.generatedSlotIds);
        const merged = parsed.phrases
          .filter((phrase) => acceptedSlotIds.has(phrase.slot_id))
          .concat(repaired);
        const repairedAssembly = assembleBatchFromGeneratedPhrases(merged, languageCode, validationContext, slots);
        if (repairedAssembly && repairedAssembly.phrases) {
          repairedAssembly.reason = repairedAssembly.rejectedCount === 0
            ? 'success_after_slot_regeneration'
            : 'partial_slot_regeneration';
          assembly = repairedAssembly;
        }
      }
    } catch (err) {
      console.error(`AI_BATCH_ERROR reason=slot_regeneration_error error=${err.name || 'Error'}`);
    }
  }

  if (!assembly.phrases) {
    return buildLoggedFinalAssemblyFallback(languageCode, context, assembly);
  }

  // Record planned daily-bank categories for this batch. With slot-based
  // generation the model no longer chooses categories; the server does, so the
  // repeat-avoidance signal comes from selected slots rather than model labels.
  const usedCategories = extractUsedCategoriesFromSlots(slots);
  recordShownCategories(device.device_id, deviceLocalDate, usedCategories);
  recordShownContentMemory(device.device_id, slots, assembly.generatedSlotIds);
  recordLearnedWords(device.device_id, slots, assembly.generatedSlotIds);
  recordRecalledWords(device.device_id, slots, assembly.generatedSlotIds);

  return buildLoggedOpenAiResult(assembly, context);
}

module.exports = {
  generateBatch,
  buildFallbackBatch,
  _test: {
    cleanUsablePhrases,
    hasQuestionMark,
    hasQuestionShapeWithoutMark,
    isGenericBadLockScreenPhrase,
    assembleBatchFromGeneratedPhrases,
    validateFinalBatch,
    resolveTargetLanguageCode,
    windowContextFor,
    resolveLocalDateContext,
    buildContextPrompt,
    buildSystemPrompt,
    SUPPORTED_LANGUAGES,
  },
};
