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

  // --- follow-up incident: the schema's own `maxLength` (first 70, then a
  // "softer" 60) turned out to be the actual root cause, not a mitigation --
  // production showed the model treating WHATEVER number appeared in the
  // schema as an implicit target and cutting off mid-WORD near it (e.g.
  // "...хранилища стале", "...и жела", "...окружающ", all landing at
  // 56-60 chars, right at the old soft target). The fix removes the
  // property entirely: the schema must carry NO length constraint at all,
  // in either direction; LOCK_SCREEN_TEXT_MAX_LENGTH (70) remains the one
  // real hard cap, enforced only after generation, server-side. ---
  {
    assert.strictEqual(LOCK_SCREEN_TEXT_MAX_LENGTH, 70, 'the real hard cap enforced by server-side validation must stay 70');

    const schema = buildBatchResponseFormat('lock_screen_batch', 12);
    const textSchema = schema.json_schema.schema.properties.phrases.items.properties.text;
    assert.deepStrictEqual(textSchema, { type: 'string' }, 'the OpenAI-visible schema must carry no maxLength (or any other length constraint) on text at all');
    assert(!Object.prototype.hasOwnProperty.call(textSchema, 'maxLength'), 'text schema must not define maxLength in any form');
    assert(!JSON.stringify(schema).includes('"maxLength"'), 'no maxLength keyword anywhere in the response schema');

    // Server-side validation must still ACCEPT a genuinely completed phrase
    // anywhere up to the real hard cap, including well past the old 60-char
    // soft target that turned out to be harmful.
    const completeLongPhrase = 'Международный день переводчика напоминает о силе точного слова';
    assert(
      completeLongPhrase.length > 60 && completeLongPhrase.length <= LOCK_SCREEN_TEXT_MAX_LENGTH,
      'fixture sanity: must land strictly between the old soft target and the hard cap'
    );
    assert.strictEqual(isUnusableLockScreenText(completeLongPhrase), false, 'a complete phrase between 60 and 70 chars must still be accepted');
  }

  // --- the 9 real production phrases from the morning incident ---
  // Ground truth for each, established by the audit (see task history):
  //   - truncated mid-WORD (жела/окружающ/уверенн/десят/особ/стале): NOT
  //     caught by hasIncompleteSentenceEnding -- deliberately, see that
  //     function's own comment for why a suffix/fragment dictionary was
  //     rejected as too fragile. The real fix for this class is removing
  //     the schema's maxLength above, which removed the length-target
  //     pressure that produced all 9 of these in the first place.
  //   - truncated on a bare trailing conjunction ("...представляющий, как",
  //     "...цвет, что при"): NOW caught, via this task's "как"/"при"
  //     additions to INCOMPLETE_ENDING_WORDS.
  //   - grammatical number/gender disagreement ("Городское парки"): NOT
  //     caught by any deterministic check -- no grammar checker was built
  //     (out of scope per the task); mitigated only at the prompt level
  //     (ruNaturalnessInstruction's agreement instruction below). Recorded
  //     here as a known, accepted quality gap, not a false test pass.
  //   - noun tautology ("краски ... краски"): same as above -- NOT caught
  //     deterministically, mitigated only at the prompt level.
  {
    const productionPhrases = {
      truncatedFragment: [
        'Положите влажную салфетку в контейнер для хранилища стале',
        'Городское парки наполняются людьми, и осень добавляет особ',
        'Кажется, много разблокировок, сегодня день активности и жела',
        'Иногда полезно остановиться и просто понаблюдать за окружающ',
        'Можно обвести в раме те фотографии, которые придают уверенн',
        'Переводы почти удвоились до 728 миллиардов долларов за десят',
      ],
      truncatedOnConjunction: [
        'Существует «День знаков препинания», представляющий, как',
        'Осень уже на подходе, и листья начинают менять цвет, что при',
      ],
      tautologyNotTruncation: [
        'Сентябрь приносит с собой яркие краски осени и новые краски',
      ],
    };

    for (const text of productionPhrases.truncatedOnConjunction) {
      assert.strictEqual(hasIncompleteSentenceEnding(text), true, `must now be caught: "${text}"`);
      assert.strictEqual(isUnusableLockScreenText(text), true, `must now be rejected end-to-end: "${text}"`);
    }

    for (const text of productionPhrases.truncatedFragment) {
      assert.strictEqual(
        hasIncompleteSentenceEnding(text),
        false,
        `documented gap: mid-word fragment truncation is not caught deterministically (fix is the schema change, not this check): "${text}"`
      );
    }

    // The tautology example is NOT actually truncated -- it ends on a
    // complete, valid word ("краски") -- so it correctly passes the
    // completeness check. Its problem (repeated noun) is a documented,
    // prompt-only mitigation (ruNaturalnessInstruction), not something this
    // deterministic check was ever meant to catch.
    for (const text of productionPhrases.tautologyNotTruncation) {
      assert.strictEqual(hasIncompleteSentenceEnding(text), false, `not a truncation defect, must not be flagged as one: "${text}"`);
    }
  }

  // --- grammar agreement: known, accepted quality gap (item 6) ---
  {
    const correct = 'Городские парки наполняются людьми';
    const productionError = 'Городское парки наполняются людьми, и осень добавляет особую свежесть';
    assert.strictEqual(isUnusableLockScreenText(correct), false, 'a grammatically correct phrase must be accepted');
    // No deterministic grammar/agreement checker exists (out of scope, see
    // task history) -- this is NOT a false negative, it's the documented,
    // accepted state: gender/number agreement errors like "Городское парки"
    // (should be "Городские парки") are only mitigated at the prompt level
    // (ruNaturalnessInstruction's explicit agreement example), never
    // deterministically validated server-side.
    assert.strictEqual(
      isUnusableLockScreenText(productionError),
      false,
      'known accepted gap: agreement errors are not caught by any deterministic check, only mitigated in the prompt'
    );
  }

  // --- prompt: Russian-only naturalness instruction ---
  {
    const ruPrompt = buildSystemPrompt('ru');
    assert(/естественным современным русским/i.test(ruPrompt), 'ru prompt must instruct natural modern Russian');
    assert(/калек/i.test(ruPrompt), 'ru prompt must forbid calques/literal translation');
    assert(/завершённой мыслью/i.test(ruPrompt), 'ru prompt must require each phrase to be a complete thought');
    assert(/согласовани.*рода, числа и падежа/i.test(ruPrompt), 'ru prompt must require gender/number/case agreement');
    assert(/городские парки/i.test(ruPrompt), 'ru prompt must give the concrete agreement example from the production incident');
    assert(/не обрывай.*слово/i.test(ruPrompt), 'ru prompt must explicitly forbid cutting a word off mid-word for length');
    assert(/не повторяй.*существительное/i.test(ruPrompt), 'ru prompt must instruct against repeating the same noun in one short phrase');

    const enPrompt = buildSystemPrompt('en');
    assert(!/калек/i.test(enPrompt), 'the Russian-only naturalness sentence must not leak into a non-ru prompt');
    assert(!/естественным современным русским/i.test(enPrompt));
    assert(!/городские парки/i.test(enPrompt));
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
