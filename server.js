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
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

const uploadDir = path.join(__dirname, "uploads");

fs.mkdirSync(uploadDir, {
  recursive: true
});

const upload = multer({
  dest: uploadDir,

  limits: {
    fileSize: 5 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {
    const ok = /^image\/(png|jpeg|jpg|gif|webp)$/.test(
      file.mimetype
    );

    cb(null, ok);
  }
});

/* ================================
   Middleware
================================ */

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],

        scriptSrc: [
          "'self'",
          "'unsafe-inline'"
        ],

        styleSrc: [
          "'self'",
          "'unsafe-inline'"
        ],

        imgSrc: [
          "'self'",
          "data:",
          "https:"
        ],

        connectSrc: [
          "'self'",
          "https://www.googleapis.com",
          "https://*.youtube.com",
          "wss:",
          "ws:"
        ],

        frameSrc: [
          "'self'",
          "https://www.youtube.com",
          "https://www.youtube-nocookie.com"
        ],

        mediaSrc: [
          "'self'",
          "https:",
          "blob:"
        ]
      }
    },

    crossOriginResourcePolicy: {
      policy: "cross-origin"
    }
  })
);

app.use(morgan("combined"));

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  "/uploads",
  express.static(uploadDir)
);

/* ================================
   Session
================================ */

const sessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),

  secret:
    process.env.SESSION_SECRET ||
    "CHANGE_ME",

  resave: false,

  saveUninitialized: false,

  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure:
      process.env.NODE_ENV === "production",

    maxAge:
      1000 *
      60 *
      60 *
      24 *
      30
  }
});

app.use(sessionMiddleware);

/* ================================
   Auth helpers
================================ */

const auth = (req, res, next) => {
  if (req.session.userId) {
    return next();
  }

  return res.status(401).json({
    error: "ログインが必要です"
  });
};

async function getUser(id) {
  const result = await pool.query(
    "SELECT * FROM users WHERE id = $1",
    [id]
  );

  return result.rows[0] || null;
}

async function isAdmin(id) {
  const user = await getUser(id);

  if (!user) {
    return false;
  }

  if (user.is_admin === true) {
    return true;
  }

  try {
    const raw =
      await fs.promises.readFile(
        path.join(__dirname, "admin.txt"),
        "utf8"
      );

    const admins = raw
      .split(/\r?\n/)
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);

    return admins.includes(
      String(user.username).toLowerCase()
    );
  } catch {
    return false;
  }
}

async function adminOnly(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "ログインが必要です"
    });
  }

  if (!(await isAdmin(req.session.userId))) {
    return res.status(403).json({
      error: "Admin権限が必要です"
    });
  }

  next();
}

/* ================================
   Room helpers
================================ */

async function roomOwner(userId, roomId) {
  const result = await pool.query(
    `
    SELECT 1
    FROM rooms
    WHERE id = $1
      AND owner_id = $2
    `,
    [roomId, userId]
  );

  return result.rowCount > 0;
}

async function roomMember(userId, roomId) {
  const result = await pool.query(
    `
    SELECT 1
    FROM room_members
    WHERE room_id = $1
      AND user_id = $2
    `,
    [roomId, userId]
  );

  return result.rowCount > 0;
}

async function roomBanned(userId, roomId) {
  const result = await pool.query(
    `
    SELECT 1
    FROM room_bans
    WHERE room_id = $1
      AND user_id = $2
    `,
    [roomId, userId]
  );

  return result.rowCount > 0;
}

async function roomExists(roomId) {
  const result = await pool.query(
    "SELECT 1 FROM rooms WHERE id = $1",
    [roomId]
  );

  return result.rowCount > 0;
}

/* ================================
   Logs
================================ */

function appendLog(fileName, data) {
  try {
    fs.appendFileSync(
      path.join(__dirname, fileName),
      data + "\n",
      "utf8"
    );
  } catch (error) {
    console.error(
      `ログ保存失敗: ${fileName}`,
      error.message
    );
  }
}

async function adminLog(
  action,
  adminId,
  roomId = null,
  targetUserId = null,
  messageId = null,
  detail = ""
) {
  await pool.query(
    `
    INSERT INTO admin_logs(
      admin_id,
      action,
      room_id,
      target_user_id,
      message_id,
      detail
    )
    VALUES($1,$2,$3,$4,$5,$6)
    `,
    [
      adminId,
      action,
      roomId,
      targetUserId,
      messageId,
      detail
    ]
  );

  appendLog(
    "adminlog.txt",
    JSON.stringify({
      time: new Date().toISOString(),
      action,
      adminId,
      roomId,
      targetUserId,
      messageId,
      detail
    })
  );
}

async function chatLog(
  roomId,
  senderId,
  messageId,
  content,
  imageUrl = null,
  action = "MESSAGE"
) {
  const room = await pool.query(
    "SELECT name FROM rooms WHERE id = $1",
    [roomId]
  );

  const user = await pool.query(
    "SELECT username FROM users WHERE id = $1",
    [senderId]
  );

  appendLog(
    "chatlog.txt",
    JSON.stringify({
      time: new Date().toISOString(),
      roomId,
      roomName: room.rows[0]?.name || "",
      userId: senderId,
      username: user.rows[0]?.username || "",
      messageId,
      content: content || "",
      imageUrl,
      action
    })
  );
}

