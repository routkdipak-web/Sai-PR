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

const BEATS = ['CSR', 'Plant', 'HR', 'Corporate', 'Product'];
const MEDIA_TYPES = ['Print', 'Digital', 'Satellite'];
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
const DECRYPT_ERR_LIMIT = 4;
const DECRYPT_ERR_WINDOW_MS = 60000;
const RECOVERY_COOLDOWN_MS = 120000;

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
// AUTH (Firestore)
// ---------------------------------------------------------------

let authWriteChain = Promise.resolve();
function queueAuthWrite(fn) {
  authWriteChain = authWriteChain.then(fn).catch(e => {
    console.error('Auth write error:', e.message);
  });
  return authWriteChain;
}

let authCache = new Map();

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
    authCache.set(id, data);
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

function buildPrompt(captionText, kind = 'print') {
  const sourceDesc = {
    print: 'an IMAGE of a newspaper clipping (Odia, Hindi or English) and possibly a caption',
    link: 'the TEXT of an online news/web-portal article or social-media link (title, description, article text). There is NO image',
    text: 'a plain TEXT message copied from a WhatsApp group. There is NO image'
  }[kind] || 'a news item';

  return `You are a careful PR & Media Monitoring Analyst for steel, aluminium and mining companies in Odisha, India.
Your output goes into an official media-monitoring Excel sheet that is sent to the Head Office. A WRONG value is far worse than "Other". A human will review every "Other" later.

YOU ARE GIVEN: ${sourceDesc}.

GOLDEN RULE (most important):
- Use ONLY what is clearly visible/readable in the given content. NEVER guess, assume or invent.
- If you are not sure about a field, write "Other" (or "" for page/edition/headline/summary). Do NOT pick the "closest" value.
- Caption/file-name text (like "Pioneer_Pg_03_Bhubaneswar_10 October 2026") is only metadata. It is NEVER the headline.

FIELD RULES:
1. headline_en: The real headline of the news${kind === 'print' ? ' as PRINTED in the clipping image' : ''}, translated to simple, accurate English (max 18 words). If it cannot be read clearly, return "".
2. summary_en: 3-4 factual English sentences covering who, what, where, when, numbers, and the company's role.
3. publication: ${kind === 'print' ? 'The newspaper name exactly as printed on the clipping or given in the caption. If not visible, write "Other".' : 'The website/channel name, else "Other".'}
4. page: ${kind === 'print' ? 'Page number as digits only, ONLY if printed on the clipping or in the caption. Otherwise "".' : 'Always ""'}
5. edition: ${kind === 'print' ? 'City edition only if printed or in the caption. Otherwise "".' : 'Always "".'}
6. company: Choose exactly ONE from this list, or "Other":
   ${TARGET_COMPANIES.join(', ')}
7. beat: Choose exactly ONE of: ${BEATS.join(', ')} or "Other".
8. media_type: ${kind === 'print' ? '"Print"' : kind === 'link' ? '"Digital"' : 'One of: Print, Digital, Satellite'}.
9. sentiment: "Positive", "Negative", or "Neutral".
10. needs_review: true if unsure about any field; otherwise false.

Return ONLY this pure JSON object:
{
  "headline_en": "",
  "summary_en": "",
  "publication": "",
  "page": "",
  "edition": "",
  "company": "",
  "beat": "",
  "media_type": "",
  "sentiment": "",
  "needs_review": false
}${captionText ? `\n\n${kind === 'print' ? 'Image caption / metadata' : 'Content'}:\n${captionText}` : ''}`;
}

