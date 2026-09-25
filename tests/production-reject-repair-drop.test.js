// Regression test for the batch_id 18 (window=night, lang=ru, date
// 2026-09-25) production incident: all 12 of 12 phrases were rejected on
// first pass (11 "basic_quality" for exceeding LOCK_SCREEN_TEXT_MAX_LENGTH,
// 1 "blocked_phrase" for goodnight_care's "пусть"), repair.called stayed
// false (generatedCount was 0), and every slot ended up filled from generic
// fallback pools.
//
// This test replays the exact 12 rejected texts from that trace through the
// real validation code, then drives a full generateBatch() run with a mocked
// OpenAI client whose first call returns those same 12 texts and whose
// repair call fixes some slots and leaves others still invalid. It asserts:
//   - the real rejectionReasonForText/collectUsablePhrases report the exact
//     too_long:N>70 / blocked_phrase:пусть sub-reasons, not just the coarse
//     "basic_quality"/"blocked_phrase" bucket (B1);
//   - repair.called is true even though generatedCount was 0 (B3);
//   - the goodnight_care slot's "пусть"-based rewrite is accepted, not
//     blocked (B4);
//   - slots still rejected after the one repair round are DROPPED, not
//     filled from FALLBACK_PHRASES -- no fallback_generic/fallback_anchor
//     entries appear, and the final batch is shorter than 12 (B5).
const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-prod-reject-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');

const db = require('../src/db');
const { STYLE_IDS } = require('../src/constants');
const { generateBatch, _test: contentTest } = require('../src/contentGenerator');
const { LOCK_SCREEN_TEXT_MAX_LENGTH, rejectionReasonForText, collectUsablePhrases } = contentTest;

// The exact 12 rejected texts from the batch_id 18 production trace (s1..s11
// are the "basic_quality" rejections, s12 is goodnight_care's
// "blocked_phrase" rejection).
const PRODUCTION_REJECTED_TEXTS = [
  'Осень приносит переменчивые настроения, но каждый день приветствует нас новыми возможностями.',
  'В 2026 году возобновляемая энергетика, по прогнозам, превзойдет уголь по объему производства электроэнергии в мире.',
  'Первая серия программы "60 минут" вышла в эфир 24 сентября 1968 года, завоевав внимение зрителей.',
  'Невозможно игнорировать, как мир вокруг нас постоянно меняется и преображается.',
  'Часто простые вещи, такие как прогулка на свежем воздухе, могут приносить удивительное спокойствие.',
  'Европа исследует солнечные панели для железных дорог, основываясь на успехе швейцарских трасс.',
  'Я бы рассказал вам шутку о химии, но не уверен, что она вызовет реакцию.',
  'Кажется, сегодня вечер вы проводите активно, возможно, стоит немного отвлечься и отдохнуть.',
  'Правильная обувь может сделать вашу прогулку более комфортной даже в дождь.',
  'Рынок углеродных кредитов по Парижскому соглашению теперь поддерживает проекты в области возобновляемых источников энергии.',
  'Выражение "развеять лед" означает снять напряжение или начать разговор.',
];
const GOODNIGHT_REJECTED_TEXT = 'Спокойной ночи, пусть завтра день принесет только хорошее.';

// --- Part 1: replay each text through the REAL validation functions ------

