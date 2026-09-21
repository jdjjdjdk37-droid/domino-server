// ==============================================
// خادم لعبة الدومينو - Railway Ready v9.1
// Room Code 5 Digits + Friend Chat + Supabase Fix
// ==============================================
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

// =========================================
// Agora Configuration
// =========================================
const AGORA_APP_ID = process.env.AGORA_APP_ID || "d25d8dee0f8b487fb15bb4151a54057d";
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || "f245fe7746ff4591b303bf9799bb7968";

console.log(`🎤 Agora App ID: ${AGORA_APP_ID.substring(0, 8)}...`);

// =========================================
// Supabase Configuration (with WebSocket)
// =========================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "avatars";

let supabaseAdmin = null;
let supabaseReady = false;

try {
  if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false },
      realtime: {
        transport: WebSocket,
      },
    });
    supabaseReady = true;
    console.log('✅ Supabase Admin جاهز');
    console.log(`   URL: ${SUPABASE_URL}`);
    console.log(`   Bucket: ${SUPABASE_BUCKET}`);
  } else {
    console.log('⚠️ Supabase: متغيرات ناقصة');
    console.log(`   URL موجود: ${!!SUPABASE_URL}`);
    console.log(`   KEY موجود: ${!!SUPABASE_SECRET_KEY}`);
  }
} catch (err) {
  console.error('⚠️ Supabase معطّل:', err.message);
}

// =========================================
// Firebase Admin
// =========================================
let admin = null;
let db = null;
let firebaseReady = false;

try {
  admin = require('firebase-admin');
  if (process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY) {

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });

    db = admin.firestore();
    firebaseReady = true;
    console.log('✅ Firebase Admin جاهز');
  }
} catch (err) {
  console.error('⚠️ Firebase معطّل:', err.message);
}

const { DominoGame } = require('./dominoGameLogic');

// =========================================
// إعداد التطبيق
// =========================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// =========================================
// Rate Limiting
// =========================================
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: "طلبات كثيرة جداً، حاول لاحقاً" },
});

app.use('/api/', apiLimiter);
app.use('/downloads', express.static(path.join(__dirname, 'public/downloads')));

// =========================================
// تخزين الغرف
// =========================================
const rooms = new Map();
const playerRooms = new Map();
const onlineUsers = new Map();
const spectators = new Map();

const MAX_SPECTATORS_PER_ROOM = 50;
const AI_TAKEOVER_DELAY = 30000;
const TURN_TIMEOUT = 30000;

// =========================================
// Logging
// =========================================
function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${level}] ${timestamp} - ${message}`,
    Object.keys(data).length ? JSON.stringify(data) : '');
}

// =========================================
// 🆕 توليد رمز الغرفة — 5 أرقام فقط
// =========================================
function generateRoomCode() {
  let roomId;
  let attempts = 0;
  do {
    roomId = Math.floor(10000 + Math.random() * 90000).toString();
    attempts++;
    if (attempts > 100) break;
  } while (rooms.has(roomId));
  return roomId;
}

// =========================================
// OTA
// =========================================
const OTA_ENABLED = false;

const LATEST_VERSION = {
  versionCode: 6,
  versionName: "2.6.0",
  apkUrl: `${process.env.PUBLIC_URL || 'https://domino-server-production-e9af.up.railway.app'}/downloads/domino-v2.6.0.apk`,
  changelog: "🎉 جديد:\n• رمز الغرفة 5 أرقام\n• دعوات فورية\n• دردشة الأصدقاء\n• رسائل صوتية",
  isMandatory: false,
  releaseDate: "2026-09-21",
  minSupportedVersion: 1,
};

// =========================================
// 🎤 Agora Token
// =========================================
app.post('/api/agora/token', (req, res) => {
  try {
    const { roomId, uid } = req.body;
    if (!roomId || !uid) {
      return res.status(400).json({ error: "roomId و uid مطلوبان" });
    }

    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      roomId,
      parseInt(uid),
      RtcRole.PUBLISHER,
      Math.floor(Date.now() / 1000) + 3600
    );

    res.json({
      token,
      channel: roomId,
      uid: parseInt(uid),
      appId: AGORA_APP_ID,
    });
  } catch (err) {
    log('ERROR', 'فشل توليد Token', { error: err.message });
    res.status(500).json({ error: "فشل توليد Token" });
  }
});

// =========================================
// ☁️ Supabase Upload URL
// =========================================
app.post('/api/supabase/upload-url', (req, res) => {
  try {
    const { userId, fileType } = req.body;
    if (!userId) return res.status(400).json({ error: "userId مطلوب" });
    if (!supabaseReady) return res.status(503).json({ error: "Supabase غير متصل" });

    const ext = fileType || 'jpg';
    const fileName = `${userId}_${Date.now()}.${ext}`;
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${fileName}`;

    res.json({
      fileName,
      bucket: SUPABASE_BUCKET,
      publicUrl,
      uploadUrl: `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${fileName}`,
    });
  } catch (err) {
    res.status(500).json({ error: "فشل إنشاء URL" });
  }
});

