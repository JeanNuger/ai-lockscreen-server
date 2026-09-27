const DEFAULT_MAX_LENGTH = 65;

function normalizeText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function validateLockScreenText(text, options = {}) {
  if (typeof text !== 'string') {
    return { ok: false, reason: 'schema', detail: 'schema' };
  }
  const trimmed = text.trim();
  const maxLength = options.maxLength || DEFAULT_MAX_LENGTH;
  if (trimmed.length === 0) {
    return { ok: false, reason: 'basic_quality', detail: 'empty' };
  }
  if (trimmed.length > maxLength) {
    return { ok: false, reason: 'basic_quality', detail: `too_long:${trimmed.length}>${maxLength}` };
  }
  return { ok: true, reason: null, detail: null };
}

module.exports = {
  DEFAULT_MAX_LENGTH,
  normalizeText,
  validateLockScreenText,
};
