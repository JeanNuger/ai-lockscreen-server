const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-shown-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const shownRoute = require('../src/routes/shown');
const { loadSeenBlock, SEEN_MAX_PHRASES } = require('../src/seenMemory');
const { getRecallCandidate } = require('../src/learningMemory');

const TODAY = '2026-10-01';

function ensureDevice(id) {
  db.prepare('INSERT OR IGNORE INTO devices (device_id) VALUES (?)').run(id);
}

function insertDeliveredBatch(deviceId, texts, delivered) {
  ensureDevice(deviceId);
  db.prepare(`
    INSERT INTO content_batches (device_id, window, local_date, supports_morning_pack, phrases, source, delivered_at)
    VALUES (?, 'day', ?, 0, ?, 'openai', datetime('now', ?))
  `).run(deviceId, TODAY, JSON.stringify(texts.map((text) => ({ text, style_id: 'A1' }))), delivered);
}

function insertLearnedWord(deviceId, wordText, localDate) {
  ensureDevice(deviceId);
  db.prepare('INSERT INTO device_learning_memory (device_id, word_key, word_text, learned_local_date) VALUES (?, ?, ?, ?)')
    .run(deviceId, `key-${wordText}`, wordText, localDate);
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', shownRoute);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/shown`;
  const post = async (body) => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const nowMs = Date.now();
  const entry = (text, minutesAgo = 5) => ({ text, shown_at: nowMs - minutesAgo * 60000, local_date: TODAY });

  try {
    // --- endpoint: saves, and the same entry sent again is not duplicated ---
    {
      const first = await post({ device_id: 'dev-post', shown: [entry('Phrase one', 10), entry('Phrase two', 9)] });
      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.body.saved, 2);
      const again = await post({ device_id: 'dev-post', shown: [entry('Phrase one', 10), entry('Phrase two', 9), entry('Phrase three', 8)] });
      assert.strictEqual(again.body.saved, 1, 're-sent entries must not be saved again');
      const count = db.prepare('SELECT COUNT(*) AS c FROM shown_phrases WHERE device_id = ?').get('dev-post').c;
      assert.strictEqual(count, 3);
      const row = db.prepare('SELECT shown_at, local_date FROM shown_phrases WHERE device_id = ? AND text = ?').get('dev-post', 'Phrase one');
      assert.strictEqual(row.shown_at, new Date(nowMs - 10 * 60000).toISOString(), 'epoch ms is stored as UTC ISO');
      assert.strictEqual(row.local_date, TODAY);
    }

    // --- endpoint: validation ---
    {
      assert.strictEqual((await post({ shown: [] })).status, 400, 'device_id is required');
      assert.strictEqual((await post({ device_id: 'dev-post' })).status, 400, 'shown must be an array');
      const tooMany = Array.from({ length: 301 }, (_, i) => entry(`bulk ${i}`));
      assert.strictEqual((await post({ device_id: 'dev-bulk', shown: tooMany })).status, 400, 'more than 300 is refused');
      const exactly300 = Array.from({ length: 300 }, (_, i) => entry(`bulk ${i}`, i + 1));
      const ok = await post({ device_id: 'dev-bulk', shown: exactly300 });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.body.saved, 300, '300 entries are accepted');
      const mixed = await post({ device_id: 'dev-mixed', shown: [entry('Good'), { text: '', shown_at: nowMs }, { text: 'No time' }, null] });
      assert.strictEqual(mixed.body.saved, 1, 'invalid entries are skipped, valid ones kept');
      assert.strictEqual(mixed.body.received, 4);
    }

    // --- already_seen: reports from the last 3 days win over delivered texts ---
    {
      insertDeliveredBatch('dev-seen', ['DELIVERED_ONLY_PHRASE', 'DELIVERED_AND_SHOWN'], '-1 hours');
      await post({ device_id: 'dev-seen', shown: [entry('DELIVERED_AND_SHOWN', 30), entry('SHOWN_LATER', 5)] });
      const seen = loadSeenBlock('dev-seen');
      assert.deepStrictEqual(seen.phrases, ['SHOWN_LATER', 'DELIVERED_AND_SHOWN'], 'only shown phrases, newest first');
      assert(!seen.phrases.includes('DELIVERED_ONLY_PHRASE'), 'a delivered but never shown phrase is not "seen"');
    }

    // --- already_seen: cut to 150 and 3 days ---
    {
      ensureDevice('dev-seen-cap');
      const many = Array.from({ length: 200 }, (_, i) => entry(`cap phrase ${i}`, i + 1));
      await post({ device_id: 'dev-seen-cap', shown: many.slice(0, 200).slice(0, 300) });
      const old = { text: 'FOUR_DAYS_OLD', shown_at: nowMs - 4 * 24 * 3600 * 1000, local_date: TODAY };
      await post({ device_id: 'dev-seen-cap', shown: [old] });
      const seen = loadSeenBlock('dev-seen-cap');
      assert.strictEqual(seen.phrases.length, SEEN_MAX_PHRASES);
      assert(!seen.phrases.includes('FOUR_DAYS_OLD'));
    }

    // --- already_seen: no reports in the last 3 days -> delivered texts, as before ---
    {
      insertDeliveredBatch('dev-old-app', ['Delivered one', 'Delivered two'], '-1 hours');
      const seen = loadSeenBlock('dev-old-app');
      assert.deepStrictEqual(seen.phrases.sort(), ['Delivered one', 'Delivered two']);

      // A device whose only report is older than 3 days also falls back to delivered texts.
      insertDeliveredBatch('dev-stale-reports', ['Delivered recent'], '-1 hours');
      await post({ device_id: 'dev-stale-reports', shown: [{ text: 'Shown long ago', shown_at: nowMs - 5 * 24 * 3600 * 1000, local_date: TODAY }] });
      assert.deepStrictEqual(loadSeenBlock('dev-stale-reports').phrases, ['Delivered recent']);
    }

    // --- night recall: reminds the morning word only if it was shown ---
    {
      const word = 'Синкретизм: слияние разных начал';
      insertLearnedWord('dev-recall-shown', word, TODAY);
      await post({ device_id: 'dev-recall-shown', shown: [entry(word, 600), entry('Something else', 5)] });
      const candidate = getRecallCandidate('dev-recall-shown', TODAY);
      assert(candidate, 'a morning word that was shown is recalled');
      assert.strictEqual(candidate.word_text, word);

      insertLearnedWord('dev-recall-unshown', word, TODAY);
      await post({ device_id: 'dev-recall-unshown', shown: [entry('Something else', 5)] });
      assert.strictEqual(getRecallCandidate('dev-recall-unshown', TODAY), null,
        'a device that reports, but never showed the word, is not reminded of it');
    }

    // --- night recall: a device that never reports behaves as before ---
    {
      insertLearnedWord('dev-recall-oldapp', 'Word of the morning', TODAY);
      const candidate = getRecallCandidate('dev-recall-oldapp', TODAY);
      assert(candidate, 'no reports at all -> the morning word is recalled as before');
      assert.strictEqual(candidate.word_text, 'Word of the morning');
    }
  } finally {
    server.close();
  }
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('shown-reports tests passed');
  })
  .catch((err) => {
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {
      // best effort cleanup
    }
    console.error(err);
    process.exit(1);
  });
