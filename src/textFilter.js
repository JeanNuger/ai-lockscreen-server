const DEFAULT_MAX_LENGTH = 65;
// Was 8 -- tied to the old blanket "ultra-short, до 8 слов" prompt
// instruction (see buildSystemPrompt in contentGenerator.js), which the
// three-tier length_hint system (short/medium/long) replaced. A ~60-char
// Russian "long" phrase routinely runs 8-10 words on its own, so keeping
// this at 8 would have silently rejected/regenerated every legitimate long
// phrase regardless of the prompt wording change. LOCK_SCREEN_TEXT_MAX_LENGTH
// (the character cap, backed by the actual on-device measurement) is now the
// real governing constraint -- this stays only as a sanity guard against a
// pathological many-tiny-words response, not a creative-length limit.
const DEFAULT_MAX_WORDS = 16;

const STOP_PHRASES = [
  'уют',
  'чай',
  'тихий свет',
  'мысли',
  'мыслях',
  'мысли собираются',
  'наполнен теплом',
  'верь в себя',
  'ты справишься',
  'пусть',
  'пусть день будет',
  'пусть день станет',
  'пусть день начнется',
  'пусть остаток дня',
  'чайник',
  'улыбается',
  'фея',
  'малинов',
  'мечта',
  'мечты',
  'мечтает',
  'магия',
  'магич',
  'чудеса',
  'чудес',
  'счастье',
  'счастья',
  'безмятеж',
  'ветер шепчет',
  'свет в окне',
  'тишина',
  'тишине',
  'тишину',
  'тише',
  'ноч',
  'покой',
  'атмосфера покоя',
  'атмосфер',
  'звезда',
  'звезды',
  'звёзд',
  'луна',
  'лун',
  'облака',
  'облак',
  'небо',
  'небе',
  'снежинка',
  'фонарь',
  'фонаря',
  'свеч',
  'гирлянд',
  'огоньк',
  'гармони',
  'умиротвор',
  'тает',
  'танцующие',
  'шорох',
  'листва',
  'листвы',
  'новый шанс',
  'странные миры',
  'буйство красок',
  'маленькие привычки',
  'следы крупнее',
  'используйте',
  'убедитесь',
  'врожд',
  'вечно',
  'шарик',
  'пинг-понг',
  'укрывательств',
  'спящий город',
  'летуч',
  'мыши',
  'мышь',
  'завтра будет новый день',
];

function normalizeText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function hasQuestionMark(text) {
  return /[?¿؟？]/.test(String(text || ''));
}

function hasBlockedPhrase(text) {
  const normalized = normalizeText(text);
  return STOP_PHRASES.some((phrase) => normalized.includes(phrase));
}

// Catches imperative/command-verb openers (everyday_lifehack's most common
// leak into commanding tone) — e.g. "Используй общественный транспорт...",
// "Проверяй зарядку..." — rather than the short-fact/observation format the
// system prompt requires for that slot type.
//
// NOT a plain \b word-boundary check: JS regex \b is defined relative to the
// ASCII \w class, which does not include Cyrillic letters, so a trailing \b
// right after a Cyrillic word never actually matches (verified directly --
// the literal /^(...)\b/i form silently matched nothing on any Cyrillic
// sample). The (?![а-яёa-z]) lookahead requires the match not be immediately
// followed by another letter (so "используй" matches but a longer word that
// merely starts with the same stem does not), without relying on \b.
const IMPERATIVE_OPENER_PATTERN = /^(используй|выбери|держи|создай|читай|проверяй|наблюдай|соблюдай|делай)(?![а-яёa-z])/i;

function hasImperativeCommand(text) {
  return IMPERATIVE_OPENER_PATTERN.test(String(text || '').trim());
}

function validateLockScreenText(text, options = {}) {
  if (typeof text !== 'string') {
    return { ok: false, reason: 'schema' };
  }
  const trimmed = text.trim();
  const maxLength = options.maxLength || DEFAULT_MAX_LENGTH;
  const maxWords = options.maxWords || DEFAULT_MAX_WORDS;
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return { ok: false, reason: 'basic_quality' };
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) {
    return { ok: false, reason: 'basic_quality' };
  }
  if (hasQuestionMark(trimmed)) {
    return { ok: false, reason: 'question' };
  }
  if (hasBlockedPhrase(trimmed)) {
    return { ok: false, reason: 'blocked_phrase' };
  }
  if (hasImperativeCommand(trimmed)) {
    return { ok: false, reason: 'imperative_command' };
  }
  return { ok: true, reason: null };
}

module.exports = {
  STOP_PHRASES,
  DEFAULT_MAX_LENGTH,
  DEFAULT_MAX_WORDS,
  normalizeText,
  hasQuestionMark,
  hasBlockedPhrase,
  hasImperativeCommand,
  validateLockScreenText,
};
