// Step 2 (fixed-order rebuild): holiday content should prefer the user's
// own country over an international ("global") one when both exist for the
// same date. Covers:
//   1. selectBankItemsForDevice: local holiday present + global present ->
//      local wins.
//   2. No local holiday for this country -> falls back to the global one.
//   3. Neither local nor global -> holiday_today slot is simply skipped,
//      same as today (via the real planSlots()/collectCandidates path).
//   4. buildBankPrompt's text actually asks for per-country holiday
//      coverage (the countries list) and an international day requirement.
//   5. collectHolidayCountryCodes: always includes the owner-specified CIS
//      list, adds distinct device countries (city_country_code first, else
//      timezone), and never exceeds the 20-country cap.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-holiday-country-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const {
  selectBankItemsForDevice,
  buildBankPrompt,
  collectHolidayCountryCodes,
  getPreparedBankDates,
  _test: bankTest,
} = require('../src/dailyContentBank');
const { planSlots } = require('../src/slotPlanner');

function insertBankRow(bankDate, category, contentText, tags = ['global']) {
  db.prepare(`
    INSERT INTO daily_content_bank (bank_date, category, content_text, tags)
    VALUES (?, ?, ?, ?)
  `).run(bankDate, category, contentText, JSON.stringify(tags));
}

function insertDevice(deviceId, { timezone = null, cityCountryCode = null } = {}) {
  db.prepare(`
    INSERT INTO devices (device_id, timezone, city_country_code, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(deviceId, timezone, cityCountryCode);
}

const BANK_DATE = '2026-10-05';

// --- 1: local + global both exist -> local wins ---------------------------
function testLocalHolidayWinsOverGlobal() {
  insertBankRow(BANK_DATE, 'holiday', 'LOCAL_KZ_HOLIDAY', ['KZ']);
  insertBankRow(BANK_DATE, 'holiday', 'GLOBAL_HOLIDAY', ['global']);
  for (let i = 0; i < 10; i++) {
    const selected = selectBankItemsForDevice(`local-wins-device-${i}`, BANK_DATE, BANK_DATE, null, 'KZ', 20);
    const holiday = selected.find((item) => item.category === 'holiday');
    assert(holiday, `run ${i}: a holiday item must be selected`);
    assert.strictEqual(holiday.content_text, 'LOCAL_KZ_HOLIDAY', `run ${i}: the KZ-tagged holiday must win over the global one`);
  }
}

// --- 2: only global exists for this country -> falls back to global ------
function testFallsBackToGlobalWhenNoLocalHoliday() {
  const date = '2026-10-06';
  insertBankRow(date, 'holiday', 'ONLY_GLOBAL_HOLIDAY', ['global']);
  const selected = selectBankItemsForDevice('fallback-global-device', date, date, null, 'FR', 20);
  const holiday = selected.find((item) => item.category === 'holiday');
  assert(holiday, 'a holiday item must still be selected');
  assert.strictEqual(holiday.content_text, 'ONLY_GLOBAL_HOLIDAY', 'must fall back to the global holiday when no FR-tagged one exists');
}

// --- 3: neither local nor global -> holiday_today slot is just skipped ---
function testHolidaySlotSkippedWhenNothingAvailable() {
  const date = '2026-10-07';
  // No holiday rows inserted for this date at all.
  const selected = selectBankItemsForDevice('nothing-device', date, date, null, 'DE', 20);
  assert(!selected.some((item) => item.category === 'holiday'), 'no holiday item must be selected when none exists at all');

  const planned = planSlots({
    device: { device_id: 'nothing-device' },
    window: 'morning',
    dateContext: { date, weekday: 'Wednesday', time: '08:00', tomorrow_date: '2026-10-08', tomorrow_weekday: 'Thursday' },
    bankItems: [],
  }, { seed: 'nothing-seed' });
  assert(!planned.slots.some((s) => s.type === 'holiday_today'), 'holiday_today slot must simply be absent, exactly as today, when there is no data at all');
}

// --- 4: buildBankPrompt asks for per-country holiday coverage + a global requirement ---
function testBankPromptAsksForCountriesAndGlobalDay() {
  const preparedDates = getPreparedBankDates(BANK_DATE);
  const countryCodes = ['KZ', 'RU', 'FR'];
  const prompt = buildBankPrompt(BANK_DATE, preparedDates, countryCodes);
  for (const code of countryCodes) {
    assert(prompt.includes(code), `prompt must mention country code "${code}"`);
  }
  assert(/international observance/i.test(prompt), 'prompt must require at least one international observance day');
  assert(/global/i.test(prompt), 'prompt must reference the "global" tag for international items');
  assert(/never invent|never invented/i.test(prompt), 'prompt must forbid inventing holidays');
  assert(/commercial|marketing/i.test(prompt), 'prompt must exclude commercial/marketing "days of X"');
}

// --- 5: collectHolidayCountryCodes -----------------------------------------
function testCollectHolidayCountryCodesAlwaysIncludesCisListAndDeviceCountries() {
  insertDevice('device-with-city-country', { cityCountryCode: 'fr' }); // lowercase on purpose -- must normalize
  insertDevice('device-with-timezone-only', { timezone: 'America/New_York' }); // -> US
  insertDevice('device-with-unresolvable-timezone', { timezone: 'Not/A_Real_Zone' }); // contributes nothing
  insertDevice('device-with-nothing', {}); // contributes nothing

  const codes = collectHolidayCountryCodes();
  for (const code of bankTest.ALWAYS_INCLUDED_HOLIDAY_COUNTRIES) {
    assert(codes.includes(code), `always-included country "${code}" must be present`);
  }
  assert(codes.includes('FR'), 'a device country resolved from city_country_code must be included (normalized to uppercase)');
  assert(codes.includes('US'), 'a device country resolved from timezone must be included when city_country_code is absent');
  assert(codes.length <= bankTest.MAX_HOLIDAY_COUNTRIES, `must never exceed MAX_HOLIDAY_COUNTRIES (${bankTest.MAX_HOLIDAY_COUNTRIES}), got ${codes.length}`);
  assert.strictEqual(new Set(codes).size, codes.length, 'country list must contain no duplicates');
}

function testCollectHolidayCountryCodesNeverExceedsCap() {
  // Register far more distinct countries than the cap allows.
  const manyTimezones = [
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome',
    'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Seoul', 'Asia/Bangkok', 'Asia/Jakarta',
    'America/Chicago', 'America/Sao_Paulo', 'America/Mexico_City', 'America/Toronto',
    'Africa/Cairo', 'Africa/Lagos', 'Africa/Johannesburg',
    'Australia/Sydney', 'Pacific/Auckland', 'Asia/Dubai',
  ];
  manyTimezones.forEach((timezone, index) => {
    insertDevice(`cap-test-device-${index}`, { timezone });
  });
  const codes = collectHolidayCountryCodes();
  assert(codes.length <= bankTest.MAX_HOLIDAY_COUNTRIES, `must cap at ${bankTest.MAX_HOLIDAY_COUNTRIES} even with many distinct device countries, got ${codes.length}`);
}

function testResolveDeviceCountryCodePrefersCityOverTimezone() {
  assert.strictEqual(
    bankTest.resolveDeviceCountryCode({ city_country_code: 'jp', timezone: 'Asia/Almaty' }),
    'JP',
    'city_country_code must win over timezone when both are present'
  );
  assert.strictEqual(
    bankTest.resolveDeviceCountryCode({ city_country_code: null, timezone: 'Asia/Almaty' }),
    'KZ',
    'must fall back to countryForTimezone when city_country_code is absent'
  );
  assert.strictEqual(
    bankTest.resolveDeviceCountryCode({ city_country_code: null, timezone: null }),
    null,
    'must return null (not "unknown") when neither resolves'
  );
}

function main() {
  // Must run FIRST, before any other test inserts holiday/on_this_day rows
  // -- resolveDateSensitiveBankDate falls back to the nearest date that has
  // ANY date-sensitive rows at all once some exist, which would otherwise
  // make this "nothing available" case pick up a different date's rows.
  testHolidaySlotSkippedWhenNothingAvailable();
  testLocalHolidayWinsOverGlobal();
  testFallsBackToGlobalWhenNoLocalHoliday();
  testBankPromptAsksForCountriesAndGlobalDay();
  testCollectHolidayCountryCodesAlwaysIncludesCisListAndDeviceCountries();
  testCollectHolidayCountryCodesNeverExceedsCap();
  testResolveDeviceCountryCodePrefersCityOverTimezone();
}

try {
  main();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('holiday-country-preference.test.js: all assertions passed');
} catch (err) {
  try {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best effort cleanup
  }
  console.error(err);
  process.exit(1);
}
