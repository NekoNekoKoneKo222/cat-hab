
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const util = require("util");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const helmet = require("helmet");
const morgan = require("morgan");
const { Server } = require("socket.io");

const execFileAsync = util.promisify(execFile);
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    cb(null, /^image\/(png|jpeg|jpg|gif|webp)$/.test(file.mimetype))
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https:", "wss:", "ws:"],
      frameSrc: ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://unityroom.com"],
      mediaSrc: ["'self'", "https:", "blob:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"]
    }
  },
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(uploadDir));

const sessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || "CHANGE_ME",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
});
app.use(sessionMiddleware);

const auth = (req, res, next) =>
  req.session.userId ? next() : res.status(401).json({ error: "ログインが必要です" });

async function getUser(id) {
  const r = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
  return r.rows[0] || null;
}

async function isAdmin(id) {
  const u = await getUser(id);
  if (!u) return false;
  if (u.is_admin) return true;
  try {
    const raw = await fs.promises.readFile(path.join(__dirname, "admin.txt"), "utf8");
    return raw.split(/\r?\n/).map(x => x.trim().toLowerCase()).filter(Boolean)
      .includes(String(u.username).toLowerCase());
  } catch {
    return false;
  }
}

async function roomOwner(userId, roomId) {
  const r = await pool.query("SELECT 1 FROM rooms WHERE id=$1 AND owner_id=$2", [roomId, userId]);
  return r.rowCount > 0;
}
async function roomMember(userId, roomId) {
  const r = await pool.query("SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2", [roomId, userId]);
  return r.rowCount > 0;
}
async function roomBanned(userId, roomId) {
  const r = await pool.query("SELECT 1 FROM room_bans WHERE room_id=$1 AND user_id=$2", [roomId, userId]);
  return r.rowCount > 0;
}
async function adminOnly(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "ログインが必要です" });
  if (!(await isAdmin(req.session.userId))) return res.status(403).json({ error: "Admin権限が必要です" });
  next();
}

async function adminLog(action, adminId, roomId = null, targetUserId = null, messageId = null, detail = "") {
  await pool.query(
    `INSERT INTO admin_logs(admin_id,action,room_id,target_user_id,message_id,detail)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [adminId, action, roomId, targetUserId, messageId, detail]
  );
  fs.appendFileSync(
    path.join(__dirname, "adminlog.txt"),
    JSON.stringify({ time:new Date().toISOString(), action, adminId, roomId, targetUserId, messageId, detail }) + "\n"
  );
}

async function chatLog(roomId, senderId, messageId, content, imageUrl = null, action = "MESSAGE") {
  let room = await pool.query("SELECT name FROM rooms WHERE id=$1", [roomId]);
  let user = await pool.query("SELECT username FROM users WHERE id=$1", [senderId]);
  fs.appendFileSync(
    path.join(__dirname, "chatlog.txt"),
    JSON.stringify({
      time:new Date().toISOString(), roomId, roomName:room.rows[0]?.name || "",
      userId:senderId, username:user.rows[0]?.username || "",
      messageId, content:content || "", imageUrl, action
    }) + "\n"
  );
}

async function db() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id SERIAL PRIMARY KEY,
      username VARCHAR(32) UNIQUE NOT NULL,
      display_name VARCHAR(64) NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_url TEXT,
      bio TEXT DEFAULT '',
      is_admin BOOLEAN DEFAULT FALSE,
      is_banned BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_online TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS friendships(
      id SERIAL PRIMARY KEY,
      requester_id INT REFERENCES users(id) ON DELETE CASCADE,
      addressee_id INT REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(requester_id,addressee_id)
    );

    CREATE TABLE IF NOT EXISTS dm_rooms(
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS dm_members(
      room_id INT REFERENCES dm_rooms(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(room_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS messages(
      id SERIAL PRIMARY KEY,
      room_id INT REFERENCES dm_rooms(id) ON DELETE CASCADE,
      sender_id INT REFERENCES users(id) ON DELETE CASCADE,
      content TEXT DEFAULT '',
      image_url TEXT,
      deleted BOOLEAN DEFAULT FALSE,
      reply_to_id INT REFERENCES messages(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reactions(
      id SERIAL PRIMARY KEY,
      message_id INT REFERENCES messages(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      image_url TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(message_id,user_id,image_url)
    );
    CREATE TABLE IF NOT EXISTS notifications(
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(40) DEFAULT 'info',
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rooms(
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      owner_id INT REFERENCES users(id) ON DELETE SET NULL,
      is_private BOOLEAN DEFAULT FALSE,
      require_join_code BOOLEAN DEFAULT FALSE,
      join_code TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS room_members(
      room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(room_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS room_bans(
      id SERIAL PRIMARY KEY,
      room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      banned_by INT REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(room_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS admin_logs(
      id SERIAL PRIMARY KEY,
      admin_id INT REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(50) NOT NULL,
      room_id INT REFERENCES rooms(id) ON DELETE SET NULL,
      target_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      message_id INT,
      detail TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reports(
      id SERIAL PRIMARY KEY,
      reporter_id INT REFERENCES users(id) ON DELETE SET NULL,
      target_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      room_id INT REFERENCES rooms(id) ON DELETE SET NULL,
      message_id INT,
      reason TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'open',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS games(
      id SERIAL PRIMARY KEY,
      title VARCHAR(100) NOT NULL,
      description TEXT DEFAULT '',
      game_type VARCHAR(30) NOT NULL,
      game_url TEXT NOT NULL,
      thumbnail_url TEXT,
      category VARCHAR(50),
      creator_id INT REFERENCES users(id) ON DELETE SET NULL,
      is_public BOOLEAN DEFAULT TRUE,
      play_count INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS game_favorites(
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      game_id INT REFERENCES games(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id,game_id)
    );
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INT REFERENCES messages(id) ON DELETE SET NULL;
  `);

  const game = await pool.query("SELECT 1 FROM games WHERE game_url=$1 LIMIT 1", [
    "https://unityroom.com/games/shougi-like"
  ]);
  if (!game.rowCount) {
    await pool.query(
      `INSERT INTO games(title,description,game_type,game_url,category)
       VALUES($1,$2,$3,$4,$5)`,
      ["将棋ライク", "将棋×ローグライクのブラウザゲーム", "unityroom",
       "https://unityroom.com/games/shougi-like", "ボードゲーム"]
    );
  }
}