function extractJson(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  const m = text.match(/\{[\s\S]*\}/);
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

async function callGemini(imageDataUrl, text, kind) {
  const parts = [];
  if (imageDataUrl) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageDataUrl.split(',')[1] } });
  }
  parts.push({ text: buildPrompt(text, kind) });

  const candidateModels = [GEMINI_MODEL, 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-1.5-flash'];
  const uniqueModels = [...new Set(candidateModels)];

  for (const modelToTry of uniqueModels) {
    try {
      const url = '[https://generativelanguage.googleapis.com/v1beta/models/](https://generativelanguage.googleapis.com/v1beta/models/)' + modelToTry + ':generateContent?key=' + GEMINI_API_KEY;
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 }
        })
      }, AI_TIMEOUT_MS);

      const j = await res.json();
      if (res.ok) {
        return extractJson(j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join(''));
      }
      throw new Error(j?.error?.message || `Gemini API Error ${res.status}`);
    } catch (err) {
      if (modelToTry === uniqueModels[uniqueModels.length - 1]) throw err;
    }
  }
}

async function callClaude(imageDataUrl, text, kind) {
  const content = [];
  if (imageDataUrl) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: imageDataUrl.split(',')[1] }
    });
  }
  content.push({ type: 'text', text: buildPrompt(text, kind) });

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

async function analyzeNews(imageDataUrl, text, kind) {
  if (!AI_ENABLED) return null;
  kind = kind || (imageDataUrl ? 'print' : 'text');
  try {
    let raw = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        raw = ANTHROPIC_API_KEY
          ? await callClaude(imageDataUrl, text, kind)
          : await callGemini(imageDataUrl, text, kind);
        if (raw) break;
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (!raw) return null;
    const s = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
    return {
      headlineEn: s(raw.headline_en, 250),
      summary: s(raw.summary_en, 900),
      publication: s(raw.publication, 80),
      page: s(raw.page, 6).replace(/[^\d]/g, ''),
      edition: s(raw.edition, 60),
      company: s(raw.company, 40),
      beat: s(raw.beat, 25),
      mediaType: s(raw.media_type, 20),
      sentiment: s(raw.sentiment, 20),
      needsReview: raw.needs_review === true
    };
  } catch (e) {
    return null;
  }
}

function pickFrom(list, value, fallback) {
  const hit = list.find(x => x.toLowerCase() === String(value || '').trim().toLowerCase());
  return hit || fallback;
}

function cleanPublication(v) {
  const t = String(v || '').trim();
  if (!t || t.length > 60 || /^(other|unknown|n\/a|none|-)$/i.test(t)) return '';
  return t;
}

function finalizeFields({ ai, kind, cap, link, textContent }) {
  const isPrint = kind === 'print';
  const isLink = kind === 'link';

  let company = ai ? pickFrom([...TARGET_COMPANIES, 'Other'], ai.company, 'Other') : detectCompany(textContent);
  const beat = ai ? pickFrom(BEATS, ai.beat, 'Other') : 'Other';
  const sentiment = ai ? pickFrom(SENTIMENTS, ai.sentiment, 'Other') : 'Other';

  let mediaType;
  if (isPrint) mediaType = 'Print';
  else if (isLink) mediaType = 'Digital';
  else if (cap.publication) mediaType = 'Print';
  else mediaType = ai ? pickFrom(MEDIA_TYPES, ai.mediaType, 'Other') : 'Other';

  let publication = '', page = '', edition = '';
  if (isLink) {
    publication = link.publication || 'Other';
  } else {
    publication = cap.publication || cleanPublication(ai?.publication) || 'Other';
    page = cap.page || (ai?.page || '');
    edition = cap.edition || (ai?.edition || '');
  }

  const needsReview = !ai ||
    ai.needsReview ||
    [company, publication, beat, mediaType, sentiment].includes('Other') ||
    (isPrint && !page);

  return { company, beat, sentiment, mediaType, publication, page, edition, needsReview };
}

// ---------------------------------------------------------------
// LINK HANDLING
// ---------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

