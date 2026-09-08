const { STYLE_IDS, BATCH_SIZE } = require('./constants');

const FALLBACK_PHRASES = [
  'Хороший день начинается с тебя',
  'Ты справляешься лучше, чем думаешь',
  'Сделай глубокий вдох',
  'Маленькие шаги ведут к большим переменам',
  'Сегодня отличный день, чтобы попробовать что-то новое',
  'Не забудь позвонить близким',
  'Улыбнись — просто так',
  'Немного воды никогда не помешает',
  'Ты уже проделал большой путь',
  'Дай себе немного отдыха, если нужно',
];

function pickRandomStyle() {
  return STYLE_IDS[Math.floor(Math.random() * STYLE_IDS.length)];
}

function buildFallbackBatch() {
  const shuffled = [...FALLBACK_PHRASES].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, BATCH_SIZE).map((text) => ({
    text,
    style_id: pickRandomStyle(),
  }));
}

// Builds the user-context prompt sent to the model. Deliberately excludes
// anything not already agreed in PRODUCT_REBUILD_PLAN.md §5.1 — no location,
// no notification/app data (see the plan's data-source list).
//
// `signals` (optional) holds whichever device signals the client sent with
// this /batch request — see src/deviceSignals.js. Each is appended only if
// present; a device that didn't send a signal (older client, permission not
// granted, sensor unavailable) simply doesn't get that line, same as the
// existing survey fields above. Phrased descriptively, not as raw numbers
// handed to the model, so the model reads them as loose context rather than
// literal instructions — consistent with the system prompt's "не будь
// слишком буквальным" guidance below.
function buildContextPrompt(device, window, signals) {
  const parts = [];
  if (device.gender) parts.push(`пол: ${device.gender}`);
  if (device.birth_date) parts.push(`дата рождения: ${device.birth_date}`);
  if (device.interests) {
    try {
      const interests = JSON.parse(device.interests);
      if (Array.isArray(interests) && interests.length) {
        parts.push(`интересы: ${interests.join(', ')}`);
      }
    } catch (_) {
      // malformed stored JSON — skip rather than fail the whole request
    }
  }
  if (device.personal_goal) parts.push(`личная цель: ${device.personal_goal}`);
  if (device.tone) parts.push(`тон общения: ${device.tone}`);
  if (device.timezone) parts.push(`часовой пояс: ${device.timezone}`);
  parts.push(`время суток: ${window}`);

  if (signals) {
    if (signals.battery_level !== undefined) {
      parts.push(`заряд батареи телефона: ${signals.battery_level}%`);
    }
    if (signals.ambient_light !== undefined) {
      parts.push(`освещённость вокруг: ${signals.ambient_light} люкс`);
    }
    if (signals.screen_on_duration_seconds !== undefined) {
      parts.push(`последний раз экран был включён: ${signals.screen_on_duration_seconds} сек`);
    }
    if (signals.steps_since_last_batch !== undefined) {
      parts.push(`шагов с прошлого окна: ${signals.steps_since_last_batch}`);
    }
  }

  return parts.join('; ');
}

const SYSTEM_PROMPT = `Ты — генератор коротких фраз для экрана блокировки телефона (живые обои).
Верни JSON-объект с полем "phrases" — массивом ровно из ${BATCH_SIZE} объектов.
Каждый объект: {"text": "короткая фраза на русском, до 80 символов", "style_id": одно из [${STYLE_IDS.join(', ')}]}.
Фразы должны быть тёплыми, короткими, разнообразными по теме (не повторяться), уместными для мельком увиденного экрана блокировки — не навязчивые, без рекламы, без вопросов, требующих ответа.
Учитывай контекст пользователя, если он передан, но не будь слишком буквальным / не выдавай личные данные обратно в тексте.
Отвечай только JSON, без пояснений.`;

/**
 * Generates a batch of {text, style_id} phrases for a device.
 * Falls back to a local static batch if no API key is configured or the
 * OpenAI call fails for any reason — the endpoint should never 500 just
 * because content generation had a bad day.
 *
 * @param {object} device - row from the devices table (or a stub {device_id})
 * @param {string} window - 'morning' | 'day' | 'evening' | 'night'
 * @param {object} [signals] - optional device signals from deviceSignals.js
 * @returns {Promise<{phrases: Array<{text: string, style_id: string}>, source: 'openai'|'fallback'}>}
 */
async function generateBatch(device, window, signals) {
  const apiKey = process.env.OPENAI_API_KEY;
  const context = buildContextPrompt(device, window, signals);

  if (!apiKey) {
    return { phrases: buildFallbackBatch(), source: 'fallback', context };
  }

  try {
    // Lazy require: avoids crashing at startup if the package is present but
    // no key is set yet, and keeps the fallback path dependency-free.
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey });

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: context },
      ],
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    const phrases = Array.isArray(parsed.phrases) ? parsed.phrases : [];

    // Validate style_id against the fixed set — never forward a value the
    // Android client wouldn't recognize (see constants.js comment).
    const cleaned = phrases
      .filter((p) => p && typeof p.text === 'string' && p.text.trim().length > 0)
      .map((p) => ({
        text: p.text.trim(),
        style_id: STYLE_IDS.includes(p.style_id) ? p.style_id : pickRandomStyle(),
      }));

    if (cleaned.length === 0) {
      return { phrases: buildFallbackBatch(), source: 'fallback', context };
    }
    return { phrases: cleaned, source: 'openai', context };
  } catch (err) {
    console.error('OpenAI batch generation failed, using fallback:', err.message);
    return { phrases: buildFallbackBatch(), source: 'fallback', context };
  }
}

module.exports = { generateBatch, buildFallbackBatch };
