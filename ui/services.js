'use strict';
document.addEventListener('catHubAuthReady', async () => {
  const name = document.body.dataset.service;
  if (name) {
    const status = document.querySelector('[data-service-status]');
    try {
      const response = await fetch('/api/services', { cache: 'no-store' });
      if (!response.ok) throw new Error('接続情報を取得できません');
      const service = (await response.json())[name];
      if (!service?.configured) { status.textContent = 'サービスURLが未設定です。'; return; }
      const link = document.querySelector('[data-service-link]');
      link.href = service.url; link.hidden = false;
      const health = await fetch(`/api/services/${name}/health`, { cache: 'no-store' });
      status.textContent = health.ok ? 'サービスへ接続できました。' : 'サービスへの接続を確認できません。';
    } catch (error) { status.textContent = error.message; }
  }
  const form = document.querySelector('[data-proxy-form]');
  form?.addEventListener('submit', async e => {
    e.preventDefault(); const result = document.querySelector('[data-proxy-result]'); result.textContent = '取得中…';
    try { const response = await fetch('/api/proxy?url=' + encodeURIComponent(form.elements.namedItem('url').value), { cache: 'no-store' });
      const type = response.headers.get('content-type') || '';
      result.textContent = type.startsWith('image/') ? `画像を取得しました (${response.status})。` : await response.text();
    } catch (error) { result.textContent = error.message; }
  });
});
