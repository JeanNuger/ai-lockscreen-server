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
    window TEXT NOT NULL,       -- 'morning' | 'day' | 'evening'
    phrases TEXT NOT NULL,      -- JSON array of {text, style_id}
    source TEXT NOT NULL,       -- 'openai' | 'fallback'
    context TEXT,               -- JSON: what was sent to OpenAI as context (for admin monitoring)
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
`);

module.exports = db;
