// Regression coverage for two things:
// (1) the historical "incomplete sentence" production incident (a phrase cut
//     off mid-thought exactly at the old schema maxLength, e.g. "...выявить
//     в") -- the hasIncompleteSentenceEnding guard that used to catch this
//     was REMOVED as part of the content-quality rebuild (requirement A: the
//     server checks only schema/empty/too_long/language/duplicates now, no
//     stylistic/completeness heuristics) -- so this file now confirms that
//     removal instead of the guard's old behavior;
// (2) the schema's own `maxLength` must still carry no length constraint at
//     all -- that part of the original fix (removing the schema property
//     entirely, letting LOCK_SCREEN_TEXT_MAX_LENGTH be the one real
//     server-side hard cap) is unrelated to the removed style filters and
//     still applies.
// Zero real OpenAI calls.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-incomplete-sentence-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const { validateLockScreenText } = require('../src/textFilter');
const {
  LOCK_SCREEN_TEXT_MAX_LENGTH,
  buildBatchResponseFormat,
  buildSystemPrompt,
  isUnusableLockScreenText,
} = require('../src/contentGenerator')._test;

function main() {
  // --- 1. The incomplete-sentence guard (and its word list) no longer
  // exists at all -- content-quality rebuild, requirement A. ---
  {
    const textFilter = require('../src/textFilter');
    assert.strictEqual(textFilter.hasIncompleteSentenceEnding, undefined, 'hasIncompleteSentenceEnding must no longer be exported');
    assert.strictEqual(textFilter.INCOMPLETE_ENDING_WORDS, undefined, 'INCOMPLETE_ENDING_WORDS must no longer be exported');
  }

  // --- 2. The exact production incident string is now ACCEPTED: it is
  // exactly 70 chars (at the hard cap, not over it), and the completeness
  // guard that used to flag its trailing "в" is gone. ---
  {
    const crisprCutoff = 'Благодаря диагностике на основе CRISPR, болезни теперь можно выявить в';
    assert.strictEqual(crisprCutoff.length, 70, 'fixture sanity: this is the real 70-char production string');
    assert.strictEqual(validateLockScreenText(crisprCutoff, { maxLength: LOCK_SCREEN_TEXT_MAX_LENGTH }).ok, true, 'a 70-char string must pass length validation regardless of its trailing word');
    assert.strictEqual(isUnusableLockScreenText(crisprCutoff), false, 'the former incomplete-sentence guard must no longer reject this string');
  }

  // --- 3. A normal, complete phrase still passes, as before. ---
  {
    const complete = 'Сегодня можно просто отдохнуть';
    assert.strictEqual(validateLockScreenText(complete, { maxLength: LOCK_SCREEN_TEXT_MAX_LENGTH }).ok, true);
    assert.strictEqual(isUnusableLockScreenText(complete), false);
  }

  // --- 4. A phrase one character over the hard cap is still rejected --
  // too_long is one of the checks requirement A keeps. ---
  {
    const overCap = `${'а'.repeat(LOCK_SCREEN_TEXT_MAX_LENGTH)}б`;
    assert.strictEqual(overCap.length, LOCK_SCREEN_TEXT_MAX_LENGTH + 1);
    assert.strictEqual(isUnusableLockScreenText(overCap), true, 'a phrase over the hard cap must still be rejected');
  }

  // --- 5. The OpenAI-visible schema must still carry no length constraint
  // on `text` at all (unrelated to the removed style filters -- this was
  // always a separate fix: LOCK_SCREEN_TEXT_MAX_LENGTH (70) is the one real
  // hard cap, enforced only after generation, server-side). ---
  {
    assert.strictEqual(LOCK_SCREEN_TEXT_MAX_LENGTH, 70, 'the real hard cap enforced by server-side validation must stay 70');

    const schema = buildBatchResponseFormat('lock_screen_batch', 12);
    const textSchema = schema.json_schema.schema.properties.phrases.items.properties.text;
    assert.deepStrictEqual(textSchema, { type: 'string' }, 'the OpenAI-visible schema must carry no maxLength (or any other length constraint) on text at all');
    assert(!Object.prototype.hasOwnProperty.call(textSchema, 'maxLength'), 'text schema must not define maxLength in any form');
    assert(!JSON.stringify(schema).includes('"maxLength"'), 'no maxLength keyword anywhere in the response schema');

    const completeLongPhrase = 'Международный день переводчика напоминает о силе точного слова';
    assert(
      completeLongPhrase.length > 60 && completeLongPhrase.length <= LOCK_SCREEN_TEXT_MAX_LENGTH,
      'fixture sanity: must land strictly between the old soft target and the hard cap'
    );
    assert.strictEqual(isUnusableLockScreenText(completeLongPhrase), false, 'a complete phrase between 60 and 70 chars must still be accepted');
  }

  // --- 6. Grammar agreement / mid-word truncation / noun tautology were
  // never deterministically caught (documented, accepted gap, mitigated only
  // at the prompt level) -- still true now that even the completeness guard
  // is gone, so these must all still pass validation. ---
  {
    const productionPhrases = [
      'Положите влажную салфетку в контейнер для хранилища стале',
      'Городское парки наполняются людьми, и осень добавляет особ',
      'Существует «День знаков препинания», представляющий, как',
      'Сентябрь приносит с собой яркие краски осени и новые краски',
    ];
    for (const text of productionPhrases) {
      assert.strictEqual(isUnusableLockScreenText(text), false, `no deterministic guard exists for this class of defect any more: "${text}"`);
    }
  }

  // --- 7. buildSystemPrompt (content-quality rebuild, requirement D): now a
  // constant, argument-free, English-only prompt -- the old Russian-only
  // naturalness instruction (calque/agreement guidance) is gone from the
  // prompt text along with the style filters it used to complement. Full
  // structural check (opening/closing sentence, section order) lives in
  // tests/slot-planner.test.js; here just confirm the old per-language
  // behavior is gone. ---
  {
    const promptNoArgs = buildSystemPrompt();
    const promptRu = buildSystemPrompt('ru');
    const promptEn = buildSystemPrompt('en');
    assert.strictEqual(promptRu, promptNoArgs, 'buildSystemPrompt must ignore any language argument');
    assert.strictEqual(promptEn, promptNoArgs, 'buildSystemPrompt must return the same constant text regardless of argument');
    assert(!/калек/i.test(promptNoArgs), 'the old Russian-only naturalness instruction must be gone');
    assert(!/естественным современным русским/i.test(promptNoArgs));
  }

  // --- 8. server-authored fallback strings are gone entirely ---
  {
    const src = fs.readFileSync(require.resolve('../src/contentGenerator.js'), 'utf8');
    assert(!src.includes('Отдохни — ты его заслужил'), 'the old calque fallback string must be gone from the source');
    assert(!src.includes('Ты заслуживаешь немного отдыха'), 'server-authored fallback strings must not remain in the source');
  }
}

main();
db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('incomplete-sentence.test.js: all assertions passed');
