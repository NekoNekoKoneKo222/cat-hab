-- Cat Hub データベーススキーマ
-- 起動時に自動実行される。IF NOT EXISTSで冪等性を確保。

-- express-session (connect-pg-simple) 用のセッションテーブル。
-- connect-pg-simpleの自動作成(createTableIfMissing)は非同期で走り、
-- 起動直後の最初のリクエストとの間にタイミング問題を起こすことがあるため、
-- 他の全テーブルと同じ起動シーケンスの中で確実に作成する。
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR NOT NULL COLLATE "default",
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

-- 「session テーブルに主キーが存在するか」自体をpg_index(indisprimary)で
-- 判定する(制約名では判定しない)。
-- また、主キー未付与のまま運用されていた既存テーブルにはsid重複行が
-- 残っている可能性があるため、ADD CONSTRAINTの前に重複を除去しておく
-- (重複がある状態でPRIMARY KEYを追加しようとすると一意性違反でエラーになり、
--  この初期化処理全体が失敗して主キーが付かないまま起動してしまう)。
--
-- 注意: 制約名(かつてのsession_pkey)は使わない。Postgresではインデックス名は
-- テーブル単位ではなくスキーマ全体で一意である必要があり、このDB上には
-- アプリと無関係な別テーブル(user_sessions)がたまたま同名の主キー制約を
-- 持っていたことが判明している。同じ名前を使うと、その無関係なテーブルの
-- 制約と衝突したり、最悪誤って触ってしまったりする恐れがあるため、
-- sessionテーブル専用の一意な名前を使う。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    WHERE c.relname = 'session' AND i.indisprimary
  ) THEN
    DELETE FROM session a
      USING session b
      WHERE a.sid = b.sid AND a.ctid < b.ctid;

    ALTER TABLE session ADD CONSTRAINT session_sid_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(32) UNIQUE NOT NULL,
  display_name  VARCHAR(64) NOT NULL,
  email         VARCHAR(255) UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url    TEXT,
  bio           TEXT,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS friendships (
  id           SERIAL PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending / accepted / declined / blocked
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (requester_id, addressee_id)
);

CREATE TABLE IF NOT EXISTS dm_rooms (
  id         SERIAL PRIMARY KEY,
  is_group   BOOLEAN NOT NULL DEFAULT FALSE,
  name       VARCHAR(64),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dm_members (
  id         SERIAL PRIMARY KEY,
  room_id    INTEGER NOT NULL REFERENCES dm_rooms(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS groups (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(64) NOT NULL,
  description TEXT,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_members (
  id         SERIAL PRIMARY KEY,
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       VARCHAR(16) NOT NULL DEFAULT 'member', -- member / moderator / owner
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS communities (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(64) NOT NULL,
  description TEXT,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channels (
  id           SERIAL PRIMARY KEY,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name         VARCHAR(64) NOT NULL,
  topic        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_messages (
  id         SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT,
  image_url  TEXT,
  reply_to   INTEGER REFERENCES channel_messages(id) ON DELETE SET NULL,
  deleted    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id         SERIAL PRIMARY KEY,
  room_id    INTEGER NOT NULL REFERENCES dm_rooms(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT,
  image_url  TEXT,
  reply_to   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  deleted    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rooms (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(64) NOT NULL,
  is_private  BOOLEAN NOT NULL DEFAULT FALSE,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_members (
  id         SERIAL PRIMARY KEY,
  room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       VARCHAR(16) NOT NULL DEFAULT 'member',
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS room_bans (
  id         SERIAL PRIMARY KEY,
  room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lifted_at  TIMESTAMPTZ,
  UNIQUE (room_id, user_id)
);

-- 仕様上の必須テーブルには含まれないが、「ルーム」でのチャット送信機能に必要なため追加
CREATE TABLE IF NOT EXISTS room_messages (
  id         SERIAL PRIMARY KEY,
  room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT,
  image_url  TEXT,
  reply_to   INTEGER REFERENCES room_messages(id) ON DELETE SET NULL,
  deleted    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reactions (
  id            SERIAL PRIMARY KEY,
  message_id    INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  channel_msg_id INTEGER REFERENCES channel_messages(id) ON DELETE CASCADE,
  room_msg_id   INTEGER REFERENCES room_messages(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji_code    VARCHAR(32) NOT NULL, -- 絵文字は使わずコード名で管理 (例: 'like','heart')
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (message_id IS NOT NULL)::int +
    (channel_msg_id IS NOT NULL)::int +
    (room_msg_id IS NOT NULL)::int = 1
  )
);

CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(32) NOT NULL,
  payload    JSONB,
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_logs (
  id         SERIAL PRIMARY KEY,
  admin_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     VARCHAR(64) NOT NULL,
  target     VARCHAR(64),
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reports (
  id           SERIAL PRIMARY KEY,
  reporter_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_type  VARCHAR(32) NOT NULL,
  target_id    INTEGER,
  reason       TEXT,
  status       VARCHAR(16) NOT NULL DEFAULT 'open',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS games (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(128) NOT NULL,
  description TEXT,
  category    VARCHAR(64),
  url         TEXT NOT NULL,
  thumbnail_url TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS game_favorites (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, game_id)
);

CREATE TABLE IF NOT EXISTS game_history (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  played_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS game_ratings (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  rating     SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, game_id)
);

CREATE TABLE IF NOT EXISTS game_comments (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_friendships_users ON friendships(requester_id, addressee_id);

CREATE TABLE IF NOT EXISTS chat_logs (
 id BIGSERIAL PRIMARY KEY, room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
 user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, username VARCHAR(32),
 message TEXT, action VARCHAR(32) NOT NULL, timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tube_history (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 video_id VARCHAR(20) NOT NULL, title TEXT NOT NULL, watched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(user_id,video_id)
);
CREATE TABLE IF NOT EXISTS tube_favorites (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 video_id VARCHAR(20) NOT NULL, title TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(user_id,video_id)
);
CREATE TABLE IF NOT EXISTS tube_playlists (
 id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name VARCHAR(80) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tube_playlist_items (
 playlist_id BIGINT NOT NULL REFERENCES tube_playlists(id) ON DELETE CASCADE,
 video_id VARCHAR(20) NOT NULL, title TEXT NOT NULL, added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(playlist_id,video_id)
);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS join_code_hash VARCHAR(64);
