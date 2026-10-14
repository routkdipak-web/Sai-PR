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

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------

const AUTH_DIR = process.env.AUTH_DIR || './auth_info_baileys';
const AUTH_COLLECTION = 'wa_auth';

const ALLOWED_GROUPS = (process.env.ALLOWED_GROUPS || 'Media track')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const TARGET_COMPANIES = [
  'AM/NS India', 'Tata Steel', 'JSW Steel', 'RSP', 'SAIL',
  'JSL', 'JSPL', 'NALCO', 'Vedanta', 'Aditya Aluminium',
  'Maithan', 'MCL', 'Hindalco', 'Visa Steel', 'CIL'
];

const BEATS = ['CSR', 'Plant', 'HR', 'Corporate', 'Product', 'Legal', 'Environment'];
const SENTIMENTS = ['Positive', 'Neutral', 'Negative'];

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Clean configured model string to avoid any typos
let rawModel = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
if (rawModel.includes('gemin1')) {
  rawModel = rawModel.replace('gemin1', 'gemini');
}
if (rawModel.includes('2.5') || rawModel.includes('2.0') || rawModel.includes('1.5')) {
  rawModel = 'gemini-3.8-flash';
}
const GEMINI_MODEL = rawModel;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';
const AI_ENABLED = !!(GEMINI_API_KEY || ANTHROPIC_API_KEY);
const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '90000', 10);

const MAX_IMAGE_CHARS_FOR_FIRESTORE = 900000;

// ---------------------------------------------------------------
// FIREBASE
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
  console.log('WARNING: Firebase connected nahi hai.');
}

console.log(AI_ENABLED
  ? `AI reading ON using ${ANTHROPIC_API_KEY ? 'Claude' : 'Gemini (' + GEMINI_MODEL + ')'}`
  : 'AI reading OFF');

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
// AUTH
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
// UTILITIES & FALLBACKS
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
  if (/\b(plant|blast furnace|expansion|production|commission\w*|capacity|mill|furnace|shutdown)\b/i.test(text)) return 'Plant';
  if (/\b(hr|appoint\w*|employees?|bonus|union|safety|workers?|recruit\w*)\b/i.test(text)) return 'HR';
  if (/\b(product|launch\w*|tmt|grade|steel coil|export\w*)\b/i.test(text)) return 'Product';
  if (/\b(court|legal|nclt|penalty|fine|notice|order)\b/i.test(text)) return 'Legal';
  if (/\b(pollution|green|solar|emission|spcb|cpcb|forest|environment)\b/i.test(text)) return 'Environment';
  return 'Corporate';
}

function detectSentiment(text) {
  if (/\b(award\w*|growth|profit|record|achiev\w*|milestone|inaugurat\w*|honou?r\w*|wins?|felicitat\w*|trophy|laud\w*|praise)\b/i.test(text)) return 'Positive';
  if (/\b(strike|protest\w*|accident|death|loss|fine|penalty|leak\w*|fire|injur\w*|halt\w*|disrupt\w*|clash|arrest\w*)\b/i.test(text)) return 'Negative';
  return 'Neutral';
}

function detectMedia(text, hasImage) {
  if (hasImage || /\b(page|edition|samaja|sambad|dharitri|prameya|pragativadi|pbd|pg_\d+)\b/i.test(text)) return 'Print';
  if (/\b(bulletin|live|channel|kanak|otv|kalinga|news18|prameya news7)\b/i.test(text)) return 'Satellite';
  return 'Digital';
}

// Extract metadata from string like: "Pioneer_Pg_03_Bhubaneswar_10 October 2026"
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
// AI ENGINE
// ---------------------------------------------------------------

const NON_ENGLISH_RE = /[\u0900-\u097F\u0B00-\u0B7F]/;

function buildPrompt(captionText) {
  return `You are an expert PR & Media Monitoring Analyst in Odisha, India.
You are given an image of a newspaper clipping (in Odia, Hindi, or English) and possibly a caption.

CRITICAL INSTRUCTIONS:
1. HEADLINE: Do NOT use the file/caption metadata (e.g. "Pioneer_Pg_03_Bhubaneswar...") as the headline. Read the ACTUAL printed newspaper title inside the image clipping and translate it into clear, concise English (max 18 words).
2. SUMMARY: Read the actual printed article body inside the image and provide a 3-4 sentence comprehensive English summary (who, what happened, numbers, location, company impact).
3. SENTIMENT: Strictly evaluate the tone regarding the industry/company:
   - "Negative": If there are deaths, accidents, protests, worker strikes, factory shutdowns, penalties, pollution issues.
   - "Positive": If it covers awards, CSR, school support, new investment, inauguration, profit, milestones.
   - "Neutral": Routine business updates or general stats.
4. If the caption includes paper metadata like "Pioneer_Pg_03_Bhubaneswar_10 October 2026", use it to extract publication and page, but always extract headline and summary from the PRINTED clipping itself.

Return ONLY a pure JSON object:
{
  "headline_en": "Actual news headline from the clipping translated to English",
  "summary_en": "Detailed 3-4 sentence English summary of the news body text",
  "publication": "Newspaper name (e.g., Sambad, Samaj, Dharitri, Prameya, Pioneer, Odisha Bhaskar)",
  "page": "Page number as digits only",
  "edition": "City edition (e.g., Bhubaneswar, Cuttack)",
  "company": "One of: ${TARGET_COMPANIES.join(', ')}, Other",
  "beat": "One of: ${BEATS.join(', ')}",
  "media_type": "Print",
  "sentiment": "Positive | Negative | Neutral"
}${captionText ? `\n\nImage metadata / caption: ${captionText}` : ''}`;
}

