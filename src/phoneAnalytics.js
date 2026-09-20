const db = require('./db');

const RETENTION_DAYS = 45;
const MAX_UNLOCKS_SINCE_LAST_BATCH = 10000;
const MAX_STEPS_SINCE_LAST_BATCH = 200000;
const MIN_UNLOCK_BASELINE = 3;
const MIN_STEP_BASELINE = 100;

const getYesterdaySampleStatement = db.prepare(`
  SELECT unlocks_since_last_batch, steps_since_last_batch
  FROM phone_signal_samples
  WHERE device_id = ? AND window = ? AND device_local_date = ?
  ORDER BY recorded_at DESC, id DESC
  LIMIT 1
`);

const insertSampleStatement = db.prepare(`
  INSERT INTO phone_signal_samples (
    device_id,
    window,
    device_local_date,
    unlocks_since_last_batch,
    steps_since_last_batch
  )
  VALUES (?, ?, ?, ?, ?)
`);

const pruneOldSamplesStatement = db.prepare(`
  DELETE FROM phone_signal_samples
  WHERE recorded_at < datetime('now', ?)
`);

function sanitizeInteger(value, max) {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return null;
  }
  if (value < 0 || value > max) {
    return null;
  }
  return value;
}

function sanitizePhoneSignalSample(signals = {}) {
  const sample = {};
  const unlocks = sanitizeInteger(
    signals.unlocks_since_last_batch,
    MAX_UNLOCKS_SINCE_LAST_BATCH
  );
  const steps = sanitizeInteger(
    signals.steps_since_last_batch,
    MAX_STEPS_SINCE_LAST_BATCH
  );

  if (unlocks !== null) {
    sample.unlocks_since_last_batch = unlocks;
  }
  if (steps !== null) {
    sample.steps_since_last_batch = steps;
  }
  return sample;
}

function hasUsableSample(sample) {
  return Boolean(sample && (
    sample.unlocks_since_last_batch !== undefined ||
    sample.steps_since_last_batch !== undefined
  ));
}

function getLocalCalendarDate(instant, timezone) {
  if (!timezone) {
    return null;
  }
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(instant);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const year = get('year');
    const month = get('month');
    const day = get('day');
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch (err) {
    return null;
  }
}

function addDaysToDateString(date, days) {
  const instant = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(instant.getTime())) {
    return null;
  }
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function compareTrend(current, baseline, { higherRatio, lowerRatio, minBaseline }) {
  if (!Number.isInteger(current) || !Number.isInteger(baseline)) {
    return null;
  }
  if (baseline < minBaseline) {
    return null;
  }
  if (current > baseline * higherRatio) {
    return 'higher';
  }
  if (current < baseline * lowerRatio) {
    return 'lower';
  }
  return null;
}

function computePhoneTrends(device = {}, window, signals = {}, options = {}) {
  const sample = sanitizePhoneSignalSample(signals);
  if (!hasUsableSample(sample)) {
    return {};
  }

  const now = options.now || new Date();
  const localDate = getLocalCalendarDate(now, device.timezone);
  const yesterdayDate = localDate ? addDaysToDateString(localDate, -1) : null;
  if (!device.device_id || !window || !yesterdayDate) {
    return {};
  }

  const yesterday = getYesterdaySampleStatement.get(device.device_id, window, yesterdayDate);
  if (!yesterday) {
    return {};
  }

  const trends = {};
  const unlockTrend = compareTrend(
    sample.unlocks_since_last_batch,
    yesterday.unlocks_since_last_batch,
    { higherRatio: 1.35, lowerRatio: 0.65, minBaseline: MIN_UNLOCK_BASELINE }
  );
  if (unlockTrend) {
    trends.unlocks_vs_yesterday = unlockTrend;
  }

  const stepsTrend = compareTrend(
    sample.steps_since_last_batch,
    yesterday.steps_since_last_batch,
    { higherRatio: 1.5, lowerRatio: 0.5, minBaseline: MIN_STEP_BASELINE }
  );
  if (stepsTrend) {
    trends.steps_vs_yesterday = stepsTrend;
  }

  return trends;
}

function recordPhoneSignalSample(device = {}, window, signals = {}, options = {}) {
  const sample = sanitizePhoneSignalSample(signals);
  if (!hasUsableSample(sample)) {
    return false;
  }

  const now = options.now || new Date();
  const localDate = options.deviceLocalDate || getLocalCalendarDate(now, device.timezone);
  if (!device.device_id || !window || !localDate) {
    return false;
  }

  insertSampleStatement.run(
    device.device_id,
    window,
    localDate,
    sample.unlocks_since_last_batch ?? null,
    sample.steps_since_last_batch ?? null
  );
  pruneOldPhoneSignalSamples();
  return true;
}

function pruneOldPhoneSignalSamples() {
  return pruneOldSamplesStatement.run(`-${RETENTION_DAYS} days`).changes;
}

module.exports = {
  computePhoneTrends,
  recordPhoneSignalSample,
  pruneOldPhoneSignalSamples,
  _test: {
    RETENTION_DAYS,
    MIN_UNLOCK_BASELINE,
    MIN_STEP_BASELINE,
    addDaysToDateString,
    compareTrend,
    getLocalCalendarDate,
    sanitizePhoneSignalSample,
  },
};
