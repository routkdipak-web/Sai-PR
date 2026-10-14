const express = require('express');
const path = require('path');
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

// Serve frontend dashboard
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Fallback Storage (Jab tak Firebase setup na ho)
let liveFeedStorage = [];

// 1. Firebase Admin Setup
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin connected successfully');
  } catch (e) {
    console.error('Firebase Admin Error:', e.message);
  }
}
const db = admin.apps.length ? admin.firestore() : null;

// 2. WhatsApp State & Configuration
let latestQrDataUrl = '';
let connectionStatus = 'Starting WhatsApp Engine...';
let sock = null;

// Group Whitelist: Khali chhodne par saare groups listen honge
const ALLOWED_GROUPS = [];

const TARGET_COMPANIES = [
  'AM/NS India', 'Tata Steel', 'JSW Steel', 'RSP', 'SAIL', 
  'JSL', 'JSPL', 'NALCO', 'Vedanta', 'Aditya Aluminium', 
  'Maithan', 'MCL', 'Hindalco', 'Visa Steel', 'CIL'
];

// 3. Ultra-Lightweight WhatsApp Socket Engine
async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

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
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed, reconnecting:', shouldReconnect);
      connectionStatus = shouldReconnect ? 'Reconnecting...' : 'Logged Out';
      if (shouldReconnect) {
        startWhatsAppBot();
      } else {
        latestQrDataUrl = '';
      }
    }
  });

  // 4. Group Message & Image Clipping Listener
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      // fromMe filter hata diya gaya hai - ab aapka khud ka bheja message bhi catch hoga!
      if (!msg || !msg.message) return;

      const remoteJid = msg.key.remoteJid || '';
      const isGroup = remoteJid.endsWith('@g.us');

      // Sirf WhatsApp Groups monitor honge
      if (!isGroup) return;

      let textContent = '';
      let mediaBase64 = null;

      // Extract text from conversation, reply, ya image caption
      if (msg.message.conversation) {
        textContent = msg.message.conversation;
      } else if (msg.message.extendedTextMessage?.text) {
        textContent = msg.message.extendedTextMessage.text;
      } else if (msg.message.imageMessage?.caption) {
        textContent = msg.message.imageMessage.caption;
      }

      // Extract image clipping if present
      if (msg.message.imageMessage) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          mediaBase64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
        } catch (imgErr) {
          console.error('Image Download Error:', imgErr.message);
        }
      }

      if (!textContent.trim() && !mediaBase64) return;

      // Company Tagging
      let detectedCompany = 'Other';
      for (const comp of TARGET_COMPANIES) {
        const pattern = new RegExp(`\\b${comp.replace('/', '\\/')}\\b`, 'i');
        if (pattern.test(textContent)) {
          detectedCompany = comp;
          break;
        }
      }

      // Beat Tagging
      let detectedBeat = 'Corporate';
      if (/csr|gram|community|health|school|welfare|blood/i.test(textContent)) detectedBeat = 'CSR';
      else if (/plant|blast furnace|expansion|production|commission|capacity/i.test(textContent)) detectedBeat = 'Plant';
      else if (/hr|appoint|employee|bonus|union|safety|workers/i.test(textContent)) detectedBeat = 'HR';
      else if (/product|launch|tmt|grade|steel coil|export/i.test(textContent)) detectedBeat = 'Product';

      // Tone / Sentiment Tagging
      let detectedSentiment = 'Neutral';
      if (/award|growth|profit|record|achieve|milestone|inaugurat|honor/i.test(textContent)) detectedSentiment = 'Positive';
      else if (/strike|protest|accident|death|loss|fine|penalty|leak/i.test(textContent)) detectedSentiment = 'Negative';

      // Media Type
      let detectedMedia = 'Online';
      if (mediaBase64 || /page|edition|samaja|sambad|dharitri|express/i.test(textContent)) detectedMedia = 'Print';
      else if (/bulletin|live|channel|kanak|otv|kalinga/i.test(textContent)) detectedMedia = 'Channel';

      const entry = {
        id: Date.now().toString(),
        company: detectedCompany,
        headline: textContent.slice(0, 200) || (mediaBase64 ? 'Newspaper Clipping Image' : 'WhatsApp Update'),
        rawContent: textContent,
        beat: detectedBeat,
        mediaType: detectedMedia,
        sentiment: detectedSentiment,
        groupName: remoteJid,
        sender: msg.key.participant || (msg.key.fromMe ? 'Admin (You)' : remoteJid),
        timestamp: new Date().toISOString(),
        clipImage: mediaBase64 || null
      };

      // In-Memory store me save
      liveFeedStorage.unshift(entry);
      if (liveFeedStorage.length > 300) liveFeedStorage.pop();

      // Firebase me save (agar keys active hon)
      if (db) {
        await db.collection('media_news').add(entry);
      }

      console.log(`[Captured News] ${detectedCompany} | ${detectedBeat} | ${detectedSentiment} | Sender: ${entry.sender}`);

    } catch (err) {
      console.error('Error handling upsert:', err.message);
    }
  });
}

startWhatsAppBot();

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({ status: connectionStatus, qr: latestQrDataUrl });
});

// Live Feed Endpoint (Taaki bina Firebase ke bhi dashboard par 2 second me data dikhe)
app.get('/api/news-feed', (req, res) => {
  res.json({ success: true, data: liveFeedStorage });
});

// Logout / Switch WhatsApp Account Endpoint
app.post('/api/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      connectionStatus = 'Logged Out. Refreshing QR...';
      latestQrDataUrl = '';
      startWhatsAppBot();
    }
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(port, () => {
  console.log(`PR Hub listening on port ${port}`);
});
