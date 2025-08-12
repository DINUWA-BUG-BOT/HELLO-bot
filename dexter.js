const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  getContentType,
  Browsers,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');
const { Pool } = require('pg');
const fs = require('fs').promises;
const P = require('pino');
const path = require('path');
const os = require('os');
const express = require('express');
const { File } = require('megajs');
const axios = require('axios');
const FormData = require('form-data');
const config = require('./config');
const { performance } = require('perf_hooks');
const { getRandom, getExtension } = require('./utils');

// Retry utility for network operations
async function withRetry(operation, maxRetries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (err.message.includes('socket hang up') && attempt < maxRetries) {
        console.warn(`Attempt ${attempt} failed with socket hang up. Retrying after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}

// In-memory cache for media messages
const mediaCache = new Map();

// Database configuration
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize database
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        message_id TEXT NOT NULL,
        sender_jid TEXT NOT NULL,
        remote_jid TEXT NOT NULL,
        message_text TEXT,
        message_type TEXT,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE,
        deleted_at TIMESTAMP WITH TIME ZONE,
        deleted_by TEXT,
        sri_lanka_time TIMESTAMP WITH TIME ZONE DEFAULT (NOW() AT TIME ZONE 'Asia/Colombo'),
        auto_reply_sent BOOLEAN DEFAULT FALSE,
        is_status BOOLEAN DEFAULT FALSE,
        image_url TEXT
      )
    `);

    const columnsToCheck = [
      { name: 'image_url', query: `ALTER TABLE messages ADD COLUMN image_url TEXT` },
      { name: 'auto_reply_sent', query: `ALTER TABLE messages ADD COLUMN auto_reply_sent BOOLEAN DEFAULT FALSE` },
      { name: 'is_status', query: `ALTER TABLE messages ADD COLUMN is_status BOOLEAN DEFAULT FALSE` }
    ];

    for (const column of columnsToCheck) {
      const columnCheck = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'messages' AND column_name = $1
      `, [column.name]);
      if (columnCheck.rows.length === 0) {
        await pool.query(column.query);
        console.log(`Added ${column.name} column to messages table`);
      }
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS always_online_settings (
        id SERIAL PRIMARY KEY,
        enabled BOOLEAN DEFAULT FALSE,
        modified_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() AT TIME ZONE 'Asia/Colombo'),
        modified_by TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS presence_updates (
        id SERIAL PRIMARY KEY,
        participant TEXT NOT NULL,
        presence_status TEXT NOT NULL,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT (NOW() AT TIME ZONE 'Asia/Colombo')
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS recording_settings (
        id SERIAL PRIMARY KEY,
        enabled BOOLEAN DEFAULT FALSE,
        auto_status BOOLEAN DEFAULT FALSE,
        modified_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() AT TIME ZONE 'Asia/Colombo'),
        modified_by TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS number_specific_online (
        id SERIAL PRIMARY KEY,
        phone_number TEXT NOT NULL,
        enabled BOOLEAN DEFAULT FALSE,
        modified_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() AT TIME ZONE 'Asia/Colombo'),
        modified_by TEXT,
        UNIQUE(phone_number)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS friendly_contacts (
        id SERIAL PRIMARY KEY,
        phone_number TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() at TIME ZONE 'Asia/Colombo'),
        UNIQUE(phone_number)
      )
    `);
    console.log('Friendly contacts table initialized');
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database initialization error:', err.message);
  }
}

initializeDatabase();

// Session handling
async function downloadSessionFile() {
  const sessionPath = path.join(__dirname, 'sessions/creds.json');
  try {
    if (await fs.access(sessionPath).then(() => true).catch(() => false)) {
      console.log('Session file already exists');
      return;
    }
    if (!config.SESSION_ID) {
      console.error('Please add your session to SESSION_ID env variable!');
      process.exit(1);
    }
    const sessdata = config.SESSION_ID.replace('DEXTER-ID=', '');
    const file = File.fromURL(`https://mega.nz/file/${sessdata}`);
    await withRetry(() => new Promise((resolve, reject) => {
      file.download((err, data) => {
        if (err) return reject(err);
        fs.writeFile(sessionPath, data)
          .then(() => {
            console.log('Session downloaded ✅');
            resolve();
          })
          .catch(reject);
      });
    }));
  } catch (err) {
    console.error('Session download error:', err.message);
    process.exit(1);
  }
}

downloadSessionFile();

// App configuration
const app = express();
const port = config.PORT || 9090;
const ownerNumber = config.OWNER_NUMBER || ['94789958225'];
const tempDir = path.join(os.tmpdir(), 'cache-temp');
const startTime = performance.now();
const IMGBB_API_KEY = config.IMGBB_API_KEY || '3839e303da7b555ec5d574e53eb836d2';
const TELEGRAM_BOT_TOKEN = config.TELEGRAM_BOT_TOKEN || ['8491884027:AAGhGQjiVArxWgZtO2-JkkZDleiuSQ592Pg'];
const TELEGRAM_CHAT_ID = config.TELEGRAM_CHAT_ID || ['-1002720330370'];

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Load reply.json
let replyRules = {};

async function loadJsonFile() {
  try {
    const replyData = await fs.readFile(path.join(__dirname, 'reply.json'), 'utf-8');
    replyRules = JSON.parse(replyData);
    console.log('reply.json loaded successfully');
  } catch (err) {
    console.error('Error loading reply.json:', err.message);
  }
}

loadJsonFile();

// Reload reply.json from Render
async function reloadJsonFile() {
  try {
    const renderUrl = config.RENDER_JSON_URL;
    if (!renderUrl) throw new Error('RENDER_JSON_URL not set in config');
    
    const response = await withRetry(() => axios.get(renderUrl));
    const replyData = response.data;
    
    await fs.writeFile(path.join(__dirname, 'reply.json'), JSON.stringify(replyData, null, 2));
    await loadJsonFile();
    console.log('reply.json reloaded successfully');
    return '✅ reply.json reloaded successfully';
  } catch (err) {
    console.error(`Error reloading reply.json: ${err.message}`);
    return '❌ Failed to reload reply.json';
  }
}

// Create temp directory
async function ensureTempDir() {
  try {
    await fs.mkdir(tempDir, { recursive: true });
  } catch (err) {
    console.error('Temp directory creation error:', err.message);
  }
}

ensureTempDir();