/* ================================
   Database initialization
================================ */

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
      UNIQUE(requester_id, addressee_id)
    );

    CREATE TABLE IF NOT EXISTS dm_rooms(
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS dm_members(
      room_id INT REFERENCES dm_rooms(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(room_id, user_id)
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
      UNIQUE(message_id, user_id, image_url)
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
      PRIMARY KEY(room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS room_bans(
      id SERIAL PRIMARY KEY,
      room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      banned_by INT REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(room_id, user_id)
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

    CREATE TABLE IF NOT EXISTS groups(
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      owner_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS group_members(
      group_id INT REFERENCES groups(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(20) DEFAULT 'member',
      PRIMARY KEY(group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS communities(
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT DEFAULT '',
      owner_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS channels(
      id SERIAL PRIMARY KEY,
      community_id INT REFERENCES communities(id) ON DELETE CASCADE,
      name VARCHAR(50) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS channel_messages(
      id SERIAL PRIMARY KEY,
      channel_id INT REFERENCES channels(id) ON DELETE CASCADE,
      sender_id INT REFERENCES users(id) ON DELETE CASCADE,
      content TEXT DEFAULT '',
      image_url TEXT,
      deleted BOOLEAN DEFAULT FALSE,
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
      UNIQUE(user_id, game_id)
    );
  `);

  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS avatar_url TEXT;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '';

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE;

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE;

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS reply_to_id INT
        REFERENCES messages(id)
        ON DELETE SET NULL;
  `);

  const game = await pool.query(
    `
    SELECT 1
    FROM games
    WHERE game_url = $1
    LIMIT 1
    `,
    [
      "https://unityroom.com/games/shougi-like"
    ]
  );

  if (!game.rowCount) {
    await pool.query(
      `
      INSERT INTO games(
        title,
        description,
        game_type,
        game_url,
        category
      )
      VALUES($1,$2,$3,$4,$5)
      `,
      [
        "将棋ライク",
        "将棋×ローグライクのブラウザゲーム",
        "unityroom",
        "https://unityroom.com/games/shougi-like",
        "ボードゲーム"
      ]
    );
  }

  console.log(
    "PostgreSQLのテーブル準備完了"
  );
}

/* ================================
   Health
================================ */

app.get(
  "/healthz",
  (req, res) => {
    res.json({
      ok: true,
      service: "cat-hub"
    });
  }
);

/* ================================
   Auth
================================ */

app.post(
  "/api/auth/signup",
  async (req, res) => {
    try {
      const username = String(
        req.body.username || ""
      )
        .trim()
        .toLowerCase();

      const displayName = String(
        req.body.displayName ||
          username
      ).trim();

      const password = String(
        req.body.password || ""
      );

      const termsAccepted =
        Boolean(req.body.termsAccepted);

      if (!termsAccepted) {
        return res.status(400).json({
          error:
            "利用規約に同意してください"
        });
      }

      if (
        !/^[a-z0-9_]{3,32}$/.test(
          username
        )
      ) {
        return res.status(400).json({
          error:
            "ユーザー名は英数字と _ の3〜32文字です"
        });
      }

      if (password.length < 8) {
        return res.status(400).json({
          error:
            "パスワードは8文字以上です"
        });
      }

      const hash =
        await bcrypt.hash(
          password,
          12
        );

      const result =
        await pool.query(
          `
          INSERT INTO users(
            username,
            display_name,
            password_hash
          )
          VALUES($1,$2,$3)
          RETURNING
            id,
            username,
            display_name,
            avatar_url,
            bio,
            is_admin
          `,
          [
            username,
            displayName || username,
            hash
          ]
        );

      req.session.userId =
        result.rows[0].id;

      res.json({
        user: result.rows[0]
      });

    } catch (error) {
      console.error(error);

      if (
        error.code === "23505"
      ) {
        return res.status(409).json({
          error:
            "そのユーザー名はすでに使用されています"
        });
      }

      res.status(500).json({
        error:
          "登録に失敗しました"
      });
    }
  }
);

app.post(
  "/api/auth/login",
  async (req, res) => {
    try {
      const username = String(
        req.body.username || ""
      )
        .trim()
        .toLowerCase();

      const password = String(
        req.body.password || ""
      );

      const result =
        await pool.query(
          "SELECT * FROM users WHERE username = $1",
          [username]
        );

      if (!result.rowCount) {
        return res.status(401).json({
          error:
            "ログイン情報が違います"
        });
      }

      const user =
        result.rows[0];

      if (user.is_banned) {
        return res.status(403).json({
          error:
            "このアカウントは停止されています"
        });
      }

      const valid =
        await bcrypt.compare(
          password,
          user.password_hash
        );

      if (!valid) {
        return res.status(401).json({
          error:
            "ログイン情報が違います"
        });
      }

      req.session.userId =
        user.id;

      await pool.query(
        `
        UPDATE users
        SET last_online = NOW()
        WHERE id = $1
        `,
        [user.id]
      );

      res.json({
        user: {
          id: user.id,
          username: user.username,
          display_name:
            user.display_name,
          avatar_url:
            user.avatar_url,
          bio: user.bio,
          is_admin:
            await isAdmin(user.id)
        }
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "ログインに失敗しました"
      });
    }
  }
);

app.post(
  "/api/auth/logout",
  (req, res) => {
    req.session.destroy(
      () => {
        res.json({
          ok: true
        });
      }
    );
  }
);

app.get(
  "/api/me",
  auth,
  async (req, res) => {
    const user =
      await getUser(
        req.session.userId
      );

    if (!user) {
      return res.status(404).json({
        error:
          "ユーザーがありません"
      });
    }

    user.is_admin =
      await isAdmin(user.id);

    delete user.password_hash;

    res.json(user);
  }
);

app.patch(
  "/api/me",
  auth,
  async (req, res) => {
    const displayName =
      String(
        req.body.displayName || ""
      ).trim();

    const bio =
      String(
        req.body.bio || ""
      ).trim();

    await pool.query(
      `
      UPDATE users
      SET display_name = $1,
          bio = $2
      WHERE id = $3
      `,
      [
        displayName || "User",
        bio,
        req.session.userId
      ]
    );

    res.json({
      ok: true
    });
  }
);

app.post(
  "/api/me/password",
  auth,
  async (req, res) => {
    const password =
      String(
        req.body.password || ""
      );

    if (password.length < 8) {
      return res.status(400).json({
        error:
          "パスワードは8文字以上です"
      });
    }

    const hash =
      await bcrypt.hash(
        password,
        12
      );

    await pool.query(
      `
      UPDATE users
      SET password_hash = $1
      WHERE id = $2
      `,
      [
        hash,
        req.session.userId
      ]
    );

    res.json({
      ok: true
    });
  }
);

app.post(
  "/api/me/icon",
  auth,
  upload.single("image"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error:
          "画像を選択してください"
      });
    }

    const imageUrl =
      "/uploads/" +
      req.file.filename;

    await pool.query(
      `
      UPDATE users
      SET avatar_url = $1
      WHERE id = $2
      `,
      [
        imageUrl,
        req.session.userId
      ]
    );

    res.json({
      ok: true,
      avatar_url: imageUrl
    });
  }
);

/* ================================
   Friends
================================ */

app.get(
  "/api/users/search",
  auth,
  async (req, res) => {
    const q =
      "%" +
      String(
        req.query.q || ""
      ).trim() +
      "%";

    const result =
      await pool.query(
        `
        SELECT
          id,
          username,
          display_name,
          avatar_url
        FROM users
        WHERE id <> $1
          AND is_banned = FALSE
          AND (
            username ILIKE $2
            OR display_name ILIKE $2
          )
        ORDER BY display_name
        LIMIT 20
        `,
        [
          req.session.userId,
          q
        ]
      );

    res.json(
      result.rows
    );
  }
);

app.post(
  "/api/friends/request",
  auth,
  async (req, res) => {
    const target =
      Number(
        req.body.userId
      );

    if (
      !target ||
      target === req.session.userId
    ) {
      return res.status(400).json({
        error:
          "ユーザーが不正です"
      });
    }

    try {
      await pool.query(
        `
        INSERT INTO friendships(
          requester_id,
          addressee_id
        )
        VALUES($1,$2)
        `,
        [
          req.session.userId,
          target
        ]
      );

      await pool.query(
        `
        INSERT INTO notifications(
          user_id,
          type,
          title,
          content
        )
        VALUES(
          $1,
          'friend_request',
          'フレンド申請',
          'フレンド申請が届きました'
        )
        `,
        [target]
      );

      io.to(
        "u:" + target
      ).emit(
        "notification"
      );

      res.json({
        ok: true
      });

    } catch (error) {
      if (
        error.code === "23505"
      ) {
        return res.status(409).json({
          error:
            "申請がすでに存在します"
        });
      }

      console.error(error);

      res.status(500).json({
        error:
          "申請に失敗しました"
      });
    }
  }
);

app.get(
  "/api/friends",
  auth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT
          f.id,
          f.status,
          f.requester_id,
          u.id AS user_id,
          u.username,
          u.display_name,
          u.avatar_url
        FROM friendships f
        JOIN users u
          ON u.id = CASE
            WHEN f.requester_id = $1
            THEN f.addressee_id
            ELSE f.requester_id
          END
        WHERE
          f.requester_id = $1
          OR f.addressee_id = $1
        ORDER BY u.display_name
        `,
        [req.session.userId]
      );

    res.json(
      result.rows
    );
  }
);

app.post(
  "/api/friends/accept",
  auth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        UPDATE friendships
        SET status = 'accepted'
        WHERE id = $1
          AND addressee_id = $2
          AND status = 'pending'
        RETURNING requester_id
        `,
        [
          Number(
            req.body.friendshipId
          ),
          req.session.userId
        ]
      );

    if (!result.rowCount) {
      return res.status(404).json({
        error:
          "申請がありません"
      });
    }

    const requesterId =
      result.rows[0]
        .requester_id;

    await pool.query(
      `
      INSERT INTO notifications(
        user_id,
        type,
        title,
        content
      )
      VALUES(
        $1,
        'friend_accept',
        'フレンド承認',
        'フレンド申請が承認されました'
      )
      `,
      [requesterId]
    );

    io.to(
      "u:" + requesterId
    ).emit(
      "notification"
    );

    res.json({
      ok: true
    });
  }
);

/* ================================
   DM
================================ */

app.post(
  "/api/dm/open",
  auth,
  async (req, res) => {
    const other =
      Number(
        req.body.userId
      );

    const result =
      await pool.query(
        `
        SELECT r.id
        FROM dm_rooms r
        JOIN dm_members a
          ON a.room_id = r.id
        JOIN dm_members b
          ON b.room_id = r.id
        WHERE
          a.user_id = $1
          AND b.user_id = $2
          AND (
            SELECT COUNT(*)
            FROM dm_members m
            WHERE m.room_id = r.id
          ) = 2
        LIMIT 1
        `,
        [
          req.session.userId,
          other
        ]
      );

    if (result.rowCount) {
      return res.json({
        roomId: result.rows[0].id
      });
    }

    const room =
      await pool.query(
        `
        INSERT INTO dm_rooms
        DEFAULT VALUES
        RETURNING id
        `
      );

    await pool.query(
      `
      INSERT INTO dm_members(
        room_id,
        user_id
      )
      VALUES
        ($1,$2),
        ($1,$3)
      `,
      [
        room.rows[0].id,
        req.session.userId,
        other
      ]
    );

    res.json({
      roomId:
        room.rows[0].id
    });
  }
);

app.get(
  "/api/dm/rooms",
  auth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT
          r.id AS room_id,
          u.id AS user_id,
          u.username,
          u.display_name,
          u.avatar_url,
          (
            SELECT content
            FROM messages
            WHERE room_id = r.id
            ORDER BY created_at DESC
            LIMIT 1
          ) AS last_message
        FROM dm_rooms r
        JOIN dm_members me
          ON me.room_id = r.id
          AND me.user_id = $1
        JOIN dm_members other
          ON other.room_id = r.id
          AND other.user_id <> $1
        JOIN users u
          ON u.id = other.user_id
        ORDER BY r.id DESC
        `,
        [req.session.userId]
      );

    res.json(
      result.rows
    );
  }
);

app.get(
  "/api/dm/:id",
  auth,
  async (req, res) => {
    const id =
      Number(
        req.params.id
      );

    const member =
      await pool.query(
        `
        SELECT 1
        FROM dm_members
        WHERE room_id = $1
          AND user_id = $2
        `,
        [
          id,
          req.session.userId
        ]
      );

    if (!member.rowCount) {
      return res.status(403).json({
        error:
          "アクセスできません"
      });
    }

    const result =
      await pool.query(
        `
        SELECT
          m.*,
          u.display_name,
          u.username
        FROM messages m
        JOIN users u
          ON u.id = m.sender_id
        WHERE m.room_id = $1
        ORDER BY m.created_at
        `,
        [id]
      );

    res.json(
      result.rows
    );
  }
);

app.post(
  "/api/dm/:id",
  auth,
  upload.single("image"),
  async (req, res) => {
    const id =
      Number(
        req.params.id
      );

    const text =
      String(
        req.body.content || ""
      );

    const replyToId =
      req.body.replyToId
        ? Number(
            req.body.replyToId
          )
        : null;

    const imageUrl =
      req.file
        ? "/uploads/" +
          req.file.filename
        : null;

    const member =
      await pool.query(
        `
        SELECT 1
        FROM dm_members
        WHERE room_id = $1
          AND user_id = $2
        `,
        [
          id,
          req.session.userId
        ]
      );

    if (!member.rowCount) {
      return res.status(403).json({
        error:
          "アクセスできません"
      });
    }

    if (
      !text.trim() &&
      !imageUrl
    ) {
      return res.status(400).json({
        error:
          "空のメッセージです"
      });
    }

    const result =
      await pool.query(
        `
        INSERT INTO messages(
          room_id,
          sender_id,
          content,
          image_url,
          reply_to_id
        )
        VALUES($1,$2,$3,$4,$5)
        RETURNING *
        `,
        [
          id,
          req.session.userId,
          text,
          imageUrl,
          replyToId
        ]
      );

    io.to(
      "r:" + id
    ).emit(
      "message",
      result.rows[0]
    );

    res.json(
      result.rows[0]
    );
  }
);

/* ================================
   Rooms
================================ */

app.post(
  "/api/rooms",
  auth,
  async (req, res) => {
    const name =
      String(
        req.body.name || ""
      ).trim();

    const privateRoom =
      Boolean(
        req.body.isPrivate
      );

    const requireJoinCode =
      Boolean(
        req.body.requireJoinCode
      );

    const joinCode =
      requireJoinCode
        ? String(
            req.body.joinCode || ""
          ).trim()
        : null;

    if (!name) {
      return res.status(400).json({
        error:
          "ルーム名を入力してください"
      });
    }

    if (
      requireJoinCode &&
      (
        joinCode.length < 4 ||
        joinCode.length > 32
      )
    ) {
      return res.status(400).json({
        error:
          "参加コードは4〜32文字です"
      });
    }

    const result =
      await pool.query(
        `
        INSERT INTO rooms(
          name,
          owner_id,
          is_private,
          require_join_code,
          join_code
        )
        VALUES($1,$2,$3,$4,$5)
        RETURNING *
        `,
        [
          name,
          req.session.userId,
          privateRoom,
          requireJoinCode,
          joinCode
        ]
      );

    await pool.query(
      `
      INSERT INTO room_members(
        room_id,
        user_id
      )
      VALUES($1,$2)
      `,
      [
        result.rows[0].id,
        req.session.userId
      ]
    );

    res.json(
      result.rows[0]
    );
  }
);

app.get(
  "/api/rooms/public",
  auth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT
          r.id,
          r.name,
          r.owner_id,
          u.username AS owner_username,
          u.display_name AS owner_display_name,
          COUNT(m.user_id)::int AS member_count
        FROM rooms r
        JOIN users u
          ON u.id = r.owner_id
        LEFT JOIN room_members m
          ON m.room_id = r.id
        WHERE r.is_private = FALSE
        GROUP BY
          r.id,
          u.username,
          u.display_name
        ORDER BY r.id DESC
        `
      );

    res.json(
      result.rows
    );
  }
);

app.get(
  "/api/rooms/mine",
  auth,
  async (req, res) => {
    const admin =
      await isAdmin(
        req.session.userId
      );

    let result;

    if (admin) {
      result =
        await pool.query(
          `
          SELECT
            r.id,
            r.name,
            r.owner_id,
            r.is_private,
            r.require_join_code,
            COUNT(m.user_id)::int AS member_count
          FROM rooms r
          LEFT JOIN room_members m
            ON m.room_id = r.id
          GROUP BY r.id
          ORDER BY r.id DESC
          `
        );
    } else {
      result =
        await pool.query(
          `
          SELECT
            r.id,
            r.name,
            r.owner_id,
            r.is_private,
            r.require_join_code,
            COUNT(m.user_id)::int AS member_count
          FROM rooms r
          JOIN room_members me
            ON me.room_id = r.id
            AND me.user_id = $1
          LEFT JOIN room_members m
            ON m.room_id = r.id
          GROUP BY r.id
          ORDER BY r.id DESC
          `,
          [req.session.userId]
        );
    }

    res.json(
      result.rows
    );
  }
);

app.post(
  "/api/rooms/join",
  auth,
  async (req, res) => {
    const roomId =
      Number(
        req.body.roomId
      );

    const joinCode =
      String(
        req.body.joinCode || ""
      );

    const result =
      await pool.query(
        "SELECT * FROM rooms WHERE id = $1",
        [roomId]
      );

    if (!result.rowCount) {
      return res.status(404).json({
        error:
          "ルームがありません"
      });
    }

    const room =
      result.rows[0];

    const admin =
      await isAdmin(
        req.session.userId
      );

    if (
      admin ||
      room.owner_id ===
        req.session.userId
    ) {
      await pool.query(
        `
        INSERT INTO room_members(
          room_id,
          user_id
        )
        VALUES($1,$2)
        ON CONFLICT DO NOTHING
        `,
        [
          roomId,
          req.session.userId
        ]
      );

      return res.json({
        ok: true,
        roomId
      });
    }

    if (
      await roomBanned(
        req.session.userId,
        roomId
      )
    ) {
      return res.status(403).json({
        error:
          "このルームからBANされています"
      });
    }

    if (
      room.is_private &&
      !joinCode
    ) {
      return res.status(403).json({
        error:
          "参加コードが必要です"
      });
    }

    if (
      room.require_join_code &&
      joinCode !==
        room.join_code
    ) {
      return res.status(403).json({
        error:
          "参加コードが違います"
      });
    }

    await pool.query(
      `
      INSERT INTO room_members(
        room_id,
        user_id
      )
      VALUES($1,$2)
      ON CONFLICT DO NOTHING
      `,
      [
        roomId,
        req.session.userId
      ]
    );

    res.json({
      ok: true,
      roomId
    });
  }
);

app.get(
  "/api/rooms/:id/messages",
  auth,
  async (req, res) => {
    const roomId =
      Number(
        req.params.id
      );

    const admin =
      await isAdmin(
        req.session.userId
      );

    if (
      !admin &&
      !(
        await roomMember(
          req.session.userId,
          roomId
        )
      )
    ) {
      return res.status(403).json({
        error:
          "ルームに参加していません"
      });
    }

    const result =
      await pool.query(
        `
        SELECT
          m.*,
          u.username,
          u.display_name,
          u.avatar_url
        FROM messages m
        JOIN users u
          ON u.id = m.sender_id
        WHERE m.room_id = $1
        ORDER BY m.created_at
        LIMIT 500
        `,
        [roomId]
      );

    res.json(
      result.rows
    );
  }
);

app.post(
  "/api/rooms/:id/messages",
  auth,
  upload.single("image"),
  async (req, res) => {
    const roomId =
      Number(
        req.params.id
      );

    const text =
      String(
        req.body.content || ""
      );

    const replyToId =
      req.body.replyToId
        ? Number(
            req.body.replyToId
          )
        : null;

    const imageUrl =
      req.file
        ? "/uploads/" +
          req.file.filename
        : null;

    const admin =
      await isAdmin(
        req.session.userId
      );

    if (
      !admin &&
      !(
        await roomMember(
          req.session.userId,
          roomId
        )
      )
    ) {
      return res.status(403).json({
        error:
          "ルームに参加していません"
      });
    }

    if (
      !admin &&
      (
        await roomBanned(
          req.session.userId,
          roomId
        )
      )
    ) {
      return res.status(403).json({
        error:
          "このルームからBANされています"
      });
    }

    if (
      !text.trim() &&
      !imageUrl
    ) {
      return res.status(400).json({
        error:
          "空のメッセージです"
      });
    }

    if (replyToId) {
      const reply =
        await pool.query(
          `
          SELECT id
          FROM messages
          WHERE id = $1
            AND room_id = $2
          `,
          [
            replyToId,
            roomId
          ]
        );

      if (!reply.rowCount) {
        return res.status(400).json({
          error:
            "返信先メッセージが見つかりません"
        });
      }
    }

    const result =
      await pool.query(
        `
        INSERT INTO messages(
          room_id,
          sender_id,
          content,
          image_url,
          reply_to_id
        )
        VALUES($1,$2,$3,$4,$5)
        RETURNING *
        `,
        [
          roomId,
          req.session.userId,
          text,
          imageUrl,
          replyToId
        ]
      );

    await chatLog(
      roomId,
      req.session.userId,
      result.rows[0].id,
      text,
      imageUrl
    );

    io.to(
      "r:" + roomId
    ).emit(
      "message",
      result.rows[0]
    );

    res.json(
      result.rows[0]
    );
  }
);

/* ================================
   Kick
================================ */

app.post(
  "/api/rooms/:id/kick",
  auth,
  async (req, res) => {
    const roomId =
      Number(
        req.params.id
      );

    const targetUserId =
      Number(
        req.body.userId
      );

    const reason =
      String(
        req.body.reason || ""
      );

    const owner =
      await roomOwner(
        req.session.userId,
        roomId
      );

    const admin =
      await isAdmin(
        req.session.userId
      );

    if (!owner && !admin) {
      return res.status(403).json({
        error:
          "権限がありません"
      });
    }

    if (
      await isAdmin(
        targetUserId
      )
    ) {
      return res.status(403).json({
        error:
          "AdminはKickできません"
      });
    }

    await pool.query(
      `
      DELETE FROM room_members
      WHERE room_id = $1
        AND user_id = $2
      `,
      [
        roomId,
        targetUserId
      ]
    );

    await adminLog(
      "KICK",
      req.session.userId,
      roomId,
      targetUserId,
      null,
      reason
    );

    io.to(
      "u:" +
        targetUserId
    ).emit(
      "roomKicked",
      {
        roomId
      }
    );

    res.json({
      ok: true
    });
  }
);

/* ================================
   BAN
================================ */

app.post(
  "/api/rooms/:id/ban",
  auth,
  async (req, res) => {
    const roomId =
      Number(
        req.params.id
      );

    const targetUserId =
      Number(
        req.body.userId
      );

    const reason =
      String(
        req.body.reason || ""
      );

    const owner =
      await roomOwner(
        req.session.userId,
        roomId
      );

    const admin =
      await isAdmin(
        req.session.userId
      );

    if (!owner && !admin) {
      return res.status(403).json({
        error:
          "権限がありません"
      });
    }

    if (
      targetUserId ===
      req.session.userId
    ) {
      return res.status(400).json({
        error:
          "自分自身をBANできません"
      });
    }

    if (
      await isAdmin(
        targetUserId
      )
    ) {
      return res.status(403).json({
        error:
          "AdminはBANできません"
      });
    }

    await pool.query(
      `
      INSERT INTO room_bans(
        room_id,
        user_id,
        banned_by,
        reason
      )
      VALUES($1,$2,$3,$4)
      ON CONFLICT(
        room_id,
        user_id
      )
      DO UPDATE SET
        banned_by =
          EXCLUDED.banned_by,
        reason =
          EXCLUDED.reason,
        created_at =
          NOW()
      `,
      [
        roomId,
        targetUserId,
        req.session.userId,
        reason
      ]
    );

    await pool.query(
      `
      DELETE FROM room_members
      WHERE room_id = $1
        AND user_id = $2
      `,
      [
        roomId,
        targetUserId
      ]
    );

    await adminLog(
      "BAN",
      req.session.userId,
      roomId,
      targetUserId,
      null,
      reason
    );

    io.to(
      "u:" +
        targetUserId
    ).emit(
      "roomBanned",
      {
        roomId
      }
    );

    res.json({
      ok: true
    });
  }
);

/* ================================
   BAN list
================================ */

app.get(
  "/api/rooms/:id/bans",
  auth,
  async (req, res) => {
    const roomId =
      Number(
        req.params.id
      );

    const admin =
      await isAdmin(
        req.session.userId
      );

    const owner =
      await roomOwner(
        req.session.userId,
        roomId
      );

    if (!admin && !owner) {
      return res.status(403).json({
        error:
          "権限がありません"
      });
    }

    const result =
      await pool.query(
        `
        SELECT
          b.*,
          u.username,
          u.display_name,
          a.username AS banned_by_username
        FROM room_bans b
        JOIN users u
          ON u.id = b.user_id
        LEFT JOIN users a
          ON a.id = b.banned_by
        WHERE b.room_id = $1
        ORDER BY b.created_at DESC
        `,
        [roomId]
      );

    res.json(
      result.rows
    );
  }
);

app.delete(
  "/api/rooms/:id/bans/:userId",
  auth,
  async (req, res) => {
    const roomId =
      Number(
        req.params.id
      );

    const targetUserId =
      Number(
        req.params.userId
      );

    const admin =
      await isAdmin(
        req.session.userId
      );

    const owner =
      await roomOwner(
        req.session.userId,
        roomId
      );

    if (!admin && !owner) {
      return res.status(403).json({
        error:
          "権限がありません"
      });
    }

    await pool.query(
      `
      DELETE FROM room_bans
      WHERE room_id = $1
        AND user_id = $2
      `,
      [
        roomId,
        targetUserId
      ]
    );

    await adminLog(
      "UNBAN",
      req.session.userId,
      roomId,
      targetUserId,
      null,
      "BAN解除"
    );

    res.json({
      ok: true
    });
  }
);

/* ================================
   Message delete
================================ */

app.delete(
  "/api/messages/:messageId",
  auth,
  async (req, res) => {
    const messageId =
      Number(
        req.params.messageId
      );

    const result =
      await pool.query(
        `
        SELECT *
        FROM messages
        WHERE id = $1
        `,
        [messageId]
      );

    if (!result.rowCount) {
      return res.status(404).json({
        error:
          "メッセージがありません"
      });
    }

    const message =
      result.rows[0];

    const admin =
      await isAdmin(
        req.session.userId
      );

    const owner =
      await roomOwner(
        req.session.userId,
        message.room_id
      );

    if (
      message.sender_id !==
        req.session.userId &&
      !admin &&
      !owner
    ) {
      return res.status(403).json({
        error:
          "削除権限がありません"
      });
    }

    await pool.query(
      `
      UPDATE messages
      SET
        deleted = TRUE,
        content = '',
        image_url = NULL
      WHERE id = $1
      `,
      [messageId]
    );

    await adminLog(
      "DELETE_MESSAGE",
      req.session.userId,
      message.room_id,
      message.sender_id,
      messageId,
      "メッセージ削除"
    );

    await chatLog(
      message.room_id,
      req.session.userId,
      messageId,
      "",
      null,
      "DELETE_MESSAGE"
    );

    io.to(
      "r:" +
        message.room_id
    ).emit(
      "messageDeleted",
      {
        messageId
      }
    );

    res.json({
      ok: true
    });
  }
);

/* ================================
   Reactions
================================ */

app.post(
  "/api/messages/:messageId/reaction",
  auth,
  async (req, res) => {
    const messageId =
      Number(
        req.params.messageId
      );

    const imageUrl =
      String(
        req.body.imageUrl || ""
      ).trim();

    if (!imageUrl) {
      return res.status(400).json({
        error:
          "リアクション画像がありません"
      });
    }

    const result =
      await pool.query(
        `
        SELECT room_id
        FROM messages
        WHERE id = $1
        `,
        [messageId]
      );

    if (!result.rowCount) {
      return res.status(404).json({
        error:
          "メッセージがありません"
      });
    }

    const roomId =
      result.rows[0]
        .room_id;

    if (
      !(
        await roomMember(
          req.session.userId,
          roomId
        )
      ) &&
      !(
        await isAdmin(
          req.session.userId
        )
      )
    ) {
      return res.status(403).json({
        error:
          "アクセスできません"
      });
    }

    const reaction =
      await pool.query(
        `
        INSERT INTO reactions(
          message_id,
          user_id,
          image_url
        )
        VALUES($1,$2,$3)
        ON CONFLICT DO NOTHING
        RETURNING *
        `,
        [
          messageId,
          req.session.userId,
          imageUrl
        ]
      );

    if (
      reaction.rowCount
    ) {
      io.to(
        "r:" +
          roomId
      ).emit(
        "reaction",
        reaction.rows[0]
      );
    }

    res.json({
      ok: true,
      reaction:
        reaction.rows[0] ||
        null
    });
  }
);

/* ================================
   Notifications
================================ */

app.get(
  "/api/notifications",
  auth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT *
        FROM notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 50
        `,
        [req.session.userId]
      );

    res.json(
      result.rows
    );
  }
);

app.post(
  "/api/notifications/read",
  auth,
  async (req, res) => {
    await pool.query(
      `
      UPDATE notifications
      SET is_read = TRUE
      WHERE user_id = $1
      `,
      [req.session.userId]
    );

    res.json({
      ok: true
    });
  }
);

/* ================================
   Groups
================================ */

app.post(
  "/api/groups",
  auth,
  async (req, res) => {
    const name =
      String(
        req.body.name || ""
      ).trim();

    if (!name) {
      return res.status(400).json({
        error:
          "グループ名を入力してください"
      });
    }

    const result =
      await pool.query(
        `
        INSERT INTO groups(
          name,
          owner_id
        )
        VALUES($1,$2)
        RETURNING *
        `,
        [
          name,
          req.session.userId
        ]
      );

    await pool.query(
      `
      INSERT INTO group_members(
        group_id,
        user_id,
        role
      )
      VALUES($1,$2,'owner')
      `,
      [
        result.rows[0].id,
        req.session.userId
      ]
    );

    res.json(
      result.rows[0]
    );
  }
);

app.get(
  "/api/groups",
  auth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT
          g.*,
          gm.role
        FROM groups g
        JOIN group_members gm
          ON gm.group_id = g.id
        WHERE gm.user_id = $1
        ORDER BY g.id DESC
        `,
        [req.session.userId]
      );

    res.json(
      result.rows
    );
  }
);

