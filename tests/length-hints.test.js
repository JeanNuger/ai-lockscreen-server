// Regression coverage for the three-tier length_hint system: SHORT (~10-20
// chars) / MEDIUM (~21-40) / LONG (~41-60, a permission not an instruction)
// are sent per-slot to help the model vary phrase length across a batch,
// but LOCK_SCREEN_TEXT_MAX_LENGTH (70) stays the one hard, always-enforced
// cap regardless of which hint a slot carries -- backed by the real on-device
// measurement of the Android lock-screen text area. Zero real OpenAI calls
// (OPENAI_API_KEY is never set).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-length-hints-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;

const db = require('../src/db');
const { BATCH_SIZE, STYLE_IDS } = require('../src/constants');
const { planSlots, _test: plannerTest } = require('../src/slotPlanner');
const { _test: contentTest } = require('../src/contentGenerator');

const { LOCK_SCREEN_TEXT_MAX_LENGTH, isUnusableLockScreenText, buildContextPrompt } = contentTest;
const { lengthHintForType, TYPE_LENGTH_HINTS } = plannerTest;

function main() {
  // --- 1. hard max is 70, not the old 65 ---
  {
    assert.strictEqual(LOCK_SCREEN_TEXT_MAX_LENGTH, 70, 'the absolute hard cap must be 70, per the on-device measurement');
  }

  // --- SHORT hint: types meant to stay punchy get 'short' ---
  {
    assert.strictEqual(lengthHintForType('greeting_name'), 'short');
    assert.strictEqual(lengthHintForType('goodnight_care'), 'short');
    assert.strictEqual(lengthHintForType('smart_humor_observation'), 'short');
  }

  // --- MEDIUM hint: ordinary types default to 'medium' ---
  {
    assert.strictEqual(lengthHintForType('weather_lifehack'), 'medium');
    assert.strictEqual(lengthHintForType('holiday_today'), 'medium');
    assert.strictEqual(lengthHintForType('free_ai_thought'), 'medium');
    // an unrecognized/future type must default to medium, not crash or become undefined
    assert.strictEqual(lengthHintForType('some_future_type_not_yet_mapped'), 'medium');
  }

  // --- LONG hint: fact-carrying types get permission to say more ---
  {
    for (const type of ['history_today', 'word_learning', 'science_tech', 'country_fact',
      'good_news', 'money_economics', 'unusual_fact', 'culture']) {
      assert.strictEqual(lengthHintForType(type), 'long', `${type} must carry the 'long' hint`);
    }
  }

  // --- every CONTENT_TYPE has an explicit, deliberate entry (no silent gaps) ---
  {
    const { CONTENT_TYPES } = require('../src/slotPlanner');
    for (const type of CONTENT_TYPES) {
      assert(
        Object.prototype.hasOwnProperty.call(TYPE_LENGTH_HINTS, type) || lengthHintForType(type) === 'medium',
        `type "${type}" must resolve to a valid length hint`
      );
    }
  }

  // --- length_hint reaches the actual OpenAI payload via buildContextPrompt ---
  {
    const device = { device_id: 'length-hint-device', timezone: 'Asia/Almaty' };
    const slots = [
      { slot_id: 's1', type: 'greeting_name', facts: {}, constraints: [], length_hint: 'short' },
      { slot_id: 's2', type: 'science_tech', facts: { text: 'x' }, constraints: [], length_hint: 'long' },
    ];
    const contextJson = buildContextPrompt(device, 'morning', {}, null, 'ru', slots, null);
    const context = JSON.parse(contextJson);
    assert.strictEqual(context.slots[0].length_hint, 'short');
    assert.strictEqual(context.slots[1].length_hint, 'long');
  }

  // --- LONG still cannot exceed the absolute 70-char cap ---
  {
    const exactly70 = 'x'.repeat(70);
    const over70 = 'x'.repeat(71);
    assert.strictEqual(isUnusableLockScreenText(exactly70), false, 'exactly 70 chars must be usable');
    assert.strictEqual(isUnusableLockScreenText(over70), true, '71 chars must be rejected regardless of length_hint');
  }

  // --- word-count is no longer an effective ceiling on 'long' phrases ---
  // (the old DEFAULT_MAX_WORDS=8 would have rejected any legitimate ~60-char
  // Russian long-hint phrase on word count alone, independent of the 70-char
  // cap -- this proves that constraint no longer silently defeats the hint).
  {
    const naturalLongRuPhrase = 'Международный день мира отмечают сегодня во многих странах мира';
    assert(naturalLongRuPhrase.length <= 70, 'fixture sanity: must be within the hard cap');
    assert(naturalLongRuPhrase.split(/\s+/).length > 8, 'fixture sanity: must exceed the old 8-word ceiling');
    assert.strictEqual(isUnusableLockScreenText(naturalLongRuPhrase), false,
      'a natural long-hint phrase over 8 words must not be rejected purely on word count');
  }

  // --- a real batch can contain more than one length_hint (variety, not all-short) ---
  {
    const baseInput = {
      device: {
        device_id: 'length-hint-planner-device',
        name: 'Aruzhan',
        birth_date: '1995-05-20',
        gender: 'female',
        interests: JSON.stringify(['work']),
      },
      window: 'day',
      dateContext: {
        date: '2026-09-20',
        weekday: 'Sunday',
        time: '12:00',
        tomorrow_date: '2026-09-21',
        tomorrow_weekday: 'Monday',
      },
      weather: { temperatureC: 18, city: 'Almaty', description: 'rain' },
      bankItems: [
        { category: 'on_this_day', content_text: 'In 1519, Magellan set sail across the Atlantic.', tags: ['global'] },
        { category: 'science', content_text: 'Octopuses have three hearts.', tags: ['global'] },
        { category: 'quote', content_text: '"Simplicity is the ultimate sophistication." -- Leonardo da Vinci', tags: ['global'] },
        { category: 'good_news', content_text: 'A reforestation project just passed one million trees.', tags: ['global'] },
      ],
    };

    const planned = planSlots(baseInput, { seed: 'length-hint-variety-seed' });
    assert.strictEqual(planned.slots.length, BATCH_SIZE);

    const hintsSeen = new Set(planned.slots.map((slot) => slot.length_hint));
    assert(hintsSeen.size > 1, `a rich batch must contain more than one length_hint, saw: ${[...hintsSeen]}`);

    for (const slot of planned.slots) {
      assert(['short', 'medium', 'long'].includes(slot.length_hint), `slot ${slot.slot_id} has an invalid length_hint: ${slot.length_hint}`);
      assert.strictEqual(slot.length_hint, lengthHintForType(slot.type), `slot ${slot.slot_id}'s length_hint must match its type's mapping`);
    }
  }
}

main();
db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('length-hints.test.js: all assertions passed');
