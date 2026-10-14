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

const AUTH_DIR = process.env.AUTH_DIR || './auth_info_baileys';
const AUTH_COLLECTION = 'wa_auth';

// Sirf in groups ko sunega (group ka naam, comma se alag).
const ALLOWED_GROUPS = (process.env.ALLOWED_GROUPS || 'Media track')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const TARGET_COMPANIES = [
  'AM/NS India', 'Tata Steel', 'JSW Steel', 'RSP', 'SAIL',
  'JSL', 'JSPL', 'NALCO', 'Vedanta', 'Aditya Aluminium',
  'Maithan', 'MCL', 'Hindalco', 'Visa Steel', 'CIL'
];

const BEATS = ['CSR', 'Plant', 'HR', 'Corporate', 'Product'];
const SENTIMENTS = ['Positive', 'Neutral', 'Negative'];

// AI (clipping padhne, translate aur summary ke liye).
// Inme se koi ek key Render Environment me daalo:
//   GEMINI_API_KEY     (Google AI Studio, free tier hai)
//   ANTHROPIC_API_KEY  (Claude API, paid)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const AI_ENABLED = !!(GEMINI_API_KEY || ANTHROPIC_API_KEY);
// AI ke jawab ka intezar (milliseconds). Naye models kabhi slow hote hain, isliye 90 second.
const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '90000', 10);

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

console.log(AI_ENABLED
  ? `AI reading ON (${ANTHROPIC_API_KEY ? 'Claude' : 'Gemini'})`
  : 'AI reading OFF (GEMINI_API_KEY ya ANTHROPIC_API_KEY set nahi hai)');

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
// ---------------------------------------------------------------

async function useFirestoreAuthState(collectionName) {
  const col = db.collection(collectionName);
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
// KEYWORD TAGGING (AI na ho ya fail ho jaye tab ke liye backup)
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

// Caption se publication / page / edition nikalna
// Jaise: "Samaya_Pg_10_Bhubaneswar_13 Oct 2026"
function parseClipCaption(text) {
  const m = (text || '').match(/([A-Za-z][A-Za-z .&-]*?)_Pg_?(\d+)_([A-Za-z ]+?)_(\d{1,2}\s*[A-Za-z]{3,9}\s*\d{4})/i);
  if (!m) return {};
  return {
    publication: m[1].replace(/_/g, ' ').trim(),
    page: String(parseInt(m[2], 10)),
    edition: m[3].trim(),
    paperDate: m[4].trim()
  };
}

// ---------------------------------------------------------------
// AI: clipping padhna, translate, summary, publication, page
// ---------------------------------------------------------------

const NON_ENGLISH_RE = /[\u0900-\u097F\u0B00-\u0B7F]/; // Hindi (Devanagari) aur Odia

function buildPrompt(text) {
  return `You are a media-monitoring assistant for an Indian industrial PR team (steel, aluminium, mining, power).
You are given a newspaper clipping (photo/scan) and/or a message. The language may be Odia, Hindi or English.

Return ONLY one JSON object, with exactly these keys:
{
  "headline_en": "main headline translated to clear English, max 18 words",
  "summary_en": "short English summary of the news body, 2 to 3 sentences, max 60 words. Include key names, numbers and place.",
  "publication": "newspaper name written in English letters, or empty string",
  "page": "page number as digits only, or empty string",
  "edition": "city edition in English letters, or empty string",
  "language": "Odia, Hindi or English",
  "company": "one of: ${TARGET_COMPANIES.join(', ')}, Other",
  "beat": "one of: ${BEATS.join(', ')}",
  "sentiment": "one of: ${SENTIMENTS.join(', ')}"
}

Company hints: JSL = Jindal Stainless (also Jindal Stainless Foundation). JSPL = Jindal Steel & Power. RSP = Rourkela Steel Plant (SAIL). SAIL = Steel Authority of India. AM/NS India = ArcelorMittal Nippon Steel India. MCL = Mahanadi Coalfields. CIL = Coal India. NALCO = National Aluminium Company. If more than one company is mentioned, choose the main subject of the news. If none fit, use Other.
Sentiment is the tone for the company: Positive (awards, growth, CSR, achievements), Negative (accidents, protests, penalties, criticism), else Neutral.
Do not invent facts. If something is not visible, use an empty string.${text ? `\n\nMessage text / caption:\n${text}` : ''}`;
}

function extractJson(raw) {
  if (!raw) return null;
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callClaude(imageDataUrl, text) {
  const content = [];
  if (imageDataUrl) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: imageDataUrl.split(',')[1] }
    });
  }
  content.push({ type: 'text', text: buildPrompt(text) });

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content }]
    })
  }, AI_TIMEOUT_MS);

  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || `Claude API ${res.status}`);
  return extractJson(j?.content?.map(c => c.text || '').join(''));
}

async function callGemini(imageDataUrl, text) {
  const parts = [];
  if (imageDataUrl) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageDataUrl.split(',')[1] } });
  }
  parts.push({ text: buildPrompt(text) });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    })
  }, AI_TIMEOUT_MS);

  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || `Gemini API ${res.status}`);
  return extractJson(j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join(''));
}