/* ================================
   Communities
================================ */

app.post(
  "/api/communities",
  auth,
  async (req, res) => {
    const name =
      String(
        req.body.name || ""
      ).trim();

    const description =
      String(
        req.body.description || ""
      ).trim();

    if (!name) {
      return res.status(400).json({
        error:
          "コミュニティ名を入力してください"
      });
    }

    const result =
      await pool.query(
        `
        INSERT INTO communities(
          name,
          description,
          owner_id
        )
        VALUES($1,$2,$3)
        RETURNING *
        `,
        [
          name,
          description,
          req.session.userId
        ]
      );

    await pool.query(
      `
      INSERT INTO channels(
        community_id,
        name
      )
      VALUES($1,'general')
      `,
      [result.rows[0].id]
    );

    res.json(
      result.rows[0]
    );
  }
);

app.get(
  "/api/communities",
  auth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT
          id,
          name,
          description,
          owner_id,
          created_at
        FROM communities
        ORDER BY id DESC
        `
      );

    res.json(
      result.rows
    );
  }
);

/* ================================
   Admin
================================ */

app.get(
  "/api/admin/logs",
  adminOnly,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT
          l.*,
          a.username AS admin_username,
          t.username AS target_username,
          r.name AS room_name
        FROM admin_logs l
        LEFT JOIN users a
          ON a.id = l.admin_id
        LEFT JOIN users t
          ON t.id =
            l.target_user_id
        LEFT JOIN rooms r
          ON r.id = l.room_id
        ORDER BY l.created_at DESC
        LIMIT 500
        `
      );

    res.json(
      result.rows
    );
  }
);

