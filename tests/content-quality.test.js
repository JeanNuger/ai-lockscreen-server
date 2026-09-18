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
  buildFallbackBatch,
  _test: contentTest,
} = require('../src/contentGenerator');
const {
  selectBankItemsForDevice,
  getBankDateString,
  BANK_CATEGORIES,
  _test: bankTest,
} = require('../src/dailyContentBank');

function phrase(text, style_id = 'A1') {
  return { text, style_id };
}

function validGeneratedPhrases(count = BATCH_SIZE) {
  return Array.from({ length: count }, (_, i) => phrase(`Конкретная строка ${i + 1}`, STYLE_IDS[i % STYLE_IDS.length]));
}

function normalizedTexts(items) {
  return items.map((item) => item.text.trim().replace(/\s+/g, ' ').toLowerCase());
}

function assertFinalBatch(items) {
  assert.strictEqual(items.length, BATCH_SIZE, 'final batch must be exactly 12');
  assert.strictEqual(new Set(normalizedTexts(items)).size, BATCH_SIZE, 'final texts must be unique');
  for (const item of items) {
    assert(item.text && item.text.length <= 140, 'final text must be nonempty and within max length');
    assert(STYLE_IDS.includes(item.style_id), `style_id must be valid: ${item.style_id}`);
  }
  assert.strictEqual(new Set(items.map((item) => item.style_id)).size, BATCH_SIZE, 'final styles must be unique');
}

function captureConsole(callback) {
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const errors = [];
  console.log = (message) => logs.push(String(message));
  console.error = (message) => errors.push(String(message));
  return Promise.resolve()
    .then(callback)
    .then((result) => {
      console.log = originalLog;
      console.error = originalError;
      return { result, logs, errors };
    })
    .catch((err) => {
      console.log = originalLog;
      console.error = originalError;
      throw err;
    });
}

