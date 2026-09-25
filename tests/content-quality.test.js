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

// expectedLength defaults to BATCH_SIZE (the normal case: every direct
// assembleBatchFromGeneratedPhrases call in this file uses the old
// fallback-fill path, always exactly 12) -- but a real generateBatch() run
// through the repair flow can now legitimately come back shorter than 12: a
// slot still rejected after the one repair round is dropped, not
// generic-filled (see contentGenerator.js's dropMissing/B5). Callers that
// exercise that exact scenario pass the real expected count explicitly.
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
  assert.strictEqual(
    contentTest.assembleBatchFromGeneratedPhrases(
      [...validGeneratedPhrases().slice(0, 11), phrase('Уют и чай наполняют день теплом.')],
      'ru'
    ).rejectionReasons.blocked_phrase,
    1,
    'local textFilter must reject postcard filler without spending tokens'
  );
  for (const badPostcard of [
    'Пусть ночи будут спокойными.',
    'Чайник улыбается вечернему свету.',
    'Вечер как фея над городом.',
    'Малиновый солнце обещает чудеса.',
    'Свет в окне манит счастьем.',
    'Темнота помогает сосредоточиться на мыслях.',
    'Луна играет с облаками.',
    'Кто-то где-то слушает шорох листвы.',
    'Каждая ночь - это новый шанс.',
    'Ночь дарит нам тишину и покой.',
    'Медленно танцующие огоньки гирлянды создают атмосферу.',
    'Свечи и ночное небо - гармония в словах.',
    'Спокойной ночи! Завтра будет новый день.',
  ]) {
    assert.strictEqual(
      contentTest.assembleBatchFromGeneratedPhrases(
        [...validGeneratedPhrases().slice(0, 11), phrase(badPostcard)],
        'ru'
      ).rejectionReasons.blocked_phrase,
      1,
      `postcard garbage must be blocked: ${badPostcard}`
    );
  }

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

  // --- Regression tests for a real production batch (2026-09-19) where the
  // model wrote "Завтра пятница" on an actual Saturday (real tomorrow:
  // Sunday), echoed exact battery/unlock snapshots, invented "в пробке" with
  // no traffic signal, and used directive/coaching phrasing despite the
  // prompt already forbidding it. See task history for the full production
  // AI_BATCH_RESULT and example phrases this exercises.

  const saturdayDateContext = {
    date: '2026-09-19',
    weekday: 'Saturday',
    time: '15:30',
    tomorrow_date: '2026-09-20',
    tomorrow_weekday: 'Sunday',
  };

  // DATE / WEEKDAY
  const wrongTomorrowWeekday = contentTest.assembleBatchFromGeneratedPhrases(
    [...validTwelve.slice(0, 11), phrase('Завтра пятница, выходные уже рядом.')],
    'ru',
    { dateContext: saturdayDateContext }
  );
  assertFinalBatch(wrongTomorrowWeekday.phrases);
  assert.strictEqual(wrongTomorrowWeekday.rejectedCount, 1);
  assert.strictEqual(wrongTomorrowWeekday.rejectionReasons.date_claim, 1, 'wrong tomorrow weekday must be rejected as date_claim');

  const correctTomorrowWeekday = contentTest.assembleBatchFromGeneratedPhrases(
    [...validTwelve.slice(0, 11), phrase('Завтра воскресенье, можно не спешить с утра.')],
    'ru',
    { dateContext: saturdayDateContext }
  );
  assertFinalBatch(correctTomorrowWeekday.phrases);
  assert.strictEqual(correctTomorrowWeekday.rejectedCount, 0, 'correct tomorrow weekday claim must be allowed');
  // Explicitly confirm NO guard fired for this phrase, not just that the
  // date guard let it through -- "не спешить" isn't a match for any
  // COACHING_PATTERNS.ru entry (не забудь/тебе стоит/пора X/попробуй(-ть)/
  // сделай/дай себе/запланируй/экспериментируй), but this asserts it rather
  // than assuming it, so this stays a pure date-correctness check and isn't
  // accidentally piggybacking on coaching semantics.
  assert.deepStrictEqual(correctTomorrowWeekday.rejectionReasons, {}, 'correct weekday claim must not trigger the coaching guard or any other guard');
  assert(correctTomorrowWeekday.phrases.some((p) => p.text.includes('воскресенье')), 'correct weekday claim must survive into the final batch');

  const noDateContextWeekdayClaim = contentTest.assembleBatchFromGeneratedPhrases(
    [...validTwelve.slice(0, 11), phrase('Завтра пятница, выходные уже рядом.')],
    'ru',
    { dateContext: null }
  );
  assertFinalBatch(noDateContextWeekdayClaim.phrases);
  assert.strictEqual(noDateContextWeekdayClaim.rejectionReasons.date_claim, 1, 'relative weekday claim without authoritative date context must be rejected');

  // DATE / WEEKDAY -- all 10 SUPPORTED_LANGUAGES, not just ru. Each phrase is
  // deliberately short/neutral (no imperative verbs) so a false reject here
  // can only be the date guard, not coaching/traffic/telemetry leaking in
  // through DEFAULT_LANGUAGE_CODE's EN fallback patterns.
  const weekdayGuardLanguageCases = {
    ru: { wrong: 'Завтра пятница.', correct: 'Завтра воскресенье.' },
    en: { wrong: 'Tomorrow is Friday.', correct: 'Tomorrow is Sunday.' },
    fr: { wrong: "Demain c'est vendredi.", correct: "Demain c'est dimanche." },
    es: { wrong: 'Mañana es viernes.', correct: 'Mañana es domingo.' },
    pt: { wrong: 'Amanhã é sexta-feira.', correct: 'Amanhã é domingo.' },
    de: { wrong: 'Morgen ist Freitag.', correct: 'Morgen ist Sonntag.' },
    zh: { wrong: '明天是星期五。', correct: '明天是星期日。' },
    ja: { wrong: '明日は金曜日。', correct: '明日は日曜日。' },
    ko: { wrong: '내일은 금요일이다.', correct: '내일은 일요일이다.' },
    it: { wrong: 'Domani è venerdì.', correct: 'Domani è domenica.' },
  };
  assert.deepStrictEqual(
    Object.keys(weekdayGuardLanguageCases).sort(),
    Object.keys(contentTest.SUPPORTED_LANGUAGES).sort(),
    'weekday guard language test coverage must match SUPPORTED_LANGUAGES exactly'
  );
  for (const [langCode, cases] of Object.entries(weekdayGuardLanguageCases)) {
    const filler = validGeneratedPhrasesForLanguage(langCode, 11);

    const wrongResult = contentTest.assembleBatchFromGeneratedPhrases(
      [...filler, phrase(cases.wrong)],
      langCode,
      { dateContext: saturdayDateContext }
    );
    assertFinalBatch(wrongResult.phrases);
    assert.strictEqual(wrongResult.rejectionReasons.date_claim, 1, `[${langCode}] wrong tomorrow weekday must be rejected as date_claim`);

    const correctResult = contentTest.assembleBatchFromGeneratedPhrases(
      [...filler, phrase(cases.correct)],
      langCode,
      { dateContext: saturdayDateContext }
    );
    assertFinalBatch(correctResult.phrases);
    assert.deepStrictEqual(correctResult.rejectionReasons, {}, `[${langCode}] correct tomorrow weekday claim must not be rejected by any guard`);
    assert(correctResult.phrases.some((p) => p.text === cases.correct), `[${langCode}] correct weekday claim must survive into the final batch`);
  }

  // WINDOW / TIME OF DAY
  const eveningWindow = contentTest.windowContextFor('evening');
  assert.strictEqual(eveningWindow.id, 'evening');
  assert.strictEqual(eveningWindow.range, '15:00-20:00', 'evening window must expose its actual clock range, not just the id');
  const systemPromptText = contentTest.buildSystemPrompt('ru');
  assert(/slot_id/.test(systemPromptText), 'prompt must keep OpenAI in slot-writing mode');
  assert(!/profile\.tone/.test(systemPromptText), 'prompt must not depend on the old tone setting');

  // Content-improvement follow-up: all four windows must have distinct,
  // non-empty `focus` text (drives non-fixed-type tone/topic differentiation
  // -- see WINDOW_CONTEXT/buildSystemPrompt's now.window.focus instruction),
  // and buildSystemPrompt stays a pure function of languageCode only (no
  // window param) so the OpenAI-side prompt cache rationale documented on
  // buildSystemPrompt is preserved -- window-specific behavior travels only
  // through the per-request context payload (now.window.focus), never
  // through the static system prompt text itself.
  for (const w of ['morning', 'day', 'evening', 'night']) {
    const focus = contentTest.windowContextFor(w).focus;
    assert(typeof focus === 'string' && focus.length > 0, `window ${w} must have a non-empty focus`);
  }
  assert.strictEqual(
    new Set(['morning', 'day', 'evening', 'night'].map((w) => contentTest.windowContextFor(w).focus)).size,
    4,
    'all four windows must have genuinely distinct focus text'
  );
  assert(/now\.window\.focus/.test(systemPromptText), 'system prompt must instruct the model to read now.window.focus');
  assert.strictEqual(
    contentTest.buildSystemPrompt('ru'),
    contentTest.buildSystemPrompt('ru'),
    'buildSystemPrompt must remain a pure function of languageCode alone (no window/other input), preserving the OpenAI prompt-cache rationale'
  );

  // Req 4: personalization must never be spelled out to the user -- the
  // system prompt itself must explicitly forbid the exact creepy patterns
  // named in the product requirement.
  assert(/ты выбрал/i.test(systemPromptText), 'prompt must forbid literally naming a chosen interest ("ты выбрал ...")');
  assert(/раз тебе нравится/i.test(systemPromptText), 'prompt must forbid "раз тебе нравится X" phrasing');
  assert(/поскольку тебе/i.test(systemPromptText), 'prompt must forbid literally stating the user\'s age ("поскольку тебе N лет")');
  assert(/разблокировал телефон/i.test(systemPromptText), 'prompt must forbid literally citing the unlock count back at the user');
  assert(/many_unlocks/.test(systemPromptText) && /не упрёк/.test(systemPromptText), 'prompt must explicitly forbid a scolding tone for many_unlocks');
  assert(/age_bracket/.test(systemPromptText), 'prompt must document the age_bracket (not exact age) mechanism for age_context');
  assert(/temp_band|condition_lean/.test(systemPromptText), 'prompt must reference the weather temp_band/condition_lean facts for varied advice');

  // BATTERY
  const batteryEcho = contentTest.assembleBatchFromGeneratedPhrases(
    [...validTwelve.slice(0, 11), phrase('75% заряда осталось в батарее.')],
    'ru',
    { signals: { battery_level: 75 } }
  );
  assertFinalBatch(batteryEcho.phrases);
  assert.strictEqual(batteryEcho.rejectionReasons.telemetry_echo, 1, 'exact battery percentage echo must be rejected');

  const irrelevantNumberNotBattery = contentTest.assembleBatchFromGeneratedPhrases(
    [...validTwelve.slice(0, 11), phrase('До города 75 километров трассы.')],
    'ru',
    { signals: { battery_level: 75 } }
  );
  assertFinalBatch(irrelevantNumberNotBattery.phrases);
  assert.strictEqual(irrelevantNumberNotBattery.rejectedCount, 0, 'an unrelated number must not trip the telemetry guard just because it matches battery_level');

  // UNLOCKS
  const unlockEcho = contentTest.assembleBatchFromGeneratedPhrases(
    [...validTwelve.slice(0, 11), phrase('Сегодня получилось 65 разблокировок подряд.')],
    'ru',
    { signals: { unlocks_since_last_batch: 65 } }
  );
  assertFinalBatch(unlockEcho.phrases);
  assert.strictEqual(unlockEcho.rejectionReasons.telemetry_echo, 1, 'exact unlock count echo must be rejected');

  // TRAFFIC / UNSUPPORTED SITUATIONAL CONTEXT
  const trafficClaim = contentTest.assembleBatchFromGeneratedPhrases(
    [...validTwelve.slice(0, 11), phrase('В пробке подкаст звучит полезнее радио.')],
    'ru',
    {}
  );
  assertFinalBatch(trafficClaim.phrases);
  assert.strictEqual(trafficClaim.rejectionReasons.unsupported_context, 1, 'unsupported traffic claim must be rejected without a traffic signal');

  const trafficAllowedWithContext = contentTest.assembleBatchFromGeneratedPhrases(
    [...validTwelve.slice(0, 11), phrase('В пробке подкаст звучит полезнее радио.')],
    'ru',
    { contextFlags: { traffic: true } }
  );
  assertFinalBatch(trafficAllowedWithContext.phrases);
  assert.strictEqual(trafficAllowedWithContext.rejectedCount, 0, 'traffic claim must be allowed once a real traffic signal exists');

  // COACHING / DIRECTIVE PHRASING
  const coachingProductionFailures = [
    'Не забудь дать себе немного времени на паузу.',
    'Пора завершать дела.',
    'Попробуй что-то новое.',
    'Экспериментируй на кухне.',
  ];
  for (const bad of coachingProductionFailures) {
    const result = contentTest.assembleBatchFromGeneratedPhrases(
      [...validTwelve.slice(0, 11), phrase(bad)],
      'ru',
      {}
    );
    assertFinalBatch(result.phrases);
    assert.strictEqual(result.rejectionReasons.coaching, 1, `coaching phrase must be rejected: ${bad}`);
  }

  const neutralObservationsMustSurvive = [
    'В Алматы сегодня около 12°C.',
    'После дождя городские огни выглядят резче.',
  ];
  for (const good of neutralObservationsMustSurvive) {
    const result = contentTest.assembleBatchFromGeneratedPhrases(
      [...validTwelve.slice(0, 11), phrase(good)],
      'ru',
      {}
    );
    assertFinalBatch(result.phrases);
    assert.strictEqual(result.rejectedCount, 0, `neutral observation must not be rejected: ${good}`);
  }

  // ASSEMBLY: several different rejection reasons in one batch must each be
  // caught independently, with exactly the clean phrases preserved and the
  // rest fallback-filled to exactly BATCH_SIZE (partial validation, not
  // all-or-nothing).
  const mixedBatch = [
    ...validTwelve.slice(0, 8),
    phrase('Завтра пятница, выходные уже рядом.'),
    phrase('75% заряда осталось в батарее.'),
    phrase('В пробке подкаст звучит полезнее радио.'),
    phrase('Попробуй что-то новое.'),
  ];
  const mixedResult = contentTest.assembleBatchFromGeneratedPhrases(
    mixedBatch,
    'ru',
    { dateContext: saturdayDateContext, signals: { battery_level: 75 } }
  );
  assertFinalBatch(mixedResult.phrases);
  assert.strictEqual(mixedResult.generatedCount, 8, 'only the 8 clean generated phrases should survive');
  assert.strictEqual(mixedResult.rejectedCount, 4);
  assert.strictEqual(mixedResult.fallbackFillCount, 4);
  assert.strictEqual(mixedResult.reason, 'partial_validation_fill');
  assert.deepStrictEqual(
    mixedResult.rejectionReasons,
    { date_claim: 1, telemetry_echo: 1, unsupported_context: 1, coaching: 1 },
    'each production failure category must be attributed to its own reason, independently'
  );
  for (let i = 1; i <= 8; i++) {
    assert(mixedResult.phrases.some((p) => p.text === `Конкретная строка ${i}`), `valid generated phrase ${i} must be preserved`);
  }

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
  assertFinalBatch(noTimezoneLogs.result.phrases);
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
  // count=5 with Phase 5 evergreen backfill active means the exact item set
  // is no longer just the two rows inserted above (missing evergreen-
  // compatible categories get backfilled with a non-seeded random pick, see
  // dailyContentBank.js) -- the one thing this test can deterministically
  // guarantee is that the Russia-tagged on_this_day item never leaks into a
  // KZ selection, regardless of which evergreen categories happen to fill
  // the rest of the count.
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
  assert.strictEqual(generated.phrases.length, BATCH_SIZE, 'fallback generateBatch must still return 12');
  const context = JSON.parse(generated.context);
  assert.strictEqual(context.now.language, 'Russian', 'Russian language should remain output language');
  assert.strictEqual(context.now.country, 'KZ', 'IP country must win over Android locale region');
  assert.strictEqual(context.now.country_source, 'ip_approximate');
  assert.strictEqual(context.now.device_region, 'RU', 'Android RU region should only be retained as device_region');
  assert.strictEqual(context.now.window.id, 'day', 'now.window must still expose its id alongside the new focus field');
  assert(typeof context.now.window.focus === 'string' && context.now.window.focus.length > 0, 'now.window.focus must reach the actual OpenAI payload, not just windowContextFor in isolation');
  assert(Array.isArray(context.slots), 'slot-based context must include selected slots');
  assert.strictEqual(context.slots.length, BATCH_SIZE, 'slot-based context must include exactly 12 selected slots');
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
  assertFinalBatch(noKeyLogs.result.phrases);
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
                return {
                  choices: [{
                    message: {
                      content: JSON.stringify({
                        phrases: payload.slots.map((slot, index) => ({
                          slot_id: slot.slot_id,
                          text: index === payload.slots.length - 1
                            ? 'Это вопрос?'
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

    assert.strictEqual(memoryOpenAiCallCount, 2, 'one rejected slot should trigger exactly one targeted repair OpenAI call');
    assert.strictEqual(memoryResult.source, 'openai');
    // The mock's repair handler always answers the (single) rejected slot
    // with the same still-a-question text, so it stays rejected after the
    // one repair round -- under B5 that slot is now dropped rather than
    // generic-filled, so the final batch is BATCH_SIZE - 1, not BATCH_SIZE.
    assertFinalBatch(memoryResult.phrases, BATCH_SIZE - 1);
    const memoryRows = db.prepare(`
      SELECT content_key FROM device_content_memory
      WHERE device_id = ? AND content_key != ?
    `).all('memory-generation-device', 'raw-history-secret-key');
    assert.strictEqual(
      memoryRows.length,
      BATCH_SIZE - 1,
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
                            ? 'Уют и чай наполняют день теплом.'
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
    assert.strictEqual(repairOpenAiCallCount, 2, 'one blocked phrase must trigger one targeted repair call');
    assert.deepStrictEqual(repairRequestSlotCounts, [BATCH_SIZE, 1], 'repair call must send only the rejected slot');
    assert.deepStrictEqual(repairRequestSlotIds[1], [repairRequestSlotIds[0][2]], 'repair call must preserve the rejected slot_id only');
    assertFinalBatch(repairedLogs.result.phrases);
    assert(!repairedLogs.result.phrases.some((item) => /уют|чай|теплом/i.test(item.text)), 'blocked filler must not survive after repair');
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
