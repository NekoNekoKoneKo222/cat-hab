'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Server: SocketIOServer } = require('socket.io');

const config = require('./config');
const db = require('./db');
const { requireAdmin } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const proxyRoutes = require('./routes/proxy');
const uploadRoutes = require('./routes/upload');
const friendsRoutes = require('./routes/friends');
const dmRoutes = require('./routes/dm');
const notificationsRoutes = require('./routes/notifications');
const groupsRoutes = require('./routes/groups');
const communitiesRoutes = require('./routes/communities');
const roomsRoutes = require('./routes/rooms');
const cattubeRoutes = require('./routes/cattube');
const gamesRoutes = require('./routes/games');
const bus = require('./utils/events');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: false }, // 同一オリジンのみ許可。Cross-Origin接続は行わない。
});

app.set('trust proxy', 1); // Render等リバースプロキシ配下でsecure cookieを正しく扱う

// VM_ISO_URLが外部URLの場合、そのオリジンをCSPのconnect-srcへ動的に追加する。
// (相対パスの場合は'self'で足りるため追加不要)
function resolveIsoOrigin() {
  try {
    const u = new URL(config.vm.isoUrl, 'https://placeholder.invalid');
    if (u.origin === 'https://placeholder.invalid') return null; // 相対パスだった
    return u.origin;
  } catch (err) {
    return null;
  }
}
const isoOrigin = resolveIsoOrigin();
const connectSrcDirectives = ["'self'", 'https://www.googleapis.com'];
if (isoOrigin) connectSrcDirectives.push(isoOrigin);

// --- セキュリティヘッダ ---
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: connectSrcDirectives,
        mediaSrc: ["'self'", 'https:', 'blob:'],
        frameSrc: ["'self'", 'https://www.youtube.com', 'https://unityroom.com'],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false, // v86はSharedArrayBufferを使用しないため不要

  })
);

app.use(morgan(config.isProd ? 'combined' : 'dev'));

// --- Body parsing (サイズ制限でDoS/乱用対策) ---
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// --- セッション ---
const sessionMiddleware = session({
  store: config.databaseUrl
    ? new PgSession({
        pool: db.pool,
        tableName: 'session',
        createTableIfMissing: true,
      })
    : undefined, // DATABASE_URL未設定時はメモリストア(開発用フォールバック)
  name: 'cathub.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7日
  },
});
app.use(sessionMiddleware);

// --- 静的ファイル配信 ---
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(
  '/uploads',
  express.static(path.join(__dirname, '..', 'uploads'), {
    // アップロードファイルはブラウザにスクリプトとして解釈されないようMIME推測を無効化
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
    },
  })
);

// --- ヘルスチェック (Render用) ---
app.get('/healthz', async (req, res) => {
  const dbOk = await db.healthCheck();
  res.json({ ok: true, db: dbOk, env: config.nodeEnv });
});

// --- API ---
app.use('/api/auth', authRoutes);
app.use('/api/proxy', proxyRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/dm', dmRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/communities', communitiesRoutes);
app.use('/api/rooms', roomsRoutes);
app.use('/api/cattube', cattubeRoutes);
app.use('/api/games', gamesRoutes);

app.get('/api/config/public', (req, res) => {
  // フロントエンドが必要とする「秘密情報を含まない」設定値のみ返す
  res.json({
    vmEnabled: config.vm.enabled,
    vmIsoUrl: config.vm.isoUrl,
    vmMemoryMb: config.vm.memoryMb,
    vmCpuCount: config.vm.cpuCount,
    vmMaxIsoSizeMb: config.vm.maxIsoSizeMb,
    youtubeEnabled: Boolean(config.youtubeApiKey),
  });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  // 管理者向け: 値の有無のみ返し、秘密情報自体はGUIに表示しない
  res.json({
    vm: {
      isoUrlConfigured: Boolean(config.vm.isoUrl),
      isoUrl: config.vm.isoUrl, // ISO URLは秘密情報ではない運用前提(READMEに明記)
      enabled: config.vm.enabled,
      memoryMb: config.vm.memoryMb,
      cpuCount: config.vm.cpuCount,
      maxIsoSizeMb: config.vm.maxIsoSizeMb,
      networkProxyAllowlistCount: config.vm.networkProxyAllowlist.length,
    },
    proxy: {
      allowedHostsCount: config.allowedProxyHosts.length,
    },
    youtube: {
      apiKeyConfigured: Boolean(config.youtubeApiKey),
    },
    adminUsersCount: config.adminUsers.length,
  });
});

// --- 未認証/不明APIの404 ---
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// --- SPA的ルーティングではなく複数静的ページ構成。存在しないパスは404ページ ---
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
});

// --- エラーハンドラ (詳細なスタックはクライアントへ返さない) ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error('[error]', err);
  res.status(500).json({ error: 'サーバー内部エラーが発生しました' });
});

// Socket.IOにセッションを共有
io.engine.use(sessionMiddleware);

async function checkRoomMembership(scope, roomId, userId) {
  if (scope === 'dm') {
    const r = await db.query('SELECT 1 FROM dm_members WHERE room_id = $1 AND user_id = $2', [
      roomId,
      userId,
    ]);
    return r.rows.length > 0;
  }
  if (scope === 'room') {
    const r = await db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [
      roomId,
      userId,
    ]);
    return r.rows.length > 0;
  }
  if (scope === 'channel') {
    // コミュニティ/チャンネルはログイン済みユーザーに公開されている
    return true;
  }
  return false;
}

io.on('connection', (socket) => {
  const session = socket.request.session;
  const userId = session && session.userId;

  if (userId) {
    socket.join('user:' + userId);
  }

  socket.on('join', async ({ scope, roomId }, ack) => {
    try {
      if (!userId) return ack && ack({ ok: false, error: 'ログインが必要です' });
      const id = Number(roomId);
      if (!['dm', 'channel', 'room'].includes(scope) || !Number.isInteger(id)) {
        return ack && ack({ ok: false, error: '不正なパラメータです' });
      }
      const allowed = await checkRoomMembership(scope, id, userId);
      if (!allowed) return ack && ack({ ok: false, error: 'アクセス権がありません' });
      socket.join(scope + ':' + id);
      return ack && ack({ ok: true });
    } catch (err) {
      return ack && ack({ ok: false, error: 'サーバーエラーが発生しました' });
    }
  });

  socket.on('leave', ({ scope, roomId }) => {
    const id = Number(roomId);
    if (['dm', 'channel', 'room'].includes(scope) && Number.isInteger(id)) {
      socket.leave(scope + ':' + id);
    }
  });

  socket.on('disconnect', () => {});
});

// DB更新後に発行されるイベントをSocket.IOで該当ルームへ配信する
bus.on('message:new', ({ scope, roomId, message }) => {
  io.to(scope + ':' + roomId).emit('message:new', { scope, roomId, message });
});
bus.on('message:deleted', ({ scope, roomId, messageId }) => {
  io.to(scope + ':' + roomId).emit('message:deleted', { scope, roomId, messageId });
});
bus.on('reaction:update', (payload) => {
  io.to(payload.scope + ':' + payload.roomId).emit('reaction:update', payload);
});
bus.on('notification', ({ userId: targetUserId, notification }) => {
  io.to('user:' + targetUserId).emit('notification', notification);
});

async function start() {
  try {
    await db.initSchema();
    await db.seedInitialData();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[db] スキーマ初期化に失敗しました:', err.message);
  }
  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[cathub] Cat Hub がポート ${config.port} で起動しました (env=${config.nodeEnv})`);
  });
}

start();

module.exports = { app, server, io };
