const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-bank-sources-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const { BATCH_SIZE, STYLE_IDS } = require('../src/constants');
const {
  BANK_CATEGORIES,
  selectBankItemsForDevice,
  generateDailyBank,
  getBankDateString,
  _test: bankTest,
} = require('../src/dailyContentBank');
const {
  CONTENT_TYPES,
  FACTUAL_TYPES,
  _test: plannerTest,
} = require('../src/slotPlanner');
const {
  generateBatch,
} = require('../src/contentGenerator');

const EXPECTED_CATEGORIES = [
  'holiday', 'on_this_day', 'humor', 'idiom', 'statistic',
  'quote', 'science', 'technology', 'economics', 'fact',
  'country_fact', 'good_news',
];

const EXPECTED_MAPPING = {
  holiday: 'holiday_today',
  on_this_day: 'history_today',
  humor: 'smart_humor_observation',
  idiom: 'word_learning',
  statistic: 'unusual_fact',
  quote: 'culture',
  science: 'science_tech',
  technology: 'science_tech',
  economics: 'money_economics',
  fact: 'unusual_fact',
  country_fact: 'country_fact',
  good_news: 'good_news',
};

function insertBankRow(bankDate, category, contentText, tags = ['global']) {
  db.prepare(`
    INSERT INTO daily_content_bank (bank_date, category, content_text, tags)
    VALUES (?, ?, ?, ?)
  `).run(bankDate, category, contentText, JSON.stringify(tags));
}