app.get(
  "/api/admin/users",
  adminOnly,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT
          id,
          username,
          display_name,
          avatar_url,
          is_admin,
          is_banned,
          created_at,
          last_online
        FROM users
        ORDER BY id DESC
        LIMIT 500
        `
      );

    for (
      const user of result.rows
    ) {
      user.is_admin =
        await isAdmin(
          user.id
        );
    }

    res.json(
      result.rows
    );
  }
);

app.post(
  "/api/admin/users/:id/ban",
  adminOnly,
  async (req, res) => {
    const userId =
      Number(
        req.params.id
      );

    const reason =
      String(
        req.body.reason || ""
      );

    if (
      await isAdmin(userId)
    ) {
      return res.status(403).json({
        error:
          "Adminは通常のアカウントBAN対象外です"
      });
    }

    await pool.query(
      `
      UPDATE users
      SET is_banned = TRUE
      WHERE id = $1
      `,
      [userId]
    );

    await adminLog(
      "ACCOUNT_BAN",
      req.session.userId,
      null,
      userId,
      null,
      reason
    );

    io.to(
      "u:" +
        userId
    ).emit(
      "accountBanned"
    );

    res.json({
      ok: true
    });
  }
);

app.delete(
  "/api/admin/users/:id/ban",
  adminOnly,
  async (req, res) => {
    const userId =
      Number(
        req.params.id
      );

    if (
      await isAdmin(userId)
    ) {
      return res.status(403).json({
        error:
          "Adminの状態はこの操作で変更できません"
      });
    }

    await pool.query(
      `
      UPDATE users
      SET is_banned = FALSE
      WHERE id = $1
      `,
      [userId]
    );

    await adminLog(
      "ACCOUNT_UNBAN",
      req.session.userId,
      null,
      userId,
      null,
      "アカウントBAN解除"
    );

    res.json({
      ok: true
    });
  }
);

app.get(
  "/api/admin/rooms",
  adminOnly,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT
          r.*,
          u.username AS owner_username,
          u.display_name AS owner_display_name,
          COUNT(m.user_id)::int AS member_count
        FROM rooms r
        LEFT JOIN users u
          ON u.id = r.owner_id
        LEFT JOIN room_members m
          ON m.room_id = r.id
        GROUP BY
          r.id,
          u.username,
          u.display_name
        ORDER BY r.id DESC
        `
      );

    res.json(
      result.rows
    );
  }
);

