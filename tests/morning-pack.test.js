// Morning pack feature coverage. Follows the same house style as
// tests/batch-trace.test.js / tests/learning-memory.test.js: a fresh temp
// SQLite DB per file, `openai` mocked via Module._load patching (never a real
// network call), run with `node tests/morning-pack.test.js`.
const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-morning-pack-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
process.env.OPENAI_API_KEY = 'test-key-morning-pack';

const db = require('../src/db');
const { STYLE_IDS } = require('../src/constants');
const { generateMorningPack, generateBatch, _test: contentTest } = require('../src/contentGenerator');
const { computeTargetDate, getOrGenerateMorningPack } = require('../src/morningPack');
const { getBankDateString } = require('../src/dailyContentBank');
const { MORNING_PACK_ORDER } = require('../src/slotPlanner');

function insertBankItem(bankDate, category, contentText, tags = ['global']) {
  db.prepare(`
    INSERT INTO daily_content_bank (bank_date, category, content_text, tags)
    VALUES (?, ?, ?, ?)
  `).run(bankDate, category, contentText, JSON.stringify(tags));
}

function insertDevice(deviceId, overrides = {}) {
  const device = {
    device_id: deviceId,
    name: overrides.name || 'Mira',
    gender: overrides.gender || 'female',
    birth_date: overrides.birth_date || '1995-04-12',
    timezone: overrides.timezone || 'UTC',
    created_at: overrides.created_at || '2026-01-01 00:00:00',
  };
  db.prepare(`
    INSERT INTO devices (device_id, name, gender, birth_date, timezone, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(device.device_id, device.name, device.gender, device.birth_date, device.timezone, device.created_at);
  return device;
}

function mockPhrase(slot, index, text) {
  return {
    slot_id: slot.slot_id,
    text,
    style_id: STYLE_IDS[index % STYLE_IDS.length],
  };
}

// Installs a mock `openai` module for the duration of one scenario.
// `handler(payload, schemaName)` receives the parsed user-message JSON
// payload and the response_format schema name (`lock_screen_morning_pack`
// for a pack first-pass call, `lock_screen_repair` for any repair call,
// `lock_screen_batch` for the ordinary batch) and must return an array of
// {slot_id, text, style_id} phrases (or throw, to simulate an API failure).
function installOpenAiMock(handler) {
  const originalLoad = Module._load;
  const calls = [];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'openai') {
      return class MockOpenAI {
        constructor() {
          this.chat = {
            completions: {
              create: async (requestBody) => {
                const payload = JSON.parse(requestBody.messages[1].content);
                const schemaName = requestBody.response_format.json_schema.name;
                calls.push({ schemaName, payload });
                const phrases = handler(payload, schemaName, calls.length);
                return { choices: [{ message: { content: JSON.stringify({ phrases }) } }] };
              },
            },
          };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  return {
    calls,
    packCallCount: () => calls.filter((c) => c.schemaName === 'lock_screen_morning_pack').length,
    restore: () => {
      Module._load = originalLoad;
    },
  };
}

// A generic "always valid, always distinct" phrase generator good enough to
// pass every textFilter/rejectionReasonForText check for English text --
// used for slots the test doesn't care about the content of.
function genericValidPhrase(slot, index) {
  return `Pack update number ${index} about ${slot.type.replace(/_/g, ' ')}`;
}

async function testTargetDateComputation() {
  // any window other than night -> dateContext.date (today).
  assert.strictEqual(
    computeTargetDate('day', { date: '2026-03-05', time: '13:00', tomorrow_date: '2026-03-06' }),
    '2026-03-05'
  );
  assert.strictEqual(
    computeTargetDate('morning', { date: '2026-03-05', time: '07:00', tomorrow_date: '2026-03-06' }),
    '2026-03-05'
  );
  assert.strictEqual(
    computeTargetDate('evening', { date: '2026-03-05', time: '18:00', tomorrow_date: '2026-03-06' }),
    '2026-03-05'
  );

  // window=night at 19:30 on day D -> the next 05:00, which is D+1.
  assert.strictEqual(
    computeTargetDate('night', { date: '2026-03-05', time: '19:30', tomorrow_date: '2026-03-06' }),
    '2026-03-06',
    'an evening night request must target the next upcoming 05:00 (tomorrow)'
  );

  // window=night at 02:00 -- still logically "night", clock already past
  // midnight, local date has already rolled over to D+1 -- must target the
  // SAME upcoming 05:00 (today from this vantage point), not a further one.
  assert.strictEqual(
    computeTargetDate('night', { date: '2026-03-06', time: '02:00', tomorrow_date: '2026-03-07' }),
    '2026-03-06',
    'a post-midnight recovery night request must target the same upcoming 05:00, not a new later one'
  );

  // Exactly 05:00 boundary: the 05:00 that just started is no longer
  // "upcoming" -- target rolls to the next day's 05:00 (tomorrow_date).
  assert.strictEqual(
    computeTargetDate('night', { date: '2026-03-06', time: '05:00', tomorrow_date: '2026-03-07' }),
    '2026-03-07'
  );

  assert.strictEqual(computeTargetDate('night', null), null);
  console.log('[morning-pack-test] target date computation OK');
}

async function testPackOrderFactsAndDrop() {
  const bankDate = getBankDateString();
  const targetDate = '2026-03-05';
  const otherDate = '2026-03-04'; // "today", NOT the pack's target_date

  insertBankItem(targetDate, 'holiday', 'Target Day Festival celebrates renewal and light.');
  insertBankItem(targetDate, 'on_this_day', 'In 1990 a landmark bridge opened nearby.');
  insertBankItem(otherDate, 'holiday', 'Today-Only Festival must never leak into the pack.');
  insertBankItem(otherDate, 'on_this_day', 'Today-only history fact must never leak into the pack.');
  // Deliberately contains a question mark, so this idiom's own text is
  // unusable as either the OpenAI-generated text OR word_learning's grounded
  // fallback (see groundedFallbackTextForSlot, which reuses facts.word
  // verbatim) -- forces a genuine drop rather than a fallback rescue.
  insertBankItem(bankDate, 'idiom', 'Break the ice -- does it always work?');

  const device = insertDevice('pack-device-order');
  const signals = { system_language: 'en', region: 'US' };
  const weather = { countryCode: 'US', city: 'Metropolis' };
  const weatherForecast = { countryCode: 'US', city: 'Metropolis', temperatureC: 2, description: 'light snow' };

  const mock = installOpenAiMock((payload) => payload.slots.map((slot, index) => {
    // word_learning is deliberately always invalid (a bare question with no
    // real content) on BOTH the first pass and the repair pass, to exercise
    // "fails validation and still fails after repair -> drop it".
    if (slot.type === 'word_learning') {
      return mockPhrase(slot, index, 'Is this even a real phrase?');
    }
    return mockPhrase(slot, index, genericValidPhrase(slot, index));
  }));

  try {
    const { phrases, trace } = await generateMorningPack(device, targetDate, signals, weather, weatherForecast);

    assert.strictEqual(mock.calls.length >= 2, true, 'word_learning rejection should trigger a repair call');
    assert(mock.calls.some((c) => c.schemaName === 'lock_screen_repair'), 'a repair call must have been made');

    const types = phrases.map((p) => p.type);
    assert.deepStrictEqual(
      types,
      ['greeting_name', 'holiday_today', 'weather_lifehack', 'history_today', 'daily_horoscope', 'daily_numerology'],
      'kept slots must preserve the required 7-slot relative order with the dropped slot simply omitted'
    );
    assert(!types.includes('word_learning'), 'word_learning must be dropped after failing validation and repair');

    const holidayPhrase = phrases.find((p) => p.type === 'holiday_today');
    assert(holidayPhrase, 'holiday_today must be present');
    const historyPhrase = phrases.find((p) => p.type === 'history_today');
    assert(historyPhrase, 'history_today must be present');

    // Facts pulled for target_date, not "today" (otherDate) -- verify by
    // checking the facts the model was actually given, not just the mocked
    // output text (the mock echoes generic text regardless of facts).
    const plannedHoliday = trace.planned.find((p) => p.type === 'holiday_today');
    assert(plannedHoliday, 'holiday_today must be planned');
    const firstPassPayload = mock.calls.find((c) => c.schemaName === 'lock_screen_morning_pack').payload;
    const holidaySlotSent = firstPassPayload.slots.find((s) => s.type === 'holiday_today');
    assert.strictEqual(
      holidaySlotSent.facts.text,
      'Target Day Festival celebrates renewal and light.',
      'holiday fact sent to OpenAI must be target_date\'s holiday, not today\'s'
    );
    const historySlotSent = firstPassPayload.slots.find((s) => s.type === 'history_today');
    assert.strictEqual(
      historySlotSent.facts.text,
      'In 1990 a landmark bridge opened nearby.',
      'on_this_day fact sent to OpenAI must be target_date\'s fact, not today\'s'
    );

    assert.strictEqual(trace.kind, 'morning_pack');
    assert.strictEqual(trace.meta.target_date, targetDate);
    assert(trace.final.some((f) => f.status !== undefined || f.slot_id), 'trace.final must be populated');

    console.log('[pack-trace]', JSON.stringify(trace));
  } finally {
    mock.restore();
  }
}

async function testMissingHolidayAndWeatherDropped() {
  const bankDate = getBankDateString();
  const targetDate = '2026-04-10';
  // selectBankItemsForDevice falls back to the NEAREST available
  // holiday/on_this_day date when the exact target_date isn't present (see
  // resolveDateSensitiveBankDate) -- so to genuinely test "no entry for
  // target_date at all", every holiday/on_this_day row from earlier tests in
  // this same shared temp DB must be cleared first, not just omitted here.
  db.prepare(`DELETE FROM daily_content_bank WHERE category IN ('holiday', 'on_this_day')`).run();
  insertBankItem(bankDate, 'idiom', 'A penny saved is a penny earned, meaning save money.');

  const device = insertDevice('pack-device-missing-facts');
  const signals = { system_language: 'en', region: 'US' };
  const weather = { countryCode: 'US' };

  const mock = installOpenAiMock((payload) => payload.slots.map((slot, index) => mockPhrase(slot, index, genericValidPhrase(slot, index))));
  try {
    // weatherForecast is null (undefined) -- simulates "no forecast available".
    const { phrases } = await generateMorningPack(device, targetDate, signals, weather, null);
    const types = phrases.map((p) => p.type);
    assert(!types.includes('holiday_today'), 'holiday_today must be dropped when Daily Bank has no entry for target_date');
    assert(!types.includes('history_today'), 'history_today must be dropped when Daily Bank has no entry for target_date');
    assert(!types.includes('weather_lifehack'), 'weather_lifehack must be dropped when no forecast is available');
    assert(types.includes('greeting_name'), 'greeting_name should still be present');
    assert(types.includes('word_learning'), 'word_learning should still be present (idiom exists)');
    assert.deepStrictEqual(types, types.slice().sort((a, b) => MORNING_PACK_ORDER.indexOf(a) - MORNING_PACK_ORDER.indexOf(b)), 'remaining order must still follow MORNING_PACK_ORDER');
  } finally {
    mock.restore();
  }
}

async function testZodiacFallbackLanguageMismatchDropped() {
  const bankDate = getBankDateString();
  const targetDate = '2026-05-01';
  insertBankItem(bankDate, 'idiom', 'Piece of cake means something very easy to do.');

  const device = insertDevice('pack-device-ja', { birth_date: '1995-04-12' }); // Aries
  const signals = { system_language: 'ja', region: 'JP' };
  const weather = { countryCode: 'JP' };

  const mock = installOpenAiMock((payload) => payload.slots.map((slot, index) => {
    // daily_horoscope is always invalid (a question, no real content) on
    // both first pass and repair -- ZODIAC_FALLBACK_TEXT has no 'ja' entry,
    // so the grounded fallback would only be available in English, and must
    // be dropped rather than shown in the wrong language.
    if (slot.type === 'daily_horoscope') {
      return mockPhrase(slot, index, 'これは質問ですか?');
    }
    return mockPhrase(slot, index, `パック更新 ${index} ${slot.type}`);
  }));

  try {
    const { phrases } = await generateMorningPack(device, targetDate, signals, weather, null);
    const types = phrases.map((p) => p.type);
    assert(!types.includes('daily_horoscope'), 'daily_horoscope must be dropped, not shown with an English-only zodiac fallback for a ja pack');
    assert(types.includes('daily_numerology'), 'daily_numerology (unrelated slot) should be unaffected');
  } finally {
    mock.restore();
  }
}

async function testPackGeneratedExactlyOnceAndReused() {
  const bankDate = getBankDateString();
  const targetDate = '2026-06-01';
  insertBankItem(targetDate, 'holiday', 'Founders Day marks the town\'s anniversary.');
  insertBankItem(targetDate, 'on_this_day', 'In 2001 a local museum first opened its doors.');
  insertBankItem(bankDate, 'idiom', 'Once in a blue moon means very rarely.');

  const device = insertDevice('pack-device-once');
  const signals = { system_language: 'en', region: 'US' };
  const weather = { countryCode: 'US' };
  const dateContext = { date: targetDate, time: '19:00', tomorrow_date: '2026-06-02' }; // window=day path

  const mock = installOpenAiMock((payload) => payload.slots.map((slot, index) => mockPhrase(slot, index, genericValidPhrase(slot, index))));
  try {
    const first = await getOrGenerateMorningPack({
      device, window: 'day', dateContext, signals, weather, ip: '203.0.113.5', packDateHeld: null,
    });
    assert(first, 'first request must generate and return a pack');
    assert(first.pack_id, 'pack must have a pack_id');
    assert.strictEqual(first.local_date, targetDate);
    const packCallsAfterFirst = mock.packCallCount();
    assert(packCallsAfterFirst >= 1, 'OpenAI must be called to generate the pack the first time');

    const second = await getOrGenerateMorningPack({
      device, window: 'day', dateContext, signals, weather, ip: '203.0.113.5', packDateHeld: null,
    });
    assert(second, 'second (repeated) request must still return the pack');
    assert.strictEqual(second.pack_id, first.pack_id, 'repeated request for the same device/target_date must return the same pack_id');
    assert.strictEqual(mock.packCallCount(), packCallsAfterFirst, 'OpenAI must NOT be called again for the pack on a repeated request');

    // pack_date_held equal to target_date -> null (already cached client-side).
    const held = await getOrGenerateMorningPack({
      device, window: 'day', dateContext, signals, weather, ip: '203.0.113.5', packDateHeld: targetDate,
    });
    assert.strictEqual(held, null, 'pack_date_held matching target_date must return null (client already has it)');
    assert.strictEqual(mock.packCallCount(), packCallsAfterFirst, 'pack_date_held short-circuit must not call OpenAI either');
  } finally {
    mock.restore();
  }
}

async function testDayWindowNoPackDateHeldGeneratesToday() {
  const bankDate = getBankDateString();
  const targetDate = '2026-07-04';
  insertBankItem(targetDate, 'holiday', 'Summer Fair Day celebrates the harvest.');
  insertBankItem(targetDate, 'on_this_day', 'In 1975 a famous park was dedicated.');
  insertBankItem(bankDate, 'idiom', 'Under the weather means feeling slightly ill.');

  const device = insertDevice('pack-device-day-window');
  const signals = { system_language: 'en', region: 'US' };
  const weather = { countryCode: 'US' };
  const dateContext = { date: targetDate, time: '13:00', tomorrow_date: '2026-07-05' };

  const mock = installOpenAiMock((payload) => payload.slots.map((slot, index) => mockPhrase(slot, index, genericValidPhrase(slot, index))));
  try {
    const result = await getOrGenerateMorningPack({
      device, window: 'day', dateContext, signals, weather, ip: '203.0.113.9', packDateHeld: '',
    });
    assert(result, 'day window with empty pack_date_held must generate today\'s pack');
    assert.strictEqual(result.local_date, targetDate);
    assert(result.phrases.length > 0);
  } finally {
    mock.restore();
  }
}

async function testPackFailureNeverBreaksOrdinaryBatch() {
  const bankDate = getBankDateString();
  const targetDate = '2026-08-15';
  insertBankItem(targetDate, 'holiday', 'A fine holiday for testing failures.');
  insertBankItem(bankDate, 'idiom', 'Bite the bullet means to endure something difficult.');
  const device = insertDevice('pack-device-failure');
  const signals = { system_language: 'en', region: 'US' };
  const weather = { countryCode: 'US' };
  const dateContext = { date: targetDate, time: '13:00', tomorrow_date: '2026-08-16' };

  const mock = installOpenAiMock((payload, schemaName) => {
    if (schemaName === 'lock_screen_morning_pack' || schemaName === 'lock_screen_repair') {
      throw new Error('simulated pack generation outage');
    }
    return payload.slots.map((slot, index) => mockPhrase(slot, index, genericValidPhrase(slot, index)));
  });
  try {
    const result = await getOrGenerateMorningPack({
      device, window: 'day', dateContext, signals, weather, ip: '203.0.113.20', packDateHeld: null,
    });
    assert.strictEqual(result, null, 'a pack generation failure must degrade to null, never throw');

    // The ordinary batch path (a completely separate OpenAI call, different
    // schema name) must be totally unaffected by the pack failure above.
    const batchResult = await generateBatch(
      device,
      'day',
      signals,
      weather,
      {},
      { localDate: targetDate }
    );
    assert.strictEqual(batchResult.phrases.length, 12, 'ordinary batch must still return a full 12-phrase batch');
  } finally {
    mock.restore();
  }
}

async function testExcludeMorningPackTypesFromOrdinaryBatch() {
  const bankDate = getBankDateString();
  const targetDate = '2026-09-01';
  insertBankItem(targetDate, 'holiday', 'Exclusion Test Holiday.');
  insertBankItem(targetDate, 'on_this_day', 'Exclusion test history fact.');
  insertBankItem(bankDate, 'idiom', 'Spill the beans means to reveal a secret.');
  const device = insertDevice('pack-device-exclude', { timezone: 'UTC' });
  const signals = { system_language: 'en', region: 'US', battery_level: 80 };
  const weather = { countryCode: 'US', temperatureC: 10, description: 'clear' };

  const mock = installOpenAiMock((payload) => payload.slots.map((slot, index) => mockPhrase(slot, index, genericValidPhrase(slot, index))));
  try {
    const result = await generateBatch(device, 'morning', signals, weather, {}, {
      localDate: targetDate,
      excludeMorningPackTypes: true,
    });
    const morningTypesInBatch = mock.calls
      .filter((c) => c.schemaName !== 'lock_screen_morning_pack')
      .flatMap((c) => c.payload.slots.map((s) => s.type));
    const forbidden = ['greeting_name', 'weather_lifehack', 'holiday_today', 'history_today', 'word_learning', 'daily_horoscope', 'daily_numerology'];
    for (const type of forbidden) {
      assert(!morningTypesInBatch.includes(type), `ordinary batch must never plan a "${type}" slot when excludeMorningPackTypes is set`);
    }
    assert.strictEqual(result.phrases.length, 12, 'ordinary batch must still be a full 12-phrase batch, filled from other types');
  } finally {
    mock.restore();
  }
}

async function testOrdinaryBatchUnaffectedWithoutFlag() {
  const bankDate = getBankDateString();
  insertBankItem(bankDate, 'holiday', 'Regular Batch Holiday.');
  insertBankItem(bankDate, 'on_this_day', 'Regular Batch History Fact.');
  insertBankItem(bankDate, 'idiom', 'Cut corners means to do something poorly to save effort.');
  const device = insertDevice('pack-device-backcompat', { timezone: 'UTC' });
  const signals = { system_language: 'en', region: 'US' };
  const weather = { countryCode: 'US', temperatureC: 10, description: 'clear' };

  const mock = installOpenAiMock((payload) => payload.slots.map((slot, index) => mockPhrase(slot, index, genericValidPhrase(slot, index))));
  try {
    const result = await generateBatch(device, 'morning', signals, weather, {}, { localDate: bankDate });
    const morningTypesInBatch = mock.calls.flatMap((c) => c.payload.slots.map((s) => s.type));
    // Without excludeMorningPackTypes, the legacy fixed morning sequence must
    // still include greeting_name -- confirms the option is a strict no-op
    // when absent.
    assert(morningTypesInBatch.includes('greeting_name'), 'legacy morning batch must still include greeting_name when the pack feature is not requested');
    assert.strictEqual(result.phrases.length, 12);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'dateContext'), true, 'dateContext is an internal-only addition, not part of the HTTP response body');
  } finally {
    mock.restore();
  }
}

async function main() {
  await testTargetDateComputation();
  await testPackOrderFactsAndDrop();
  await testMissingHolidayAndWeatherDropped();
  await testZodiacFallbackLanguageMismatchDropped();
  await testPackGeneratedExactlyOnceAndReused();
  await testDayWindowNoPackDateHeldGeneratesToday();
  await testPackFailureNeverBreaksOrdinaryBatch();
  await testExcludeMorningPackTypesFromOrdinaryBatch();
  await testOrdinaryBatchUnaffectedWithoutFlag();
}

main()
  .then(() => {
    console.log('[morning-pack-test] all scenarios passed');
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
