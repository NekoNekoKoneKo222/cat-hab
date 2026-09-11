// 環境変数の一元管理。秘密情報はここから直接ログ出力しないこと。
'use strict';

function parseList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseIntEnv(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  port: parseIntEnv(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',

  databaseUrl: process.env.DATABASE_URL || '',

  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',

  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',

  adminUsers: parseList(process.env.ADMIN_USERS),

  allowedProxyHosts: parseList(process.env.ALLOWED_PROXY_HOSTS),

  proxy: {
    timeoutMs: 10000,
    maxBytes: 8 * 1024 * 1024, // 8MB
    maxRedirects: 5,
  },

  vm: {
    isoUrl: process.env.VM_ISO_URL || '/vm/iso/linux.iso',
    maxIsoSizeMb: parseIntEnv(process.env.VM_MAX_ISO_SIZE_MB, 2048),
    memoryMb: parseIntEnv(process.env.VM_MEMORY_MB, 512),
    cpuCount: parseIntEnv(process.env.VM_CPU_COUNT, 1),
    networkProxyAllowlist: parseList(process.env.VM_NETWORK_PROXY_ALLOWLIST),
    enabled: (process.env.VM_ENABLED || 'true') !== 'false',
  },
};

module.exports = config;
