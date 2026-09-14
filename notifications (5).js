'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const result = await db.query(
      `SELECT id, type, payload, is_read, created_at
       FROM notifications WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [req.session.userId, limit]
    );
    const unreadResult = await db.query(
      'SELECT COUNT(*)::int as count FROM notifications WHERE user_id = $1 AND is_read = FALSE',
      [req.session.userId]
    );
    res.json({ notifications: result.rows, unreadCount: unreadResult.rows[0].count });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notifications GET]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/:id/read', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '不正なIDです' });
    await db.query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [
      id,
      req.session.userId,
    ]);
    res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notifications read]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/read-all', requireAuth, async (req, res) => {
  try {
    await db.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE', [
      req.session.userId,
    ]);
    res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notifications read-all]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

module.exports = router;
