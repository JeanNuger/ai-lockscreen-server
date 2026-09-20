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
  EVERGREEN_COMPATIBLE_CATEGORIES,
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
  holiday: 'holiday',
  on_this_day: 'history_today',
  humor: 'humor',
  idiom: 'word_learning',
  statistic: 'unusual_fact',
  quote: 'culture',
  science: 'science',
  technology: 'technology',
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

  // --- good_news must be excluded from evergreen compatibility, and
  // evergreen backfill must never fabricate a good_news item ---
  {
    assert(!EVERGREEN_COMPATIBLE_CATEGORIES.has('good_news'), 'good_news must not be evergreen-compatible (it is a claim about recency)');
    const backfill = bankTest.getEvergreenBackfillRows(new Set(), null);
    assert(!backfill.some((row) => row.category === 'good_news'), 'evergreen backfill must never fabricate a good_news item, even when every category is missing');
  }

  // --- good_news can come from today's live Daily Bank (fresh-only, never evergreen) ---
  {
    const bankDate = getBankDateString();
    insertBankRow(bankDate, 'good_news', 'LIVE_GOOD_NEWS_UNIQUE_TEXT');
    const selected = selectBankItemsForDevice('device-good-news-live', bankDate, '2026-09-21', null, null, 20);
    const goodNewsItems = selected.filter((item) => item.category === 'good_news');
    assert.strictEqual(goodNewsItems.length, 1, 'exactly one good_news item must be selectable when live has one today');
    assert.strictEqual(goodNewsItems[0].content_text, 'LIVE_GOOD_NEWS_UNIQUE_TEXT', 'good_news must come from the live row, not an evergreen substitute');
  }

  // --- when live has NO good_news today, it must simply be omitted, never
  // backfilled from evergreen ---
  {
    const failedBankDate = 'no-bank-rows-for-good-news-test';
    const selected = selectBankItemsForDevice('device-good-news-missing', failedBankDate, '2026-09-21', null, null, 20);
    assert(
      !selected.some((item) => item.category === 'good_news'),
      'good_news must be omitted (not evergreen-backfilled) when today\'s live bank has none'
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

  // --- D/F: live category content is preferred over evergreen; evergreen
  // only fills categories with zero live rows today ---
  {
    const bankDate = getBankDateString();
    insertBankRow(bankDate, 'science', 'LIVE_SCIENCE_ITEM_UNIQUE_TEXT');
    // count=20 exceeds the max possible distinct categories (10), so the
    // selection loop exhausts every available category exactly once --
    // deterministic regardless of the non-seeded category shuffle.
    const selected = selectBankItemsForDevice('device-live-preference', bankDate, '2026-09-19', null, null, 20);
    const scienceItems = selected.filter((item) => item.category === 'science');
    assert.strictEqual(scienceItems.length, 1, 'exactly one science item must be selected');
    assert.strictEqual(
      scienceItems[0].content_text,
      'LIVE_SCIENCE_ITEM_UNIQUE_TEXT',
      'live science content must be preferred over the evergreen science fallback'
    );
    // Every other evergreen-compatible category had zero live rows today, so
    // they must all have been evergreen-backfilled and selectable -- except
    // country_fact, which is architecturally evergreen-compatible but has no
    // seed catalog entries in this task by explicit product decision (no
    // invented country facts were added just to fill it), so it is expected
    // to be legitimately absent here, not a bug.
    const nonScienceCategories = new Set(selected.map((item) => item.category));
    for (const category of EVERGREEN_COMPATIBLE_CATEGORIES) {
      if (category === 'science' || category === 'country_fact') continue;
      assert(nonScienceCategories.has(category), `evergreen must backfill missing category "${category}" when live has none today`);
    }
    assert(!nonScienceCategories.has('country_fact'), 'country_fact must not appear when the seed catalog has no entries for it (no fabricated country facts)');
  }

  // --- evergreen backfill occurs ONLY for missing evergreen-compatible categories ---
  {
    const backfill = bankTest.getEvergreenBackfillRows(new Set(['humor', 'science']), null);
    assert(!backfill.some((row) => row.category === 'humor'), 'evergreen must not backfill a category that already has live rows (humor)');
    assert(!backfill.some((row) => row.category === 'science'), 'evergreen must not backfill a category that already has live rows (science)');
    assert(backfill.some((row) => row.category === 'idiom'), 'evergreen must backfill a genuinely missing category (idiom)');
    assert(backfill.some((row) => row.category === 'technology'), 'evergreen must backfill a genuinely missing category (technology)');
  }

  // --- evergreen must NEVER backfill holiday or on_this_day ---
  {
    const fullyMissing = bankTest.getEvergreenBackfillRows(new Set(), null);
    assert(!fullyMissing.some((row) => row.category === 'holiday'), 'evergreen must never backfill holiday');
    assert(!fullyMissing.some((row) => row.category === 'on_this_day'), 'evergreen must never backfill on_this_day');
    assert(
      fullyMissing.every((row) => EVERGREEN_COMPATIBLE_CATEGORIES.has(row.category)),
      'every evergreen backfill row must belong to an evergreen-compatible category'
    );
  }

  // --- a total live-bank failure (zero rows for today) still supplies
  // evergreen-compatible content, with holiday/on_this_day simply absent ---
  {
    const failedBankDate = 'no-bank-rows-exist-for-this-date';
    const selected = selectBankItemsForDevice('device-total-failure', failedBankDate, '2026-09-19', null, null, 20);
    assert(selected.length > 0, 'a total Daily Bank generation failure must still yield evergreen-compatible content');
    assert(
      selected.every((item) => item.category !== 'holiday' && item.category !== 'on_this_day'),
      'a failed bank day must never fabricate holiday/on_this_day content via evergreen'
    );
    const categoriesSeen = new Set(selected.map((item) => item.category));
    // country_fact is architecturally evergreen-compatible but intentionally
    // has zero seed catalog entries in this task (no invented country facts),
    // so it is correctly absent here even on a fully failed bank day.
    assert(
      categoriesSeen.size >= EVERGREEN_COMPATIBLE_CATEGORIES.size - 1,
      'a failed bank day should surface every evergreen-compatible category that actually has seed content'
    );
    assert(!categoriesSeen.has('country_fact'), 'country_fact must not appear on a failed bank day when the seed catalog has no entries for it');
    assert(!categoriesSeen.has('good_news'), 'good_news must never appear via evergreen, even on a fully failed bank day');
  }

  // --- evergreen IDs/content keys are deterministic across days/runs ---
  {
    // bankItemToCandidate's content_key is derived only from item.id (see
    // slotPlanner.js) -- an evergreen catalog entry's id is a fixed,
    // hand-authored string, never a freshly-generated per-day row id, so its
    // content_key is bankDate-independent by construction. Proven two ways,
    // neither dependent on selectBankItemsForDevice's non-seeded random
    // in-category pick (which would make a "same day" comparison flaky):
    // (1) the same fixed catalog entry yields the same content_key on
    // repeated direct calls, and (2) getEvergreenBackfillRows -- a pure,
    // non-random filter -- surfaces the exact same object/id when invoked
    // twice, simulating two independent "runs".
    const fixedEvergreenItem = bankTest.EVERGREEN_CONTENT_BANK.find((item) => item.id === 'evergreen-humor-1');
    assert(fixedEvergreenItem, 'fixture assumption: evergreen-humor-1 must exist in the seed catalog');
    const candidateA = plannerTest.bankItemToCandidate(fixedEvergreenItem);
    const candidateB = plannerTest.bankItemToCandidate(fixedEvergreenItem);
    assert.strictEqual(candidateA.content_key, candidateB.content_key, 'the same evergreen catalog entry must always produce the same content_key');
    assert.strictEqual(candidateA.content_key, 'bank_evergreen-humor-1', 'evergreen content_key must be derived from its fixed catalog id, not a fresh row id');

    const runOne = bankTest.getEvergreenBackfillRows(new Set(), null).find((item) => item.id === 'evergreen-humor-1');
    const runTwo = bankTest.getEvergreenBackfillRows(new Set(), null).find((item) => item.id === 'evergreen-humor-1');
    assert(runOne && runTwo, 'evergreen-humor-1 must be present across independent backfill runs');
    assert.strictEqual(
      plannerTest.bankItemToCandidate(runOne).content_key,
      plannerTest.bankItemToCandidate(runTwo).content_key,
      'the same evergreen item must produce the same content_key across independent backfill runs'
    );
  }

  // --- evergreen content still passes through Content Memory anti-repeat ---
  {
    const evergreenItem = bankTest.EVERGREEN_CONTENT_BANK.find((item) => item.category === 'quote');
    const candidate = plannerTest.bankItemToCandidate(evergreenItem);
    const penalty = plannerTest.antiRepeatPenalty(candidate, {
      contentKeys: new Set([candidate.content_key]),
      topicKeys: new Set(),
    });
    assert.strictEqual(penalty, 45, 'a previously-shown evergreen content_key must receive the same anti-repeat penalty as any other bank item');
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

  // --- one per-user OpenAI call remains unchanged; per-user prompt stays
  // bounded and never receives the full evergreen catalog ---
  {
    db.prepare('INSERT OR IGNORE INTO devices (device_id, timezone, created_at) VALUES (?, ?, ?)')
      .run('bank-sources-e2e-device', 'Asia/Almaty', '2026-09-01 00:00:00');
    // Deliberately no daily_content_bank rows for today's real bankDate --
    // simulates a fully empty/failed live bank so evergreen backfill is
    // exercised through the real generateBatch path.

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

      assert.strictEqual(openAiCallCount, 1, 'per-user batch generation must still make exactly one OpenAI call with evergreen active');
      assert.strictEqual(result.phrases.length, BATCH_SIZE);

      const payload = JSON.parse(capturedRequest.messages[1].content);
      assert.strictEqual(payload.slots.length, BATCH_SIZE, 'the per-user prompt must stay bounded at BATCH_SIZE slots regardless of evergreen catalog size');

      const payloadText = JSON.stringify(payload);
      const catalogTextsPresent = bankTest.EVERGREEN_CONTENT_BANK.filter((item) => payloadText.includes(item.content_text)).length;
      assert(
        catalogTextsPresent < bankTest.EVERGREEN_CONTENT_BANK.length,
        'the per-user prompt must never contain the full evergreen catalog, only the selected shortlist'
      );
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
