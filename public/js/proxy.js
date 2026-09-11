(function () {
  'use strict';
  const form = document.getElementById('proxy-form');
  const alertBox = document.getElementById('proxy-alert');
  const frameCard = document.getElementById('proxy-frame-card');
  const frame = document.getElementById('proxy-frame');

  function loadUrl(url) {
    alertBox.innerHTML = '';
    frameCard.style.display = 'none';
    const proxied = '/api/proxy?url=' + encodeURIComponent(url);

    fetch(proxied, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || ('取得に失敗しました (HTTP ' + res.status + ')'));
        }
        frame.src = proxied;
        frameCard.style.display = 'block';
      })
      .catch((err) => {
        alertBox.innerHTML = '<div class="ch-alert error">' + CatHub.escapeHtml(err.message) + '</div>';
      });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = document.getElementById('target-url').value.trim();
    if (!url) return;
    loadUrl(url);
  });
})();
