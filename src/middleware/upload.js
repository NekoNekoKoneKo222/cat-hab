'use strict';

const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

const ALLOWED_MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // ユーザー入力のファイル名は一切使用しない(パストラバーサル対策)。
    // 拡張子はMIMEタイプから安全なものだけを付与する。
    const ext = ALLOWED_MIME_TO_EXT[file.mimetype] || '';
    const randomName = crypto.randomBytes(24).toString('hex');
    cb(null, randomName + ext);
  },
});

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME_TO_EXT[file.mimetype]) {
    return cb(new Error('許可されていないファイル形式です(jpeg/png/gif/webpのみ)'));
  }
  return cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
});

module.exports = { upload, UPLOAD_DIR, MAX_FILE_SIZE };