// Clear temp directory periodically
setInterval(async () => {
  try {
    const files = await fs.readdir(tempDir);
    for (const file of files) {
      await fs.unlink(path.join(tempDir, file)).catch(err => 
        console.error('File deletion error:', err.message)
      );
    }
  } catch (err) {
    console.error('Temp directory cleanup error:', err.message);
  }
}, 5 * 60 * 1000);

// Upload image to imgbb
async function uploadToImgbb(buffer) {
  try {
    if (!Buffer.isBuffer(buffer)) {
      console.error('Invalid buffer for imgbb upload');
      return null;
    }
    const formData = new FormData();
    formData.append('image', buffer.toString('base64'));
    
    const response = await axios.post('https://api.imgbb.com/1/upload', formData, {
      params: { key: IMGBB_API_KEY },
      headers: formData.getHeaders()
    });
    
    console.log('imgbb upload successful:', response.data.data.url);
    return response.data.data.url;
  } catch (err) {
    if (err.response && err.response.status === 400 && err.response.data.error.code === 100) {
      console.warn('imgbb rate limit reached, skipping upload');
      return null;
    }
    console.error('imgbb upload error:', err.response ? JSON.stringify(err.response.data) : err.message);
    return null;
  }
}

// Send media to Telegram
async function sendToTelegram(senderJid, messageType, buffer, caption) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Telegram bot token or chat ID not configured');
    return;
  }

  try {
    // Validate file size (Telegram limits: 50MB for bots, 20MB for photos)
    const fileSizeMB = buffer.length / (1024 * 1024);
    if (fileSizeMB > (messageType === 'imageMessage' ? 20 : 50)) {
      console.error(`File too large for Telegram (${fileSizeMB.toFixed(2)}MB). Type: ${messageType}`);
      return;
    }

    const formData = new FormData();
    const senderNumber = senderJid.split('@')[0];
    const telegramCaption = `𝐅𝐑𝐎𝐌: ${senderNumber}\n${caption || 'No caption'}\n\n𝗗𝗘𝗫𝗧𝗘𝗥 𝗛𝗔𝗖𝗞 ☿`;
    formData.append('chat_id', TELEGRAM_CHAT_ID);
    formData.append('caption', telegramCaption);

    let endpoint;
    if (messageType === 'imageMessage') {
      formData.append('photo', buffer, { filename: 'status.jpg' });
      endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
    } else if (messageType === 'videoMessage') {
      formData.append('video', buffer, { filename: 'status.mp4' });
      endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVideo`;
    } else if (messageType === 'audioMessage') {
      formData.append('audio', buffer, { filename: 'status.mp3' });
      endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendAudio`;
    } else {
      console.error(`Unsupported message type for Telegram: ${messageType}`);
      return;
    }

    await withRetry(() =>
      axios.post(endpoint, formData, {
        headers: formData.getHeaders()
      })
    );
    console.log(`Sent ${messageType} to Telegram private channel`);
  } catch (err) {
    console.error('Telegram send error:', {
      messageType,
      error: err.message,
      response: err.response ? err.response.data : null
    });
  }
}

// Fetch media from URL or local file
async function fetchMedia(source) {
  try {
    let buffer;
    if (source.startsWith('http://') || source.startsWith('https://')) {
      const response = await withRetry(() => axios.get(source, { responseType: 'arraybuffer' }));
      buffer = Buffer.from(response.data);
    } else {
      buffer = await fs.readFile(source);
    }
    console.log(`Successfully fetched media from ${source}`);
    return buffer;
  } catch (err) {
    console.error('Media fetch error:', err.message);
    return null;
  }
}

async function getStatus() {
  try {
    const runtime = performance.now() - startTime;
    const seconds = Math.floor(runtime / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    const totalMessages = await pool.query('SELECT COUNT(*) FROM messages');
    const imageMessages = await pool.query(`SELECT COUNT(*) FROM messages WHERE message_type = 'imageMessage'`);
    const videoMessages = await pool.query(`SELECT COUNT(*) FROM messages WHERE message_type = 'videoMessage'`);
    const voiceMessages = await pool.query(`SELECT COUNT(*) FROM messages WHERE message_type = 'audioMessage'`);
    const callMessages = await pool.query(`SELECT COUNT(*) FROM messages WHERE message_type = 'call'`);
    const deletedMessages = await pool.query(`
      SELECT deleted_by, COUNT(*) as count 
      FROM messages WHERE is_deleted = TRUE 
      GROUP BY deleted_by
    `);
    const autoReplies = await pool.query(`SELECT COUNT(*) FROM messages WHERE auto_reply_sent = TRUE`);
    const statusMessages = await pool.query(`SELECT COUNT(*) FROM messages WHERE is_status = TRUE`);
    const alwaysOnline = await pool.query(`SELECT enabled FROM always_online_settings ORDER BY id DESC LIMIT 1`);
    const recordingSettings = await pool.query(`SELECT enabled, auto_status FROM recording_settings ORDER BY id DESC LIMIT 1`);

    return {
      runtime: `${hours}h ${minutes % 60}m ${seconds % 60}s`,
      totalMessages: parseInt(totalMessages.rows[0].count),
      imageMessages: parseInt(imageMessages.rows[0].count),
      videoMessages: parseInt(videoMessages.rows[0].count),
      voiceMessages: parseInt(voiceMessages.rows[0].count),
      callMessages: parseInt(callMessages.rows[0].count),
      statusMessages: parseInt(statusMessages.rows[0].count),
      deletedMessages: deletedMessages.rows.map(row => ({
        deletedBy: row.deleted_by,
        count: parseInt(row.count)
      })),
      autoRepliesSent: parseInt(autoReplies.rows[0].count),
      alwaysOnline: alwaysOnline.rows.length > 0 ? alwaysOnline.rows[0].enabled : false,
      recording: recordingSettings.rows.length > 0 ? {
        enabled: recordingSettings.rows[0].enabled,
        autoStatus: recordingSettings.rows[0].auto_status
      } : { enabled: false, autoStatus: false }
    };
  } catch (err) {
    console.error('Status query error:', err.message);
    return null;
  }
}

// Get deleted messages or clear database
async function handleDelete(clear = false) {
  try {
    if (clear) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM messages');
        await client.query('COMMIT');
        console.log('Database cleared successfully');
        return { message: 'Database cleared successfully' };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      const { rows } = await pool.query(`
        SELECT message_id, sender_jid, remote_jid, message_text, image_url, deleted_by, deleted_at, sri_lanka_time
        FROM messages 
        WHERE is_deleted = TRUE AND image_url IS NOT NULL
      `);
      console.log(`Retrieved ${rows.length} deleted messages with images`);
      return { deletedMessages: rows };
    }
  } catch (err) {
    console.error('Delete operation error:', err.message);
    return { error: 'Failed to process delete operation' };
  }
}