const DOMAIN_PUBLICATION = {
  'odisharay.com': 'Odisha Ray',
  'orissadiary.com': 'Odisha Diary',
  'odishanewsonline.com': 'Odisha News Online',
  'facebook.com': 'Facebook',
  'youtube.com': 'YouTube',
  'timesofindia.indiatimes.com': 'Times of India',
  'newindianexpress.com': 'New Indian Express',
  'orissapost.com': 'Orissa Post',
  'odishatv.in': 'OTV',
  'sambad.in': 'Sambad'
};

const GENERIC_TITLES = /^(facebook|log in|login|instagram|youtube|x|twitter|just a moment\.{0,3}|access denied|403 forbidden)$/i;

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
    .replace(/\s+/g, ' ').trim();
}

async function fetchLinkPreview(url) {
  const empty = { title: '', description: '', body: '', siteName: '' };
  try {
    const res = await fetchWithTimeout(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +[http://www.google.com/bot.html](http://www.google.com/bot.html))',
        'accept': 'text/html,application/xhtml+xml'
      }
    }, 10000);
    if (!res.ok) return empty;
    const html = (await res.text()).slice(0, 600000);
    let title = metaContent(html, ['og:title', 'twitter:title']);
    if (!title) {
      const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = t ? decodeHtml(t[1]) : '';
    }
    const description = metaContent(html, ['og:description', 'twitter:description', 'description']);
    const siteName = metaContent(html, ['og:site_name']);
    return { title, description, body: '', siteName };
  } catch (e) {
    return empty;
  }
}

function metaContent(html, names) {
  for (const n of names) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i');
    const m = html.match(re1);
    if (m && m[1]) return decodeHtml(m[1]);
  }
  return '';
}

async function getLinkInfo(msg, textContent) {
  const urls = (textContent.match(URL_RE) || []).map(u => u.replace(/[.,;]+$/, ''));
  if (!urls.length) return null;
  const url = urls[0];
  const ext = msg.message?.extendedTextMessage || {};
  let title = decodeHtml(ext.title || '');
  let description = decodeHtml(ext.description || '');
  if (GENERIC_TITLES.test(title)) title = '';

  const p = await fetchLinkPreview(ext.matchedText || url);
  if (!title) title = GENERIC_TITLES.test(p.title) ? '' : p.title;
  if (!description) description = p.description;

  const domain = domainOf(url);
  let publication = publicationFromDomain(domain);
  return { url, domain, title, description, publication };
}

// ---------------------------------------------------------------
// WHATSAPP BOT
// ---------------------------------------------------------------

let latestQrDataUrl = '';
let connectionStatus = 'Starting WhatsApp Engine...';
let sock = null;
let botGen = 0;
let isLoggingOut = false;
let isRecovering = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let lastRecoveryAt = 0;

const groupNameCache = new Map();
const inFlightIds = new Set();
const sentMessageCache = new Map();

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

const DECRYPT_RE = /Bad MAC|Failed to decrypt|No matching sessions|No session found|MessageCounterError|Invalid PreKey/i;
let decryptErrTimes = [];
let lastDecryptCountAt = 0;
let suppressedLogCount = 0;

function noteDecryptError() {
  const now = Date.now();
  if (now - lastDecryptCountAt < 1000) return;
  lastDecryptCountAt = now;
  decryptErrTimes = decryptErrTimes.filter(t => now - t < DECRYPT_ERR_WINDOW_MS);
  decryptErrTimes.push(now);
  if (decryptErrTimes.length >= DECRYPT_ERR_LIMIT) {
    decryptErrTimes = [];
    recoverFromDecryptErrors().catch(e => {});
  }
}

const origConsoleError = console.error.bind(console);
const origConsoleWarn = console.warn.bind(console);
function filterConsole(orig) {
  return (...args) => {
    let text = '';
    try { text = args.map(a => (typeof a === 'string' ? a : (a && a.message) || '')).join(' '); } catch (e) {}
    if (DECRYPT_RE.test(text)) {
      suppressedLogCount++;
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
    startWhatsAppBot().catch(e => scheduleReconnect(10000));
  }, ms);
}

