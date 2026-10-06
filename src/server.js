'use strict';

const path = require('path');
const express = require('express');
const fs = require('node:fs');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const { fetchSafe, ProxyError } = require('./safe-proxy');

const app = express();
const rootDir = path.resolve(__dirname, '..');
const port = Number.parseInt(process.env.PORT || '3000', 10);
const host = '0.0.0.0';
const pool = new Pool({ connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
const admins = new Set(String(process.env.ADMIN_USERS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", 'https://www.youtube.com', 'https://unityroom.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    }
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '32kb' }));
app.use(session({ store: new PgSession({ pool, tableName: 'hub_sessions', createTableIfMissing: true }),
  name: 'cathub.sid', secret: process.env.SESSION_SECRET || 'development-only-change-me',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7*24*60*60*1000 } }));
app.use((req, res, next) => {
  if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
    const origin = req.get('origin');
    if ((process.env.NODE_ENV === 'production' && !origin) ||
        (origin && origin !== `${req.protocol}://${req.get('host')}`) ||
        req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Originが一致しません' });
  }
  next();
});

const q = (sql, params = []) => pool.query(sql, params);
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0,max) : '';
const userView = user => ({ id:user.id, username:user.username, displayName:user.display_name, isAdmin:admins.has(user.username) });
const attempts = new Map();
function authLimit(req,res,next) {
  const now=Date.now(), key=req.ip, entry=attempts.get(key)||{count:0,until:now+15*60*1000};
  if(now>entry.until){entry.count=0;entry.until=now+15*60*1000;}
  entry.count++;attempts.set(key,entry);
  if(entry.count>20)return res.status(429).json({error:'試行回数が多すぎます'});
  next();
}

async function authenticate(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'ログインが必要です。' });
  try {
    const result = await q('SELECT id,username,display_name,banned_at FROM hub_users WHERE id=$1',[req.session.userId]);
    if (!result.rowCount || result.rows[0].banned_at) return res.status(403).json({ error: 'アカウントを利用できません。' });
    req.user = result.rows[0];
    return next();
  } catch {
    return res.status(503).json({ error: 'データベースに接続できません。' });
  }
}

const requireAdmin = (req,res,next) => admins.has(req.user.username) ? next() : res.status(403).json({error:'管理者権限がありません。'});

app.get('/healthz', async (_req,res) => { try { await q('SELECT 1'); res.json({ok:true,service:'cat-hub',db:true}); } catch { res.status(503).json({ok:false,db:false}); } });

app.post('/api/auth/signup', authLimit, async (req,res) => {
  const username=clean(req.body.username,32).toLowerCase(), display=clean(req.body.displayName,64)||username, password=String(req.body.password||'');
  if (!/^[a-z0-9_]{3,32}$/.test(username) || admins.has(username) || password.length<8 || password.length>128 || req.body.acceptTerms!==true) return res.status(400).json({error:'入力内容または利用規約への同意を確認してください'});
  try { const hash=await bcrypt.hash(password,12); const result=await q('INSERT INTO hub_users(username,display_name,password_hash,terms_accepted_at) VALUES($1,$2,$3,NOW()) RETURNING id,username,display_name',[username,display,hash]);
    req.session.regenerate(err=>{if(err)return res.status(500).json({error:'セッションエラー'});req.session.userId=result.rows[0].id;res.status(201).json({user:userView(result.rows[0])});});
  } catch(err) { if(err.code==='23505')return res.status(409).json({error:'ユーザー名は使用済みです'}); console.error(err);res.status(503).json({error:'登録できません'}); }
});
app.post('/api/auth/login', authLimit, async (req,res) => {
  try { const name=clean(req.body.username,32).toLowerCase(),result=await q('SELECT * FROM hub_users WHERE username=$1',[name]);
    if(!result.rowCount||!(await bcrypt.compare(String(req.body.password||''),result.rows[0].password_hash)))return res.status(401).json({error:'ログイン情報が違います'});
    if(result.rows[0].banned_at)return res.status(403).json({error:'アカウントを利用できません'});
    req.session.regenerate(err=>{if(err)return res.status(500).json({error:'セッションエラー'});req.session.userId=result.rows[0].id;res.json({user:userView(result.rows[0])});});
  } catch(err) { console.error(err);res.status(503).json({error:'ログインできません'}); }
});
app.post('/api/auth/logout',(req,res)=>req.session.destroy(()=>{res.clearCookie('cathub.sid');res.json({ok:true});}));

app.get('/api/auth/me', authenticate, async (req, res) => {
  res.set('Cache-Control','no-store').json(userView(req.user));
});
app.patch('/api/auth/profile', authenticate, async (req,res) => {
  const display=clean(req.body.displayName,64);
  if(!display)return res.status(400).json({error:'表示名が必要です'});
  try{const result=await q('UPDATE hub_users SET display_name=$1 WHERE id=$2 RETURNING id,username,display_name',[display,req.user.id]);res.json(userView(result.rows[0]));}
  catch(err){console.error(err);res.status(503).json({error:'更新できません'});}
});
app.patch('/api/auth/username', authenticate, async (req,res) => {
  const name=clean(req.body.username,32).toLowerCase();
  if(!/^[a-z0-9_]{3,32}$/.test(name)||admins.has(name))return res.status(400).json({error:'アカウント名が不正です'});
  try{const result=await q('UPDATE hub_users SET username=$1 WHERE id=$2 RETURNING id,username,display_name',[name,req.user.id]);res.json(userView(result.rows[0]));}
  catch(err){res.status(err.code==='23505'?409:503).json({error:err.code==='23505'?'アカウント名は使用済みです':'更新できません'});}
});
app.patch('/api/auth/password', authenticate, async (req,res) => {
  const next=String(req.body.newPassword||'');if(next.length<8||next.length>128)return res.status(400).json({error:'パスワードは8〜128文字です'});
  try{const result=await q('SELECT password_hash FROM hub_users WHERE id=$1',[req.user.id]);if(!(await bcrypt.compare(String(req.body.currentPassword||''),result.rows[0].password_hash)))return res.status(403).json({error:'現在のパスワードが違います'});await q('UPDATE hub_users SET password_hash=$1 WHERE id=$2',[await bcrypt.hash(next,12),req.user.id]);res.json({ok:true});}
  catch(err){console.error(err);res.status(503).json({error:'変更できません'});}
});

