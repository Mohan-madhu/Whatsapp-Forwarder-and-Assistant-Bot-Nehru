const fs = require('fs');
const path = require('path');

const AUTH_PATH = path.join(__dirname, 'auth_info_baileys');

try {
  if (fs.existsSync(AUTH_PATH)) {
    fs.rmSync(AUTH_PATH, { recursive: true, force: true });
    console.log('Removed auth_info_baileys. Start the bot again and scan the QR with the new WhatsApp account.');
  } else {
    console.log('auth_info_baileys is already empty/missing. Start the bot and scan the QR.');
  }
} catch (error) {
  console.error('Failed to remove auth_info_baileys:', error);
  process.exitCode = 1;
}
