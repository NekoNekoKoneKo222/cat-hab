"use strict";

let mode = "login";
let me = null;
let socket = null;
let currentDm = null;
let currentRoom = null;

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function api(url, options = {}) {
  const r = await fetch(url, options);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "エラーが発生しました");
  return d;
}

function setPanel(name) {
  const ids = ["tube","cloud","friends","rooms","play","admin","settings"];
  ids.forEach(id => $("#" + id).classList.toggle("hidden", id !== name));
  $$(".nav[data-panel]").forEach(b => b.classList.toggle("active", b.dataset.panel === name));
  const button = $(`.nav[data-panel="${name}"]`);
  $("#pageTitle").textContent = button ? button.textContent.trim() : "Cat Hub";
}

async function startApp() {
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#meName").textContent = me.display_name || me.username;
  if (me.is_admin) $("#adminNav").classList.remove("hidden");

  socket = io();
  socket.on("connect", () => $("#status").textContent = "接続中");
  socket.on("disconnect", () => $("#status").textContent = "再接続待機中");
  socket.on("message", () => {
    if (currentDm) loadDM(currentDm).catch(console.error);
    if (currentRoom) loadRoomMessages(currentRoom).catch(console.error);
  });
  socket.on("messageDeleted", () => {
    if (currentRoom) loadRoomMessages(currentRoom).catch(console.error);
  });
  socket.on("reaction", () => {
    if (currentRoom) loadRoomMessages(currentRoom).catch(console.error);
  });
  socket.on("roomKicked", e => {
    if (currentRoom === e.roomId) closeRoom();
    alert("ルームからKickされました。");
    loadRooms().catch(console.error);
  });
  socket.on("roomBanned", e => {
    if (currentRoom === e.roomId) closeRoom();
    alert("ルームからBANされました。");
    loadRooms().catch(console.error);
  });
  socket.on("roomDeleted", e => {
    if (currentRoom === e.roomId) closeRoom();
    loadRooms().catch(console.error);
  });
  socket.on("accountBanned", () => {
    alert("アカウントが停止されました。");
    location.reload();
  });

  await Promise.all([
    loadDMRooms(),
    loadFriends(),
    loadRooms(),
    loadGames()
  ]);
}

async function restoreSession() {
  try {
    me = await api("/api/me");
    await startApp();
  } catch {}
}

$("#loginTab").onclick = () => {
  mode = "login";
  $("#loginTab").classList.add("active");
  $("#signupTab").classList.remove("active");
  $("#displayName").classList.add("hidden");
  $("#termsRow").classList.add("hidden");
  $("#authButton").textContent = "ログイン";
};

$("#signupTab").onclick = () => {
  mode = "signup";
  $("#signupTab").classList.add("active");
  $("#loginTab").classList.remove("active");
  $("#displayName").classList.remove("hidden");
  $("#termsRow").classList.remove("hidden");
  $("#authButton").textContent = "アカウント作成";
};

$("#authForm").onsubmit = async e => {
  e.preventDefault();
  $("#authError").textContent = "処理中...";
  try {
    const body = {
      username: $("#username").value.trim(),
      password: $("#password").value,
      displayName: $("#displayName").value.trim(),
      termsAccepted: $("#terms").checked
    };
    const result = await api(mode === "signup" ? "/api/auth/signup" : "/api/auth/login", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(body)
    });
    me = result.user;
    $("#authError").textContent = "";
    await startApp();
  } catch (e) {
    console.error(e);
    $("#authError").textContent = e.message;
  }
};

$("#logout").onclick = async () => {
  await api("/api/auth/logout", {method:"POST"}).catch(() => {});
  location.reload();
};

$$(".nav[data-panel]").forEach(button => {
  button.onclick = async () => {
    setPanel(button.dataset.panel);
    try {
      if (button.dataset.panel === "cloud") await loadDMRooms();
      if (button.dataset.panel === "friends") await loadFriends();
      if (button.dataset.panel === "rooms") await loadRooms();
      if (button.dataset.panel === "play") await loadGames();
      if (button.dataset.panel === "settings") await loadMe();
      if (button.dataset.panel === "admin" && me?.is_admin) setupAdmin();
    } catch (e) { console.error(e); }
  };
});