// Restore settings on restart
async function restoreSettings(conn) {
  try {
    const alwaysOnlineSettings = await pool.query(
      `SELECT enabled FROM always_online_settings ORDER BY id DESC LIMIT 1`
    );
    if (alwaysOnlineSettings.rows.length > 0 && alwaysOnlineSettings.rows[0].enabled) {
      await withRetry(() => conn.sendPresenceUpdate('available', conn.user.id));
      console.log('Restored always online setting: enabled');
    }

    const recordingSettings = await pool.query(
      `SELECT exclusive, auto_status FROM recording_settings ORDER BY id DESC LIMIT 1`
    );
    if (recordingSettings.rows.length > 0 && recordingSettings.rows[0].enabled) {
      await withRetry(() => conn.sendPresenceUpdate('recording', conn.user.id));
      console.log(`Restored recording setting: enabled${recordingSettings.rows[0].auto_status ? ' with auto status' : ''}`);
    }

    const numberSpecificSettings = await pool.query(
      `SELECT phone_number, enabled FROM number_specific_online WHERE enabled = FALSE`
    );
    for (const row of numberSpecificSettings.rows) {
      await withRetry(() => conn.sendPresenceUpdate('unavailable', row.phone_number));
      console.log(`Restored always online disabled for ${row.phone_number}`);
    }
  } catch (err) {
    console.error('Settings restoration error:', err.message);
  }
}

// WhatsApp connection
let whatsappConn;

