(function () {
  'use strict';
  const alertBox = document.getElementById('ch-alert');
  const btn = document.getElementById('login-submit-btn');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');

  async function doLogin() {
    alertBox.innerHTML = '';

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
      alertBox.innerHTML = '<div class="ch-alert error">ユーザー名とパスワードを入力してください</div>';
      return;
    }

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'ログイン中...';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alertBox.innerHTML = '<div class="ch-alert error">' + (data.error || 'ログインに失敗しました') + '</div>';
        btn.disabled = false;
        btn.textContent = originalLabel;
        return;
      }
      window.location.href = '/';
    } catch (err) {
      alertBox.innerHTML = '<div class="ch-alert error">通信エラーが発生しました: ' + err.message + '</div>';
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  btn.addEventListener('click', doLogin);
  // Enterキーでも送信できるようにする(フォームsubmitイベントには依存しない)
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doLogin();
    }
  });
})();
