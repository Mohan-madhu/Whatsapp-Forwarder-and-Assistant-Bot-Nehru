/**
 * WhatsApp Message Forwarder Module
 * Handles tagging messages and forwarding them to multiple contacts with rate limiting
 */

// Store tagged message info: { messageId, messageBody, mediaPath, sender, timestamp }
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
 * @param {object} client - WhatsApp Web client
 * @param {string} number - Number in @c.us format or raw digits
 * @returns {string|null}
 */
async function resolveRecipientId(client, number) {
  const raw = (number || '').replace(/@c\.us$/i, '').trim();
  if (!raw) return null;
  const numberId = await client.getNumberId(raw);
  return numberId?._serialized || null;
}

/**
 * Tag a message for forwarding
 * @param {string} chatId - Chat where message originated
 * @param {object} message - WhatsApp message object
 * @param {string} tag - Tag name/identifier
 */
function tagMessage(chatId, message, tag = 'default') {
  const messageId = message.id?._serialized || `msg_${Date.now()}`;
  
  taggedMessages.set(tag, {
    messageId,
    body: message.body || '',
    hasMedia: message.hasMedia,
    mediaType: message.type, // 'image', 'document', 'video', etc.
    sender: chatId,
    timestamp: new Date().toISOString(),
    originalMessage: message // Keep original for forwarding
  });

  return tag;
}

/**
 * Parse phone numbers from command
 * Expects format: "10 digit Indian numbers on new lines"
 * @param {string} numberString - Numbers separated by newlines
 * @returns {array} - Array of valid phone numbers with @c.us
 */
function parsePhoneNumbers(numberString) {
  const lines = numberString.split('\n').map(line => line.trim()).filter(line => line);
  const validNumbers = [];
  
  for (const line of lines) {
    // Remove any non-digit characters
    const cleaned = line.replace(/\D/g, '');
    
    // Accept 10 digit Indian numbers
    if (cleaned.length === 10) {
      validNumbers.push(`${cleaned}@c.us`);
    } else if (cleaned.length === 12 && cleaned.startsWith('91')) {
      // Remove Indian country code if present
      validNumbers.push(`${cleaned.slice(2)}@c.us`);
    }
  }
  
  return validNumbers;
}

/**
 * Start a forwarding session
 * Forwards tagged message to multiple numbers with delay
 * @param {object} client - WhatsApp Web client
 * @param {string} chatId - Source chat (for status messages)
 * @param {string} tag - Tag of message to forward
 * @param {array} phoneNumbers - Array of numbers to forward to (in @c.us format)
 * @param {number|object} delayConfig - Delay between messages (ms) or { minDelayMs, maxDelayMs }
 * @returns {object} - Session object
 */
async function startForwarding(client, chatId, tag, phoneNumbers, delayConfig = 2000) {
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
    chatId, // Where to send status updates
    message: tagged,
    phoneNumbers,
    total: phoneNumbers.length,
    processed: 0,
    failed: 0,
    failedNumbers: [],
    status: 'starting',
    startTime: Date.now(),
    statusMessageId: null,
    minDelayMs,
    maxDelayMs,
    lastDelayMs: null
  };

  forwardingSessions.set(sessionId, session);

  // Start forwarding in background
  forwardWithUpdates(client, session);

  return session;
}

/**
 * Forward message with progressive status updates
 * Edits the status message instead of sending new ones
 */