/* Health */
app.get("/healthz", (req,res) => res.json({ ok:true, service:"cat-hub" }));

/* Auth */
app.post("/api/auth/signup", async (req,res)=>{
  try{
    const username=String(req.body.username||"").trim().toLowerCase();
    const displayName=String(req.body.displayName||username).trim();
    const password=String(req.body.password||"");
    const terms=Boolean(req.body.termsAccepted);
    if(!terms) return res.status(400).json({error:"利用規約に同意してください"});
    if(!/^[a-z0-9_]{3,32}$/.test(username)) return res.status(400).json({error:"ユーザー名は英数字と _ の3〜32文字です"});
    if(password.length<8) return res.status(400).json({error:"パスワードは8文字以上です"});
    const hash=await bcrypt.hash(password,12);
    const r=await pool.query(
      `INSERT INTO users(username,display_name,password_hash)
       VALUES($1,$2,$3)
       RETURNING id,username,display_name,avatar_url,bio,is_admin`,
      [username,displayName||username,hash]
    );
    req.session.userId=r.rows[0].id;
    res.json({user:r.rows[0]});
  }catch(e){
    res.status(e.code==="23505"?409:500).json({error:e.code==="23505"?"そのユーザー名は使用済みです":"登録に失敗しました"});
  }
});
app.post("/api/auth/login", async (req,res)=>{
  try{
    const username=String(req.body.username||"").trim().toLowerCase();
    const password=String(req.body.password||"");
    const r=await pool.query("SELECT * FROM users WHERE username=$1",[username]);
    if(!r.rowCount) return res.status(401).json({error:"ログイン情報が違います"});
    const u=r.rows[0];
    if(u.is_banned) return res.status(403).json({error:"このアカウントは停止されています"});
    if(!(await bcrypt.compare(password,u.password_hash))) return res.status(401).json({error:"ログイン情報が違います"});
    req.session.userId=u.id;
    await pool.query("UPDATE users SET last_online=NOW() WHERE id=$1",[u.id]);
    res.json({user:{id:u.id,username:u.username,display_name:u.display_name,avatar_url:u.avatar_url,bio:u.bio,is_admin:await isAdmin(u.id)}});
  }catch(e){res.status(500).json({error:"ログインに失敗しました"});}
});
app.post("/api/auth/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/me",auth,async(req,res)=>{
  const u=await getUser(req.session.userId);
  if(!u) return res.status(404).json({error:"ユーザーがありません"});
  u.is_admin=await isAdmin(u.id);
  delete u.password_hash;
  res.json(u);
});
app.patch("/api/me",auth,async(req,res)=>{
  const name=String(req.body.displayName||"").trim();
  const bio=String(req.body.bio||"").trim();
  await pool.query("UPDATE users SET display_name=$1,bio=$2 WHERE id=$3",[name||"User",bio,req.session.userId]);
  res.json({ok:true});
});
app.post("/api/me/password",auth,async(req,res)=>{
  const p=String(req.body.password||"");
  if(p.length<8)return res.status(400).json({error:"パスワードは8文字以上です"});
  const h=await bcrypt.hash(p,12);
  await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2",[h,req.session.userId]);
  res.json({ok:true});
});
app.post("/api/me/icon",auth,upload.single("image"),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:"画像を選択してください"});
  const url="/uploads/"+req.file.filename;
  await pool.query("UPDATE users SET avatar_url=$1 WHERE id=$2",[url,req.session.userId]);
  res.json({ok:true,avatar_url:url});
});

