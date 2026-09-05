// Generates a bcrypt hash for the admin password, so the plaintext password
// never has to be written into .env directly or shown to anyone else.
//
// Usage:
//   node scripts/hash-password.js "your-chosen-password"
//
// Copy the printed hash into .env as ADMIN_PASSWORD_HASH.

const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js "your-chosen-password"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log('\nADMIN_PASSWORD_HASH=' + hash + '\n');
console.log('Copy the line above into your .env file, then restart the server.');
