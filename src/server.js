'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
const rootDir = path.resolve(__dirname, '..');
const adminFile = path.join(rootDir, 'admin.txt');
const port = Number.parseInt(process.env.PORT || '3000', 10);
const host = '0.0.0.0';
const databaseUrl = process.env.SUPABASE_DATABASE_URL || '';
const isProduction = process.env.NODE_ENV === 'production';
const configuredSecret = process.env.SESSION_SECRET || '';

if (isProduction && configuredSecret.length < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 characters in production.');
}
const sessionSecret = configuredSecret || crypto.randomBytes(32).toString('hex');

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

const pool = databaseUrl ? new Pool({
  connectionString: databaseUrl,
  ssl: isProduction ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
}) : null;

let databaseReady = false;

async function initializeDatabase() {
  if (!pool) {
    console.warn('SUPABASE_DATABASE_URL is not configured; account features are disabled.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cat_hub_users (
      id UUID PRIMARY KEY,
      username VARCHAR(20) UNIQUE NOT NULL,
      display_name VARCHAR(40) NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  databaseReady = true;
  console.log('Supabase PostgreSQL is ready.');
}

app.use(session({
  name: 'cat_hub_session',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  store: pool ? new pgSession({
    pool,
    tableName: 'cat_hub_sessions',
    createTableIfMissing: true
  }) : undefined,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validUsername(username) {
  return /^[a-z0-9_]{3,20}$/.test(username);
}

async function readAdminEntries() {
  const text = await fs.readFile(adminFile, 'utf8');
  return new Set(text.split(/\r?\n/)
    .map(normalizeUsername)
    .filter(line => line && !line.startsWith('#')));
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'ログインが必要です。' });
  return next();
}

async function requireAdmin(req, res, next) {
  try {
    const entries = await readAdminEntries();
    if (!entries.has(normalizeUsername(req.session.user.username))) {
      return res.status(403).json({ error: '管理者権限がありません。' });
    }
    return next();
  } catch (error) {
    console.error('admin.txt read failed:', error.message);
    return res.status(500).json({ error: '管理者設定を読み込めません。' });
  }
}

const attempts = new Map();
function authRateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter(time => now - time < 60_000);
  if (recent.length >= 10) {
    return res.status(429).json({ error: '試行回数が多すぎます。1分後にお試しください。' });
  }
  recent.push(now);
  attempts.set(key, recent);
  return next();
}

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'cat-hub', supabase: databaseReady });
});

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  if (!databaseReady) return res.status(503).json({ error: 'Supabaseデータベースが設定されていません。' });
  const username = normalizeUsername(req.body.username);
  const displayName = String(req.body.displayName || '').trim();
  const password = String(req.body.password || '');

  if (!validUsername(username)) {
    return res.status(400).json({ error: 'ユーザー名は3〜20文字の半角英数字と_のみ使用できます。' });
  }
  if (displayName.length < 1 || displayName.length > 40) {
    return res.status(400).json({ error: '表示名は1〜40文字で入力してください。' });
  }
  if (password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: 'パスワードは8〜72文字で入力してください。' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const id = crypto.randomUUID();
    await pool.query(
      'INSERT INTO cat_hub_users (id, username, display_name, password_hash) VALUES ($1, $2, $3, $4)',
      [id, username, displayName, passwordHash]
    );
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.user = { id, username, displayName };
    return res.status(201).json({ user: req.session.user });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'このユーザー名は既に使用されています。' });
    console.error('Registration failed:', error.message);
    return res.status(500).json({ error: 'アカウント登録に失敗しました。' });
  }
});

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  if (!databaseReady) return res.status(503).json({ error: 'Supabaseデータベースが設定されていません。' });
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || '');

  try {
    const result = await pool.query(
      'SELECT id, username, display_name, password_hash FROM cat_hub_users WHERE username = $1 LIMIT 1',
      [username]
    );
    const account = result.rows[0];
    if (!account || !(await bcrypt.compare(password, account.password_hash))) {
      return res.status(401).json({ error: 'ユーザー名またはパスワードが正しくありません。' });
    }
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.user = {
      id: account.id,
      username: account.username,
      displayName: account.display_name
    };
    return res.json({ user: req.session.user });
  } catch (error) {
    console.error('Login failed:', error.message);
    return res.status(500).json({ error: 'ログイン処理に失敗しました。' });
  }
});

app.post('/api/auth/logout', requireLogin, (req, res) => {
  req.session.destroy(error => {
    if (error) return res.status(500).json({ error: 'ログアウトに失敗しました。' });
    res.clearCookie('cat_hub_session', { httpOnly: true, secure: isProduction, sameSite: 'lax' });
    return res.status(204).end();
  });
});

app.get('/api/auth/me', requireLogin, async (req, res) => {
  const entries = await readAdminEntries().catch(() => new Set());
  res.set('Cache-Control', 'no-store').json({
    user: req.session.user,
    isAdmin: entries.has(normalizeUsername(req.session.user.username))
  });
});

app.get('/api/admin/status', requireLogin, requireAdmin, (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    adminSource: 'admin.txt',
    database: 'Supabase PostgreSQL',
    services: ['Cat Tube', 'Cloud Cat', 'Play Cat', 'Reverse Proxy'],
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.use('/ui', express.static(path.join(rootDir, 'ui'), {
  index: false,
  fallthrough: false,
  maxAge: isProduction ? '1h' : 0
}));

const pages = new Set([
  'index.html', 'cattube.html', 'cloudcat.html', 'playcat.html',
  'proxy.html', 'admin.html', 'login.html', 'register.html'
]);

app.get('/', (_req, res) => res.sendFile(path.join(rootDir, 'index.html')));
app.get('/:page', (req, res, next) => {
  if (!pages.has(req.params.page)) return next();
  return res.sendFile(path.join(rootDir, req.params.page));
});

app.use((_req, res) => {
  res.status(404).type('html').send('<!doctype html><html lang="ja"><meta charset="utf-8"><title>404 | Cat Hub</title><body style="font-family:system-ui;background:#0b1020;color:#fff;padding:40px"><h1>404</h1><p>ページが見つかりません。</p><a style="color:#6c8cff" href="/">Cat Hubへ戻る</a></body></html>');
});

initializeDatabase().catch(error => {
  databaseReady = false;
  console.error('Supabase database initialization failed:', error.message);
});

const server = app.listen(port, host, () => {
  console.log(`Cat Hub listening on http://${host}:${port}`);
});

function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  server.close(async error => {
    if (pool) await pool.end().catch(() => {});
    process.exit(error ? 1 : 0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
