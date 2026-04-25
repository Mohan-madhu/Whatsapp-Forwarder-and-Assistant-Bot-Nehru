const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  jidNormalizedUser,
  getContentType
} = baileys;
const forwarder = require('./forwarder');
const mediaDownloader = require('./media-downloader');

const FLOW_PATH = path.join(__dirname, 'data', 'flow.json');
const COURSES_PATH = path.join(__dirname, 'data', 'courses.json');
const SESSIONS_PATH = path.join(__dirname, 'data', 'sessions.json');
const LOG_PATH = path.join(__dirname, 'bot.log');
const AUTH_PATH = path.join(__dirname, 'auth_info_baileys');

const flow = JSON.parse(fs.readFileSync(FLOW_PATH, 'utf-8'));
const courses = JSON.parse(fs.readFileSync(COURSES_PATH, 'utf-8'));

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

function shouldLogMessage(message) {
  return (
    message.startsWith('IN ') ||
    message.startsWith('OUT ') ||
    message.startsWith('CONN ') ||
    message.startsWith('WA ') ||
    message.startsWith('ERR ') ||
    message.startsWith('IGNORED ')
  );
}

function logLine(message) {
  if (!shouldLogMessage(message)) return;
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line, 'utf-8');
    if (process.stdout.writable && !process.stdout.destroyed) {
      process.stdout.write(line);
    }
  } catch (error) {
    console.error('Failed to write log:', error);
  }
}

function errorMessage(error) {
  if (error && typeof error === 'object') {
    return error.stack || error.message || JSON.stringify(error);
  }
  return String(error);
}

function getDisconnectStatusCode(error) {
  return error?.output?.statusCode || new Boom(error).output?.statusCode;
}

function shouldReconnectAfterClose(statusCode) {
  if (!statusCode) return true;

  const noRetryCodes = new Set([
    DisconnectReason.loggedOut,
    DisconnectReason.connectionReplaced,
    DisconnectReason.badSession,
    DisconnectReason.multideviceMismatch,
    405
  ]);

  return !noRetryCodes.has(statusCode);
}

process.on('unhandledRejection', (reason) => {
  logLine(`ERR unhandledRejection ${errorMessage(reason)}`);
});

process.on('uncaughtException', (error) => {
  logLine(`ERR uncaughtException ${errorMessage(error)}`);
  console.error('Uncaught exception:', error);
});

// ====== BOT CONTROL SWITCHES ======
// 1 = ON, 0 = OFF
const CONFIG = {
  AUTO_MENU_ON_ANY_MESSAGE: 0,
  REQUIRE_COMMAND_PREFIX: 0,
  COMMAND_PREFIX: '!',
  ALLOW_SELF_CHAT: 1,
  SELF_CHAT_BYPASS_PREFIX: 1,
  OWNER_NUMBERS: (process.env.OWNER_NUMBERS || '')
    .split(',')
    .map((number) => number.replace(/\D/g, ''))
    .filter(Boolean)
};

// ====== SESSION TRIGGER KEYWORDS ======
const TRIGGER_KEYWORDS = ['hi', 'hello', 'hey'];
const INACTIVITY_TIMEOUT_MS = 60 * 1000; // 1 minute
const STOP_MESSAGE = '\n\n💬 Type STOP to pause replies';

// ====== RATE LIMIT SETTINGS ======
const RATE = {
  REPLY_DELAY_MS: 1000,
  WINDOW_MS: 1000,
  MAX_MESSAGES_PER_WINDOW: 3,
  MAX_USERS_PER_WINDOW: 2
};

let sock = null;
let myJid = '';
let isConnecting = false;
let reconnectTimer = null;
let lastCredsLogAt = 0;
const contactLabels = new Map(); // chatId -> best known display name

function jidToPhoneNumber(jid) {
  return String(jid || '').split('@')[0].replace(/\D/g, '');
}

function isOwnerNumber(jid) {
  const digits = jidToPhoneNumber(jid);
  if (!digits) return false;

  return CONFIG.OWNER_NUMBERS.some((owner) => {
    const normalizedOwner = String(owner || '').replace(/\D/g, '');
    return digits === normalizedOwner || digits.endsWith(normalizedOwner) || normalizedOwner.endsWith(digits);
  });
}