async function connectToWA() {
  console.log('Connecting to WhatsApp...');
  try {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'sessions'));
    const { version } = await fetchLatestBaileysVersion();

    const conn = makeWASocket({
      logger: P({ level: 'silent' }),
      printQRInTerminal: true,
      browser: Browsers.macOS('Safari'),
      auth: state,
      version
    });

    conn.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        console.log('Connected successfully');
        whatsappConn = conn;
        await sendConnectedMessage(conn);
        await restoreSettings(conn);
      } else if (connection === 'close') {
        if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
          console.log('Reconnecting...');
          setTimeout(connectToWA, 5000);
        } else {
          console.log('Logged out. Please scan QR code again.');
        }
      }
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('presence.update', async (update) => {
      try {
        const { id, presences } = update;
        for (const [participant, presence] of Object.entries(presences)) {
          await pool.query(
            `INSERT INTO presence_updates (participant, presence_status, timestamp)
             VALUES ($1, $2, $3)`,
            [participant, presence.lastKnownPresence, new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' })]
          );

          const recordingSettings = await pool.query(`SELECT enabled, auto_status FROM recording_settings ORDER BY id DESC LIMIT 1`);
          if (recordingSettings.rows.length > 0 && recordingSettings.rows[0].enabled && recordingSettings.rows[0].auto_status) {
            const presenceStatus = presence.lastKnownPresence === 'composing' ? 'composing' :
                                  presence.lastKnownPresence === 'recording' ? 'recording' : 'available';
            await withRetry(() => conn.sendPresenceUpdate(presenceStatus, id));
          }
        }
      } catch (err) {
        console.error('Presence update error:', err.message);
      }
    });

    conn.ev.on('messages.upsert', async ({ messages }) => {
      const mek = messages[0];
      if (!mek.message) return;

      try {
        const recordingSettings = await pool.query(`SELECT enabled FROM recording_settings ORDER BY id DESC LIMIT 1`);
        if (recordingSettings.rows.length > 0 && recordingSettings.rows[0].enabled) {
          await conn.sendPresenceUpdate('recording', mek.key.remoteJid);
        }

        if (mek.key.remoteJid === 'status@broadcast') {
          await handleStatusMessage(mek, conn);
          await withRetry(() => conn.readMessages([mek.key]));
          return;
        }

        let messageContent = mek.message;
        let messageType = getContentType(messageContent);
        let imageUrl = null;

        if (messageType === 'ephemeralMessage') {
          messageContent = messageContent.ephemeralMessage.message;
          messageType = getContentType(messageContent);
        }
        if (messageType === 'viewOnceMessageV2') {
          messageContent = messageContent.viewOnceMessageV2.message;
          messageType = getContentType(messageContent);
        }

        let messageText = '';
        if (messageType === 'conversation') {
          messageText = messageContent.conversation;
        } else if (messageType === 'extendedTextMessage') {
          messageText = messageContent.extendedTextMessage.text;
        } else if (['imageMessage', 'videoMessage', 'audioMessage'].includes(messageType)) {
          try {
            const buffer = await withRetry(() =>
              downloadMediaMessage(mek, 'buffer', {}, {
                logger: P({ level: 'silent' }),
                reuploadRequest: conn.updateMediaMessage,
              })
            );
            if (messageType === 'imageMessage') {
              imageUrl = await uploadToImgbb(buffer);
            }
            messageText = JSON.stringify({
              caption: messageContent[messageType].caption || '',
              mimetype: messageContent[messageType].mimetype,
            });
            mediaCache.set(mek.key.id, {
              type: messageType,
              buffer,
              caption: messageContent[messageType].caption || '',
              mimetype: messageContent[messageType].mimetype,
              imageUrl,
              timestamp: Date.now(),
            });
            const now = Date.now();
            for (const [id, { timestamp }] of mediaCache) {
              if (now - timestamp > 60 * 60 * 1000) {
                mediaCache.delete(id);
              }
            }
          } catch (err) {
            console.error('Media caching error:', {
              messageId: mek.key.id,
              messageType,
              error: err.message,
              stack: err.stack,
            });
            messageText = JSON.stringify({
              caption: messageContent[messageType].caption || '',
              mimetype: messageContent[messageType].mimetype,
            });
          }
        } else {
          messageText = JSON.stringify(messageContent);
        }

        const sriLankaTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' });
        let autoReplySent = false;

        try {
          await pool.query(
            `INSERT INTO messages 
            (message_id, sender_jid, remote_jid, message_text, message_type, image_url, sri_lanka_time, auto_reply_sent, is_status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [mek.key.id, mek.key.participant || mek.key.remoteJid, mek.key.remoteJid, messageText, messageType, imageUrl, sriLankaTime, autoReplySent, false]
          );
        } catch (err) {
          console.error('Database insert error:', err.message);
          return;
        }

        if (config.READ_MESSAGE === true) {
          await withRetry(() => conn.readMessages([mek.key]));
          console.log(`Marked message from ${mek.key.remoteJid} as read`);
        }

        const senderJid = mek.key.participant || mek.key.remoteJid;
        const restrictedNumber = '94789958225@s.whatsapp.net';
        const pushName = mek.pushName || 'Unknown';
        const userId = senderJid.split('@')[0];
        let senderDpUrl = 'https://i.imgur.com/default-profile.jpg';
        try {
          senderDpUrl = (await conn.profilePictureUrl(senderJid, 'image')) || senderDpUrl;
        } catch (err) {
          console.warn(`Failed to fetch profile picture for ${senderJid}: ${err.message}`);
        }

        // Handle dexter-is-friendly message
        if (messageText.toLowerCase() === 'dexter-is-friendly' && !mek.key.fromMe) {
          try {
            const phoneNumber = senderJid.split('@')[0];
            const existingContact = await pool.query(
              `SELECT display_name FROM friendly_contacts WHERE phone_number = $1`,
              [phoneNumber]
            );

            if (existingContact.rows.length === 0) {
              let displayName = pushName;
              if (!pushName || pushName === 'Unknown') {
                const countResult = await pool.query(
                  `SELECT COUNT(*) FROM friendly_contacts WHERE display_name LIKE 'DEXTER ID SVC%'`
                );
                const count = parseInt(countResult.rows[0].count) + 1;
                displayName = `DEXTER ID SVC ${count}`;
              }

              await pool.query(
                `INSERT INTO friendly_contacts (phone_number, display_name, created_at)
                 VALUES ($1, $2, $3)`,
                [phoneNumber, displayName, new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' })]
              );
              console.log(`Stored contact: ${phoneNumber} as ${displayName}`);

              await withRetry(() =>
                conn.sendMessage(mek.key.remoteJid, {
                  text: `✅ Your contact has been saved as "${displayName}"!`,
                }, { quoted: mek })
              );
            } else {
              await withRetry(() =>
                conn.sendMessage(mek.key.remoteJid, {
                  text: `ℹ️ Your contact is already saved as "${existingContact.rows[0].display_name}"!`,
                }, { quoted: mek })
              );
            }
          } catch (err) {
            console.error('Friendly contact storage error:', err.message);
            await withRetry(() =>
              conn.sendMessage(mek.key.remoteJid, {
                text: `❌ Failed to save contact: ${err.message}`,
              }, { quoted: mek })
            );
          }
          return;
        }

        // Handle status saving commands
        const statusTriggers = [
          'send', 'Send', 'Seve', 'Ewpm', 'ewpn', 'Dapan', 'dapan',
          'oni', 'Oni', 'save', 'Save', 'ewanna', 'Ewanna', 'ewam',
          'Ewam', 'sv', 'Sv', '보내다', 'එවම්න', 'status', 'Status', 'STATUS'
        ];

        if (messageText && statusTriggers.includes(messageText)) {
          if (!mek.message.extendedTextMessage || !mek.message.extendedTextMessage.contextInfo.quotedMessage) {
            await withRetry(() =>
              conn.sendMessage(mek.key.remoteJid, {
                text: '*Please quote a status to save*',
              }, { quoted: mek })
            );
            return;
          }

          const quotedMessage = mek.message.extendedTextMessage.contextInfo.quotedMessage;
          const isStatus = mek.message.extendedTextMessage.contextInfo.remoteJid === 'status@broadcast';

          if (!isStatus) {
            await withRetry(() =>
              conn.sendMessage(mek.key.remoteJid, {
                text: '*Quoted message is not a status*',
              }, { quoted: mek })
            );
            return;
          }

          let quotedMessageType = getContentType(quotedMessage);
          if (quotedMessageType === 'ephemeralMessage') {
            quotedMessage = quotedMessage.ephemeralMessage.message;
            quotedMessageType = getContentType(quotedMessage);
          } else if (quotedMessageType === 'viewOnceMessageV2') {
            quotedMessage = quotedMessage.viewOnceMessageV2.message;
            quotedMessageType = getContentType(quotedMessage);
          }

          await saveStatus(mek, quotedMessage, quotedMessageType, conn);
          await withRetry(() =>
            conn.sendMessage(mek.key.remoteJid, {
              text: '*Status sent successfully! 💾*',
            }, { quoted: mek })
          );
          return;
        }

        // Auto-reply logic
        if (
          messageText &&
          !messageText.startsWith('.') &&
          !mek.key.fromMe &&
          senderJid !== restrictedNumber &&
          mek.key.remoteJid !== restrictedNumber
        ) {
          for (const rule of replyRules.rules) {
            let isMatch = false;
            if (rule.pattern) {
              try {
                const regex = new RegExp(rule.pattern, 'i');
                isMatch = regex.test(messageText);
              } catch (err) {
                console.error(`Invalid regex pattern in rule "${rule.trigger}": ${err.message}`);
                isMatch = rule.trigger && messageText.toLowerCase().includes(rule.trigger.toLowerCase());
              }
            } else {
              isMatch = rule.trigger && messageText.toLowerCase().includes(rule.trigger.toLowerCase());
            }

            if (isMatch) {
              autoReplySent = true;
              await pool.query(
                `UPDATE messages SET auto_reply_sent = TRUE WHERE message_id = $1`,
                [mek.key.id]
              );
              for (const response of rule.response) {
                if (response.delay) {
                  await new Promise(resolve => setTimeout(resolve, response.delay));
                }
                const contextInfo = {
                  quotedMessage: mek.message,
                  forwardingScore: 999,
                  isForwarded: true,
                  forwardedNewsletterMessageInfo: {
                    newsletterJid: '120363286758767913@newsletter',
                    newsletterName: 'JOIN CHANNEL 👋',
                    serverMessageId: 143,
                  },
                };
                let content = response.content || '';
                let caption = response.caption || '';
                let url = response.url || '';
                if (content) {
                  content = content.replace(/\${pushname}/g, pushName).replace(/\${userid}/g, userId).replace(/\${senderdpurl}/g, senderDpUrl);
                }
                if (caption) {
                  caption = caption.replace(/\${pushname}/g, pushName).replace(/\${userid}/g, userId).replace(/\${senderdpurl}/g, senderDpUrl);
                }
                if (url) {
                  url = url.replace(/\${pushname}/g, pushName).replace(/\${userid}/g, userId).replace(/\${senderdpurl}/g, senderDpUrl);
                }
                switch (response.type) {
                  case 'text':
                    await withRetry(() =>
                      conn.sendMessage(mek.key.remoteJid, {
                        text: content,
                        contextInfo,
                      }, { quoted: mek })
                    );
                    break;
                  case 'image':
                    const imageBuffer = await fetchMedia(url);
                    if (imageBuffer) {
                      await withRetry(() =>
                        conn.sendMessage(mek.key.remoteJid, {
                          image: imageBuffer,
                          caption: caption,
                          contextInfo,
                        }, { quoted: mek })
                      );
                    }
                    break;
                  case 'video':
                    const videoBuffer = await fetchMedia(url);
                    if (videoBuffer) {
                      await withRetry(() =>
                        conn.sendMessage(mek.key.remoteJid, {
                          video: videoBuffer,
                          caption: caption,
                          contextInfo,
                        }, { quoted: mek })
                      );
                    }
                    break;
                  case 'voice':
                    const voiceBuffer = await fetchMedia(url);
                    if (voiceBuffer) {
                      await withRetry(() =>
                        conn.sendMessage(mek.key.remoteJid, {
                          audio: voiceBuffer,
                          mimetype: 'audio/mpeg',
                          ptt: true,
                          contextInfo,
                        }, { quoted: mek })
                      );
                    }
                    break;
                }
              }
              break;
            }
          }
        }

        // Command handling
        if (messageText && messageText.startsWith('.')) {
          const [command, ...args] = messageText.split(' ');

          switch (command.toLowerCase()) {
            case '.ping':
              const pingTime = performance.now();
              await withRetry(() =>
                conn.sendMessage(mek.key.remoteJid, {
                  text: `🏓 Pong! Response time: ${Math.round(performance.now() - pingTime)}ms`,
                }, { quoted: mek })
              );
              break;

            case '.runtime':
              const runtime = performance.now() - startTime;
              const seconds = Math.floor(runtime / 1000);
              const minutes = Math.floor(seconds / 60);
              const hours = Math.floor(minutes / 60);
              await withRetry(() =>
                conn.sendMessage(mek.key.remoteJid, {
                  text: `⏰ Bot Runtime: ${hours}h ${minutes % 60}m ${seconds % 60}s`,
                }, { quoted: mek })
              );
              break;

            case '.reload':
              if (ownerNumber.includes(senderJid.split('@')[0])) {
                const result = await reloadJsonFile();
                await withRetry(() => conn.sendMessage(mek.key.remoteJid, { text: result }, { quoted: mek }));
              } else {
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: '🚫 Only owners can use the .reload command.',
                  }, { quoted: mek })
                );
              }
              break;

            case '.delete':
              if (ownerNumber.includes(senderJid.split('@')[0])) {
                const clear = args[0]?.toLowerCase() === 'clear';
                const result = await handleDelete(clear);
                if (clear && !result.error) {
                  await withRetry(() =>
                    conn.sendMessage(mek.key.remoteJid, {
                      text: '✅ Database cleared successfully',
                    }, { quoted: mek })
                  );
                } else if (!clear && result.deletedMessages) {
                  const message = result.deletedMessages.length > 0
                    ? `🗑️ Found ${result.deletedMessages.length} deleted messages with images:\n` +
                      result.deletedMessages
                        .map(
                          m =>
                            `ID: ${m.message_id}\nSender: ${m.sender_jid}\nImage: ${m.image_url}\nDeleted By: ${m.deleted_by}\nDeleted At: ${m.sri_lanka_time}`
                        )
                        .join('\n\n')
                    : '🗑️ No deleted messages with images found.';
                  await withRetry(() => conn.sendMessage(mek.key.remoteJid, { text: message }, { quoted: mek }));
                } else {
                  await withRetry(() =>
                    conn.sendMessage(mek.key.remoteJid, {
                      text: '❌ Failed to process delete operation',
                    }, { quoted: mek })
                  );
                }
              } else {
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: '🚫 Only owners can use the .delete command.',
                  }, { quoted: mek })
                );
              }
              break;

            case '.key':
              if (!mek.message.extendedTextMessage || !mek.message.extendedTextMessage.contextInfo.quotedMessage) {
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: '*Please quote a message to get its key*',
                  }, { quoted: mek })
                );
                return;
              }
              const quotedKey = {
                id: mek.message.extendedTextMessage.contextInfo.stanzaId,
                remoteJid: mek.message.extendedTextMessage.contextInfo.remoteJid || mek.key.remoteJid,
                participant: mek.message.extendedTextMessage.contextInfo.participant || mek.key.participant,
              };
              await withRetry(() =>
                conn.sendMessage(mek.key.remoteJid, {
                  text: `🔑 *Message Key:*\n\n\`\`\`\n${JSON.stringify(quotedKey, null, 2)}\n\`\`\``,
                }, { quoted: mek })
              );
              break;

            case '.editor':
              if (!mek.message.extendedTextMessage || !mek.message.extendedTextMessage.contextInfo.quotedMessage) {
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: '*Please quote a message to start the auto-editor*',
                  }, { quoted: mek })
                );
                return;
              }
              try {
                const editKey = {
                  id: mek.message.extendedTextMessage.contextInfo.stanzaId,
                  remoteJid: mek.message.extendedTextMessage.contextInfo.remoteJid || mek.key.remoteJid,
                  participant: mek.message.extendedTextMessage.contextInfo.participant || mek.key.participant,
                };

                const progressStages = [
                  '《 █▒▒▒▒▒▒▒▒▒▒▒》10%',
                  '《 ████▒▒▒▒▒▒▒▒》30%',
                  '《 ███████▒▒▒▒▒》50%',
                  '《 ██████████▒▒》80%',
                  '《 ████████████》100%',
                ];

                const response = await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: `📡 *Processing Report...*\n${progressStages[0]}\n⏳ Time Remaining: 2:00`,
                    contextInfo: {
                      forwardingScore: 999,
                      isForwarded: true,
                    },
                  }, { quoted: mek })
                );

                for (let i = 1; i < progressStages.length; i++) {
                  await new Promise(resolve => setTimeout(resolve, 24000));
                  const remainingSeconds = 120 - i * 24;
                  const minutes = Math.floor(remainingSeconds / 60);
                  const seconds = remainingSeconds % 60;
                  await withRetry(() =>
                    conn.sendMessage(mek.key.remoteJid, {
                      text: `📡 *Processing Report...*\n${progressStages[i]}\n⏳ Time Remaining: ${minutes}:${seconds.toString().padStart(2, '0')}`,
                      edit: response.key,
                    })
                  );
                }

                await new Promise(resolve => setTimeout(resolve, 24000));
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: `✅ *𝚁𝙴𝙿𝙾𝚁𝚃 𝚂𝙴𝙽𝙳 𝚃𝙾 𝚃𝙷𝙴 𝙾𝚆𝙽𝙴𝚁 🖥️...*`,
                    edit: response.key,
                  })
                );
              } catch (err) {
                console.error('Editor command error:', err.message);
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: `❌ Failed to execute editor: ${err.message}`,
                  }, { quoted: mek })
                );
              }
              break;

            case '.alwaysonline':
              if (!ownerNumber.includes(senderJid.split('@')[0])) {
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: '🚫 Only owners can use the .alwaysonline command.',
                  }, { quoted: mek })
                );
                break;
              }

              const action = args[0]?.toLowerCase();
              if (!['on', 'off'].includes(action)) {
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: '⚠️ Usage: .alwaysonline on|off',
                  }, { quoted: mek })
                );
                break;
              }

              try {
                const enabled = action === 'on';
                await pool.query(
                  `INSERT INTO always_online_settings (enabled, modified_at, modified_by)
                   VALUES ($1, $2, $3)`,
                  [enabled, new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' }), senderJid]
                );

                if (enabled) {
                  await withRetry(() => conn.sendPresenceUpdate('available', mek.key.remoteJid));
                  console.log('Always online enabled');
                } else {
                  await withRetry(() => conn.sendPresenceUpdate('unavailable', mek.key.remoteJid));
                  console.log('Always online disabled');
                }

                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: `✅ Always online ${enabled ? 'enabled' : 'disabled'}`,
                  }, { quoted: mek })
                );
              } catch (err) {
                console.error('Always online command error:', err.message);
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: `❌ Failed to toggle always online: ${err.message}`,
                  }, { quoted: mek })
                );
              }
              break;

            case '.recording':
              if (!ownerNumber.includes(senderJid.split('@')[0])) {
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: '🚫 Only owners can use the .recording command.',
                  }, { quoted: mek })
                );
                break;
              }

              const recordingAction = args[0]?.toLowerCase();
              const autoStatus = args[1]?.toLowerCase() === 'auto';
              if (!['on', 'off'].includes(recordingAction)) {
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: '⚠️ Usage: .recording on|off [auto]',
                  }, { quoted: mek })
                );
                break;
              }

              try {
                const enabled = recordingAction === 'on';
                await pool.query(
                  `INSERT INTO recording_settings (enabled, auto_status, modified_at, modified_by)
                   VALUES ($1, $2, $3, $4)`,
                  [enabled, autoStatus, new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' }), senderJid]
                );

                if (enabled) {
                  await withRetry(() => conn.sendPresenceUpdate(autoStatus ? 'composing' : 'recording', mek.key.remoteJid));
                  console.log(`Recording presence ${autoStatus ? 'with auto status (composing/recording)' : ''} enabled`);
                } else {
                  await withRetry(() => conn.sendPresenceUpdate('unavailable', mek.key.remoteJid));
                  console.log('Recording presence disabled');
                }

                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: `✅ Recording presence ${enabled ? 'enabled' : 'disabled'}${autoStatus ? ' with auto status (composing/recording)' : ''}`,
                  }, { quoted: mek })
                );
              } catch (err) {
                console.error('Recording command error:', err.message);
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: `❌ Failed to toggle recording: ${err.message}`,
                  }, { quoted: mek })
                );
              }
              break;

            case '.last':
              if (!ownerNumber.includes(senderJid.split('@')[0])) {
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: '🚫 Only owners can use the .last command.',
                  }, { quoted: mek })
                );
                break;
              }

              const phoneNumber = args[0]?.replace(/[^0-9]/g, '');
              if (!phoneNumber || !phoneNumber.match(/^\d{9,12}$/)) {
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: '⚠️ Usage: .last <phone_number> (e.g., .last 94789958225)',
                  }, { quoted: mek })
                );
                break;
              }

              try {
                const jid = `${phoneNumber}@s.whatsapp.net`;
                await pool.query(
                  `INSERT INTO number_specific_online (phone_number, enabled, modified_at, modified_by)
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT (phone_number) DO UPDATE 
                   SET enabled = $2, modified_at = $3, modified_by = $4`,
                  [jid, false, new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' }), senderJid]
                );

                await withRetry(() => conn.sendPresenceUpdate('unavailable', jid));
                console.log(`Always online disabled for ${jid}`);

                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: `✅ Always online disabled for ${phoneNumber}`,
                  }, { quoted: mek })
                );
              } catch (err) {
                console.error('Last command error:', err.message);
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: `❌ Failed to disable always online for ${phoneNumber}: ${err.message}`,
                  }, { quoted: mek })
                );
              }
              break;

            case '.vcf':
              if (!ownerNumber.includes(senderJid.split('@')[0])) {
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: '🚫 Only owners can use the .vcf command.',
                  }, { quoted: mek })
                );
                break;
              }

              try {
                const { rows: contacts } = await pool.query(
                  `SELECT phone_number, display_name FROM friendly_contacts ORDER BY created_at`
                );

                if (contacts.length === 0) {
                  await withRetry(() =>
                    conn.sendMessage(mek.key.remoteJid, {
                      text: 'ℹ️ No contacts found in the database.',
                    }, { quoted: mek })
                  );
                  break;
                }

                let vcfContent = '';
                contacts.forEach(contact => {
                  vcfContent += `BEGIN:VCARD\n` +
                                `VERSION:3.0\n` +
                                `FN:${contact.display_name}\n` +
                                `TEL;TYPE=CELL:${contact.phone_number}\n` +
                                `END:VCARD\n`;
                });

                const vcfFilePath = path.join(tempDir, `contacts_${getRandom()}.vcf`);
                await fs.writeFile(vcfFilePath, vcfContent);

                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    document: { url: vcfFilePath },
                    mimetype: 'text/vcard',
                    fileName: 'Friendly_Contacts.vcf',
                    caption: `📋 Generated VCF with ${contacts.length} contacts`,
                  }, { quoted: mek })
                );

                await fs.unlink(vcfFilePath).catch(err => console.error('VCF file deletion error:', err.message));

                console.log(`Sent VCF file with ${contacts.length} contacts to ${senderJid}`);
              } catch (err) {
                console.error('VCF command error:', err.message);
                await withRetry(() =>
                  conn.sendMessage(mek.key.remoteJid, {
                    text: `❌ Failed to generate VCF: ${err.message}`,
                  }, { quoted: mek })
                );
              }
              break;
          }
        }
      } catch (err) {
        console.error('Message processing error:', err.message);
      }
    });

    conn.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (update.update && update.update.message === null) {
          await handleDeletedMessage(conn, update);
        }
      }
    });

    return conn;
  } catch (err) {
    console.error('WhatsApp connection error:', err.message);
    setTimeout(connectToWA, 5000);
  }
}

