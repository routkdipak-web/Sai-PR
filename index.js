const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const admin = require('firebase-admin');
const pino = require('pino');
const baileys = require('@whiskeysockets/baileys');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  BufferJSON,
  initAuthCreds,
  proto
} = baileys;

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

const rawModel = (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();
const GEMINI_MODEL = rawModel.replace(/gemin1/g, 'gemini');

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';
const AI_ENABLED = !!(GEMINI_API_KEY || ANTHROPIC_API_KEY);
const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '90000', 10);

const MAX_IMAGE_CHARS_FOR_FIRESTORE = 900000;

// Decrypt-error auto recovery settings
const DECRYPT_ERR_LIMIT = 4;            // itne errors...
const DECRYPT_ERR_WINDOW_MS = 60000;    // ...is time ke andar aaye to recover
const RECOVERY_COOLDOWN_MS = 120000;    // 2 min me ek hi baar recover

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
// AUTH (Firestore) - cache + serialized writes = no more key races
// ---------------------------------------------------------------

// Saari Firestore writes ek line me (queue) hoti hain, taaki keys kabhi
// aage-peeche/overlap hoke corrupt na ho. Yehi Bad MAC ki main wajah thi.
let authWriteChain = Promise.resolve();
function queueAuthWrite(fn) {
  authWriteChain = authWriteChain.then(fn).catch(e => {
    console.error('Auth write error:', e.message);
  });
  return authWriteChain;
}

let authCache = new Map(); // docId -> parsed value (memory me latest state)

