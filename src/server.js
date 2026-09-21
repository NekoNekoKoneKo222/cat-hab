'use strict';

const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const admin = require('firebase-admin');

const app = express();
const rootDir = path.resolve(__dirname, '..');
const adminFile = path.join(rootDir, 'admin.txt');
const port = Number.parseInt(process.env.PORT || '3000', 10);
const host = '0.0.0.0';

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

let firebaseReady = false;
try {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountJson) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(serviceAccountJson))
    });
    firebaseReady = true;
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT is not configured; authentication is disabled.');
  }
} catch (error) {
  console.error('Firebase Admin initialization failed:', error.message);
}

function publicFirebaseConfig() {
  return {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    appId: process.env.FIREBASE_APP_ID || ''
  };
}

async function readAdminEntries() {
  const text = await fs.readFile(adminFile, 'utf8');
  return new Set(text.split(/\r?\n/)
    .map(line => line.trim().toLowerCase())
    .filter(line => line && !line.startsWith('#')));
}

async function authenticate(req, res, next) {
  if (!firebaseReady) {
    return res.status(503).json({ error: 'Firebase Adminが設定されていません。' });
  }
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ error: 'ログインが必要です。' });
  try {
    req.user = await admin.auth().verifyIdToken(match[1], true);
    return next();
  } catch {
    return res.status(401).json({ error: 'ログイン情報が無効または期限切れです。' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const entries = await readAdminEntries();
    const uid = String(req.user.uid || '').toLowerCase();
    const email = String(req.user.email || '').toLowerCase();
    if (!entries.has(uid) && !entries.has(email)) {
      return res.status(403).json({ error: '管理者権限がありません。' });
    }
    return next();
  } catch (error) {
    console.error('admin.txt read failed:', error.message);
    return res.status(500).json({ error: '管理者設定を読み込めません。' });
  }
}

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'cat-hub', firebase: firebaseReady });
});

app.get('/api/config/firebase', (_req, res) => {
  const config = publicFirebaseConfig();
  const enabled = firebaseReady && Object.values(config).every(Boolean);
  res.set('Cache-Control', 'no-store').json({ enabled, config: enabled ? config : {} });
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  const entries = await readAdminEntries().catch(() => new Set());
  const uid = String(req.user.uid || '').toLowerCase();
  const email = String(req.user.email || '').toLowerCase();
  res.json({
    uid: req.user.uid,
    email: req.user.email || null,
    name: req.user.name || null,
    isAdmin: entries.has(uid) || entries.has(email)
  });
});

app.get('/api/admin/status', authenticate, requireAdmin, (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    adminSource: 'admin.txt',
    firebase: 'connected',
    services: ['Cat Tube', 'Cloud Cat', 'Play Cat', 'Reverse Proxy'],
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.use('/ui', express.static(path.join(rootDir, 'ui'), {
  index: false,
  fallthrough: false,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
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

const server = app.listen(port, host, () => {
  console.log(`Cat Hub listening on http://${host}:${port}`);
});

function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  server.close(error => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
