'use strict';

const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

function publicIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const p = address.split('.').map(Number);
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || (b === 168) || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 198 && b === 19) return false;
  return true;
}

async function validateUrl(rawUrl, lookup = dns.lookup) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new ProxyError(400, 'URLが不正です'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ProxyError(400, 'HTTP/HTTPSのみ利用できます');
  if (url.username || url.password || url.hash) throw new ProxyError(400, 'URLの認証情報やフラグメントは利用できません');
  if (url.port && !['80', '443'].includes(url.port)) throw new ProxyError(400, 'このポートは利用できません');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host === 'metadata' || host === 'metadata.google.internal' ||
      net.isIP(host) === 6) throw new ProxyError(403, '内部ホストには接続できません');
  let records;
  try {
    records = net.isIP(host) === 4 ? [{ address: host, family: 4 }] :
      await lookup(host, { all: true, family: 4, verbatim: true });
  } catch { throw new ProxyError(502, '接続先の名前解決に失敗しました'); }
  if (!records.length || records.some(record => !publicIPv4(record.address))) {
    throw new ProxyError(403, '内部または予約済みのIPには接続できません');
  }
  return { url, address: records[0].address };
}

class ProxyError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requestOnce(url, address) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, {
      lookup: (_host, _options, callback) => callback(null, address, 4),
      headers: { Accept: 'application/json, text/plain, image/png, image/jpeg, image/webp, image/gif' },
      timeout: TIMEOUT_MS,
      maxHeaderSize: 16 * 1024,
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          response.destroy(new ProxyError(502, '応答が大きすぎます'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('timeout', () => request.destroy(new ProxyError(504, '接続がタイムアウトしました')));
    request.on('error', reject);
  });
}

async function fetchSafe(rawUrl, { validate = validateUrl, request = requestOnce } = {}) {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url, address } = await validate(current);
    const response = await request(url, address);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === MAX_REDIRECTS) throw new ProxyError(502, 'リダイレクト回数が多すぎます');
      if (!response.headers.location) throw new ProxyError(502, 'リダイレクト先がありません');
      current = new URL(response.headers.location, url).href;
      continue;
    }
    const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!['application/json', 'text/plain', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) {
      throw new ProxyError(415, 'このContent-Typeは表示できません');
    }
    return { status: response.status, type, body: response.body };
  }
  throw new ProxyError(502, 'リダイレクト回数が多すぎます');
}

module.exports = { fetchSafe, validateUrl, publicIPv4, ProxyError };
