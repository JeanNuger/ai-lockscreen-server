const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-content-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const { BATCH_SIZE, STYLE_IDS } = require('../src/constants');
const {
  generateBatch,
  _test: contentTest,
} = require('../src/contentGenerator');
const {
  selectBankItemsForDevice,
  getBankDateString,
  BANK_CATEGORIES,
  _test: bankTest,
} = require('../src/dailyContentBank');
const {
  getRecentContentMemory,
  recordShownContentMemory,
  pruneOldContentMemory,
} = require('../src/contentMemory');

function phrase(text, style_id = 'A1') {
  return { text, style_id };
}

function validGeneratedPhrases(count = BATCH_SIZE) {
  return Array.from({ length: count }, (_, i) => phrase(`Конкретная строка ${i + 1}`, STYLE_IDS[i % STYLE_IDS.length]));
}

// Script-appropriate filler text per SUPPORTED_LANGUAGES code, so a batch
// tested with languageCode='fr' (etc.) doesn't get its own filler phrases
// rejected by isValidLanguageText's script check (Cyrillic filler would fail
// a Latin/Han/Hiragana/Hangul scriptCheck). Only used to pad a batch to 11
// clean phrases around the one phrase under test -- not meant to look
// natural, just to pass validation and stay unique.
const LANGUAGE_FILLER_TEXT = {
  ru: 'Конкретная строка',
  en: 'Concrete line',
  fr: 'Phrase concrète',
  es: 'Frase concreta',
  pt: 'Frase concreta',
  de: 'Konkreter Satz',
  zh: '具体的句子',
  ja: '具体的な文',
  ko: '구체적인 문장',
  it: 'Frase concreta',
};
function validGeneratedPhrasesForLanguage(languageCode, count = BATCH_SIZE - 1) {
  const base = LANGUAGE_FILLER_TEXT[languageCode];
  return Array.from({ length: count }, (_, i) => phrase(`${base} ${i + 1}`, STYLE_IDS[i % STYLE_IDS.length]));
}

function normalizedTexts(items) {
  return items.map((item) => item.text.trim().replace(/\s+/g, ' ').toLowerCase());
}

// expectedLength defaults to BATCH_SIZE, the common case when nothing was
// rejected -- but the server no longer has any ready-made phrase pool to pad
// a short batch with (see contentGenerator.js's fillWithFallbackPhrases), so
// any call here with at least one rejected/missing phrase legitimately comes
// back shorter than 12. Callers that exercise that pass the real expected
// count explicitly.
function assertFinalBatch(items, expectedLength = BATCH_SIZE) {
  assert.strictEqual(items.length, expectedLength, `final batch must be exactly ${expectedLength}`);
  assert.strictEqual(new Set(normalizedTexts(items)).size, expectedLength, 'final texts must be unique');
  for (const item of items) {
    assert(item.text && item.text.length <= 70, 'final text must be nonempty and within max length');
    assert(STYLE_IDS.includes(item.style_id), `style_id must be valid: ${item.style_id}`);
  }
  assert.strictEqual(new Set(items.map((item) => item.style_id)).size, expectedLength, 'final styles must be unique');
}

function captureConsole(callback) {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const logs = [];
  const errors = [];
  const warnings = [];
  console.log = (message) => logs.push(String(message));
  console.error = (message) => errors.push(String(message));
  console.warn = (message) => warnings.push(String(message));
  return Promise.resolve()
    .then(callback)
    .then((result) => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
      return { result, logs, errors, warnings };
    })
    .catch((err) => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
      throw err;
    });
}

