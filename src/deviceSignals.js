// Parses the optional device-signal query params the Android client may send
// alongside GET /api/v1/batch (battery level, ambient light, screen-on
// duration, steps/unlocks since last batch — see PRODUCT_REBUILD_PLAN.md's
// server contract section). All are optional and independent: a missing or
// malformed value for one never blocks the others or the request as a whole
// — these are enrichment signals for the AI context, not required fields,
// so a single bad query param should degrade gracefully (log + ignore that
// one value), not fail the whole /batch call the user's lock screen depends on.

const SIGNAL_SPECS = [
  { key: 'battery_level', min: 0, max: 100, integer: true },
  { key: 'ambient_light', min: 0, max: null, integer: false },
  { key: 'screen_on_duration_seconds', min: 0, max: null, integer: true },
  { key: 'steps_since_last_batch', min: 0, max: null, integer: true },
  { key: 'unlocks_since_last_batch', min: 0, max: null, integer: true },
];

// system_language/region are short ISO codes (ISO 639-1 language, ISO 3166-1 alpha-2
// country), not numbers — validated by pattern/length instead of the numeric min/max above.
const STRING_SIGNAL_SPECS = [
  { key: 'system_language', maxLength: 10, pattern: /^[A-Za-z-]+$/ },
  { key: 'region', maxLength: 10, pattern: /^[A-Za-z-]+$/ },
];

/**
 * @param {object} query - req.query
 * @returns {object} only the signals that were present and valid, e.g.
 *   { battery_level: 42, steps_since_last_batch: 1230, system_language: 'ru' }
 */
function parseDeviceSignals(query) {
  const signals = {};
  for (const spec of SIGNAL_SPECS) {
    const raw = query[spec.key];
    if (raw === undefined) {
      continue;
    }
    const value = spec.integer ? parseInt(raw, 10) : parseFloat(raw);
    if (
      Number.isNaN(value) ||
      value < spec.min ||
      (spec.max !== null && value > spec.max)
    ) {
      console.warn(`Ignoring invalid ${spec.key}=${raw} in /batch request`);
      continue;
    }
    signals[spec.key] = value;
  }
  for (const spec of STRING_SIGNAL_SPECS) {
    const raw = query[spec.key];
    if (raw === undefined) {
      continue;
    }
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > spec.maxLength || !spec.pattern.test(raw)) {
      console.warn(`Ignoring invalid ${spec.key}=${raw} in /batch request`);
      continue;
    }
    signals[spec.key] = raw;
  }
  return signals;
}

module.exports = { parseDeviceSignals };
