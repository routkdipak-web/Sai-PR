const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const admin = require('firebase-admin');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json({ limit: '25mb' }));
const port = process.env.PORT || 3000;

// Frontend dashboard (public/index.html)
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------

// WhatsApp login yahan save hota hai. Render me Disk attach karo to
// AUTH_DIR=/app/auth_info_baileys set karo, taaki restart par QR dobara na scan karna pade.
const AUTH_DIR = process.env.AUTH_DIR || './auth_info_baileys';

// Sirf in groups ko sunega (group ka naam, comma se alag).
// Render Environment me: ALLOWED_GROUPS=Media track
// Khali chhodoge to saare groups sune jayenge.
const ALLOWED_GROUPS = (process.env.ALLOWED_GROUPS || 'Media track')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const TARGET_COMPANIES = [
  'AM/NS India', 'Tata Steel', 'JSW Steel', 'RSP', 'SAIL',
  'JSL', 'JSPL', 'NALCO', 'Vedanta', 'Aditya Aluminium',
  'Maithan', 'MCL', 'Hindalco', 'Visa Steel', 'CIL'
];

// Firestore ek document max ~1 MB leta hai, isliye badi image Firestore me nahi jayegi
const MAX_IMAGE_CHARS_FOR_FIRESTORE = 900000;

// ---------------------------------------------------------------
// STORAGE
// ---------------------------------------------------------------

// In-memory feed (dashboard polling ke liye)
let liveFeedStorage = [];

// Firebase Admin
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('Firebase Admin connected successfully');
  } catch (e) {
    console.error('Firebase Admin Error:', e.message);
  }
}
const db = admin.apps.length ? admin.firestore() : null;

async function saveEntry(entry) {
  liveFeedStorage.unshift(entry);
  if (liveFeedStorage.length > 300) liveFeedStorage.pop();

  if (db) {
    try {
      const copy = { ...entry };
      delete copy.id;
      if (copy.clipImage && copy.clipImage.length > MAX_IMAGE_CHARS_FOR_FIRESTORE) {
        copy.clipImage = null;
        copy.imageTooLarge = true;
      }
      await db.collection('media_news').doc(entry.id).set(copy);
    } catch (e) {
      console.error('Firestore save error:', e.message);
    }
  }
}

// ---------------------------------------------------------------
// TAGGING (word boundary ke saath, taaki "three" me "hr" match na ho)
// ---------------------------------------------------------------

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