async function loadMe() {
  const u = await api("/api/me");
  $("#profileName").value = u.display_name || "";
  $("#profileBio").value = u.bio || "";
}
$("#profileForm").onsubmit = async e => {
  e.preventDefault();
  await api("/api/me", {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({displayName:$("#profileName").value,bio:$("#profileBio").value})});
  alert("保存しました");
};
$("#passwordForm").onsubmit = async e => {
  e.preventDefault();
  await api("/api/me/password", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:$("#newPassword").value})});
  $("#newPassword").value = "";
  alert("パスワードを変更しました");
};

/* Cat Tube */
async function searchYouTube() {
  const q = $("#tubeSearch").value.trim();
  if (!q) return;
  $("#tubeResults").innerHTML = '<div class="muted">検索中...</div>';
  try {
    const items = await api("/api/youtube/search?q=" + encodeURIComponent(q));
    $("#tubeResults").innerHTML = items.map(x => {
      const id = x.id?.videoId;
      const thumb = x.snippet?.thumbnails?.high?.url || x.snippet?.thumbnails?.medium?.url || "";
      return `<div class="card"><img class="thumb" src="${esc(thumb)}" alt=""><div class="cardbody"><h3>${esc(x.snippet?.title)}</h3><p class="muted">${esc(x.snippet?.channelTitle)}</p><button class="btn" type="button" data-video="${esc(id)}">見る</button></div></div>`;
    }).join("") || '<div class="muted">動画がありません</div>';
    $$("[data-video]").forEach(b => b.onclick = () => watchYouTube(b.dataset.video));
  } catch (e) {
    $("#tubeResults").innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}
$("#tubeSearchBtn").onclick = searchYouTube;
$("#tubeSearch").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); searchYouTube(); } };

async function watchYouTube(id) {
  try {
    const d = await api("/api/youtube/video/" + encodeURIComponent(id));
    $("#tubeResults").innerHTML = `<div style="grid-column:1/-1"><h2>${esc(d.snippet?.title)}</h2><div style="position:relative;padding-top:56.25%"><iframe src="https://www.youtube.com/embed/${encodeURIComponent(id)}?rel=0" allowfullscreen style="position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:16px"></iframe></div><div class="toolbar" style="margin-top:12px;flex-wrap:wrap"><button id="streamBtn" class="btn alt" type="button">Direct Stream</button><a class="btn alt" target="_blank" rel="noopener noreferrer" href="https://www.youtube.com/watch?v=${encodeURIComponent(id)}">YouTubeで開く</a></div><div id="streamInfo"></div></div>`;
    $("#streamBtn").onclick = () => getStream(id);
  } catch (e) { alert(e.message); }
}

async function getStream(id) {
  $("#streamInfo").innerHTML = '<div class="muted">ストリームを取得中...</div>';
  try {
    const d = await api("/api/youtube/stream?url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + id));
    $("#streamInfo").innerHTML = `<p class="muted">${esc(d.note || "")}</p><video controls playsinline class="game-player" src="${esc(d.url)}"></video>`;
  } catch (e) {
    $("#streamInfo").innerHTML = `<div class="error">${esc(e.message)}<br>この動画は埋め込み再生を利用してください。</div>`;
  }
}

/* DM */
async function loadDMRooms() {
  const rooms = await api("/api/dm/rooms");
  $("#dmList").innerHTML = rooms.map(r => `<div class="item" style="cursor:pointer" data-dm="${r.user_id}"><b>${esc(r.display_name)}</b><div class="muted">${esc(r.last_message || "新しいDM")}</div></div>`).join("") || '<div class="muted">DMがありません</div>';
  $$("[data-dm]").forEach(x => x.onclick = () => openDM(Number(x.dataset.dm)));
}
$("#refreshDM").onclick = () => loadDMRooms().catch(e => alert(e.message));

async function openDM(userId) {
  const r = await api("/api/dm/open", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({userId})});
  currentDm = r.roomId;
  setPanel("cloud");
  if (socket) socket.emit("joinRoom", currentDm);
  $("#dmForm").classList.remove("hidden");
  await loadDM(currentDm);
}

