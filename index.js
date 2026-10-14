const express = require('express');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const QRCode = require('qrcode');

const app = express();
app.use(express.json({ limit: '20mb' }));
const port = process.env.PORT || 3000;

// Serve public directory
app.use(express.static(path.join(__dirname, 'public')));

// 1. Firebase Initialization
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin initialized successfully');
  } catch (e) {
    console.error('Firebase Admin init failed:', e.message);
  }
}
const db = admin.apps.length ? admin.firestore() : null;

// 2. WhatsApp Client State
let latestQrDataUrl = '';
let connectionStatus = 'Initializing...';

// Group Whitelist: Sirf inhi groups ka message read hoga (Khali chhodne par saare groups read honge)
// Yahan aap apne testing group ya office group ka exact naam likh sakte hain
const ALLOWED_GROUPS = []; // e.g. ["Daily Steel News", "PR Media Monitoring"]

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', async (qr) => {
  latestQrDataUrl = await QRCode.toDataURL(qr);
  connectionStatus = 'Scan QR Code';
  console.log('New WhatsApp QR code generated');
});

client.on('ready', () => {
  latestQrDataUrl = '';
  connectionStatus = 'Connected & Monitoring Active';
  console.log('WhatsApp Bot is Live and Ready!');
});

client.on('disconnected', (reason) => {
  connectionStatus = 'Disconnected: ' + reason;
  latestQrDataUrl = '';
  console.log('WhatsApp Disconnected:', reason);
});

// 3. Message Classifier Engine
const TARGET_COMPANIES = [
  'AM/NS India', 'Tata Steel', 'JSW Steel', 'RSP', 'SAIL', 
  'JSL', 'JSPL', 'NALCO', 'Vedanta', 'Aditya Aluminium', 
  'Maithan', 'MCL', 'Hindalco', 'Visa Steel', 'CIL'
];

client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();
    
    // Group filter check
    if (!chat.isGroup) return;
    if (ALLOWED_GROUPS.length > 0 && !ALLOWED_GROUPS.includes(chat.name)) {
      return;
    }

    let textContent = msg.body || '';
    let mediaBase64 = null;

    // Media (Newspaper cutting/photo) check
    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      if (media && media.mimetype && media.mimetype.startsWith('image/')) {
        mediaBase64 = `data:${media.mimetype};base64,${media.data}`;
      }
    }

    if (!textContent.trim() && !mediaBase64) return;

    // Detect Target Company
    let detectedCompany = 'Other';
    for (const comp of TARGET_COMPANIES) {
      const pattern = new RegExp(`\\b${comp.replace('/', '\\/')}\\b`, 'i');
      if (pattern.test(textContent)) {
        detectedCompany = comp;
        break;
      }
    }

    // Detect Beat / Category
    let detectedBeat = 'Corporate';
    if (/csr|gram|community|health|school|welfare|blood/i.test(textContent)) detectedBeat = 'CSR';
    else if (/plant|blast furnace|expansion|production|commission|capacity/i.test(textContent)) detectedBeat = 'Plant';
    else if (/hr|appoint|employee|bonus|union|safety|workers/i.test(textContent)) detectedBeat = 'HR';
    else if (/product|launch|tmt|grade|steel coil|export/i.test(textContent)) detectedBeat = 'Product';

    // Detect Tone / Sentiment
    let detectedSentiment = 'Neutral';
    if (/award|growth|profit|record|achieve|milestone|inaugurat|honor/i.test(textContent)) detectedSentiment = 'Positive';
    else if (/strike|protest|accident|death|loss|fine|penalty|leak/i.test(textContent)) detectedSentiment = 'Negative';

    // Detect Media Type
    let detectedMedia = 'Online';
    if (mediaBase64 || /page|edition|samaja|sambad|dharitri|express/i.test(textContent)) detectedMedia = 'Print';
    else if (/bulletin|live|channel|kanak|otv|kalinga/i.test(textContent)) detectedMedia = 'Channel';

    const entry = {
      company: detectedCompany,
      headline: textContent.slice(0, 200) || (mediaBase64 ? 'Newspaper Clipping Image' : 'WhatsApp Update'),
      rawContent: textContent,
      beat: detectedBeat,
      mediaType: detectedMedia,
      sentiment: detectedSentiment,
      groupName: chat.name,
      sender: msg.author || msg.from,
      timestamp: new Date().toISOString(),
      clipImage: mediaBase64 || null
    };

    if (db) {
      await db.collection('media_news').add(entry);
      console.log(`Saved entry for [${detectedCompany}] from group [${chat.name}]`);
    }
  } catch (err) {
    console.error('Error handling message:', err.message);
  }
});

client.initialize();

// Status API
app.get('/api/status', (req, res) => {
  res.json({ status: connectionStatus, qr: latestQrDataUrl });
});

// Logout / Switch WhatsApp Account Endpoint
app.post('/api/logout', async (req, res) => {
  try {
    await client.logout();
    connectionStatus = 'Logged Out. Refreshing QR...';
    latestQrDataUrl = '';
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
