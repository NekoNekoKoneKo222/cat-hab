CREATE TABLE IF NOT EXISTS hub_users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(32) UNIQUE NOT NULL,
  display_name VARCHAR(64) NOT NULL,
  password_hash TEXT NOT NULL,
  terms_accepted_at TIMESTAMPTZ NOT NULL,
  banned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS games (
  id BIGSERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL, thumbnail TEXT, tags TEXT[] NOT NULL DEFAULT '{}',
  category TEXT NOT NULL DEFAULT 'その他', platform TEXT NOT NULL DEFAULT 'browser',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS game_favorites (
  user_id BIGINT NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
  game_id BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,game_id)
);
INSERT INTO games(slug,title,description,author,url,tags,category,platform)
VALUES('shogi-lite','将棋ライク','5×5 の盤で遊ぶ二人用の戦略ゲーム。','Cat Hub','/games/shogi-lite.html',ARRAY['将棋','二人用'],'戦略','browser')
ON CONFLICT(slug) DO NOTHING;
