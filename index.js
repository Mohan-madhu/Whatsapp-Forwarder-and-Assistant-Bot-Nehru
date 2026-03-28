const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const forwarder = require('./forwarder');

const FLOW_PATH = path.join(__dirname, 'data', 'flow.json');
const COURSES_PATH = path.join(__dirname, 'data', 'courses.json');
const SESSIONS_PATH = path.join(__dirname, 'data', 'sessions.json');
const LOG_PATH = path.join(__dirname, 'bot.log');

const flow = JSON.parse(fs.readFileSync(FLOW_PATH, 'utf-8'));
const courses = JSON.parse(fs.readFileSync(COURSES_PATH, 'utf-8'));

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line, 'utf-8');
    console.log(line.trimEnd());
  } catch (error) {
    console.error('Failed to write log:', error);
  }
}

// ====== BOT CONTROL SWITCHES ======
// 1 = ON, 0 = OFF
const CONFIG = {
  AUTO_MENU_ON_ANY_MESSAGE: 0,
  REQUIRE_COMMAND_PREFIX: 0,
  COMMAND_PREFIX: '!',
  ALLOW_SELF_CHAT: 1,
  SELF_CHAT_BYPASS_PREFIX: 1
};

// ====== SESSION TRIGGER KEYWORDS ======
const TRIGGER_KEYWORDS = ['hi', 'hello', 'hey'];
const INACTIVITY_TIMEOUT_MS = 60 * 1000; // 1 minute
const STOP_MESSAGE = '\n\n💬 Type STOP to pause replies';

// ====== RATE LIMIT SETTINGS ======
const RATE = {
  MAX_MESSAGES_PER_SECOND: 1,
  MAX_USERS_PER_SECOND: 1,
  MIN_DELAY_MS: 1000
};

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// ====== SESSION STORE (JSON) ======
let sessions = { sessions: {} };
let saveTimer = null;

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_PATH)) {
      sessions = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf-8'));
    }
  } catch (error) {
    console.error('Failed to load sessions.json:', error);
    sessions = { sessions: {} };
  }
}

function saveSessionsDebounced() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2));
    } catch (error) {
      console.error('Failed to save sessions.json:', error);
    }
  }, 250);
}

function getSession(chatId) {
  if (!sessions.sessions[chatId]) {
    sessions.sessions[chatId] = {
      currentMenu: 'main',
      menuStack: [],
      lastMessage: null,
      lastActive: new Date().toISOString(),
      lastActivityTime: Date.now(),
      courseContext: null,
      sessionActive: false,
      pauseUntil: null
    };
  }
  return sessions.sessions[chatId];
}

function setMenu(session, nextMenu) {
  if (session.currentMenu !== nextMenu) {
    session.menuStack = session.menuStack || [];
    session.menuStack.push(session.currentMenu);
    session.currentMenu = nextMenu;
  }
}

function goBack(session) {
  if (session.menuStack && session.menuStack.length > 0) {
    session.currentMenu = session.menuStack.pop();
    return true;
  }
  return false;
}

// ====== RATE LIMITED SEND QUEUE ======
const sendQueue = [];
let sending = false;
let perSecondCount = 0;
let perSecondUsers = new Set();
let lastSendAt = 0;
const sentMessageIds = new Set();

setInterval(() => {
  perSecondCount = 0;
  perSecondUsers = new Set();
}, 1000);

function canSend(chatId) {
  if (perSecondCount >= RATE.MAX_MESSAGES_PER_SECOND) return false;
  if (!perSecondUsers.has(chatId) && perSecondUsers.size >= RATE.MAX_USERS_PER_SECOND) return false;
  return true;
}

function recordSend(chatId) {
  perSecondCount += 1;
  perSecondUsers.add(chatId);
  lastSendAt = Date.now();
}

function splitText(text, maxLen = 1400) {
  if (!text || text.length <= maxLen) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    parts.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }
  if (remaining.length) parts.push(remaining);
  return parts;
}

