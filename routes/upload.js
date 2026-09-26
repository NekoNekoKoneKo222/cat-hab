'use strict';

const express = require('express');
const fs = require('fs/promises');
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
  upload.single('image')(req, res, async (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? 'ファイルサイズが大きすぎます(上限8MB)' : err.message;
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      return res.status(400).json({ error: '画像ファイルが指定されていません' });
    }
    const data = await fs.readFile(req.file.path).catch(() => Buffer.alloc(0));
    const hex = data.subarray(0,12).toString('hex');
    const valid = req.file.mimetype==='image/png' ? hex.startsWith('89504e470d0a1a0a') :
      req.file.mimetype==='image/jpeg' ? hex.startsWith('ffd8ff') :
      req.file.mimetype==='image/gif' ? hex.startsWith('474946383761')||hex.startsWith('474946383961') :
      req.file.mimetype==='image/webp' ? data.toString('ascii',0,4)==='RIFF' && data.toString('ascii',8,12)==='WEBP' : false;
    if(!valid){await fs.unlink(req.file.path).catch(()=>{});return res.status(400).json({error:'画像形式が正しくありません'});}
    return res.status(201).json({ url: '/uploads/' + req.file.filename });
  });
});

module.exports = router;
