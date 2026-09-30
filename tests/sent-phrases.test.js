// Coverage for the sent-phrases memory (src/sentPhrases.js):
//   1. An exact repeat of a sent phrase is rejected (reason 'repeat', detail 'repeat_exact').
//   2. A near repeat (Jaccard >= 0.8) is rejected (detail 'repeat_near'); a different phrase is not.
//   3. greeting_name / goodnight_care are never rejected; weather_lifehack is.
//   4. Text older than 35 days is scrubbed when new phrases are written; the hash stays,
//      so exact repeats are still caught but near repeats of scrubbed text are not.
//   5. A Daily Bank fact that was already used is not offered again; date-sensitive
//      categories come back after 300 days, other categories never.
//   6. content_batches.context / trace_json are cleared after 30 days.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-sent-phrases-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const sentPhrases = require('../src/sentPhrases');
const { _test: contentTest } = require('../src/contentGenerator');
const { _test: plannerTest } = require('../src/slotPlanner');
const { selectBankItemsForDevice } = require('../src/dailyContentBank');

function addDevice(deviceId) {
  db.prepare('INSERT OR IGNORE INTO devices (device_id) VALUES (?)').run(deviceId);
}

function collect(deviceId, text, slotType) {
  const validationContext = { sentArchive: sentPhrases.loadSentArchive(deviceId) };
  const slots = [{ slot_id: 's1', type: slotType }];
  return contentTest.collectUsablePhrases([{ slot_id: 's1', text, style_id: 'A1' }], null, validationContext, slots);
}

function testExactRepeatRejected() {
  addDevice('exact');
  sentPhrases.recordSentPhrases('exact', [{ text: 'Сегодня отличный день для прогулки', slot_type: 'everyday_lifehack' }]);

  const result = collect('exact', 'сегодня  ОТЛИЧНЫЙ день для прогулки!', 'everyday_lifehack');
  assert.strictEqual(result.accepted.length, 0);
  assert.deepStrictEqual(result.rejectedSlotIds, ['s1']);
  assert.strictEqual(result.rejectionReasons.repeat, 1);
  assert.strictEqual(result.rejectedDetails[0].detail, 'repeat_exact');

  const other = collect('exact', 'Совсем другая мысль про вечерний чай', 'everyday_lifehack');
  assert.strictEqual(other.accepted.length, 1);

  addDevice('someone-else');
  const otherDevice = collect('someone-else', 'Сегодня отличный день для прогулки', 'everyday_lifehack');
  assert.strictEqual(otherDevice.accepted.length, 1, 'the archive is per device');
}

function testNearRepeatRejected() {
  addDevice('near');
  sentPhrases.recordSentPhrases('near', [{ text: 'Сегодня отличный день для прогулки', slot_type: 'everyday_lifehack' }]);

  // 5 of 6 distinct words shared -> Jaccard 0.83
  const near = collect('near', 'Сегодня отличный день для долгой прогулки', 'everyday_lifehack');
  assert.strictEqual(near.accepted.length, 0);
  assert.strictEqual(near.rejectedDetails[0].detail, 'repeat_near');

  // 3 of 7 distinct words shared -> well below 0.8
  const different = collect('near', 'Сегодня отличный повод позвонить старому другу', 'everyday_lifehack');
  assert.strictEqual(different.accepted.length, 1);
}

function testExemptAndCheckedTypes() {
  addDevice('types');
  const text = 'Доброе утро, Алина';
  sentPhrases.recordSentPhrases('types', [
    { text, slot_type: 'greeting_name' },
    { text: 'Спокойной ночи, Алина', slot_type: 'goodnight_care' },
    { text: 'Возьми зонт, сегодня дождь', slot_type: 'weather_lifehack' },
  ]);

  assert.strictEqual(collect('types', text, 'greeting_name').accepted.length, 1, 'greeting is not checked');
  assert.strictEqual(collect('types', 'Спокойной ночи, Алина', 'goodnight_care').accepted.length, 1, 'goodnight is not checked');
  assert.strictEqual(collect('types', 'Возьми зонт, сегодня дождь', 'weather_lifehack').accepted.length, 0, 'weather_lifehack is checked');
  assert.strictEqual(collect('types', text, 'fun_fact').accepted.length, 0, 'same text in a checked slot is a repeat');
}

function testOldTextIsScrubbedButHashStays() {
  addDevice('scrub');
  const oldText = 'Старая фраза про осенний парк и тишину';
  sentPhrases.recordSentPhrases('scrub', [{ text: oldText, slot_type: 'culture' }]);
  db.prepare("UPDATE sent_phrases SET sent_at = datetime('now', '-40 days') WHERE device_id = 'scrub'").run();

  // A fresh write scrubs the text of rows older than 35 days.
  sentPhrases.recordSentPhrases('scrub', [{ text: 'Новая фраза про утренний кофе', slot_type: 'culture' }]);
  const rows = db.prepare('SELECT text_norm, text_norm_hash FROM sent_phrases WHERE device_id = ? ORDER BY id').all('scrub');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].text_norm, null, 'old text is cleared');
  assert.ok(rows[0].text_norm_hash > 0, 'old hash is kept');
  assert.ok(rows[1].text_norm, 'new text is kept');

  assert.strictEqual(collect('scrub', oldText, 'culture').rejectedDetails[0].detail, 'repeat_exact');
  assert.strictEqual(collect('scrub', 'Старая фраза про осенний парк и тишину сегодня', 'culture').accepted.length, 1,
    'near repeats are only checked against text that is still stored');
  assert.strictEqual(collect('scrub', 'Новая фраза про утренний кофе сегодня', 'culture').accepted.length, 0,
    'near repeat of recent text is rejected');
}

