const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-trace-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
process.env.OPENAI_API_KEY = 'test-key-batch-trace';

const db = require('../src/db');
const { STYLE_IDS } = require('../src/constants');
const { generateBatch, _test: contentTest } = require('../src/contentGenerator');
const { getBankDateString } = require('../src/dailyContentBank');

function mockPhrase(slot, index, text) {
  return {
    slot_id: slot.slot_id,
    text,
    style_id: STYLE_IDS[index % STYLE_IDS.length],
  };
}

// Stylistic filters (question mark, blocked phrases, etc) were removed from
// textFilter.js as part of the content-quality rebuild (requirement A) --
// only schema/empty/too_long/language/duplicate checks remain. An overlong
// string is now the reliable, language-independent way to force a rejection.
const OVERLONG_TEXT = 'あ'.repeat(contentTest.LOCK_SCREEN_TEXT_MAX_LENGTH + 10);

async function testRejectRepairFallback() {
  const bankDate = getBankDateString();
  db.prepare(`
    INSERT INTO daily_content_bank (bank_date, category, content_text, tags)
    VALUES (?, ?, ?, ?)
  `).run(bankDate, 'holiday', 'World Dream Day encourages people to share meaningful goals.', JSON.stringify(['global']));
  db.prepare(`
    INSERT INTO daily_content_bank (bank_date, category, content_text, tags)
    VALUES (?, ?, ?, ?)
  `).run(bankDate, 'on_this_day', 'In 1956 the first transatlantic telephone cable opened.', JSON.stringify(['global']));
  db.prepare(`
    INSERT INTO daily_content_bank (bank_date, category, content_text, tags)
    VALUES (?, ?, ?, ?)
  `).run(bankDate, 'idiom', 'Silver lining means a hopeful part of a hard situation.', JSON.stringify(['global']));
  db.prepare(`
    INSERT INTO devices (device_id, name, gender, birth_date, timezone, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('trace-device', 'Aria', 'female', '1995-04-12', 'Asia/Tokyo', '2026-09-01 00:00:00');

  let callCount = 0;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'openai') {
      return class MockOpenAI {
        constructor() {
          this.chat = {
            completions: {
              create: async (requestBody) => {
                callCount += 1;
                const payload = JSON.parse(requestBody.messages[1].content);
                if (callCount === 1) {
                  return {
                    choices: [{
                      message: {
                        content: JSON.stringify({
                          phrases: payload.slots
                            .filter((slot) => slot.type !== 'daily_numerology')
                            .map((slot, index) => {
                              if (slot.type === 'greeting_name') {
                                return mockPhrase(slot, index, OVERLONG_TEXT);
                              }
                              if (slot.type === 'daily_horoscope') {
                                return mockPhrase(slot, index, OVERLONG_TEXT);
                              }
                              return mockPhrase(slot, index, `朝の確認 ${index + 1}`);
                            }),
                        }),
                      },
                    }],
                  };
                }
                return {
                  choices: [{
                    message: {
                      content: JSON.stringify({
                        phrases: payload.slots
                          .filter((slot) => slot.type !== 'daily_numerology')
                          .map((slot, index) => {
                            if (slot.type === 'greeting_name') {
                              return mockPhrase(slot, index, 'アリア、おはようございます');
                            }
                            if (slot.type === 'daily_horoscope') {
                              return mockPhrase(slot, index, OVERLONG_TEXT);
                            }
                            return mockPhrase(slot, index, `修理済み ${index + 1}`);
                          }),
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

  try {
    const result = await generateBatch(
      {
        device_id: 'trace-device',
        name: 'Aria',
        gender: 'female',
        birth_date: '1995-04-12',
        timezone: 'Asia/Tokyo',
        created_at: '2026-09-01 00:00:00',
      },
      'morning',
      { system_language: 'ja', region: 'JP', battery_level: 12 },
      { countryCode: 'JP', city: 'Tokyo', temperatureC: 8, description: 'light rain' },
      {},
      { localDate: bankDate }
    );

    assert.strictEqual(callCount, 2, 'rejected/missing slots should trigger one repair call');
    assert(result.trace, 'trace must be returned');
    assert.strictEqual(result.trace.repair.called, true);
    assert.deepStrictEqual(
      result.trace.meta.profile_present,
      { name: true, birth_date: true, gender: true },
      'trace metadata must only expose boolean profile field presence'
    );
    assert(result.trace.repair.sent_slot_ids.length >= 2, 'repair should include rejected and missing slots');
    assert(result.trace.first_pass.some((item) => item.status === 'rejected'), 'trace should include first-pass rejection');
    assert(result.trace.first_pass.some((item) => item.status === 'missing'), 'trace should include missing first-pass slot');
    // B5: the daily_horoscope/daily_numerology slots are still a question /
    // still missing after the one repair round (see the mock's second-call
    // handler, which never actually fixes them) -- they are now DROPPED
    // instead of filled from the zodiac/numerology fallback pools, so no
    // fallback_zodiac/fallback_numerology trace entries appear at all, and
    // the final batch is shorter than 12 (10: the 12 planned slots minus the
    // 2 still-rejected-after-repair ones).
    assert.strictEqual(result.trace.fallback.length, 0, 'still-rejected-after-repair slots must be dropped, not filled from a fallback pool');
    assert.strictEqual(result.trace.summary.language_mismatch_count, 0, 'nothing was fallback-filled, so there is no fallback language to mismatch');
    assert.strictEqual(result.phrases.length, 10, 'batch must come up short by exactly the 2 still-rejected-after-repair slots');
    assert.strictEqual(result.trace.whole_batch_fallback.flag, false, 'a per-slot repair/drop run is not a whole-batch fallback');

    console.log('[test-trace]', JSON.stringify(result.trace));
    return result.trace;
  } finally {
    Module._load = originalLoad;
    delete process.env.OPENAI_API_KEY;
  }
}

async function testWholeBatchFallback() {
  process.env.OPENAI_API_KEY = 'test-key-whole-batch-fallback';
  db.prepare(`
    INSERT INTO devices (device_id, name, gender, birth_date, timezone, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('trace-device-outage', 'Sam', 'male', '1990-01-15', 'Europe/Moscow', '2026-09-01 00:00:00');

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'openai') {
      return class MockOpenAI {
        constructor() {
          this.chat = {
            completions: {
              // Simulate a hard OpenAI outage -- this is the path that should
              // trigger buildLoggedFallbackResult('openai_error') and return
              // an empty batch (no more ready-made fallback phrases to fill
              // it with).
              create: async () => {
                throw new Error('simulated OpenAI outage');
              },
            },
          };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const result = await generateBatch(
      {
        device_id: 'trace-device-outage',
        name: 'Sam',
        gender: 'male',
        birth_date: '1990-01-15',
        timezone: 'Europe/Moscow',
        created_at: '2026-09-01 00:00:00',
      },
      'morning',
      { system_language: 'en', region: 'US', battery_level: 80 },
      { countryCode: 'US', city: 'New York', temperatureC: 15, description: 'clear' },
      {},
      { localDate: getBankDateString() }
    );

    assert.strictEqual(result.source, 'fallback', 'openai outage must fall back to an empty batch');
    assert.strictEqual(result.phrases.length, 0, 'openai outage must return an empty batch, not filled with fallback phrases');
    assert(result.trace, 'trace must be returned even on whole-batch fallback');
    assert.strictEqual(result.trace.whole_batch_fallback.flag, true, 'outage must be flagged as a whole-batch fallback');
    assert.strictEqual(result.trace.whole_batch_fallback.reason, 'openai_error');
    assert.deepStrictEqual(
      result.trace.meta.profile_present,
      { name: true, birth_date: true, gender: true },
      'whole-batch fallback trace must keep boolean profile field presence'
    );
    assert.strictEqual(result.trace.final.length, 0, 'whole-batch fallback trace records no final entries when the batch is empty');

    console.log('[test-trace-whole-batch-fallback]', JSON.stringify(result.trace));
    return result.trace;
  } finally {
    Module._load = originalLoad;
    delete process.env.OPENAI_API_KEY;
  }
}

async function main() {
  await testRejectRepairFallback();
  await testWholeBatchFallback();
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