/* Friends */
app.get("/api/users/search",auth,async(req,res)=>{
  const q="%"+String(req.query.q||"").trim()+"%";
  const r=await pool.query(
    `SELECT id,username,display_name,avatar_url
     FROM users WHERE id<>$1 AND is_banned=FALSE
     AND (username ILIKE $2 OR display_name ILIKE $2)
     ORDER BY display_name LIMIT 20`,
    [req.session.userId,q]
  );
  res.json(r.rows);
});
app.post("/api/friends/request",auth,async(req,res)=>{
  const target=Number(req.body.userId);
  if(!target||target===req.session.userId)return res.status(400).json({error:"ユーザーが不正です"});
  try{
    await pool.query("INSERT INTO friendships(requester_id,addressee_id) VALUES($1,$2)",[req.session.userId,target]);
    await pool.query("INSERT INTO notifications(user_id,type,title,content) VALUES($1,'friend_request','フレンド申請','フレンド申請が届きました')",[target]);
    io.to("u:"+target).emit("notification");
    res.json({ok:true});
  }catch(e){res.status(409).json({error:"申請がすでに存在します"});}
});
app.get("/api/friends",auth,async(req,res)=>{
  const r=await pool.query(
    `SELECT f.id,f.status,f.requester_id,u.id user_id,u.username,u.display_name,u.avatar_url
     FROM friendships f JOIN users u ON u.id=CASE WHEN f.requester_id=$1 THEN f.addressee_id ELSE f.requester_id END
     WHERE f.requester_id=$1 OR f.addressee_id=$1 ORDER BY u.display_name`,
    [req.session.userId]
  );
  res.json(r.rows);
});
app.post("/api/friends/accept",auth,async(req,res)=>{
  const r=await pool.query(
    "UPDATE friendships SET status='accepted' WHERE id=$1 AND addressee_id=$2 AND status='pending' RETURNING requester_id",
    [Number(req.body.friendshipId),req.session.userId]
  );
  if(!r.rowCount)return res.status(404).json({error:"申請がありません"});
  await pool.query("INSERT INTO notifications(user_id,type,title,content) VALUES($1,'friend_accept','フレンド承認','フレンド申請が承認されました')",[r.rows[0].requester_id]);
  io.to("u:"+r.rows[0].requester_id).emit("notification");
  res.json({ok:true});
});

