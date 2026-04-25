const fs = require('fs');
const path = require('path');
const pino = require('pino');
const baileys = require('@whiskeysockets/baileys');

const { downloadMediaMessage, normalizeMessageContent } = baileys;

const MEDIA_DOWNLOAD = {
  // 1 = enabled, 0 = disabled
  ENABLED: 0,
  BASE_DIR: path.join(__dirname, 'downloads'),
  ALLOWED_TYPES: new Set([
    'imageMessage',
    'videoMessage',
    'documentMessage',
    'audioMessage',
    'stickerMessage'
  ])
};

function isEnabled() {
  const env = process.env.MEDIA_DOWNLOAD_ENABLED;
  if (env === '1' || String(env).toLowerCase() === 'true') return true;
  if (env === '0' || String(env).toLowerCase() === 'false') return false;
  return MEDIA_DOWNLOAD.ENABLED === 1;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg')) return 'jpg';
  if (m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('gif')) return 'gif';
  if (m.includes('webp')) return 'webp';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('quicktime')) return 'mov';
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('msword')) return 'doc';
  if (m.includes('officedocument.wordprocessingml')) return 'docx';
  if (m.includes('officedocument.spreadsheetml')) return 'xlsx';
  if (m.includes('officedocument.presentationml')) return 'pptx';
  if (m.includes('mpeg')) return 'mp3';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('opus')) return 'opus';
  if (m.includes('aac')) return 'aac';
  if (m.includes('zip')) return 'zip';
  return 'bin';
}

function pickMediaNode(message) {
  const normalized = normalizeMessageContent(message?.message) || message?.message || {};
  const keys = [
    'documentMessage',
    'videoMessage',
    'imageMessage',
    'audioMessage',
    'stickerMessage'
  ];
  for (const key of keys) {
    if (normalized[key]) return { type: key, node: normalized[key] };
  }
  return null;
}

function buildFileName(message, media) {
  const id = String(message?.key?.id || Date.now());
  const ts = Date.now();
  const mime = media?.node?.mimetype || '';
  const ext = extFromMime(mime);
  const fromDoc = sanitizeFileName(media?.node?.fileName || '');
  if (fromDoc) return fromDoc;
  return `${ts}_${id}.${ext}`;
}

async function maybeDownloadIncomingMedia({ sock, message, chatId, logLine }) {
  if (!isEnabled()) return null;
  if (!sock || !message || !chatId) return null;

  const media = pickMediaNode(message);
  if (!media) return null;
  if (!MEDIA_DOWNLOAD.ALLOWED_TYPES.has(media.type)) return null;

  const dateDir = new Date().toISOString().slice(0, 10);
  const targetDir = path.join(MEDIA_DOWNLOAD.BASE_DIR, dateDir);
  ensureDir(targetDir);

  const fileName = buildFileName(message, media);
  const filePath = path.join(targetDir, fileName);

  const buffer = await downloadMediaMessage(
    message,
    'buffer',
    {},
    {
      logger: pino({ level: 'silent' }),
      reuploadRequest: sock.updateMediaMessage
    }
  );

  fs.writeFileSync(filePath, buffer);
  const size = Buffer.isBuffer(buffer) ? buffer.length : 0;
  if (typeof logLine === 'function') {
    logLine(`WA media saved type=${media.type} from=${chatId} bytes=${size} path=${filePath}`);
  }

  return { filePath, mediaType: media.type, size };
}

module.exports = {
  MEDIA_DOWNLOAD,
  isEnabled,
  maybeDownloadIncomingMedia
};