app.post(
  "/api/admin/join-room",
  adminOnly,
  async (req, res) => {
    const roomId =
      Number(
        req.body.roomId
      );

    if (
      !(await roomExists(roomId))
    ) {
      return res.status(404).json({
        error:
          "ルームがありません"
      });
    }

    await pool.query(
      `
      INSERT INTO room_members(
        room_id,
        user_id
      )
      VALUES($1,$2)
      ON CONFLICT DO NOTHING
      `,
      [
        roomId,
        req.session.userId
      ]
    );

    await adminLog(
      "ADMIN_JOIN_ROOM",
      req.session.userId,
      roomId,
      null,
      null,
      "管理目的の参加"
    );

    res.json({
      ok: true,
      roomId
    });
  }
);

app.delete(
  "/api/admin/rooms/:id",
  adminOnly,
  async (req, res) => {
    const roomId =
      Number(
        req.params.id
      );

    await adminLog(
      "DELETE_ROOM",
      req.session.userId,
      roomId,
      null,
      null,
      "Adminによるルーム削除"
    );

    await pool.query(
      `
      DELETE FROM rooms
      WHERE id = $1
      `,
      [roomId]
    );

    io.to(
      "r:" +
        roomId
    ).emit(
      "roomDeleted",
      {
        roomId
      }
    );

    res.json({
      ok: true
    });
  }
);

