const db = require('./db');

// What the model is told the device has already seen, so it varies topics by
// itself instead of the server trying to spot repeats by meaning.
//
//  - phrases: original texts of the phrases delivered to this device in the last
//    SEEN_DAYS days (content_batches), newest first, at most SEEN_MAX_PHRASES.
//  - learned_words: every word/expression this device has already been taught
//    (device_learning_memory), as one line.
//
// Added to every batch request and, because repair reuses the batch payload,
// to every repair request too.

const SEEN_DAYS = 3;
const SEEN_MAX_PHRASES = 150;
// Safety cap only: a device that learned hundreds of words must not make the
// request grow without bound. Newest words win.
const LEARNED_WORDS_MAX = 300;

const SEEN_INSTRUCTION = 'The user has already seen these phrases and learned these words. '
  + 'Do not repeat these facts, jokes, ideas or words, even in different words. '
  + 'For every topic pick something new.';

const selectRecentBatchesStatement = db.prepare(`
  SELECT phrases FROM content_batches
  WHERE device_id = ? AND delivered_at >= datetime('now', ?)
  ORDER BY id DESC
`);

const selectLearnedWordsStatement = db.prepare(`
  SELECT word_text FROM device_learning_memory
  WHERE device_id = ?
  ORDER BY id DESC
  LIMIT ?
`).pluck();

function loadSeenPhrases(deviceId, { days = SEEN_DAYS, limit = SEEN_MAX_PHRASES } = {}) {
  const texts = [];
  const seen = new Set();
  for (const row of selectRecentBatchesStatement.all(deviceId, `-${days} days`)) {
    let list;
    try {
      list = JSON.parse(row.phrases);
    } catch (err) {
      continue;
    }
    for (const item of Array.isArray(list) ? list : []) {
      const text = item && typeof item.text === 'string' ? item.text.trim() : '';
      if (text && !seen.has(text)) {
        seen.add(text);
        texts.push(text);
        if (texts.length >= limit) {
          return texts;
        }
      }
    }
  }
  return texts;
}

function loadLearnedWords(deviceId, limit = LEARNED_WORDS_MAX) {
  return selectLearnedWordsStatement.all(deviceId, limit);
}

// Returns { instruction, phrases, learned_words } or null when there is
// nothing to show (new device) or the read failed: a broken history must never
// block a batch.
function loadSeenBlock(deviceId, options = {}) {
  if (!deviceId) {
    return null;
  }
  try {
    const phrases = loadSeenPhrases(deviceId, options);
    const words = loadLearnedWords(deviceId);
    if (phrases.length === 0 && words.length === 0) {
      return null;
    }
    return {
      instruction: SEEN_INSTRUCTION,
      phrases,
      learned_words: words.join('; '),
    };
  } catch (err) {
    console.warn(`SEEN_MEMORY_LOAD_ERROR device_id=${deviceId} error=${err.name || 'Error'}`);
    return null;
  }
}

module.exports = {
  SEEN_DAYS,
  SEEN_MAX_PHRASES,
  LEARNED_WORDS_MAX,
  SEEN_INSTRUCTION,
  loadSeenBlock,
  loadSeenPhrases,
  loadLearnedWords,
};
