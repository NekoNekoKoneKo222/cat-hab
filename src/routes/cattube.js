'use strict';

const express = require('express');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const YT_BASE = 'https://www.googleapis.com/youtube/v3';

const searchRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyFn: (req) => `cattube:${req.session.userId}`,
  message: 'リクエストが多すぎます。しばらく待ってから再試行してください',
});

function requireApiKey(req, res, next) {
  if (!config.youtubeApiKey) {
    return res.status(503).json({
      error: 'Cat Tube機能は現在利用できません(YOUTUBE_API_KEYが設定されていません)',
    });
  }
  return next();
}

async function callYoutubeApi(path, params) {
  const url = new URL(YT_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('key', config.youtubeApiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const message = (data && data.error && data.error.message) || 'YouTube APIエラー';
      const err = new Error(message);
      err.status = res.status >= 400 && res.status < 500 ? 502 : 502;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

router.get('/search', requireAuth, requireApiKey, searchRateLimit, async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) return res.status(400).json({ error: '検索キーワードを入力してください' });
    if (q.length > 100) return res.status(400).json({ error: '検索キーワードが長すぎます' });

    const data = await callYoutubeApi('/search', {
      part: 'snippet',
      type: 'video',
      maxResults: '24',
      q,
      safeSearch: 'moderate',
    });

    const items = (data.items || []).map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      channelTitle: item.snippet.channelTitle,
      channelId: item.snippet.channelId,
      publishedAt: item.snippet.publishedAt,
      thumbnail: item.snippet.thumbnails && (item.snippet.thumbnails.medium || item.snippet.thumbnails.default),
    }));

    res.json({ items });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[cattube/search]', err.message);
    res.status(err.status || 500).json({ error: '検索に失敗しました: ' + err.message });
  }
});

router.get('/video/:id', requireAuth, requireApiKey, async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^[a-zA-Z0-9_-]{5,20}$/.test(id)) {
      return res.status(400).json({ error: '不正な動画IDです' });
    }
    const data = await callYoutubeApi('/videos', {
      part: 'snippet,statistics,contentDetails',
      id,
    });
    const video = (data.items || [])[0];
    if (!video) return res.status(404).json({ error: '動画が見つかりません' });

    res.json({
      video: {
        videoId: video.id,
        title: video.snippet.title,
        description: video.snippet.description,
        channelTitle: video.snippet.channelTitle,
        channelId: video.snippet.channelId,
        publishedAt: video.snippet.publishedAt,
        viewCount: video.statistics ? video.statistics.viewCount : null,
        likeCount: video.statistics ? video.statistics.likeCount : null,
        thumbnail: video.snippet.thumbnails && (video.snippet.thumbnails.medium || video.snippet.thumbnails.default),
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[cattube/video]', err.message);
    res.status(err.status || 500).json({ error: '動画情報の取得に失敗しました: ' + err.message });
  }
});

router.get('/channel/:id', requireAuth, requireApiKey, async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^[a-zA-Z0-9_-]{5,32}$/.test(id)) {
      return res.status(400).json({ error: '不正なチャンネルIDです' });
    }
    const data = await callYoutubeApi('/channels', {
      part: 'snippet,statistics',
      id,
    });
    const channel = (data.items || [])[0];
    if (!channel) return res.status(404).json({ error: 'チャンネルが見つかりません' });

    res.json({
      channel: {
        channelId: channel.id,
        title: channel.snippet.title,
        description: channel.snippet.description,
        thumbnail: channel.snippet.thumbnails && (channel.snippet.thumbnails.medium || channel.snippet.thumbnails.default),
        subscriberCount: channel.statistics ? channel.statistics.subscriberCount : null,
        videoCount: channel.statistics ? channel.statistics.videoCount : null,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[cattube/channel]', err.message);
    res.status(err.status || 500).json({ error: 'チャンネル情報の取得に失敗しました: ' + err.message });
  }
});

module.exports = router;
