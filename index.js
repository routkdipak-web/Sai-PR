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

const BEATS = ['CSR', 'Plant', 'HR', 'Corporate', 'Product'];   // Legal/Environment hata diye
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
const MAX_FEED = 2000;   // dashboard me itni purani entries (images memory me nahi rakhte)

// Negative news par WhatsApp alert: ALERT_NUMBERS=919XXXXXXXXX,919YYYYYYYYY (Render env)
const ALERT_NUMBERS = (process.env.ALERT_NUMBERS || '')
  .split(',')
  .map(n => n.replace(/\D/g, ''))
  .filter(Boolean)
  .map(n => (n.length === 10 ? '91' + n : n));

// Decrypt-error auto recovery settings
const DECRYPT_ERR_LIMIT = 5;            // itne errors...
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

const FEED_FIELDS = [
  'company', 'headline', 'headlineOriginal', 'summary', 'publication', 'page', 'edition',
  'paperDate', 'rawContent', 'link', 'beat', 'mediaType', 'sentiment', 'needsReview',
  'reviewed', 'groupName', 'sender', 'timestamp', 'hasImage', 'imageTooLarge',
  'widthCm', 'heightCm'
];

const imageCache = new Map(); // sirf jab Firebase na ho

// Image memory me nahi, sirf URL: /api/news/:id/image
function withImageUrl(id, data) {
  const out = { id, ...data };
  const hasImg = data.hasImage === true || (data.hasImage === undefined && !data.link && data.mediaType === 'Print');
  out.clipImage = hasImg ? `/api/news/${encodeURIComponent(id)}/image` : null;
  delete out.hasImage;
  return out;
}

async function loadFeedFromFirestore() {
  if (!db) return;
  try {
    const snap = await db.collection('media_news')
      .orderBy('timestamp', 'desc')
      .select(...FEED_FIELDS)
      .limit(MAX_FEED)
      .get();
    liveFeedStorage = snap.docs.map(d => withImageUrl(d.id, d.data()));
    console.log(`Loaded ${liveFeedStorage.length} saved news items from Firestore`);
  } catch (e) {
    console.error('Load feed error:', e.message);
  }
}