/* ================================
   Reports
================================ */

app.post(
  "/api/reports",
  auth,
  async (req, res) => {
    const targetUserId =
      req.body.targetUserId
        ? Number(
            req.body.targetUserId
          )
        : null;

    const roomId =
      req.body.roomId
        ? Number(
            req.body.roomId
          )
        : null;

    const messageId =
      req.body.messageId
        ? Number(
            req.body.messageId
          )
        : null;

    const reason =
      String(
        req.body.reason || ""
      ).trim();

    if (!reason) {
      return res.status(400).json({
        error:
          "通報理由を入力してください"
      });
    }

    await pool.query(
      `
      INSERT INTO reports(
        reporter_id,
        target_user_id,
        room_id,
        message_id,
        reason
      )
      VALUES($1,$2,$3,$4,$5)
      `,
      [
        req.session.userId,
        targetUserId,
        roomId,
        messageId,
        reason
      ]
    );

    res.json({
      ok: true
    });
  }
);

app.get(
  "/api/admin/reports",
  adminOnly,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT
          r.*,
          reporter.username AS reporter_username,
          target.username AS target_username,
          rooms.name AS room_name
        FROM reports r
        LEFT JOIN users reporter
          ON reporter.id =
            r.reporter_id
        LEFT JOIN users target
          ON target.id =
            r.target_user_id
        LEFT JOIN rooms
          ON rooms.id =
            r.room_id
        ORDER BY r.created_at DESC
        LIMIT 500
        `
      );

    res.json(
      result.rows
    );
  }
);

/* ================================
   Play Cat
================================ */

app.get(
  "/api/games",
  auth,
  async (req, res) => {
    const result =
      await pool.query(
        `
        SELECT
          g.*,
          u.username AS creator_username
        FROM games g
        LEFT JOIN users u
          ON u.id = g.creator_id
        WHERE g.is_public = TRUE
        ORDER BY g.created_at DESC
        `
      );

    res.json(
      result.rows
    );
  }
);

app.post(
  "/api/games",
  auth,
  async (req, res) => {
    const title =
      String(
        req.body.title || ""
      ).trim();

    const description =
      String(
        req.body.description || ""
      ).trim();

    const gameType =
      String(
        req.body.gameType || ""
      ).trim();

    const gameUrl =
      String(
        req.body.gameUrl || ""
      ).trim();

    const thumbnailUrl =
      req.body.thumbnailUrl
        ? String(
            req.body.thumbnailUrl
          )
        : null;

    const category =
      req.body.category
        ? String(
            req.body.category
          )
        : "";

    if (
      !title ||
      !gameType ||
      !gameUrl
    ) {
      return res.status(400).json({
        error:
          "タイトル・種類・URLが必要です"
      });
    }

    const result =
      await pool.query(
        `
        INSERT INTO games(
          title,
          description,
          game_type,
          game_url,
          thumbnail_url,
          category,
          creator_id
        )
        VALUES(
          $1,$2,$3,$4,$5,$6,$7
        )
        RETURNING *
        `,
        [
          title,
          description,
          gameType,
          gameUrl,
          thumbnailUrl,
          category,
          req.session.userId
        ]
      );

    res.json(
      result.rows[0]
    );
  }
);

app.post(
  "/api/games/:id/play",
  auth,
  async (req, res) => {
    const gameId =
      Number(
        req.params.id
      );

    await pool.query(
      `
      UPDATE games
      SET play_count =
        play_count + 1
      WHERE id = $1
      `,
      [gameId]
    );

    res.json({
      ok: true
    });
  }
);

app.post(
  "/api/games/:id/favorite",
  auth,
  async (req, res) => {
    const gameId =
      Number(
        req.params.id
      );

    await pool.query(
      `
      INSERT INTO game_favorites(
        user_id,
        game_id
      )
      VALUES($1,$2)
      ON CONFLICT DO NOTHING
      `,
      [
        req.session.userId,
        gameId
      ]
    );

    res.json({
      ok: true
    });
  }
);

/* ================================
   Cat Tube
================================ */

app.get(
  "/api/youtube/search",
  async (req, res) => {
    const key =
      process.env.YOUTUBE_API_KEY;

    if (!key) {
      return res.status(503).json({
        error:
          "YOUTUBE_API_KEY が設定されていません"
      });
    }

    const q =
      String(
        req.query.q || ""
      ).trim();

    if (!q) {
      return res.status(400).json({
        error:
          "検索語を入力してください"
      });
    }

    const maxResults =
      Math.min(
        Math.max(
          Number(
            req.query.maxResults
          ) || 12,
          1
        ),
        50
      );

    try {
      const url =
        new URL(
          "https://www.googleapis.com/youtube/v3/search"
        );

      url.searchParams.set(
        "part",
        "snippet"
      );

      url.searchParams.set(
        "type",
        "video"
      );

      url.searchParams.set(
        "q",
        q
      );

      url.searchParams.set(
        "maxResults",
        String(maxResults)
      );

      url.searchParams.set(
        "key",
        key
      );

      const response =
        await fetch(url);

      const data =
        await response.json();

      if (!response.ok) {
        return res
          .status(response.status)
          .json({
            error:
              data.error?.message ||
              "YouTube APIエラー"
          });
      }

      res.json(
        data.items || []
      );

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "YouTube検索に失敗しました"
      });
    }
  }
);

app.get(
  "/api/youtube/video/:id",
  async (req, res) => {
    const key =
      process.env.YOUTUBE_API_KEY;

    if (!key) {
      return res.status(503).json({
        error:
          "YOUTUBE_API_KEY が設定されていません"
      });
    }

    try {
      const url =
        new URL(
          "https://www.googleapis.com/youtube/v3/videos"
        );

      url.searchParams.set(
        "part",
        "snippet,statistics,contentDetails"
      );

      url.searchParams.set(
        "id",
        req.params.id
      );

      url.searchParams.set(
        "key",
        key
      );

      const response =
        await fetch(url);

      const data =
        await response.json();

      if (!response.ok) {
        return res
          .status(response.status)
          .json({
            error:
              data.error?.message ||
              "YouTube APIエラー"
          });
      }

      res.json(
        data.items?.[0] ||
          null
      );

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "動画取得に失敗しました"
      });
    }
  }
);

app.get(
  "/api/youtube/stream",
  async (req, res) => {
    const source =
      String(
        req.query.url || ""
      ).trim();

    if (
      !/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(
        source
      )
    ) {
      return res.status(400).json({
        error:
          "YouTube URLを指定してください"
      });
    }

    try {
      const args = [
        "--no-playlist",
        "--no-warnings",
        "-f",
        "bv*+ba/b",
        "--get-url",
        source
      ];

      const result =
        await execFileAsync(
          "yt-dlp",
          args,
          {
            timeout: 30000,
            maxBuffer:
              1024 *
              1024 *
              4
          }
        );

      const streamUrl =
        result.stdout
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .pop();

      if (!streamUrl) {
        return res.status(404).json({
          error:
            "ストリームURLを取得できませんでした"
        });
      }

      res.json({
        url: streamUrl,
        note:
          "取得したストリームURLは一時的な場合があります。"
      });

    } catch (error) {
      console.error(
        "yt-dlp error:",
        error
      );

      res.status(502).json({
        error:
          "yt-dlpでストリームを取得できませんでした"
      });
    }
  }
);

/* ================================
   Static
================================ */

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

/* ================================
   Socket.IO
================================ */

io.engine.use(
  sessionMiddleware
);

io.use(
  (socket, next) => {
    if (
      !socket.request.session
        .userId
    ) {
      return next(
        new Error(
          "unauthorized"
        )
      );
    }

    next();
  }
);

io.on(
  "connection",
  socket => {
    const userId =
      socket.request.session
        .userId;

    socket.join(
      "u:" + userId
    );

    socket.on(
      "joinRoom",
      async roomId => {
        const id =
          Number(roomId);

        if (
          await isAdmin(
            userId
          ) ||
          await roomMember(
            userId,
            id
          )
        ) {
          socket.join(
            "r:" + id
          );
        }
      }
    );

    socket.on(
      "leaveRoom",
      roomId => {
        socket.leave(
          "r:" +
            Number(roomId)
        );
      }
    );
  }
);

/* ================================
   Start
================================ */

async function start() {
  try {
    await db();

    server.listen(
      PORT,
      () => {
        console.log(
          `Cat Hub running on port ${PORT}`
        );

        console.log(
          "PostgreSQL connected."
        );

        console.log(
          "Database tables are ready."
        );
      }
    );

  } catch (error) {
    console.error(
      "Database initialization error:",
      error
    );

    process.exit(1);
  }
}

start();
