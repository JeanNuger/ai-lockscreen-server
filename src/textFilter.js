const DEFAULT_MAX_LENGTH = 65;
const DEFAULT_MAX_WORDS = 8;

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
  return { ok: true, reason: null };
}

module.exports = {
  STOP_PHRASES,
  DEFAULT_MAX_LENGTH,
  DEFAULT_MAX_WORDS,
  normalizeText,
  hasQuestionMark,
  hasBlockedPhrase,
  validateLockScreenText,
};
