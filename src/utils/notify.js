'use strict';

const db = require('../db');
const bus = require('./events');

async function createNotification(userId, type, payload) {
  const result = await db.query(
    `INSERT INTO notifications (user_id, type, payload)
     VALUES ($1, $2, $3)
     RETURNING id, type, payload, is_read, created_at`,
    [userId, type, payload ? JSON.stringify(payload) : null]
  );
  const notification = result.rows[0];
  bus.emit('notification', { userId, notification });
  return notification;
}

module.exports = { createNotification };
