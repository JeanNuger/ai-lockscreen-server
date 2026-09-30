const crypto = require('crypto');
const db = require('./db');

// Memory of everything sent to a device, so phrases and Daily Bank facts do not
// repeat for years without extra OpenAI calls.
//
//  - sent_phrases: every sent phrase is stored with a hash of its normalized
//    text (forever) and the normalized text itself (only the last
//    TEXT_RETENTION_DAYS days; older rows get text_norm = NULL when new phrases
//    are written). Only EXACT repeats are caught here, by hash over the whole
//    archive. Repeats by meaning are not detected on the server: the model gets
//    the recently seen texts in its prompt instead (see seenMemory.js).
//  - device_shown_facts: Daily Bank facts already used for a device.

const TEXT_RETENTION_DAYS = 35;
const BATCH_DIAGNOSTICS_RETENTION_DAYS = 30;
const BATCH_DIAGNOSTICS_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const EXEMPT_SLOT_TYPES = new Set(['greeting_name', 'goodnight_care']);
const DATE_SENSITIVE_FACT_CATEGORIES = new Set(['holiday', 'on_this_day', 'born_today']);
const DATE_SENSITIVE_FACT_WINDOW_DAYS = 300;

// NFKC + lower case + punctuation/symbols to spaces + collapsed whitespace, so
// differences in case, spacing or punctuation do not hide a repeat. Letters,
// digits and combining marks of every language are kept.
function normalizeSentText(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 52-bit integer from SHA-1: fits a JS number and a SQLite INTEGER exactly.
function hashNormalized(normalized) {
  return parseInt(crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 13), 16);
}

const selectAllHashesStatement = db.prepare(`
  SELECT text_norm_hash FROM sent_phrases WHERE device_id = ?
`).pluck();

const insertSentPhraseStatement = db.prepare(`
  INSERT INTO sent_phrases (device_id, text_norm_hash, text_norm, slot_type)
  VALUES (?, ?, ?, ?)
`);

const scrubOldTextStatement = db.prepare(`
  UPDATE sent_phrases SET text_norm = NULL
  WHERE text_norm IS NOT NULL AND sent_at < datetime('now', ?)
`);

const pruneBatchDiagnosticsStatement = db.prepare(`
  UPDATE content_batches SET context = NULL, trace_json = NULL
  WHERE delivered_at < datetime('now', ?)
    AND (context IS NOT NULL OR trace_json IS NOT NULL)
`);

// Loads what the repeat check needs for one device. Returns null (check
// skipped) if the archive cannot be read: a broken archive must never block
// a batch.
function loadSentArchive(deviceId) {
  if (!deviceId) {
    return null;
  }
  try {
    const hashes = new Set(selectAllHashesStatement.all(deviceId));
    return { deviceId, hashes };
  } catch (err) {
    console.warn(`SENT_PHRASES_LOAD_ERROR device_id=${deviceId} error=${err.name || 'Error'}`);
    return null;
  }
}

// Returns 'exact' or null. greeting_name / goodnight_care are never
// checked (they legitimately repeat); every other type, including
// weather_lifehack, is.
function findRepeat(archive, text, slotType = null) {
  if (!archive || (slotType && EXEMPT_SLOT_TYPES.has(slotType))) {
    return null;
  }
  const normalized = normalizeSentText(text);
  if (!normalized) {
    return null;
  }
  return archive.hashes.has(hashNormalized(normalized)) ? 'exact' : null;
}

// items: [{ text, slot_type }]. Also drops the text of rows older than
// TEXT_RETENTION_DAYS (hash stays) and, at most once an hour, the
// context/trace_json of old content_batches.
function recordSentPhrases(deviceId, items) {
  if (!deviceId || !Array.isArray(items) || items.length === 0) {
    return 0;
  }
  try {
    const rows = items
      .map((item) => ({ normalized: normalizeSentText(item && item.text), slot_type: (item && item.slot_type) || null }))
      .filter((row) => row.normalized);
    const insertMany = db.transaction((list) => {
      for (const row of list) {
        insertSentPhraseStatement.run(deviceId, hashNormalized(row.normalized), row.normalized, row.slot_type);
      }
      scrubOldTextStatement.run(`-${TEXT_RETENTION_DAYS} days`);
    });
    insertMany(rows);
    pruneBatchDiagnosticsIfDue();
    return rows.length;
  } catch (err) {
    console.warn(`SENT_PHRASES_RECORD_ERROR device_id=${deviceId} error=${err.name || 'Error'}`);
    return 0;
  }
}

