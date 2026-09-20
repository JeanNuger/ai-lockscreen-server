const db = require('./db');

const RETENTION_DAYS = 45;

const selectRecentMemoryStatement = db.prepare(`
  SELECT content_key, topic_key, shown_at
  FROM device_content_memory
  WHERE device_id = ?
    AND shown_at >= datetime('now', ?)
  ORDER BY shown_at DESC, id DESC
`);

const insertMemoryStatement = db.prepare(`
  INSERT INTO device_content_memory (device_id, content_key, topic_key)
  VALUES (?, ?, ?)
`);

const pruneOldMemoryStatement = db.prepare(`
  DELETE FROM device_content_memory
  WHERE shown_at < datetime('now', ?)
`);

function normalizeKey(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getRecentContentMemory(deviceId) {
  if (!deviceId) {
    return [];
  }
  pruneOldContentMemory();
  return selectRecentMemoryStatement.all(deviceId, `-${RETENTION_DAYS} days`);
}

function recordShownContentMemory(deviceId, slots = [], generatedSlotIds = []) {
  if (!deviceId || !Array.isArray(slots) || !Array.isArray(generatedSlotIds)) {
    return 0;
  }

  const generated = new Set(generatedSlotIds);
  const rows = slots
    .filter((slot) => slot && generated.has(slot.slot_id))
    .map((slot) => ({
      content_key: normalizeKey(slot.content_key || slot.id),
      topic_key: normalizeKey(slot.topic_key),
    }))
    .filter((row) => row.content_key);

  if (rows.length === 0) {
    return 0;
  }

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertMemoryStatement.run(deviceId, item.content_key, item.topic_key);
    }
  });
  insertMany(rows);
  pruneOldContentMemory();
  return rows.length;
}

function pruneOldContentMemory() {
  return pruneOldMemoryStatement.run(`-${RETENTION_DAYS} days`).changes;
}

module.exports = {
  RETENTION_DAYS,
  getRecentContentMemory,
  recordShownContentMemory,
  pruneOldContentMemory,
  _test: {
    normalizeKey,
  },
};