function isAdminMessage({ chatId, fromMe, isSelfChat }) {
  if (fromMe && isSelfChat && CONFIG.ALLOW_SELF_CHAT === 1) return true;
  return isOwnerNumber(chatId);
}

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
const sendQueuesByChat = new Map(); // chatId -> text parts[]
const activeChats = []; // round-robin order
let sending = false;
const recentSends = []; // { chatId, sentAt }
const sentMessageIds = new Set();

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
  if (!sendQueuesByChat.has(chatId)) {
    sendQueuesByChat.set(chatId, []);
    activeChats.push(chatId);
  }
  const chatQueue = sendQueuesByChat.get(chatId);
  for (const part of parts) {
    chatQueue.push({ text: part, queuedAt: Date.now() });
  }
  processQueue();
}

function hasPendingMessages() {
  return activeChats.length > 0;
}

function pruneRecentSends(now = Date.now()) {
  while (recentSends.length > 0 && now - recentSends[0].sentAt >= RATE.WINDOW_MS) {
    recentSends.shift();
  }
}

function getRateState(now = Date.now()) {
  pruneRecentSends(now);
  return {
    messageCount: recentSends.length,
    users: new Set(recentSends.map((item) => item.chatId))
  };
}

function getWindowWaitMs(now = Date.now()) {
  pruneRecentSends(now);
  if (recentSends.length < RATE.MAX_MESSAGES_PER_WINDOW) return 0;
  return Math.max(0, RATE.WINDOW_MS - (now - recentSends[0].sentAt));
}

function nextQueueItemRoundRobin(rateState, now = Date.now()) {
  if (activeChats.length === 0) return null;

  let attempts = 0;
  let soonestEligibleAt = null;
  while (attempts < activeChats.length) {
    // Move pointer fairly across active chats.
    if (nextQueueItemRoundRobin._idx == null || nextQueueItemRoundRobin._idx >= activeChats.length) {
      nextQueueItemRoundRobin._idx = 0;
    }
    const idx = nextQueueItemRoundRobin._idx;
    const chatId = activeChats[idx];
    const queue = sendQueuesByChat.get(chatId) || [];

    // Advance pointer for next round before returning.
    nextQueueItemRoundRobin._idx = (idx + 1) % Math.max(activeChats.length, 1);

    if (queue.length > 0) {
      const nextQueued = queue[0];
      const eligibleAt = nextQueued.queuedAt + RATE.REPLY_DELAY_MS;
      if (eligibleAt > now) {
        soonestEligibleAt = soonestEligibleAt == null ? eligibleAt : Math.min(soonestEligibleAt, eligibleAt);
        attempts += 1;
        continue;
      }

      const userAllowed = rateState.users.has(chatId) || rateState.users.size < RATE.MAX_USERS_PER_WINDOW;
      if (!userAllowed) {
        attempts += 1;
        continue;
      }

      const item = queue.shift();
      if (queue.length === 0) {
        sendQueuesByChat.delete(chatId);
        const removedAt = activeChats.indexOf(chatId);
        if (removedAt >= 0) {
          activeChats.splice(removedAt, 1);
          if (activeChats.length === 0) {
            nextQueueItemRoundRobin._idx = 0;
          } else if (nextQueueItemRoundRobin._idx > removedAt) {
            nextQueueItemRoundRobin._idx -= 1;
          } else if (nextQueueItemRoundRobin._idx >= activeChats.length) {
            nextQueueItemRoundRobin._idx = 0;
          }
        }
      }
      return { chatId, text: item.text };
    }

    // Defensive cleanup if queue got empty unexpectedly.
    sendQueuesByChat.delete(chatId);
    activeChats.splice(idx, 1);
    if (activeChats.length === 0) {
      nextQueueItemRoundRobin._idx = 0;
      return null;
    }
    if (idx >= activeChats.length) {
      nextQueueItemRoundRobin._idx = 0;
    } else {
      nextQueueItemRoundRobin._idx = idx;
    }
    attempts += 1;
  }

  if (soonestEligibleAt != null) {
    return { waitMs: Math.max(0, soonestEligibleAt - now) };
  }

  return { waitMs: RATE.WINDOW_MS };
}

