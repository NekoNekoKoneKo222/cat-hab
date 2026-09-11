'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';

    const conditions = [];
    const params = [];
    if (q) {
      params.push('%' + q + '%');
      conditions.push(`title ILIKE $${params.length}`);
    }
    if (category) {
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await db.query(
      `SELECT g.*,
              COALESCE((SELECT AVG(rating) FROM game_ratings WHERE game_id = g.id), 0) as avg_rating,
              (SELECT COUNT(*)::int FROM game_ratings WHERE game_id = g.id) as rating_count,
              (SELECT COUNT(*)::int FROM game_favorites WHERE game_id = g.id AND user_id = $${params.length + 1}) as is_favorited
       FROM games g ${where}
       ORDER BY g.created_at DESC`,
      [...params, req.session.userId]
    );

    res.json({
      games: result.rows.map((g) => ({
        id: g.id,
        title: g.title,
        description: g.description,
        category: g.category,
        url: g.url,
        thumbnailUrl: g.thumbnail_url,
        avgRating: Number(g.avg_rating),
        ratingCount: g.rating_count,
        isFavorited: g.is_favorited > 0,
      })),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[games GET]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.get('/favorites', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT g.* FROM games g
       JOIN game_favorites f ON f.game_id = g.id
       WHERE f.user_id = $1 ORDER BY f.created_at DESC`,
      [req.session.userId]
    );
    res.json({ games: result.rows });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[games/favorites GET]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.get('/history', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT g.*, h.played_at FROM game_history h
       JOIN games g ON g.id = h.game_id
       WHERE h.user_id = $1 ORDER BY h.played_at DESC LIMIT 50`,
      [req.session.userId]
    );
    res.json({ history: result.rows });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[games/history GET]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const gameId = Number(req.params.id);
    if (!Number.isInteger(gameId)) return res.status(400).json({ error: '不正なIDです' });

    const gameResult = await db.query('SELECT * FROM games WHERE id = $1', [gameId]);
    const game = gameResult.rows[0];
    if (!game) return res.status(404).json({ error: 'ゲームが見つかりません' });

    const comments = await db.query(
      `SELECT c.id, c.content, c.created_at, u.username, u.display_name, u.avatar_url
       FROM game_comments c JOIN users u ON u.id = c.user_id
       WHERE c.game_id = $1 ORDER BY c.created_at DESC LIMIT 50`,
      [gameId]
    );
    const ratingResult = await db.query(
      'SELECT AVG(rating)::float as avg, COUNT(*)::int as count FROM game_ratings WHERE game_id = $1',
      [gameId]
    );
    const myRatingResult = await db.query(
      'SELECT rating FROM game_ratings WHERE game_id = $1 AND user_id = $2',
      [gameId, req.session.userId]
    );
    const favResult = await db.query(
      'SELECT 1 FROM game_favorites WHERE game_id = $1 AND user_id = $2',
      [gameId, req.session.userId]
    );

    res.json({
      game,
      comments: comments.rows,
      avgRating: ratingResult.rows[0].avg || 0,
      ratingCount: ratingResult.rows[0].count,
      myRating: myRatingResult.rows[0] ? myRatingResult.rows[0].rating : null,
      isFavorited: favResult.rows.length > 0,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[games/:id GET]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/:id/favorite', requireAuth, async (req, res) => {
  try {
    const gameId = Number(req.params.id);
    if (!Number.isInteger(gameId)) return res.status(400).json({ error: '不正なIDです' });

    const existing = await db.query(
      'SELECT id FROM game_favorites WHERE game_id = $1 AND user_id = $2',
      [gameId, req.session.userId]
    );
    let favorited;
    if (existing.rows.length > 0) {
      await db.query('DELETE FROM game_favorites WHERE id = $1', [existing.rows[0].id]);
      favorited = false;
    } else {
      await db.query('INSERT INTO game_favorites (user_id, game_id) VALUES ($1, $2)', [
        req.session.userId,
        gameId,
      ]);
      favorited = true;
    }
    res.json({ ok: true, favorited });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[games/:id/favorite POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/:id/history', requireAuth, async (req, res) => {
  try {
    const gameId = Number(req.params.id);
    if (!Number.isInteger(gameId)) return res.status(400).json({ error: '不正なIDです' });
    const game = await db.query('SELECT id FROM games WHERE id = $1', [gameId]);
    if (game.rows.length === 0) return res.status(404).json({ error: 'ゲームが見つかりません' });

    await db.query('INSERT INTO game_history (user_id, game_id) VALUES ($1, $2)', [
      req.session.userId,
      gameId,
    ]);
    res.status(201).json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[games/:id/history POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/:id/rating', requireAuth, async (req, res) => {
  try {
    const gameId = Number(req.params.id);
    const rating = Number((req.body || {}).rating);
    if (!Number.isInteger(gameId)) return res.status(400).json({ error: '不正なIDです' });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: '評価は1〜5の整数で指定してください' });
    }
    await db.query(
      `INSERT INTO game_ratings (user_id, game_id, rating) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, game_id) DO UPDATE SET rating = $3, created_at = NOW()`,
      [req.session.userId, gameId, rating]
    );
    res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[games/:id/rating POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

router.post('/:id/comments', requireAuth, async (req, res) => {
  try {
    const gameId = Number(req.params.id);
    if (!Number.isInteger(gameId)) return res.status(400).json({ error: '不正なIDです' });
    const { content } = req.body || {};
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'コメント内容を入力してください' });
    }
    const result = await db.query(
      'INSERT INTO game_comments (user_id, game_id, content) VALUES ($1, $2, $3) RETURNING id, content, created_at',
      [req.session.userId, gameId, content.trim().slice(0, 1000)]
    );
    res.status(201).json({
      comment: {
        ...result.rows[0],
        username: req.session.user.username,
        display_name: req.session.user.displayName,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[games/:id/comments POST]', err.message);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
});

module.exports = router;