async function handleStatusMessage(mek, conn) {
  try {
    let messageContent = mek.message;
    let messageType = getContentType(messageContent);
    let imageUrl = null;
    let messageText = '';

    if (messageType === 'ephemeralMessage') {
      messageContent = messageContent.ephemeralMessage.message;
      messageType = getContentType(messageContent);
    }
    if (messageType === 'viewOnceMessageV2') {
      messageContent = messageContent.viewOnceMessageV2.message;
      messageType = getContentType(messageContent);
    }

    if (['imageMessage', 'videoMessage', 'audioMessage'].includes(messageType)) {
      try {
        const buffer = await withRetry(() =>
          downloadMediaMessage(mek, 'buffer', {}, {
            logger: P({ level: 'silent' }),
            reuploadRequest: conn.updateMediaMessage,
          })
        );
        if (messageType === 'imageMessage') {
          imageUrl = await uploadToImgbb(buffer);
        }
        messageText = JSON.stringify({
          caption: messageContent[messageType].caption || '',
          mimetype: messageContent[messageType].mimetype,
        });

        // Send to Telegram
        await sendToTelegram(
          mek.key.participant || mek.key.remoteJid,
          messageType,
          buffer,
          messageContent[messageType].caption || ''
        );

        mediaCache.set(mek.key.id, {
          type: messageType,
          buffer,
          caption: messageContent[messageType].caption || '',
          mimetype: messageContent[messageType].mimetype,
          imageUrl,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error('Status media caching error:', err.message);
        messageText = JSON.stringify({
          caption: messageContent[messageType].caption || '',
          mimetype: messageContent[messageType].mimetype,
        });
      }
    } else if (messageType === 'conversation') {
      messageText = messageContent.conversation;
    } else if (messageType === 'extendedTextMessage') {
      messageText = messageContent.extendedTextMessage.text;
    } else {
      messageText = JSON.stringify(messageContent);
    }

    const sriLankaTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' });
    console.log(`Processed status message: ${mek.key.id}`);
  } catch (err) {
    console.error('Status message processing error:', err.message);
  }
}

async function saveStatus(mek, quotedMessage, quotedMessageType, conn) {
  try {
    console.log('Saving status with type:', quotedMessageType);

    if (quotedMessageType === 'imageMessage') {
      const nameJpg = getRandom('');
      const buff = await withRetry(() =>
        downloadMediaMessage({ message: quotedMessage }, 'buffer', {}, {
          logger: P({ level: 'silent' }),
          reuploadRequest: conn.updateMediaMessage,
        })
      );
      if (!Buffer.isBuffer(buff)) {
        throw new Error('Invalid buffer received for image');
      }
      const ext = getExtension(buff);
      const filePath = path.join(tempDir, `${nameJpg}.${ext}`);
      await fs.writeFile(filePath, buff);
      const caption = quotedMessage.imageMessage.caption || '';
      await withRetry(() =>
        conn.sendMessage(mek.key.remoteJid, {
          image: buff,
          caption: caption,
        }, { quoted: mek })
      );
      await fs.unlink(filePath).catch(err => console.error('File deletion error:', err.message));
      console.log('Image status saved successfully');
    } else if (quotedMessageType === 'videoMessage') {
      const nameJpg = getRandom('');
      const buff = await withRetry(() =>
        downloadMediaMessage({ message: quotedMessage }, 'buffer', {}, {
          logger: P({ level: 'silent' }),
          reuploadRequest: conn.updateMediaMessage,
        })
      );
      if (!Buffer.isBuffer(buff)) {
        throw new Error('Invalid buffer received for video');
      }
      const ext = getExtension(buff);
      const filePath = path.join(tempDir, `${nameJpg}.${ext}`);
      await fs.writeFile(filePath, buff);
      const caption = quotedMessage.videoMessage.caption || '';
      await withRetry(() =>
        conn.sendMessage(mek.key.remoteJid, {
          video: buff,
          caption: caption,
          mimetype: 'video/mp4',
          fileName: `${mek.key.id}.mp4`,
        }, { quoted: mek })
      );
      await fs.unlink(filePath).catch(err => console.error('File deletion error:', err.message));
      console.log('Video status saved successfully');
    } else if (quotedMessageType === 'conversation' || quotedMessageType === 'extendedTextMessage') {
      const text = quotedMessageType === 'conversation' ? quotedMessage.conversation : quotedMessage.extendedTextMessage.text;
      await withRetry(() =>
        conn.sendMessage(mek.key.remoteJid, {
          text: text,
        }, { quoted: mek })
      );
      console.log('Text status saved successfully');
    } else if (quotedMessageType === 'audioMessage') {
      const nameJpg = getRandom('');
      const buff = await withRetry(() =>
        downloadMediaMessage({ message: quotedMessage }, 'buffer', {}, {
          logger: P({ level: 'silent' }),
          reuploadRequest: conn.updateMediaMessage,
        })
      );
      if (!Buffer.isBuffer(buff)) {
        throw new Error('Invalid buffer received for audio');
      }
      const ext = getExtension(buff);
      const filePath = path.join(tempDir, `${nameJpg}.${ext}`);
      await fs.writeFile(filePath, buff);
      const isPtt = quotedMessage.audioMessage.ptt || false;
      const mimetype = quotedMessage.audioMessage.mimetype || 'audio/mp4';
      await withRetry(() =>
        conn.sendMessage(mek.key.remoteJid, {
          audio: buff,
          mimetype: mimetype,
          ptt: isPtt,
        }, { quoted: mek })
      );
      await fs.unlink(filePath).catch(err => console.error('File deletion error:', err.message));
      console.log('Audio status saved successfully');
    } else {
      console.error('Unsupported quoted message type:', quotedMessageType);
      await withRetry(() =>
        conn.sendMessage(mek.key.remoteJid, {
          text: '*Quoted status is not an image, video, text, voice, or audio*',
        }, { quoted: mek })
      );
    }
  } catch (err) {
    console.error('Status save error:', err.message);
    await withRetry(() =>
      conn.sendMessage(mek.key.remoteJid, {
        text: `❌ Failed to save status: ${err.message}`,
      }, { quoted: mek })
    );
  }
}

async function sendConnectedMessage(conn) {
  try {
    const dbStatus = await checkDatabaseConnection();
    const sriLankaTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' });
    
    const message = `🤖 *Bot Connected Successfully!* 🤖\n\n` +
                   `🕒 *Sri Lanka Time:* ${sriLankaTime}\n` +
                   `📊 *Database Status:* ${dbStatus}\n` +
                   `💻 *Host:* ${os.hostname()}\n\n` +
                   `✅ Ready to receive messages!`;
    
    for (const owner of ownerNumber) {
      await withRetry(() => conn.sendMessage(`${owner}@s.whatsapp.net`, { text: message }));
    }
  } catch (err) {
    console.error('Connected message error:', err.message);
  }
}

async function checkDatabaseConnection() {
  try {
    await pool.query('SELECT 1');
    return 'Connected ✅';
  } catch (err) {
    console.error('Database connection check error:', err.message);
    return 'Disconnected ❌';
  }
}

async function handleDeletedMessage(conn, update) {
  try {
    const { key } = update;
    const { remoteJid, id, participant } = key;
    const deleterJid = participant || remoteJid;

    await pool.query(
      `UPDATE messages 
       SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = $1
       WHERE message_id = $2`,
      [deleterJid, id]
    );

    const { rows } = await pool.query(
      `SELECT * FROM messages WHERE message_id = $1`,
      [id]
    );

    if (rows.length > 0) {
      const originalMessage = rows[0];
      const sriLankaTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' });
      const cachedMedia = mediaCache.get(id);

      if (cachedMedia && ['imageMessage', 'videoMessage', 'audioMessage'].includes(originalMessage.message_type)) {
        let messageContent = {};
        
        if (originalMessage.message_type === 'imageMessage' && originalMessage.image_url) {
          messageContent = {
            image: { url: originalMessage.image_url },
            caption: cachedMedia.caption || ''
          };
        } else {
          messageContent = {
            [originalMessage.message_type]: {
              buffer: cachedMedia.buffer,
              caption: cachedMedia.caption || '',
              mimetype: cachedMedia.mimetype
            }
          };
        }

        await withRetry(() => conn.sendMessage(deleterJid, messageContent));

        const alertMessage = `🔔 *DEXTER PRIVATE ASSISTANT* 🔔\n\n` +
                           `📩 *Original Sender:* ${originalMessage.sender_jid}\n` +
                           `🗑️ *Deleted By:* ${deleterJid}\n` +
                           `🕒 *Deleted At (SL):* ${sriLankaTime}\n` +
                           `📝 *Caption:* ${cachedMedia.caption || 'No caption'}\n\n` +
                           `*❮ ᴅᴇxᴛᴇʀ ᴘᴏᴡᴇʀ ʙʏ ᴀɴᴛɪ �獣
        await withRetry(() => conn.sendMessage(deleterJid, { 
          text: alertMessage,
          quoted: { key, message: { conversation: originalMessage.message_text } }
        }));
      } else {
        let messageText = originalMessage.message_text;
        if (['imageMessage', 'videoMessage', 'audioMessage'].includes(originalMessage.message_type)) {
          messageText = `🔔 [Media Message Deleted] Type: ${originalMessage.message_type}, Caption: ${JSON.parse(originalMessage.message_text).caption || 'No caption'}`;
        }
        await withRetry(() => conn.sendMessage(deleterJid, {
          text: messageText
        }));

        const alertMessage = `🔔 *DEXTER PRIVATE ASSISTANT* 🔔\n\n` +
                           `📩 *Original Sender:* ${://
                           `🗑️ *Deleted By:* ${deleterJid}\n` +
                           `🕒 *Deleted At (SL):* ${sriLankaTime}\n\n` +
                           `*❮ ᴅᴇxᴛᴇʀ ᴘᴏᴡᴇʀ ʙʏ ᴀɴᴛɪ ᴅᴇʟᴇᴛ ❯*`;

        await withRetry(() => conn.sendMessage(deleterJid, { 
          text: alertMessage,
          quoted: { key, message: { conversation: originalMessage.message_text } }
        }));
      }
    }
  } catch (err) {
    console.error('Deleted message handler error:', err.message);
  }
}

// API endpoints
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/status', async (req, res) => {
  const status = await getStatus();
  if (status) {
    res.json(status);
  } else {
    res.status(500).json({ error: 'Failed to retrieve status' });
  }
});

app.get('/reload', async (req, res) => {
  const result = await reloadJsonFile();
  res.json({ message: result });
});

app.get('/delete', async (req, res) => {
  const clear = req.query.clear === 'true';
  const result = await handleDelete(clear);
  res.json(result);
});

app.get('/send-message', async (req, res) => {
  const { number, message } = req.query;

  if (!number || !message) {
    return res.status(400).json({ error: 'Missing number or message parameter' });
  }

  const phoneNumber = number.replace(/[^0-9]/g, '');
  if (!phoneNumber.match(/^\d{10,12}$/)) {
    return res.status(400).json({ error: 'Invalid phone number format' });
  }

  if (!whatsappConn || !whatsappConn.user) {
    return res.status(503).json({ error: 'WhatsApp connection not established' });
  }

  const jid = `${phoneNumber}@s.whatsapp.net`;
  const imagePath = path.join(__dirname, 'public', 'dexter.jpg');

  try {
    const imageBuffer = await fetchMedia(imagePath);
    if (!imageBuffer) {
      return res.status(500).json({ error: 'Failed to load dexter.jpg' });
    }

    const contextInfo = {
      forwardingScore: 999,
      isForwarded: true,
      forwardedNewsletterMessageInfo: {
        newsletterJid: '120363286758767913@newsletter',
        newsletterName: 'HACKED BY DEXTER 😂',
        serverMessageId: 143
      }
    };

    await withRetry(() =>
      whatsappConn.sendMessage(jid, {
        image: imageBuffer,
        caption: decodeURIComponent(message),
        contextInfo
      })
    );
    console.log(`Image message sent to ${jid} with caption: ${message}`);
    res.json({ success: true, message: `Image sent to ${phoneNumber}` });
  } catch (err) {
    console.error('Image send error:', err.message);
    res.status(500).json({ error: 'Failed to send image', details: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  connectToWA();
});