function testShownBankFactIsNotOfferedAgain() {
  addDevice('facts');
  const bankDate = '2026-09-30';
  const insertBank = db.prepare('INSERT INTO daily_content_bank (bank_date, category, content_text) VALUES (?, ?, ?)');
  const factText = 'Осьминоги имеют три сердца.';
  const factId = insertBank.run(bankDate, 'fact', factText).lastInsertRowid;
  const holidayText = 'День примера отмечают 30 сентября.';
  insertBank.run(bankDate, 'holiday', holidayText);

  const select = () => selectBankItemsForDevice('facts', bankDate, bankDate, null, null, 5);
  const categories = (items) => items.map((item) => item.category).sort();
  assert.deepStrictEqual(categories(select()), ['fact', 'holiday']);

  // Record exactly the way generateBatch does: the slot built from the real bank candidate.
  const candidate = plannerTest.bankItemToCandidate({ id: factId, category: 'fact', content_text: factText });
  const slot = { slot_id: 's1', type: candidate.type, source: candidate.source, facts: candidate.facts };
  sentPhrases.recordSentContent('facts', [slot], [{ slot_id: 's1', text: 'Три сердца у осьминога' }]);
  assert.deepStrictEqual(categories(select()), ['holiday'], 'the used fact is gone');

  // A slot whose phrase was dropped does not consume its fact.
  sentPhrases.recordSentContent('facts', [{ ...slot, facts: { text: holidayText }, slot_id: 's2' }], [{ slot_id: 's9', text: 'x' }]);
  assert.deepStrictEqual(categories(select()), ['holiday']);

  // Other devices are unaffected.
  addDevice('facts-other');
  assert.deepStrictEqual(categories(selectBankItemsForDevice('facts-other', bankDate, bankDate, null, null, 5)), ['fact', 'holiday']);

  // Evergreen category: still hidden after a year. Date-sensitive: back after 300 days.
  db.prepare("UPDATE device_shown_facts SET shown_at = datetime('now', '-400 days') WHERE device_id = 'facts'").run();
  assert.deepStrictEqual(categories(select()), ['holiday']);

  const shown = sentPhrases.loadShownFacts('facts');
  assert.strictEqual(sentPhrases.isFactShown(shown, 'fact', factText), true, 'evergreen fact key is known');
  sentPhrases.recordShownFacts('facts', [{ slot_id: 's1', source: 'daily_bank', facts: { text: holidayText } }], new Set(['s1']));
  assert.strictEqual(sentPhrases.isFactShown(sentPhrases.loadShownFacts('facts'), 'holiday', holidayText), true);
  db.prepare("UPDATE device_shown_facts SET shown_at = datetime('now', '-301 days') WHERE device_id = 'facts'").run();
  const later = sentPhrases.loadShownFacts('facts');
  assert.strictEqual(sentPhrases.isFactShown(later, 'holiday', holidayText), false, 'holiday facts return after 300 days');
  assert.strictEqual(sentPhrases.isFactShown(later, 'fact', holidayText), true, 'other categories never return');
}

function testOldBatchDiagnosticsAreCleared() {
  addDevice('diag');
  const insert = db.prepare(`
    INSERT INTO content_batches (device_id, window, local_date, phrases, source, context, trace_json, delivered_at)
    VALUES ('diag', 'morning', ?, '[]', 'openai', 'ctx', '{"t":1}', datetime('now', ?))
  `);
  insert.run('2026-08-01', '-31 days');
  insert.run('2026-09-25', '-2 days');

  sentPhrases._test.resetDiagnosticsPruneThrottle();
  sentPhrases.recordSentPhrases('diag', [{ text: 'Любая новая фраза', slot_type: 'culture' }]);

  const rows = db.prepare('SELECT context, trace_json, phrases FROM content_batches WHERE device_id = ? ORDER BY id').all('diag');
  assert.strictEqual(rows[0].context, null);
  assert.strictEqual(rows[0].trace_json, null);
  assert.strictEqual(rows[0].phrases, '[]', 'sent phrases of old batches are kept');
  assert.strictEqual(rows[1].context, 'ctx');
  assert.strictEqual(rows[1].trace_json, '{"t":1}');
}

testExactRepeatRejected();
testNearRepeatRejected();
testExemptAndCheckedTypes();
testOldTextIsScrubbedButHashStays();
testShownBankFactIsNotOfferedAgain();
testOldBatchDiagnosticsAreCleared();
console.log('[sent-phrases] all scenarios passed');
