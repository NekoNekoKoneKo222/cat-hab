(function () {
  'use strict';

  const NAV_ITEMS = [
    { href: '/', key: 'home', label: 'ホーム' },
    { href: '/cattube.html', key: 'cattube', label: 'Cat Tube' },
    { href: '/cloudcat.html', key: 'cloudcat', label: 'Cloud Cat' },
    { href: '/playcat.html', key: 'playcat', label: 'Play Cat' },
    { href: '/proxy.html', key: 'proxy', label: 'Proxy' },
    { href: '/webvm.html', key: 'webvm', label: 'Web VM' },
    { href: '/notifications.html', key: 'notifications', label: '通知' },
    { href: '/profile.html', key: 'profile', label: 'プロフィール' },
  ];

  const ADMIN_ITEM = { href: '/admin.html', key: 'admin', label: 'Admin' };

  const CAT_MARK_SVG =
    '<svg class="ch-brand-mark" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M10 6L16 18H32L38 6L34 22C38 25 40 30 40 34C40 41 32.8 46 24 46C15.2 46 8 41 8 34C8 30 10 25 14 22L10 6Z" fill="currentColor"/>' +
    '<circle cx="18" cy="32" r="2.4" fill="#2e1a52"/>' +
    '<circle cx="30" cy="32" r="2.4" fill="#2e1a52"/>' +
    '</svg>';

  function iconFor(key) {
    // シンプルな幾何学アイコン(絵文字は使用しない)
    const paths = {
      home: 'M4 11L12 4L20 11V20H14V14H10V20H4V11Z',
      cattube: 'M4 6H20V18H4V6ZM10 9V15L15 12L10 9Z',
      cloudcat: 'M6 6H18V15H10L6 18V6Z',
      playcat: 'M4 9H10V6H14V9H20V15H14V18H10V15H4V9Z',
      proxy: 'M4 4H20V10H4V4ZM4 14H20V20H4V14Z',
      webvm: 'M4 5H20V15H4V5ZM9 19H15V17H9V19Z',
      notifications: 'M12 3C10 3 9 4.5 9 6.2C6.6 7 5 9 5 12V16L3 18V19H21V18L19 16V12C19 9 17.4 7 15 6.2C15 4.5 14 3 12 3ZM10 20C10 21.1 10.9 22 12 22C13.1 22 14 21.1 14 20H10Z',
      profile: 'M12 4C9.8 4 8 5.8 8 8C8 10.2 9.8 12 12 12C14.2 12 16 10.2 16 8C16 5.8 14.2 4 12 4ZM12 14C7.6 14 4 16.7 4 20V21H20V20C20 16.7 16.4 14 12 14Z',
      admin: 'M12 2L20 6V11C20 16 16.9 20.5 12 22C7.1 20.5 4 16 4 11V6L12 2ZM12 7A3 3 0 1 0 12 13A3 3 0 0 0 12 7Z',
    };
    const d = paths[key] || paths.home;
    return (
      '<svg class="ch-nav-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="' + d + '" fill="currentColor"/></svg>'
    );
  }

  function currentPath() {
    const p = window.location.pathname;
    if (p === '/' || p === '/index.html') return 'home';
    // "/webvm.html" -> "webvm" のようにファイル名部分だけを取り出してキーと比較する
    const match = p.match(/\/([^/]+)\.html$/);
    if (!match) return '';
    return match[1];
  }

  async function fetchMe() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      const data = await res.json();
      return data.user || null;
    } catch (err) {
      return null;
    }
  }

  function buildNavHtml(items, activeKey) {
    return items
      .map((item) => {
        const cls = item.key === activeKey ? 'active' : '';
        const badge = item.key === 'notifications' ? '<span id="ch-notif-badge" style="display:none; margin-left:auto; background:#e05a7a; color:#fff; border-radius:999px; font-size:0.72rem; padding:1px 7px;"></span>' : '';
        return (
          '<li><a class="' + cls + '" href="' + item.href + '">' +
          iconFor(item.key) + '<span>' + item.label + '</span>' + badge + '</a></li>'
        );
      })
      .join('');
  }

  async function fetchUnreadCount() {
    try {
      const res = await fetch('/api/notifications', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      updateNotifBadge(data.unreadCount);
    } catch (err) {
      /* noop */
    }
  }

  function updateNotifBadge(count) {
    const badge = document.getElementById('ch-notif-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  document.addEventListener('cathub:unread-count', (e) => updateNotifBadge(e.detail));

  async function renderNav() {
    const root = document.getElementById('ch-nav-root');
    if (!root) return;
    const user = await fetchMe();
    const activeKey = currentPath();
    const items = NAV_ITEMS.slice();
    if (user && user.isAdmin) items.push(ADMIN_ITEM);

    const userBlock = user
      ? '<div class="ch-user-chip"><span class="ch-user-avatar">' +
        (user.displayName || user.username).slice(0, 1).toUpperCase() +
        '</span><span>' + escapeHtml(user.displayName || user.username) + '</span></div>' +
        '<button class="ch-nav-btn" id="ch-logout-btn" type="button">ログアウト</button>'
      : '<a class="ch-btn" style="width:100%; justify-content:center;" href="/login.html">ログイン</a>';

    root.innerHTML =
      '<div class="ch-brand">' + CAT_MARK_SVG + '<span>Cat Hub</span></div>' +
      '<ul class="ch-nav-list">' + buildNavHtml(items, activeKey) + '</ul>' +
      '<div class="ch-nav-footer">' + userBlock + '</div>';

    const logoutBtn = document.getElementById('ch-logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
        window.location.href = '/login.html';
      });
    }

    document.dispatchEvent(new CustomEvent('cathub:user-loaded', { detail: { user } }));
    if (user) fetchUnreadCount();

    // ログイン必須ページで未ログインならリダイレクト
    if (!user && document.body.dataset.requireAuth === 'true') {
      window.location.href = '/login.html';
    }
    if (user && !user.isAdmin && document.body.dataset.requireAdmin === 'true') {
      window.location.href = '/';
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function setupMobileToggle() {
    const toggle = document.getElementById('ch-mobile-toggle');
    const nav = document.querySelector('.ch-nav');
    if (!toggle || !nav) return;
    toggle.addEventListener('click', () => nav.classList.toggle('open'));
  }

  window.CatHub = window.CatHub || {};
  window.CatHub.escapeHtml = escapeHtml;

  document.addEventListener('DOMContentLoaded', () => {
    renderNav();
    setupMobileToggle();
  });
})();