async function saveEntry(entry) {
  const rawImage = entry.clipImage || null;
  const tooLarge = !!rawImage && rawImage.length > MAX_IMAGE_CHARS_FOR_FIRESTORE;
  const storedImage = tooLarge ? null : rawImage;

  // Memory me image nahi, sirf URL
  const mem = { ...entry, clipImage: storedImage ? `/api/news/${encodeURIComponent(entry.id)}/image` : null };
  if (tooLarge) mem.imageTooLarge = true;
  liveFeedStorage.unshift(mem);
  if (liveFeedStorage.length > MAX_FEED) liveFeedStorage.pop();

  if (db) {
    try {
      const copy = { ...entry, clipImage: storedImage, hasImage: !!storedImage };
      delete copy.id;
      if (tooLarge) copy.imageTooLarge = true;
      await db.collection('media_news').doc(entry.id).set(copy);
    } catch (e) {
      console.error('Firestore save error:', e.message);
    }
  } else if (storedImage) {
    imageCache.set(entry.id, storedImage);
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

1. headline_en: The real headline of the news${kind === 'print' ? ' as PRINTED in the clipping image' : ''}, translated to simple, accurate English (max 18 words). Do not add facts that are not in the headline. If it cannot be read clearly, return "".

2. summary_en: 3-4 factual English sentences covering who, what, where, when, numbers, and the company's role. Rules:
   - Use only facts present in the content. Keep every name, number, amount (Rs/crore/lakh/tonnes), date and place EXACTLY as given.
   - NO opinion or praise words (do not write "prestigious", "remarkable", "landmark" etc. unless that word is quoted in the content).
   - Do NOT add statements like "several organisations participated" unless the content says so.
   - If the content is very short, write fewer sentences. Never pad. If unreadable, return "".
   - Odia/Hindi names: write the standard English spelling of the name; if unsure of a name, transliterate carefully.

3. publication: ${kind === 'print' ? 'The newspaper name exactly as printed on the clipping (masthead/header) or given in the caption. If it is not visible and not in the caption, write "Other".' : 'The website/channel name only if clearly stated in the content, else "Other".'}

4. page: ${kind === 'print' ? 'Page number as digits only, ONLY if printed on the clipping or written in the caption. Otherwise "".' : 'Always "" (online content has no page number).'}

5. edition: ${kind === 'print' ? 'City edition only if printed or in the caption (e.g. Bhubaneswar, Cuttack, Rourkela). Otherwise "".' : 'Always "".'}

6. company: Choose exactly ONE from this list, or "Other":
   ${TARGET_COMPANIES.join(', ')}
   Meaning of short names: AM/NS India = ArcelorMittal Nippon Steel India; RSP = Rourkela Steel Plant (SAIL's plant); SAIL = Steel Authority of India (corporate, other plants); JSL = Jindal Stainless; JSPL = Jindal Steel & Power; NALCO = National Aluminium Company; MCL = Mahanadi Coalfields; CIL = Coal India; Aditya Aluminium = Hindalco's Aditya plant; Maithan = Maithan Ispat/Maithan Group; Visa Steel = Visa Steel Ltd.
   Pick the company the news is MAINLY about. If the news is about a listed company's unit (e.g. Tata Steel Kalinganagar) pick that company. If the main subject is none of the listed companies, or you cannot tell, write "Other". Do not pick a company just because it is mentioned in passing.

7. beat: Choose exactly ONE of: ${BEATS.join(', ')} or "Other".
   - CSR: community work, village/school/health camps, donations, scholarships, social welfare, rural development.
   - Plant: production, operations, capacity expansion, commissioning, shutdown, plant projects, infrastructure, technology at the plant.
   - HR: employees/workforce, recruitment, training, labour union issues, workplace accidents or deaths of workers.
   - Corporate: awards & recognitions, financial results, agreements/MoUs, top leadership & appointments, governance/vigilance events, policy, investments, general company news.
   - Product: new products/grades, launches, sales, exports, marketing, customers.
   Choose by the MAIN focus of the news. If none clearly fits, write "Other".

8. media_type: ${kind === 'print' ? '"Print"' : kind === 'link' ? '"Digital"' : 'One of: Print (newspaper), Digital (website/web portal/online/social media), Satellite (TV channel). If unclear write "Other"'}.

9. sentiment: Judge how the news reflects on the company/industry, ONLY from what the content says:
   - "Positive": awards, recognition, new investment, inauguration, record production/profit, achievements, CSR benefit to people, praise.
   - "Negative": accident, death, injury, protest, strike, shutdown/closure, penalty/fine/court case against the company, pollution allegation, corruption/scam, criticism.
   - "Neutral": plain factual/routine information with no clearly good or bad angle (schedules, statements, appointments, meetings).
   If the content is unreadable or too little to judge, write "Other".

10. needs_review: true if you were unsure about ANY field or the clipping was blurry/partly cut; otherwise false.

Return ONLY this pure JSON object, nothing else:
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
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelToTry + ':generateContent?key=' + GEMINI_API_KEY;
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

async function callClaude(imageDataUrl, text, kind) {
  const content = [];
  if (imageDataUrl) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: imageDataUrl.split(',')[1] }
    });
  }
  content.push({ type: 'text', text: buildPrompt(text, kind) });

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
        const retryable = /abort|timeout|overload|busy|unavailable|429|503|rate/i.test(err.message);
        if (attempt === 2 || !retryable) throw err;
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
    console.error('AI analysis error:', e.message);
    return null;
  }
}

// List me se exact match nahi mila to "Other" - kabhi andaza nahi
function pickFrom(list, value, fallback) {
  const hit = list.find(x => x.toLowerCase() === String(value || '').trim().toLowerCase());
  return hit || fallback;
}

function cleanPublication(v) {
  const t = String(v || '').trim();
  if (!t || t.length > 60 || /^(other|unknown|n\/a|none|-)$/i.test(t)) return '';
  return t;
}

