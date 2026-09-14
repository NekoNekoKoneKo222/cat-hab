(function () {
  'use strict';
  const alertBox = document.getElementById('ch-alert');
  const btn = document.getElementById('register-submit-btn');
  const usernameInput = document.getElementById('username');
  const displayNameInput = document.getElementById('displayName');
  const passwordInput = document.getElementById('password');

  async function doRegister() {
    alertBox.innerHTML = '';

    const username = usernameInput.value.trim();
    const displayName = displayNameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
      alertBox.innerHTML = '<div class="ch-alert error">ユーザー名とパスワードを入力してください</div>';
      return;
    }

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = '登録中...';

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ username, displayName, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alertBox.innerHTML = '<div class="ch-alert error">' + (data.error || '登録に失敗しました') + '</div>';
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

  btn.addEventListener('click', doRegister);
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doRegister();
    }
  });
})();
