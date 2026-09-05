const db = require('./db');

const getPendingForDeviceStatement = db.prepare(`
  SELECT m.id, m.text, m.style_id
  FROM admin_messages m
  WHERE m.is_active = 1
    AND (m.target_device_id = ? OR m.target_device_id IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM admin_message_deliveries d
      WHERE d.message_id = m.id AND d.device_id = ?
    )
  ORDER BY m.created_at ASC
`);

const recordDeliveryStatement = db.prepare(`
  INSERT OR IGNORE INTO admin_message_deliveries (message_id, device_id)
  VALUES (?, ?)
`);

/**
 * Returns admin messages (targeted at this device, or broadcast to all
 * devices) that this specific device hasn't received yet, and marks them
 * as delivered. Call this once per /batch request — each pending message
 * is delivered exactly once per device.
 */
function consumePendingMessages(deviceId) {
  const pending = getPendingForDeviceStatement.all(deviceId, deviceId);
  for (const message of pending) {
    recordDeliveryStatement.run(message.id, deviceId);
  }
  return pending.map((m) => ({ text: m.text, style_id: m.style_id }));
}

module.exports = { consumePendingMessages };