// Final entry ke fields ek jagah validate hote hain (print / link / text)
function finalizeFields({ ai, kind, cap, link, textContent }) {
  const isPrint = kind === 'print';
  const isLink = kind === 'link';

  // Company: AI ne bola to wahi; AI chala hi nahi to hi keyword (exact naam) se
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
    // Caption (insaan ka diya hua) sabse bharosemand, phir AI
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
// LINK HANDLING (facebook / odisharay / odishanewsonline etc.)
// ---------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

const DOMAIN_PUBLICATION = {
  'odisharay.com': 'Odisha Ray',
  'orissadiary.com': 'Odisha Diary',
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
  const empty = { title: '', description: '', body: '', siteName: '' };
  try {
    const res = await fetchWithTimeout(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en,hi;q=0.8,or;q=0.7'
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

    // Article ka asli text (paragraphs) - summary sahi banane ke liye
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ');
    const paras = [];
    const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      const t = decodeHtml(m[1].replace(/<[^>]+>/g, ' '));
      if (t.length > 40) paras.push(t);
      if (paras.join(' ').length > 5000) break;
    }
    return { title, description, body: paras.join(' ').slice(0, 5000), siteName };
  } catch (e) {
    return empty;
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

  // Hamesha page se article text lene ki koshish (summary ke liye)
  const p = await fetchLinkPreview(ext.matchedText || url);
  if (!title) title = GENERIC_TITLES.test(p.title) ? '' : p.title;
  if (!description) description = p.description;

  const domain = domainOf(url);
  let publication = publicationFromDomain(domain);
  if (publication === domain && p.siteName && !GENERIC_TITLES.test(p.siteName)) publication = p.siteName;
  return { url, domain, title, description, body: p.body, publication };
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

// Sirf "Media track" jaise allowed group ki JID yaad rakhte hain.
// Baaki groups ke messages ko na decrypt karte hain na process (system halka rehta hai).
const allowedJids = new Set();
let groupsLoaded = false;
let groupRefreshTimer = null;

async function refreshAllowedGroups() {
  if (!sock || ALLOWED_GROUPS.length === 0) { groupsLoaded = true; return; }
  try {
    const all = await sock.groupFetchAllParticipating();
    allowedJids.clear();
    for (const [jid, meta] of Object.entries(all || {})) {
      const name = String(meta?.subject || '').toLowerCase();
      groupNameCache.set(jid, meta?.subject || jid);
      if (ALLOWED_GROUPS.some(a => name.includes(a))) allowedJids.add(jid);
    }
    groupsLoaded = true;
    console.log(`Allowed groups: ${allowedJids.size} mile (${[...allowedJids].map(j => groupNameCache.get(j)).join(', ') || 'koi nahi - group ka naam check karo'})`);
  } catch (e) {
    console.error('Group list load failed:', e.message);
    setTimeout(() => refreshAllowedGroups().catch(() => {}), 15000);
  }
}

function isAllowedSync(jid) {
  if (ALLOWED_GROUPS.length === 0) return true;
  return allowedJids.has(jid);
}

async function isGroupAllowed(jid) {
  if (ALLOWED_GROUPS.length === 0) return true;
  if (allowedJids.has(jid)) return true;
  if (groupsLoaded) return false;          // list aa chuki hai to baaki sab group ignore
  const name = (await getGroupName(jid)).toLowerCase();  // list abhi load nahi hui (shuruaat)
  return ALLOWED_GROUPS.some(allowed => name.includes(allowed));
}

// --- Decrypt error detector (Bad MAC etc.) ---
const DECRYPT_RE = /Bad MAC|Failed to decrypt|No matching sessions|No session found|MessageCounterError|Over 2000 messages|Invalid PreKey|No SenderKeyRecord|SenderKey/i;
let decryptErrTimes = [];
let lastDecryptCountAt = 0;
let suppressedLogCount = 0;

const BOOT_AT = Date.now();
let lastOpenAt = 0;
function noteDecryptError(jid) {
  // Sirf allowed group ke decrypt error ginte hain; baaki groups/DM ke errors se recovery nahi chalegi
  if (!jid || !groupsLoaded || !isAllowedSync(jid)) return;
  const now = Date.now();
  // Render deploy ke time purana + naya instance kuch second saath chalte hain, tab ke errors ginti me nahi
  if (now - BOOT_AT < 90000) return;
  // Reconnect ke baad WhatsApp purane pending messages dobara bhejta hai, unke errors recovery trigger na karein
  if (now - lastOpenAt < 45000) return;
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
      return;
    }
    orig(...args);
  };
}
console.error = filterConsole(origConsoleError);
console.warn = filterConsole(origConsoleWarn);

const waLogger = pino({ level: 'error' }, {
  write(line) {
    if (DECRYPT_RE.test(line)) {
      let jid = '';
      try { const o = JSON.parse(line); jid = o?.key?.remoteJid || o?.remoteJid || ''; } catch (e) {}
      noteDecryptError(jid);
      return;
    }
    // baaki errors bhi chhote form me dikhao
    try {
      const o = JSON.parse(line);
      origConsoleError('[wa]', o.msg || o.err?.message || line.slice(0, 200));
    } catch (e) {}
  }
});

function teardownSocket() {
  if (groupRefreshTimer) { clearInterval(groupRefreshTimer); groupRefreshTimer = null; }
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
    // Dusre groups / status / channels ke messages ko decrypt hi mat karo
    shouldIgnoreJid: (jid) => {
      if (!jid) return false;
      if (jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return true;
      if (jid.endsWith('@g.us') && ALLOWED_GROUPS.length > 0 && groupsLoaded) return !allowedJids.has(jid);
      return false;
    },
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
      lastOpenAt = Date.now();
      reconnectAttempts = 0;
      setTimeout(() => { if (myGen === botGen) refreshAllowedGroups().catch(() => {}); }, 2500);
      if (groupRefreshTimer) clearInterval(groupRefreshTimer);
      groupRefreshTimer = setInterval(() => { if (myGen === botGen) refreshAllowedGroups().catch(() => {}); }, 30 * 60 * 1000);
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
    for (const msg of m.messages) {
      // 'notify' = live message. 'append' = reconnect ke baad aaye pending messages: sirf taaza (15 min) wale lo
      const ts = Number(msg?.messageTimestamp?.low ?? msg?.messageTimestamp ?? 0);
      const recent = ts && (Date.now() / 1000 - ts) < 900;
      if (m.type !== 'notify' && !(m.type === 'append' && recent)) continue;

      const jid = msg?.key?.remoteJid || '';
      if (jid.endsWith('@g.us') && groupsLoaded && !isAllowedSync(jid)) continue;   // doosre groups: bilkul ignore
      if (jid.endsWith('@g.us')) {
        if (!msg.message) console.log(`[incoming] undecryptable group message (stub ${msg.messageStubType || '-'}) - WhatsApp retry ka wait`);
        else console.log(`[incoming] ${Object.keys(msg.message)[0]} (${m.type}) from group`);
      }
      messageChain = messageChain
        .then(() => processMessage(msg, newSock))
        .catch(e => console.error('Message error:', e.message));
    }
  });
}