async function recoverFromDecryptErrors() {
  if (isRecovering || isLoggingOut) return;
  if (Date.now() - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return;
  isRecovering = true;
  lastRecoveryAt = Date.now();
  try {
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

  let keyStore = state.keys;
  if (typeof baileys.makeCacheableSignalKeyStore === 'function') {
    try {
      keyStore = baileys.makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }));
    } catch (e) {}
  }

  const newSock = makeWASocket({
    auth: { creds: state.creds, keys: keyStore },
    logger: waLogger,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '120.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => sentMessageCache.get(key.id) || undefined
  });
  sock = newSock;

  newSock.ev.on('creds.update', () => {
    if (myGen !== botGen) return;
    Promise.resolve(saveCreds()).catch(e => {});
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
    }

    if (connection === 'close') {
      if (isLoggingOut || isRecovering) return;
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        connectionStatus = 'Logged Out. Refreshing QR...';
        latestQrDataUrl = '';
        await clearSavedAuth();
        scheduleReconnect(2000);
        return;
      }

      reconnectAttempts++;
      const delay = Math.min(3000 * reconnectAttempts, 30000);
      connectionStatus = 'Reconnecting...';
      scheduleReconnect(delay);
    }
  });

  let messageChain = Promise.resolve();
  newSock.ev.on('messages.upsert', (m) => {
    if (myGen !== botGen) return;
    if (m.type !== 'notify') return;
    for (const msg of m.messages) {
      messageChain = messageChain
        .then(() => processMessage(msg, newSock))
        .catch(e => {});
    }
  });
}

async function processMessage(msg, activeSock) {
  if (!msg || !msg.message) return;

  const remoteJid = msg.key.remoteJid || '';
  if (!remoteJid.endsWith('@g.us')) return;
  if (!(await isGroupAllowed(remoteJid))) return;

  const entryId = msg.key.id || Date.now().toString();
  if (inFlightIds.has(entryId) || liveFeedStorage.some(e => e.id === entryId)) return;
  inFlightIds.add(entryId);

  try {
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
      } catch (imgErr) {}
    }

    if (!textContent.trim() && !mediaBase64) return;

    const groupName = await getGroupName(remoteJid);
    const cap = parseClipCaption(textContent);
    const link = mediaBase64 ? null : await getLinkInfo(m0, textContent);

    if (link && liveFeedStorage.some(e => e.link && e.link === link.url)) return;

    const kind = mediaBase64 ? 'print' : (link ? 'link' : 'text');
    const userNote = link ? textContent.replace(URL_RE, '').trim() : textContent;
    const aiText = link
      ? [link.title && `TITLE: ${link.title}`, link.description && `DESCRIPTION: ${link.description}`, userNote && `SENDER NOTE: ${userNote}`].filter(Boolean).join('\n')
      : textContent;

    let ai = null;
    if (AI_ENABLED && (mediaBase64 || aiText.trim().length > 15)) {
      try { ai = await analyzeNews(mediaBase64, aiText, kind); } catch (e) { ai = null; }
    }

    const f = finalizeFields({ ai, kind, cap, link, textContent });

    let fallbackHeadline = kind === 'print' ? 'Newspaper Clipping News' : (link ? link.title || textContent.slice(0, 200) : textContent.slice(0, 200));

    const entry = {
      id: entryId,
      company: f.company,
      headline: ai?.headlineEn || fallbackHeadline,
      headlineOriginal: (link ? (link.title || link.url) : textContent).slice(0, 200) || fallbackHeadline,
      summary: ai?.summary || (link && !ai ? (link.description || '').slice(0, 600) : ''),
      publication: f.publication,
      page: f.page,
      edition: f.edition,
      paperDate: cap.paperDate || '',
      rawContent: textContent,
      link: link ? link.url : '',
      beat: f.beat,
      mediaType: f.mediaType,
      sentiment: f.sentiment,
      needsReview: f.needsReview,
      groupName,
      sender: msg.key.participant || (msg.key.fromMe ? 'Admin (You)' : remoteJid),
      timestamp: new Date().toISOString(),
      clipImage: mediaBase64 || null
    };

    await saveEntry(entry);
  } finally {
    inFlightIds.delete(entryId);
  }
}

