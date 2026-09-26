(function () {
  'use strict';

  const tabsEl = document.getElementById('cc-tabs');
  const sidebarEl = document.getElementById('cc-sidebar');
  const contentEl = document.getElementById('cc-content');

  let socket = null;
  let myUser = null;
  let currentTab = 'friends';
  let activeChat = null; // { scope, roomId }
  let replyTarget = null;

  function esc(str) {
    return window.CatHub ? window.CatHub.escapeHtml(str) : String(str);
  }

  function fmtTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (err) {
      return '';
    }
  }

  async function api(method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'エラーが発生しました (HTTP ' + res.status + ')');
    return data;
  }

  function initSocket() {
    if (socket) return;
    socket = window.io();
    socket.on('message:new', ({ scope, roomId, message }) => {
      if (activeChat && activeChat.scope === scope && activeChat.roomId === roomId) {
        appendMessage(message, scope);
      }
    });
    socket.on('message:deleted', ({ scope, roomId, messageId }) => {
      if (activeChat && activeChat.scope === scope && activeChat.roomId === roomId) {
        const el = document.querySelector('[data-msg-id="' + messageId + '"] .ch-cc-msg-content');
        if (el) {
          el.textContent = '(このメッセージは削除されました)';
          el.classList.add('deleted');
        }
        const img = document.querySelector('[data-msg-id="' + messageId + '"] .ch-cc-msg-img');
        if (img) img.remove();
      }
    });
    socket.on('reaction:update', (payload) => {
      if (activeChat && activeChat.scope === payload.scope && activeChat.roomId === payload.roomId) {
        loadReactionsFor(payload.messageId, payload.scope);
      }
    });
    socket.on('notification', () => {
      refreshNotificationBadge();
    });
  }

  function joinRoom(scope, roomId) {
    if (!socket) return;
    socket.emit('join', { scope, roomId }, () => {});
  }

  async function refreshNotificationBadge() {
    try {
      const data = await api('GET', '/api/notifications');
      document.dispatchEvent(new CustomEvent('cathub:unread-count', { detail: data.unreadCount }));
    } catch (err) {
      /* noop */
    }
  }

  tabsEl.querySelectorAll('.ch-cc-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      tabsEl.querySelectorAll('.ch-cc-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.getAttribute('data-tab');
      activeChat = null;
      renderTab();
    });
  });

  function renderTab() {
    contentEl.innerHTML = '';
    sidebarEl.innerHTML = '';
    if (currentTab === 'friends') return renderFriendsTab();
    if (currentTab === 'dm') return renderDmTab();
    if (currentTab === 'groups') return renderGroupsTab();
    if (currentTab === 'communities') return renderCommunitiesTab();
    if (currentTab === 'rooms') return renderRoomsTab();
  }

  // ================= フレンド =================
  async function renderFriendsTab() {
    sidebarEl.innerHTML =
      '<form id="add-friend-form" class="ch-form" style="max-width:none;">' +
      '<div class="ch-field"><label>ユーザー名でフレンド申請</label><input id="add-friend-input" placeholder="username" /></div>' +
      '<button class="ch-btn" type="submit">申請を送る</button>' +
      '</form><div id="friend-alert" style="margin-top:8px;"></div>';

    document.getElementById('add-friend-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('add-friend-input');
      const alertBox = document.getElementById('friend-alert');
      try {
        await api('POST', '/api/friends/request', { username: input.value.trim() });
        input.value = '';
        alertBox.innerHTML = '<div class="ch-alert success">申請を送りました</div>';
        loadFriendsList();
      } catch (err) {
        alertBox.innerHTML = '<div class="ch-alert error">' + esc(err.message) + '</div>';
      }
    });

    contentEl.innerHTML = '<p style="color:var(--ch-text-muted);">読み込み中...</p>';
    loadFriendsList();
  }

  async function loadFriendsList() {
    try {
      const data = await api('GET', '/api/friends');
      const section = (title, list, actions) =>
        '<h3 style="color:var(--ch-purple-dark);">' + title + ' (' + list.length + ')</h3>' +
        (list.length === 0
          ? '<p style="color:var(--ch-text-muted); font-size:0.85rem;">なし</p>'
          : list
              .map(
                (item) =>
                  '<div class="ch-cc-list-item" style="cursor:default;"><span>' +
                  esc(item.user.displayName) +
                  ' (@' + esc(item.user.username) + ')</span><span>' +
                  actions(item) +
                  '</span></div>'
              )
              .join(''));

      contentEl.innerHTML =
        section('フレンド', data.friends, (item) => '<button class="ch-btn secondary dm-start-btn" data-uid="' + item.user.id + '" type="button">DM</button>') +
        section('受信した申請', data.incoming, (item) => '<button class="ch-btn accept-btn" data-fid="' + item.friendshipId + '" type="button">承認</button> <button class="ch-btn danger decline-btn" data-fid="' + item.friendshipId + '" type="button">拒否</button>') +
        section('送信した申請', data.outgoing, (item) => '<button class="ch-btn danger decline-btn" data-fid="' + item.friendshipId + '" type="button">取消</button>');

      contentEl.querySelectorAll('.accept-btn').forEach((b) =>
        b.addEventListener('click', async () => {
          await api('POST', '/api/friends/' + b.getAttribute('data-fid') + '/accept');
          loadFriendsList();
        })
      );
      contentEl.querySelectorAll('.decline-btn').forEach((b) =>
        b.addEventListener('click', async () => {
          await api('DELETE', '/api/friends/' + b.getAttribute('data-fid'));
          loadFriendsList();
        })
      );
      contentEl.querySelectorAll('.dm-start-btn').forEach((b) =>
        b.addEventListener('click', async () => {
          const room = await api('POST', '/api/dm/rooms', { userId: Number(b.getAttribute('data-uid')) });
          document.querySelector('[data-tab="dm"]').click();
          setTimeout(() => openDmRoom(room.roomId), 100);
        })
      );
    } catch (err) {
      contentEl.innerHTML = '<div class="ch-alert error">' + esc(err.message) + '</div>';
    }
  }

  // ================= DM =================
  async function renderDmTab() {
    sidebarEl.innerHTML = '<p style="color:var(--ch-text-muted);">読み込み中...</p>';
    contentEl.innerHTML = '<p style="color:var(--ch-text-muted);">左のリストからDMを選択してください。</p>';
    try {
      const data = await api('GET', '/api/dm/rooms');
      if (data.rooms.length === 0) {
        sidebarEl.innerHTML = '<p style="color:var(--ch-text-muted); font-size:0.85rem;">DMはまだありません。フレンド一覧から開始できます。</p>';
        return;
      }
      sidebarEl.innerHTML = data.rooms
        .map((r) => {
          const label = r.isGroup
            ? r.name || 'グループDM'
            : (r.members.find((m) => m.id !== myUser.id) || { displayName: '不明' }).displayName;
          return '<div class="ch-cc-list-item" data-room-id="' + r.id + '"><span>' + esc(label) + '</span></div>';
        })
        .join('');
      sidebarEl.querySelectorAll('[data-room-id]').forEach((el) =>
        el.addEventListener('click', () => {
          sidebarEl.querySelectorAll('.ch-cc-list-item').forEach((x) => x.classList.remove('active'));
          el.classList.add('active');
          openDmRoom(Number(el.getAttribute('data-room-id')));
        })
      );
    } catch (err) {
      sidebarEl.innerHTML = '<div class="ch-alert error">' + esc(err.message) + '</div>';
    }
  }

  function openDmRoom(roomId) {
    activeChat = { scope: 'dm', roomId };
    renderChatUi({
      scope: 'dm',
      roomId,
      getMessagesUrl: '/api/dm/rooms/' + roomId + '/messages',
      sendUrl: '/api/dm/rooms/' + roomId + '/messages',
      deleteUrlBase: '/api/dm/messages/',
      reactUrlBase: '/api/dm/messages/',
      canModerate: false,
    });
  }

  // ================= グループ =================
  async function renderGroupsTab() {
    sidebarEl.innerHTML =
      '<form id="create-group-form" class="ch-form" style="max-width:none; margin-bottom:10px;">' +
      '<div class="ch-field"><label>新しいグループ名</label><input id="group-name-input" /></div>' +
      '<button class="ch-btn" type="submit">作成</button></form><div id="group-list"></div>';
    document.getElementById('create-group-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('group-name-input');
      if (!input.value.trim()) return;
      await api('POST', '/api/groups', { name: input.value.trim() });
      input.value = '';
      loadGroupList();
    });
    contentEl.innerHTML = '<p style="color:var(--ch-text-muted);">左のリストからグループを選択してください。</p>';
    loadGroupList();
  }

  async function loadGroupList() {
    const listEl = document.getElementById('group-list');
    try {
      const data = await api('GET', '/api/groups');
      listEl.innerHTML = data.groups
        .map((g) => '<div class="ch-cc-list-item" data-group-id="' + g.id + '"><span>' + esc(g.name) + '</span><span style="font-size:0.75rem;">' + g.member_count + '人</span></div>')
        .join('');
      listEl.querySelectorAll('[data-group-id]').forEach((el) =>
        el.addEventListener('click', () => {
          listEl.querySelectorAll('.ch-cc-list-item').forEach((x) => x.classList.remove('active'));
          el.classList.add('active');
          openGroupDetail(Number(el.getAttribute('data-group-id')));
        })
      );
    } catch (err) {
      listEl.innerHTML = '<div class="ch-alert error">' + esc(err.message) + '</div>';
    }
  }

  async function openGroupDetail(groupId) {
    contentEl.innerHTML = '<p style="color:var(--ch-text-muted);">読み込み中...</p>';
    try {
      const data = await api('GET', '/api/groups/' + groupId);
      const canManage = ['owner', 'moderator'].includes(data.myRole);
      contentEl.innerHTML =
        '<h3 style="margin-top:0; color:var(--ch-purple-dark);">' + esc(data.group.name) + '</h3>' +
        '<p style="color:var(--ch-text-muted);">' + esc(data.group.description || '') + '</p>' +
        (canManage
          ? '<form id="add-member-form" class="ch-form" style="max-width:320px; flex-direction:row; margin-bottom:14px;">' +
            '<input id="add-member-input" placeholder="ユーザー名" style="flex:1; border:1px solid var(--ch-border); border-radius:10px; padding:8px;" />' +
            '<button class="ch-btn" type="submit">追加</button></form>'
          : '') +
        '<h4 style="color:var(--ch-purple-dark);">メンバー</h4>' +
        data.members
          .map(
            (m) =>
              '<div class="ch-cc-list-item" style="cursor:default;"><span>' +
              esc(m.display_name) + ' (' + m.role + ')</span>' +
              (canManage && m.role !== 'owner'
                ? '<button class="ch-btn danger remove-member-btn" data-uid="' + m.id + '" type="button">削除</button>'
                : '') +
              '</div>'
          )
          .join('');

      const form = document.getElementById('add-member-form');
      if (form) {
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const input = document.getElementById('add-member-input');
          try {
            await api('POST', '/api/groups/' + groupId + '/members', { username: input.value.trim() });
            openGroupDetail(groupId);
          } catch (err) {
            alert(err.message);
          }
        });
      }
      contentEl.querySelectorAll('.remove-member-btn').forEach((b) =>
        b.addEventListener('click', async () => {
          await api('DELETE', '/api/groups/' + groupId + '/members/' + b.getAttribute('data-uid'));
          openGroupDetail(groupId);
        })
      );
    } catch (err) {
      contentEl.innerHTML = '<div class="ch-alert error">' + esc(err.message) + '</div>';
    }
  }

  // ================= コミュニティ =================
  async function renderCommunitiesTab() {
    sidebarEl.innerHTML =
      '<form id="create-community-form" class="ch-form" style="max-width:none; margin-bottom:10px;">' +
      '<div class="ch-field"><label>新しいコミュニティ名</label><input id="community-name-input" /></div>' +
      '<button class="ch-btn" type="submit">作成</button></form><div id="community-list"></div>';
    document.getElementById('create-community-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('community-name-input');
      if (!input.value.trim()) return;
      await api('POST', '/api/communities', { name: input.value.trim() });
      input.value = '';
      loadCommunityList();
    });
    contentEl.innerHTML = '<p style="color:var(--ch-text-muted);">左のリストからコミュニティを選択してください。</p>';
    loadCommunityList();
  }

  async function loadCommunityList() {
    const listEl = document.getElementById('community-list');
    try {
      const data = await api('GET', '/api/communities');
      listEl.innerHTML = data.communities
        .map((c) => '<div class="ch-cc-list-item" data-community-id="' + c.id + '"><span>' + esc(c.name) + '</span><span style="font-size:0.75rem;">' + c.channel_count + 'ch</span></div>')
        .join('');
      listEl.querySelectorAll('[data-community-id]').forEach((el) =>
        el.addEventListener('click', () => {
          listEl.querySelectorAll('.ch-cc-list-item').forEach((x) => x.classList.remove('active'));
          el.classList.add('active');
          openCommunityChannels(Number(el.getAttribute('data-community-id')));
        })
      );
    } catch (err) {
      listEl.innerHTML = '<div class="ch-alert error">' + esc(err.message) + '</div>';
    }
  }

  async function openCommunityChannels(communityId) {
    contentEl.innerHTML = '<p style="color:var(--ch-text-muted);">読み込み中...</p>';
    try {
      const data = await api('GET', '/api/communities/' + communityId + '/channels');
      contentEl.innerHTML =
        '<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px;">' +
        data.channels.map((c) => '<button class="ch-btn secondary channel-btn" data-channel-id="' + c.id + '" type="button">#' + esc(c.name) + '</button>').join('') +
        '</div><div id="channel-chat-area"></div>';
      contentEl.querySelectorAll('.channel-btn').forEach((b) =>
        b.addEventListener('click', () => openChannelChat(Number(b.getAttribute('data-channel-id'))))
      );
      if (data.channels.length > 0) openChannelChat(data.channels[0].id);
    } catch (err) {
      contentEl.innerHTML = '<div class="ch-alert error">' + esc(err.message) + '</div>';
    }
  }

  function openChannelChat(channelId) {
    activeChat = { scope: 'channel', roomId: channelId };
    const area = document.getElementById('channel-chat-area');
    renderChatUi(
      {
        scope: 'channel',
        roomId: channelId,
        getMessagesUrl: '/api/communities/channels/' + channelId + '/messages',
        sendUrl: '/api/communities/channels/' + channelId + '/messages',
        deleteUrlBase: '/api/communities/channels/messages/',
        reactUrlBase: null, // チャンネルのリアクション一覧APIは未提供のため、送信のみ将来対応
        canModerate: false,
      },
      area
    );
  }

  // ================= ルーム =================
  async function renderRoomsTab() {
    sidebarEl.innerHTML =
      '<form id="create-room-form" class="ch-form" style="max-width:none; margin-bottom:10px;">' +
      '<div class="ch-field"><label>新しいルーム名</label><input id="room-name-input" /></div>' +
      '<button class="ch-btn" type="submit">作成</button></form><div id="room-list"></div>';
    document.getElementById('create-room-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('room-name-input');
      if (!input.value.trim()) return;
      await api('POST', '/api/rooms', { name: input.value.trim(), isPrivate: false });
      input.value = '';
      loadRoomList();
    });
    contentEl.innerHTML = '<p style="color:var(--ch-text-muted);">左のリストからルームを選択してください。</p>';
    loadRoomList();
  }

  async function loadRoomList() {
    const listEl = document.getElementById('room-list');
    try {
      const data = await api('GET', '/api/rooms');
      listEl.innerHTML = data.rooms
        .map(
          (r) =>
            '<div class="ch-cc-list-item" data-room-id="' + r.id + '"><span>' + esc(r.name) + (r.role ? '' : ' (未参加)') + '</span><span style="font-size:0.75rem;">' + r.member_count + '人</span></div>'
        )
        .join('');
      listEl.querySelectorAll('[data-room-id]').forEach((el) =>
        el.addEventListener('click', async () => {
          listEl.querySelectorAll('.ch-cc-list-item').forEach((x) => x.classList.remove('active'));
          el.classList.add('active');
          const roomId = Number(el.getAttribute('data-room-id'));
          try {
            await api('POST', '/api/rooms/' + roomId + '/join');
          } catch (err) {
            /* 既に参加済み、またはprivateで拒否。チャットの表示自体は試みる */
          }
          openRoomChat(roomId);
        })
      );
    } catch (err) {
      listEl.innerHTML = '<div class="ch-alert error">' + esc(err.message) + '</div>';
    }
  }

  function openRoomChat(roomId) {
    activeChat = { scope: 'room', roomId };
    renderChatUi({
      scope: 'room',
      roomId,
      getMessagesUrl: '/api/rooms/' + roomId + '/messages',
      sendUrl: '/api/rooms/' + roomId + '/messages',
      deleteUrlBase: '/api/rooms/messages/',
      reactUrlBase: null, // ルームのリアクションは未実装(既知の制限事項)
      canModerate: true,
    });
  }

  // ================= 共通チャットUI =================
  function renderChatUi(cfg, container) {
    const target = container || contentEl;
    replyTarget = null;
    target.innerHTML =
      '<div class="ch-cc-chat">' +
      '<div class="ch-cc-messages" id="cc-messages"></div>' +
      '<div id="cc-reply-preview"></div>' +
      '<div class="ch-cc-input-row">' +
      '<input type="file" id="cc-image-input" accept="image/jpeg,image/png,image/gif,image/webp" style="display:none;" />' +
      '<button class="ch-btn secondary" id="cc-image-btn" type="button" title="画像を送信">画像</button>' +
      '<textarea id="cc-text-input" placeholder="メッセージを入力 (Shift+Enterで改行)"></textarea>' +
      '<button class="ch-btn" id="cc-send-btn" type="button">送信</button>' +
      '</div></div>';

    window.__ccCurrentCfg = cfg;
    joinRoom(cfg.scope, cfg.roomId);
    loadMessages(cfg);

    document.getElementById('cc-image-btn').addEventListener('click', () => {
      document.getElementById('cc-image-input').click();
    });
    document.getElementById('cc-send-btn').addEventListener('click', () => sendMessage(cfg));
    document.getElementById('cc-text-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(cfg);
      }
    });
  }

  async function loadMessages(cfg) {
    const messagesEl = document.getElementById('cc-messages');
    if (!messagesEl) return;
    messagesEl.innerHTML = '<p style="color:var(--ch-text-muted);">読み込み中...</p>';
    try {
      const data = await api('GET', cfg.getMessagesUrl);
      messagesEl.innerHTML = '';
      data.messages.forEach((m) => appendMessage(m, cfg.scope, cfg));
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (err) {
      messagesEl.innerHTML = '<div class="ch-alert error">' + esc(err.message) + '</div>';
    }
  }

  function appendMessage(m, scope, cfgArg) {
    const cfg = cfgArg || window.__ccCurrentCfg;
    const messagesEl = document.getElementById('cc-messages');
    if (!messagesEl || !cfg) return;
    const isMine = myUser && m.userId === myUser.id;
    const wrap = document.createElement('div');
    wrap.className = 'ch-cc-msg';
    wrap.setAttribute('data-msg-id', m.id);
    wrap.innerHTML =
      '<div class="ch-cc-msg-avatar">' + esc((m.displayName || '?').slice(0, 1)) + '</div>' +
      '<div class="ch-cc-msg-body">' +
      '<div class="ch-cc-msg-meta">' + esc(m.displayName) + ' ・ ' + fmtTime(m.createdAt) + '</div>' +
      '<div class="ch-cc-msg-content' + (m.deleted ? ' deleted' : '') + '">' +
      (m.deleted ? '(このメッセージは削除されました)' : esc(m.content || '')) +
      '</div>' +
      (m.imageUrl && !m.deleted ? '<img class="ch-cc-msg-img" src="' + esc(m.imageUrl) + '" alt="" />' : '') +
      '<div class="ch-cc-reactions" data-reactions-for="' + m.id + '"></div>' +
      '<div class="ch-cc-msg-actions">' +
      (cfg.reactUrlBase ? '<span class="react-btn" data-id="' + m.id + '">リアクション</span>' : '') +
      '<span class="reply-btn" data-id="' + m.id + '">返信</span>' +
      (!m.deleted && (isMine || cfg.canModerate) ? '<span class="delete-btn" data-id="' + m.id + '">削除</span>' : '') +
      '</div></div>';
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    if (cfg.reactUrlBase) loadReactionsFor(m.id, scope, cfg);

    wrap.querySelector('.reply-btn').addEventListener('click', () => {
      replyTarget = m.id;
      const previewEl = document.getElementById('cc-reply-preview');
      previewEl.innerHTML =
        '<div class="ch-cc-reply-preview"><span>返信先: ' + esc((m.content || '(画像)').slice(0, 40)) + '</span><span class="cancel-reply" style="cursor:pointer;">解除</span></div>';
      previewEl.querySelector('.cancel-reply').addEventListener('click', () => {
        replyTarget = null;
        previewEl.innerHTML = '';
      });
    });

    const deleteBtn = wrap.querySelector('.delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        if (!confirm('このメッセージを削除しますか?')) return;
        try {
          await api('DELETE', cfg.deleteUrlBase + m.id);
        } catch (err) {
          alert(err.message);
        }
      });
    }

    const reactBtn = wrap.querySelector('.react-btn');
    if (reactBtn) {
      reactBtn.addEventListener('click', async () => {
        try {
          await api('POST', cfg.reactUrlBase + m.id + '/reactions', { emojiCode: 'like' });
        } catch (err) {
          alert(err.message);
        }
      });
    }
  }

  async function loadReactionsFor(messageId, scope, cfgArg) {
    const cfg = cfgArg || window.__ccCurrentCfg;
    if (!cfg || cfg.scope !== 'dm') return; // リアクション一覧取得APIはDMのみ提供
    const holder = document.querySelector('[data-reactions-for="' + messageId + '"]');
    if (!holder) return;
    try {
      const data = await api('GET', '/api/dm/messages/' + messageId + '/reactions');
      holder.innerHTML = data.reactions
        .map(
          (r) =>
            '<span class="ch-cc-reaction-chip' + (myUser && r.user_ids.includes(myUser.id) ? ' mine' : '') + '">' +
            esc(r.emoji_code) + ' ' + r.count + '</span>'
        )
        .join('');
    } catch (err) {
      /* noop */
    }
  }

  async function sendMessage(cfg) {
    const textInput = document.getElementById('cc-text-input');
    const imageInput = document.getElementById('cc-image-input');
    const content = textInput.value.trim();
    const file = imageInput.files[0];

    if (!content && !file) return;

    let imageUrl = null;
    if (file) {
      const formData = new FormData();
      formData.append('image', file);
      try {
        const res = await fetch('/api/upload/image', { method: 'POST', credentials: 'same-origin', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        imageUrl = data.url;
      } catch (err) {
        alert('画像アップロードに失敗しました: ' + err.message);
        return;
      }
    }

    try {
      const payload = {};
      if (content) payload.content = content;
      if (imageUrl) payload.imageUrl = imageUrl;
      if (replyTarget) payload.replyTo = replyTarget;
      await api('POST', cfg.sendUrl, payload);
      textInput.value = '';
      imageInput.value = '';
      replyTarget = null;
      const previewEl = document.getElementById('cc-reply-preview');
      if (previewEl) previewEl.innerHTML = '';
    } catch (err) {
      alert('送信に失敗しました: ' + err.message);
    }
  }

  document.addEventListener('cathub:user-loaded', (e) => {
    myUser = e.detail.user;
    if (myUser) {
      initSocket();
      renderTab();
      refreshNotificationBadge();
    }
  });
})();
