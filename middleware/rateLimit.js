'use strict';

// 依存追加を避けるための軽量インメモリレートリミッタ。
// 単一プロセス前提(Cat Hubは1 Web Serviceとして動作するためこれで十分)。

function createRateLimiter({ windowMs, max, keyFn, message }) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits.entries()) {
      if (now - entry.windowStart > windowMs) hits.delete(key);
    }
  }, windowMs).unref();

  return function rateLimitMiddleware(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { count: 0, windowStart: now };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: message || 'リクエストが多すぎます。しばらく待ってから再試行してください' });
    }
    return next();
  };
}

module.exports = { createRateLimiter };