async function forwardWithUpdates(client, session) {
  const { message, phoneNumbers, chatId } = session;

  try {
    // Send initial status message
    const initialStatus = `📨 **Forwarding Started**\n` +
      `Total: ${session.total}\n` +
      `Processed: 0/${session.total}\n` +
      `Delay range: ${Math.round(session.minDelayMs / 1000)}-${Math.round(session.maxDelayMs / 1000)}s\n` +
      `Status: Starting...`;

    const statusMsg = await client.sendMessage(chatId, initialStatus);
    session.statusMessageId = statusMsg.id?._serialized;

    // Forward to each number
    for (let i = 0; i < phoneNumbers.length; i++) {
      const number = phoneNumbers[i];
      session.status = 'processing';
      let nextDelayMs = null;

      try {
        const recipientId = await resolveRecipientId(client, number);
        if (!recipientId) {
          throw new Error('No WhatsApp account for this number');
        }
        markRecipient(recipientId);

        // Forward the message
        if (message.hasMedia && message.originalMessage.hasMedia) {
          // Forward media message
          await message.originalMessage.forward(recipientId);
        } else {
          // Forward text message
          await client.sendMessage(recipientId, message.body);
        }

        session.processed += 1;
      } catch (error) {
        const displayNumber = (number || '').replace(/@c\.us$/i, '');
        console.error(`Failed to forward to ${displayNumber || number}:`, error.message);
        session.failed += 1;
        session.failedNumbers.push(displayNumber || number);
      }

      if (i < phoneNumbers.length - 1) {
        nextDelayMs = Math.floor(Math.random() * (session.maxDelayMs - session.minDelayMs + 1)) + session.minDelayMs;
        session.lastDelayMs = nextDelayMs;
      }

      // Update status message (edit instead of sending new)
      try {
        const progressPercent = Math.round((session.processed / session.total) * 100);
        const delayText = nextDelayMs
          ? `Delay (next): ${Math.round(nextDelayMs / 1000)}s\n`
          : '';
        const statusText = `📨 **Forwarding in Progress**\n` +
          `Total: ${session.total}\n` +
          `✅ Completed: ${session.processed}\n` +
          `❌ Failed: ${session.failed}\n` +
          `Progress: ${progressPercent}%\n` +
          delayText +
          `Status: Processing...`;

        if (session.statusMessageId) {
          const statusMsg = await client.getMessageById(session.statusMessageId);
          if (statusMsg) {
            await statusMsg.edit(statusText);
          }
        }
      } catch (editError) {
        // Status message edit failed, but continue forwarding
        console.warn('Could not update status message:', editError.message);
      }

      // Wait before next message (avoid ban)
      if (nextDelayMs) {
        await sleep(nextDelayMs);
      }
    }

    // Final status
    session.status = 'completed';
    const duration = Math.round((Date.now() - session.startTime) / 1000);
    const finalStatus = `📨 **Forwarding Completed**\n` +
      `Total: ${session.total}\n` +
      `✅ Completed: ${session.processed}\n` +
      `❌ Failed: ${session.failed}\n` +
      `Duration: ${duration}s\n` +
      `Delay range: ${Math.round(session.minDelayMs / 1000)}-${Math.round(session.maxDelayMs / 1000)}s\n` +
      `Status: Done!` +
      (session.failedNumbers.length > 0 
        ? `\n\nFailed numbers:\n${session.failedNumbers.join(', ')}`
        : '');

    if (session.statusMessageId) {
      try {
        const statusMsg = await client.getMessageById(session.statusMessageId);
        if (statusMsg) {
          await statusMsg.edit(finalStatus);
        }
      } catch (e) {
        // Fallback: send as new message
        await client.sendMessage(chatId, finalStatus);
      }
    }

  } catch (error) {
    console.error('Forwarding error:', error);
    session.status = 'error';
    await client.sendMessage(chatId, 
      `❌ Forwarding Error: ${error.message}`);
  }

  // Cleanup after completion
  setTimeout(() => forwardingSessions.delete(session.sessionId), 60000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get forwarding session status
 */
function getSessionStatus(sessionId) {
  return forwardingSessions.get(sessionId);
}

/**
 * Get all active sessions
 */
function getActiveSessions() {
  return Array.from(forwardingSessions.values());
}

/**
 * Cancel forwarding session
 */
function cancelSession(sessionId) {
  const session = forwardingSessions.get(sessionId);
  if (session) {
    session.status = 'cancelled';
    forwardingSessions.delete(sessionId);
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