// ---------------------------------------------------------------
// NEGATIVE NEWS ALERT (WhatsApp)
// ---------------------------------------------------------------

async function sendNegativeAlert(entry) {
  if (!ALERT_NUMBERS.length || !sock || isRecovering || isLoggingOut) return;
  const lines = [
    '🔴 *NEGATIVE NEWS ALERT*',
    `*Company:* ${entry.company}`,
    `*Headline:* ${entry.headline}`,
    `*Source:* ${entry.publication || 'Other'}${entry.page ? ', Pg ' + entry.page : ''}${entry.edition ? ' (' + entry.edition + ')' : ''} | ${entry.mediaType}`,
    entry.summary ? `*Summary:* ${entry.summary.slice(0, 350)}${entry.summary.length > 350 ? '...' : ''}` : '',
    entry.link ? `*Link:* ${entry.link}` : '',
    entry.needsReview ? '_(Auto-detected: please verify on dashboard)_' : ''
  ].filter(Boolean).join('\n');

  for (const num of ALERT_NUMBERS) {
    try {
      const sent = await sock.sendMessage(`${num}@s.whatsapp.net`, { text: lines });
      if (sent?.key?.id && sent.message) {
        sentMessageCache.set(sent.key.id, sent.message);
        if (sentMessageCache.size > 200) sentMessageCache.delete(sentMessageCache.keys().next().value);
      }
    } catch (e) {
      console.error('Alert send failed:', e.message);
    }
  }
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

    // Link message?
    const link = mediaBase64 ? null : await getLinkInfo(m0, textContent);

    // Wahi link pehle aa chuka ho to dobara entry nahi
    if (link && liveFeedStorage.some(e => e.link && e.link === link.url)) {
      console.log('Duplicate link skipped:', link.url);
      return;
    }

    const kind = mediaBase64 ? 'print' : (link ? 'link' : 'text');
    const userNote = link ? textContent.replace(URL_RE, '').trim() : textContent;
    const aiText = link
      ? [
          link.title && `TITLE: ${link.title}`,
          link.description && `DESCRIPTION: ${link.description}`,
          link.body && `ARTICLE TEXT: ${link.body}`,
          userNote && `SENDER NOTE: ${userNote}`
        ].filter(Boolean).join('\n')
      : textContent;

    const canAnalyse = mediaBase64 || aiText.trim().length > 15;
    let ai = null;
    if (AI_ENABLED && canAnalyse) {
      try {
        ai = await analyzeNews(mediaBase64, aiText, kind);
      } catch (err) {
        ai = null;
      }
    }

    const f = finalizeFields({ ai, kind, cap, link, textContent });

    let fallbackHeadline;
    if (kind === 'print') {
      fallbackHeadline = 'Newspaper Clipping News';
    } else if (link) {
      fallbackHeadline = link.title || (userNote ? userNote.slice(0, 200) : `Link: ${link.domain}`);
    } else {
      fallbackHeadline = textContent.slice(0, 200);
    }

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
    console.log(`Saved${f.needsReview ? ' (CHECK)' : ''}: [${f.company}] ${entry.headline.slice(0, 80)}`);
    if (f.sentiment === 'Negative') sendNegativeAlert(entry).catch(() => {});
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
  if (DECRYPT_RE.test(text)) { return; }
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
  res.json({ status: connectionStatus, qr: latestQrDataUrl, alerts: ALERT_NUMBERS.length });
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
      try {
        ai = await analyzeNews(b.clipImage || null, typedHeadline, kind);
      } catch (e) {
        ai = null;
      }
    }
    const cap = parseClipCaption(typedHeadline);
    const f = finalizeFields({ ai, kind, cap, link: null, textContent: typedHeadline });

    // Manual form me jo insaan ne chuna, AI "Other" de to wahi use hoga
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

