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

/**
 * @param {object} query - req.query
 * @returns {object} only the signals that were present and valid, e.g.
 *   { battery_level: 42, steps_since_last_batch: 1230 }
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
  return signals;
}

module.exports = { parseDeviceSignals };