async function loadDM(roomId) {
  const messages = await api("/api/dm/" + roomId);
  $("#dmMessages").innerHTML = messages.map(m => `<div class="msg ${m.sender_id === me.id ? "mine" : ""}"><div class="msg-name">${esc(m.display_name)}</div><span class="bubble">${m.deleted ? "[削除済み]" : esc(m.content)}${m.image_url ? `<img src="${esc(m.image_url)}" alt="">` : ""}</span></div>`).join("") || '<div class="muted">メッセージがありません</div>';
  $("#dmMessages").scrollTop = $("#dmMessages").scrollHeight;
}
$("#dmForm").onsubmit = async e => {
  e.preventDefault(); if (!currentDm) return;
  const fd = new FormData(); fd.append("content", $("#dmInput").value);
  if ($("#dmImage").files[0]) fd.append("image", $("#dmImage").files[0]);
  await api("/api/dm/" + currentDm, {method:"POST",body:fd});
  $("#dmInput").value = ""; $("#dmImage").value = "";
  await loadDM(currentDm); await loadDMRooms();
};

/* Friends */
async function loadFriends() {
  const f = await api("/api/friends");
  $("#friendList").innerHTML = f.map(x => {
    const action = x.status === "pending" && x.requester_id !== me.id ? `<button class="btn alt" data-accept="${x.id}">承認</button>` : x.status === "accepted" ? `<button class="btn alt" data-open-dm="${x.user_id}">DM</button>` : '<span class="muted">申請中</span>';
    return `<div class="item"><b>${esc(x.display_name)}</b> <span class="muted">@${esc(x.username)}</span><span class="item-actions">${action}</span></div>`;
  }).join("") || '<div class="muted">フレンドがいません</div>';
  $$("[data-accept]").forEach(b => b.onclick = () => acceptFriend(Number(b.dataset.accept)).catch(e => alert(e.message)));
  $$("[data-open-dm]").forEach(b => b.onclick = () => openDM(Number(b.dataset.openDm)).catch(e => alert(e.message)));
}
$("#userSearchBtn").onclick = searchUsers;
$("#userSearch").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); searchUsers(); } };
async function searchUsers() {
  const q = $("#userSearch").value.trim(); if (!q) return;
  const users = await api("/api/users/search?q=" + encodeURIComponent(q));
  $("#userResults").innerHTML = users.map(u => `<div class="item"><b>${esc(u.display_name)}</b> <span class="muted">@${esc(u.username)}</span><span class="item-actions"><button class="btn alt" data-request="${u.id}">フレンド申請</button></span></div>`).join("") || '<div class="muted">見つかりませんでした</div>';
  $$("[data-request]").forEach(b => b.onclick = () => requestFriend(Number(b.dataset.request)).catch(e => alert(e.message)));
}
async function requestFriend(id) { await api("/api/friends/request", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({userId:id})}); alert("申請しました"); await loadFriends(); }
async function acceptFriend(id) { await api("/api/friends/accept", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({friendshipId:id})}); await loadFriends(); }

/* Rooms */
$("#privateRoom").onchange = () => {
  const enabled = $("#privateRoom").checked;
  $("#requireCode").disabled = !enabled;
  if (!enabled) $("#requireCode").checked = false;
};
$("#roomCreate").onclick = async () => {
  try {
    const body = {
      name: $("#roomName").value.trim(),
      isPrivate: $("#privateRoom").checked,
      requireJoinCode: $("#requireCode").checked,
      joinCode: $("#joinCode").value.trim()
    };
    await api("/api/rooms", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    $("#roomName").value = ""; $("#joinCode").value = "";
    await loadRooms(); alert("ルームを作成しました");
  } catch (e) { alert(e.message); }
};

async function loadRooms() {
  const [pub, mine] = await Promise.all([api("/api/rooms/public"), api("/api/rooms/mine")]);
  $("#publicRooms").innerHTML = pub.map(r => `<div class="item"><b>${esc(r.name)}</b><span class="muted"> ${r.member_count}人</span><span class="item-actions"><button class="btn alt" data-join="${r.id}" data-code="${r.require_join_code}">参加</button></span></div>`).join("") || '<div class="muted">公開ルームがありません</div>';
  $("#myRooms").innerHTML = mine.map(r => `<div class="item"><b>${esc(r.name)}</b> ${r.is_private ? '<span class="muted">非公開</span>' : ''} ${r.owner_id === me.id ? '<span class="muted">管理者</span>' : ''}<span class="item-actions"><button class="btn alt" data-open-room="${r.id}">開く</button></span></div>`).join("") || '<div class="muted">参加中のルームがありません</div>';
  $$("[data-join]").forEach(b => b.onclick = () => joinRoom(Number(b.dataset.join), b.dataset.code === "true").catch(e => alert(e.message)));
  $$("[data-open-room]").forEach(b => b.onclick = () => openRoom(Number(b.dataset.openRoom)).catch(e => alert(e.message)));
}

async function joinRoom(id, required) {
  const code = required ? (prompt("参加コードを入力してください") || "") : "";
  await api("/api/rooms/join", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({roomId:id,joinCode:code})});
  await loadRooms(); await openRoom(id);
}