async function main() {
  // --- A: BANK_CATEGORIES contains exactly the final 10 categories ---
  assert.deepStrictEqual(
    [...BANK_CATEGORIES].sort(),
    [...EXPECTED_CATEGORIES].sort(),
    'BANK_CATEGORIES must contain exactly the Phase 5 category set'
  );
  assert(!BANK_CATEGORIES.includes('advice'), 'advice must remain absent from BANK_CATEGORIES');
  assert(!BANK_CATEGORIES.includes('psychology'), 'psychology must remain absent from BANK_CATEGORIES');
  assert(!BANK_CATEGORIES.includes('wish'), 'wish must remain absent from BANK_CATEGORIES');

  // --- B: all 10 categories map directly (deterministically) to the expected type ---
  for (const [category, expectedType] of Object.entries(EXPECTED_MAPPING)) {
    const type = plannerTest.mapBankItemType({ category, content_text: 'placeholder content text.', tags: ['global'] });
    assert.strictEqual(type, expectedType, `category "${category}" must map directly to type "${expectedType}"`);
  }

  // --- old regex/keyword inference is gone: "fact" must ignore keywords that
  // used to trigger science/technology/economics/culture inference ---
  const keywordBaitCases = [
    'A fact about science and biology that is not actually a science category item.',
    'A fact mentioning AI, software, and computers.',
    'A fact about the economy, market, and inflation.',
    'A fact about music, film, and culture.',
  ];
  for (const content_text of keywordBaitCases) {
    const type = plannerTest.mapBankItemType({ category: 'fact', content_text, tags: ['science', 'technology', 'economy', 'culture'] });
    assert.strictEqual(type, 'unusual_fact', `"fact" category must always map to unusual_fact regardless of keywords: "${content_text}"`);
  }

  // --- country_fact: reuses existing country-tag filtering, no per-country
  // generation call -- the exact same isBankItemAllowedForCountry mechanism
  // that already gates every other category ---
  {
    const kzFact = { category: 'country_fact', content_text: 'Kazakhstan is the largest landlocked country in the world.', tags: ['KZ'] };
    assert(bankTest.isBankItemAllowedForCountry(kzFact, 'KZ'), 'a KZ-tagged country_fact must be allowed for a KZ device');
    assert(!bankTest.isBankItemAllowedForCountry(kzFact, 'FR'), 'a KZ-tagged country_fact must be rejected for a device in a different country');
  }

  // --- good_news can come from today's live Daily Bank only ---
  {
    const bankDate = getBankDateString();
    insertBankRow(bankDate, 'good_news', 'LIVE_GOOD_NEWS_UNIQUE_TEXT');
    const selected = selectBankItemsForDevice('device-good-news-live', bankDate, '2026-09-21', null, null, 20);
    const goodNewsItems = selected.filter((item) => item.category === 'good_news');
    assert.strictEqual(goodNewsItems.length, 1, 'exactly one good_news item must be selectable when live has one today');
    assert.strictEqual(goodNewsItems[0].content_text, 'LIVE_GOOD_NEWS_UNIQUE_TEXT', 'good_news must come from the live row');
  }

  // --- when live has NO good_news today, it must simply be omitted ---
  {
    const failedBankDate = 'no-bank-rows-for-good-news-test';
    const selected = selectBankItemsForDevice('device-good-news-missing', failedBankDate, '2026-09-21', null, null, 20);
    assert(
      !selected.some((item) => item.category === 'good_news'),
      'good_news must be omitted when today\'s live bank has none'
    );
  }

  // --- city_fact and useful_knowledge are no longer active content types ---
  {
    assert(!CONTENT_TYPES.includes('city_fact'), 'city_fact must be removed from CONTENT_TYPES');
    assert(!CONTENT_TYPES.includes('useful_knowledge'), 'useful_knowledge must be removed from CONTENT_TYPES');
    assert(!FACTUAL_TYPES.has('city_fact'), 'city_fact must be removed from FACTUAL_TYPES');
    assert(!FACTUAL_TYPES.has('useful_knowledge'), 'useful_knowledge must be removed from FACTUAL_TYPES');
    // No production code path can produce these types anymore either --
    // any bank item with an unrecognized/removed category degrades to the
    // safe default, never to a removed type.
    assert.strictEqual(plannerTest.mapBankItemType({ category: 'city_fact', content_text: 'x' }), 'unusual_fact');
    assert.strictEqual(plannerTest.mapBankItemType({ category: 'useful_knowledge', content_text: 'x' }), 'unusual_fact');
  }

  // --- repo has no unexpected runtime dependency on the removed types ---
  {
    const slotPlannerSource = fs.readFileSync(path.join(__dirname, '../src/slotPlanner.js'), 'utf8');
    const dailyBankSource = fs.readFileSync(path.join(__dirname, '../src/dailyContentBank.js'), 'utf8');
    const contentGeneratorSource = fs.readFileSync(path.join(__dirname, '../src/contentGenerator.js'), 'utf8');
    for (const removedType of ['city_fact', 'useful_knowledge']) {
      assert(!slotPlannerSource.includes(removedType), `slotPlanner.js must not reference removed type "${removedType}"`);
      assert(!dailyBankSource.includes(removedType), `dailyContentBank.js must not reference removed type "${removedType}"`);
      assert(!contentGeneratorSource.includes(removedType), `contentGenerator.js must not reference removed type "${removedType}"`);
    }
  }

  // --- live category content is selected as-is; missing categories are not fabricated ---
  {
    const bankDate = getBankDateString();
    insertBankRow(bankDate, 'science', 'LIVE_SCIENCE_ITEM_UNIQUE_TEXT');
    const selected = selectBankItemsForDevice('device-live-preference', bankDate, '2026-09-19', null, null, 20);
    const scienceItems = selected.filter((item) => item.category === 'science');
    assert.strictEqual(scienceItems.length, 1, 'exactly one science item must be selected');
    assert.strictEqual(
      scienceItems[0].content_text,
      'LIVE_SCIENCE_ITEM_UNIQUE_TEXT',
      'live science content must be selected without fallback substitution'
    );
    assert.deepStrictEqual(
      new Set(selected.map((item) => item.category)),
      new Set(['good_news', 'science']),
      'selection must contain only live categories present in the DB for that day'
    );
  }

  // --- a total live-bank failure (zero rows for today) supplies no bank facts ---
  {
    const failedBankDate = 'no-bank-rows-exist-for-this-date';
    const selected = selectBankItemsForDevice('device-total-failure', failedBankDate, '2026-09-19', null, null, 20);
    assert.deepStrictEqual(selected, [], 'a failed/empty live bank day must not yield static fallback facts');
  }

  // --- no extra Daily Bank OpenAI call ---
  {
    let responsesCallCount = 0;
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'openai') {
        return class MockOpenAI {
          constructor() {
            this.responses = {
              create: async () => {
                responsesCallCount += 1;
                const items = EXPECTED_CATEGORIES
                  .filter((c) => c !== 'holiday')
                  .map((category, i) => ({
                    category,
                    content_text: `Generated ${category} item ${i}.`,
                    tags: ['global'],
                  }));
                return { output_text: JSON.stringify(items) };
              },
            };
          }
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    process.env.OPENAI_API_KEY = 'test-key-daily-bank';
    try {
      const { savedCount, error } = await generateDailyBank();
      assert.strictEqual(responsesCallCount, 1, 'generateDailyBank must make exactly one shared OpenAI call');
      assert.strictEqual(error, null);
      assert.strictEqual(savedCount, EXPECTED_CATEGORIES.length - 1);
    } finally {
      Module._load = originalLoad;
      delete process.env.OPENAI_API_KEY;
    }
  }

  // --- one per-user OpenAI call remains unchanged; empty live bank yields generic slots only ---
  {
    db.prepare('INSERT OR IGNORE INTO devices (device_id, timezone, created_at) VALUES (?, ?, ?)')
      .run('bank-sources-e2e-device', 'Asia/Almaty', '2026-09-01 00:00:00');
    // Deliberately no daily_content_bank rows for today's real bankDate --
    // simulates a fully empty/failed live bank. The batch should still be
    // generated from non-bank planner slots, but factual bank-derived slots
    // must be absent.

    let openAiCallCount = 0;
    let capturedRequest = null;
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'openai') {
        return class MockOpenAI {
          constructor() {
            this.chat = {
              completions: {
                create: async (requestBody) => {
                  openAiCallCount += 1;
                  capturedRequest = requestBody;
                  const payload = JSON.parse(requestBody.messages[1].content);
                  return {
                    choices: [{
                      message: {
                        content: JSON.stringify({
                          phrases: payload.slots.map((slot, index) => ({
                            slot_id: slot.slot_id,
                            text: `Concrete bank-sources line ${index + 1}`,
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
      return originalLoad.call(this, request, parent, isMain);
    };
    process.env.OPENAI_API_KEY = 'test-key-bank-sources-e2e';

    try {
      const result = await generateBatch(
        { device_id: 'bank-sources-e2e-device', timezone: 'Asia/Almaty', created_at: '2026-09-01 00:00:00' },
        'day',
        { system_language: 'en' },
        null,
        {}
      );

      assert.strictEqual(openAiCallCount, 1, 'per-user batch generation must still make exactly one OpenAI call with an empty live bank');
      // Content-quality rebuild (requirement B): no more padding to exactly
      // BATCH_SIZE -- just bounded by it.
      assert(result.phrases.length > 0 && result.phrases.length <= BATCH_SIZE);

      const payload = JSON.parse(capturedRequest.messages[1].content);
      assert(payload.slots.length > 0 && payload.slots.length <= BATCH_SIZE, 'the per-user prompt must stay bounded at BATCH_SIZE slots with an empty live bank');
      assert.strictEqual(result.phrases.length, payload.slots.length, 'every planned slot got a phrase back from the mock, so none should be dropped');
      assert(!payload.slots.some((slot) => slot.source === 'daily_bank'), 'empty live bank must not produce bank-derived slots');
      assert(!payload.slots.some((slot) => slot.bank_category), 'empty live bank must not attach bank categories to slots');
    } finally {
      Module._load = originalLoad;
      delete process.env.OPENAI_API_KEY;
    }
  }

  // --- obsolete Daily Bank advice/gender branch is removed ---
  {
    const bankSourceText = fs.readFileSync(path.join(__dirname, '../src/dailyContentBank.js'), 'utf8');
    assert(!bankSourceText.includes('genderAdviceTag'), 'genderAdviceTag must be removed as obsolete Daily Bank code');
    assert(!bankSourceText.includes("category === 'advice'"), 'the advice-category selection branch must be removed as obsolete Daily Bank code');
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