// =========================================
// 📩 جلب رسائل الأصدقاء
// =========================================
app.get('/api/messages/:user1/:user2', async (req, res) => {
  try {
    const { user1, user2 } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    if (!firebaseReady) {
      return res.status(503).json({ error: "Firebase غير متصل" });
    }

    const snapshot = await db.collection('private_messages')
      .orderBy('timestamp', 'desc')
      .limit(200)
      .get();

    const messages = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      const isBetween = 
        (data.fromUser === user1 && data.toUser === user2) ||
        (data.fromUser === user2 && data.toUser === user1);
      
      if (isBetween && messages.length < limit) {
        messages.push({
          id: doc.id,
          ...data,
          timestamp: data.timestamp?.toDate?.()?.toISOString() || data.timestamp,
        });
      }
    });

    res.json({ messages: messages.reverse(), count: messages.length });
  } catch (err) {
    res.status(500).json({ error: "فشل جلب الرسائل" });
  }
});

// =========================================
// 👀 Live Matches
// =========================================
app.get('/api/live-matches', (req, res) => {
  const list = [];
  rooms.forEach((game, roomId) => {
    if (game.gameStatus === "playing") {
      const specList = spectators.get(roomId) || [];
      list.push({
        roomId,
        mode: game.mode,
        players: game.players.map(p => ({
          name: p.name,
          score: p.score,
          avatar: p.avatar || null,
        })),
        spectators: specList.length,
        startedAt: game.createdAt,
        duration: Date.now() - game.createdAt,
      });
    }
  });
  res.json({ matches: list, count: list.length });
});

// =========================================
// 👀 Room Spectators
// =========================================
app.get('/api/room/:roomId/spectators', (req, res) => {
  const { roomId } = req.params;
  const list = spectators.get(roomId) || [];
  res.json({
    count: list.length,
    list,
    max: MAX_SPECTATORS_PER_ROOM,
  });
});

// =========================================
// 📊 User APIs
// =========================================
app.get('/api/user/:userId/stats', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!firebaseReady) return res.status(503).json({ error: "Firebase غير متصل" });

    const snapshot = await db.collection('users_stats')
      .where('name', '==', userId).limit(1).get();

    if (snapshot.empty) {
      return res.json({
        userId, wins: 0, losses: 0, winRate: 0,
        longestStreak: 0, totalScore: 0, matches: 0,
      });
    }

    const data = snapshot.docs[0].data();
    const wins = data.wins || 0;
    const losses = data.losses || 0;
    const total = wins + losses;

    res.json({
      userId,
      name: data.name,
      avatarUrl: data.avatarUrl || null,
      wins, losses,
      winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
      longestStreak: data.longestStreak || 0,
      currentStreak: data.currentStreak || 0,
      totalScore: data.totalScore || 0,
      matches: total,
      achievements: data.achievements || [],
    });
  } catch (err) {
    res.status(500).json({ error: "فشل جلب الإحصائيات" });
  }
});

app.get('/api/user/:userId/friends', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!firebaseReady) return res.status(503).json({ error: "Firebase غير متصل" });

    const doc = await db.collection('friends').doc(userId).get();
    if (!doc.exists) return res.json({ userId, friends: [] });

    const data = doc.data();
    const friends = (data.friends || []).map(f => ({
      ...f,
      isOnline: onlineUsers.has(f.friendName),
    }));

    res.json({ userId, friends, count: friends.length });
  } catch (err) {
    res.status(500).json({ error: "فشل جلب الأصدقاء" });
  }
});

app.get('/api/user/:userId/matches', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    if (!firebaseReady) return res.status(503).json({ error: "Firebase غير متصل" });

    const snapshot = await db.collection('matches')
      .orderBy('finishedAt', 'desc').limit(100).get();

    const matches = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      const isPlayer = data.players?.some(p => p.name === userId);
      if (isPlayer && matches.length < limit) {
        matches.push({
          id: doc.id,
          ...data,
          finishedAt: data.finishedAt?.toDate?.()?.toISOString() || null,
        });
      }
    });

    res.json({ userId, matches, count: matches.length });
  } catch (err) {
    res.status(500).json({ error: "فشل جلب المباريات" });
  }
});