async function openRoom(id) {
  const room = await api("/api/rooms/" + id);
  currentRoom = id;
  if (socket) socket.emit("joinRoom", id);
  $("#roomView").classList.remove("hidden");
  $("#roomTitle").textContent = room.name;
  $("#roomMeta").textContent = room.is_private ? "非公開ルーム" : "公開ルーム";
  $("#deleteRoom").classList.toggle("hidden", !(room.is_owner || room.is_admin));
  await Promise.all([loadRoomMessages(id), loadMembers(id), loadBans(id)]);
}

function closeRoom() {
  currentRoom = null;
  $("#roomView").classList.add("hidden");
}

$("#refreshRoom").onclick = () => currentRoom && openRoom(currentRoom).catch(e => alert(e.message));
$("#deleteRoom").onclick = async () => {
  if (!currentRoom || !confirm("このルームを削除しますか？")) return;
  try { await api("/api/rooms/" + currentRoom, {method:"DELETE"}); closeRoom(); await loadRooms(); } catch (e) { alert(e.message); }
};

async function loadRoomMessages(id) {
  const messages = await api("/api/rooms/" + id + "/messages");
  $("#roomMessages").innerHTML = messages.map(m => `<div class="msg ${m.sender_id === me.id ? "mine" : ""}"><div class="msg-name">${esc(m.display_name)} @${esc(m.username)}</div><span class="bubble">${m.deleted ? "[削除済み]" : esc(m.content)}${m.image_url ? `<img src="${esc(m.image_url)}" alt="">` : ""}<div class="small" style="margin-top:6px;opacity:.75">${new Date(m.created_at).toLocaleString("ja-JP")}</div>${m.deleted ? "" : `<div class="member-actions"><button class="btn alt small-btn" data-delete-message="${m.id}">削除</button><button class="btn alt small-btn" data-reply="${m.id}">返信</button></div>`}</span></div>`).join("") || '<div class="muted">メッセージがありません</div>';
  $("#roomMessages").scrollTop = $("#roomMessages").scrollHeight;
  $$("[data-delete-message]").forEach(b => b.onclick = () => deleteRoomMessage(Number(b.dataset.deleteMessage)).catch(e => alert(e.message)));
  $$("[data-reply]").forEach(b => b.onclick = () => { const content = $("#roomInput"); content.value = ">>> " + b.dataset.reply + "\n" + content.value; content.focus(); });
}
$("#roomForm").onsubmit = async e => {
  e.preventDefault(); if (!currentRoom) return;
  const fd = new FormData(); fd.append("content", $("#roomInput").value);
  if ($("#roomImage").files[0]) fd.append("image", $("#roomImage").files[0]);
  try {
    await api("/api/rooms/" + currentRoom + "/messages", {method:"POST",body:fd});
    $("#roomInput").value = ""; $("#roomImage").value = "";
    await loadRoomMessages(currentRoom);
  } catch (e) { alert(e.message); }
};
async function deleteRoomMessage(id) {
  if (!confirm("このメッセージを削除しますか？")) return;
  await api("/api/messages/" + id, {method:"DELETE"});
  if (currentRoom) await loadRoomMessages(currentRoom);
}

