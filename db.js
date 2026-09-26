'use strict';
const fs = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');
const pool = new Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 8000, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
async function query(sql, params) { return pool.query(sql, params); }
async function healthCheck() { try { await query('SELECT 1'); return true; } catch { return false; } }
async function initSchema() { await query(await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8')); }
async function seedInitialData() {
  await query(`INSERT INTO games (title, description, category, url) SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM games WHERE url=$4)`, ['将棋ライク', '将棋を題材にしたブラウザゲーム', '戦略', 'https://unityroom.com/games/shougi-like']);
}
module.exports = { pool, query, healthCheck, initSchema, seedInitialData };
