'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('../config');

if (!config.databaseUrl) {
  // eslint-disable-next-line no-console
  console.warn('[db] 警告: DATABASE_URLが設定されていません。DB機能は動作しません。');
}

const pool = config.databaseUrl
  ? new Pool({
      connectionString: config.databaseUrl,
      // Render PostgreSQLは外部接続にSSLが必要になる場合がある。
      // ローカル開発(sslmode指定なし)では無効化する。
      ssl: config.databaseUrl.includes('sslmode=require') || config.isProd
        ? { rejectUnauthorized: false }
        : false,
    })
  : null;

async function query(text, params) {
  if (!pool) throw new Error('データベースが設定されていません (DATABASE_URL未設定)');
  return pool.query(text, params);
}

async function initSchema() {
  if (!pool) return;
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  // eslint-disable-next-line no-console
  console.log('[db] スキーマ初期化完了');
}

async function healthCheck() {
  if (!pool) return false;
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    return false;
  }
}

async function seedInitialData() {
  if (!pool) return;
  await pool.query(
    `INSERT INTO games (title, description, category, url, thumbnail_url)
     SELECT '将棋ライク', 'unityroom.comで公開されている将棋風ブラウザゲームです。', '将棋・ボードゲーム',
            'https://unityroom.com/games/shougi-like', NULL
     WHERE NOT EXISTS (SELECT 1 FROM games WHERE url = 'https://unityroom.com/games/shougi-like')`
  );
}

module.exports = { pool, query, initSchema, seedInitialData, healthCheck };
