/**
 * WhatsApp Message Forwarder Module (Baileys)
 * Handles tagging messages and forwarding them to multiple contacts with rate limiting
 */

// Store tagged message info
const taggedMessages = new Map();

// Store active forwarding sessions
const forwardingSessions = new Map();

// Track recent forward recipients to avoid auto-replies in their chats.
const recentRecipients = new Map();
const RECENT_TTL_MS = 5 * 60 * 1000;

function markRecipient(recipientId) {
  if (!recipientId) return;
  recentRecipients.set(recipientId, Date.now() + RECENT_TTL_MS);
}

function isRecentlyForwarded(chatId) {
  const expiresAt = recentRecipients.get(chatId);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    recentRecipients.delete(chatId);
    return false;
  }
  return true;
}

/**
 * Resolve a recipient ID that WhatsApp can send to.
 * Returns null if the number is not on WhatsApp.
 * @param {object} sock - Baileys socket
 * @param {string} number - Number in @s.whatsapp.net format or raw digits
 * @returns {string|null}
 */
async function resolveRecipientId(sock, number) {
  const raw = String(number || '').replace(/@s\.whatsapp\.net$/i, '').trim();
  if (!raw) return null;
  const results = await sock.onWhatsApp(raw);
  const first = Array.isArray(results) ? results[0] : null;
  if (!first || !first.exists || !first.jid) return null;
  return first.jid;
}

/**
 * Extract plain text from a Baileys message
 * @param {object} waMsg
 * @returns {string}
 */
function extractText(waMsg) {
  const content = waMsg?.message || {};
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ''
  );
}

/**
 * Tag a message for forwarding
 * @param {string} chatId - Chat where message originated
 * @param {object} message - Baileys message object
 * @param {string} tag - Tag name/identifier
 */
function tagMessage(chatId, message, tag = 'default') {
  const messageId = message?.key?.id || `msg_${Date.now()}`;

  taggedMessages.set(tag, {
    messageId,
    body: extractText(message),
    sender: chatId,
    timestamp: new Date().toISOString(),
    originalMessage: message
  });

  return tag;
}

/**
 * Parse phone numbers from command
 * Expects format: "10 digit Indian numbers on new lines"
 * @param {string} numberString - Numbers separated by newlines
 * @returns {array} - Array of valid phone numbers with @s.whatsapp.net
 */
function parsePhoneNumbers(numberString) {
  const lines = numberString.split('\n').map((line) => line.trim()).filter(Boolean);
  const validNumbers = [];

  for (const line of lines) {
    const cleaned = line.replace(/\D/g, '');

    if (cleaned.length === 10) {
      validNumbers.push(`${cleaned}@s.whatsapp.net`);
    } else if (cleaned.length === 12 && cleaned.startsWith('91')) {
      validNumbers.push(`${cleaned.slice(2)}@s.whatsapp.net`);
    }
  }

  return validNumbers;
}

async function sendForwardedMessage(sock, recipientId, tagged) {
  // Native forward first
  try {
    await sock.sendMessage(recipientId, { forward: tagged.originalMessage });
    return;
  } catch (_) {
    // Fallback to plain text if forward payload is unsupported
  }

  if (tagged.body) {
    await sock.sendMessage(recipientId, { text: tagged.body });
    return;
  }

  throw new Error('Unable to forward this message type with current payload');
}

/**
 * Start a forwarding session
 * @param {object} sock - Baileys socket
 * @param {string} chatId - Source chat (for status messages)
 * @param {string} tag - Tag of message to forward
 * @param {array} phoneNumbers - Array of numbers to forward to
 * @param {number|object} delayConfig - Delay or { minDelayMs, maxDelayMs }
 * @returns {object}
 */
