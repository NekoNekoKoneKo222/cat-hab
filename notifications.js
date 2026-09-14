(function () {
  'use strict';
  const NOTIF_LABELS = {
    friend_request: (p) => (p.fromUsername || 'ユーザー') + ' さんからフレンド申請が届きました',
    friend_accept: (p) => (p.fromUsername || 'ユーザー') + ' さんとフレンドになりました',
    dm_message: (p) => (p.fromUsername || 'ユーザー') + ' さん: ' + (p.preview || ''),
  };

  async function loadNotifications() {
    const listEl = document.getElementById('notif-list');
    const res = await fetch('/api/notifications', { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) {
      listEl.innerHTML = '<div class="ch-alert error">' + CatHub.escapeHtml(data.error || '取得に失敗しました') + '</div>';
      return;
    }
    if (data.notifications.length === 0) {
      listEl.innerHTML = '<p style="color:var(--ch-text-muted);">通知はありません。</p>';
      return;
    }
    listEl.innerHTML = data.notifications
      .map((n) => {
        const labelFn = NOTIF_LABELS[n.type];
        const text = labelFn ? labelFn(n.payload || {}) : n.type;
        const time = new Date(n.created_at).toLocaleString('ja-JP');
        return (
          '<div style="padding:12px 0; border-bottom:1px solid var(--ch-border); ' +
          (n.is_read ? 'opacity:0.6;' : '') +
          '"><div>' + CatHub.escapeHtml(text) + '</div>' +
          '<div style="font-size:0.78rem; color:var(--ch-text-muted);">' + time + '</div></div>'
        );
      })
      .join('');
  }

  document.getElementById('mark-all-btn').addEventListener('click', async () => {
    await fetch('/api/notifications/read-all', { method: 'POST', credentials: 'same-origin' });
    loadNotifications();
    document.dispatchEvent(new CustomEvent('cathub:unread-count', { detail: 0 }));
  });

  document.addEventListener('cathub:user-loaded', (e) => {
    if (e.detail.user) loadNotifications();
  });
})();
