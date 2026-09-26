const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATABASE_PATH = process.env.DATABASE_PATH || './data/app.db';

// Ensure the directory for the DB file exists (better-sqlite3 won't create it).
const dir = path.dirname(DATABASE_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DATABASE_PATH);
db.pragma('journal_mode = WAL');

// Minimal schema — matches the API contract in SERVER_PLAN.md / PRODUCT_REBUILD_PLAN.md §4.
// devices: one row per anonymous device_id (no accounts — see plan §3 "В MVP не входит: сложные аккаунты").
// content_batches: history of what was sent, kept mainly for debugging/economics tracking (§4.4 token economics),
//   and now doubles as the data source for the admin monitoring page.
// admin_messages / admin_message_deliveries: manual messages an admin can inject into a device's
//   (or all devices') next batch, alongside the normal AI-generated phrases — added per product
//   decision to support real-time manual broadcast/targeted messaging from the admin panel.
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    name TEXT,
    gender TEXT,
    birth_date TEXT,
    interests TEXT,        -- JSON array, e.g. ["sport","work"]
    personal_goal TEXT,
    tone TEXT,
    timezone TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS content_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    window TEXT NOT NULL,       -- 'morning' | 'day' | 'evening' | 'night'
    local_date TEXT,            -- device-local date used for generation/cache key
    supports_morning_pack INTEGER NOT NULL DEFAULT 0,
    phrases TEXT NOT NULL,      -- JSON array of {text, style_id}
    source TEXT NOT NULL,       -- 'openai' | 'fallback'
    context TEXT,               -- JSON: what was sent to OpenAI as context (for admin monitoring)
    trace_json TEXT,            -- JSON: per-slot generation trace for debugging
    delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
  );

  CREATE INDEX IF NOT EXISTS idx_content_batches_device ON content_batches(device_id);
  CREATE INDEX IF NOT EXISTS idx_content_batches_delivered_at ON content_batches(delivered_at);

  CREATE TABLE IF NOT EXISTS admin_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_device_id TEXT,      -- NULL means broadcast to every device
    text TEXT NOT NULL,
    style_id TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_message_deliveries (
    message_id INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (message_id, device_id),
    FOREIGN KEY (message_id) REFERENCES admin_messages(id)
  );

  -- daily_content_bank: the shared, non-personalized "content of the day"
  -- collected once per day via a web-search-enabled OpenAI call (see
  -- src/dailyContentBank.js) -- holidays, "on this day" facts, quotes, etc.
  -- bank_date is the shared Asia/Almaty product-day date (not per-device
  -- local date) since this bank is shared across every device, not per-user.
  CREATE TABLE IF NOT EXISTS daily_content_bank (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_date TEXT NOT NULL,
    category TEXT NOT NULL,
    content_text TEXT NOT NULL,
    tags TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_daily_content_bank_date ON daily_content_bank(bank_date);

  -- device_shown_categories: which daily_content_bank categories a device has
  -- already seen on a given day, so the per-window personalization step
  -- (added separately) can avoid repeating the same category to the same
  -- device within one day.
  CREATE TABLE IF NOT EXISTS device_shown_categories (
    device_id TEXT NOT NULL,
    shown_date TEXT NOT NULL,
    category TEXT NOT NULL,
    PRIMARY KEY (device_id, shown_date, category),
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
  );

  CREATE TABLE IF NOT EXISTS phone_signal_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    window TEXT NOT NULL,
    device_local_date TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    unlocks_since_last_batch INTEGER,
    steps_since_last_batch INTEGER,
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
  );

  CREATE INDEX IF NOT EXISTS idx_phone_signal_samples_history
    ON phone_signal_samples(device_id, window, device_local_date);
  CREATE INDEX IF NOT EXISTS idx_phone_signal_samples_recorded_at
    ON phone_signal_samples(recorded_at);

  CREATE TABLE IF NOT EXISTS device_content_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    content_key TEXT NOT NULL,
    topic_key TEXT,
    shown_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
  );

  CREATE INDEX IF NOT EXISTS idx_device_content_memory_recent
    ON device_content_memory(device_id, shown_at);
  CREATE INDEX IF NOT EXISTS idx_device_content_memory_content
    ON device_content_memory(device_id, content_key);
  CREATE INDEX IF NOT EXISTS idx_device_content_memory_topic
    ON device_content_memory(device_id, topic_key);

  -- device_learning_memory: Phase 4 "word of the day" -> "remember the word X?"
  -- recall memory. Deliberately separate from device_content_memory (which is
  -- a broad anti-repeat log) -- this table drives a specific recall queue
  -- (2-14 day eligibility window, at most one successful recall per learned
  -- word), not generic repeat avoidance. See HANDOFF_2 Phase 4.
  CREATE TABLE IF NOT EXISTS device_learning_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    word_key TEXT NOT NULL,
    word_text TEXT NOT NULL,
    learned_at TEXT NOT NULL DEFAULT (datetime('now')),
    recalled_at TEXT,
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
  );

  CREATE INDEX IF NOT EXISTS idx_device_learning_memory_recall
    ON device_learning_memory(device_id, recalled_at, learned_at);

  -- morning_packs: the "morning pack" feature -- a fixed, mandatory 7-slot set
  -- (greeting_name -> holiday_today -> weather_lifehack -> history_today ->
  -- daily_horoscope -> daily_numerology -> word_learning) generated the
  -- EVENING BEFORE and delivered to the client alongside a normal /batch
  -- response, so it's already cached locally with no network needed at wake
  -- time. Keyed by (device_id, local_date) with a UNIQUE constraint so the
  -- pack for a given device/date is generated exactly once -- a second
  -- concurrent request that loses the race on INSERT reads back the winner's
  -- row instead of generating (or storing) a duplicate. local_date is the
  -- pack's target_date (the calendar date the pack's content is FOR), not the
  -- date it was generated/requested on.
  CREATE TABLE IF NOT EXISTS morning_packs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    local_date TEXT NOT NULL,
    pack_json TEXT NOT NULL,
    trace_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (device_id, local_date),
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
  );

  CREATE INDEX IF NOT EXISTS idx_morning_packs_device_date
    ON morning_packs(device_id, local_date);