app.get('/api/news/:id/image', async (req, res) => {
  try {
    const id = req.params.id;
    let dataUrl = imageCache.get(id) || null;
    if (!dataUrl && db) {
      const doc = await db.collection('media_news').doc(id).get();
      dataUrl = doc.exists ? doc.data().clipImage : null;
    }
    const m = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
    if (!m) return res.status(404).end();
    res.set('Content-Type', m[1]);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(m[2], 'base64'));
  } catch (err) {
    res.status(500).end();
  }
});

// Row edit: insaan ne jo sudhara wahi final (reviewed = true)
app.put('/api/news/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const idx = liveFeedStorage.findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Entry nahi mili' });

    const b = req.body || {};
    const txt = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
    const num = (v) => {
      if (v === '' || v == null) return null;
      const n = parseFloat(v);
      return Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.round(n * 100) / 100 : null;
    };

    const upd = {
      company: pickFrom([...TARGET_COMPANIES, 'Other'], b.company, 'Other'),
      headline: txt(b.headline, 300),
      summary: txt(b.summary, 1200),
      publication: txt(b.publication, 80) || 'Other',
      page: txt(b.page, 6).replace(/[^\d]/g, ''),
      edition: txt(b.edition, 60),
      beat: pickFrom(BEATS, b.beat, 'Other'),
      mediaType: pickFrom(MEDIA_TYPES, b.mediaType, 'Other'),
      sentiment: pickFrom(SENTIMENTS, b.sentiment, 'Other'),
      widthCm: num(b.widthCm),
      heightCm: num(b.heightCm),
      reviewed: true,
      needsReview: false,
      editedAt: new Date().toISOString()
    };
    if (!upd.headline) return res.status(400).json({ success: false, error: 'Headline khali nahi ho sakti' });

    liveFeedStorage[idx] = { ...liveFeedStorage[idx], ...upd };
    if (db) await db.collection('media_news').doc(id).set(upd, { merge: true });
    res.json({ success: true, entry: liveFeedStorage[idx] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/news/:id', async (req, res) => {
  try {
    const id = req.params.id;
    liveFeedStorage = liveFeedStorage.filter(e => e.id !== id);
    imageCache.delete(id);
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