function testExactSubReasonsForProductionTexts() {
  for (const text of PRODUCTION_REJECTED_TEXTS) {
    const { reason, detail } = rejectionReasonForText(text, 'ru', {});
    assert.strictEqual(reason, 'basic_quality', `expected basic_quality for: ${text}`);
    const expectedDetail = `too_long:${text.trim().length}>${LOCK_SCREEN_TEXT_MAX_LENGTH}`;
    assert.strictEqual(detail, expectedDetail, `expected exact too_long detail for: ${text}`);
    assert(text.trim().length > LOCK_SCREEN_TEXT_MAX_LENGTH, 'sanity: text must actually exceed the real limit');
    // Word count must NOT be the trigger -- confirms length, not word count,
    // is the dominant/only cause (this task's stop condition check).
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    assert(wordCount <= 16, `word count must be within the 16-word limit (was ${wordCount}), proving length alone caused the rejection`);
  }

  const { reason: goodnightReason, detail: goodnightDetail } = rejectionReasonForText(GOODNIGHT_REJECTED_TEXT, 'ru', {});
  assert.strictEqual(goodnightReason, 'blocked_phrase');
  assert.strictEqual(goodnightDetail, 'blocked_phrase:пусть', 'must report the exact matched stop phrase, not just the coarse reason');

  // collectUsablePhrases over the whole batch: 11 basic_quality (unchanged --
  // the length limit fix is orthogonal to the blocked-phrase fix). The
  // blocked_phrase count is now 0, not 1: with real slot types threaded
  // through (s12 is goodnight_care) and the follow-up "спокойной
  // ночи"/"покой"-collision fix, GOODNIGHT_REJECTED_TEXT itself is now
  // ACCEPTED on first pass -- it's exactly the sanctioned wish, so it no
  // longer needs repair at all. This is a strictly better outcome than the
  // original production incident (which rejected it), not a regression in
  // this test.
  const phrases = [...PRODUCTION_REJECTED_TEXTS, GOODNIGHT_REJECTED_TEXT].map((text, i) => ({
    slot_id: `s${i + 1}`,
    text,
    style_id: null,
  }));
  const expectedSlots = phrases.map((p, i) => ({ slot_id: p.slot_id, type: i === 11 ? 'goodnight_care' : 'free_ai_thought' }));
  const collected = collectUsablePhrases(phrases, 'ru', {}, expectedSlots);
  assert.strictEqual(collected.accepted.length, 1, 'only the goodnight_care wish should be accepted -- the fixed blocked-phrase collision');
  assert.strictEqual(collected.accepted[0].slot_id, 's12');
  assert.strictEqual(collected.rejectionReasons.basic_quality, 11);
  assert.strictEqual(collected.rejectionReasons.blocked_phrase, undefined, 'the goodnight wish text no longer triggers blocked_phrase at all');

  // B4: with slot type goodnight_care, the SAME text (minus the "ночи" part,
  // which is a separate, still-enforced ban) must be ACCEPTED once it no
  // longer contains "ночи" -- proving the exemption is scoped to "пусть"
  // only, not a blanket pass for goodnight_care.
  const goodnightFixedNoNight = 'Пусть впереди будет только хорошее.';
  const fixedResult = rejectionReasonForText(goodnightFixedNoNight, 'ru', {}, 'goodnight_care');
  assert.strictEqual(fixedResult.reason, null, '"пусть" must be allowed for goodnight_care once no other ban applies');

  // Same "пусть" text is STILL blocked for every other slot type (the
  // exemption must not leak).
  const stillBlockedElsewhere = rejectionReasonForText(goodnightFixedNoNight, 'ru', {}, 'free_ai_thought');
  assert.strictEqual(stillBlockedElsewhere.reason, 'blocked_phrase', '"пусть" must stay blocked for every slot type other than goodnight_care');

  // Follow-up fix: the two fixed, idiomatic good-night wishes ("спокойной
  // ночи"/"доброй ночи") are now allowed for goodnight_care specifically --
  // see GOODNIGHT_CARE_ALLOWED_NIGHT_PHRASES in textFilter.js. The general
  // "ноч" stop phrase (night-poetry ban) stays fully enforced everywhere
  // else, including any OTHER "ноч" occurrence inside a goodnight_care text.

  // The exact case from the review: the fixed wish combined with other
  // content must be accepted for goodnight_care.
  const wishWithContent = rejectionReasonForText('Спокойной ночи, пусть завтра будет добрым', 'ru', {}, 'goodnight_care');
  assert.strictEqual(wishWithContent.reason, null, '"Спокойной ночи, пусть завтра будет добрым" must be accepted for goodnight_care');

  const dobroyNightWishWithContent = rejectionReasonForText('Доброй ночи, пусть приснятся хорошие сны', 'ru', {}, 'goodnight_care');
  assert.strictEqual(dobroyNightWishWithContent.reason, null, '"Доброй ночи, ..." must also be accepted for goodnight_care');

  // Night POETRY (not the fixed wish itself) must still be rejected for
  // goodnight_care -- the exemption only carves out the two literal phrases,
  // it is not a blanket pass on "ноч".
  const nightPoetry = rejectionReasonForText('Ночь укутает тишиной', 'ru', {}, 'goodnight_care');
  assert.strictEqual(nightPoetry.reason, 'blocked_phrase', '"Ночь укутает тишиной" must still be rejected for goodnight_care (night-poetry ban)');
  assert.strictEqual(nightPoetry.detail, 'blocked_phrase:ноч');

  // A second, non-idiomatic "ноч" mention alongside the fixed wish must still
  // block -- the exemption strips only the sanctioned phrase, not every "ноч".
  const wishPlusExtraNightMention = rejectionReasonForText('Спокойной ночи, пусть эта ночь принесёт покой', 'ru', {}, 'goodnight_care');
  assert.strictEqual(wishPlusExtraNightMention.reason, 'blocked_phrase', 'a second, non-idiomatic "ноч" mention must still block even for goodnight_care');

  // The same "Спокойной ночи" wish must still be rejected for every OTHER
  // slot type -- the exemption is scoped to goodnight_care only.
  const nightWishElsewhere = rejectionReasonForText('Спокойной ночи, пусть завтра будет добрым', 'ru', {}, 'free_ai_thought');
  assert.strictEqual(nightWishElsewhere.reason, 'blocked_phrase', '"Спокойной ночи" must still be rejected outside goodnight_care');

  const nightWishElsewhereNoSlotType = rejectionReasonForText('Спокойной ночи.', 'ru', {});
  assert.strictEqual(nightWishElsewhereNoSlotType.reason, 'blocked_phrase', '"Спокойной ночи" must still be rejected with no slot type at all');

  console.log('[production-reject] sub-reason/collectUsablePhrases checks passed');
}

