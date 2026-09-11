(function () {
  'use strict';
  const form = document.getElementById('register-form');
  const alertBox = document.getElementById('ch-alert');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    alertBox.innerHTML = '';
    const body = {
      username: document.getElementById('username').value.trim(),
      displayName: document.getElementById('displayName').value.trim(),
      password: document.getElementById('password').value,
    };
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        alertBox.innerHTML = '<div class="ch-alert error">' + (data.error || '登録に失敗しました') + '</div>';
        return;
      }
      window.location.href = '/';
    } catch (err) {
      alertBox.innerHTML = '<div class="ch-alert error">通信エラーが発生しました: ' + err.message + '</div>';
    }
  });
})();