let lastDiagnosticsPruneMs = 0;

function pruneBatchDiagnostics() {
  return pruneBatchDiagnosticsStatement.run(`-${BATCH_DIAGNOSTICS_RETENTION_DAYS} days`).changes;
}

function pruneBatchDiagnosticsIfDue(nowMs = Date.now()) {
  if (nowMs - lastDiagnosticsPruneMs < BATCH_DIAGNOSTICS_PRUNE_INTERVAL_MS) {
    return 0;
  }
  lastDiagnosticsPruneMs = nowMs;
  return pruneBatchDiagnostics();
}

// --- Daily Bank facts -------------------------------------------------------

function factKey(text) {
  const normalized = normalizeSentText(text);
  return normalized ? `fact_${hashNormalized(normalized).toString(36)}` : null;
}

const selectShownFactsStatement = db.prepare(`
  SELECT topic_key, julianday('now') - julianday(shown_at) AS age_days
  FROM device_shown_facts WHERE device_id = ?
`);

const upsertShownFactStatement = db.prepare(`
  INSERT INTO device_shown_facts (device_id, topic_key) VALUES (?, ?)
  ON CONFLICT(device_id, topic_key) DO UPDATE SET shown_at = datetime('now')
`);

// Map<topic_key, age_days> for one device.
function loadShownFacts(deviceId) {
  const shown = new Map();
  if (!deviceId) {
    return shown;
  }
  for (const row of selectShownFactsStatement.all(deviceId)) {
    shown.set(row.topic_key, row.age_days);
  }
  return shown;
}

// holiday / on_this_day / born_today come back every year, so they may be shown
// again after DATE_SENSITIVE_FACT_WINDOW_DAYS; every other category never repeats.
function isFactShown(shownFacts, category, contentText) {
  const key = factKey(contentText);
  if (!key || !shownFacts.has(key)) {
    return false;
  }
  return !DATE_SENSITIVE_FACT_CATEGORIES.has(category) || shownFacts.get(key) < DATE_SENSITIVE_FACT_WINDOW_DAYS;
}

// Marks the Daily Bank facts behind slots that actually made it into the sent
// batch. `sentSlotIds` is the set of slot_ids with a final phrase; a fact whose
// slot was dropped is not consumed.
function recordShownFacts(deviceId, slots, sentSlotIds) {
  if (!deviceId || !Array.isArray(slots) || !(sentSlotIds instanceof Set)) {
    return 0;
  }
  const keys = [];
  for (const slot of slots) {
    if (!slot || slot.source !== 'daily_bank' || !sentSlotIds.has(slot.slot_id) || !slot.facts) {
      continue;
    }
    const key = factKey(slot.facts.text || slot.facts.word);
    if (key) {
      keys.push(key);
    }
  }
  if (keys.length === 0) {
    return 0;
  }
  try {
    db.transaction((list) => {
      for (const key of list) {
        upsertShownFactStatement.run(deviceId, key);
      }
    })(keys);
    return keys.length;
  } catch (err) {
    console.warn(`SHOWN_FACTS_RECORD_ERROR device_id=${deviceId} error=${err.name || 'Error'}`);
    return 0;
  }
}

// Everything to remember after a batch/pack is final: sent texts and used facts.
function recordSentContent(deviceId, slots, phrases) {
  if (!Array.isArray(phrases) || phrases.length === 0) {
    return;
  }
  const typeBySlot = new Map((Array.isArray(slots) ? slots : []).map((slot) => [slot.slot_id, slot.type]));
  recordSentPhrases(deviceId, phrases.map((phrase) => ({
    text: phrase.text,
    slot_type: typeBySlot.get(phrase.slot_id) || null,
  })));
  recordShownFacts(deviceId, slots, new Set(phrases.map((phrase) => phrase.slot_id)));
}

module.exports = {
  TEXT_RETENTION_DAYS,
  BATCH_DIAGNOSTICS_RETENTION_DAYS,
  DATE_SENSITIVE_FACT_WINDOW_DAYS,
  loadSentArchive,
  findRepeat,
  recordSentPhrases,
  recordSentContent,
  loadShownFacts,
  isFactShown,
  recordShownFacts,
  pruneBatchDiagnostics,
  _test: {
    normalizeSentText,
    hashNormalized,
    factKey,
    resetDiagnosticsPruneThrottle() {
      lastDiagnosticsPruneMs = 0;
    },
  },
};