async function processQueue() {
  if (sending) return;
  sending = true;
  while (hasPendingMessages()) {
    if (!sock) {
      await sleep(200);
      continue;
    }

    const now = Date.now();
    const windowWaitMs = getWindowWaitMs(now);
    if (windowWaitMs > 0) {
      await sleep(windowWaitMs);
      continue;
    }

    const rateState = getRateState(Date.now());
    const item = nextQueueItemRoundRobin(rateState, Date.now());
    if (!item) {
      await sleep(50);
      continue;
    }
    if (item.waitMs != null) {
      await sleep(Math.max(50, item.waitMs));
      continue;
    }

    try {
      const sent = await sock.sendMessage(item.chatId, { text: item.text });
      if (sent?.key?.id) {
        sentMessageIds.add(sent.key.id);
      }
      recentSends.push({ chatId: item.chatId, sentAt: Date.now() });
    } catch (error) {
      logLine(`ERR send failed to=${item.chatId} message=${error?.message || String(error)}`);
      recentSends.push({ chatId: item.chatId, sentAt: Date.now() });
    }
  }
  sending = false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractReadableId(chatId) {
  const jid = String(chatId || '');
  if (jid.endsWith('@s.whatsapp.net')) return jid.replace('@s.whatsapp.net', '');
  if (jid.endsWith('@c.us')) return jid.replace('@c.us', '');
  if (jid.endsWith('@lid')) return jid.replace('@lid', '');
  return jid;
}

function getChatLabel(chatId) {
  const name = contactLabels.get(chatId);
  const id = extractReadableId(chatId);
  return name ? `${name} <${id}>` : id;
}

function updateContactLabel(chatId, message) {
  const pushName = String(message?.pushName || '').trim();
  if (pushName) {
    contactLabels.set(chatId, pushName);
  }
}

// ====== MESSAGE ROUTING ======
function normalize(text) {
  return (text || '').trim();
}

function lower(text) {
  return normalize(text).toLowerCase();
}

function isStartCommand(msgUpper) {
  return msgUpper === 'NEHRU-START';
}

function isEndCommand(msgUpper) {
  return msgUpper === 'NEHRU-END';
}

function handleCourseDetailOptions(msg) {
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
      return true;
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

  if (!session.sessionActive) {
    const isTrigger = TRIGGER_KEYWORDS.includes(msgLower);
    if (isTrigger) {
      session.sessionActive = true;
      session.currentMenu = 'main';
      session.menuStack = [];
      session.lastActivityTime = Date.now();
      return addStopMessage(flow.welcome);
    }
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
      return null;
  }
}

function handleAboutMenu(msg, session) {
  const key = msg.toUpperCase();
  if (key === 'E') {
    session.currentMenu = 'main';
    return flow.welcome;
  }
  if (flow.about[key]) return flow.about[key];
  return null;
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
      return null;
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
  return null;
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

  return null;
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
  return null;
}

function handlePhdMenu(msg, session) {
  if (msg === '0') {
    session.currentMenu = 'courses';
    return flow.courses.menu;
  }
  const course = courses.phd[msg];
  if (course) {
    return `${course.name}\n\nFor Ph.D. Admissions:\n📞 Call: +91 887 000 5337\n📧 Email: nascoffice@nehrucolleges.com\n\nType 0 for Programme Menu`;
  }
  return null;
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
  return null;
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
  return null;
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
  return null;
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
  return null;
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
  return null;
}

function handleDepartmentsMenu(msg, session) {
  if (msg === '0') {
    session.currentMenu = 'main';
    return flow.welcome;
  }
  if (flow.departments[msg]) return flow.departments[msg];
  return null;
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
  return null;
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
  return null;
}

function getPrimaryMessageNode(message) {
  const m = message?.message || {};
  const key = Object.keys(m)[0];
  if (!key) return null;
  return m[key];
}

function getContextInfo(message) {
  const node = getPrimaryMessageNode(message);
  return node?.contextInfo || null;
}

function getQuotedMessage(message) {
  const context = getContextInfo(message);
  if (!context || !context.quotedMessage) return null;
  const participant = context.participant || context.remoteJid || '';
  return {
    key: {
      remoteJid: message?.key?.remoteJid,
      fromMe: !!participant && jidNormalizedUser(participant) === myJid,
      id: context.stanzaId || `quoted_${Date.now()}`,
      participant: participant || undefined
    },
    message: context.quotedMessage
  };
}

function extractMessageText(message) {
  const m = message?.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  );
}