// =========================================
// 🔥 إغلاق الغرفة
// =========================================
function closeRoom(roomId, reason = "انتهت اللعبة") {
  const game = rooms.get(roomId);
  if (!game) return;

  log('INFO', `🔒 إغلاق الغرفة`, { roomId, reason });

  game.players.forEach(p => {
    if (p.turnTimer) clearTimeout(p.turnTimer);
    if (p.aiTakeoverTimer) clearTimeout(p.aiTakeoverTimer);
  });

  const specList = spectators.get(roomId) || [];
  specList.forEach(s => {
    io.to(s.id).emit('spectator_game_ended', {
      roomId,
      message: "انتهت المباراة",
    });
  });
  spectators.delete(roomId);

  io.to(roomId).emit('room_closed', { roomId, reason, message: reason });

  game.players.forEach(p => playerRooms.delete(p.id));

  io.sockets.sockets.forEach(socket => {
    if (socket.rooms.has(roomId)) socket.leave(roomId);
  });

  rooms.delete(roomId);
  log('INFO', `🗑️ تم حذف الغرفة`, { roomId, remaining: rooms.size });
}

// =========================================
// 🧹 تنظيف الغرف المهملة
// =========================================
setInterval(() => {
  const now = Date.now();
  const MAX_IDLE_TIME = 10 * 60 * 1000;
  const MAX_GAME_AGE = 3 * 60 * 60 * 1000;

  rooms.forEach((game, roomId) => {
    const lastActivity = game.lastActivity || game.createdAt;

    if (game.gameStatus === "finished") {
      closeRoom(roomId, "🏆 انتهت اللعبة");
      return;
    }
    if (now - lastActivity > MAX_IDLE_TIME) {
      closeRoom(roomId, "⏱️ انتهت مدة الانتظار");
      return;
    }
    if (now - game.createdAt > MAX_GAME_AGE) {
      closeRoom(roomId, "⌛ الغرفة قديمة");
      return;
    }
    const connectedPlayers = game.players.filter(p => p.connected);
    if (connectedPlayers.length === 0 && game.players.length > 0) {
      closeRoom(roomId, "👋 غادر جميع اللاعبين");
    }
  });
}, 60 * 1000);

// =========================================
// 🎯 Endpoints
// =========================================
app.get('/', (req, res) => {
  res.json({
    name: "🎲 Domino Server",
    status: "online",
    version: "9.1.0",
    activeRooms: rooms.size,
    activePlayers: playerRooms.size,
    onlineUsers: onlineUsers.size,
    spectators: spectators.size,
    uptime: Math.floor(process.uptime()) + "s",
    otaEnabled: OTA_ENABLED,
    firebaseReady,
    supabaseReady,
    agoraEnabled: !!(AGORA_APP_ID && AGORA_APP_CERTIFICATE),
  });
});

app.get('/health', async (req, res) => {
  const start = Date.now();
  let firebaseStatus = 'disconnected';

  if (firebaseReady) {
    try {
      await db.collection('_health').limit(1).get();
      firebaseStatus = 'connected';
    } catch { firebaseStatus = 'error'; }
  }

  const memory = process.memoryUsage();

  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    responseTime: (Date.now() - start) + "ms",
    services: {
      firebase: firebaseStatus,
      supabase: supabaseReady ? 'connected' : 'disconnected',
      agora: (AGORA_APP_ID && AGORA_APP_CERTIFICATE) ? 'configured' : 'missing',
    },
    stats: {
      rooms: rooms.size,
      players: playerRooms.size,
      onlineUsers: onlineUsers.size,
      spectators: spectators.size,
      memory: Math.round(memory.heapUsed / 1024 / 1024) + "MB",
      uptime: Math.floor(process.uptime()) + "s",
    },
    version: "9.1.0",
  });
});

app.get('/rooms', (req, res) => {
  const list = [];
  rooms.forEach((game, roomId) => {
    if (game.gameStatus === "waiting") {
      list.push({
        roomId,
        mode: game.mode,
        players: game.players.length,
        maxPlayers: game.mode === "2v2" ? 4 : 2,
        hostName: game.players[0]?.name,
      });
    }
  });
  res.json({ rooms: list, count: list.length });
});

app.get('/api/config', (req, res) => {
  res.json({
    theme: {
      primaryColor: "#0D2818",
      accentColor: "#D4AF37",
      surfaceColor: "#1A3A2A",
      textColor: "#F5F0E1",
    },
    features: {
      voiceChat: true,
      aiTakeover: true,
      avatars: true,
      chat: true,
      privateChat: true,
      leaderboard: true,
      friendInvites: true,
      spectator: true,
      supabaseUploads: supabaseReady,
      roomCodeDigits: 5,
    },
    agora: {
      appId: AGORA_APP_ID,
      enabled: true,
    },
    timings: {
      turnTimeout: 30,
      aiTakeoverDelay: 30,
      roomIdleTimeout: 600,
      inviteTimeout: 30,
    },
    version: {
      latest: LATEST_VERSION.versionName,
      code: LATEST_VERSION.versionCode,
    },
  });
});