function detectCompany(text) {
  for (const comp of TARGET_COMPANIES) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(comp)}($|[^A-Za-z0-9])`, 'i');
    if (pattern.test(text)) return comp;
  }
  return 'Other';
}

function detectBeat(text) {
  if (/\b(csr|gram|village|community|health|school|welfare|blood|donat\w*)\b/i.test(text)) return 'CSR';
  if (/\b(plant|blast furnace|expansion|production|commission\w*|capacity|mill|furnace)\b/i.test(text)) return 'Plant';
  if (/\b(hr|appoint\w*|employees?|bonus|union|safety|workers?|recruit\w*)\b/i.test(text)) return 'HR';
  if (/\b(product|launch\w*|tmt|grade|steel coil|export\w*)\b/i.test(text)) return 'Product';
  return 'Corporate';
}

function detectSentiment(text) {
  if (/\b(award\w*|growth|profit|record|achiev\w*|milestone|inaugurat\w*|honou?r\w*|wins?|felicitat\w*|trophy)\b/i.test(text)) return 'Positive';
  if (/\b(strike|protest\w*|accident|death|loss|fine|penalty|leak\w*|fire|injur\w*)\b/i.test(text)) return 'Negative';
  return 'Neutral';
}

function detectMedia(text, hasImage) {
  if (hasImage || /\b(page|edition|samaja|sambad|dharitri|pragativadi|pbd|pg_\d+)\b/i.test(text)) return 'Print';
  if (/\b(bulletin|live|channel|kanak|otv|kalinga)\b/i.test(text)) return 'Channel';
  return 'Online';
}

// ---------------------------------------------------------------
// WHATSAPP BOT
// ---------------------------------------------------------------

let latestQrDataUrl = '';
let connectionStatus = 'Starting WhatsApp Engine...';
let sock = null;
let isLoggingOut = false;
let reconnectTimer = null;

// Group id -> group ka naam (cache)
const groupNameCache = new Map();

async function getGroupName(jid) {
  if (groupNameCache.has(jid)) return groupNameCache.get(jid);
  try {
    const meta = await sock.groupMetadata(jid);
    groupNameCache.set(jid, meta.subject || jid);
    return meta.subject || jid;
  } catch (e) {
    return jid;
  }
}

async function isGroupAllowed(jid) {
  if (ALLOWED_GROUPS.length === 0) return true;
  const name = (await getGroupName(jid)).toLowerCase();
  return ALLOWED_GROUPS.some(allowed => name.includes(allowed));
}

async function startWhatsAppBot() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '120.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQrDataUrl = await QRCode.toDataURL(qr);
      connectionStatus = 'Scan QR Code';
      console.log('Fresh WhatsApp QR Generated');
    }

    if (connection === 'open') {
      latestQrDataUrl = '';
      connectionStatus = 'Connected & Monitoring Active';
      console.log('WhatsApp Bot is Online and Monitoring Groups!');
    }

    if (connection === 'close') {
      if (isLoggingOut) return; // logout flow khud restart karega

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed, reconnecting:', shouldReconnect);

      if (shouldReconnect) {
        connectionStatus = 'Reconnecting...';
        reconnectTimer = setTimeout(startWhatsAppBot, 3000);
      } else {
        // Phone se logout hua: purana login hata ke naya QR banao
        connectionStatus = 'Logged Out. Refreshing QR...';
        latestQrDataUrl = '';
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
        reconnectTimer = setTimeout(startWhatsAppBot, 2000);
      }
    }
  });

  // Group message aur image clipping listener
  sock.ev.on('messages.upsert', async (m) => {
    // Sirf naye messages ('notify'), purani history ('append') nahi
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      try {
        if (!msg || !msg.message) continue;

        const remoteJid = msg.key.remoteJid || '';
        if (!remoteJid.endsWith('@g.us')) continue; // sirf groups

        if (!(await isGroupAllowed(remoteJid))) continue;

        // Same message dobara na aaye
        const entryId = msg.key.id || Date.now().toString();
        if (liveFeedStorage.some(e => e.id === entryId)) continue;

        let textContent = '';
        let mediaBase64 = null;

        if (msg.message.conversation) {
          textContent = msg.message.conversation;
        } else if (msg.message.extendedTextMessage?.text) {
          textContent = msg.message.extendedTextMessage.text;
        } else if (msg.message.imageMessage?.caption) {
          textContent = msg.message.imageMessage.caption;
        }

        if (msg.message.imageMessage) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            mediaBase64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
          } catch (imgErr) {
            console.error('Image Download Error:', imgErr.message);
          }
        }

        if (!textContent.trim() && !mediaBase64) continue;

        const groupName = await getGroupName(remoteJid);

        const entry = {
          id: entryId,
          company: detectCompany(textContent),
          headline: textContent.slice(0, 200) || (mediaBase64 ? 'Newspaper Clipping Image' : 'WhatsApp Update'),
          rawContent: textContent,
          beat: detectBeat(textContent),
          mediaType: detectMedia(textContent, !!mediaBase64),
          sentiment: detectSentiment(textContent),
          groupName,
          sender: msg.key.participant || (msg.key.fromMe ? 'Admin (You)' : remoteJid),
          timestamp: new Date().toISOString(),
          clipImage: mediaBase64 || null
        };

        await saveEntry(entry);
        console.log(`[Captured News] ${entry.company} | ${entry.beat} | ${entry.sentiment} | Group: ${groupName}`);
      } catch (err) {
        console.error('Error handling upsert:', err.message);
      }
    }
  });
}

startWhatsAppBot().catch(err => {
  console.error('WhatsApp start error:', err.message);
  connectionStatus = 'Error: ' + err.message;
});

// ---------------------------------------------------------------
// API ENDPOINTS
// ---------------------------------------------------------------

app.get('/api/status', (req, res) => {
  res.json({ status: connectionStatus, qr: latestQrDataUrl });
});

// Dashboard is feed ko har 3 second me padhta hai
app.get('/api/news-feed', (req, res) => {
  res.json({ success: true, data: liveFeedStorage });
});

// Manual news add (dashboard se)
app.post('/api/news', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.headline && !b.clipImage) {
      return res.status(400).json({ success: false, error: 'headline ya image chahiye' });
    }
    const entry = {
      id: Date.now().toString(),
      company: b.company || 'Other',
      headline: String(b.headline || 'Clipping Image Update').slice(0, 200),
      rawContent: String(b.headline || ''),
      beat: b.beat || 'Corporate',
      mediaType: b.mediaType || 'Online',
      sentiment: b.sentiment || 'Neutral',
      groupName: 'Manual',
      sender: 'Manual Entry',
      timestamp: new Date().toISOString(),
      clipImage: b.clipImage || null
    };
    await saveEntry(entry);
    res.json({ success: true, entry });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// News delete
app.delete('/api/news/:id', async (req, res) => {
  try {
    const id = req.params.id;
    liveFeedStorage = liveFeedStorage.filter(e => e.id !== id);
    if (db) await db.collection('media_news').doc(id).delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Logout / Switch WhatsApp account
app.post('/api/logout', async (req, res) => {
  try {
    isLoggingOut = true;
    connectionStatus = 'Logging out...';
    latestQrDataUrl = '';

    try {
      if (sock) await sock.logout();
    } catch (e) {
      console.log('Logout note:', e.message);
    }

    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
    groupNameCache.clear();

    connectionStatus = 'Logged Out. Refreshing QR...';
    isLoggingOut = false;
    await startWhatsAppBot();

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    isLoggingOut = false;
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(port, () => {
  console.log(`PR Hub listening on port ${port}`);
});