app.get('/api/admin/status', authenticate, requireAdmin, (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    adminSource: 'ADMIN_USERS',
    authentication: 'username/password',
    services: ['Cat Tube', 'Cloud Cat', 'Play Cat', 'Reverse Proxy'],
    uptimeSeconds: Math.floor(process.uptime())
  });
});

// Only public data types are returned. Neither browser credentials nor incoming
// headers are forwarded to the destination.
app.get('/api/proxy', authenticate, async (req, res) => {
  const rawUrl = req.query.url;
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) {
    return res.status(400).json({ error: 'urlパラメータを指定してください' });
  }
  try {
    const result = await fetchSafe(rawUrl);
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': result.type });
    return res.status(result.status).send(result.body);
  } catch (error) {
    return res.status(error instanceof ProxyError ? error.status : 502).json({ error: error instanceof ProxyError ? error.message : '接続に失敗しました' });
  }
});

const services = {
  cloud: process.env.CLOUD_CAT_URL,
  tube: process.env.CAT_TUBE_URL,
};
app.get('/api/services', authenticate, (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    cloud: { configured: Boolean(services.cloud), url: services.cloud || null },
    tube: { configured: Boolean(services.tube), url: services.tube || null },
  });
});
app.get('/api/services/:name/health', authenticate, async (req, res) => {
  const base = services[req.params.name];
  if (!base) return res.status(404).json({ error: 'サービスが未設定です' });
  try {
    const target = new URL('/healthz', base);
    const result = await fetchSafe(target.href);
    return res.status(result.status).type('application/json').send(result.type === 'application/json' ? result.body : JSON.stringify({ online: result.status === 200 }));
  } catch (error) {
    return res.status(502).json({ error: 'サービスへ接続できません' });
  }
});

app.get('/api/games', authenticate, async (req,res) => {
  try{const term='%'+clean(req.query.q,80)+'%',category=clean(req.query.category,40);
    const result=await q(`SELECT g.*,EXISTS(SELECT 1 FROM game_favorites f WHERE f.game_id=g.id AND f.user_id=$1) AS favorite FROM games g WHERE (g.title ILIKE $2 OR g.description ILIKE $2 OR $2='%%') AND ($3='' OR g.category=$3) ORDER BY g.created_at DESC LIMIT 100`,[req.user.id,term,category]);res.json(result.rows);}
  catch(err){console.error(err);res.status(503).json({error:'ゲームを取得できません'});}
});
app.post('/api/games/:id/favorite',authenticate,async(req,res)=>{try{await q('INSERT INTO game_favorites(user_id,game_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.user.id,req.params.id]);res.json({ok:true});}catch{res.status(400).json({error:'ゲームがありません'});}});
app.delete('/api/games/:id/favorite',authenticate,async(req,res)=>{try{await q('DELETE FROM game_favorites WHERE user_id=$1 AND game_id=$2',[req.user.id,req.params.id]);res.json({ok:true});}catch{res.status(400).json({error:'処理に失敗しました'});}});

app.use('/ui', express.static(path.join(rootDir, 'ui'), {
  index: false,
  fallthrough: false,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));
app.use('/games', authenticate, express.static(path.join(rootDir,'games'),{index:false}));

const pages = new Set([
  'index.html', 'cattube.html', 'cloudcat.html', 'playcat.html',
  'proxy.html', 'admin.html', 'login.html', 'register.html', 'terms.html', 'settings.html'
]);

app.get('/', (_req, res) => res.sendFile(path.join(rootDir, 'index.html')));
app.get('/:page', (req, res, next) => {
  if (!pages.has(req.params.page)) return next();
  return res.sendFile(path.join(rootDir, req.params.page));
});

app.use((_req, res) => {
  res.status(404).type('html').send('<!doctype html><html lang="ja"><meta charset="utf-8"><title>404 | Cat Hub</title><body style="font-family:system-ui;background:#0b1020;color:#fff;padding:40px"><h1>404</h1><p>ページが見つかりません。</p><a style="color:#6c8cff" href="/">Cat Hubへ戻る</a></body></html>');
});

let server;
async function start() {
  if (!process.env.DATABASE_URL || !process.env.SESSION_SECRET) throw new Error('DATABASE_URL と SESSION_SECRET が必要です');
  await q(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  server = app.listen(port, host, () => console.log(`Cat Hub listening on http://${host}:${port}`));
  return server;
}
if (require.main === module) start().catch(err => { console.error(err.message); process.exit(1); });

function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  if (server) server.close(error => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
module.exports = { app, start };
