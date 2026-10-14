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
  downloadMediaMessage,
  BufferJSON,
  initAuthCreds,
  proto
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json({ limit: '25mb' }));
const port = process.env.PORT || 3000;

// Frontend dashboard (public/index.html)
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------

// Firebase na ho to WhatsApp login is folder me save hota hai (Render restart par mit jayega)
const AUTH_DIR = process.env.AUTH_DIR || './auth_info_baileys';

// Firebase me WhatsApp login is collection me save hoga
const AUTH_COLLECTION = 'wa_auth';

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
// FIREBASE + STORAGE
// ---------------------------------------------------------------

let liveFeedStorage = [];

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

if (!db) {
  console.log('WARNING: Firebase connected nahi hai. WhatsApp login aur news restart par mit jayenge.');
}

// Server start hone par purani news Firestore se wapas load karo
async function loadFeedFromFirestore() {
  if (!db) return;
  try {
    const snap = await db.collection('media_news').orderBy('timestamp', 'desc').limit(300).get();
    liveFeedStorage = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log(`Loaded ${liveFeedStorage.length} saved news items from Firestore`);
  } catch (e) {
    console.error('Load feed error:', e.message);
  }
}

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
// WHATSAPP LOGIN FIREBASE ME SAVE KARNE WALA SYSTEM
// (useMultiFileAuthState ki jagah, taaki restart par QR dobara na scan karna pade)
// ---------------------------------------------------------------

async function useFirestoreAuthState(collectionName) {
  const col = db.collection(collectionName);

  // Firestore document id me "/" nahi chal sakta
  const fixId = (id) => String(id).replace(/\//g, '__').replace(/:/g, '-');

  const writeData = async (data, key) => {
    await col.doc(fixId(key)).set({ value: JSON.stringify(data, BufferJSON.replacer) });
  };

  const readData = async (key) => {
    try {
      const doc = await col.doc(fixId(key)).get();
      if (!doc.exists) return null;
      return JSON.parse(doc.data().value, BufferJSON.reviver);
    } catch (e) {
      return null;
    }
  };

  const removeData = async (key) => {
    try { await col.doc(fixId(key)).delete(); } catch (e) {}
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      await writeData(creds, 'creds');
    }
  };
}

// Saved WhatsApp login poora hatao (Switch Account ke liye)
async function clearSavedAuth() {
  if (db) {
    try {
      const snap = await db.collection(AUTH_COLLECTION).get();
      let batch = db.batch();
      let count = 0;
      for (const doc of snap.docs) {
        batch.delete(doc.ref);
        count++;
        if (count % 400 === 0) {
          await batch.commit();
          batch = db.batch();
        }
      }
      await batch.commit();
    } catch (e) {
      console.error('Clear auth error:', e.message);
    }
  }
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
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

  // Firebase hai to login wahan save hoga, warna local folder me
  const { state, saveCreds } = db
    ? await useFirestoreAuthState(AUTH_COLLECTION)
    : await useMultiFileAuthState(AUTH_DIR);

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
        reconnectTimer = setTimeout(() => {
          startWhatsAppBot().catch(e => console.error('Reconnect error:', e.message));
        }, 3000);
      } else {
        // Phone se logout hua: saved login hata ke naya QR banao
        connectionStatus = 'Logged Out. Refreshing QR...';
        latestQrDataUrl = '';
        await clearSavedAuth();
        reconnectTimer = setTimeout(() => {
          startWhatsAppBot().catch(e => console.error('Restart error:', e.message));
        }, 2000);
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

// Pehle purani news load karo, phir WhatsApp start karo
(async () => {
  await loadFeedFromFirestore();
  await startWhatsAppBot();
})().catch(err => {
  console.error('Startup error:', err.message);
  connectionStatus = 'Error: ' + err.message;
});

// ---------------------------------------------------------------
// API ENDPOINTS
// ---------------------------------------------------------------

app.get('/api/status', (req, res) => {
  res.json({ status: connectionStatus, qr: latestQrDataUrl });
});

app.get('/api/news-feed', (req, res) => {
  res.json({ success: true, data: liveFeedStorage });
});

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

    await clearSavedAuth();
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
