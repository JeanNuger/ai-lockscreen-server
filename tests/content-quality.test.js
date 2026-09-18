const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-content-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const { BATCH_SIZE } = require('../src/constants');
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

  const validTwelve = Array.from({ length: BATCH_SIZE }, (_, i) => phrase(`Конкретная строка ${i + 1}`, `A${(i % 9) + 1}`));
  assert(contentTest.cleanUsablePhrases(validTwelve), 'valid 12-item batch should pass');
  assert.strictEqual(
    contentTest.cleanUsablePhrases([...validTwelve.slice(0, 11), phrase('А ты замечал этот паттерн')]),
    null,
    'question-shaped phrase without ? must invalidate a 12-item batch'
  );
  assert.strictEqual(
    contentTest.cleanUsablePhrases([...validTwelve.slice(0, 11), phrase('Скорее всего, есть одна вещь, с которой стоит начать')]),
    null,
    'generic bad phrase must invalidate a 12-item batch'
  );

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

  const generated = await generateBatch(
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
  );
  assert.strictEqual(generated.phrases.length, BATCH_SIZE, 'fallback generateBatch must still return 12');
  const context = JSON.parse(generated.context);
  assert.strictEqual(context.now.language, 'Russian', 'Russian language should remain output language');
  assert.strictEqual(context.now.country, 'KZ', 'IP country must win over Android locale region');
  assert.strictEqual(context.now.country_source, 'ip_approximate');
  assert.strictEqual(context.now.device_region, 'RU', 'Android RU region should only be retained as device_region');
  assert(context.today_content.every((item) => !/Russia/i.test(item.text)), 'KZ context must not include Russia-specific today_content');
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
