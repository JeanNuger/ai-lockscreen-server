// Regression coverage for the two production defects found in the evening
// batch (see task history): (1) a phrase cut off mid-thought exactly at the
// old schema maxLength ("...выявить в"), (2) a hardcoded fallback string
// that read like a literal English-to-Russian calque ("Отдохни — ты его
// заслужил"). Zero real OpenAI calls.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-incomplete-sentence-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const {
  hasIncompleteSentenceEnding,
  INCOMPLETE_ENDING_WORDS,
  validateLockScreenText,
} = require('../src/textFilter');
const {
  LOCK_SCREEN_TEXT_MAX_LENGTH,
  OPENAI_SCHEMA_SOFT_MAX_LENGTH,
  buildBatchResponseFormat,
  buildSystemPrompt,
  isUnusableLockScreenText,
} = require('../src/contentGenerator')._test;

function main() {
  // --- 1. The exact production incident string must now be rejected ---
  {
    const crisprCutoff = 'Благодаря диагностике на основе CRISPR, болезни теперь можно выявить в';
    assert.strictEqual(crisprCutoff.length, 70, 'fixture sanity: this is the real 70-char production string');
    assert.strictEqual(hasIncompleteSentenceEnding(crisprCutoff), true, 'a phrase ending on a bare preposition must be flagged');
    assert.strictEqual(validateLockScreenText(crisprCutoff, { maxLength: LOCK_SCREEN_TEXT_MAX_LENGTH }).ok, false);
    assert.strictEqual(validateLockScreenText(crisprCutoff, { maxLength: LOCK_SCREEN_TEXT_MAX_LENGTH }).reason, 'incomplete_sentence');
    assert.strictEqual(isUnusableLockScreenText(crisprCutoff), true, 'the exact production string must be rejected end-to-end');
  }

  // --- 2. A natural, complete phrase without a trailing preposition must pass ---
  {
    const complete = 'Сегодня можно просто отдохнуть';
    assert.strictEqual(hasIncompleteSentenceEnding(complete), false);
    assert.strictEqual(validateLockScreenText(complete, { maxLength: LOCK_SCREEN_TEXT_MAX_LENGTH }).ok, true);
    assert.strictEqual(isUnusableLockScreenText(complete), false);
  }

  // --- 3. A normal phrase with no terminal punctuation must still pass --
  // (the check must never require a trailing period -- lock-screen phrases
  // routinely have none).
  {
    const noPunctuation = 'Один тихий час меняет весь день';
    assert(!/[.!?…]$/.test(noPunctuation), 'fixture sanity: no trailing punctuation');
    assert.strictEqual(hasIncompleteSentenceEnding(noPunctuation), false);
    assert.strictEqual(isUnusableLockScreenText(noPunctuation), false, 'missing terminal punctuation alone must never cause rejection');
  }

  // --- every listed trailing word actually triggers the guard, standalone
  // and with a short sentence in front of it ---
  {
    for (const word of INCOMPLETE_ENDING_WORDS) {
      assert.strictEqual(hasIncompleteSentenceEnding(word), true, `bare trailing word "${word}" must be flagged`);
      assert.strictEqual(hasIncompleteSentenceEnding(`Короткая мысль про ${word}`), true, `"...${word}" must be flagged in a full sentence`);
    }
  }

  // --- terminal punctuation after the flagged word must not hide it ---
  {
    assert.strictEqual(hasIncompleteSentenceEnding('Болезни теперь можно выявить в.'), true, 'trailing punctuation must not mask an incomplete ending');
    assert.strictEqual(hasIncompleteSentenceEnding('Болезни теперь можно выявить в…'), true);
  }

  // --- a word that merely STARTS with a flagged token must not false-positive ---
  // (word-list lookup on the exact last word only, not a substring/prefix match)
  {
    assert.strictEqual(hasIncompleteSentenceEnding('Сегодня хорошая погода'), false, '"погода" must not match "по" as a prefix');
    assert.strictEqual(hasIncompleteSentenceEnding('Настроение отличное'), false);
  }

  // --- empty/whitespace-only input must not throw or false-positive ---
  {
    assert.strictEqual(hasIncompleteSentenceEnding(''), false);
    assert.strictEqual(hasIncompleteSentenceEnding('   '), false);
    assert.strictEqual(hasIncompleteSentenceEnding(null), false);
    assert.strictEqual(hasIncompleteSentenceEnding(undefined), false);
  }

  // --- non-Russian text with no Cyrillic trailing word must be unaffected ---
  {
    assert.strictEqual(hasIncompleteSentenceEnding('Good morning, the day is still wide open'), false);
    assert.strictEqual(hasIncompleteSentenceEnding('Un mot gentil dure plus qu\'une journée'), false);
  }

  // --- soft schema length target vs. the real hard cap ---
  {
    assert.strictEqual(LOCK_SCREEN_TEXT_MAX_LENGTH, 70, 'the real hard cap enforced by server-side validation must stay 70');
    assert.strictEqual(OPENAI_SCHEMA_SOFT_MAX_LENGTH, 60, 'the schema-visible soft target must be smaller than the hard cap');
    assert(OPENAI_SCHEMA_SOFT_MAX_LENGTH < LOCK_SCREEN_TEXT_MAX_LENGTH, 'soft target must never exceed (let alone equal) the hard cap');

    const schema = buildBatchResponseFormat('lock_screen_batch', 12);
    assert.strictEqual(
      schema.json_schema.schema.properties.phrases.items.properties.text.maxLength,
      OPENAI_SCHEMA_SOFT_MAX_LENGTH,
      'the OpenAI-visible schema must use the soft target, not the hard cap'
    );

    // Server-side validation must still ACCEPT a genuinely completed phrase
    // between the soft target (60) and the real hard cap (70) -- the soft
    // schema hint must never become an accidental second hard cap.
    const completeLongPhrase = 'Международный день переводчика напоминает о силе точного слова';
    assert(
      completeLongPhrase.length > OPENAI_SCHEMA_SOFT_MAX_LENGTH && completeLongPhrase.length <= LOCK_SCREEN_TEXT_MAX_LENGTH,
      'fixture sanity: must land strictly between the soft target and the hard cap'
    );
    assert.strictEqual(isUnusableLockScreenText(completeLongPhrase), false, 'a complete phrase between 60 and 70 chars must still be accepted');
  }

  // --- prompt: Russian-only naturalness instruction ---
  {
    const ruPrompt = buildSystemPrompt('ru');
    assert(/естественным современным русским/i.test(ruPrompt), 'ru prompt must instruct natural modern Russian');
    assert(/калек/i.test(ruPrompt), 'ru prompt must forbid calques/literal translation');
    assert(/завершённой мыслью/i.test(ruPrompt), 'ru prompt must require each phrase to be a complete thought');

    const enPrompt = buildSystemPrompt('en');
    assert(!/калек/i.test(enPrompt), 'the Russian-only naturalness sentence must not leak into a non-ru prompt');
    assert(!/естественным современным русским/i.test(enPrompt));
  }

  // --- the fixed fallback string no longer contains the dangling "его" ---
  {
    const src = fs.readFileSync(require.resolve('../src/contentGenerator.js'), 'utf8');
    assert(!src.includes('Отдохни — ты его заслужил'), 'the old calque fallback string must be gone from the source');
    assert(src.includes('Ты заслуживаешь немного отдыха'), 'the corrected, gender-neutral fallback string must be present');
  }
}

main();
db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('incomplete-sentence.test.js: all assertions passed');
