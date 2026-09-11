'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { createNotification } = require('../utils/notify');

const router = express.Router();

function publicUserRow(row, prefix) {
  return {
    id: row[prefix + 'id'],
    username: row[prefix + 'username'],
    displayName: row[prefix + 'display_name'],
    avatarUrl: row[prefix + 'avatar_url'],
  };
}

// フレンド申請送信
router.post('/request', requireAuth, async (req, res) => {
  try {
    const { username } = req.body || {};
    if (typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'ユーザー名を指定してください' });
    }

    const targetResult = await db.query('SELECT id, username FROM users WHERE username = $1', [
      username.trim(),
    ]);
    const target = targetResult.rows[0];
    if (!target) {
      return res.status(404).json({ error: '指定されたユーザーが見つかりません' });
    }
    if (target.id === req.session.userId) {
      return res.status(400).json({ error: '自分自身にはフレンド申請できません' });
    }

    const existing = await db.query(
      `SELECT * FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2)
          OR (requester_id = $2 AND addressee_id = $1)`,
      [req.session.userId, target.id]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.status === 'accepted') {
        return res.status(409).json({ error: '既にフレンドです' });
      }
      return res.status(409).json({ error: '既に申請が存在します' });
    }

    const result = await db.query(
      `INSERT INTO friendships (requester_id, addressee_id, status)
       VALUES ($1, $2, 'pending') RETURNING id`,
      [req.session.userId, target.id]
    );

    await createNotification(target.id, 'friend_request', {
      fromUserId: req.session.userId,
      fromUsername: req.session.user.username,
      friendshipId: result.rows[0].id,
    });

    res.status(201).json({ id: result.rows[0].id, status: 'pending' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[friends/request]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

// 受信した申請を承認
router.post('/:id/accept', requireAuth, async (req, res) => {
  try {
    const friendshipId = Number(req.params.id);
    if (!Number.isInteger(friendshipId)) return res.status(400).json({ error: '不正なIDです' });

    const result = await db.query('SELECT * FROM friendships WHERE id = $1', [friendshipId]);
    const friendship = result.rows[0];
    if (!friendship) return res.status(404).json({ error: '申請が見つかりません' });
    if (friendship.addressee_id !== req.session.userId) {
      return res.status(403).json({ error: 'この操作を行う権限がありません' });
    }
    if (friendship.status !== 'pending') {
      return res.status(409).json({ error: 'この申請は既に処理済みです' });
    }

    await db.query(
      "UPDATE friendships SET status = 'accepted', updated_at = NOW() WHERE id = $1",
      [friendshipId]
    );
    await createNotification(friendship.requester_id, 'friend_accept', {
      fromUserId: req.session.userId,
      fromUsername: req.session.user.username,
    });

    res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[friends/accept]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

// 申請を拒否 / フレンド解除 / 送信した申請の取り消し
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const friendshipId = Number(req.params.id);
    if (!Number.isInteger(friendshipId)) return res.status(400).json({ error: '不正なIDです' });

    const result = await db.query('SELECT * FROM friendships WHERE id = $1', [friendshipId]);
    const friendship = result.rows[0];
    if (!friendship) return res.status(404).json({ error: '見つかりません' });
    if (
      friendship.requester_id !== req.session.userId &&
      friendship.addressee_id !== req.session.userId
    ) {
      return res.status(403).json({ error: 'この操作を行う権限がありません' });
    }

    await db.query('DELETE FROM friendships WHERE id = $1', [friendshipId]);
    res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[friends/delete]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

// フレンド一覧・保留中の申請一覧
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;

    const friends = await db.query(
      `SELECT f.id as friendship_id,
              u.id as u_id, u.username as u_username, u.display_name as u_display_name, u.avatar_url as u_avatar_url
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
       WHERE (f.requester_id = $1 OR f.addressee_id = $1) AND f.status = 'accepted'
       ORDER BY u.display_name`,
      [userId]
    );

    const incoming = await db.query(
      `SELECT f.id as friendship_id, f.created_at,
              u.id as u_id, u.username as u_username, u.display_name as u_display_name, u.avatar_url as u_avatar_url
       FROM friendships f
       JOIN users u ON u.id = f.requester_id
       WHERE f.addressee_id = $1 AND f.status = 'pending'
       ORDER BY f.created_at DESC`,
      [userId]
    );

    const outgoing = await db.query(
      `SELECT f.id as friendship_id, f.created_at,
              u.id as u_id, u.username as u_username, u.display_name as u_display_name, u.avatar_url as u_avatar_url
       FROM friendships f
       JOIN users u ON u.id = f.addressee_id
       WHERE f.requester_id = $1 AND f.status = 'pending'
       ORDER BY f.created_at DESC`,
      [userId]
    );

    res.json({
      friends: friends.rows.map((r) => ({ friendshipId: r.friendship_id, user: publicUserRow(r, 'u_') })),
      incoming: incoming.rows.map((r) => ({ friendshipId: r.friendship_id, user: publicUserRow(r, 'u_') })),
      outgoing: outgoing.rows.map((r) => ({ friendshipId: r.friendship_id, user: publicUserRow(r, 'u_') })),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[friends/list]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

module.exports = router;
