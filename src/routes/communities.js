'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth, isAdminUser } = require('../middleware/auth');
const bus = require('../utils/events');

const router = express.Router();
const MAX_CONTENT_LENGTH = 2000;

function publicChannelMessage(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
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

// --- コミュニティ ---
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, description } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'コミュニティ名を入力してください' });
    }
    const result = await db.query(
      'INSERT INTO communities (name, description, owner_id) VALUES ($1, $2, $3) RETURNING id, name, description',
      [name.trim().slice(0, 64), typeof description === 'string' ? description.trim().slice(0, 500) : null, req.session.userId]
    );
    // 作成時に「雑談」チャンネルを1つ自動作成する
    await db.query('INSERT INTO channels (community_id, name, topic) VALUES ($1, $2, $3)', [
      result.rows[0].id,
      '雑談',
      null,
    ]);
    res.status(201).json({ community: result.rows[0] });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[communities POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

// コミュニティは公開一覧(全ログインユーザーが閲覧可能)
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.name, c.description, c.owner_id,
              (SELECT COUNT(*)::int FROM channels WHERE community_id = c.id) as channel_count
       FROM communities c ORDER BY c.created_at DESC`
    );
    res.json({ communities: result.rows });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[communities GET]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const communityId = Number(req.params.id);
    if (!Number.isInteger(communityId)) return res.status(400).json({ error: '不正なIDです' });
    const community = await db.query('SELECT owner_id FROM communities WHERE id = $1', [communityId]);
    if (community.rows.length === 0) return res.status(404).json({ error: '見つかりません' });
    if (community.rows[0].owner_id !== req.session.userId && !isAdminUser(req.session.user)) {
      return res.status(403).json({ error: 'オーナーまたは管理者のみ削除できます' });
    }
    await db.query('DELETE FROM communities WHERE id = $1', [communityId]);
    res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[communities DELETE]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

// --- チャンネル ---
router.get('/:id/channels', requireAuth, async (req, res) => {
  try {
    const communityId = Number(req.params.id);
    if (!Number.isInteger(communityId)) return res.status(400).json({ error: '不正なIDです' });
    const result = await db.query(
      'SELECT id, name, topic FROM channels WHERE community_id = $1 ORDER BY id',
      [communityId]
    );
    res.json({ channels: result.rows });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[communities/:id/channels GET]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/:id/channels', requireAuth, async (req, res) => {
  try {
    const communityId = Number(req.params.id);
    if (!Number.isInteger(communityId)) return res.status(400).json({ error: '不正なIDです' });
    const community = await db.query('SELECT owner_id FROM communities WHERE id = $1', [communityId]);
    if (community.rows.length === 0) return res.status(404).json({ error: '見つかりません' });
    if (community.rows[0].owner_id !== req.session.userId && !isAdminUser(req.session.user)) {
      return res.status(403).json({ error: 'オーナーまたは管理者のみチャンネルを作成できます' });
    }
    const { name, topic } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'チャンネル名を入力してください' });
    }
    const result = await db.query(
      'INSERT INTO channels (community_id, name, topic) VALUES ($1, $2, $3) RETURNING id, name, topic',
      [communityId, name.trim().slice(0, 64), typeof topic === 'string' ? topic.trim().slice(0, 200) : null]
    );
    res.status(201).json({ channel: result.rows[0] });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[communities/:id/channels POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

// --- チャンネルメッセージ ---
router.get('/channels/:channelId/messages', requireAuth, async (req, res) => {
  try {
    const channelId = Number(req.params.channelId);
    if (!Number.isInteger(channelId)) return res.status(400).json({ error: '不正なIDです' });

    const beforeId = req.query.before ? Number(req.query.before) : null;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const params = [channelId];
    let whereBefore = '';
    if (Number.isInteger(beforeId)) {
      params.push(beforeId);
      whereBefore = `AND cm.id < $${params.length}`;
    }
    params.push(limit);

    const result = await db.query(
      `SELECT cm.*, u.username, u.display_name, u.avatar_url
       FROM channel_messages cm JOIN users u ON u.id = cm.user_id
       WHERE cm.channel_id = $1 ${whereBefore}
       ORDER BY cm.id DESC LIMIT $${params.length}`,
      params
    );
    res.json({ messages: result.rows.map(publicChannelMessage).reverse() });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[channels/:id/messages GET]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/channels/:channelId/messages', requireAuth, async (req, res) => {
  try {
    const channelId = Number(req.params.channelId);
    if (!Number.isInteger(channelId)) return res.status(400).json({ error: '不正なIDです' });

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
      `INSERT INTO channel_messages (channel_id, user_id, content, image_url, reply_to)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [channelId, req.session.userId, safeContent, safeImageUrl, safeReplyTo]
    );
    const withUser = await db.query(
      `SELECT cm.*, u.username, u.display_name, u.avatar_url
       FROM channel_messages cm JOIN users u ON u.id = cm.user_id WHERE cm.id = $1`,
      [result.rows[0].id]
    );
    const message = publicChannelMessage(withUser.rows[0]);
    bus.emit('message:new', { scope: 'channel', roomId: channelId, message });

    res.status(201).json({ message });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[channels/:id/messages POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.delete('/channels/messages/:id', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    if (!Number.isInteger(messageId)) return res.status(400).json({ error: '不正なIDです' });

    const result = await db.query(
      `SELECT cm.*, c.community_id, co.owner_id as community_owner_id
       FROM channel_messages cm
       JOIN channels c ON c.id = cm.channel_id
       JOIN communities co ON co.id = c.community_id
       WHERE cm.id = $1`,
      [messageId]
    );
    const message = result.rows[0];
    if (!message) return res.status(404).json({ error: 'メッセージが見つかりません' });

    const canDelete =
      message.user_id === req.session.userId ||
      message.community_owner_id === req.session.userId ||
      isAdminUser(req.session.user);
    if (!canDelete) return res.status(403).json({ error: '削除する権限がありません' });

    await db.query('UPDATE channel_messages SET deleted = TRUE WHERE id = $1', [messageId]);
    bus.emit('message:deleted', { scope: 'channel', roomId: message.channel_id, messageId });
    res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[channels/messages DELETE]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/channels/messages/:id/reactions', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    if (!Number.isInteger(messageId)) return res.status(400).json({ error: '不正なIDです' });
    const { emojiCode } = req.body || {};
    if (typeof emojiCode !== 'string' || !/^[a-zA-Z0-9_+-]{1,32}$/.test(emojiCode)) {
      return res.status(400).json({ error: '不正なリアクションです' });
    }
    const message = await db.query('SELECT channel_id FROM channel_messages WHERE id = $1', [messageId]);
    if (message.rows.length === 0) return res.status(404).json({ error: 'メッセージが見つかりません' });

    const existing = await db.query(
      'SELECT id FROM reactions WHERE channel_msg_id = $1 AND user_id = $2 AND emoji_code = $3',
      [messageId, req.session.userId, emojiCode]
    );
    let action;
    if (existing.rows.length > 0) {
      await db.query('DELETE FROM reactions WHERE id = $1', [existing.rows[0].id]);
      action = 'removed';
    } else {
      await db.query(
        'INSERT INTO reactions (channel_msg_id, user_id, emoji_code) VALUES ($1, $2, $3)',
        [messageId, req.session.userId, emojiCode]
      );
      action = 'added';
    }
    bus.emit('reaction:update', {
      scope: 'channel',
      roomId: message.rows[0].channel_id,
      messageId,
      userId: req.session.userId,
      emojiCode,
      action,
    });
    res.json({ ok: true, action });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[channels/messages/reactions POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

module.exports = router;