function enqueueMessage(chatId, text) {
  if (chatId === 'status@broadcast') return;
  const parts = splitText(text);
  for (const part of parts) {
    sendQueue.push({ chatId, text: part });
  }
  processQueue();
}

async function processQueue() {
  if (sending) return;
  sending = true;
  while (sendQueue.length > 0) {
    const item = sendQueue[0];
    if (!canSend(item.chatId)) {
      await sleep(50);
      continue;
    }
    sendQueue.shift();
    try {
      const sent = await client.sendMessage(item.chatId, item.text);
      if (sent?.id?._serialized) {
        sentMessageIds.add(sent.id._serialized);
      }
      recordSend(item.chatId);
    } catch (error) {
      console.error('Failed to send message:', error);
    }
    const sinceLast = Date.now() - lastSendAt;
    if (sinceLast < RATE.MIN_DELAY_MS) {
      await sleep(RATE.MIN_DELAY_MS - sinceLast);
    }
  }
  sending = false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ====== MESSAGE ROUTING ======
function normalize(text) {
  return (text || '').trim();
}

function lower(text) {
  return normalize(text).toLowerCase();
}

function isGlobalCommand(msgLower) {
  return ['menu', '0', 'back', 'help', 'contact', 'apply', 'departments', 'schools'].includes(msgLower);
}

function isStartCommand(msgUpper) {
  return msgUpper === 'NEHRU-START';
}

function isEndCommand(msgUpper) {
  return msgUpper === 'NEHRU-END';
}

function handleCourseDetailOptions(msg, session) {
  const option = msg.toUpperCase();
  if (option === 'A') return '📘 Curriculum details will be shared by the department. Please contact admission office for the full syllabus.';
  if (option === 'B') return '🔬 Lab and facility details are available during campus visits or on request. Call: +91 887 000 5337.';
  if (option === 'C') return '📊 Placement statistics vary by program. For the latest placement details, call: +91 887 000 5337.';
  if (option === 'D') return flow.commands.apply;
  if (option === 'E') return 'BACK';
  return flow.errors.invalid;
}

function checkInactivity(session) {
  const now = Date.now();
  if (session.sessionActive && !session.pauseUntil) {
    const inactiveMs = now - (session.lastActivityTime || 0);
    if (inactiveMs > INACTIVITY_TIMEOUT_MS) {
      session.sessionActive = false;
      return true; // inactivity triggered
    }
  }
  return false;
}

function addStopMessage(response) {
  if (response && typeof response === 'string') {
    return response + STOP_MESSAGE;
  }
  return response;
}

function handleMessage(text, session) {
  const msg = normalize(text);
  const msgLower = lower(text);
  const msgUpper = msg.toUpperCase();
  session.lastActive = new Date().toISOString();
  session.lastActivityTime = Date.now();

  // Check if session timed out due to inactivity
  const timedOut = checkInactivity(session);
  if (timedOut) {
    return flow.sessionEnded || '✅ Session ended due to inactivity.\n\nType HI, HELLO, or HEY to start again.';
  }

  if (msgUpper === 'STOP') {
    session.sessionActive = false;
    session.currentMenu = 'main';
    session.menuStack = [];
    return flow.sessionStopped || '⏸️ Session paused.\n\nChat freely or type HI to resume using the bot.';
  }

  // Check for trigger keywords when inactive
  if (!session.sessionActive) {
    const isTrigger = TRIGGER_KEYWORDS.includes(msgLower);
    if (isTrigger) {
      session.sessionActive = true;
      session.currentMenu = 'main';
      session.menuStack = [];
      session.lastActivityTime = Date.now();
      return addStopMessage(flow.welcome);
    }
    // Session inactive and not a trigger keyword - don't respond
    return null;
  }

  if (isStartCommand(msgUpper)) {
    session.sessionActive = true;
    session.currentMenu = 'main';
    session.menuStack = [];
    return addStopMessage(flow.welcome);
  }

  if (isEndCommand(msgUpper)) {
    session.sessionActive = false;
    session.currentMenu = 'main';
    session.menuStack = [];
    return flow.sessionEnded || '✅ Session ended.\n\nType HI, HELLO, or HEY to start again.';
  }

  if (!session.lastMessage) {
    session.sessionActive = true;
    session.lastMessage = msg;
    session.currentMenu = 'main';
    session.menuStack = [];
    return addStopMessage(flow.welcome);
  }

  if (msgLower === 'menu') {
    session.currentMenu = 'main';
    session.menuStack = [];
    return addStopMessage(flow.welcome);
  }
  if (msgLower === 'help') return addStopMessage(flow.commands.help);
  if (msgLower === 'contact') return addStopMessage(flow.commands.contact);
  if (msgLower === 'apply') return addStopMessage(flow.commands.apply);
  if (msgLower === 'departments' || msgLower === 'schools') {
    session.currentMenu = 'departments';
    return addStopMessage(flow.departments.menu);
  }
  if (msgLower === 'back') {
    if (goBack(session)) {
      return addStopMessage(getMenuPrompt(session.currentMenu));
    }
    return addStopMessage(flow.welcome);
  }

  if (session.currentMenu.startsWith('courses_ug_school_')) {
    return handleUGSchoolMenu(msg, session);
  }

  let response;
  switch (session.currentMenu) {
    case 'main':
      response = handleMainMenu(msg, session);
      break;
    case 'about':
      response = handleAboutMenu(msg, session);
      break;
    case 'courses':
      response = handleCoursesMenu(msg, session);
      break;
    case 'courses_ug':
      response = handleUGMenu(msg, session);
      break;
    case 'courses_pg':
      response = handlePGMenu(msg, session);
      break;
    case 'courses_phd':
      response = handlePhdMenu(msg, session);
      break;
    case 'admission':
      response = handleAdmissionMenu(msg, session);
      break;
    case 'fees':
      response = handleFeesMenu(msg, session);
      break;
    case 'campus':
      response = handleCampusMenu(msg, session);
      break;
    case 'placements':
      response = handlePlacementsMenu(msg, session);
      break;
    case 'contact':
      response = handleContactMenu(msg, session);
      break;
    case 'brochure':
      response = handleBrochureMenu(msg, session);
      break;
    case 'counselor':
      response = flow.counselor.menu;
      break;
    case 'departments':
      response = handleDepartmentsMenu(msg, session);
      break;
    case 'faq':
      response = handleFaqMenu(msg, session);
      break;
    case 'course_detail':
      response = handleCourseDetailMenu(msg, session);
      break;
    default:
      // Invalid input while session active - don't respond with error
      response = flow.errors.invalid;
  }
  return addStopMessage(response);
}

function getMenuPrompt(menu) {
  if (menu.startsWith('courses_ug_school_')) {
    const schoolKey = menu.split('_').pop();
    return flow.courses.ug.schools[schoolKey]?.menu || flow.courses.ug.menu;
  }
  switch (menu) {
    case 'main': return flow.welcome;
    case 'about': return flow.about.menu;
    case 'courses': return flow.courses.menu;
    case 'courses_ug': return flow.courses.ug.menu;
    case 'courses_pg': return flow.courses.pg.menu;
    case 'courses_phd': return flow.courses.phd.menu;
    case 'admission': return flow.admission.menu;
    case 'fees': return flow.fees.menu;
    case 'campus': return flow.campus.menu;
    case 'placements': return flow.placements.menu;
    case 'contact': return flow.contact.menu;
    case 'brochure': return flow.brochure.menu;
    case 'departments': return flow.departments.menu;
    case 'faq': return flow.faq.menu;
    default: return flow.welcome;
  }
}

function handleMainMenu(msg, session) {
  switch (msg) {
    case '1':
      setMenu(session, 'about');
      return flow.about.menu;
    case '2':
      setMenu(session, 'courses');
      return flow.courses.menu;
    case '3':
      setMenu(session, 'admission');
      return flow.admission.menu;
    case '4':
      setMenu(session, 'fees');
      return flow.fees.menu;
    case '5':
      setMenu(session, 'campus');
      return flow.campus.menu;
    case '6':
      setMenu(session, 'placements');
      return flow.placements.menu;
    case '7':
      setMenu(session, 'contact');
      return flow.contact.menu;
    case '8':
      setMenu(session, 'brochure');
      return flow.brochure.menu;
    case '9':
      setMenu(session, 'counselor');
      return flow.counselor.menu;
    case '10':
      setMenu(session, 'counselor');
      return flow.counselor.menu;
    case '0':
      setMenu(session, 'faq');
      return flow.faq.menu;
    default:
      return null; // Silent fail on invalid input
  }
}

function handleAboutMenu(msg, session) {
  const key = msg.toUpperCase();
  if (key === 'E') {
    session.currentMenu = 'main';
    return flow.welcome;
  }
  if (flow.about[key]) return flow.about[key];
  return null; // Silent fail
}

function handleCoursesMenu(msg, session) {
  switch (msg) {
    case '1':
      setMenu(session, 'courses_ug');
      return flow.courses.ug.menu;
    case '2':
      setMenu(session, 'courses_pg');
      return flow.courses.pg.menu;
    case '3':
      setMenu(session, 'courses_phd');
      return flow.courses.phd.menu;
    case '0':
      session.currentMenu = 'main';
      return flow.welcome;
    default:
      return null; // Silent fail
  }
}

function handleUGMenu(msg, session) {
  if (msg === '0') {
    session.currentMenu = 'courses';
    return flow.courses.menu;
  }
  const school = flow.courses.ug.schools[msg];
  if (school) {
    setMenu(session, `courses_ug_school_${msg}`);
    return school.menu;
  }
  return null; // Silent fail
}

function handleUGSchoolMenu(msg, session) {
  const schoolKey = session.currentMenu.split('_').pop();
  if (msg === '0') {
    session.currentMenu = 'courses_ug';
    return flow.courses.ug.menu;
  }

  const schoolMap = {
    '1': 'computational',
    '2': 'commerce',
    '3': 'management',
    '4': 'life',
    '5': 'investigative',
    '6': 'creative',
    '7': 'liberal'
  };

  const schoolName = schoolMap[schoolKey];
  const course = courses.ug[schoolName]?.[msg];
  if (course) {
    session.courseContext = { level: 'ug', schoolKey, courseKey: msg };
    session.currentMenu = 'course_detail';
    return course.details || `${course.name}\n\n${courses.fallbackDetail}`;
  }

  return null; // Silent fail
}

function handlePGMenu(msg, session) {
  if (msg === '0') {
    session.currentMenu = 'courses';
    return flow.courses.menu;
  }
  const course = courses.pg[msg];
  if (course) {
    session.courseContext = { level: 'pg', courseKey: msg };
    session.currentMenu = 'course_detail';
    return course.details || `${course.name}\n\n${courses.fallbackDetail}`;
  }
  return null; // Silent fail
}

function handlePhdMenu(msg, session) {
  if (msg === '0') {
    session.currentMenu = 'courses';
    return flow.courses.menu;
  }
  const course = courses.phd[msg];
  if (course) {
    return `${course.name}\n\nFor Ph.D. Admissions:\n\ud83d\udcde Call: +91 887 000 5337\n\ud83d\udce7 Email: nascoffice@nehrucolleges.com\n\nType 0 for Programme Menu`;
  }
  return null; // Silent fail
}

function handleCourseDetailMenu(msg, session) {
  const response = handleCourseDetailOptions(msg, session);
  if (response === 'BACK') {
    if (session.courseContext?.level === 'ug') {
      session.currentMenu = `courses_ug_school_${session.courseContext.schoolKey}`;
      return getMenuPrompt(session.currentMenu);
    }
    if (session.courseContext?.level === 'pg') {
      session.currentMenu = 'courses_pg';
      return flow.courses.pg.menu;
    }
    session.currentMenu = 'courses';
    return flow.courses.menu;
  }
  return response;
}

function handleAdmissionMenu(msg, session) {
  const key = msg.toUpperCase();
  if (key === 'F') {
    session.currentMenu = 'main';
    return flow.welcome;
  }
  if (flow.admission[key]) return flow.admission[key];
  return null; // Silent fail
}

function handleFeesMenu(msg, session) {
  if (msg === '0') {
    session.currentMenu = 'main';
    return flow.welcome;
  }
  if (flow.fees[msg]) return flow.fees[msg];
  if (['2', '4', '5', '6'].includes(msg)) {
    return 'For this information, please contact the Admission Office at +91 887 000 5337 or email nascoffice@nehrucolleges.com. Type 0 for Fees Menu.';
  }
  return null; // Silent fail
}

function handleCampusMenu(msg, session) {
  if (msg === '0') {
    session.currentMenu = 'main';
    return flow.welcome;
  }
  if (flow.campus[msg]) return flow.campus[msg];
  if (['2', '3', '5', '7', '8', '9'].includes(msg)) {
    return 'More campus facility details are available on request. Call: +91 887 000 5337 or visit https://nasccbe.ac.in. Type 0 for Facilities Menu.';
  }
  return null; // Silent fail
}

function handlePlacementsMenu(msg, session) {
  if (msg === '0') {
    session.currentMenu = 'main';
    return flow.welcome;
  }
  if (flow.placements[msg]) return flow.placements[msg];
  if (['4', '5', '6', '7'].includes(msg)) {
    return 'Placement support details are available through the Placement Cell. Call: +91 887 000 5337. Type 0 for Placements Menu.';
  }
  return null; // Silent fail
}

function handleContactMenu(msg, session) {
  const key = msg.toUpperCase();
  if (key === 'E') {
    session.currentMenu = 'main';
    return flow.welcome;
  }
  if (flow.contact[key]) return flow.contact[key];
  if (key === 'C') {
    session.currentMenu = 'counselor';
    return flow.counselor.menu;
  }
  if (key === 'D') return 'Department contact numbers can be shared on request. Please call +91 887 000 5337.';
  return null; // Silent fail
}

function handleDepartmentsMenu(msg, session) {
  if (msg === '0') {
    session.currentMenu = 'main';
    return flow.welcome;
  }
  if (flow.departments[msg]) return flow.departments[msg];
  return null; // Silent fail
}

function handleBrochureMenu(msg, session) {
  if (msg === '0') {
    session.currentMenu = 'main';
    return flow.welcome;
  }
  const num = Number(msg);
  if (!Number.isNaN(num) && num >= 1 && num <= 10) {
    return flow.brochure.sent;
  }
  return null; // Silent fail
}

function handleFaqMenu(msg, session) {
  if (msg === '0') {
    session.currentMenu = 'main';
    return flow.welcome;
  }
  if (flow.faq[msg]) return flow.faq[msg];
  if (['6', '7', '8'].includes(msg)) {
    return 'For these FAQs, please contact the Admission Office at +91 887 000 5337 or visit https://nasccbe.ac.in. Type 0 for FAQ Menu.';
  }
  return null; // Silent fail
}

// ====== WHATSAPP EVENTS ======
loadSessions();

/**
 * Handle forwarding commands
 * WB-TAG: Tag the message you're replying to
 * WB-FORWARD: Forward tagged message to list of numbers
 */
function handleForwarderCommand(message, messageBody) {
  const command = messageBody.toUpperCase().trim();
  const chatId = message.from;

  // WB-TAG: Tag current message for forwarding
  if (command === 'WB-TAG' || command.startsWith('WB-TAG ')) {
    const tag = command.slice(7).trim() || 'default';
    
    // Check if replying to a message
    if (message.hasQuotedMsg) {
      message.getQuotedMessage().then((quotedMsg) => {
        try {
          if (quotedMsg.fromMe) {
            enqueueMessage(chatId,
              '❌ Please reply to a user message to tag it (not a bot menu).');
            return;
          }
          const tagName = forwarder.tagMessage(chatId, quotedMsg, tag);
          const response = `✅ Message tagged as "${tagName}" for forwarding.\n\n` +
            `Now send:\n` +
            `WB-FORWARD\n` +
            `[10-digit numbers, one per line]\n\n` +
            `Example:\n` +
            `WB-FORWARD\n` +
            `9876543210\n` +
            `9123456789`;
          enqueueMessage(chatId, response);
        } catch (error) {
          enqueueMessage(chatId, `❌ Error tagging message: ${error.message}`);
        }
      });
    } else {
      enqueueMessage(chatId, 
        `❌ Please reply to a message with WB-TAG to tag it for forwarding.`);
    }
    return true;
  }

  // WB-FORWARD: Forward tagged message
  if (command.startsWith('WB-FORWARD')) {
    const lines = messageBody.split('\n');
    const numberLines = lines.slice(1).join('\n').trim();

    if (!numberLines) {
      enqueueMessage(chatId,
        `❌ No numbers provided.\n\n` +
        `Format:\n` +
        `WB-FORWARD\n` +
        `9876543210\n` +
        `9123456789`);
      return true;
    }

    try {
      const phoneNumbers = forwarder.parsePhoneNumbers(numberLines);

      if (phoneNumbers.length === 0) {
        enqueueMessage(chatId,
          `❌ No valid 10-digit Indian numbers found.\n\n` +
          `Provided: ${numberLines.split('\n').length} lines`);
        return true;
      }

      // Get tagged message (use 'default' or specified tag)
      const tag = 'default';
      const tagged = forwarder.taggedMessages.get(tag);

      if (!tagged) {
        enqueueMessage(chatId,
          `❌ No message tagged yet. Reply to a message with WB-TAG first.`);
        return true;
      }

      // Start forwarding
      forwarder.startForwarding(client, chatId, tag, phoneNumbers, { minDelayMs: 4000, maxDelayMs: 10000 })
        .then((session) => {
          const confirmMsg = `🚀 Forwarding started!\n\n` +
            `Session: ${session.sessionId}\n` +
            `Recipients: ${session.total}\n` +
            `Delay: 4-10 seconds between messages\n\n` +
            `Status will update below...`;
          enqueueMessage(chatId, confirmMsg);
        })
        .catch((error) => {
          enqueueMessage(chatId, `❌ Failed to start forwarding: ${error.message}`);
        });
    } catch (error) {
      enqueueMessage(chatId, `❌ Error: ${error.message}`);
    }

    return true;
  }

  // WB-STATUS: Check forwarding status
  if (command.startsWith('WB-STATUS')) {
    const sessions = forwarder.getActiveSessions();
    if (sessions.length === 0) {
      enqueueMessage(chatId, '📭 No active forwarding sessions.');
      return true;
    }

    let statusText = '📊 **Active Forwarding Sessions**\n\n';
    for (const session of sessions) {
      statusText += `Session: ${session.sessionId}\n` +
        `Status: ${session.status}\n` +
        `Progress: ${session.processed}/${session.total}\n` +
        `Failed: ${session.failed}\n\n`;
    }
    enqueueMessage(chatId, statusText);
    return true;
  }

  return false;
}

client.on('qr', (qr) => {
  console.log('Scan this QR with WhatsApp to connect:');
  qrcode.generate(qr, { small: true });
  logLine('QR generated for login.');
});

client.on('ready', () => {
  console.log('WhatsApp bot is ready.');
  logLine('Bot ready.');
});

client.on('message_create', (message) => {
  if (!message.fromMe) return;

  const isSelfChat = message.to && message.to === message.from;
  const body = typeof message.body === 'string' ? message.body : '';
  const isForwarderCommand = /^\s*WB-(TAG|FORWARD|STATUS)\b/i.test(body);

  // Handle admin forwarding commands directly from self-chat outgoing messages.
  if (isSelfChat && isForwarderCommand) {
    try {
      handleForwarderCommand(message, body);
    } catch (error) {
      console.error('Error handling self-chat forwarder command:', error);
    }
  }

  // Mark all outgoing messages so the 'message' listener can ignore duplicates.
  if (message.id?._serialized) {
    sentMessageIds.add(message.id._serialized);
  }
});

client.on('message', async (message) => {
  try {
    const fromId = String(message.from || '');
    const toId = String(message.to || '');
    const isSelfChat = message.fromMe && toId && toId === fromId;

    // Ignore status/broadcast traffic completely.
    if (fromId === 'status@broadcast' || toId === 'status@broadcast') return;
    if (fromId.endsWith('@broadcast') || toId.endsWith('@broadcast')) return;
    if (message.isStatus === true || message.broadcast === true) return;

    if (fromId.includes('@g.us')) return; // ignore groups
    if (message.fromMe && !isSelfChat) return; // only allow self-chat from your own messages
    if (message.id?._serialized && sentMessageIds.has(message.id._serialized)) {
      sentMessageIds.delete(message.id._serialized);
      return;
    }
    if (message.fromMe && CONFIG.ALLOW_SELF_CHAT !== 1) return;
    const chatId = message.from;
    if (forwarder.isRecentlyForwarded(chatId)) return;
    const messageType = String(message.type || '').toLowerCase();
    if (messageType !== 'chat') {
      logLine(`IGNORED non-text from=${chatId} type=${messageType || 'unknown'}`);
      return;
    }
    const session = getSession(chatId);
    let incoming = typeof message.body === 'string' ? message.body : '';
    logLine(`IN from=${chatId} fromMe=${message.fromMe} body=${JSON.stringify(incoming)}`);
    
    // Handle forwarder commands first (WB-TAG, WB-FORWARD, etc.)
    const trimmed = incoming.trim();
    const forwarderMatch = /^\s*WB-(TAG|FORWARD|STATUS)\b/i.test(incoming);
    if (forwarderMatch) {
      const isSelfChatMessage = message.fromMe === true && message.to === message.from;
      if (!isSelfChatMessage) {
        logLine(`IGNORED WB command from non-admin chat=${chatId}`);
        return;
      }
      const handled = handleForwarderCommand(message, incoming);
      if (handled) return;
    }

    const isSelfChatMessage = message.fromMe === true;
    const prefix = CONFIG.COMMAND_PREFIX;
    const msgUpper = trimmed.toUpperCase();
    const isStartEnd = isStartCommand(msgUpper) || isEndCommand(msgUpper);
    const prefixRequired = CONFIG.REQUIRE_COMMAND_PREFIX === 1
      && !(isSelfChatMessage && CONFIG.SELF_CHAT_BYPASS_PREFIX === 1)
      && !session.sessionActive
      && !isStartEnd;
    if (prefixRequired) {
      if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return;
      incoming = trimmed.slice(prefix.length).trim();
      if (!incoming) incoming = 'MENU';
    }
    const response = handleMessage(incoming, session);
    session.lastMessage = message.body;
    saveSessionsDebounced();
    if (response != null) {
      logLine(`OUT to=${chatId} response=${JSON.stringify(response)}`);
      enqueueMessage(chatId, response);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    logLine(`ERROR ${error?.stack || error?.message || String(error)}`);
    enqueueMessage(message.from, flow.errors.technical);
  }
});

client.initialize();