/* DM */
app.post("/api/dm/open",auth,async(req,res)=>{
  const other=Number(req.body.userId);
  const r=await pool.query(
    `SELECT r.id FROM dm_rooms r
     JOIN dm_members a ON a.room_id=r.id JOIN dm_members b ON b.room_id=r.id
     WHERE a.user_id=$1 AND b.user_id=$2
       AND (SELECT COUNT(*) FROM dm_members m WHERE m.room_id=r.id)=2 LIMIT 1`,
    [req.session.userId,other]
  );
  if(r.rowCount)return res.json({roomId:r.rows[0].id});
  const room=await pool.query("INSERT INTO dm_rooms DEFAULT VALUES RETURNING id");
  await pool.query("INSERT INTO dm_members(room_id,user_id) VALUES($1,$2),($1,$3)",[room.rows[0].id,req.session.userId,other]);
  res.json({roomId:room.rows[0].id});
});
app.get("/api/dm/rooms",auth,async(req,res)=>{
  const r=await pool.query(
    `SELECT r.id room_id,u.id user_id,u.username,u.display_name,u.avatar_url,
      (SELECT content FROM messages WHERE room_id=r.id ORDER BY created_at DESC LIMIT 1) last_message
     FROM dm_rooms r
     JOIN dm_members me ON me.room_id=r.id AND me.user_id=$1
     JOIN dm_members other ON other.room_id=r.id AND other.user_id<>$1
     JOIN users u ON u.id=other.user_id ORDER BY r.id DESC`,
    [req.session.userId]
  );
  res.json(r.rows);
});
app.get("/api/dm/:id",auth,async(req,res)=>{
  const id=Number(req.params.id);
  if(!(await pool.query("SELECT 1 FROM dm_members WHERE room_id=$1 AND user_id=$2",[id,req.session.userId])).rowCount)
    return res.status(403).json({error:"アクセスできません"});
  const r=await pool.query(
    `SELECT m.*,u.display_name,u.username FROM messages m JOIN users u ON u.id=m.sender_id
     WHERE m.room_id=$1 ORDER BY m.created_at`,[id]
  );
  res.json(r.rows);
});
app.post("/api/dm/:id",auth,upload.single("image"),async(req,res)=>{
  const id=Number(req.params.id),txt=String(req.body.content||"");
  const reply=req.body.replyToId?Number(req.body.replyToId):null;
  const img=req.file?"/uploads/"+req.file.filename:null;
  if(!(await pool.query("SELECT 1 FROM dm_members WHERE room_id=$1 AND user_id=$2",[id,req.session.userId])).rowCount)
    return res.status(403).json({error:"アクセスできません"});
  if(!txt.trim()&&!img)return res.status(400).json({error:"空のメッセージです"});
  const r=await pool.query(
    `INSERT INTO messages(room_id,sender_id,content,image_url,reply_to_id)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [id,req.session.userId,txt,img,reply]
  );
  io.to("r:"+id).emit("message",r.rows[0]);
  res.json(r.rows[0]);
});

/* Rooms */
app.post("/api/rooms",auth,async(req,res)=>{
  const name=String(req.body.name||"").trim();
  const privateRoom=Boolean(req.body.isPrivate);
  const required=Boolean(req.body.requireJoinCode);
  const code=required?String(req.body.joinCode||"").trim():null;
  if(!name)return res.status(400).json({error:"ルーム名を入力してください"});
  if(required&&(code.length<4||code.length>32))return res.status(400).json({error:"参加コードは4〜32文字"});
  const r=await pool.query(
    `INSERT INTO rooms(name,owner_id,is_private,require_join_code,join_code)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [name,req.session.userId,privateRoom,required,code]
  );
  await pool.query("INSERT INTO room_members(room_id,user_id) VALUES($1,$2)",[r.rows[0].id,req.session.userId]);
  res.json(r.rows[0]);
});
app.get("/api/rooms/public",auth,async(req,res)=>{
  const r=await pool.query(
    `SELECT r.id,r.name,r.owner_id,u.username owner_username,u.display_name owner_display_name,
            COUNT(m.user_id)::int member_count
     FROM rooms r JOIN users u ON u.id=r.owner_id
     LEFT JOIN room_members m ON m.room_id=r.id
     WHERE r.is_private=FALSE GROUP BY r.id,u.username,u.display_name ORDER BY r.id DESC`
  );
  res.json(r.rows);
});
app.get("/api/rooms/mine",auth,async(req,res)=>{
  const admin=await isAdmin(req.session.userId);
  const r= admin ? await pool.query(
    `SELECT r.id,r.name,r.owner_id,r.is_private,r.require_join_code,COUNT(m.user_id)::int member_count
     FROM rooms r LEFT JOIN room_members m ON m.room_id=r.id
     GROUP BY r.id ORDER BY r.id DESC`
  ) : await pool.query(
    `SELECT r.id,r.name,r.owner_id,r.is_private,r.require_join_code,COUNT(m.user_id)::int member_count
     FROM rooms r JOIN room_members me ON me.room_id=r.id AND me.user_id=$1
     LEFT JOIN room_members m ON m.room_id=r.id GROUP BY r.id ORDER BY r.id DESC`,
    [req.session.userId]
  );
  res.json(r.rows);
});
app.post("/api/rooms/join",auth,async(req,res)=>{
  const id=Number(req.body.roomId),code=String(req.body.joinCode||"");
  const r=await pool.query("SELECT * FROM rooms WHERE id=$1",[id]);
  if(!r.rowCount)return res.status(404).json({error:"ルームがありません"});
  const room=r.rows[0],admin=await isAdmin(req.session.userId);
  if(admin||room.owner_id===req.session.userId){
    await pool.query("INSERT INTO room_members(room_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[id,req.session.userId]);
    return res.json({ok:true,roomId:id});
  }
  if(await roomBanned(req.session.userId,id))return res.status(403).json({error:"このルームからBANされています"});
  if(room.is_private&&!code)return res.status(403).json({error:"参加コードが必要です"});
  if(room.require_join_code&&code!==room.join_code)return res.status(403).json({error:"参加コードが違います"});
  await pool.query("INSERT INTO room_members(room_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[id,req.session.userId]);
  res.json({ok:true,roomId:id});
});

app.get("/api/rooms/:id", auth, async (req, res) => {
  const roomId = Number(req.params.id);
  const result = await pool.query(
    `SELECT r.*, u.username AS owner_username, u.display_name AS owner_display_name
     FROM rooms r
     LEFT JOIN users u ON u.id = r.owner_id
     WHERE r.id = $1`,
    [roomId]
  );
  if (!result.rowCount) return res.status(404).json({ error: "ルームがありません" });
  const room = result.rows[0];
  room.is_member = await roomMember(req.session.userId, roomId);
  room.is_owner = room.owner_id === req.session.userId;
  room.is_admin = await isAdmin(req.session.userId);
  delete room.join_code;
  res.json(room);
});

app.get("/api/rooms/:id/members", auth, async (req, res) => {
  const roomId = Number(req.params.id);
  const admin = await isAdmin(req.session.userId);
  if (!admin && !(await roomMember(req.session.userId, roomId))) {
    return res.status(403).json({ error: "ルームに参加していません" });
  }
  const result = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, rm.joined_at,
            (r.owner_id = u.id) AS is_owner
     FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     JOIN rooms r ON r.id = rm.room_id
     WHERE rm.room_id = $1
     ORDER BY is_owner DESC, u.display_name ASC`,
    [roomId]
  );
  for (const user of result.rows) user.is_admin = await isAdmin(user.id);
  res.json(result.rows);
});

app.delete("/api/rooms/:id", auth, async (req, res) => {
  const roomId = Number(req.params.id);
  const owner = await roomOwner(req.session.userId, roomId);
  const admin = await isAdmin(req.session.userId);
  if (!owner && !admin) return res.status(403).json({ error: "ルーム削除権限がありません" });

  await adminLog(
    "DELETE_ROOM",
    req.session.userId,
    roomId,
    null,
    null,
    admin && !owner ? "Adminによるルーム削除" : "ルーム管理者によるルーム削除"
  );

  await pool.query("DELETE FROM rooms WHERE id = $1", [roomId]);
  io.to(`r:${roomId}`).emit("roomDeleted", { roomId });
  res.json({ ok: true });
});

app.get("/api/rooms/:id/messages",auth,async(req,res)=>{
  const id=Number(req.params.id);
  if(!(await isAdmin(req.session.userId))&&!(await roomMember(req.session.userId,id)))
    return res.status(403).json({error:"ルームに参加していません"});
  const r=await pool.query(
    `SELECT m.*,u.username,u.display_name,u.avatar_url FROM messages m JOIN users u ON u.id=m.sender_id
     WHERE m.room_id=$1 ORDER BY m.created_at LIMIT 500`,[id]
  );
  res.json(r.rows);
});
app.post("/api/rooms/:id/messages",auth,upload.single("image"),async(req,res)=>{
  const id=Number(req.params.id),txt=String(req.body.content||"");
  const reply=req.body.replyToId?Number(req.body.replyToId):null;
  const img=req.file?"/uploads/"+req.file.filename:null;
  const admin=await isAdmin(req.session.userId);
  if(!admin&&!(await roomMember(req.session.userId,id)))return res.status(403).json({error:"ルームに参加していません"});
  if(!admin&&await roomBanned(req.session.userId,id))return res.status(403).json({error:"このルームからBANされています"});
  if(!txt.trim()&&!img)return res.status(400).json({error:"空のメッセージです"});
  const r=await pool.query(
    `INSERT INTO messages(room_id,sender_id,content,image_url,reply_to_id)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [id,req.session.userId,txt,img,reply]
  );
  await chatLog(id,req.session.userId,r.rows[0].id,txt,img);
  io.to("r:"+id).emit("message",r.rows[0]);
  res.json(r.rows[0]);
});
app.post("/api/rooms/:id/kick",auth,async(req,res)=>{
  const id=Number(req.params.id),target=Number(req.body.userId),reason=String(req.body.reason||"");
  if(!(await roomOwner(req.session.userId,id))&&!(await isAdmin(req.session.userId)))return res.status(403).json({error:"権限がありません"});
  if(await isAdmin(target))return res.status(403).json({error:"Adminはルーム管理者からKickできません"});
  await pool.query("DELETE FROM room_members WHERE room_id=$1 AND user_id=$2",[id,target]);
  await adminLog("KICK",req.session.userId,id,target,null,reason);
  io.to("u:"+target).emit("roomKicked",{roomId:id});
  res.json({ok:true});
});
app.post("/api/rooms/:id/ban",auth,async(req,res)=>{
  const id=Number(req.params.id),target=Number(req.body.userId),reason=String(req.body.reason||"");
  if(!(await roomOwner(req.session.userId,id))&&!(await isAdmin(req.session.userId)))return res.status(403).json({error:"権限がありません"});
  if(target===req.session.userId)return res.status(400).json({error:"自分自身をBANできません"});
  if(await isAdmin(target))return res.status(403).json({error:"AdminはBANできません"});
  await pool.query(
    `INSERT INTO room_bans(room_id,user_id,banned_by,reason) VALUES($1,$2,$3,$4)
     ON CONFLICT(room_id,user_id) DO UPDATE SET banned_by=EXCLUDED.banned_by,reason=EXCLUDED.reason`,
    [id,target,req.session.userId,reason]
  );
  await pool.query("DELETE FROM room_members WHERE room_id=$1 AND user_id=$2",[id,target]);
  await adminLog("BAN",req.session.userId,id,target,null,reason);
  io.to("u:"+target).emit("roomBanned",{roomId:id});
  res.json({ok:true});
});
app.get("/api/rooms/:id/bans",auth,async(req,res)=>{
  const id=Number(req.params.id);
  if(!(await isAdmin(req.session.userId))&&!(await roomOwner(req.session.userId,id)))return res.status(403).json({error:"権限がありません"});
  const r=await pool.query(
    `SELECT b.*,u.username,u.display_name,a.username banned_by_username
     FROM room_bans b JOIN users u ON u.id=b.user_id
     LEFT JOIN users a ON a.id=b.banned_by WHERE b.room_id=$1 ORDER BY b.created_at DESC`,[id]
  );
  res.json(r.rows);
});
app.delete("/api/rooms/:id/bans/:userId",auth,async(req,res)=>{
  const id=Number(req.params.id),target=Number(req.params.userId);
  if(!(await isAdmin(req.session.userId))&&!(await roomOwner(req.session.userId,id)))return res.status(403).json({error:"権限がありません"});
  await pool.query("DELETE FROM room_bans WHERE room_id=$1 AND user_id=$2",[id,target]);
  await adminLog("UNBAN",req.session.userId,id,target,null,"BAN解除");
  res.json({ok:true});
});
app.delete("/api/messages/:messageId",auth,async(req,res)=>{
  const messageId=Number(req.params.messageId);
  const r=await pool.query("SELECT * FROM messages WHERE id=$1",[messageId]);
  if(!r.rowCount)return res.status(404).json({error:"メッセージがありません"});
  const m=r.rows[0];
  const admin=await isAdmin(req.session.userId);
  const owner=await roomOwner(req.session.userId,m.room_id);
  if(m.sender_id!==req.session.userId&&!admin&&!owner)return res.status(403).json({error:"削除権限がありません"});
  await pool.query("UPDATE messages SET deleted=TRUE,content='',image_url=NULL WHERE id=$1",[messageId]);
  await adminLog("DELETE_MESSAGE",req.session.userId,m.room_id,m.sender_id,messageId,"メッセージ削除");
  await chatLog(m.room_id,req.session.userId,messageId,"",null,"DELETE_MESSAGE");
  io.to("r:"+m.room_id).emit("messageDeleted",{messageId});
  res.json({ok:true});
});

/* Reactions */
app.post("/api/messages/:messageId/reaction",auth,async(req,res)=>{
  const messageId=Number(req.params.messageId),imageUrl=String(req.body.imageUrl||"").trim();
  if(!imageUrl)return res.status(400).json({error:"リアクション画像がありません"});
  const r=await pool.query("SELECT room_id FROM messages WHERE id=$1",[messageId]);
  if(!r.rowCount)return res.status(404).json({error:"メッセージがありません"});
  if(!(await roomMember(req.session.userId,r.rows[0].room_id))&&!await isAdmin(req.session.userId))
    return res.status(403).json({error:"アクセスできません"});
  const x=await pool.query(
    `INSERT INTO reactions(message_id,user_id,image_url) VALUES($1,$2,$3)
     ON CONFLICT DO NOTHING RETURNING *`,[messageId,req.session.userId,imageUrl]
  );
  if(x.rowCount)io.to("r:"+r.rows[0].room_id).emit("reaction",x.rows[0]);
  res.json({ok:true});
});

/* Admin */
app.get("/api/admin/logs",adminOnly,async(req,res)=>{
  const r=await pool.query(
    `SELECT l.*,a.username admin_username,t.username target_username,r.name room_name
     FROM admin_logs l LEFT JOIN users a ON a.id=l.admin_id
     LEFT JOIN users t ON t.id=l.target_user_id LEFT JOIN rooms r ON r.id=l.room_id
     ORDER BY l.created_at DESC LIMIT 500`);
  res.json(r.rows);
});
app.get("/api/admin/users",adminOnly,async(req,res)=>{
  const r=await pool.query("SELECT id,username,display_name,is_admin,is_banned,created_at,last_online FROM users ORDER BY id DESC LIMIT 500");
  for(const u of r.rows)u.is_admin=await isAdmin(u.id);
  res.json(r.rows);
});
app.post("/api/admin/users/:id/ban",adminOnly,async(req,res)=>{
  const id=Number(req.params.id),reason=String(req.body.reason||"");
  if(await isAdmin(id))return res.status(403).json({error:"Adminは通常のアカウントBAN対象外です"});
  await pool.query("UPDATE users SET is_banned=TRUE WHERE id=$1",[id]);
  await adminLog("ACCOUNT_BAN",req.session.userId,null,id,null,reason);
  io.to("u:"+id).emit("accountBanned");
  res.json({ok:true});
});
app.delete("/api/admin/users/:id/ban",adminOnly,async(req,res)=>{
  const id=Number(req.params.id);
  if(await isAdmin(id))return res.status(403).json({error:"Adminの状態はこの操作で変更できません"});
  await pool.query("UPDATE users SET is_banned=FALSE WHERE id=$1",[id]);
  await adminLog("ACCOUNT_UNBAN",req.session.userId,null,id,null,"アカウントBAN解除");
  res.json({ok:true});
});
app.get("/api/admin/rooms",adminOnly,async(req,res)=>{
  const r=await pool.query(
    `SELECT r.*,u.username owner_username,COUNT(m.user_id)::int member_count
     FROM rooms r LEFT JOIN users u ON u.id=r.owner_id LEFT JOIN room_members m ON m.room_id=r.id
     GROUP BY r.id,u.username ORDER BY r.id DESC`);
  res.json(r.rows);
});
app.post("/api/admin/join-room",adminOnly,async(req,res)=>{
  const id=Number(req.body.roomId);
  await pool.query("INSERT INTO room_members(room_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[id,req.session.userId]);
  await adminLog("ADMIN_JOIN_ROOM",req.session.userId,id,null,null,"管理目的の参加");
  res.json({ok:true,roomId:id});
});
app.delete("/api/admin/rooms/:id",adminOnly,async(req,res)=>{
  const id=Number(req.params.id);
  await adminLog("DELETE_ROOM",req.session.userId,id,null,null,"Adminによるルーム削除");
  await pool.query("DELETE FROM rooms WHERE id=$1",[id]);
  io.to("r:"+id).emit("roomDeleted",{roomId:id});
  res.json({ok:true});
});

/* Play Cat */
app.get("/api/games",auth,async(req,res)=>{
  const r=await pool.query(
    `SELECT g.*,u.username creator_username
     FROM games g LEFT JOIN users u ON u.id=g.creator_id
     WHERE g.is_public=TRUE ORDER BY g.created_at DESC`);
  res.json(r.rows);
});
app.post("/api/games",auth,async(req,res)=>{
  const {title,description,gameType,gameUrl,thumbnailUrl,category}=req.body;
  if(!title||!gameType||!gameUrl)return res.status(400).json({error:"タイトル・種類・URLが必要です"});
  const r=await pool.query(
    `INSERT INTO games(title,description,game_type,game_url,thumbnail_url,category,creator_id)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [title,description||"",gameType,gameUrl,thumbnailUrl||null,category||"",req.session.userId]
  );
  res.json(r.rows[0]);
});
app.post("/api/games/:id/play",auth,async(req,res)=>{
  const id=Number(req.params.id);
  await pool.query("UPDATE games SET play_count=play_count+1 WHERE id=$1",[id]);
  res.json({ok:true});
});
app.post("/api/games/:id/favorite",auth,async(req,res)=>{
  const id=Number(req.params.id);
  await pool.query("INSERT INTO game_favorites(user_id,game_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[req.session.userId,id]);
  res.json({ok:true});
});

/* Cat Tube: YouTube Data API */
app.get("/api/youtube/search",async(req,res)=>{
  const key=process.env.YOUTUBE_API_KEY;
  if(!key)return res.status(503).json({error:"YOUTUBE_API_KEY が設定されていません"});
  const q=String(req.query.q||"").trim();
  if(!q)return res.status(400).json({error:"検索語を入力してください"});
  const max=Math.min(Math.max(Number(req.query.maxResults)||12,1),50);
  try{
    const url=new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part","snippet");
    url.searchParams.set("type","video");
    url.searchParams.set("q",q);
    url.searchParams.set("maxResults",String(max));
    url.searchParams.set("key",key);
    const r=await fetch(url);
    const data=await r.json();
    if(!r.ok)return res.status(r.status).json({error:data.error?.message||"YouTube APIエラー"});
    res.json(data.items||[]);
  }catch(e){res.status(500).json({error:"YouTube検索に失敗しました"});}
});
app.get("/api/youtube/video/:id",async(req,res)=>{
  const key=process.env.YOUTUBE_API_KEY;
  if(!key)return res.status(503).json({error:"YOUTUBE_API_KEY が設定されていません"});
  try{
    const url=new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part","snippet,statistics,contentDetails");
    url.searchParams.set("id",req.params.id);
    url.searchParams.set("key",key);
    const r=await fetch(url),data=await r.json();
    if(!r.ok)return res.status(r.status).json({error:data.error?.message||"YouTube APIエラー"});
    res.json(data.items?.[0]||null);
  }catch(e){res.status(500).json({error:"動画取得に失敗しました"});}
});
app.get("/api/youtube/stream", async (req, res) => {
  const source = String(req.query.url || "").trim();

  if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(source)) {
    return res.status(400).json({
      error: "YouTube URLを指定してください"
    });
  }

  try {
    // Prefer a browser-playable single-file MP4/WebM stream.
    // This avoids returning separate video/audio URLs that a normal <video> element cannot combine.
    const formats = [
      ["best[ext=mp4]/best", "combined"],
      ["18", "fallback"]
    ];

    let lastError = null;

    for (const [format, mode] of formats) {
      try {
        const args = [
          "--no-playlist",
          "--no-warnings",
          "--no-progress",
          "-f", format,
          "--get-url",
          source
        ];

        const { stdout } = await execFileAsync(
          "yt-dlp",
          args,
          {
            timeout: 30000,
            maxBuffer: 1024 * 1024 * 8,
            windowsHide: true
          }
        );

        const streamUrl = stdout
          .trim()
          .split(/\r?\n/)
          .map(v => v.trim())
          .filter(Boolean)
          .pop();

        if (streamUrl) {
          return res.json({
            url: streamUrl,
            mode,
            note: "取得したストリームURLは一時的な場合があります。"
          });
        }
      } catch (error) {
        lastError = error;
      }
    }

    console.error("yt-dlp stream error:", lastError?.stderr || lastError?.message || lastError);

    return res.status(502).json({
      error: "yt-dlpでブラウザ再生可能なストリームを取得できませんでした"
    });
  } catch (error) {
    console.error("yt-dlp route error:", error);
    return res.status(500).json({
      error: "ストリーム取得処理でエラーが発生しました"
    });
  }
});

/* SPA/static */
app.use(express.static(path.join(__dirname,"public")));

/* Socket.IO */
io.engine.use(sessionMiddleware);
io.use((socket,next)=>{
  if(!socket.request.session.userId)return next(new Error("unauthorized"));
  next();
});
io.on("connection",socket=>{
  const uid=socket.request.session.userId;
  socket.join("u:"+uid);
  socket.on("joinRoom",async id=>{
    const roomId=Number(id);
    if(await isAdmin(uid)||await roomMember(uid,roomId))socket.join("r:"+roomId);
  });
  socket.on("leaveRoom",id=>socket.leave("r:"+Number(id)));
});

/* Start */
async function start(){
  try{
    await db();
    server.listen(PORT,()=>console.log(`Cat Hub running on port ${PORT}`));
  }catch(e){
    console.error("Database initialization error:",e);
    process.exit(1);
  }
}
start();