function extractJson(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) {
    console.error("JSON parse failure:", m[0]);
    return null;
  }
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

async function callGemini(imageDataUrl, text) {
  const parts = [];
  if (imageDataUrl) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageDataUrl.split(',')[1] } });
  }
  parts.push({ text: buildPrompt(text) });

  const url = `[https://generativelanguage.googleapis.com/v1beta/models/$](https://generativelanguage.googleapis.com/v1beta/models/$){GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
    })
  }, AI_TIMEOUT_MS);

  const j = await res.json();
  if (!res.ok) {
    console.error("Gemini API Error details:", JSON.stringify(j));
    throw new Error(j?.error?.message || `Gemini API Error ${res.status}`);
  }
  return extractJson(j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join(''));
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

  const res = await fetchWithTimeout('[https://api.anthropic.com/v1/messages](https://api.anthropic.com/v1/messages)', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content }]
    })
  }, AI_TIMEOUT_MS);

  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || `Claude API ${res.status}`);
  return extractJson(j?.content?.map(c => c.text || '').join(''));
}

async function analyzeNews(imageDataUrl, text) {
  if (!AI_ENABLED) return null;
  try {
    let raw = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        raw = ANTHROPIC_API_KEY
          ? await callClaude(imageDataUrl, text)
          : await callGemini(imageDataUrl, text);
        if (raw) break;
      } catch (err) {
        console.warn(`AI attempt ${attempt} failed:`, err.message);
        if (attempt === 2) throw err;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (!raw) return null;
    const s = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
    return {
      headlineEn: s(raw.headline_en, 250),
      summary: s(raw.summary_en, 800),
      publication: s(raw.publication, 80),
      page: s(raw.page, 6).replace(/[^\d]/g, ''),
      edition: s(raw.edition, 60),
      company: s(raw.company, 40),
      beat: s(raw.beat, 25),
      mediaType: s(raw.media_type, 20),
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
      console.log('WhatsApp Bot is Online!');
    }

    if (connection === 'close') {
      if (isLoggingOut) return;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
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
        const cap = parseClipCaption(textContent);

        // Check if textContent is purely metadata (e.g. Pioneer_Pg_03...)
        const isPureMetadataCaption = !!cap.publication && textContent.includes('_Pg_');

        // Trigger AI
        const needsAI = AI_ENABLED && (mediaBase64 || NON_ENGLISH_RE.test(textContent) || textContent.length > 50);
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
        const mediaType = ai?.mediaType || detectMedia(textContent, !!mediaBase64);

        // Don't let file caption become headline
        let fallbackHeadline = 'Newspaper Clipping News';
        if (!isPureMetadataCaption && textContent.trim()) {
          fallbackHeadline = textContent.slice(0, 200);
        }

        const entry = {
          id: entryId,
          company,
          headline: ai?.headlineEn || fallbackHeadline,
          headlineOriginal: textContent.slice(0, 200) || fallbackHeadline,
          summary: ai?.summary || '',
          publication: ai?.publication || cap.publication || '',
          page: ai?.page || cap.page || '',
          edition: ai?.edition || cap.edition || '',
          paperDate: cap.paperDate || '',
          rawContent: textContent,
          beat,
          mediaType,
          sentiment,
          groupName,
          sender: msg.key.participant || (msg.key.fromMe ? 'Admin (You)' : remoteJid),
          timestamp: new Date().toISOString(),
          clipImage: mediaBase64 || null
        };

        await saveEntry(entry);
        console.log(`[Captured News] ${entry.company} | ${entry.beat} | ${entry.sentiment} | AI: ${ai ? 'yes' : 'no'}`);
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

    const isPureMetadataCaption = !!cap.publication && typedHeadline.includes('_Pg_');

    const entry = {
      id: Date.now().toString(),
      company: b.company && b.company !== 'ALL' ? b.company : (ai?.company || 'Other'),
      headline: ai?.headlineEn || (isPureMetadataCaption ? 'Newspaper Clipping News' : (typedHeadline.slice(0, 200) || 'Newspaper Clipping News')),
      headlineOriginal: typedHeadline.slice(0, 200),
      summary: ai?.summary || '',
      publication: ai?.publication || cap.publication || '',
      page: ai?.page || cap.page || '',
      edition: ai?.edition || cap.edition || '',
      paperDate: cap.paperDate || '',
      rawContent: typedHeadline,
      beat: ai?.beat || b.beat || 'Corporate',
      mediaType: ai?.mediaType || b.mediaType || 'Print',
      sentiment: ai?.sentiment || b.sentiment || 'Neutral',
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