async function startForwarding(sock, chatId, tag, phoneNumbers, delayConfig = 2000) {
  const tagged = taggedMessages.get(tag);

  if (!tagged) {
    throw new Error(`No tagged message found with tag: ${tag}`);
  }

  if (!phoneNumbers || phoneNumbers.length === 0) {
    throw new Error('No valid phone numbers provided');
  }

  const sessionId = `fw_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const delayIsObject = typeof delayConfig === 'object' && delayConfig !== null;
  const minDelayMs = delayIsObject ? (delayConfig.minDelayMs || 2000) : delayConfig;
  const maxDelayMs = delayIsObject ? (delayConfig.maxDelayMs || minDelayMs) : delayConfig;

  const session = {
    sessionId,
    tag,
    chatId,
    message: tagged,
    phoneNumbers,
    total: phoneNumbers.length,
    processed: 0,
    failed: 0,
    failedNumbers: [],
    status: 'starting',
    startTime: Date.now(),
    statusMessageKey: null,
    minDelayMs,
    maxDelayMs,
    lastDelayMs: null
  };

  forwardingSessions.set(sessionId, session);
  forwardWithUpdates(sock, session);
  return session;
}

async function updateStatusMessage(sock, session, text) {
  if (session.statusMessageKey) {
    try {
      await sock.sendMessage(session.chatId, { text, edit: session.statusMessageKey });
      return;
    } catch (_) {
      // Fall through to regular message
    }
  }

  const sent = await sock.sendMessage(session.chatId, { text });
  session.statusMessageKey = sent?.key || null;
}

async function forwardWithUpdates(sock, session) {
  const { message, phoneNumbers } = session;

  try {
    const initialStatus =
      `📨 *Forwarding Started*\n` +
      `Total: ${session.total}\n` +
      `Processed: 0/${session.total}\n` +
      `Delay range: ${Math.round(session.minDelayMs / 1000)}-${Math.round(session.maxDelayMs / 1000)}s\n` +
      `Status: Starting...`;

    await updateStatusMessage(sock, session, initialStatus);

    for (let i = 0; i < phoneNumbers.length; i++) {
      if (session.status === 'cancelled') break;

      const number = phoneNumbers[i];
      session.status = 'processing';
      let nextDelayMs = null;

      try {
        const recipientId = await resolveRecipientId(sock, number);
        if (!recipientId) {
          throw new Error('No WhatsApp account for this number');
        }
        markRecipient(recipientId);

        await sendForwardedMessage(sock, recipientId, message);
        session.processed += 1;
      } catch (error) {
        const displayNumber = String(number || '').replace(/@s\.whatsapp\.net$/i, '');
        console.error(`Failed to forward to ${displayNumber || number}:`, error.message);
        session.failed += 1;
        session.failedNumbers.push(displayNumber || number);
      }

      if (i < phoneNumbers.length - 1) {
        nextDelayMs = Math.floor(Math.random() * (session.maxDelayMs - session.minDelayMs + 1)) + session.minDelayMs;
        session.lastDelayMs = nextDelayMs;
      }

      const progressPercent = Math.round(((session.processed + session.failed) / session.total) * 100);
      const delayText = nextDelayMs ? `Delay (next): ${Math.round(nextDelayMs / 1000)}s\n` : '';
      const statusText =
        `📨 *Forwarding in Progress*\n` +
        `Total: ${session.total}\n` +
        `✅ Completed: ${session.processed}\n` +
        `❌ Failed: ${session.failed}\n` +
        `Progress: ${progressPercent}%\n` +
        delayText +
        `Status: Processing...`;

      await updateStatusMessage(sock, session, statusText);

      if (nextDelayMs) {
        await sleep(nextDelayMs);
      }
    }

    const duration = Math.round((Date.now() - session.startTime) / 1000);
    session.status = session.status === 'cancelled' ? 'cancelled' : 'completed';

    const finalStatus =
      `📨 *Forwarding ${session.status === 'cancelled' ? 'Cancelled' : 'Completed'}*\n` +
      `Total: ${session.total}\n` +
      `✅ Completed: ${session.processed}\n` +
      `❌ Failed: ${session.failed}\n` +
      `Duration: ${duration}s\n` +
      `Delay range: ${Math.round(session.minDelayMs / 1000)}-${Math.round(session.maxDelayMs / 1000)}s\n` +
      `Status: ${session.status === 'cancelled' ? 'Stopped' : 'Done!'}` +
      (session.failedNumbers.length > 0 ? `\n\nFailed numbers:\n${session.failedNumbers.join(', ')}` : '');

    await updateStatusMessage(sock, session, finalStatus);
  } catch (error) {
    console.error('Forwarding error:', error);
    session.status = 'error';
    await sock.sendMessage(session.chatId, { text: `❌ Forwarding Error: ${error.message}` });
  }

  setTimeout(() => forwardingSessions.delete(session.sessionId), 60000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSessionStatus(sessionId) {
  return forwardingSessions.get(sessionId);
}

function getActiveSessions() {
  return Array.from(forwardingSessions.values());
}

function cancelSession(sessionId) {
  const session = forwardingSessions.get(sessionId);
  if (session) {
    session.status = 'cancelled';
    return true;
  }
  return false;
}

module.exports = {
  tagMessage,
  parsePhoneNumbers,
  startForwarding,
  getSessionStatus,
  getActiveSessions,
  cancelSession,
  taggedMessages,
  isRecentlyForwarded
};