/**
 * Handle forwarding commands
 * WB-TAG: Tag the message you're replying to
 * WB-FORWARD: Forward tagged message to list of numbers
 */
function handleForwarderCommand(message, messageBody, isSelfChatCommand) {
  const command = messageBody.toUpperCase().trim();
  const chatId = message.key.remoteJid;

  if (command === 'WB-TAG' || command.startsWith('WB-TAG ')) {
    const tag = command.slice(7).trim() || 'default';
    const quotedMsg = getQuotedMessage(message);

    if (quotedMsg) {
      try {
        if (quotedMsg.key?.fromMe && !isSelfChatCommand) {
          enqueueMessage(chatId, '❌ Please reply to a user message to tag it (not a bot menu).');
          return true;
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
    } else {
      enqueueMessage(chatId, '❌ Please reply to a message with WB-TAG to tag it for forwarding.');
    }
    return true;
  }

  if (command.startsWith('WB-FORWARD')) {
    const lines = messageBody.split('\n');
    const numberLines = lines.slice(1).join('\n').trim();

    if (!numberLines) {
      enqueueMessage(chatId, `❌ No numbers provided.\n\nFormat:\nWB-FORWARD\n9876543210\n9123456789`);
      return true;
    }

    try {
      const phoneNumbers = forwarder.parsePhoneNumbers(numberLines);

      if (phoneNumbers.length === 0) {
        enqueueMessage(chatId, `❌ No valid 10-digit Indian numbers found.\n\nProvided: ${numberLines.split('\n').length} lines`);
        return true;
      }

      const tag = 'default';
      const tagged = forwarder.taggedMessages.get(tag);
      if (!tagged) {
        enqueueMessage(chatId, '❌ No message tagged yet. Reply to a message with WB-TAG first.');
        return true;
      }

      forwarder.startForwarding(sock, chatId, tag, phoneNumbers, { minDelayMs: 4000, maxDelayMs: 10000 })
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

  if (command.startsWith('WB-STATUS')) {
    const list = forwarder.getActiveSessions();
    if (list.length === 0) {
      enqueueMessage(chatId, '📭 No active forwarding sessions.');
      return true;
    }

    let statusText = '📊 *Active Forwarding Sessions*\n\n';
    for (const session of list) {
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

async function handleIncomingMessage(message) {
  try {
    const chatId = String(message?.key?.remoteJid || '');
    if (!chatId) return;

    const fromMe = message?.key?.fromMe === true;
    const isSelfChat = fromMe && !!myJid && jidNormalizedUser(chatId) === myJid;
    const messageId = message?.key?.id || '';

    if (chatId === 'status@broadcast' || chatId.endsWith('@broadcast')) return;
    if (chatId.endsWith('@g.us')) return;
    if (messageId && sentMessageIds.has(messageId)) {
      sentMessageIds.delete(messageId);
      return;
    }
    if (fromMe && !isSelfChat) return;
    if (fromMe && CONFIG.ALLOW_SELF_CHAT !== 1) return;
    if (forwarder.isRecentlyForwarded(chatId)) return;

    // Optional local media archive (documents/videos/images/etc.)
    await mediaDownloader.maybeDownloadIncomingMedia({
      sock,
      message,
      chatId,
      logLine
    });

    const incoming = extractMessageText(message);
    const messageType = getContentType(message?.message || {}) || 'unknown';
    updateContactLabel(chatId, message);
    const fromLabel = getChatLabel(chatId);
    if (!incoming) {
      logLine(`IGNORED non-text from=${fromLabel} rawJid=${chatId} type=${messageType}`);
      return;
    }

    const session = getSession(chatId);
    logLine(`IN from=${fromLabel} rawJid=${chatId} fromMe=${fromMe} body=${JSON.stringify(incoming)}`);

    const trimmed = incoming.trim();
    const forwarderMatch = /^\s*WB-(TAG|FORWARD|STATUS)\b/i.test(trimmed);
    if (forwarderMatch) {
      if (!isAdminMessage({ chatId, fromMe, isSelfChat })) {
        logLine(`IGNORED non-admin command from=${fromLabel} rawJid=${chatId}`);
        enqueueMessage(chatId, '❌ This command is only available to the bot admin.');
        return;
      }

      const handled = handleForwarderCommand(message, incoming, isSelfChat);
      if (handled) return;
    }

    let content = incoming;
    const prefix = CONFIG.COMMAND_PREFIX;
    const msgUpper = trimmed.toUpperCase();
    const isStartEnd = isStartCommand(msgUpper) || isEndCommand(msgUpper);
    const prefixRequired = CONFIG.REQUIRE_COMMAND_PREFIX === 1
      && !(fromMe && CONFIG.SELF_CHAT_BYPASS_PREFIX === 1)
      && !session.sessionActive
      && !isStartEnd;

    if (prefixRequired) {
      if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return;
      content = trimmed.slice(prefix.length).trim();
      if (!content) content = 'MENU';
    }

    const response = handleMessage(content, session);
    session.lastMessage = incoming;
    saveSessionsDebounced();

    if (response != null) {
      const toLabel = getChatLabel(chatId);
      logLine(`OUT to=${toLabel} rawJid=${chatId} response=${JSON.stringify(response)}`);
      enqueueMessage(chatId, response);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    logLine(`ERR handler ${error?.stack || error?.message || String(error)}`);
    const chatId = message?.key?.remoteJid;
    if (chatId) enqueueMessage(chatId, flow.errors.technical);
  }
}

async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logLine(`WA version=${version.join('.')} isLatest=${isLatest}`);

    sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: 'error' }),
      browser: Browsers.windows('NASC-Baileys-Bot'),
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\nScan this QR with WhatsApp Linked Devices:\n');
        qrcode.generate(qr, { small: true });
        logLine('CONN qr generated');
      }

      if (connection === 'connecting') {
        logLine('CONN connecting');
      }

      if (connection === 'open') {
        myJid = jidNormalizedUser(sock?.user?.id || '');
        logLine(`CONN open jid=${myJid}`);
        return;
      }

      if (connection === 'close') {
        const statusCode = getDisconnectStatusCode(lastDisconnect?.error);
        // Some close codes need a fresh QR or mean another socket replaced this one.
        const shouldReconnect = shouldReconnectAfterClose(statusCode);
        logLine(`CONN closed code=${statusCode || 'unknown'} reconnect=${shouldReconnect}`);

        if (shouldReconnect) {
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectToWhatsApp().catch((error) => {
              logLine(`ERR reconnect ${errorMessage(error)}`);
            });
          }, 2000);
        } else {
          if (statusCode === DisconnectReason.connectionReplaced) {
            logLine('WA connection replaced; stop duplicate bot process if one is running');
          } else if (statusCode === 405 || statusCode === DisconnectReason.badSession) {
            logLine('WA pairing/session failed; run npm run reset-auth and rescan');
          } else if (statusCode === DisconnectReason.multideviceMismatch) {
            logLine('WA multidevice mismatch; run npm run reset-auth and rescan');
          } else {
            logLine('WA logged out; run npm run reset-auth and reconnect');
          }
        }
      }
    });

    sock.ev.on('creds.update', async (...args) => {
      try {
        await saveCreds(...args);
      } catch (error) {
        logLine(`ERR saveCreds ${errorMessage(error)}`);
        return;
      }

      const now = Date.now();
      if (now - lastCredsLogAt > 30000) {
        lastCredsLogAt = now;
        logLine('WA creds updated');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        for (const message of messages || []) {
          await handleIncomingMessage(message);
        }
      } catch (error) {
        logLine(`ERR messages.upsert ${errorMessage(error)}`);
      }
    });
  } finally {
    isConnecting = false;
  }
}

loadSessions();
connectToWhatsApp().catch((error) => {
  console.error('Failed to start Baileys bot:', error);
  logLine(`ERR startup ${errorMessage(error)}`);
});
