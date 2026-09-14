'use strict';

const config = require('../config');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'ログインが必要です' });
  }
  return next();
}

function isAdminUser(user) {
  if (!user) return false;
  if (user.is_admin) return true;
  return config.adminUsers.includes(user.username);
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'ログインが必要です' });
  }
  if (!isAdminUser(req.session.user)) {
    return res.status(403).json({ error: '管理者権限が必要です' });
  }
  return next();
}

module.exports = { requireAuth, requireAdmin, isAdminUser };