async function main() {
  // Content-quality rebuild (requirement A): every stylistic filter (stop
  // phrases/postcard-cliche guard, question mark, question-shape, generic-bad
  // phrase list, imperative openers, incomplete-sentence guard, coaching,
  // telemetry echo, unsupported-context, date-claim) has been removed from
  // textFilter.js/contentGenerator.js entirely -- the server now only checks
  // schema/empty/too_long/language/duplicate-slot-id/exact-duplicate-text.
  // hasQuestionMark/hasQuestionShapeWithoutMark/isGenericBadLockScreenPhrase/
  // findBlockedPhrase/STOP_PHRASES and friends are no longer exported at all.
  assert.strictEqual(contentTest.hasQuestionMark, undefined, 'hasQuestionMark must no longer be exported (stylistic filters were removed)');
  assert.strictEqual(contentTest.hasQuestionShapeWithoutMark, undefined, 'hasQuestionShapeWithoutMark must no longer be exported');
  assert.strictEqual(contentTest.isGenericBadLockScreenPhrase, undefined, 'isGenericBadLockScreenPhrase must no longer be exported');
  // A former "postcard cliche" phrase (uyut/chai/night poetry etc) must now
  // survive validation untouched -- quality is the model's job (system
  // prompt), not a server-side stylistic filter's.
  assert.strictEqual(
    contentTest.assembleBatchFromGeneratedPhrases(
      [...validGeneratedPhrases().slice(0, 11), phrase('Уют и чай наполняют день теплом.')],
      'ru'
    ).rejectedCount,
    0,
    'former postcard-cliche filler must no longer be rejected -- style filters were removed'
  );

  const validTwelve = validGeneratedPhrases();
  const successAssembly = contentTest.assembleBatchFromGeneratedPhrases(validTwelve, 'ru');
  assertFinalBatch(successAssembly.phrases);
  assert.strictEqual(successAssembly.generatedCount, BATCH_SIZE);
  assert.strictEqual(successAssembly.rejectedCount, 0);
  assert.strictEqual(successAssembly.fallbackFillCount, 0);
  assert.strictEqual(successAssembly.reason, 'success');

  // A question-shaped phrase (with or without an actual "?") is no longer
  // rejected at all -- the question/question-shape guards were removed
  // (requirement A). The remaining too-long/duplicate coverage below already
  // exercises the partial-fill mechanics that the old oneQuestion/
  // oneQuestionShape cases used to.
  assert.strictEqual(
    contentTest.assembleBatchFromGeneratedPhrases(
      [...validTwelve.slice(0, 11), phrase('Это вопрос?')],
      'ru'
    ).rejectedCount,
    0,
    'a question mark alone must no longer cause a rejection'
  );
  assert.strictEqual(
    contentTest.assembleBatchFromGeneratedPhrases(
      [...validTwelve.slice(0, 11), phrase('А ты замечал этот паттерн')],
      'ru'
    ).rejectedCount,
    0,
    'a question-shaped phrase without "?" must no longer cause a rejection'
  );

  // No ready-made phrase pool exists any more to pad a short batch with --
  // a rejected/duplicate phrase's slot is simply left out, so the batch
  // comes back shorter than BATCH_SIZE instead of being padded back up to it.
  const duplicateText = contentTest.assembleBatchFromGeneratedPhrases(
    [...validTwelve.slice(0, 11), phrase('Конкретная строка 1', 'O9')],
    'ru'
  );
  assertFinalBatch(duplicateText.phrases, 11);
  assert.strictEqual(duplicateText.generatedCount, 11);
  assert.strictEqual(duplicateText.rejectedCount, 1);
  assert.strictEqual(duplicateText.fallbackFillCount, 1);

  const tooLongText = contentTest.assembleBatchFromGeneratedPhrases(
    [...validTwelve.slice(0, 10), phrase('Очень длинная строка '.repeat(20)), phrase('Ещё одна очень длинная строка '.repeat(20))],
    'ru'
  );
  assertFinalBatch(tooLongText.phrases, 10);
  assert.strictEqual(tooLongText.generatedCount, 10);
  assert.strictEqual(tooLongText.rejectedCount, 2);
  assert.strictEqual(tooLongText.fallbackFillCount, 2);

  // Every phrase invalid means zero usable text at all -- the batch comes
  // back empty (phrases: null, from validateFinalBatch's length>=1 check),
  // never filled with generic fallback phrases.
  const overlongRu = 'ы'.repeat(contentTest.LOCK_SCREEN_TEXT_MAX_LENGTH + 20);
  const allInvalid = contentTest.assembleBatchFromGeneratedPhrases(
    Array.from({ length: BATCH_SIZE }, () => phrase(overlongRu)),
    'ru'
  );
  assert.strictEqual(allInvalid.phrases, null, 'a batch with zero usable phrases must come back empty, not fallback-filled');
  assert.strictEqual(allInvalid.generatedCount, 0);
  assert.strictEqual(allInvalid.rejectedCount, BATCH_SIZE);
  assert.strictEqual(allInvalid.fallbackFillCount, BATCH_SIZE);
  assert.strictEqual(allInvalid.reason, 'final_assembly_fallback');

  const invalidStyles = contentTest.assembleBatchFromGeneratedPhrases(
    validTwelve.map((p, i) => ({ ...p, style_id: i < 3 ? 'BROKEN_STYLE' : 'A1' })),
    'ru'
  );
  assertFinalBatch(invalidStyles.phrases);
  assert.strictEqual(invalidStyles.generatedCount, BATCH_SIZE);
  assert(invalidStyles.phrases.some((p) => p.text === 'Конкретная строка 1'), 'good text with invalid style_id must be preserved');

  // Content-quality rebuild (requirement A): the date-claim, telemetry-echo,
  // unsupported-context and coaching guards that used to police these exact
  // production-incident phrases were all removed -- the server no longer
  // does any stylistic/semantic policing, only schema/empty/too_long/
  // language/duplicate checks (see textFilter.js). Every one of these
  // production-incident phrases must now survive untouched.
  const formerlyBadPhrases = [
    'Завтра пятница, выходные уже рядом.',
    '75% заряда осталось в батарее.',
    'Сегодня получилось 65 разблокировок подряд.',
    'В пробке подкаст звучит полезнее радио.',
    'Не забудь дать себе немного времени на паузу.',
    'Пора завершать дела.',
    'Попробуй что-то новое.',
    'Экспериментируй на кухне.',
  ];
  for (const nowFine of formerlyBadPhrases) {
    const result = contentTest.assembleBatchFromGeneratedPhrases(
      [...validTwelve.slice(0, 11), phrase(nowFine)],
      'ru',
      { dateContext: { date: '2026-09-19', weekday: 'Saturday', time: '15:30', tomorrow_date: '2026-09-20', tomorrow_weekday: 'Sunday' }, signals: { battery_level: 75, unlocks_since_last_batch: 65 } }
    );
    assertFinalBatch(result.phrases);
    assert.strictEqual(result.rejectedCount, 0, `former stylistic-guard target must no longer be rejected: ${nowFine}`);
  }

  // WINDOW / TIME OF DAY -- still real, unrelated to the removed filters.
  const eveningWindow = contentTest.windowContextFor('evening');
  assert.strictEqual(eveningWindow.id, 'evening');
  assert.strictEqual(eveningWindow.range, '15:00-20:00', 'evening window must expose its actual clock range, not just the id');
  for (const w of ['morning', 'day', 'evening', 'night']) {
    const focus = contentTest.windowContextFor(w).focus;
    assert(typeof focus === 'string' && focus.length > 0, `window ${w} must have a non-empty focus`);
  }
  assert.strictEqual(
    new Set(['morning', 'day', 'evening', 'night'].map((w) => contentTest.windowContextFor(w).focus)).size,
    4,
    'all four windows must have genuinely distinct focus text'
  );

  // buildSystemPrompt (requirement D): now a constant, argument-free,
  // English-only prompt -- see tests/slot-planner.test.js for the full
  // structural check (exact opening/closing sentences, section order,
  // interpolated LOCK_SCREEN_TEXT_MAX_LENGTH). Here just confirm it is still
  // a pure/stable function and no longer depends on any language argument.
  const systemPromptText = contentTest.buildSystemPrompt();
  assert.strictEqual(contentTest.buildSystemPrompt('ru'), systemPromptText, 'buildSystemPrompt must be identical regardless of any argument passed to it');
  assert(/slot_id/.test(systemPromptText), 'prompt must keep OpenAI in slot-writing mode');
  assert(!/profile\.tone/.test(systemPromptText), 'prompt must not depend on the old tone setting');

  // DATE_CONTEXT_UNAVAILABLE: privacy-safe diagnostic (no device id/timezone
  // value in the log line) when the device has no usable timezone yet.
  assert.deepStrictEqual(contentTest.resolveLocalDateContext(undefined), { dateContext: null, unavailableReason: 'missing_timezone' });
  assert.deepStrictEqual(contentTest.resolveLocalDateContext('Not/AZone'), { dateContext: null, unavailableReason: 'invalid_timezone' });
  const validTzResult = contentTest.resolveLocalDateContext('Asia/Almaty');
  assert(validTzResult.dateContext, 'a valid timezone must produce a dateContext');
  assert(validTzResult.dateContext.tomorrow_weekday, 'dateContext must include tomorrow_weekday');
  assert.strictEqual(validTzResult.unavailableReason, null);

  const noTimezoneLogs = await captureConsole(() => generateBatch(
    { device_id: 'device-no-timezone', created_at: '2026-09-17 00:00:00' },
    'day',
    { system_language: 'ru' },
    null
  ));
  assert.deepStrictEqual(noTimezoneLogs.result.phrases, [], 'no OpenAI key must return an empty batch, not fallback phrases');
  assert(
    noTimezoneLogs.warnings.some((line) => line === 'DATE_CONTEXT_UNAVAILABLE reason=missing_timezone'),
    'missing timezone must log a privacy-safe diagnostic reason'
  );
  assert(
    !noTimezoneLogs.warnings.some((line) => /device-no-timezone/.test(line)),
    'diagnostic log must not include the device id'
  );

  assert(!BANK_CATEGORIES.includes('psychology'), 'daily bank must not target psychology');
  assert(!BANK_CATEGORIES.includes('advice'), 'daily bank must not target advice');
  assert(!BANK_CATEGORIES.includes('wish'), 'daily bank must not target wish');

  assert.strictEqual(bankTest.normalizeCountryCode('kz'), 'KZ');
  assert(bankTest.isBankItemAllowedForCountry({
    category: 'good_news',
    content_text: 'A global astronomy item for today.',
    tags: JSON.stringify(['global', 'science']),
  }, 'KZ'), 'global bank item must stay allowed for KZ');
  assert(!bankTest.isBankItemAllowedForCountry({
    category: 'on_this_day',
    content_text: 'Russia marks a country-specific event today.',
    tags: JSON.stringify(['RU']),
  }, 'KZ'), 'Russia-specific item must not be selected for KZ');
  assert(bankTest.isBankItemAllowedForCountry({
    category: 'on_this_day',
    content_text: 'Russia appears in this older untagged bank item.',
    tags: JSON.stringify(['history']),
  }, 'KZ'), 'legacy untagged bank item should not be blocked by country keywords');

  const bankDate = getBankDateString();
  db.prepare(`
    INSERT INTO daily_content_bank (bank_date, category, content_text, tags)
    VALUES (?, ?, ?, ?)
  `).run(bankDate, 'on_this_day', 'Russia marks a country-specific event today.', JSON.stringify(['RU']));
  db.prepare(`
    INSERT INTO daily_content_bank (bank_date, category, content_text, tags)
    VALUES (?, ?, ?, ?)
  `).run(bankDate, 'fact', 'A global astronomy item for today.', JSON.stringify(['global', 'science']));
  // The one thing this test must deterministically guarantee is that the
  // Russia-tagged on_this_day item never leaks into a KZ selection. Missing
  // categories are no longer backfilled from static content.
  const selectedForKz = selectBankItemsForDevice('device-kz', bankDate, '2026-09-18', null, 'KZ', 5);
  assert(
    !selectedForKz.some((item) => item.content_text === 'Russia marks a country-specific event today.'),
    'country=KZ must not select Russia-specific bank item'
  );

  const generatedLogs = await captureConsole(() => generateBatch(
    {
      device_id: 'device-context',
      name: 'Aruzhan',
      interests: JSON.stringify(['work', 'sport', 'creative_arts']),
      personal_goal: 'productivity',
      tone: 'friendly',
      timezone: 'Asia/Almaty',
      created_at: '2026-09-17 00:00:00',
    },
    'day',
    { system_language: 'ru', region: 'RU' },
    { countryCode: 'KZ', city: 'Almaty' }
  ));
  const generated = generatedLogs.result;
  assert.deepStrictEqual(generated.phrases, [], 'no OpenAI key must return an empty batch, not fallback phrases');
  const context = JSON.parse(generated.context);
  assert.strictEqual(context.now.language, 'Russian', 'Russian language should remain output language');
  assert.strictEqual(context.now.country, 'KZ', 'IP country must win over Android locale region');
  assert.strictEqual(context.now.country_source, 'ip_approximate');
  assert.strictEqual(context.now.device_region, 'RU', 'Android RU region should only be retained as device_region');
  assert.strictEqual(context.now.window.id, 'day', 'now.window must still expose its id alongside the new focus field');
  assert(typeof context.now.window.focus === 'string' && context.now.window.focus.length > 0, 'now.window.focus must reach the actual OpenAI payload, not just windowContextFor in isolation');
  assert(Array.isArray(context.slots), 'slot-based context must include selected slots');
  // Content-quality rebuild (requirement B): the planner no longer pads to
  // exactly BATCH_SIZE -- this sparse 'day' fixture (no rich bank items) may
  // legitimately plan fewer than 12 slots.
  assert(context.slots.length > 0 && context.slots.length <= BATCH_SIZE, 'slot-based context must include a non-empty, at-most-BATCH_SIZE slot list');
  assert(!('personal_goal' in (context.profile || {})), 'slot payload must not include old personal_goal');
  assert(!('tone' in (context.profile || {})), 'slot payload must not include old tone');
  assert(!('interests' in (context.profile || {})), 'slot payload must not include old interests');
  const slotText = JSON.stringify(context.slots);
  assert(!/Russia/i.test(slotText), 'KZ context slots must not include Russia-specific bank content');

  const noKeyLogs = await captureConsole(() => generateBatch(
    {
      device_id: 'device-no-key',
      timezone: 'Asia/Almaty',
      created_at: '2026-09-17 00:00:00',
    },
    'day',
    { system_language: 'ru' },
    null
  ));
  assert.deepStrictEqual(noKeyLogs.result.phrases, [], 'no OpenAI key must return an empty batch, not fallback phrases');
  assert.strictEqual(noKeyLogs.result.source, 'fallback');
  assert(noKeyLogs.logs.some((line) => line.includes('reason=no_api_key_fallback')), 'no API key path should log reason');
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS count FROM device_content_memory WHERE device_id = ?').get('device-no-key').count,
    0,
    'global no-api-key fallback must not write content memory'
  );

  db.prepare('INSERT OR IGNORE INTO devices (device_id) VALUES (?)').run('memory-device-a');
  assert.strictEqual(recordShownContentMemory('memory-device-a', [
    { slot_id: 's1', content_key: 'memory-content-a' },
  ], ['s1']), 1, 'direct memory write helper should record generated slot content');
  assert.deepStrictEqual(
    getRecentContentMemory('memory-device-b').map((row) => row.content_key),
    [],
    'content memory must be per-device'
  );
  assert.deepStrictEqual(
    getRecentContentMemory('memory-device-a').map((row) => row.content_key),
    ['memory-content-a'],
    'content memory should be readable for the same device'
  );

  db.prepare('INSERT OR IGNORE INTO devices (device_id) VALUES (?)').run('old-memory-device');
  db.prepare(`
    INSERT INTO device_content_memory (device_id, content_key, topic_key, shown_at)
    VALUES (?, ?, ?, datetime('now', '-46 days'))
  `).run('old-memory-device', 'old-content', null);
  db.prepare(`
    INSERT INTO device_content_memory (device_id, content_key, topic_key, shown_at)
    VALUES (?, ?, ?, datetime('now', '-44 days'))
  `).run('old-memory-device', 'recent-content', null);
  assert.deepStrictEqual(
    getRecentContentMemory('old-memory-device').map((row) => row.content_key),
    ['recent-content'],
    'records older than 45 days must no longer affect selection'
  );
  pruneOldContentMemory();
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS count FROM device_content_memory WHERE content_key = ?').get('old-content').count,
    0,
    'records older than 45 days must be pruned'
  );

  process.env.OPENAI_API_KEY = 'test-key-content-memory';
  let memoryOpenAiCallCount = 0;
  let memoryCapturedRequest = null;
  let memoryPlannedSlotCount = null;
  const memoryOverlongText = 'ы'.repeat(contentTest.LOCK_SCREEN_TEXT_MAX_LENGTH + 20);
  const originalMemoryLoad = Module._load;
  Module._load = function patchedMemoryLoad(request, parent, isMain) {
    if (request === 'openai') {
      return class MockOpenAI {
        constructor() {
          this.chat = {
            completions: {
              create: async (requestBody) => {
                memoryOpenAiCallCount += 1;
                memoryCapturedRequest = requestBody;
                const payload = JSON.parse(requestBody.messages[1].content);
                if (memoryOpenAiCallCount === 1) {
                  memoryPlannedSlotCount = payload.slots.length;
                }
                return {
                  choices: [{
                    message: {
                      content: JSON.stringify({
                        phrases: payload.slots.map((slot, index) => ({
                          slot_id: slot.slot_id,
                          // Stylistic filters (question mark etc) were removed
                          // (requirement A) -- an overlong text is now the
                          // reliable way to force this one slot to keep
                          // failing validation through the repair round too.
                          text: index === payload.slots.length - 1
                            ? memoryOverlongText
                            : `Конкретная строка памяти ${index + 1}`,
                          style_id: STYLE_IDS[index],
                        })),
                      }),
                    },
                  }],
                };
              },
            },
          };
        }
      };
    }
    return originalMemoryLoad.call(this, request, parent, isMain);
  };
  try {
    db.prepare('INSERT OR IGNORE INTO devices (device_id, timezone, created_at) VALUES (?, ?, ?)')
      .run('memory-generation-device', 'Asia/Almaty', '2026-09-17 00:00:00');
    db.prepare(`
      INSERT INTO device_content_memory (device_id, content_key, topic_key)
      VALUES (?, ?, ?)
    `).run('memory-generation-device', 'raw-history-secret-key', null);

    const memoryResult = await generateBatch(
      {
        device_id: 'memory-generation-device',
        timezone: 'Asia/Almaty',
        created_at: '2026-09-17 00:00:00',
      },
      'day',
      { system_language: 'ru' },
      null
    );

    // Owner decision: a rejected slot now gets up to 2 regenerate attempts
    // before it's dropped, not 1 -- the mock's repair handler always answers
    // the (single) rejected slot with the same still-overlong text on every
    // call, so both repair rounds fire (first pass + repair round 1 + repair
    // round 2 = 3 calls) and it stays rejected after both -- under B5 that
    // slot is dropped rather than generic-filled, so the final batch is one
    // shorter than however many slots were actually planned (content-quality
    // rebuild: no longer assumed to be exactly BATCH_SIZE, see requirement B).
    assert.strictEqual(memoryOpenAiCallCount, 3, 'one persistently-rejected slot should trigger two targeted repair OpenAI calls');
    assert.strictEqual(memoryResult.source, 'openai');
    assert(memoryPlannedSlotCount > 0, 'the mock must have observed at least one real planned slot count');
    assertFinalBatch(memoryResult.phrases, memoryPlannedSlotCount - 1);
    const memoryRows = db.prepare(`
      SELECT content_key FROM device_content_memory
      WHERE device_id = ? AND content_key != ?
    `).all('memory-generation-device', 'raw-history-secret-key');
    assert.strictEqual(
      memoryRows.length,
      memoryPlannedSlotCount - 1,
      'only slots with actual valid OpenAI text should write content memory'
    );
    const payloadText = memoryCapturedRequest.messages.map((message) => message.content).join('\n');
    assert(!payloadText.includes('raw-history-secret-key'), 'raw content memory must not be added to OpenAI payload');
    assert(!payloadText.includes('already_shown'), 'device_shown_categories history must not be sent as a prompt history blob');
  } finally {
    Module._load = originalMemoryLoad;
    delete process.env.OPENAI_API_KEY;
  }

  process.env.OPENAI_API_KEY = 'test-key-slot-repair';
  let repairOpenAiCallCount = 0;
  const repairRequestSlotCounts = [];
  const repairRequestSlotIds = [];
  const repairOverlongText = 'x'.repeat(contentTest.LOCK_SCREEN_TEXT_MAX_LENGTH + 20);
  const originalRepairLoad = Module._load;
  Module._load = function patchedRepairLoad(request, parent, isMain) {
    if (request === 'openai') {
      return class MockOpenAI {
        constructor() {
          this.chat = {
            completions: {
              create: async (requestBody) => {
                repairOpenAiCallCount += 1;
                const payload = JSON.parse(requestBody.messages[1].content);
                repairRequestSlotCounts.push(payload.slots.length);
                repairRequestSlotIds.push(payload.slots.map((slot) => slot.slot_id));
                return {
                  choices: [{
                    message: {
                      content: JSON.stringify({
                        phrases: payload.slots.map((slot, index) => ({
                          slot_id: slot.slot_id,
                          text: repairOpenAiCallCount === 1 && index === 2
                            ? repairOverlongText
                            : `Concrete repair line ${repairOpenAiCallCount}-${index + 1}`,
                          style_id: STYLE_IDS[index],
                        })),
                      }),
                    },
                  }],
                };
              },
            },
          };
        }
      };
    }
    return originalRepairLoad.call(this, request, parent, isMain);
  };
  try {
    db.prepare('INSERT OR IGNORE INTO devices (device_id, timezone, created_at) VALUES (?, ?, ?)')
      .run('device-slot-repair', 'Asia/Almaty', '2026-09-17 00:00:00');
    const repairedLogs = await captureConsole(() => generateBatch(
      {
        device_id: 'device-slot-repair',
        timezone: 'Asia/Almaty',
        created_at: '2026-09-17 00:00:00',
      },
      'day',
      { system_language: 'en' },
      null
    ));
    assert.strictEqual(repairOpenAiCallCount, 2, 'one overlong phrase must trigger one targeted repair call');
    // Content-quality rebuild (requirement B): the first-pass slot count is
    // whatever was actually planned for this device/window, no longer
    // assumed to be exactly BATCH_SIZE.
    assert(repairRequestSlotCounts[0] > 0 && repairRequestSlotCounts[0] <= BATCH_SIZE, 'first pass must send the real planned slot count');
    assert.strictEqual(repairRequestSlotCounts[1], 1, 'repair call must send only the rejected slot');
    assert.deepStrictEqual(repairRequestSlotIds[1], [repairRequestSlotIds[0][2]], 'repair call must preserve the rejected slot_id only');
    assertFinalBatch(repairedLogs.result.phrases, repairRequestSlotCounts[0]);
    assert(!repairedLogs.result.phrases.some((item) => item.text === repairOverlongText), 'overlong original text must not survive after repair');
    assert(
      repairedLogs.logs.some((line) => line.includes('reason=success_after_slot_regeneration')),
      'successful repair must be visible in batch logs'
    );
  } finally {
    Module._load = originalRepairLoad;
    delete process.env.OPENAI_API_KEY;
  }

  process.env.OPENAI_API_KEY = 'test-key-no-network';
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'openai') {
      return class MockOpenAI {
        constructor() {
          this.chat = {
            completions: {
              create: async () => {
                throw new Error('mock openai unavailable');
              },
            },
          };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const openAiErrorLogs = await captureConsole(() => generateBatch(
      {
        device_id: 'device-openai-error',
        timezone: 'Asia/Almaty',
        created_at: '2026-09-17 00:00:00',
      },
      'day',
      { system_language: 'ru' },
      null
    ));
    assert.deepStrictEqual(openAiErrorLogs.result.phrases, [], 'OpenAI outage must return an empty batch, not fallback phrases');
    assert.strictEqual(openAiErrorLogs.result.source, 'fallback');
    assert(openAiErrorLogs.logs.some((line) => line.includes('reason=openai_error')), 'OpenAI error path should log fallback reason');
    assert(openAiErrorLogs.errors.some((line) => line.startsWith('OPENAI_ATTEMPT scope=batch result=openai_error')), 'OpenAI error path should log at least one OPENAI_ATTEMPT error line');
  } finally {
    Module._load = originalLoad;
    delete process.env.OPENAI_API_KEY;
  }
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
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
