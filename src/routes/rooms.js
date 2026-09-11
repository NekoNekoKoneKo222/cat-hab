'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth, isAdminUser } = require('../middleware/auth');
const bus = require('../utils/events');

const router = express.Router();
const MAX_CONTENT_LENGTH = 2000;

async function getMemberRole(roomId, userId) {
  const result = await db.query('SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2', [
    roomId,
    userId,
  ]);
  return result.rows[0] ? result.rows[0].role : null;
}

async function isBanned(roomId, userId) {
  const result = await db.query(
    'SELECT 1 FROM room_bans WHERE room_id = $1 AND user_id = $2 AND lifted_at IS NULL',
    [roomId, userId]
  );
  return result.rows.length > 0;
}

function publicRoomMessage(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    content: row.deleted ? null : row.content,
    imageUrl: row.deleted ? null : row.image_url,
    replyTo: row.reply_to,
    deleted: row.deleted,
    createdAt: row.created_at,
  };
}

router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, isPrivate } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'ルーム名を入力してください' });
    }
    const result = await db.query(
      'INSERT INTO rooms (name, is_private, owner_id) VALUES ($1, $2, $3) RETURNING id, name, is_private',
      [name.trim().slice(0, 64), Boolean(isPrivate), req.session.userId]
    );
    await db.query("INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'owner')", [
      result.rows[0].id,
      req.session.userId,
    ]);
    res.status(201).json({ room: result.rows[0] });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[rooms POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.id, r.name, r.is_private, r.owner_id, rm.role,
              (SELECT COUNT(*)::int FROM room_members WHERE room_id = r.id) as member_count
       FROM rooms r
       LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = $1
       WHERE r.is_private = FALSE OR rm.user_id IS NOT NULL
       ORDER BY r.created_at DESC`,
      [req.session.userId]
    );
    res.json({ rooms: result.rows });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[rooms GET]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/:id/join', requireAuth, async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    if (!Number.isInteger(roomId)) return res.status(400).json({ error: '不正なIDです' });

    const room = await db.query('SELECT is_private FROM rooms WHERE id = $1', [roomId]);
    if (room.rows.length === 0) return res.status(404).json({ error: 'ルームが見つかりません' });
    if (room.rows[0].is_private) {
      return res.status(403).json({ error: 'プライベートルームは招待が必要です' });
    }
    if (await isBanned(roomId, req.session.userId)) {
      return res.status(403).json({ error: 'このルームからBANされています' });
    }

    const existing = await getMemberRole(roomId, req.session.userId);
    if (existing) return res.json({ ok: true, alreadyMember: true });

    await db.query("INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')", [
      roomId,
      req.session.userId,
    ]);
    res.status(201).json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[rooms/:id/join POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/:id/leave', requireAuth, async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    if (!Number.isInteger(roomId)) return res.status(400).json({ error: '不正なIDです' });
    await db.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [
      roomId,
      req.session.userId,
    ]);
    res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[rooms/:id/leave POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

async function requireModerator(roomId, userId) {
  const role = await getMemberRole(roomId, userId);
  return role === 'owner' || role === 'moderator';
}

router.post('/:id/kick', requireAuth, async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const targetUserId = Number((req.body || {}).userId);
    if (!Number.isInteger(roomId) || !Number.isInteger(targetUserId)) {
      return res.status(400).json({ error: '不正なパラメータです' });
    }
    if (!(await requireModerator(roomId, req.session.userId))) {
      return res.status(403).json({ error: 'Kickする権限がありません' });
    }
    const targetRole = await getMemberRole(roomId, targetUserId);
    if (targetRole === 'owner') return res.status(403).json({ error: 'オーナーをKickすることはできません' });

    await db.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [
      roomId,
      targetUserId,
    ]);
    await db.query('INSERT INTO admin_logs (admin_id, action, target, detail) VALUES ($1, $2, $3, $4)', [
      req.session.userId,
      'room_kick',
      'room:' + roomId,
      JSON.stringify({ targetUserId }),
    ]);
    res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[rooms/:id/kick POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/:id/ban', requireAuth, async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const { userId, reason } = req.body || {};
    const targetUserId = Number(userId);
    if (!Number.isInteger(roomId) || !Number.isInteger(targetUserId)) {
      return res.status(400).json({ error: '不正なパラメータです' });
    }
    if (!(await requireModerator(roomId, req.session.userId))) {
      return res.status(403).json({ error: 'BANする権限がありません' });
    }
    const targetRole = await getMemberRole(roomId, targetUserId);
    if (targetRole === 'owner') return res.status(403).json({ error: 'オーナーをBANすることはできません' });

    await db.query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [
      roomId,
      targetUserId,
    ]);
    await db.query(
      `INSERT INTO room_bans (room_id, user_id, banned_by, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_id, user_id) DO UPDATE SET banned_by = $3, reason = $4, created_at = NOW(), lifted_at = NULL`,
      [roomId, targetUserId, req.session.userId, typeof reason === 'string' ? reason.slice(0, 300) : null]
    );
    await db.query('INSERT INTO admin_logs (admin_id, action, target, detail) VALUES ($1, $2, $3, $4)', [
      req.session.userId,
      'room_ban',
      'room:' + roomId,
      JSON.stringify({ targetUserId, reason }),
    ]);
    res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[rooms/:id/ban POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/:id/unban', requireAuth, async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const targetUserId = Number((req.body || {}).userId);
    if (!Number.isInteger(roomId) || !Number.isInteger(targetUserId)) {
      return res.status(400).json({ error: '不正なパラメータです' });
    }
    if (!(await requireModerator(roomId, req.session.userId))) {
      return res.status(403).json({ error: 'BAN解除する権限がありません' });
    }
    await db.query(
      'UPDATE room_bans SET lifted_at = NOW() WHERE room_id = $1 AND user_id = $2 AND lifted_at IS NULL',
      [roomId, targetUserId]
    );
    await db.query('INSERT INTO admin_logs (admin_id, action, target, detail) VALUES ($1, $2, $3, $4)', [
      req.session.userId,
      'room_unban',
      'room:' + roomId,
      JSON.stringify({ targetUserId }),
    ]);
    res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[rooms/:id/unban POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.get('/:id/messages', requireAuth, async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    if (!Number.isInteger(roomId)) return res.status(400).json({ error: '不正なIDです' });
    if (!(await getMemberRole(roomId, req.session.userId))) {
      return res.status(403).json({ error: 'このルームのメンバーではありません' });
    }
    const beforeId = req.query.before ? Number(req.query.before) : null;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const params = [roomId];
    let whereBefore = '';
    if (Number.isInteger(beforeId)) {
      params.push(beforeId);
      whereBefore = `AND rm.id < $${params.length}`;
    }
    params.push(limit);
    const result = await db.query(
      `SELECT rm.*, u.username, u.display_name, u.avatar_url
       FROM room_messages rm JOIN users u ON u.id = rm.user_id
       WHERE rm.room_id = $1 ${whereBefore}
       ORDER BY rm.id DESC LIMIT $${params.length}`,
      params
    );
    res.json({ messages: result.rows.map(publicRoomMessage).reverse() });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[rooms/:id/messages GET]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/:id/messages', requireAuth, async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    if (!Number.isInteger(roomId)) return res.status(400).json({ error: '不正なIDです' });
    if (!(await getMemberRole(roomId, req.session.userId))) {
      return res.status(403).json({ error: 'このルームのメンバーではありません' });
    }
    const { content, imageUrl, replyTo } = req.body || {};
    const safeContent =
      typeof content === 'string' && content.trim() ? content.trim().slice(0, MAX_CONTENT_LENGTH) : null;
    const safeImageUrl =
      typeof imageUrl === 'string' && imageUrl.startsWith('/uploads/') ? imageUrl : null;
    const safeReplyTo = Number.isInteger(Number(replyTo)) && replyTo ? Number(replyTo) : null;
    if (!safeContent && !safeImageUrl) {
      return res.status(400).json({ error: 'メッセージ内容または画像を指定してください' });
    }
    const result = await db.query(
      `INSERT INTO room_messages (room_id, user_id, content, image_url, reply_to)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [roomId, req.session.userId, safeContent, safeImageUrl, safeReplyTo]
    );
    const withUser = await db.query(
      `SELECT rm.*, u.username, u.display_name, u.avatar_url
       FROM room_messages rm JOIN users u ON u.id = rm.user_id WHERE rm.id = $1`,
      [result.rows[0].id]
    );
    const message = publicRoomMessage(withUser.rows[0]);
    bus.emit('message:new', { scope: 'room', roomId, message });
    res.status(201).json({ message });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[rooms/:id/messages POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.delete('/messages/:id', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    if (!Number.isInteger(messageId)) return res.status(400).json({ error: '不正なIDです' });
    const result = await db.query('SELECT * FROM room_messages WHERE id = $1', [messageId]);
    const message = result.rows[0];
    if (!message) return res.status(404).json({ error: 'メッセージが見つかりません' });

    const role = await getMemberRole(message.room_id, req.session.userId);
    const canDelete =
      message.user_id === req.session.userId ||
      role === 'owner' ||
      role === 'moderator' ||
      isAdminUser(req.session.user);
    if (!canDelete) return res.status(403).json({ error: '削除する権限がありません' });

    await db.query('UPDATE room_messages SET deleted = TRUE WHERE id = $1', [messageId]);
    bus.emit('message:deleted', { scope: 'room', roomId: message.room_id, messageId });
    res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[rooms/messages DELETE]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

module.exports = router;
