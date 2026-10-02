const db = require('./db');

// Phone data for ONE finished day (yesterday), sent by the app with the morning /day request:
// steps, unlocks, screen time. The day plan uses it once, in the morning recap. The model never
// gets exact numbers, only a level against this person's own usual days (or against fixed
// thresholds while fewer than MIN_BASELINE_DAYS days are known).

const MAX_STEPS = 200000;
const MAX_UNLOCKS = 10000;
const MAX_SCREEN_SECONDS = 24 * 60 * 60;
const BASELINE_DAYS = 14;
const MIN_BASELINE_DAYS = 3;
const MORE_RATIO = 1.3;
const LESS_RATIO = 0.7;
// Used while there is no baseline yet.
const ABSOLUTE_LEVELS = {
  steps: { high: 10000, low: 3000 },
  unlocks: { high: 120, low: 30 },
  screen_seconds: { high: 6 * 3600, low: 1 * 3600 },
};

const upsertSummaryStatement = db.prepare(`
  INSERT INTO phone_day_summaries (device_id, local_date, steps, unlocks, screen_seconds)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(device_id, local_date) DO UPDATE SET
    steps = excluded.steps,
    unlocks = excluded.unlocks,
    screen_seconds = excluded.screen_seconds,
    recorded_at = datetime('now')
`);

const selectBaselineStatement = db.prepare(`
  SELECT steps, unlocks, screen_seconds FROM phone_day_summaries
  WHERE device_id = ? AND local_date < ?
  ORDER BY local_date DESC
  LIMIT ?
`);

function parseCount(raw, max) {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > max) {
    return null;
  }
  return value;
}

// Query params of GET /api/v1/day: yesterday_steps, yesterday_unlocks, yesterday_screen_seconds.
// Each is optional and independent; a malformed value is ignored, never fatal. Returns null when
// nothing usable was sent.
function parseYesterdayPhoneData(query = {}) {
  const data = {
    steps: parseCount(query.yesterday_steps, MAX_STEPS),
    unlocks: parseCount(query.yesterday_unlocks, MAX_UNLOCKS),
    screen_seconds: parseCount(query.yesterday_screen_seconds, MAX_SCREEN_SECONDS),
  };
  return Object.values(data).some((v) => v !== null) ? data : null;
}

function recordPhoneDay(deviceId, localDate, data) {
  if (!deviceId || !localDate || !data) {
    return false;
  }
  try {
    upsertSummaryStatement.run(deviceId, localDate, data.steps, data.unlocks, data.screen_seconds);
    return true;
  } catch (err) {
    console.warn(`PHONE_DAY_RECORD_ERROR device_id=${deviceId} error=${err.name || 'Error'}`);
    return false;
  }
}

function levelAgainst(value, usualValues, absolute) {
  if (value === null || value === undefined) {
    return null;
  }
  if (usualValues.length >= MIN_BASELINE_DAYS) {
    const usual = usualValues.reduce((a, b) => a + b, 0) / usualValues.length;
    if (usual > 0) {
      const ratio = value / usual;
      return { level: ratio >= MORE_RATIO ? 'higher_than_usual' : ratio <= LESS_RATIO ? 'lower_than_usual' : 'about_usual' };
    }
  }
  return { level: value >= absolute.high ? 'high' : value <= absolute.low ? 'low' : 'normal' };
}

// { steps, unlocks, screen_time } -> level words, or null when the phone sent nothing. Call BEFORE
// recordPhoneDay so that yesterday itself is not part of its own baseline (it is excluded by date anyway).
function buildPhoneYesterday(deviceId, yesterdayDate, data) {
  if (!data) {
    return null;
  }
  const history = deviceId && yesterdayDate ? selectBaselineStatement.all(deviceId, yesterdayDate, BASELINE_DAYS) : [];
  const column = (name) => history.map((row) => row[name]).filter((v) => Number.isFinite(v));
  const result = {};
  const steps = levelAgainst(data.steps, column('steps'), ABSOLUTE_LEVELS.steps);
  const unlocks = levelAgainst(data.unlocks, column('unlocks'), ABSOLUTE_LEVELS.unlocks);
  const screen = levelAgainst(data.screen_seconds, column('screen_seconds'), ABSOLUTE_LEVELS.screen_seconds);
  if (steps) result.walking = steps.level;
  if (unlocks) result.phone_unlocks = unlocks.level;
  if (screen) result.screen_time = screen.level;
  return Object.keys(result).length > 0 ? result : null;
}

module.exports = {
  parseYesterdayPhoneData,
  recordPhoneDay,
  buildPhoneYesterday,
  _test: { levelAgainst, MIN_BASELINE_DAYS, MORE_RATIO, LESS_RATIO },
};