const fixId = (id) => String(id).replace(/\//g, '__').replace(/:/g, '-');

async function useFirestoreAuthState(collectionName) {
  const col = db.collection(collectionName);
  authCache = new Map();

  const readData = async (key) => {
    const id = fixId(key);
    if (authCache.has(id)) return authCache.get(id);
    try {
      const doc = await col.doc(id).get();
      if (!doc.exists) return null;
      const val = JSON.parse(doc.data().value, BufferJSON.reviver);
      authCache.set(id, val);
      return val;
    } catch (e) {
      return null;
    }
  };

  const writeData = (data, key) => {
    const id = fixId(key);
    authCache.set(id, data); // memory turant update
    const json = JSON.stringify(data, BufferJSON.replacer);
    return queueAuthWrite(() => col.doc(id).set({ value: json }));
  };

  const removeData = (key) => {
    const id = fixId(key);
    authCache.delete(id);
    return queueAuthWrite(() => col.doc(id).delete());
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
    saveCreds: () => writeData(creds, 'creds')
  };
}

// Poora login hatana (sirf real logout par)
async function clearSavedAuth() {
  authCache = new Map();
  if (db) {
    try {
      await authWriteChain;
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

// Sirf kharab session/sender-key hatana, login (creds) safe rehta hai.
// Isse QR dobara scan karne ki zaroorat nahi padti.
async function clearCorruptSessions() {
  authCache = new Map();
  if (db) {
    try {
      await authWriteChain;
      const snap = await db.collection(AUTH_COLLECTION).get();
      let batch = db.batch();
      let count = 0;
      for (const doc of snap.docs) {
        const id = doc.id;
        if (id.startsWith('session-') || id.startsWith('sender-key')) {
          batch.delete(doc.ref);
          count++;
          if (count % 400 === 0) {
            await batch.commit();
            batch = db.batch();
          }
        }
      }
      if (count % 400 !== 0 || count === 0) await batch.commit();
      console.log(`Recovery: ${count} kharab session keys hata di (login safe).`);
    } catch (e) {
      console.error('Clear sessions error:', e.message);
    }
  } else {
    try {
      for (const f of fs.readdirSync(AUTH_DIR)) {
        if (f.startsWith('session-') || f.startsWith('sender-key')) {
          fs.rmSync(path.join(AUTH_DIR, f), { force: true });
        }
      }
    } catch (e) {}
  }
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

function buildPrompt(captionText, hasImage = true) {
  const intro = hasImage
    ? 'You are given an image of a newspaper clipping (in Odia, Hindi, or English) and possibly a caption.'
    : 'You are given the text/title/description of an online news link or message (Odia, Hindi, or English). There is NO image; use the text only and never invent facts.';
  return `You are an expert PR & Media Monitoring Analyst in Odisha, India.
${intro}

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
  "media_type": "${hasImage ? 'Print' : 'Digital'}",
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
  parts.push({ text: buildPrompt(text, !!imageDataUrl) });

  const candidateModels = [GEMINI_MODEL, 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-1.5-flash'];
  const uniqueModels = [...new Set(candidateModels)];

  for (const modelToTry of uniqueModels) {
    try {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelToTry + ':generateContent?key=' + GEMINI_API_KEY;
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
        })
      }, AI_TIMEOUT_MS);

      const j = await res.json();
      if (res.ok) {
        return extractJson(j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join(''));
      }

      const isOverloaded = res.status === 503 || String(j?.error?.message).includes('demand') || res.status === 404;
      if (isOverloaded && modelToTry !== uniqueModels[uniqueModels.length - 1]) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw new Error(j?.error?.message || `Gemini API Error ${res.status}`);
    } catch (err) {
      if (modelToTry === uniqueModels[uniqueModels.length - 1]) throw err;
    }
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
  content.push({ type: 'text', text: buildPrompt(text, !!imageDataUrl) });

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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
        const retryable = /abort|timeout|overload|busy|unavailable|429|503|rate/i.test(err.message);
        if (attempt === 2 || !retryable) throw err;
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
// LINK HANDLING (facebook / odisharay / odishanewsonline etc.)
// ---------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

const DOMAIN_PUBLICATION = {
  'odisharay.com': 'Odisha Ray',
  'odishanewsonline.com': 'Odisha News Online',
  'facebook.com': 'Facebook',
  'fb.watch': 'Facebook',
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'instagram.com': 'Instagram',
  'x.com': 'X (Twitter)',
  'twitter.com': 'X (Twitter)',
  'timesofindia.indiatimes.com': 'Times of India',
  'newindianexpress.com': 'New Indian Express',
  'telegraphindia.com': 'The Telegraph',
  'orissapost.com': 'Orissa Post',
  'odishatv.in': 'OTV',
  'sambad.in': 'Sambad',
  'sambadenglish.com': 'Sambad English'
};

const GENERIC_TITLES = /^(facebook|log in|login|instagram|youtube|x|twitter|just a moment\.{0,3}|access denied|403 forbidden|attention required.*)$/i;

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^(www|m|mobile|web)\./i, '').toLowerCase(); } catch (e) { return ''; }
}

function publicationFromDomain(domain) {
  if (DOMAIN_PUBLICATION[domain]) return DOMAIN_PUBLICATION[domain];
  const hit = Object.keys(DOMAIN_PUBLICATION).find(d => domain.endsWith('.' + d));
  return hit ? DOMAIN_PUBLICATION[hit] : domain;
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/\s+/g, ' ').trim();
}

function metaContent(html, names) {
  for (const n of names) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    if (m && m[1]) return decodeHtml(m[1]);
  }
  return '';
}

async function fetchLinkPreview(url) {
  try {
    const res = await fetchWithTimeout(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en,hi;q=0.8,or;q=0.7'
      }
    }, 8000);
    if (!res.ok) return { title: '', description: '' };
    const html = (await res.text()).slice(0, 300000);
    let title = metaContent(html, ['og:title', 'twitter:title']);
    if (!title) {
      const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = t ? decodeHtml(t[1]) : '';
    }
    const description = metaContent(html, ['og:description', 'twitter:description', 'description']);
    return { title, description };
  } catch (e) {
    return { title: '', description: '' };
  }
}

async function getLinkInfo(msg, textContent) {
  const urls = (textContent.match(URL_RE) || []).map(u => u.replace(/[.,;]+$/, ''));
  if (!urls.length) return null;
  const url = urls[0];
  const ext = msg.message?.extendedTextMessage || {};
  let title = decodeHtml(ext.title || '');
  let description = decodeHtml(ext.description || '');
  if (GENERIC_TITLES.test(title)) title = '';

  // WhatsApp ka apna preview na ho to khud page se nikalo
  if (!title && !description) {
    const p = await fetchLinkPreview(ext.matchedText || url);
    title = GENERIC_TITLES.test(p.title) ? '' : p.title;
    description = p.description;
  }
  const domain = domainOf(url);
  return { url, domain, title, description, publication: publicationFromDomain(domain) };
}

// ---------------------------------------------------------------
// WHATSAPP BOT
// ---------------------------------------------------------------

let latestQrDataUrl = '';
let connectionStatus = 'Starting WhatsApp Engine...';
let sock = null;
let botGen = 0;                 // har naye socket ka number, purane socket ke events ignore hote hain
let isLoggingOut = false;
let isRecovering = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let lastRecoveryAt = 0;

const groupNameCache = new Map();
const inFlightIds = new Set();
const sentMessageCache = new Map(); // retry ke liye (getMessage)

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

// --- Decrypt error detector (Bad MAC etc.) ---
const DECRYPT_RE = /Bad MAC|Failed to decrypt|No matching sessions|No session found|MessageCounterError|Over 2000 messages|Invalid PreKey|No SenderKeyRecord|SenderKey/i;
let decryptErrTimes = [];
let lastDecryptCountAt = 0;
let suppressedLogCount = 0;

function noteDecryptError() {
  const now = Date.now();
  if (now - lastDecryptCountAt < 1000) return; // ek message ke kai log-lines ek hi count
  lastDecryptCountAt = now;
  decryptErrTimes = decryptErrTimes.filter(t => now - t < DECRYPT_ERR_WINDOW_MS);
  decryptErrTimes.push(now);
  if (decryptErrTimes.length >= DECRYPT_ERR_LIMIT) {
    decryptErrTimes = [];
    recoverFromDecryptErrors().catch(e => console.error('Recovery error:', e.message));
  }
}

// libsignal seedha console.error karta hai - spam rokne ke liye hook
const origConsoleError = console.error.bind(console);
const origConsoleWarn = console.warn.bind(console);
function filterConsole(orig) {
  return (...args) => {
    let text = '';
    try { text = args.map(a => (typeof a === 'string' ? a : (a && a.message) || '')).join(' '); } catch (e) {}
    if (DECRYPT_RE.test(text)) {
      suppressedLogCount++;
      if (suppressedLogCount === 1 || suppressedLogCount % 20 === 0) {
        orig(`[decrypt-warning] WhatsApp decrypt error (total hidden: ${suppressedLogCount})`);
      }
      noteDecryptError();
      return;
    }
    orig(...args);
  };
}
console.error = filterConsole(origConsoleError);
console.warn = filterConsole(origConsoleWarn);

const waLogger = pino({ level: 'error' }, {
  write(line) {
    if (DECRYPT_RE.test(line)) { noteDecryptError(); return; }
    // baaki errors bhi chhote form me dikhao
    try {
      const o = JSON.parse(line);
      origConsoleError('[wa]', o.msg || o.err?.message || line.slice(0, 200));
    } catch (e) {}
  }
});

function teardownSocket() {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners('connection.update');
    sock.ev.removeAllListeners('creds.update');
    sock.ev.removeAllListeners('messages.upsert');
  } catch (e) {}
  try { sock.end(undefined); } catch (e) {}
  sock = null;
}

function scheduleReconnect(ms) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWhatsAppBot().catch(e => {
      console.error('Restart error:', e.message);
      scheduleReconnect(10000);
    });
  }, ms);
}

// AUTO RECOVERY: login same rehta hai, sirf kharab session keys saaf hoti hain.
async function recoverFromDecryptErrors() {
  if (isRecovering || isLoggingOut) return;
  if (Date.now() - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return;
  isRecovering = true;
  lastRecoveryAt = Date.now();
  try {
    console.log('Auto-recovery: decrypt errors mile, sessions reset kar raha hun (QR ki zaroorat nahi)...');
    connectionStatus = 'Auto-fixing sessions...';
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    botGen++;
    teardownSocket();
    await clearCorruptSessions();
    suppressedLogCount = 0;
    groupNameCache.clear();
    scheduleReconnect(2000);
  } finally {
    isRecovering = false;
  }
}

async function startWhatsAppBot() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  teardownSocket();
  const myGen = ++botGen;

  const { state, saveCreds } = db
    ? await useFirestoreAuthState(AUTH_COLLECTION)
    : await useMultiFileAuthState(AUTH_DIR);

  // Keys ko memory-cache se wrap karna (agar Baileys version me ho)
  let keyStore = state.keys;
  if (typeof baileys.makeCacheableSignalKeyStore === 'function') {
    try {
      keyStore = baileys.makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }));
    } catch (e) {
      keyStore = state.keys;
    }
  }

  const newSock = makeWASocket({
    auth: { creds: state.creds, keys: keyStore },
    logger: waLogger,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '120.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    retryRequestDelayMs: 500,
    maxMsgRetryCount: 5,
    keepAliveIntervalMs: 25000,
    getMessage: async (key) => sentMessageCache.get(key.id) || undefined
  });
  sock = newSock;

  newSock.ev.on('creds.update', () => {
    if (myGen !== botGen) return;
    Promise.resolve(saveCreds()).catch(e => console.error('saveCreds error:', e.message));
  });

  newSock.ev.on('connection.update', async (update) => {
    if (myGen !== botGen) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQrDataUrl = await QRCode.toDataURL(qr);
      connectionStatus = 'Scan QR Code';
    }

    if (connection === 'open') {
      latestQrDataUrl = '';
      connectionStatus = 'Connected & Monitoring Active';
      reconnectAttempts = 0;
      console.log('WhatsApp connected');
    }

    if (connection === 'close') {
      if (isLoggingOut || isRecovering) return;
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        // Sirf tab jab WhatsApp se sach me logout hua ho
        connectionStatus = 'Logged Out. Refreshing QR...';
        latestQrDataUrl = '';
        await clearSavedAuth();
        scheduleReconnect(2000);
        return;
      }

      if (statusCode === DisconnectReason.connectionReplaced) {
        // Koi dusra instance (purana deploy) chal raha hai - ladai mat karo
        connectionStatus = 'Another session active. Retrying...';
        scheduleReconnect(30000);
        return;
      }

      reconnectAttempts++;
      const delay = Math.min(3000 * reconnectAttempts, 30000);
      connectionStatus = 'Reconnecting...';
      scheduleReconnect(delay);
    }
  });

  // Messages ek-ek karke (queue) process hote hain, parallel nahi
  let messageChain = Promise.resolve();
  newSock.ev.on('messages.upsert', (m) => {
    if (myGen !== botGen) return;
    if (m.type !== 'notify') return;
    for (const msg of m.messages) {
      messageChain = messageChain
        .then(() => processMessage(msg, newSock))
        .catch(e => console.error('Message error:', e.message));
    }
  });
}

async function processMessage(msg, activeSock) {
  if (!msg || !msg.message) return; // decrypt fail wale yahan skip ho jate hain

  const remoteJid = msg.key.remoteJid || '';
  if (!remoteJid.endsWith('@g.us')) return;
  if (!(await isGroupAllowed(remoteJid))) return;

  const entryId = msg.key.id || Date.now().toString();
  if (inFlightIds.has(entryId) || liveFeedStorage.some(e => e.id === entryId)) return;
  inFlightIds.add(entryId);

  try {
    // wrapper (ephemeral / viewOnce) khol do
    const inner = msg.message.ephemeralMessage?.message || msg.message;
    const m0 = { ...msg, message: inner };

    let textContent = '';
    let mediaBase64 = null;

    if (inner.conversation) textContent = inner.conversation;
    else if (inner.extendedTextMessage?.text) textContent = inner.extendedTextMessage.text;
    else if (inner.imageMessage?.caption) textContent = inner.imageMessage.caption;

    if (inner.imageMessage) {
      try {
        const buffer = await downloadMediaMessage(m0, 'buffer', {});
        mediaBase64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
      } catch (imgErr) {
        console.error('Image download failed:', imgErr.message);
      }
    }

    if (!textContent.trim() && !mediaBase64) return;

    const groupName = await getGroupName(remoteJid);
    const cap = parseClipCaption(textContent);
    const isPureMetadataCaption = !!cap.publication && textContent.includes('_Pg_');

    // Link message?
    const link = mediaBase64 ? null : await getLinkInfo(m0, textContent);
    const userNote = link ? textContent.replace(URL_RE, '').trim() : textContent;
    const aiText = link
      ? [link.title, link.description, userNote].filter(Boolean).join('. ')
      : textContent;

    const needsAI = AI_ENABLED && (
      mediaBase64 ||
      (link ? aiText.length > 15 : (NON_ENGLISH_RE.test(textContent) || textContent.length > 50))
    );

    let ai = null;
    if (needsAI) {
      try {
        ai = await analyzeNews(mediaBase64, aiText);
      } catch (err) {
        ai = null;
      }
    }

    const analysisText = `${ai?.headlineEn || ''} ${ai?.summary || ''} ${link ? aiText : textContent}`;

    let company = pickFrom([...TARGET_COMPANIES, 'Other'], ai?.company, null);
    if (!company || company === 'Other') {
      const kw = detectCompany(analysisText);
      if (kw !== 'Other') company = kw;
    }
    company = company || 'Other';

    const beat = pickFrom(BEATS, ai?.beat, detectBeat(analysisText));
    const sentiment = pickFrom(SENTIMENTS, ai?.sentiment, detectSentiment(analysisText));
    const mediaType = link ? 'Digital' : (ai?.mediaType || detectMedia(textContent, !!mediaBase64));

    let fallbackHeadline = 'Newspaper Clipping News';
    if (link) {
      fallbackHeadline = link.title || (userNote ? userNote.slice(0, 200) : `Link: ${link.domain}`);
    } else if (!isPureMetadataCaption && textContent.trim()) {
      fallbackHeadline = textContent.slice(0, 200);
    }

    const entry = {
      id: entryId,
      company,
      headline: ai?.headlineEn || fallbackHeadline,
      headlineOriginal: (link ? (link.title || link.url) : textContent).slice(0, 200) || fallbackHeadline,
      summary: ai?.summary || (link ? (link.description || '').slice(0, 600) : ''),
      publication: ai?.publication || (link ? link.publication : '') || cap.publication || '',
      page: ai?.page || cap.page || '',
      edition: ai?.edition || cap.edition || '',
      paperDate: cap.paperDate || '',
      rawContent: textContent,
      link: link ? link.url : '',
      beat,
      mediaType,
      sentiment,
      groupName,
      sender: msg.key.participant || (msg.key.fromMe ? 'Admin (You)' : remoteJid),
      timestamp: new Date().toISOString(),
      clipImage: mediaBase64 || null
    };

    await saveEntry(entry);
    console.log(`Saved: [${company}] ${entry.headline.slice(0, 80)}`);
  } finally {
    inFlightIds.delete(entryId);
  }
}

// ---------------------------------------------------------------
// SHUTDOWN: logout NAHI karna (warna har deploy par QR maangega)
// ---------------------------------------------------------------

async function gracefulShutdown() {
  console.log('Shutting down (session safe rakh raha hun)...');
  try { await Promise.race([authWriteChain, new Promise(r => setTimeout(r, 4000))]); } catch (e) {}
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Koi bhi chhoti error poore server ko na gira de
process.on('unhandledRejection', (e) => origConsoleError('unhandledRejection:', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => {
  const text = e && e.message ? e.message : String(e);
  if (DECRYPT_RE.test(text)) { noteDecryptError(); return; }
  origConsoleError('uncaughtException:', text);
});

(async () => {
  await loadFeedFromFirestore();
  await startWhatsAppBot();
})().catch(err => {
  connectionStatus = 'Error: ' + err.message;
  console.error('Startup error:', err.message);
  scheduleReconnect(10000);
});

// Render free plan ko jagaye rakhne ke liye khud ko ping (har 10 min)
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetchWithTimeout(process.env.RENDER_EXTERNAL_URL + '/api/status', {}, 15000).catch(() => {});
  }, 10 * 60 * 1000);
}

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
    let ai = null;
    try {
      ai = needsAI ? await analyzeNews(b.clipImage || null, typedHeadline) : null;
    } catch (e) {
      ai = null;
    }
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

// Manual logout (dashboard button) - sirf yahi jagah logout hota hai
app.post('/api/logout', async (req, res) => {
  try {
    isLoggingOut = true;
    connectionStatus = 'Logging out...';
    latestQrDataUrl = '';
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    try { if (sock) await sock.logout(); } catch (e) {}
    botGen++;
    teardownSocket();

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
