'use strict';

// SSRF対策の共通ユーティリティ。
// Cat Hub Proxy と VM用Proxy(後続フェーズ)の両方から利用する。

const dns = require('dns').promises;
const net = require('net');

// 常にブロックする既知のホスト名(大文字小文字を無視)
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
]);

function ipv4ToLong(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const ipLong = ipv4ToLong(ip);
  const rangeLong = ipv4ToLong(range);
  if (ipLong === null || rangeLong === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipLong & mask) === (rangeLong & mask);
}

// IPv4の非公開/予約済みレンジ(SSRF対策として拒否すべきもの)
const BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10', // CGNAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local / cloud metadata (169.254.169.254含む)
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved
  '255.255.255.255/32',
];

function isPrivateOrReservedIPv4(ip) {
  return BLOCKED_IPV4_CIDRS.some((cidr) => inCidr(ip, cidr));
}

function isPrivateOrReservedIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
  // IPv4射影アドレス (::ffff:a.b.c.d) は内包IPv4側で判定
  const v4mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isPrivateOrReservedIPv4(v4mapped[1]);
  return false;
}

function isPrivateOrReservedIp(ip) {
  if (net.isIPv4(ip)) return isPrivateOrReservedIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateOrReservedIPv6(ip);
  return true; // 不明な形式は安全側に倒して拒否
}

function hostMatchesAllowlist(hostname, allowlist) {
  const h = hostname.toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.toLowerCase().trim();
    if (!e) return false;
    if (e.startsWith('*.')) {
      const suffix = e.slice(1); // ".example.com"
      return h.endsWith(suffix) && h.length > suffix.length;
    }
    return h === e;
  });
}

/**
 * URLがSSRF的に安全か検証する。
 * - スキームがhttp/https以外は拒否
 * - ホスト名が既知の危険ホスト名なら拒否
 * - allowlistが指定されている場合、ホスト名がallowlistに一致しなければ拒否
 * - DNS解決した全IPが非公開/予約済みでないか確認
 *
 * @returns {Promise<{ok: true, hostname: string, resolvedIps: string[]}|{ok: false, reason: string}>}
 */
async function validateOutboundUrl(rawUrl, allowlist) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    return { ok: false, reason: 'URLの形式が不正です' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'httpまたはhttps以外のスキームは許可されていません' };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: 'このホストへのアクセスは許可されていません' };
  }

  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return { ok: false, reason: 'このホストは許可リストに登録されていません(管理者の設定が必要です)' };
  }

  if (!hostMatchesAllowlist(hostname, allowlist)) {
    return { ok: false, reason: 'このホストは許可リストに登録されていません' };
  }

  // hostnameが直接IPリテラルの場合も含めて解決する
  let addresses;
  try {
    if (net.isIP(hostname)) {
      addresses = [{ address: hostname }];
    } else {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    }
  } catch (err) {
    return { ok: false, reason: 'DNS解決に失敗しました' };
  }

  if (!addresses || addresses.length === 0) {
    return { ok: false, reason: 'DNS解決結果が空です' };
  }

  for (const addr of addresses) {
    if (isPrivateOrReservedIp(addr.address)) {
      return { ok: false, reason: '内部/予約済みIPアドレスへのアクセスは許可されていません' };
    }
  }

  return { ok: true, hostname, resolvedIps: addresses.map((a) => a.address) };
}

module.exports = {
  validateOutboundUrl,
  isPrivateOrReservedIp,
  hostMatchesAllowlist,
};
