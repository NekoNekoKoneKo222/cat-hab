'use strict';

const express = require('express');
const cheerio = require('cheerio');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const { validateOutboundUrl } = require('../utils/ssrfGuard');

const router = express.Router();

const proxyRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  keyFn: (req) => `proxy:${req.session.userId}`,
  message: 'Proxyへのリクエストが多すぎます。しばらく待ってから再試行してください',
});

// 転送してよい最小限のリクエストヘッダのみ許可(Cookie/Authorizationは転送しない)
function buildOutboundHeaders() {
  return {
    'User-Agent': 'CatHubProxy/1.0 (+safe-fetch)',
    Accept: 'text/html,application/xhtml+xml,image/*,*/*;q=0.8',
    'Accept-Language': 'ja,en;q=0.8',
  };
}

async function fetchWithSizeLimit(url, options, maxBytes) {
  const res = await fetch(url, options);
  const contentLength = res.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw Object.assign(new Error('サイズ制限を超えています'), { code: 'SIZE_LIMIT' });
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw Object.assign(new Error('サイズ制限を超えています'), { code: 'SIZE_LIMIT' });
    }
    return { res, buffer: buf };
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw Object.assign(new Error('サイズ制限を超えています'), { code: 'SIZE_LIMIT' });
    }
    chunks.push(value);
  }
  return { res, buffer: Buffer.concat(chunks.map((c) => Buffer.from(c))) };
}

/**
 * SSRF検証込みでURLを取得する。リダイレクトは手動で辿り、
 * 遷移先ごとに毎回allowlist + DNS再検証を行う。
 */
async function safeFetch(targetUrl, allowlist) {
  let currentUrl = targetUrl;
  for (let hop = 0; hop <= config.proxy.maxRedirects; hop += 1) {
    const validation = await validateOutboundUrl(currentUrl, allowlist);
    if (!validation.ok) {
      const err = new Error(validation.reason);
      err.code = 'SSRF_BLOCKED';
      throw err;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.proxy.timeoutMs);
    let result;
    try {
      result = await fetchWithSizeLimit(
        currentUrl,
        {
          headers: buildOutboundHeaders(),
          redirect: 'manual',
          signal: controller.signal,
        },
        config.proxy.maxBytes
      );
    } catch (err) {
      if (err.name === 'AbortError') {
        const e = new Error('タイムアウトしました');
        e.code = 'TIMEOUT';
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const { res, buffer } = result;

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) {
        const err = new Error('リダイレクト先が不明です');
        err.code = 'BAD_REDIRECT';
        throw err;
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue; // 次のループでリダイレクト先を再検証する
    }

    return { res, buffer, finalUrl: currentUrl };
  }

  const err = new Error('リダイレクトが多すぎます');
  err.code = 'TOO_MANY_REDIRECTS';
  throw err;
}

function rewriteHtml(html, baseUrl) {
  const $ = cheerio.load(html);

  // スクリプトは実行させない(サンドボックスiframe + CSPに加えた多層防御)
  $('script').remove();
  $('*').removeAttr('onclick').removeAttr('onload').removeAttr('onerror')
    .removeAttr('onmouseover').removeAttr('onfocus');

  function toProxyUrl(href) {
    try {
      const abs = new URL(href, baseUrl).toString();
      return '/api/proxy?url=' + encodeURIComponent(abs);
    } catch (err) {
      return null;
    }
  }
  function toAbsoluteUrl(href) {
    try {
      return new URL(href, baseUrl).toString();
    } catch (err) {
      return null;
    }
  }

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#')) return;
    if (href.trim().toLowerCase().startsWith('javascript:')) {
      $(el).removeAttr('href');
      return;
    }
    const proxied = toProxyUrl(href);
    if (proxied) $(el).attr('href', proxied);
    $(el).attr('target', '_self');
  });

  $('form[action]').each((_, el) => {
    const action = $(el).attr('action');
    if (action && action.trim().toLowerCase().startsWith('javascript:')) {
      $(el).removeAttr('action');
      return;
    }
    const proxied = action ? toProxyUrl(action) : null;
    if (proxied) $(el).attr('action', proxied);
    // POSTフォームは資格情報転送等のリスクがあるためGETのみ許容する
    $(el).attr('method', 'get');
  });

  // 画像・CSS・フォント等はクライアントのブラウザが直接取得する(サーバー側SSRFの対象外)。
  // サンドボックスiframeによりスクリプトは実行されないため、直接読み込んでも安全側に倒せる。
  ['img', 'source'].forEach((tag) => {
    $(tag + '[src]').each((_, el) => {
      const src = $(el).attr('src');
      const abs = src ? toAbsoluteUrl(src) : null;
      if (abs) $(el).attr('src', abs);
    });
  });
  $('link[href]').each((_, el) => {
    const href = $(el).attr('href');
    const abs = href ? toAbsoluteUrl(href) : null;
    if (abs) $(el).attr('href', abs);
  });

  // <base>タグは混乱を招くため除去(全リンクを絶対URL化済みのため不要)
  $('base').remove();

  return $.html();
}

router.get('/', requireAuth, proxyRateLimit, async (req, res) => {
  const targetUrl = req.query.url;
  if (typeof targetUrl !== 'string' || !targetUrl) {
    return res.status(400).json({ error: 'urlパラメータが必要です' });
  }

  if (config.allowedProxyHosts.length === 0) {
    return res.status(403).json({
      error: 'Proxy機能は管理者によって許可ホストが設定されるまで利用できません(ALLOWED_PROXY_HOSTS未設定)',
    });
  }

  try {
    const { res: upstreamRes, buffer, finalUrl } = await safeFetch(targetUrl, config.allowedProxyHosts);
    const contentType = upstreamRes.headers.get('content-type') || 'application/octet-stream';

    // 取得元のCookie等は一切クライアントへ転送しない。必要な最小限のヘッダのみ設定する。
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' https: data:; img-src https: data: blob:; font-src https: data:; frame-ancestors 'self';"
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    if (contentType.includes('text/html')) {
      const rewritten = rewriteHtml(buffer.toString('utf8'), finalUrl);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(rewritten);
    }

    // HTML以外(画像プロキシ経由リクエスト等)はそのまま返す
    res.setHeader('Content-Type', contentType);
    return res.send(buffer);
  } catch (err) {
    const statusByCode = {
      SSRF_BLOCKED: 403,
      TIMEOUT: 504,
      SIZE_LIMIT: 413,
      TOO_MANY_REDIRECTS: 400,
      BAD_REDIRECT: 502,
    };
    const status = statusByCode[err.code] || 502;
    if (!statusByCode[err.code]) {
      // eslint-disable-next-line no-console
      console.error('[proxy]', err.message);
    }
    return res.status(status).json({ error: err.message || 'Proxy取得に失敗しました' });
  }
});

module.exports = router;