async function gracefulShutdown() {
  try { await Promise.race([authWriteChain, new Promise(r => setTimeout(r, 4000))]); } catch (e) {}
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

(async () => {
  await loadFeedFromFirestore();
  await startWhatsAppBot();
})().catch(err => {
  connectionStatus = 'Error: ' + err.message;
  scheduleReconnect(10000);
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
    const kind = b.clipImage ? 'print' : 'text';
    let ai = null;
    if (AI_ENABLED && (b.clipImage || typedHeadline.length > 15)) {
      try { ai = await analyzeNews(b.clipImage || null, typedHeadline, kind); } catch (e) { ai = null; }
    }
    const cap = parseClipCaption(typedHeadline);
    const f = finalizeFields({ ai, kind, cap, link: null, textContent: typedHeadline });

    const manualCompany = b.company && b.company !== 'ALL' ? b.company : '';
    const manualBeat = pickFrom(BEATS, b.beat, 'Other');
    const manualMedia = pickFrom(MEDIA_TYPES, b.mediaType, 'Other');
    const manualSent = pickFrom(SENTIMENTS, b.sentiment, 'Other');

    const company = manualCompany || f.company;
    const beat = f.beat !== 'Other' ? f.beat : manualBeat;
    const mediaType = f.mediaType !== 'Other' ? f.mediaType : manualMedia;
    const sentiment = f.sentiment !== 'Other' ? f.sentiment : manualSent;

    const entry = {
      id: Date.now().toString(),
      company,
      headline: ai?.headlineEn || (typedHeadline && !cap.publication ? typedHeadline.slice(0, 200) : 'Newspaper Clipping News'),
      headlineOriginal: typedHeadline.slice(0, 200),
      summary: ai?.summary || '',
      publication: f.publication,
      page: f.page,
      edition: f.edition,
      paperDate: cap.paperDate || '',
      rawContent: typedHeadline,
      beat,
      mediaType,
      sentiment,
      needsReview: [company, f.publication, beat, mediaType, sentiment].includes('Other') || !ai || (kind === 'print' && !f.page),
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

// ADDED: PUT route for saving edits from frontend
app.put('/api/news/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    
    const index = liveFeedStorage.findIndex(e => e.id === id);
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Entry nahi mili' });
    }

    const existing = liveFeedStorage[index];
    
    const updatedEntry = {
      ...existing,
      headline: b.headline !== undefined ? String(b.headline).trim() : existing.headline,
      summary: b.summary !== undefined ? String(b.summary).trim() : existing.summary,
      company: b.company !== undefined ? b.company : existing.company,
      publication: b.publication !== undefined ? b.publication : existing.publication,
      page: b.page !== undefined ? String(b.page).replace(/[^\d]/g, '') : existing.page,
      edition: b.edition !== undefined ? b.edition : existing.edition,
      beat: b.beat !== undefined ? b.beat : existing.beat,
      mediaType: b.mediaType !== undefined ? b.mediaType : existing.mediaType,
      sentiment: b.sentiment !== undefined ? b.sentiment : existing.sentiment,
      widthCm: b.widthCm !== undefined ? b.widthCm : existing.widthCm,
      heightCm: b.heightCm !== undefined ? b.heightCm : existing.heightCm,
      reviewed: true,
      needsReview: false
    };

    liveFeedStorage[index] = updatedEntry;

    if (db) {
      const copy = { ...updatedEntry };
      delete copy.id;
      await db.collection('media_news').doc(id).set(copy, { merge: true });
    }

    res.json({ success: true, entry: updatedEntry });
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
