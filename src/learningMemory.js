const db = require('./db');

// The night "do you remember the word?" slot reminds ONLY the word taught by
// this device's morning batch of the same local day (learned_local_date).
// Older words are never recalled: an earlier version picked the oldest
// unrecalled row from the previous 2-14 days, which surfaced idioms from the
// retired bank. No word taught today means no recall slot.
const selectRecallCandidateStatement = db.prepare(`
  SELECT id, word_key, word_text, learned_at
  FROM device_learning_memory
  WHERE device_id = ?
    AND recalled_at IS NULL
    AND learned_local_date = ?
  ORDER BY id DESC
  LIMIT 1
`);

const insertLearnedWordStatement = db.prepare(`
  INSERT INTO device_learning_memory (device_id, word_key, word_text, learned_local_date)
  VALUES (?, ?, ?, ?)
`);

const markRecalledStatement = db.prepare(`
  UPDATE device_learning_memory
  SET recalled_at = datetime('now')
  WHERE id = ? AND device_id = ? AND recalled_at IS NULL
`);

function normalizeKey(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Returns the not-yet-recalled word this device was taught on `learnedLocalDate`
// (its local calendar date, YYYY-MM-DD), or null if there is none. Never falls
// back to an older word.
function getRecallCandidate(deviceId, learnedLocalDate) {
  if (!deviceId || typeof learnedLocalDate !== 'string' || !learnedLocalDate) {
    return null;
  }
  const row = selectRecallCandidateStatement.get(deviceId, learnedLocalDate);
  return row || null;
}

// Records words actually taught this batch. Only slots that were genuinely
// OpenAI-generated and validated (present in generatedSlotIds) are recorded --
// fallback-filled word_learning slots never reach here. A generated
// word_learning slot missing a valid facts.word is a contract violation (the
// server, not OpenAI, must choose the specific word) -- skipped without
// failing the batch, with a warning so it stays observable.
function recordLearnedWords(deviceId, slots = [], generatedSlotIds = [], phrases = [], localDate = null) {
  if (!deviceId || !Array.isArray(slots) || !Array.isArray(generatedSlotIds)) {
    return 0;
  }

  const generated = new Set(generatedSlotIds);
  // The model now picks the word itself (no bank word in facts), so the
  // generated phrase is what the device actually learned.
  const textBySlot = new Map((Array.isArray(phrases) ? phrases : [])
    .filter((phrase) => phrase && typeof phrase.text === 'string')
    .map((phrase) => [phrase.slot_id, phrase.text]));
  const rows = [];
  for (const slot of slots) {
    if (!slot || slot.type !== 'word_learning' || !generated.has(slot.slot_id)) {
      continue;
    }
    const wordText = normalizeKey(slot.facts && slot.facts.word) || normalizeKey(textBySlot.get(slot.slot_id));
    if (!wordText) {
      console.warn(`LEARNING_MEMORY_MISSING_WORD device_id=${deviceId} slot_id=${slot.slot_id}`);
      continue;
    }
    rows.push({
      word_key: normalizeKey(slot.content_key || slot.id) || wordText,
      word_text: wordText,
    });
  }

  if (rows.length === 0) {
    return 0;
  }

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertLearnedWordStatement.run(deviceId, item.word_key, item.word_text, localDate || null);
    }
  });
  insertMany(rows);
  return rows.length;
}

// Marks a word recalled only for learning_recall slots that were themselves
// genuinely OpenAI-generated and validated this batch -- planning/selecting a
// recall candidate is never enough on its own. `learning_memory_id` is the
// explicit server-only reference carried through the slot pipeline (never
// sent to OpenAI); it identifies exactly which device_learning_memory row
// this specific recall slot grounds.
function recordRecalledWords(deviceId, slots = [], generatedSlotIds = []) {
  if (!deviceId || !Array.isArray(slots) || !Array.isArray(generatedSlotIds)) {
    return 0;
  }

  const generated = new Set(generatedSlotIds);
  let marked = 0;
  for (const slot of slots) {
    if (!slot || slot.type !== 'learning_recall' || !generated.has(slot.slot_id)) {
      continue;
    }
    if (!Number.isFinite(slot.learning_memory_id)) {
      continue;
    }
    const result = markRecalledStatement.run(slot.learning_memory_id, deviceId);
    marked += result.changes;
  }
  return marked;
}

module.exports = {
  getRecallCandidate,
  recordLearnedWords,
  recordRecalledWords,
  _test: {
    normalizeKey,
  },
};