// =========================================
// 🔄 OTA
// =========================================
app.get('/api/check-update', (req, res) => {
  if (!OTA_ENABLED) {
    return res.json({ updateAvailable: false, message: "لا يوجد تحديث حالياً" });
  }

  const clientVersion = parseInt(req.query.versionCode) || 0;
  const apkPath = path.join(__dirname, 'public/downloads/domino-v2.6.0.apk');

  if (!fs.existsSync(apkPath)) {
    return res.json({ updateAvailable: false });
  }

  if (clientVersion >= LATEST_VERSION.versionCode) {
    return res.json({ updateAvailable: false });
  }

  res.json({
    updateAvailable: true,
    ...LATEST_VERSION,
    apkSize: fs.statSync(apkPath).size,
  });
});

// =========================================
// 💾 Firebase Helpers
// =========================================
async function saveMatch(matchData) {
  if (!firebaseReady) return;
  try {
    await db.collection('matches').add({
      ...matchData,
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    log('ERROR', 'حفظ المباراة', { error: err.message });
  }
}

async function updateUserStats(playerName, won, score) {
  if (!firebaseReady) return;
  try {
    const snapshot = await db.collection('users_stats')
      .where('name', '==', playerName).limit(1).get();

    if (snapshot.empty) {
      await db.collection('users_stats').add({
        name: playerName,
        wins: won ? 1 : 0,
        losses: won ? 0 : 1,
        totalScore: score,
        longestStreak: won ? 1 : 0,
        currentStreak: won ? 1 : 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      const doc = snapshot.docs[0];
      const data = doc.data();
      const newStreak = won ? (data.currentStreak || 0) + 1 : 0;

      await doc.ref.update({
        wins: (data.wins || 0) + (won ? 1 : 0),
        losses: (data.losses || 0) + (won ? 0 : 1),
        totalScore: (data.totalScore || 0) + score,
        currentStreak: newStreak,
        longestStreak: Math.max(data.longestStreak || 0, newStreak),
        lastPlayed: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (err) {
    log('ERROR', 'تحديث الإحصائيات', { error: err.message });
  }
}

async function updateLeaderboard() {
  if (!firebaseReady) return;
  try {
    const snapshot = await db.collection('users_stats')
      .orderBy('totalScore', 'desc').limit(100).get();

    const batch = db.batch();
    const leaderboardRef = db.collection('leaderboard');

    const oldSnapshot = await leaderboardRef.get();
    oldSnapshot.docs.forEach(doc => batch.delete(doc.ref));

    snapshot.docs.forEach((doc, index) => {
      const newRef = leaderboardRef.doc();
      batch.set(newRef, {
        rank: index + 1,
        ...doc.data(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    await batch.commit();
  } catch (err) {
    log('ERROR', 'Leaderboard', { error: err.message });
  }
}

// =========================================
// 🤖 AI
// =========================================
function getAIMove(game, player) {
  if (!game || !player) return null;

  const validMoves = [];
  player.hand.forEach(tile => {
    if (game.canPlayTile(tile, "left")) validMoves.push({ tile, side: "left" });
    if (game.canPlayTile(tile, "right")) validMoves.push({ tile, side: "right" });
  });

  if (validMoves.length === 0) return null;

  validMoves.sort((a, b) => {
    const aD = a.tile.left === a.tile.right ? 1 : 0;
    const bD = b.tile.left === b.tile.right ? 1 : 0;
    if (aD !== bD) return bD - aD;
    return (b.tile.left + b.tile.right) - (a.tile.left + a.tile.right);
  });

  return validMoves[0];
}

function startAIFallback(roomId, playerId) {
  const game = rooms.get(roomId);
  if (!game) return;

  const player = game.players.find(p => p.id === playerId);
  if (!player) return;

  player.aiControlled = true;
  io.to(roomId).emit('ai_took_over', {
    playerId,
    playerName: player.name,
    message: `🤖 AI يلعب مكان ${player.name}`,
  });

  if (game.players[game.currentTurn]?.id === playerId) {
    makeAIMove(roomId, playerId);
  }
}

function stopAIFallback(roomId, playerId) {
  const game = rooms.get(roomId);
  if (!game) return;

  const player = game.players.find(p => p.id === playerId);
  if (!player) return;

  if (player.aiControlled) {
    player.aiControlled = false;
    io.to(roomId).emit('ai_stopped', { playerId, playerName: player.name });
  }

  if (player.aiTakeoverTimer) {
    clearTimeout(player.aiTakeoverTimer);
    player.aiTakeoverTimer = null;
  }
}

function makeAIMove(roomId, playerId) {
  const game = rooms.get(roomId);
  if (!game || game.gameStatus !== "playing") return;

  const player = game.players.find(p => p.id === playerId);
  if (!player || !player.aiControlled) return;
  if (game.players[game.currentTurn]?.id !== playerId) return;

  const move = getAIMove(game, player);

  if (move) {
    const result = game.playTile(playerId, move.tile, move.side);
    if (!result.error) {
      game.players.forEach(p => {
        io.to(p.id).emit('game_state', game.getPublicState(p.id));
      });

      if (result.gameEnded) {
        io.to(roomId).emit('round_ended', game.lastAction);
        if (game.gameStatus === "finished") handleGameEnd(roomId);
      }
    }
  } else {
    if (game.boneyard.length > 0) {
      game.drawTile(playerId);
      const newMove = getAIMove(game, player);
      if (newMove) {
        setTimeout(() => makeAIMove(roomId, playerId), 500);
        return;
      }
    }
    const passResult = game.passTurn(playerId);
    if (!passResult.error) {
      game.players.forEach(p => {
        io.to(p.id).emit('game_state', game.getPublicState(p.id));
      });
    }
  }

  setTimeout(() => {
    const g = rooms.get(roomId);
    if (g && g.players[g.currentTurn]?.id === playerId && player.aiControlled) {
      makeAIMove(roomId, playerId);
    }
  }, 1500);
}

// =========================================
// 🏆 نهاية اللعبة
// =========================================
function handleGameEnd(roomId) {
  const game = rooms.get(roomId);
  if (!game) return;

  const winner = game.players.find(p => p.score >= game.maxScore);

  io.to(roomId).emit('game_ended', {
    winner: winner?.name,
    scores: game.players.map(p => ({ name: p.name, score: p.score })),
  });

  if (firebaseReady) {
    saveMatch({
      roomId,
      mode: game.mode,
      players: game.players.map(p => ({ name: p.name, score: p.score })),
      winner: winner?.name,
      duration: Date.now() - game.createdAt,
      createdAt: new Date(game.createdAt).toISOString(),
    });

    game.players.forEach(p => {
      updateUserStats(p.name, p.id === winner?.id, p.score);
    });

    updateLeaderboard();
  }

  setTimeout(() => closeRoom(roomId, "🏆 انتهت اللعبة"), 30000);
}

// =========================================
// 👀 إزالة مشاهد
// =========================================
function removeSpectator(socket, roomId) {
  const list = spectators.get(roomId) || [];
  const idx = list.findIndex(s => s.id === socket.id);

  if (idx !== -1) list.splice(idx, 1);

  if (list.length === 0) spectators.delete(roomId);
  else spectators.set(roomId, list);

  socket.leave(roomId);
  socket.isSpectator = false;
  socket.spectateRoomId = null;

  io.to(roomId).emit('spectator_left', {
    spectatorId: socket.id,
    totalSpectators: list.length,
  });
}

// =========================================
// 🔌 WebSocket
// =========================================
io.on('connection', (socket) => {
  log('INFO', `✅ لاعب متصل`, { socketId: socket.id });

  // تسجيل اللاعب
  socket.on('user_online', ({ userName, userAvatar }) => {
    if (userName) {
      onlineUsers.set(userName, socket.id);
      socket.userName = userName;
      socket.userAvatar = userAvatar || null;
      log('INFO', `👤 تسجيل دخول`, { userName });
    }
  });

  // =========================================
  // 🎮 دعوات اللعب
  // =========================================
  socket.on('invite_friend', ({ targetUserName, roomId, mode }) => {
    const targetSocketId = onlineUsers.get(targetUserName);

    if (targetSocketId) {
      io.to(targetSocketId).emit('receive_room_invite', {
        fromUser: socket.userName || "صديق",
        fromUserId: socket.id,
        fromUserAvatar: socket.userAvatar || null,
        roomId,
        mode,
        timestamp: Date.now(),
      });

      socket.emit('invite_sent', {
        targetUser: targetUserName,
        roomId,
        mode,
        timestamp: Date.now(),
      });

      log('INFO', `📩 دعوة أُرسلت`, { from: socket.userName, to: targetUserName });
    } else {
      socket.emit('invite_failed', {
        message: "الصديق غير متصل حالياً",
        targetUser: targetUserName,
      });
    }
  });

  socket.on('respond_invite', ({ roomId, accept, inviterName }) => {
    const inviterSocketId = onlineUsers.get(inviterName);

    if (inviterSocketId) {
      io.to(inviterSocketId).emit('invite_response', {
        fromUser: socket.userName,
        accept,
        roomId,
        timestamp: Date.now(),
      });

      if (accept) {
        io.to(inviterSocketId).emit('invite_accepted', {
          fromUser: socket.userName,
          roomId,
        });
      } else {
        io.to(inviterSocketId).emit('invite_rejected', {
          fromUser: socket.userName,
          roomId,
        });
      }
    }
  });

  // =========================================
  // 💬 رسائل الأصدقاء الخاصة
  // =========================================
  socket.on('send_private_message', async ({ toUserName, text, messageType = "text" }) => {
    const toSocketId = onlineUsers.get(toUserName);

    const message = {
      fromUser: socket.userName || "مجهول",
      fromUserId: socket.id,
      fromUserAvatar: socket.userAvatar || null,
      toUser: toUserName,
      text: (text || "").substring(0, 500),
      messageType,
      timestamp: Date.now(),
      read: false,
    };

    if (toSocketId) {
      io.to(toSocketId).emit('new_private_message', message);
    }

    socket.emit('message_sent', {
      messageId: Date.now().toString(),
      ...message,
    });

    if (firebaseReady) {
      try {
        await db.collection('private_messages').add({
          ...message,
          timestamp: new Date(message.timestamp),
        });
      } catch (err) {
        log('ERROR', 'حفظ رسالة خاصة', { error: err.message });
      }
    }
  });

  socket.on('mark_messages_read', async ({ withUserName }) => {
    if (!firebaseReady) return;

    try {
      const snapshot = await db.collection('private_messages')
        .where('fromUser', '==', withUserName)
        .where('toUser', '==', socket.userName)
        .where('read', '==', false)
        .get();

      const batch = db.batch();
      snapshot.docs.forEach(doc => {
        batch.update(doc.ref, { read: true });
      });

      await batch.commit();

      socket.emit('messages_marked_read', { count: snapshot.size });
    } catch (err) {
      log('ERROR', 'تحديث الرسائل', { error: err.message });
    }
  });

  socket.on('typing', ({ toUserName }) => {
    const toSocketId = onlineUsers.get(toUserName);
    if (toSocketId) {
      io.to(toSocketId).emit('user_typing', {
        fromUser: socket.userName,
      });
    }
  });

  // =========================================
  // 👀 Spectator Events
  // =========================================
  socket.on('spectate_room', ({ roomId, spectatorName }, callback) => {
    try {
      const game = rooms.get(roomId);
      if (!game) return callback?.({ error: "الغرفة غير موجودة" });
      if (game.gameStatus === "finished") {
        return callback?.({ error: "اللعبة انتهت" });
      }

      const currentSpecs = spectators.get(roomId) || [];
      if (currentSpecs.length >= MAX_SPECTATORS_PER_ROOM) {
        return callback?.({ error: "الغرفة ممتلئة بالمشاهدين" });
      }

      socket.join(roomId);
      socket.isSpectator = true;
      socket.spectatorName = spectatorName;
      socket.spectateRoomId = roomId;

      currentSpecs.push({ id: socket.id, name: spectatorName });
      spectators.set(roomId, currentSpecs);

      socket.emit('game_state', game.getPublicState(null));

      io.to(roomId).emit('spectator_joined', {
        spectatorId: socket.id,
        spectatorName,
        totalSpectators: currentSpecs.length,
      });

      callback?.({ success: true, totalSpectators: currentSpecs.length });
    } catch (err) {
      callback?.({ error: "فشل الانضمام" });
    }
  });

  socket.on('spectator_message', ({ roomId, text }) => {
    if (!socket.isSpectator || socket.spectateRoomId !== roomId) return;

    io.to(roomId).emit('spectator_message', {
      spectatorId: socket.id,
      spectatorName: socket.spectatorName,
      text: (text || "").substring(0, 100),
      timestamp: Date.now(),
    });
  });

  socket.on('spectator_emoji', ({ roomId, emoji }) => {
    if (!socket.isSpectator || socket.spectateRoomId !== roomId) return;

    io.to(roomId).emit('spectator_emoji', {
      spectatorId: socket.id,
      spectatorName: socket.spectatorName,
      emoji,
      timestamp: Date.now(),
    });
  });

  socket.on('leave_spectator', ({ roomId }) => {
    removeSpectator(socket, roomId);
  });

  // =========================================
  // 🎮 Game Events
  // =========================================
  socket.on('create_room', ({ playerName, mode = "1v1" }, callback) => {
    try {
      const roomId = generateRoomCode();
      const game = new DominoGame(roomId, mode, socket.id, playerName);
      game.lastActivity = Date.now();

      rooms.set(roomId, game);
      playerRooms.set(socket.id, roomId);
      socket.join(roomId);

      log('INFO', `🏠 غرفة جديدة`, { roomId, mode });

      callback({
        success: true,
        roomId,
        game: game.getPublicState(socket.id),
      });
    } catch (err) {
      callback({ error: "فشل إنشاء الغرفة" });
    }
  });

  socket.on('join_room', ({ roomId, playerName }, callback) => {
    try {
      if (!/^\d{5}$/.test(roomId)) {
        return callback({ error: "رمز الغرفة يجب أن يكون 5 أرقام" });
      }

      const game = rooms.get(roomId);
      if (!game) return callback({ error: "الغرفة غير موجودة" });
      if (game.isFull()) return callback({ error: "الغرفة ممتلئة" });

      game.addPlayer(socket.id, playerName);
      game.lastActivity = Date.now();
      playerRooms.set(socket.id, roomId);
      socket.join(roomId);

      io.to(roomId).emit('player_joined', {
        playerId: socket.id,
        playerName,
        game: game.getPublicState(),
      });

      if (game.isFull() && game.gameStatus === "waiting") {
        game.startRound();
        io.to(roomId).emit('game_started', {
          message: "🎲 بدأت اللعبة!",
          voiceChannel: roomId,
        });
        game.players.forEach(p => {
          io.to(p.id).emit('game_state', game.getPublicState(p.id));
        });
      }

      callback({
        success: true,
        roomId,
        game: game.getPublicState(socket.id),
      });
    } catch (err) {
      callback({ error: "فشل الانضمام" });
    }
  });

  socket.on('play_tile', ({ roomId, tile, side }, callback) => {
    try {
      const game = rooms.get(roomId);
      if (!game) return callback?.({ error: "الغرفة غير موجودة" });

      game.lastActivity = Date.now();
      const result = game.playTile(socket.id, tile, side);
      if (result.error) return callback?.({ error: result.error });

      game.players.forEach(p => {
        io.to(p.id).emit('game_state', game.getPublicState(p.id));
      });

      socket.to(roomId).emit('game_state', game.getPublicState(null));

      if (result.gameEnded) {
        io.to(roomId).emit('round_ended', game.lastAction);
        if (game.gameStatus === "finished") handleGameEnd(roomId);
      } else {
        const nextPlayer = game.players[game.currentTurn];
        if (nextPlayer?.aiControlled) {
          setTimeout(() => makeAIMove(roomId, nextPlayer.id), 1000);
        }
      }

      callback?.({ success: true });
    } catch (err) {
      callback?.({ error: "فشل الحركة" });
    }
  });

  socket.on('draw_tile', ({ roomId }, callback) => {
    try {
      const game = rooms.get(roomId);
      if (!game) return callback?.({ error: "الغرفة غير موجودة" });

      game.lastActivity = Date.now();
      const result = game.drawTile(socket.id);
      if (result.error) return callback?.({ error: result.error });

      game.players.forEach(p => {
        io.to(p.id).emit('game_state', game.getPublicState(p.id));
      });

      socket.to(roomId).emit('game_state', game.getPublicState(null));

      callback?.({ success: true, tile: result.tile });
    } catch (err) {
      callback?.({ error: "فشل السحب" });
    }
  });

  socket.on('pass_turn', ({ roomId }, callback) => {
    try {
      const game = rooms.get(roomId);
      if (!game) return callback?.({ error: "الغرفة غير موجودة" });

      game.lastActivity = Date.now();
      const result = game.passTurn(socket.id);
      if (result.error) return callback?.({ error: result.error });

      game.players.forEach(p => {
        io.to(p.id).emit('game_state', game.getPublicState(p.id));
      });

      socket.to(roomId).emit('game_state', game.getPublicState(null));

      if (result.gameEnded) {
        io.to(roomId).emit('round_ended', game.lastAction);
        if (game.gameStatus === "finished") handleGameEnd(roomId);
      } else {
        const nextPlayer = game.players[game.currentTurn];
        if (nextPlayer?.aiControlled) {
          setTimeout(() => makeAIMove(roomId, nextPlayer.id), 1000);
        }
      }

      callback?.({ success: true });
    } catch (err) {
      callback?.({ error: "فشل التمرير" });
    }
  });

  socket.on('new_round', ({ roomId }, callback) => {
    try {
      const game = rooms.get(roomId);
      if (!game) return callback?.({ error: "الغرفة غير موجودة" });

      const result = game.newRound();
      if (result.error) return callback?.({ error: result.error });

      game.players.forEach(p => {
        io.to(p.id).emit('game_state', game.getPublicState(p.id));
      });

      callback?.({ success: true });
    } catch (err) {
      callback?.({ error: "فشل الجولة" });
    }
  });

  // الدردشة داخل الغرفة
  socket.on('send_message', async ({ roomId, text, type = "text" }) => {
    const game = rooms.get(roomId);
    if (!game) return;

    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;

    const message = {
      playerId: socket.id,
      playerName: player.name,
      text: (text || "").substring(0, 100),
      type,
      timestamp: Date.now(),
    };

    io.to(roomId).emit('chat_message', message);

    if (firebaseReady) {
      try {
        await db.collection('chat_messages').add({
          roomId,
          ...message,
          timestamp: new Date(message.timestamp),
        });
      } catch (err) {
        log('ERROR', 'حفظ الرسالة', { error: err.message });
      }
    }
  });

  // 🎤 إشعارات الصوت
  socket.on('voice_joined', ({ roomId }) => {
    const game = rooms.get(roomId);
    if (!game) return;

    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;

    socket.to(roomId).emit('voice_user_joined', {
      playerId: socket.id,
      playerName: player.name,
      channel: roomId,
    });
  });

  socket.on('voice_left', ({ roomId }) => {
    socket.to(roomId).emit('voice_user_left', { playerId: socket.id });
  });

  socket.on('voice_muted', ({ roomId, muted }) => {
    const game = rooms.get(roomId);
    if (!game) return;

    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;

    socket.to(roomId).emit('voice_user_muted', {
      playerId: socket.id,
      playerName: player.name,
      muted,
    });
  });

  // إعادة اتصال
  socket.on('reconnect_player', ({ roomId, playerName }, callback) => {
    const game = rooms.get(roomId);
    if (!game) return callback?.({ error: "الغرفة غير موجودة" });

    const oldPlayer = game.players.find(p =>
      p.name === playerName && !p.connected
    );

    if (!oldPlayer) return callback?.({ error: "لا يمكن إعادة الاتصال" });

    const oldId = oldPlayer.id;
    playerRooms.delete(oldId);

    oldPlayer.id = socket.id;
    oldPlayer.connected = true;
    playerRooms.set(socket.id, roomId);
    socket.join(roomId);

    stopAIFallback(roomId, oldId);
    stopAIFallback(roomId, socket.id);

    io.to(roomId).emit('player_reconnected', {
      playerId: socket.id,
      playerName,
    });

    callback?.({ success: true, game: game.getPublicState(socket.id) });
  });

  socket.on('leave_room', ({ roomId }) => {
    handlePlayerLeave(socket, roomId);
  });

  socket.on('disconnect', () => {
    log('INFO', `❌ قطع`, { socketId: socket.id, userName: socket.userName });

    if (socket.isSpectator && socket.spectateRoomId) {
      removeSpectator(socket, socket.spectateRoomId);
    }

    if (socket.userName) {
      onlineUsers.delete(socket.userName);
    }

    const roomId = playerRooms.get(socket.id);
    if (roomId) handlePlayerLeave(socket, roomId);
  });
});

// =========================================
// مغادرة اللاعب
// =========================================
function handlePlayerLeave(socket, roomId) {
  const game = rooms.get(roomId);
  if (!game) return;

  game.markDisconnected(socket.id);
  game.lastActivity = Date.now();
  socket.leave(roomId);
  playerRooms.delete(socket.id);

  io.to(roomId).emit('player_left', {
    playerId: socket.id,
    message: "أحد اللاعبين غادر",
  });

  socket.to(roomId).emit('voice_user_left', { playerId: socket.id });

  const player = game.players.find(p => p.id === socket.id);

  if (player && game.players.filter(p => p.connected).length > 0) {
    player.aiTakeoverTimer = setTimeout(() => {
      const currentGame = rooms.get(roomId);
      if (!currentGame) return;

      const currentPlayer = currentGame.players.find(p => p.id === socket.id);
      if (!currentPlayer || currentPlayer.connected) return;

      startAIFallback(roomId, socket.id);
    }, AI_TAKEOVER_DELAY);
  }

  const connectedPlayers = game.players.filter(p => p.connected);
  if (connectedPlayers.length === 0) {
    closeRoom(roomId, "👋 غادر جميع اللاعبين");
  }
}

// =========================================
// تشغيل
// =========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   🎲 Domino Server v9.1              ║
  ║   Port: ${PORT}                          ║
  ║   Firebase: ${firebaseReady ? '✅' : '⚠️'}                      ║
  ║   Supabase: ${supabaseReady ? '✅' : '⚠️'}                      ║
  ║   Agora: ${AGORA_APP_ID ? '✅' : '⚠️'}                         ║
  ║   WebSocket: ✅ (ws)                   ║
  ║   Room Code: 5 أرقام                 ║
  ║   Friend Chat: ✅                     ║
  ║   Invitations: ✅                     ║
  ╚═══════════════════════════════════════╝
  `);
});

process.on('uncaughtException', (err) => {
  log('ERROR', 'خطأ غير متوقع', { error: err.message });
});
process.on('unhandledRejection', (err) => {
  log('ERROR', 'رفض غير معالج', { error: err.message });
});
