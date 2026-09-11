(function () {
  'use strict';
  const form = document.getElementById('login-form');
  const alertBox = document.getElementById('ch-alert');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    alertBox.innerHTML = '';
    const body = {
      username: document.getElementById('username').value.trim(),
      password: document.getElementById('password').value,
    };
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        alertBox.innerHTML = '<div class="ch-alert error">' + (data.error || 'ログインに失敗しました') + '</div>';
        return;
      }
      window.location.href = '/';
    } catch (err) {
      alertBox.innerHTML = '<div class="ch-alert error">通信エラーが発生しました: ' + err.message + '</div>';
    }
  });
})();
