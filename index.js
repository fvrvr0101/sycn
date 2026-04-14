require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
let db;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("Firebase initialized.");
  } else {
    console.warn("FIREBASE_SERVICE_ACCOUNT not found in .env. Firebase not initialized.");
  }
} catch (error) {
  console.error("Firebase Initialization Error:", error.message);
}

// Initialize Telegram Bot
const botToken = process.env.TELEGRAM_BOT_TOKEN;
let bot;
if (botToken && botToken !== "your_bot_token_here") {
  bot = new TelegramBot(botToken, { polling: true });
  console.log("Telegram Bot initialized.");

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "Welcome to the Personal Notification Sync Bot! To connect a device, run: /connect <pair_code>");
  });

  bot.onText(/\/connect (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const pairCode = match[1];

    if (!db) {
      return bot.sendMessage(chatId, "Server error: Firebase not configured.");
    }

    try {
      const codesRef = db.collection('pairCodes').doc(pairCode);
      const codeDoc = await codesRef.get();

      if (!codeDoc.exists) {
        return bot.sendMessage(chatId, "Invalid or expired pair code.");
      }

      const deviceId = codeDoc.data().deviceId;

      // Update device binding
      await db.collection('devices').doc(deviceId).set({
        chatId: chatId,
        connectedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // Delete the used pair code
      await codesRef.delete();

      bot.sendMessage(chatId, "Device successfully connected! You will now receive notifications here.");
    } catch (e) {
      console.error(e);
      bot.sendMessage(chatId, "Error connecting device.");
    }
  });

  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    if (!db) return bot.sendMessage(chatId, "Database offline.");
    bot.sendMessage(chatId, "Bot is running and listening for notifications.");
  });
} else {
  console.warn("TELEGRAM_BOT_TOKEN not found in .env. Bot not running.");
}


// API Endpoint: App requests a pairing code
app.post('/api/generate-code', async (req, res) => {
  if (!db) return res.status(500).json({ error: "Firebase not configured." });

  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: "Device ID required." });

  try {
    const device = await db.collection('devices').doc(deviceId).get();
    if (device.exists && device.data().chatId) {
      return res.status(400).json({ error: "Device is already paired!" });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Clean up any previously generated un-used pair codes for this device to prevent clutter
    const prevCodes = await db.collection('pairCodes').where('deviceId', '==', deviceId).get();
    const batch = db.batch();
    prevCodes.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();

    await db.collection('pairCodes').doc(code).set({
      deviceId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ code });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to generate code." });
  }
});

// API Endpoint: App sends a notification
app.post('/api/notifications', async (req, res) => {
  if (!db || !bot) return res.status(500).json({ error: "Server missing DB or Bot integration." });

  const { deviceId, appName, title, text } = req.body;
  if (!deviceId || !appName) return res.status(400).json({ error: "Missing notification data." });

  try {
    const deviceDoc = await db.collection('devices').doc(deviceId).get();
    if (!deviceDoc.exists) {
      return res.status(401).json({ error: "Device not paired." });
    }

    const chatId = deviceDoc.data().chatId;
    if (chatId) {
      let extText = text ? text : '';
      const message = `📱 *${appName}*\n*${title || 'No Title'}*\n${extText}`;
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      res.json({ success: true });
    } else {
      res.status(401).json({ error: "Device has no associated Chat ID." });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to forward notification." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend server listening on port ${PORT}`);
});
