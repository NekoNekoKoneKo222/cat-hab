import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js';
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js';

const message = document.querySelector('[data-auth-message]');
const setMessage = (text, error = true) => {
  if (!message) return;
  message.textContent = text;
  message.style.color = error ? '#ff8eae' : 'var(--green)';
};

let auth;
try {
  const response = await fetch('/api/config/firebase', { cache: 'no-store' });
  const payload = await response.json();
  if (!payload.enabled) throw new Error('Firebaseが未設定です。Renderの環境変数を設定してください。');
  auth = getAuth(initializeApp(payload.config));
} catch (error) {
  setMessage(error.message);
  document.querySelectorAll('[data-auth-submit]').forEach(button => button.disabled = true);
}

const loginForm = document.querySelector('[data-login-form]');
loginForm?.addEventListener('submit', async event => {
  event.preventDefault();
  setMessage('ログイン中…', false);
  const button = loginForm.querySelector('[data-auth-submit]');
  button.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, loginForm.email.value.trim(), loginForm.password.value);
    location.replace('/index.html');
  } catch (error) {
    setMessage(firebaseMessage(error.code));
    button.disabled = false;
  }
});

const registerForm = document.querySelector('[data-register-form]');
registerForm?.addEventListener('submit', async event => {
  event.preventDefault();
  setMessage('アカウント作成中…', false);
  const button = registerForm.querySelector('[data-auth-submit]');
  button.disabled = true;
  try {
    const credential = await createUserWithEmailAndPassword(
      auth,
      registerForm.email.value.trim(),
      registerForm.password.value
    );
    await updateProfile(credential.user, { displayName: registerForm.displayName.value.trim() });
    location.replace('/index.html');
  } catch (error) {
    setMessage(firebaseMessage(error.code));
    button.disabled = false;
  }
});

if (auth && document.body.dataset.auth === 'required') {
  onAuthStateChanged(auth, async user => {
    if (!user) return location.replace('/login.html');
    document.querySelectorAll('[data-user-name]').forEach(node => {
      node.textContent = user.displayName || user.email || 'User';
    });
    if (document.body.dataset.admin === 'required') {
      try {
        const response = await fetch('/api/admin/status', {
          headers: { Authorization: `Bearer ${await user.getIdToken()}` },
          cache: 'no-store'
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || '管理者情報を取得できません。');
        document.dispatchEvent(new CustomEvent('catHubAdminReady', { detail: payload }));
      } catch (error) {
        setMessage(error.message);
        document.querySelector('[data-admin-content]')?.setAttribute('hidden', '');
      }
    }
  });
}

document.querySelectorAll('[data-logout]').forEach(button => button.addEventListener('click', async event => {
  event.preventDefault();
  if (auth) await signOut(auth);
  location.replace('/login.html');
}));

function firebaseMessage(code) {
  const messages = {
    'auth/email-already-in-use': 'このメールアドレスは既に登録されています。',
    'auth/invalid-email': 'メールアドレスの形式が正しくありません。',
    'auth/invalid-credential': 'メールアドレスまたはパスワードが正しくありません。',
    'auth/weak-password': 'パスワードは6文字以上にしてください。',
    'auth/too-many-requests': '試行回数が多すぎます。しばらく待ってください。'
  };
  return messages[code] || '認証処理に失敗しました。もう一度お試しください。';
}
