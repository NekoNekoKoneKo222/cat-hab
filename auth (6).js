'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { isAdminUser } = require('../middleware/auth');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarUrl: u.avatar_url,
    bio: u.bio,
    isAdmin: isAdminUser(u),
  };
}

router.post('/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body || {};

    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return res.status(400).json({
        error: 'ユーザー名は英数字とアンダースコアのみ、3〜20文字で入力してください',
      });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'パスワードは8文字以上128文字以内で入力してください' });
    }
    const safeDisplayName =
      typeof displayName === 'string' && displayName.trim()
        ? displayName.trim().slice(0, 64)
        : username;

    const existing = await db.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'このユーザー名は既に使用されています' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await db.query(
      `INSERT INTO users (username, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, display_name, avatar_url, bio, is_admin`,
      [username, safeDisplayName, passwordHash]
    );
    const user = result.rows[0];

    // セッション固定攻撃対策: 認証状態変更時にセッションIDを再生成する
    req.session.regenerate((err) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error('[auth/register] session.regenerate エラー:', err.message);
        return res.status(500).json({ error: 'セッションの作成に失敗しました' });
      }
      req.session.userId = user.id;
      req.session.user = user;
      return res.status(201).json({ user: publicUser(user) });
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[auth/register]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'ユーザー名とパスワードを入力してください' });
    }

    const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];

    // タイミング攻撃緩和のため、ユーザーが存在しない場合もダミーハッシュと比較する
    const dummyHash = '$2a$12$CwTycUXWue0Thq9StjUM0uJ8vTOI6QVi0OobDNP0Q3wQ4YKQz7q8m';
    const hashToCompare = user ? user.password_hash : dummyHash;
    const valid = await bcrypt.compare(password, hashToCompare);

    if (!user || !valid) {
      return res.status(401).json({ error: 'ユーザー名またはパスワードが正しくありません' });
    }
    if (user.is_banned) {
      return res.status(403).json({ error: 'このアカウントはBANされています' });
    }

    req.session.regenerate((err) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error('[auth/login] session.regenerate エラー:', err.message);
        return res.status(500).json({ error: 'セッションの作成に失敗しました' });
      }
      req.session.userId = user.id;
      req.session.user = user;
      return res.json({ user: publicUser(user) });
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[auth/login]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => {
    res.clearCookie('cathub.sid');
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.json({ user: null });
  }
  res.json({ user: publicUser(req.session.user) });
});

module.exports = router;
