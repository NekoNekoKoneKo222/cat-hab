'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { createNotification } = require('../utils/notify');
const bus = require('../utils/events');

const router = express.Router();

const MAX_CONTENT_LENGTH = 2000;

async function isMember(roomId, userId) {
  const result = await db.query(
    'SELECT 1 FROM dm_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId]
  );
  return result.rows.length > 0;
}

function publicMessage(row) {
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

// 1:1 DMルームを取得(なければ作成)
router.post('/rooms', requireAuth, async (req, res) => {
  try {
    const { userId } = req.body || {};
    const targetId = Number(userId);
    if (!Number.isInteger(targetId)) return res.status(400).json({ error: '不正なユーザーIDです' });
    if (targetId === req.session.userId) {
      return res.status(400).json({ error: '自分自身とのDMルームは作成できません' });
    }

    const targetUser = await db.query('SELECT id FROM users WHERE id = $1', [targetId]);
    if (targetUser.rows.length === 0) return res.status(404).json({ error: 'ユーザーが見つかりません' });

    const existing = await db.query(
      `SELECT r.id FROM dm_rooms r
       JOIN dm_members m1 ON m1.room_id = r.id AND m1.user_id = $1
       JOIN dm_members m2 ON m2.room_id = r.id AND m2.user_id = $2
       WHERE r.is_group = FALSE
       LIMIT 1`,
      [req.session.userId, targetId]
    );
    if (existing.rows.length > 0) {
      return res.json({ roomId: existing.rows[0].id, created: false });
    }

    const roomResult = await db.query(
      'INSERT INTO dm_rooms (is_group, created_by) VALUES (FALSE, $1) RETURNING id',
      [req.session.userId]
    );
    const roomId = roomResult.rows[0].id;
    await db.query('INSERT INTO dm_members (room_id, user_id) VALUES ($1, $2), ($1, $3)', [
      roomId,
      req.session.userId,
      targetId,
    ]);

    res.status(201).json({ roomId, created: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dm/rooms POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

// グループDMルームを作成
router.post('/rooms/group', requireAuth, async (req, res) => {
  try {
    const { name, memberIds } = req.body || {};
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({ error: 'メンバーを1人以上指定してください' });
    }
    const ids = [...new Set(memberIds.map(Number).filter(Number.isInteger))].filter(
      (id) => id !== req.session.userId
    );
    if (ids.length === 0) return res.status(400).json({ error: '有効なメンバーがいません' });

    const safeName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 64) : null;

    const roomResult = await db.query(
      'INSERT INTO dm_rooms (is_group, name, created_by) VALUES (TRUE, $1, $2) RETURNING id',
      [safeName, req.session.userId]
    );
    const roomId = roomResult.rows[0].id;

    const allMembers = [req.session.userId, ...ids];
    const values = allMembers.map((_, i) => `($1, $${i + 2})`).join(', ');
    await db.query(`INSERT INTO dm_members (room_id, user_id) VALUES ${values}`, [
      roomId,
      ...allMembers,
    ]);

    res.status(201).json({ roomId });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dm/rooms/group POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

// 自分が参加しているDMルーム一覧
router.get('/rooms', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.id, r.is_group, r.name,
              (SELECT content FROM messages WHERE room_id = r.id AND deleted = FALSE ORDER BY created_at DESC LIMIT 1) as last_content,
              (SELECT created_at FROM messages WHERE room_id = r.id ORDER BY created_at DESC LIMIT 1) as last_at
       FROM dm_rooms r
       JOIN dm_members m ON m.room_id = r.id
       WHERE m.user_id = $1
       ORDER BY last_at DESC NULLS LAST, r.created_at DESC`,
      [req.session.userId]
    );

    const rooms = [];
    for (const row of result.rows) {
      const members = await db.query(
        `SELECT u.id, u.username, u.display_name, u.avatar_url
         FROM dm_members m JOIN users u ON u.id = m.user_id
         WHERE m.room_id = $1`,
        [row.id]
      );
      rooms.push({
        id: row.id,
        isGroup: row.is_group,
        name: row.name,
        lastMessage: row.last_content,
        lastAt: row.last_at,
        members: members.rows.map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.display_name,
          avatarUrl: u.avatar_url,
        })),
      });
    }

    res.json({ rooms });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dm/rooms GET]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

// ルーム内のメッセージ一覧(ページネーション: beforeId指定で過去分取得)
router.get('/rooms/:id/messages', requireAuth, async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    if (!Number.isInteger(roomId)) return res.status(400).json({ error: '不正なIDです' });
    if (!(await isMember(roomId, req.session.userId))) {
      return res.status(403).json({ error: 'このルームのメンバーではありません' });
    }

    const beforeId = req.query.before ? Number(req.query.before) : null;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

    const params = [roomId];
    let whereBefore = '';
    if (Number.isInteger(beforeId)) {
      params.push(beforeId);
      whereBefore = `AND m.id < $${params.length}`;
    }
    params.push(limit);

    const result = await db.query(
      `SELECT m.*, u.username, u.display_name, u.avatar_url
       FROM messages m JOIN users u ON u.id = m.user_id
       WHERE m.room_id = $1 ${whereBefore}
       ORDER BY m.id DESC
       LIMIT $${params.length}`,
      params
    );

    res.json({ messages: result.rows.map(publicMessage).reverse() });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dm/messages GET]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

// メッセージ送信
router.post('/rooms/:id/messages', requireAuth, async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    if (!Number.isInteger(roomId)) return res.status(400).json({ error: '不正なIDです' });
    if (!(await isMember(roomId, req.session.userId))) {
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
      `INSERT INTO messages (room_id, user_id, content, image_url, reply_to)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [roomId, req.session.userId, safeContent, safeImageUrl, safeReplyTo]
    );

    const withUser = await db.query(
      `SELECT m.*, u.username, u.display_name, u.avatar_url
       FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = $1`,
      [result.rows[0].id]
    );
    const message = publicMessage(withUser.rows[0]);

    bus.emit('message:new', { scope: 'dm', roomId, message });

    // 他のメンバーへ通知
    const members = await db.query('SELECT user_id FROM dm_members WHERE room_id = $1', [roomId]);
    for (const m of members.rows) {
      if (m.user_id !== req.session.userId) {
        await createNotification(m.user_id, 'dm_message', {
          roomId,
          fromUserId: req.session.userId,
          fromUsername: req.session.user.username,
          preview: safeContent ? safeContent.slice(0, 60) : '(画像)',
        });
      }
    }

    res.status(201).json({ message });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dm/messages POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

// メッセージ削除(自分の投稿のみ、論理削除)
router.delete('/messages/:id', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    if (!Number.isInteger(messageId)) return res.status(400).json({ error: '不正なIDです' });

    const result = await db.query('SELECT * FROM messages WHERE id = $1', [messageId]);
    const message = result.rows[0];
    if (!message) return res.status(404).json({ error: 'メッセージが見つかりません' });
    if (message.user_id !== req.session.userId) {
      return res.status(403).json({ error: '自分の投稿のみ削除できます' });
    }

    await db.query('UPDATE messages SET deleted = TRUE WHERE id = $1', [messageId]);
    bus.emit('message:deleted', { scope: 'dm', roomId: message.room_id, messageId });

    res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dm/messages DELETE]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

// リアクション(トグル式: 同じ絵文字コードなら解除)
router.post('/messages/:id/reactions', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    if (!Number.isInteger(messageId)) return res.status(400).json({ error: '不正なIDです' });
    const { emojiCode } = req.body || {};
    if (typeof emojiCode !== 'string' || !/^[a-zA-Z0-9_+-]{1,32}$/.test(emojiCode)) {
      return res.status(400).json({ error: '不正なリアクションです' });
    }

    const messageResult = await db.query('SELECT * FROM messages WHERE id = $1', [messageId]);
    const message = messageResult.rows[0];
    if (!message) return res.status(404).json({ error: 'メッセージが見つかりません' });
    if (!(await isMember(message.room_id, req.session.userId))) {
      return res.status(403).json({ error: 'このルームのメンバーではありません' });
    }

    const existing = await db.query(
      'SELECT id FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji_code = $3',
      [messageId, req.session.userId, emojiCode]
    );

    let action;
    if (existing.rows.length > 0) {
      await db.query('DELETE FROM reactions WHERE id = $1', [existing.rows[0].id]);
      action = 'removed';
    } else {
      await db.query(
        'INSERT INTO reactions (message_id, user_id, emoji_code) VALUES ($1, $2, $3)',
        [messageId, req.session.userId, emojiCode]
      );
      action = 'added';
    }

    bus.emit('reaction:update', {
      scope: 'dm',
      roomId: message.room_id,
      messageId,
      userId: req.session.userId,
      emojiCode,
      action,
    });

    res.json({ ok: true, action });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dm/reactions POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

// メッセージのリアクション一覧取得
router.get('/messages/:id/reactions', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    if (!Number.isInteger(messageId)) return res.status(400).json({ error: '不正なIDです' });

    const result = await db.query(
      `SELECT emoji_code, COUNT(*)::int as count, ARRAY_AGG(user_id) as user_ids
       FROM reactions WHERE message_id = $1 GROUP BY emoji_code`,
      [messageId]
    );
    res.json({ reactions: result.rows });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dm/reactions GET]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

module.exports = router;
