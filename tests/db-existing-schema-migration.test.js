const assert = require('assert');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-db-migration-test-'));
const dbPath = path.join(tempDir, 'old-app.db');

function createOldSchemaDatabase() {
  const oldDb = new Database(dbPath);
  oldDb.exec(`
    CREATE TABLE devices (
      device_id TEXT PRIMARY KEY,
      gender TEXT,
      birth_date TEXT,
      interests TEXT,
      personal_goal TEXT,
      tone TEXT,
      timezone TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE content_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      window TEXT NOT NULL,
      phrases TEXT NOT NULL,
      source TEXT NOT NULL,
      context TEXT,
      delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (device_id) REFERENCES devices(device_id)
    );
  `);
  oldDb.close();
}

function columnNames(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((col) => col.name);
}

function indexNames(db, tableName) {
  return db.prepare(`PRAGMA index_list(${tableName})`).all().map((index) => index.name);
}

try {
  createOldSchemaDatabase();
  process.env.DATABASE_PATH = dbPath;

  const db = require('../src/db');
  const deviceColumns = columnNames(db, 'devices');
  const batchColumns = columnNames(db, 'content_batches');
  const batchIndexes = indexNames(db, 'content_batches');

  assert(deviceColumns.includes('name'), 'devices.name must be added on startup');
  assert(batchColumns.includes('local_date'), 'content_batches.local_date must be added on startup');
  assert(batchColumns.includes('supports_morning_pack'), 'content_batches.supports_morning_pack must be added on startup');
  assert(batchColumns.includes('trace_json'), 'content_batches.trace_json must be added on startup');
  assert(batchIndexes.includes('idx_content_batches_reuse_key'), 'reuse index must be created after migrated columns exist');

  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('db-existing-schema-migration.test.js: all assertions passed');
} catch (err) {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best effort cleanup
  }
  console.error(err);
  process.exit(1);
}
