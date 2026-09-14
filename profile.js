(function () {
  'use strict';
  document.addEventListener('cathub:user-loaded', (e) => {
    const user = e.detail.user;
    const card = document.getElementById('profile-card');
    if (!user) return;
    card.innerHTML =
      '<p><strong>ユーザー名:</strong> ' + CatHub.escapeHtml(user.username) + '</p>' +
      '<p><strong>表示名:</strong> ' + CatHub.escapeHtml(user.displayName) + '</p>' +
      '<p><strong>権限:</strong> ' + (user.isAdmin ? '管理者' : '一般ユーザー') + '</p>';
  });
})();
