'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const { firestore, FirestoreSessionStore } = require('./firebase-store');
const { fetchSafe, ProxyError } = require('./safe-proxy');

const app = express();
const db = firestore();
const rootDir = path.resolve(__dirname, '..');
const prod = process.env.NODE_ENV === 'production';
const admins = new Set(String(process.env.ADMIN_USERS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const users = db.collection('hub_users');
const names = db.collection('hub_usernames');
const games = db.collection('hub_games');
const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const clean = (value,max) => typeof value === 'string' ? value.trim().slice(0,max) : '';
const view = (id,user) => ({ id, username:user.username, displayName:user.displayName, isAdmin:admins.has(user.username) });
const now = () => Date.now();

app.disable('x-powered-by');
if (prod) app.set('trust proxy',1);
app.use(helmet({ contentSecurityPolicy:{ directives:{
  defaultSrc:["'self'"], scriptSrc:["'self'"], styleSrc:["'self'","'unsafe-inline'"],
  imgSrc:["'self'",'data:','https:'], connectSrc:["'self'"],
  frameSrc:["'self'",'https://www.youtube.com','https://unityroom.com'],
  objectSrc:["'none'"], baseUri:["'self'"]
}}, crossOriginEmbedderPolicy:false }));
app.use(express.json({limit:'32kb'}));
app.use(session({ store:new FirestoreSessionStore(db,'hub_sessions'),
  name:'cathub.sid', secret:process.env.SESSION_SECRET || 'development-only-change-me',
  resave:false, saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:'lax',secure:prod,maxAge:7*86400000}
}));
app.use((req,res,next)=>{
  if(['POST','PUT','PATCH','DELETE'].includes(req.method)){
    const origin=req.get('origin');
    if((prod&&!origin)||(origin&&origin!==`${req.protocol}://${req.get('host')}`)||req.get('sec-fetch-site')==='cross-site')return res.status(403).json({error:'Originが一致しません'});
  }
  next();
});

const attempts=new Map();
function authLimit(req,res,next){const timestamp=now(),key=req.ip,entry=attempts.get(key)||{count:0,until:timestamp+900000};if(timestamp>entry.until){entry.count=0;entry.until=timestamp+900000;}entry.count++;attempts.set(key,entry);if(entry.count>20)return res.status(429).json({error:'試行回数が多すぎます'});next();}
const authenticate=wrap(async(req,res,next)=>{
  if(!req.session.userId)return res.status(401).json({error:'ログインが必要です'});
  const snap=await users.doc(req.session.userId).get();
  if(!snap.exists||snap.data().bannedAt)return res.status(403).json({error:'アカウントを利用できません'});
  req.user={id:snap.id,...snap.data()};next();
});
const requireAdmin=(req,res,next)=>admins.has(req.user.username)?next():res.status(403).json({error:'管理者権限がありません'});
app.get('/healthz',wrap(async(_req,res)=>{await db.doc('_meta/health').get();res.json({ok:true,service:'cat-hub',database:'firestore'});}));

app.post('/api/auth/signup',authLimit,wrap(async(req,res)=>{
  const username=clean(req.body.username,32).toLowerCase(),displayName=clean(req.body.displayName,64)||username,password=String(req.body.password||'');
  if(!/^[a-z0-9_]{3,32}$/.test(username)||admins.has(username)||password.length<8||password.length>128||req.body.acceptTerms!==true)return res.status(400).json({error:'入力内容または利用規約への同意を確認してください'});
  const passwordHash=await bcrypt.hash(password,12),id=randomUUID(),nameRef=names.doc(username),userRef=users.doc(id);
  try{await db.runTransaction(async tx=>{if((await tx.get(nameRef)).exists)throw Object.assign(new Error('duplicate'),{code:'duplicate'});tx.create(nameRef,{userId:id});tx.create(userRef,{username,displayName,passwordHash,bannedAt:null,termsAcceptedAt:now(),createdAt:now()});});}
  catch(error){if(error.code==='duplicate'||error.code===6)return res.status(409).json({error:'アカウント名は使用済みです'});throw error;}
  req.session.regenerate(error=>{if(error)return res.status(500).json({error:'セッションエラー'});req.session.userId=id;res.status(201).json({user:view(id,{username,displayName})});});
}));
app.post('/api/auth/login',authLimit,wrap(async(req,res)=>{
  const username=clean(req.body.username,32).toLowerCase();
  const nameSnap=await names.doc(username).get();
  const userSnap=nameSnap.exists?await users.doc(nameSnap.data().userId).get():null;
  if(!userSnap?.exists||!(await bcrypt.compare(String(req.body.password||''),userSnap.data().passwordHash)))return res.status(401).json({error:'ログイン情報が違います'});
  if(userSnap.data().bannedAt)return res.status(403).json({error:'アカウントを利用できません'});
  req.session.regenerate(error=>{if(error)return res.status(500).json({error:'セッションエラー'});req.session.userId=userSnap.id;res.json({user:view(userSnap.id,userSnap.data())});});
}));
app.post('/api/auth/logout',(req,res)=>req.session.destroy(()=>{res.clearCookie('cathub.sid');res.json({ok:true});}));
app.get('/api/auth/me',authenticate,(req,res)=>res.set('Cache-Control','no-store').json(view(req.user.id,req.user)));
app.patch('/api/auth/profile',authenticate,wrap(async(req,res)=>{const displayName=clean(req.body.displayName,64);if(!displayName)return res.status(400).json({error:'表示名が必要です'});await users.doc(req.user.id).update({displayName});res.json(view(req.user.id,{...req.user,displayName}));}));
app.patch('/api/auth/username',authenticate,wrap(async(req,res)=>{
  const username=clean(req.body.username,32).toLowerCase();
  if(!/^[a-z0-9_]{3,32}$/.test(username)||admins.has(username))return res.status(400).json({error:'アカウント名が不正です'});
  if(username===req.user.username)return res.json(view(req.user.id,req.user));
  try{await db.runTransaction(async tx=>{const newRef=names.doc(username);if((await tx.get(newRef)).exists)throw Object.assign(new Error('duplicate'),{code:'duplicate'});tx.create(newRef,{userId:req.user.id});tx.update(users.doc(req.user.id),{username});tx.delete(names.doc(req.user.username));});}
  catch(error){if(error.code==='duplicate'||error.code===6)return res.status(409).json({error:'アカウント名は使用済みです'});throw error;}
  res.json(view(req.user.id,{...req.user,username}));
}));
app.patch('/api/auth/password',authenticate,wrap(async(req,res)=>{
  const nextPassword=String(req.body.newPassword||'');
  if(nextPassword.length<8||nextPassword.length>128)return res.status(400).json({error:'パスワードは8〜128文字です'});
  if(!(await bcrypt.compare(String(req.body.currentPassword||''),req.user.passwordHash)))return res.status(403).json({error:'現在のパスワードが違います'});
  await users.doc(req.user.id).update({passwordHash:await bcrypt.hash(nextPassword,12)});res.json({ok:true});
}));
app.get('/api/admin/status',authenticate,requireAdmin,(_req,res)=>res.set('Cache-Control','no-store').json({adminSource:'ADMIN_USERS',authentication:'username/password',services:['Cat Tube','Cloud Cat','Play Cat','Reverse Proxy'],uptimeSeconds:Math.floor(process.uptime())}));

app.get('/api/proxy',authenticate,wrap(async(req,res)=>{const raw=req.query.url;if(typeof raw!=='string'||raw.length>2048)return res.status(400).json({error:'urlパラメータを指定してください'});try{const result=await fetchSafe(raw);res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Type':result.type});res.status(result.status).send(result.body);}catch(error){res.status(error instanceof ProxyError?error.status:502).json({error:error instanceof ProxyError?error.message:'接続に失敗しました'});}}));
const services={cloud:process.env.CLOUD_CAT_URL,tube:process.env.CAT_TUBE_URL};
app.get('/api/services',authenticate,(_req,res)=>res.set('Cache-Control','no-store').json({cloud:{configured:Boolean(services.cloud),url:services.cloud||null},tube:{configured:Boolean(services.tube),url:services.tube||null}}));
app.get('/api/services/:name/health',authenticate,wrap(async(req,res)=>{const base=services[req.params.name];if(!base)return res.status(404).json({error:'サービスが未設定です'});try{const result=await fetchSafe(new URL('/healthz',base).href);res.status(result.status).type('application/json').send(result.type==='application/json'?result.body:JSON.stringify({online:result.status===200}));}catch{res.status(502).json({error:'サービスへ接続できません'});}}));

const defaultGame={id:'shogi-lite',title:'ミニ将棋',description:'5×5の盤面で遊べる二人用の将棋',category:'ボード',url:'/games/shogi-lite.html',created_at:0};
app.get('/api/games',authenticate,wrap(async(req,res)=>{const query=clean(req.query.q,80).toLowerCase(),category=clean(req.query.category,40);const favorites=(await users.doc(req.user.id).collection('game_favorites').get()).docs.map(doc=>doc.id);const stored=(await games.limit(100).get()).docs.map(doc=>({id:doc.id,...doc.data()}));const rows=[defaultGame,...stored.filter(game=>game.id!==defaultGame.id)].filter(game=>(!category||game.category===category)&&(!query||`${game.title} ${game.description}`.toLowerCase().includes(query))).map(game=>({...game,favorite:favorites.includes(game.id)}));res.json(rows);}));
app.post('/api/games/:id/favorite',authenticate,wrap(async(req,res)=>{const id=req.params.id;if(id!==defaultGame.id&&!(await games.doc(id).get()).exists)return res.status(404).json({error:'ゲームがありません'});await users.doc(req.user.id).collection('game_favorites').doc(id).set({createdAt:now()});res.json({ok:true});}));
app.delete('/api/games/:id/favorite',authenticate,wrap(async(req,res)=>{await users.doc(req.user.id).collection('game_favorites').doc(req.params.id).delete();res.json({ok:true});}));

app.use('/ui',express.static(path.join(rootDir,'ui'),{index:false,fallthrough:false,maxAge:prod?'1h':0}));
app.use('/games',authenticate,express.static(path.join(rootDir,'games'),{index:false}));
const pages=new Set(['index.html','cattube.html','cloudcat.html','playcat.html','proxy.html','admin.html','login.html','register.html','terms.html','settings.html']);
app.get('/',(_req,res)=>res.sendFile(path.join(rootDir,'index.html')));
app.get('/:page',(req,res,next)=>pages.has(req.params.page)?res.sendFile(path.join(rootDir,req.params.page)):next());
app.use((_req,res)=>res.status(404).type('text/plain').send('ページが見つかりません'));
app.use((error,_req,res,_next)=>{console.error('[cat-hub]',error);if(!res.headersSent)res.status(503).json({error:'サービスを利用できません'});});

let server;
async function start(){if(!process.env.SESSION_SECRET)throw new Error('SESSION_SECRET が必要です');await db.doc('_meta/health').get();server=app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Cat Hub ready'));return server;}
if(require.main===module)start().catch(error=>{console.error(error.message);process.exit(1);});
function shutdown(){if(server)server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
module.exports={app,start};
