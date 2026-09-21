'use strict';

const path = require('path');
const express = require('express');

const app = express();
const rootDir = path.resolve(__dirname, '..');
const port = Number.parseInt(process.env.PORT || '3000', 10);
const host = '0.0.0.0';

app.disable('x-powered-by');

// Render uses this endpoint to decide whether the service is healthy.
app.get('/healthz', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'cat-hub',
    mode: 'ui-prototype'
  });
});

// Only expose the public UI assets, never the repository root.
app.use('/ui', express.static(path.join(rootDir, 'ui'), {
  index: false,
  fallthrough: false,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

const pages = new Set([
  'index.html',
  'cattube.html',
  'cloudcat.html',
  'playcat.html',
  'proxy.html',
  'admin.html',
  'login.html',
  'register.html'
]);

app.get('/', (_req, res) => {
  res.sendFile(path.join(rootDir, 'index.html'));
});

app.get('/:page', (req, res, next) => {
  if (!pages.has(req.params.page)) return next();
  return res.sendFile(path.join(rootDir, req.params.page));
});

app.use((_req, res) => {
  res.status(404).type('html').send(
    '<!doctype html><html lang="ja"><meta charset="utf-8">' +
    '<title>404 | Cat Hub</title><body style="font-family:system-ui;background:#0b1020;color:#fff;padding:40px">' +
    '<h1>404</h1><p>ページが見つかりません。</p><a style="color:#6c8cff" href="/">Cat Hubへ戻る</a></body></html>'
  );
});

const server = app.listen(port, host, () => {
  console.log(`Cat Hub listening on http://${host}:${port}`);
});

function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  server.close((error) => {
    if (error) {
      console.error('Shutdown failed:', error);
      process.exit(1);
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
