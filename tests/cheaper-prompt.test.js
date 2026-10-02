const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lockscreen-cheaper-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'app.db');
delete process.env.OPENAI_API_KEY;
delete process.env.CHEAPER_PROMPT;
delete process.env.OPENAI_REASONING_EFFORT;

const db = require('../src/db');
const { _test: contentTest } = require('../src/contentGenerator');
const { buildBankPrompt } = require('../src/dailyContentBank');

const slots = [
  { slot_id: 's1', type: 'greeting_name', length_hint: 'short', facts: {} },
  { slot_id: 's2', type: 'weather_lifehack', length_hint: 'medium', facts: {} },
  { slot_id: 's3', type: 'history_today', length_hint: 'long', facts: {} },
  { slot_id: 's4', type: 'quiz_question', length_hint: 'long', facts: {} },
  { slot_id: 's5', type: 'quiz_answer', length_hint: 'short', facts: {} },
];

function payloadSlots() {
  return JSON.parse(contentTest.buildContextPrompt({ device_id: 'd1', name: 'Baur' }, 'day', {}, null, 'ru', slots, null)).slots;
}

function captureUsageLine(response) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    contentTest.logOpenAiUsage('lock_screen_batch', response);
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

try {
  // --- reasoning tokens are logged ---
  {
    const line = captureUsageLine({
      usage: {
        prompt_tokens: 4300,
        completion_tokens: 1700,
        total_tokens: 6000,
        completion_tokens_details: { reasoning_tokens: 1450 },
        prompt_tokens_details: { cached_tokens: 1024 },
      },
    });
    assert(line.includes('reasoning_tokens=1450'), line);
    assert(line.includes('completion_tokens=1700'), line);
    assert(line.includes('cached_tokens=1024'), line);
    // A response without the details block logs 0, not NaN/undefined.
    assert(captureUsageLine({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }).includes('reasoning_tokens=0'));
  }

  // --- reasoning effort follows the environment at call time ---
  {
    process.env.OPENAI_REASONING_EFFORT = 'minimal';
    assert(captureUsageLine({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }).includes('reasoning_effort=minimal'));
    process.env.OPENAI_REASONING_EFFORT = 'low';
    assert(captureUsageLine({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }).includes('reasoning_effort=low'));
    delete process.env.OPENAI_REASONING_EFFORT;
    assert(captureUsageLine({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }).includes('reasoning_effort=low'), 'default stays low');
  }

  // --- current prompt is unchanged when the switch is off ---
  {
    const offPrompt = contentTest.buildSystemPrompt('ru');
    assert(offPrompt.includes('Aim for 25–60.'), 'current HARD LIMIT text');
    assert(!offPrompt.includes('max_chars'));
    assert(payloadSlots().every((slot) => slot.max_chars === undefined), 'no max_chars without the switch');
  }

  // --- cheaper prompt: every slot has its own max_chars, below the hard 70 ---
  {
    process.env.CHEAPER_PROMPT = '1';
    const perSlot = Object.fromEntries(payloadSlots().map((slot) => [slot.type, slot.max_chars]));
    assert.deepStrictEqual(perSlot, {
      greeting_name: 50,
      weather_lifehack: 55,
      history_today: 60,
      quiz_question: 55,
      quiz_answer: 30,
    });
    for (const value of Object.values(perSlot)) {
      assert(value > 0 && value < contentTest.LOCK_SCREEN_TEXT_MAX_LENGTH, 'a margin under the hard limit');
    }

    const prompt = contentTest.buildSystemPrompt('ru');
    assert(prompt.includes('"max_chars": never exceed it'));
    assert(prompt.includes('Aim for 40–60 characters'));
    assert(prompt.includes(`absolute limit is ${contentTest.LOCK_SCREEN_TEXT_MAX_LENGTH}`));
    assert(/retell it in a few short words of your own/.test(prompt), 'retell, not translate');
    assert(/Never translate a fact in full/.test(prompt));
    assert(/quiz_question: a question of at most about 55 characters/.test(prompt));
    assert(/quiz_answer: the answer in one or two words/.test(prompt));
    assert(!prompt.includes('Aim for 25–60.'), 'the old limit text is replaced');
    // No sample phrases: the prompt never quotes an example line.
    assert(!/for example|e\.g\.|«|"Доброе утро/i.test(prompt.split('HARD LIMIT')[1].split('VOICE')[0]));

    const bank = buildBankPrompt('2026-10-02', ['KZ'], []);
    assert(bank.includes('ONE short self-contained sentence in English, at most 12 words'));
    assert(!bank.includes('up to 200 characters'));
  }
  console.log('cheaper-prompt tests passed');
} finally {
  delete process.env.CHEAPER_PROMPT;
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
