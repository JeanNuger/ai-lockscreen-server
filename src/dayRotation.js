const db = require('./db');

// Per-device rotation and memory of the whole-day scheme (task 27): the interest of the day (night 2), the
// foreign language of the day (morning 10, evening 2-3) and the weekend check.

// The interests a device can pick; the order is the order of the circle.
const INTEREST_KEYS = [
  'technology', 'science_space', 'history', 'nature_animals', 'sport_health', 'food',
  'travel', 'money_business', 'family_kids', 'film_music', 'books_art', 'auto',
];
const INTEREST_CATEGORY_PREFIX = 'interest_';
const DEFAULT_LEARNING_LANGUAGE = 'en';
const DEFAULT_LEARNING_LANGUAGE_FOR_ENGLISH = 'es';
const LEARNED_FOREIGN_WORDS_MAX = 300;

function interestCategory(key) {
  return `${INTEREST_CATEGORY_PREFIX}${key}`;
}

// The interests a device chose (devices.interests, a JSON array), only valid keys, in circle order, no
// repeats. A device without any valid key (old survey keys, nothing chosen) gets all 12.
function deviceInterestKeys(device) {
  let raw = device && device.interests;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (err) {
      raw = null;
    }
  }
  const chosen = new Set((Array.isArray(raw) ? raw : [])
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase()));
  const keys = INTEREST_KEYS.filter((key) => chosen.has(key));
  return keys.length > 0 ? keys : INTEREST_KEYS.slice();
}

// The device's interests starting with the one after `lastKey`, going round. A `lastKey` that is not in
// the device's list (the list changed) continues from its place in the circle of 12.
function interestCircle(keys, lastKey) {
  const lastIndex = INTEREST_KEYS.indexOf(lastKey);
  const start = keys.findIndex((key) => INTEREST_KEYS.indexOf(key) > lastIndex);
  const from = lastIndex < 0 || start < 0 ? 0 : start;
  return keys.slice(from).concat(keys.slice(0, from));
}

const selectInterestPointerStatement = db.prepare('SELECT last_interest FROM device_interest_pointer WHERE device_id = ?').pluck();
const upsertInterestPointerStatement = db.prepare(`
  INSERT INTO device_interest_pointer (device_id, last_interest, last_date) VALUES (?, ?, ?)
  ON CONFLICT(device_id) DO UPDATE SET last_interest = excluded.last_interest, last_date = excluded.last_date
`);

function loadLastInterest(deviceId) {
  return selectInterestPointerStatement.get(deviceId) || null;
}

function recordInterest(deviceId, key, localDate) {
  upsertInterestPointerStatement.run(deviceId, key, localDate || null);
}

// Picks today's interest: the next one of the device's circle that still has a usable fact.
// hasFact(key) -> the bank row to use, or null. Returns { key, row } or null.
function pickInterestOfDay(device, hasFact) {
  const circle = interestCircle(deviceInterestKeys(device), loadLastInterest(device.device_id));
  for (const key of circle) {
    const row = hasFact(key);
    if (row) return { key, row };
  }
  return null;
}

// ---- learning language ----

function cleanLanguageCode(value, supported) {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z]{2}$/.test(code) && supported[code] ? code : null;
}

// English unless the user's own language is English, then Spanish. A chosen language equal to the user's
// language is no use to anyone and is replaced by that default too.
function defaultLearningLanguage(userLanguageCode) {
  return userLanguageCode === DEFAULT_LEARNING_LANGUAGE ? DEFAULT_LEARNING_LANGUAGE_FOR_ENGLISH : DEFAULT_LEARNING_LANGUAGE;
}

function resolveLearningLanguage({ requested, stored, userLanguageCode, supported }) {
  const chosen = cleanLanguageCode(requested, supported) || cleanLanguageCode(stored, supported);
  return chosen && chosen !== userLanguageCode ? chosen : defaultLearningLanguage(userLanguageCode);
}

const selectForeignWordsStatement = db.prepare(`
  SELECT word_text FROM device_foreign_words WHERE device_id = ? AND language = ? ORDER BY id DESC LIMIT ?
`).pluck();
const insertForeignWordStatement = db.prepare(`
  INSERT INTO device_foreign_words (device_id, language, word_text, learned_local_date) VALUES (?, ?, ?, ?)
`);

function loadLearnedForeignWords(deviceId, language) {
  return selectForeignWordsStatement.all(deviceId, language, LEARNED_FOREIGN_WORDS_MAX);
}

function recordForeignWord(deviceId, language, word, localDate) {
  insertForeignWordStatement.run(deviceId, language, word, localDate || null);
}

function normalizeWord(word) {
  return String(word || '').normalize('NFKC').trim().toLowerCase();
}

// ---- weekend ----

function isWeekendDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function isFridayDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(`${date}T00:00:00Z`).getUTCDay() === 5;
}

module.exports = {
  INTEREST_KEYS,
  INTEREST_CATEGORY_PREFIX,
  interestCategory,
  deviceInterestKeys,
  interestCircle,
  loadLastInterest,
  recordInterest,
  pickInterestOfDay,
  cleanLanguageCode,
  defaultLearningLanguage,
  resolveLearningLanguage,
  loadLearnedForeignWords,
  recordForeignWord,
  normalizeWord,
  isWeekendDate,
  isFridayDate,
};
