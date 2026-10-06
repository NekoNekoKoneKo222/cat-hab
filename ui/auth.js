const message = document.querySelector('[data-auth-message]');

function setMessage(text, error = true) {
  if (!message) return;
  message.textContent = text;
  message.style.color = error ? '#ff8eae' : 'var(--green)';
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  let payload = {};
  if (response.status !== 204) payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '通信に失敗しました。');
  return payload;
}

const loginForm = document.querySelector('[data-login-form]');
loginForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const button = loginForm.querySelector('[data-auth-submit]');
  button.disabled = true;
  setMessage('ログイン中…', false);
  try {
    await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: loginForm.username.value,
        password: loginForm.password.value
      })
    });
    location.replace('/index.html');
  } catch (error) {
    setMessage(error.message);
    button.disabled = false;
  }
});

const registerForm = document.querySelector('[data-register-form]');
registerForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const button = registerForm.querySelector('[data-auth-submit]');
  button.disabled = true;
  setMessage('アカウント作成中…', false);
  try {
    await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        displayName: registerForm.displayName.value,
        username: registerForm.username.value,
        password: registerForm.password.value
      })
    });
    location.replace('/index.html');
  } catch (error) {
    setMessage(error.message);
    button.disabled = false;
  }
});

if (document.body.dataset.auth === 'required') {
  try {
    const payload = await request('/api/auth/me', { method: 'GET' });
    document.querySelectorAll('[data-user-name]').forEach(node => {
      node.textContent = payload.user.displayName || payload.user.username;
    });
    if (document.body.dataset.admin === 'required') {
      if (!payload.isAdmin) throw new Error('管理者権限がありません。');
      const status = await request('/api/admin/status', { method: 'GET' });
      document.dispatchEvent(new CustomEvent('catHubAdminReady', { detail: status }));
    }
  } catch (error) {
    if (error.message === '管理者権限がありません。') {
      setMessage(error.message);
      document.querySelector('[data-admin-content]')?.setAttribute('hidden', '');
    } else {
      location.replace('/login.html');
    }
  }
}

document.querySelectorAll('[data-logout]').forEach(button => button.addEventListener('click', async event => {
  event.preventDefault();
  try {
    await request('/api/auth/logout', { method: 'POST', body: '{}' });
  } finally {
    location.replace('/login.html');
  }
}));
