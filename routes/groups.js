'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

async function getMemberRole(groupId, userId) {
  const result = await db.query(
    'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return result.rows[0] ? result.rows[0].role : null;
}

router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, description } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'グループ名を入力してください' });
    }
    const safeName = name.trim().slice(0, 64);
    const safeDesc = typeof description === 'string' ? description.trim().slice(0, 500) : null;

    const result = await db.query(
      'INSERT INTO groups (name, description, owner_id) VALUES ($1, $2, $3) RETURNING id',
      [safeName, safeDesc, req.session.userId]
    );
    const groupId = result.rows[0].id;
    await db.query(
      "INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')",
      [groupId, req.session.userId]
    );

    res.status(201).json({ id: groupId, name: safeName, description: safeDesc });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[groups POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT g.id, g.name, g.description, g.owner_id, gm.role,
              (SELECT COUNT(*)::int FROM group_members WHERE group_id = g.id) as member_count
       FROM groups g JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = $1
       ORDER BY g.created_at DESC`,
      [req.session.userId]
    );
    res.json({ groups: result.rows });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[groups GET]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!Number.isInteger(groupId)) return res.status(400).json({ error: '不正なIDです' });

    const role = await getMemberRole(groupId, req.session.userId);
    if (!role) return res.status(403).json({ error: 'このグループのメンバーではありません' });

    const group = await db.query('SELECT * FROM groups WHERE id = $1', [groupId]);
    if (group.rows.length === 0) return res.status(404).json({ error: 'グループが見つかりません' });

    const members = await db.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, gm.role
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1 ORDER BY gm.role, u.display_name`,
      [groupId]
    );

    res.json({ group: group.rows[0], members: members.rows, myRole: role });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[groups/:id GET]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/:id/members', requireAuth, async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!Number.isInteger(groupId)) return res.status(400).json({ error: '不正なIDです' });

    const role = await getMemberRole(groupId, req.session.userId);
    if (!role || !['owner', 'moderator'].includes(role)) {
      return res.status(403).json({ error: 'メンバーを追加する権限がありません' });
    }

    const { username } = req.body || {};
    if (typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'ユーザー名を指定してください' });
    }
    const targetResult = await db.query('SELECT id FROM users WHERE username = $1', [username.trim()]);
    const target = targetResult.rows[0];
    if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });

    const existing = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, target.id]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: '既にメンバーです' });
    }

    await db.query(
      "INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')",
      [groupId, target.id]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[groups/:id/members POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.delete('/:id/members/:userId', requireAuth, async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    const targetUserId = Number(req.params.userId);
    if (!Number.isInteger(groupId) || !Number.isInteger(targetUserId)) {
      return res.status(400).json({ error: '不正なIDです' });
    }

    const role = await getMemberRole(groupId, req.session.userId);
    const isSelf = targetUserId === req.session.userId;
    if (!isSelf && !(role && ['owner', 'moderator'].includes(role))) {
      return res.status(403).json({ error: 'この操作を行う権限がありません' });
    }
    const targetRole = await getMemberRole(groupId, targetUserId);
    if (targetRole === 'owner' && !isSelf) {
      return res.status(403).json({ error: 'オーナーを削除することはできません' });
    }

    await db.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [
      groupId,
      targetUserId,
    ]);
    res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[groups/:id/members DELETE]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!Number.isInteger(groupId)) return res.status(400).json({ error: '不正なIDです' });

    const group = await db.query('SELECT owner_id FROM groups WHERE id = $1', [groupId]);
    if (group.rows.length === 0) return res.status(404).json({ error: 'グループが見つかりません' });
    if (group.rows[0].owner_id !== req.session.userId) {
      return res.status(403).json({ error: 'オーナーのみ削除できます' });
    }

    await db.query('DELETE FROM groups WHERE id = $1', [groupId]);
    res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[groups/:id DELETE]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

module.exports = router;
