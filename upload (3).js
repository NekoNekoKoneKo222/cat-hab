'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const uploadRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyFn: (req) => `upload:${req.session.userId}`,
  message: 'アップロードが多すぎます。しばらく待ってから再試行してください',
});

router.post('/image', requireAuth, uploadRateLimit, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? 'ファイルサイズが大きすぎます(上限8MB)' : err.message;
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      return res.status(400).json({ error: '画像ファイルが指定されていません' });
    }
    return res.status(201).json({ url: '/uploads/' + req.file.filename });
  });
});

module.exports = router;