`);

// One-off migration: devices.name is new as of 2026-09-12. This project has no
// migration framework and the CREATE TABLE IF NOT EXISTS above is a no-op
// against a devices table that already exists (true on Render's persistent
// disk, and on any local dev db.file created before this change) — a new
// column there needs an explicit ALTER TABLE, not just an updated CREATE
// statement. Guarded by checking PRAGMA table_info first so this stays a
// harmless no-op on every subsequent server start (a second ALTER TABLE ADD
// COLUMN of the same name would otherwise throw "duplicate column name")
// instead of only working once.
const deviceColumnNames = db.prepare('PRAGMA table_info(devices)').all().map((col) => col.name);
if (!deviceColumnNames.includes('name')) {
  db.exec('ALTER TABLE devices ADD COLUMN name TEXT');
}

const contentBatchColumnNames = db.prepare('PRAGMA table_info(content_batches)').all().map((col) => col.name);
if (!contentBatchColumnNames.includes('local_date')) {
  db.exec('ALTER TABLE content_batches ADD COLUMN local_date TEXT');
}
if (!contentBatchColumnNames.includes('supports_morning_pack')) {
  db.exec('ALTER TABLE content_batches ADD COLUMN supports_morning_pack INTEGER NOT NULL DEFAULT 0');
}
if (!contentBatchColumnNames.includes('trace_json')) {
  db.exec('ALTER TABLE content_batches ADD COLUMN trace_json TEXT');
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_content_batches_reuse_key
    ON content_batches(device_id, window, local_date, supports_morning_pack, id)
`);

module.exports = db;