async function loadMembers(id) {
  const room = await api("/api/rooms/" + id);
  const members = await api("/api/rooms/" + id + "/members");
  $("#roomMembers").innerHTML = members.map(m => `<div class="member-row"><b>${esc(m.display_name)}</b> <span class="muted">@${esc(m.username)}</span>${m.is_owner ? '<div class="muted small">ルーム管理者</div>' : ''}${m.is_admin ? '<div class="muted small">Admin</div>' : ''}${(room.is_owner || room.is_admin) && !m.is_owner && !m.is_admin ? `<div class="member-actions"><button class="btn alt small-btn" data-kick="${m.id}">Kick</button><button class="btn danger small-btn" data-ban="${m.id}">BAN</button></div>` : ''}</div>`).join("") || '<div class="muted">メンバーなし</div>';
  $$("[data-kick]").forEach(b => b.onclick = () => moderateRoom("kick", Number(b.dataset.kick)).catch(e => alert(e.message)));
  $$("[data-ban]").forEach(b => b.onclick = () => moderateRoom("ban", Number(b.dataset.ban)).catch(e => alert(e.message)));
}
async function moderateRoom(action, userId) {
  const reason = prompt("理由（任意）") || "";
  if (!currentRoom) return;
  await api("/api/rooms/" + currentRoom + "/" + action, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({userId,reason})});
  await Promise.all([loadMembers(currentRoom), loadBans(currentRoom)]);
}
async function loadBans(id) {
  try {
    const bans = await api("/api/rooms/" + id + "/bans");
    $("#roomBans").innerHTML = bans.map(b => `<div class="item"><b>${esc(b.display_name)}</b><div class="muted">${esc(b.reason || "理由なし")}</div><button class="btn alt small-btn" data-unban="${b.user_id}">BAN解除</button></div>`).join("") || '<div class="muted">BANなし</div>';
    $$("[data-unban]").forEach(b => b.onclick = () => unban(Number(b.dataset.unban)).catch(e => alert(e.message)));
  } catch {
    $("#roomBans").innerHTML = '<div class="muted">表示権限がありません</div>';
  }
}
async function unban(userId) {
  await api("/api/rooms/" + currentRoom + "/bans/" + userId, {method:"DELETE"});
  await loadBans(currentRoom);
}

/* Play Cat */
async function loadGames() {
  try {
    const games = await api("/api/games");
    $("#games").innerHTML = games.map(g => `<div class="card"><div class="cardbody"><h3>${esc(g.title)}</h3><p class="muted">${esc(g.description)}</p><button class="btn" data-game="${g.id}" data-url="${encodeURIComponent(g.game_url)}">プレイ</button></div></div>`).join("") || '<div class="muted">ゲームがありません</div>';
    $$("[data-game]").forEach(b => b.onclick = async () => { await api("/api/games/" + b.dataset.game + "/play", {method:"POST"}); window.open(decodeURIComponent(b.dataset.url), "_blank", "noopener,noreferrer"); });
  } catch (e) { $("#games").innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

/* Admin */
function setupAdmin() {
  if (!me?.is_admin) return;
  $("#adminArea").innerHTML = `<button id="adminLoad" class="btn" type="button">管理情報を読み込む</button><div id="adminData" class="list"></div>`;
  $("#adminLoad").onclick = loadAdminData;
}
async function loadAdminData() {
  try {
    const [users, rooms, logs, reports] = await Promise.all([api("/api/admin/users"), api("/api/admin/rooms"), api("/api/admin/logs"), api("/api/admin/reports")]);
    $("#adminData").innerHTML = `<div class="item"><h3>ユーザー</h3><pre>${esc(JSON.stringify(users,null,2))}</pre></div><div class="item"><h3>ルーム</h3><pre>${esc(JSON.stringify(rooms,null,2))}</pre></div><div class="item"><h3>管理ログ</h3><pre>${esc(JSON.stringify(logs,null,2))}</pre></div><div class="item"><h3>通報</h3><pre>${esc(JSON.stringify(reports,null,2))}</pre></div>`;
  } catch (e) { $("#adminData").innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

restoreSession();