async function analyzeNews(imageDataUrl, text) {
  if (!AI_ENABLED) return null;
  try {
    // Ek baar dobara try karte hain agar timeout / busy / limit ka error aaye
    let raw = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        raw = ANTHROPIC_API_KEY
          ? await callClaude(imageDataUrl, text)
          : await callGemini(imageDataUrl, text);
        break;
      } catch (err) {
        const retryable = /abort|timeout|overload|busy|unavailable|429|503|rate/i.test(err.message);
        if (attempt === 2 || !retryable) throw err;
        console.log(`AI retry after: ${err.message}`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (!raw) return null;
    const s = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
    return {
      headlineEn: s(raw.headline_en, 250),
      summary: s(raw.summary_en, 600),
      publication: s(raw.publication, 80),
      page: s(raw.page, 6).replace(/[^\d]/g, ''),
      edition: s(raw.edition, 60),
      language: s(raw.language, 20),
      company: s(raw.company, 40),
      beat: s(raw.beat, 20),
      sentiment: s(raw.sentiment, 20)
    };
  } catch (e) {
    console.error('AI analysis error:', e.message);
    return null;
  }
}

function pickFrom(list, value, fallback) {
  const hit = list.find(x => x.toLowerCase() === String(value || '').toLowerCase());
  return hit || fallback;
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
      if (isLoggingOut) return;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed, reconnecting:', shouldReconnect);

      if (shouldReconnect) {
        connectionStatus = 'Reconnecting...';
        reconnectTimer = setTimeout(() => {
          startWhatsAppBot().catch(e => console.error('Reconnect error:', e.message));
        }, 3000);
      } else {
        connectionStatus = 'Logged Out. Refreshing QR...';
        latestQrDataUrl = '';
        await clearSavedAuth();
        reconnectTimer = setTimeout(() => {
          startWhatsAppBot().catch(e => console.error('Restart error:', e.message));
        }, 2000);
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      try {
        if (!msg || !msg.message) continue;

        const remoteJid = msg.key.remoteJid || '';
        if (!remoteJid.endsWith('@g.us')) continue;

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

        // Caption se publication/page
        const cap = parseClipCaption(textContent);

        // AI sirf tab chalao jab image ho, ya Hindi/Odia text ho, ya text bahut lamba ho
        const needsAI = AI_ENABLED && (mediaBase64 || NON_ENGLISH_RE.test(textContent) || textContent.length > 250);
        const ai = needsAI ? await analyzeNews(mediaBase64, textContent) : null;

        const analysisText = `${ai?.headlineEn || ''} ${ai?.summary || ''} ${textContent}`;

        let company = pickFrom([...TARGET_COMPANIES, 'Other'], ai?.company, null);
        if (!company || company === 'Other') {
          const kw = detectCompany(analysisText);
          if (kw !== 'Other') company = kw;
        }
        company = company || 'Other';

        const beat = pickFrom(BEATS, ai?.beat, detectBeat(analysisText));
        const sentiment = pickFrom(SENTIMENTS, ai?.sentiment, detectSentiment(analysisText));

        const originalHeadline = textContent.slice(0, 200) || (mediaBase64 ? 'Newspaper Clipping Image' : 'WhatsApp Update');

        const entry = {
          id: entryId,
          company,
          headline: ai?.headlineEn || originalHeadline,
          headlineOriginal: originalHeadline,
          summary: ai?.summary || (textContent.length > 200 ? textContent.slice(0, 400) : ''),
          publication: cap.publication || ai?.publication || '',
          page: cap.page || ai?.page || '',
          edition: cap.edition || ai?.edition || '',
          paperDate: cap.paperDate || '',
          language: ai?.language || '',
          rawContent: textContent,
          beat,
          mediaType: detectMedia(textContent, !!mediaBase64),
          sentiment,
          groupName,
          sender: msg.key.participant || (msg.key.fromMe ? 'Admin (You)' : remoteJid),
          timestamp: new Date().toISOString(),
          clipImage: mediaBase64 || null
        };

        await saveEntry(entry);
        console.log(`[Captured News] ${entry.company} | ${entry.beat} | ${entry.sentiment} | ${entry.publication} Pg ${entry.page} | AI: ${ai ? 'yes' : 'no'}`);
      } catch (err) {
        console.error('Error handling upsert:', err.message);
      }
    }
  });
}

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

    const typedHeadline = String(b.headline || '').trim();
    const needsAI = AI_ENABLED && (b.clipImage || NON_ENGLISH_RE.test(typedHeadline));
    const ai = needsAI ? await analyzeNews(b.clipImage || null, typedHeadline) : null;
    const cap = parseClipCaption(typedHeadline);

    const isDefaultHeadline = !typedHeadline || typedHeadline === 'Clipping Image Update';

    const entry = {
      id: Date.now().toString(),
      company: b.company || 'Other',
      headline: (isDefaultHeadline || NON_ENGLISH_RE.test(typedHeadline))
        ? (ai?.headlineEn || typedHeadline || 'Clipping Image Update')
        : typedHeadline.slice(0, 200),
      headlineOriginal: typedHeadline.slice(0, 200),
      summary: ai?.summary || '',
      publication: cap.publication || ai?.publication || '',
      page: cap.page || ai?.page || '',
      edition: cap.edition || ai?.edition || '',
      paperDate: cap.paperDate || '',
      language: ai?.language || '',
      rawContent: typedHeadline,
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