// --- Part 2: full generateBatch() run with a mocked repair pass ----------

async function testRepairAlwaysCalledAndDropsStillRejectedSlots() {
  process.env.OPENAI_API_KEY = 'test-key-production-reject-repair';
  db.prepare(`
    INSERT INTO devices (device_id, name, gender, birth_date, timezone, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('prod-reject-device', 'Aigerim', 'female', '1998-03-02', 'Asia/Almaty', '2026-09-01 00:00:00');

  let callCount = 0;
  let firstRequestSlotIds = [];
  let repairRequestPayload = null;
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
                  // First pass: reproduce the exact production incident --
                  // every planned slot gets a too-long text, and whichever
                  // slot is goodnight_care gets the exact blocked "пусть"
                  // text from the trace.
                  firstRequestSlotIds = payload.slots.map((slot) => slot.slot_id);
                  return {
                    choices: [{
                      message: {
                        content: JSON.stringify({
                          phrases: payload.slots.map((slot, index) => ({
                            slot_id: slot.slot_id,
                            text: slot.type === 'goodnight_care'
                              ? GOODNIGHT_REJECTED_TEXT
                              : PRODUCTION_REJECTED_TEXTS[index % PRODUCTION_REJECTED_TEXTS.length],
                            style_id: STYLE_IDS[index % STYLE_IDS.length],
                          })),
                        }),
                      },
                    }],
                  };
                }
                // Repair pass: payload.slots here are the repair-slot
                // descriptors (goodnight_care is never among them -- it was
                // already accepted on first pass) -- assert they carry the
                // B3 fields (original text/exact reason/limit), then fix
                // every even-indexed slot, leaving odd-indexed slots still
                // too long (still rejected after repair -> must be dropped,
                // not fallback-filled).
                repairRequestPayload = payload;
                return {
                  choices: [{
                    message: {
                      content: JSON.stringify({
                        phrases: payload.slots.map((slot, index) => {
                          if (index % 2 === 0) {
                            return { slot_id: slot.slot_id, text: `Короткий факт номер ${index + 1}.`, style_id: STYLE_IDS[index % STYLE_IDS.length] };
                          }
                          // Still violates the same limit -- repair must not
                          // magically fix what the model refuses to shorten.
                          return { slot_id: slot.slot_id, text: slot.original_text, style_id: STYLE_IDS[index % STYLE_IDS.length] };
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
        device_id: 'prod-reject-device',
        name: 'Aigerim',
        gender: 'female',
        birth_date: '1998-03-02',
        timezone: 'Asia/Almaty',
        created_at: '2026-09-01 00:00:00',
      },
      'night',
      { system_language: 'ru', region: 'KZ', battery_level: 40 },
      null,
      {},
      { localDate: '2026-09-25' }
    );

    assert.strictEqual(callCount, 2, 'a batch with at least one rejection must still trigger exactly one repair call (B3)');
    assert(result.trace, 'trace must be returned');

    // B3: repair must be called even though generatedCount was 0 on the
    // FIRST pass (every non-goodnight slot rejected for length) -- this is
    // the exact production gate bug. The one goodnight_care slot is NOT
    // among the rejected ones anymore (see below) thanks to the follow-up
    // blocked-phrase fix, so repair.sent_slot_ids is 11, not all 12 --
    // still proves B3, since generatedCount was 0 going into the gate check
    // (nothing was accepted from openai_first at that point) and repair
    // still fired.
    assert.strictEqual(result.trace.repair.called, true, 'repair must be called when at least one slot was rejected on first pass');
    assert.strictEqual(result.trace.repair.sent_slot_ids.length, firstRequestSlotIds.length - 1, 'every slot except the accepted goodnight_care one must be sent to repair');

    // Follow-up fix: with the "спокойной ночи"/"покой" collision fixed, the
    // exact production goodnight_care text is now ACCEPTED on first pass --
    // a strictly better outcome than the original incident (which rejected
    // it), so it never even needs repair.
    const goodnightFirstPass = result.trace.first_pass.find((item) => item.text === GOODNIGHT_REJECTED_TEXT);
    assert(goodnightFirstPass, 'goodnight_care first-pass result must be in the trace');
    assert.strictEqual(goodnightFirstPass.status, 'accepted', 'the sanctioned goodnight wish must be accepted on first pass, not rejected');
    assert.strictEqual(goodnightFirstPass.reason, null);
    assert(result.phrases.some((p) => p.text === GOODNIGHT_REJECTED_TEXT), 'the accepted goodnight_care text must be in the final batch, unmodified');
    const goodnightFinal = result.trace.final.find((item) => item.text === GOODNIGHT_REJECTED_TEXT);
    assert(goodnightFinal, 'goodnight_care must appear in the final trace');
    assert.strictEqual(goodnightFinal.final_source, 'openai_first', 'goodnight_care must be sourced from the first pass, not repair or fallback');

    // B1: first-pass trace must carry the exact sub-reason, not just
    // "basic_quality"/"blocked_phrase", for the still-too-long slots.
    const someTooLong = result.trace.first_pass.find((item) => item.status === 'rejected' && item.text !== GOODNIGHT_REJECTED_TEXT);
    assert(someTooLong, 'at least one too-long rejection must be in the trace');
    assert(/^too_long:\d+>70$/.test(someTooLong.reason), `expected an exact too_long:N>70 reason, got "${someTooLong.reason}"`);

    // B3: the repair payload must carry original_text/rejection_reason/
    // max_length_chars per slot -- and must NOT include the already-accepted
    // goodnight_care slot.
    assert(repairRequestPayload, 'repair request must have been captured');
    assert(!repairRequestPayload.slots.some((slot) => slot.type === 'goodnight_care'), 'the already-accepted goodnight_care slot must not be sent to repair');
    for (const slot of repairRequestPayload.slots) {
      assert(typeof slot.original_text === 'string' && slot.original_text.length > 0, `repair slot ${slot.slot_id} must carry original_text`);
      assert(typeof slot.rejection_reason === 'string' && slot.rejection_reason.length > 0, `repair slot ${slot.slot_id} must carry rejection_reason`);
      assert.strictEqual(slot.max_length_chars, LOCK_SCREEN_TEXT_MAX_LENGTH, `repair slot ${slot.slot_id} must carry the real max_length_chars`);
    }

    // B5: slots still rejected after the one repair round must be dropped,
    // not filled from FALLBACK_PHRASES -- no fallback_generic/anchor
    // entries, and the batch is shorter than 12.
    assert.strictEqual(result.trace.fallback.length, 0, 'no slot may be filled from a FALLBACK_PHRASES pool after repair -- still-rejected slots must be dropped');
    assert(!result.trace.final.some((item) => (item.final_source || '').startsWith('fallback')), 'no final entry may come from a fallback pool');
    assert(result.phrases.length < 12, `final batch must be shorter than 12 (some slots stayed rejected after repair), got ${result.phrases.length}`);
    assert(result.phrases.length > 0, 'final batch must not be empty -- some slots were fixed by repair');
    assert.strictEqual(result.trace.whole_batch_fallback.flag, false, 'whole-batch fallback must not fire when at least one phrase survived repair');

    console.log(`[production-reject] repair called=${result.trace.repair.called} final_batch_length=${result.phrases.length} fallback_entries=${result.trace.fallback.length}`);
    console.log('[production-reject-trace]', JSON.stringify(result.trace));
  } finally {
    Module._load = originalLoad;
    delete process.env.OPENAI_API_KEY;
  }
}

async function main() {
  testExactSubReasonsForProductionTexts();
  await testRepairAlwaysCalledAndDropsStillRejectedSlots();
}

main()
  .then(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('[production-reject] all checks passed');
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
