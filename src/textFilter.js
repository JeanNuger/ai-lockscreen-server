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

// Minimal, non-grammar-checker guard against a phrase cut off mid-thought
// (production incident: OpenAI returned a phrase ending "...выявить в" --
// exactly at the schema's old maxLength, no server-side truncation involved,
// see contentGenerator.js's LOCK_SCREEN_TEXT_MAX_LENGTH comment for the full
// story, including why the schema no longer carries any maxLength at all).
// Only checks whether the LAST WORD is one of a small set of Russian words
// that can never end a sentence on their own (prepositions/conjunctions) --
// terminal punctuation is not required (a normal lock-screen phrase without
// a period is fine), and this is deliberately just a word-list lookup, not
// real grammar analysis. The word list is Cyrillic-only, so it is inert
// (never matches) for any other language's output -- same "Russian words
// applied universally, harmless elsewhere" precedent as STOP_PHRASES above.
//
// Deliberately does NOT attempt to catch a truncated WORD (as opposed to a
// truncated sentence ending on a whole function word) -- e.g. "жела",
// "окружающ", "уверенн", "десят", "особ", "стале" (all real production
// fragments from the same incident). A hand-picked suffix/fragment
// dictionary for that was considered and rejected: Russian orthography has
// no small, reliable rule that distinguishes a genuine complete word from a
// truncated stem without unacceptable false positives -- e.g. a naive
// "never ends in a doubled consonant" rule would reject perfectly normal
// words like "тонн" (genitive plural of "тонна") or "класс"/"процесс"/
// "прогресс" (common loanwords ending in "сс"), and a naive "must end in a
// common vowel" rule would accept "стале" itself, since а/е/о/и are all
// completely ordinary word-final letters in real Russian. There is no small
// set of endings that is both broad enough to catch real fragments and safe
// enough not to reject real words. See generateBatch's system prompt (the
// ruNaturalnessInstruction in buildSystemPrompt) and the removal of the
// schema's maxLength for the actual fix to this class of defect -- it is a
// generation-time problem (the model stopping mid-word under a length
// target), not something a post-hoc text filter can reliably detect for
// free-form Russian without a real dictionary.
const INCOMPLETE_ENDING_WORDS = new Set([
  'в', 'во', 'на', 'с', 'со', 'к', 'ко', 'для', 'из', 'от', 'до', 'по', 'у', 'о', 'об', 'про', 'через', 'при',
  'и', 'но', 'а', 'или', 'либо', 'что', 'чтобы', 'если', 'когда', 'потому', 'как',
]);

function hasIncompleteSentenceEnding(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return false;
  }
  // A phrase may legitimately end with . ! … etc -- strip that before
  // looking at the last WORD, since the check is about the word, not the
  // raw trailing character.
  const withoutTrailingPunctuation = trimmed.replace(/[.!?…,:;»"')\]]+$/u, '');
  const words = withoutTrailingPunctuation.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return false;
  }
  const lastWord = words[words.length - 1].toLowerCase();
  return INCOMPLETE_ENDING_WORDS.has(lastWord);
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
  if (hasIncompleteSentenceEnding(trimmed)) {
    return { ok: false, reason: 'incomplete_sentence' };
  }
  return { ok: true, reason: null };
}

module.exports = {
  STOP_PHRASES,
  DEFAULT_MAX_LENGTH,
  DEFAULT_MAX_WORDS,
  INCOMPLETE_ENDING_WORDS,
  normalizeText,
  hasQuestionMark,
  hasBlockedPhrase,
  hasImperativeCommand,
  hasIncompleteSentenceEnding,
  validateLockScreenText,
};
