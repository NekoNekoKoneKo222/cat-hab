'use strict';
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const router = express.Router();
router.use(requireAdmin);
router.get('/status', (_req,res) => res.json({adminSource:'admin.txt',services:['Cat Tube','Cloud Cat','Play Cat','Proxy'],uptimeSeconds:Math.floor(process.uptime())}));
router.get('/users', async (_req,res,next) => {try {const r=await db.query('SELECT id,username,display_name,is_banned,created_at FROM users ORDER BY id DESC LIMIT 200');res.json({users:r.rows});}catch(e){next(e);}});
router.post('/users/:id/ban', async (req,res,next) => {try {
 const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id===req.session.userId)return res.status(400).json({error:'対象が不正です'});
 const banned=req.body.banned===true;const r=await db.query('UPDATE users SET is_banned=$1 WHERE id=$2 RETURNING id,username,is_banned',[banned,id]);if(!r.rowCount)return res.sendStatus(404);
 await db.query('INSERT INTO admin_logs(admin_id,action,target,detail) VALUES($1,$2,$3,$4)',[req.session.userId,banned?'account_ban':'account_unban',String(id),JSON.stringify({username:r.rows[0].username})]);res.json({user:r.rows[0]});
}catch(e){next(e);}});
router.get('/rooms', async (_req,res,next)=>{try{const r=await db.query('SELECT id,name,is_private,owner_id FROM rooms ORDER BY id DESC LIMIT 200');res.json({rooms:r.rows});}catch(e){next(e);}});
router.post('/rooms/:id/join', async(req,res,next)=>{try{const id=Number(req.params.id);if(!Number.isSafeInteger(id))return res.sendStatus(400);await db.query('INSERT INTO room_members(room_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(room_id,user_id) DO NOTHING',[id,req.session.userId,'admin']);await db.query('INSERT INTO admin_logs(admin_id,action,target) VALUES($1,$2,$3)',[req.session.userId,'force_join',String(id)]);res.json({ok:true});}catch(e){next(e);}});
router.delete('/rooms/:id', async(req,res,next)=>{try{const id=Number(req.params.id);if(!Number.isSafeInteger(id))return res.sendStatus(400);const r=await db.query('DELETE FROM rooms WHERE id=$1 RETURNING id',[id]);if(!r.rowCount)return res.sendStatus(404);await db.query('INSERT INTO admin_logs(admin_id,action,target) VALUES($1,$2,$3)',[req.session.userId,'room_delete',String(id)]);res.json({ok:true});}catch(e){next(e);}});
router.get('/logs',async(_req,res,next)=>{try{const r=await db.query('SELECT * FROM admin_logs ORDER BY id DESC LIMIT 200');res.json({logs:r.rows});}catch(e){next(e);}});
module.exports=router;
