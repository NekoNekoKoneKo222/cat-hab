function show(id, text, isOk) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = isOk === true ? 'ok' : isOk === false ? 'ng' : '';
}

document.getElementById('btn-health').addEventListener('click', async () => {
  show('out-health', '実行中...');
  try {
    const res = await fetch('/healthz', { cache: 'no-store' });
    const text = await res.text();
    show('out-health', 'HTTP ' + res.status + '\n' + text, res.ok);
  } catch (err) {
    show('out-health', 'エラー: ' + err.message, false);
  }
});

document.getElementById('btn-register').addEventListener('click', async () => {
  show('out-register', '実行中...');
  const rand = 'debugtest' + Math.floor(Math.random() * 100000);
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ username: rand, password: 'password123' }),
    });
    const text = await res.text();
    show('out-register', 'ユーザー名: ' + rand + '\nパスワード: password123\nHTTP ' + res.status + '\n' + text, res.ok);
  } catch (err) {
    show('out-register', 'エラー(通信自体が失敗): ' + err.message, false);
  }
});

document.getElementById('btn-me').addEventListener('click', async () => {
  show('out-me', '実行中...');
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    const text = await res.text();
    show('out-me', 'HTTP ' + res.status + '\n' + text, res.ok);
  } catch (err) {
    show('out-me', 'エラー: ' + err.message, false);
  }
});

document.getElementById('btn-login').addEventListener('click', async () => {
  show('out-login', '実行中...');
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ username, password }),
    });
    const text = await res.text();
    show('out-login', 'HTTP ' + res.status + '\n' + text, res.ok);
  } catch (err) {
    show('out-login', 'エラー(通信自体が失敗): ' + err.message, false);
  }
});

document.getElementById('btn-cookie').addEventListener('click', () => {
  show('out-cookie', document.cookie || '(Cookieが1つもありません)');
});