async function main() {
  const fallback = buildFallbackBatch('ru');
  assert.strictEqual(fallback.length, BATCH_SIZE, 'fallback batch must stay exactly 12');
  assert.strictEqual(new Set(fallback.map((p) => p.style_id)).size, BATCH_SIZE, 'fallback styles must be unique');

  const badFallbackText = fallback.map((p) => p.text).join('\n');
  for (const bad of [
    'Скорее всего, есть одна вещь, с которой стоит начать',
    'Маленькие улучшения тоже меняют форму',
    'В дне есть место для более точного угла',
    'Следующему действию не нужна церемония',
    'Чистый старт подходит любому дню',
    'Экран блокировки',
    'Обои',
    'приложения',
  ]) {
    assert(!badFallbackText.includes(bad), `fallback must not include generic bad phrase: ${bad}`);
  }

  assert(contentTest.hasQuestionMark('Это вопрос?'), 'question mark must be blocked');
  assert(contentTest.hasQuestionShapeWithoutMark('Знаешь ли ты, что сегодня произошло'), 'Russian question-shaped text without ? must be blocked');
  assert(contentTest.hasQuestionShapeWithoutMark('Почему бы не открыть план'), 'Russian "why not" question shape must be blocked');
  assert(contentTest.isGenericBadLockScreenPhrase('Следующему действию не нужна церемония.'), 'known generic bad example must be blocked');

  const validTwelve = validGeneratedPhrases();
  const successAssembly = contentTest.assembleBatchFromGeneratedPhrases(validTwelve, 'ru');
  assertFinalBatch(successAssembly.phrases);
  assert.strictEqual(successAssembly.generatedCount, BATCH_SIZE);
  assert.strictEqual(successAssembly.rejectedCount, 0);
  assert.strictEqual(successAssembly.fallbackFillCount, 0);
  assert.strictEqual(successAssembly.reason, 'success');

  const oneQuestion = contentTest.assembleBatchFromGeneratedPhrases(
    [...validTwelve.slice(0, 11), phrase('Это вопрос?')],
    'ru'
  );
  assertFinalBatch(oneQuestion.phrases);
  assert.strictEqual(oneQuestion.generatedCount, 11);
  assert.strictEqual(oneQuestion.rejectedCount, 1);
  assert.strictEqual(oneQuestion.fallbackFillCount, 1);
  assert.strictEqual(oneQuestion.reason, 'partial_validation_fill');
  assert(oneQuestion.phrases.some((p) => p.text === 'Конкретная строка 1'), 'valid generated text must be preserved');

  const oneQuestionShape = contentTest.assembleBatchFromGeneratedPhrases(
    [...validTwelve.slice(0, 11), phrase('А ты замечал этот паттерн')],
    'ru'
  );
  assertFinalBatch(oneQuestionShape.phrases);
  assert.strictEqual(oneQuestionShape.generatedCount, 11);
  assert.strictEqual(oneQuestionShape.rejectedCount, 1);
  assert.strictEqual(oneQuestionShape.fallbackFillCount, 1);

  const duplicateText = contentTest.assembleBatchFromGeneratedPhrases(
    [...validTwelve.slice(0, 11), phrase('Конкретная строка 1', 'O9')],
    'ru'
  );
  assertFinalBatch(duplicateText.phrases);
  assert.strictEqual(duplicateText.generatedCount, 11);
  assert.strictEqual(duplicateText.rejectedCount, 1);
  assert.strictEqual(duplicateText.fallbackFillCount, 1);

  const tooLongText = contentTest.assembleBatchFromGeneratedPhrases(
    [...validTwelve.slice(0, 10), phrase('Очень длинная строка '.repeat(20)), phrase('Ещё одна очень длинная строка '.repeat(20))],
    'ru'
  );
  assertFinalBatch(tooLongText.phrases);
  assert.strictEqual(tooLongText.generatedCount, 10);
  assert.strictEqual(tooLongText.rejectedCount, 2);
  assert.strictEqual(tooLongText.fallbackFillCount, 2);

  const allInvalid = contentTest.assembleBatchFromGeneratedPhrases(
    Array.from({ length: BATCH_SIZE }, (_, i) => phrase(`Это вопрос ${i}?`)),
    'ru'
  );
  assertFinalBatch(allInvalid.phrases);
  assert.strictEqual(allInvalid.generatedCount, 0);
  assert.strictEqual(allInvalid.rejectedCount, BATCH_SIZE);
  assert.strictEqual(allInvalid.fallbackFillCount, BATCH_SIZE);
  assert.strictEqual(allInvalid.reason, 'all_invalid_fallback');

  const invalidStyles = contentTest.assembleBatchFromGeneratedPhrases(
    validTwelve.map((p, i) => ({ ...p, style_id: i < 3 ? 'BROKEN_STYLE' : 'A1' })),
    'ru'
  );
  assertFinalBatch(invalidStyles.phrases);
  assert.strictEqual(invalidStyles.generatedCount, BATCH_SIZE);
  assert(invalidStyles.phrases.some((p) => p.text === 'Конкретная строка 1'), 'good text with invalid style_id must be preserved');

  assert(!BANK_CATEGORIES.includes('psychology'), 'daily bank must not target psychology');
  assert(!BANK_CATEGORIES.includes('advice'), 'daily bank must not target advice');
  assert(!BANK_CATEGORIES.includes('wish'), 'daily bank must not target wish');

  assert.strictEqual(bankTest.normalizeCountryCode('kz'), 'KZ');
  assert(bankTest.isBankItemAllowedForCountry({
    category: 'fact',
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
  const selectedForKz = selectBankItemsForDevice('device-kz', bankDate, '2026-09-18', null, 'KZ', 5);
  assert.deepStrictEqual(
    selectedForKz.map((item) => item.content_text),
    ['A global astronomy item for today.'],
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
  assert.strictEqual(generated.phrases.length, BATCH_SIZE, 'fallback generateBatch must still return 12');
  const context = JSON.parse(generated.context);
  assert.strictEqual(context.now.language, 'Russian', 'Russian language should remain output language');
  assert.strictEqual(context.now.country, 'KZ', 'IP country must win over Android locale region');
  assert.strictEqual(context.now.country_source, 'ip_approximate');
  assert.strictEqual(context.now.device_region, 'RU', 'Android RU region should only be retained as device_region');
  assert(context.today_content.every((item) => !/Russia/i.test(item.text)), 'KZ context must not include Russia-specific today_content');

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
  assertFinalBatch(noKeyLogs.result.phrases);
  assert.strictEqual(noKeyLogs.result.source, 'fallback');
  assert(noKeyLogs.logs.some((line) => line.includes('reason=no_api_key_fallback')), 'no API key path should log reason');

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
    assertFinalBatch(openAiErrorLogs.result.phrases);
    assert.strictEqual(openAiErrorLogs.result.source, 'fallback');
    assert(openAiErrorLogs.logs.some((line) => line.includes('reason=openai_error')), 'OpenAI error path should log fallback reason');
    assert(openAiErrorLogs.errors.some((line) => line.includes('reason=openai_error')), 'OpenAI error path should log one error line');
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
