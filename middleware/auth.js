'use strict';

const db = require('../db');
const fs = require('fs');
const path = require('path');

async function requireAuth(req,res,next) {
 if(!req.session?.userId)return res.status(401).json({error:'ログインが必要です'});
 try {const r=await db.query('SELECT id,username,display_name,is_admin,is_banned FROM users WHERE id=$1',[req.session.userId]);
 if(!r.rows[0]||r.rows[0].is_banned)return res.status(403).json({error:'アカウントが利用できません'});
 req.session.user={...req.session.user,...r.rows[0]};return next();
 }catch(e){return next(e)}
}

function isAdminUser(user) {
  if (!user) return false;
  try {
    const entries = fs.readFileSync(path.join(__dirname, '..', 'admin.txt'), 'utf8').split(/\r?\n/).map(v => v.trim().toLowerCase());
    return entries.includes(String(user.username).toLowerCase());
  } catch { return false; }
}

function requireAdmin(req,res,next) {
 return requireAuth(req,res,()=>isAdminUser(req.session.user)?next():res.status(403).json({error:'管理者権限が必要です'}));
}

module.exports = { requireAuth, requireAdmin, isAdminUser };
