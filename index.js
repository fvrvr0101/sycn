require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const fs = require('fs');
const upload = multer({ dest: 'uploads/' });

const app = express();
app.use(cors());
app.use(express.json());

let db;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("🔥 Firebase database initialized.");
  } else {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT missing!");
  }
} catch (error) {
  console.error("Firebase Initialization Error:", error.message);
}

const botToken = process.env.TELEGRAM_BOT_TOKEN;
let bot;

if (botToken && botToken !== "your_bot_token_here") {
  bot = new TelegramBot(botToken, { polling: true });
  console.log("🤖 Telegram Bot online.");

  bot.setMyCommands([
    { command: '/start', description: 'Start the bot and open main menu' },
    { command: '/status', description: 'Check connected devices and server status' },
    { command: '/help', description: 'Show how to use the bot' },
    { command: '/disconnect', description: 'Stop receiving notifications' }
  ]);

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const welcomeText = `👋 *Welcome to NotifySync Bot!*\n\nI will privately forward all notifications from your Android device right to this chat.\n\n👇 *Use the buttons below or send* \`/connect <code>\` *to pair a new device.*`;
    
    const options = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📱 Check Status', callback_data: 'action_status' }],
          [{ text: '❓ Help', callback_data: 'action_help' }]
        ]
      }
    };
    bot.sendMessage(chatId, welcomeText, options);
  });

  bot.on('callback_query', async (callbackQuery) => {
    const action = callbackQuery.data;
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;

    if (action === 'action_status') {
      await handleStatus(chatId);
    } else if (action === 'action_help') {
      await handleHelp(chatId);
    }
    bot.answerCallbackQuery(callbackQuery.id);
  });

  bot.onText(/\/help/, (msg) => handleHelp(msg.chat.id));
  
  async function handleHelp(chatId) {
    const helpText = `📖 *NotifySync Guide*\n\n1. Install the Android App on your phone.\n2. Open the App and grant the Notification permission.\n3. Click "Generate Pairing Code" in the App.\n4. Send \`/connect <code>\` to this bot (Example: \`/connect 123456\`).\n5. Start the local sync service in the app.\n\n*Commands:*\n/start - Open Main Menu\n/status - View connected devices\n/disconnect - Unpair all devices`;
    bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
  }

  bot.onText(/\/status/, (msg) => handleStatus(msg.chat.id));

  async function handleStatus(chatId) {
    if (!db) return bot.sendMessage(chatId, "⚠️ Server Error: Database offline.");
    try {
      const devicesSnapshot = await db.collection('devices').where('chatId', '==', chatId).get();
      if (devicesSnapshot.empty) {
        bot.sendMessage(chatId, "📉 *Status:* No devices are currently connected to this chat.\n\nUse `/connect <code>` to link one.", { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, `📈 *Status:* You have **${devicesSnapshot.size}** device(s) currently forwarding notifications to this chat. They are securely monitored.`, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      bot.sendMessage(chatId, "⚠️ Could not fetch status. Database error.");
    }
  }

  bot.onText(/\/disconnect/, async (msg) => {
    const chatId = msg.chat.id;
    if (!db) return bot.sendMessage(chatId, "⚠️ Database offline.");
    
    try {
      const devices = await db.collection('devices').where('chatId', '==', chatId).get();
      if (devices.empty) {
        return bot.sendMessage(chatId, "You have no connected devices to disconnect.");
      }
      
      const batch = db.batch();
      devices.forEach(doc => {
        batch.delete(doc.ref);
      });
      await batch.commit();

      bot.sendMessage(chatId, "🛑 *Disconnected!* Your devices have been un-linked. You will no longer receive notifications here.", { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, "⚠️ Error during disconnect.");
    }
  });

  bot.onText(/\/connect (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const pairCode = match[1];

    if (!db) return bot.sendMessage(chatId, "⚠️ Server error: Firebase not configured.");

    try {
      const codesRef = db.collection('pairCodes').doc(pairCode);
      const codeDoc = await codesRef.get();

      if (!codeDoc.exists) {
        return bot.sendMessage(chatId, "❌ *Invalid or expired pair code.*", { parse_mode: 'Markdown' });
      }

      const deviceId = codeDoc.data().deviceId;

      await db.collection('devices').doc(deviceId).set({
        chatId: chatId,
        connectedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      await codesRef.delete();

      bot.sendMessage(chatId, "✅ *Device Successfully Connected!*\n\nI am now securely listening to your phone. All new incoming notifications will be forwarded here instantly.", { parse_mode: 'Markdown' });
    } catch (e) {
      console.error(e);
      bot.sendMessage(chatId, "⚠️ Error connecting device.");
    }
  });

} else {
  console.warn("⚠️ TELEGRAM_BOT_TOKEN missing.");
}


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

app.post('/api/notifications', async (req, res) => {
  if (!db || !bot) return res.status(500).json({ error: "Server missing DB or Bot." });

  const { deviceId, appName, title, text } = req.body;
  if (!deviceId || !appName) return res.status(400).json({ error: "Missing data." });

  try {
    const deviceDoc = await db.collection('devices').doc(deviceId).get();
    if (!deviceDoc.exists) return res.status(401).json({ error: "Device not paired." });

    const chatId = deviceDoc.data().chatId;
    if (chatId) {
      let safeTitle = title ? title.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1') : 'No Title';
      let safeAppName = appName ? appName.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1') : 'App';
      let safeText = text ? text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1') : '';

      const message = `📱 *${safeAppName}*\n\n🔹 *${safeTitle}*\n${safeText}`;
      
      await bot.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' });
      res.json({ success: true });
    } else {
      res.status(401).json({ error: "No Chat ID." });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed forwarding." });
  }
});

app.post('/api/recordings', upload.single('document'), async (req, res) => {
  if (!db || !bot) return res.status(500).json({ error: "Server missing DB or Bot." });

  const { deviceId, phoneNumber, timestamp } = req.body;
  const file = req.file;

  if (!deviceId || !file) {
    return res.status(400).json({ error: "Missing deviceId or file." });
  }

  try {
    const deviceDoc = await db.collection('devices').doc(deviceId).get();
    if (!deviceDoc.exists) {
      if (file) fs.unlinkSync(file.path);
      return res.status(401).json({ error: "Device not paired." });
    }

    const chatId = deviceDoc.data().chatId;
    if (chatId) {
      const caption = `🎙 *Call Recording*\n\n📞 Number: ${phoneNumber || 'Unknown'}\n🕐 Time: ${timestamp || 'Unknown'}`;
      
      await bot.sendDocument(chatId, file.path, {
        caption: caption,
        parse_mode: 'Markdown'
      }, {
        filename: file.originalname,
        contentType: 'audio/mpeg'
      });

      fs.unlinkSync(file.path); // Delete temp file
      res.json({ success: true });
    } else {
      if (file) fs.unlinkSync(file.path);
      res.status(401).json({ error: "No Chat ID." });
    }
  } catch (error) {
    console.error("Recording forward error:", error);
    if (file) fs.unlinkSync(file.path);
    res.status(500).json({ error: "Failed forwarding recording." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend server listening on port ${PORT}`);
});
