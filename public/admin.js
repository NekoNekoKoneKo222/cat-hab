(function () {
  'use strict';
  async function loadSettings() {
    const res = await fetch('/api/admin/settings', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();

    document.getElementById('vm-settings').innerHTML =
      '<p><strong>有効:</strong> ' + (data.vm.enabled ? 'はい' : 'いいえ') + '</p>' +
      '<p><strong>ISO URL:</strong> ' + CatHub.escapeHtml(data.vm.isoUrl || '(未設定)') + '</p>' +
      '<p><strong>メモリ上限:</strong> ' + data.vm.memoryMb + ' MB</p>' +
      '<p><strong>CPU数:</strong> ' + data.vm.cpuCount + '</p>' +
      '<p><strong>ISO最大サイズ:</strong> ' + data.vm.maxIsoSizeMb + ' MB</p>' +
      '<p><strong>VM用Proxy許可リスト件数:</strong> ' + data.vm.networkProxyAllowlistCount + '</p>';

    document.getElementById('proxy-settings').innerHTML =
      '<p><strong>許可ホスト数:</strong> ' + data.proxy.allowedHostsCount + '</p>';

    document.getElementById('youtube-settings').innerHTML =
      '<p><strong>APIキー設定済み:</strong> ' + (data.youtube.apiKeyConfigured ? 'はい' : 'いいえ') + '</p>';
  }
  document.addEventListener('cathub:user-loaded', (e) => {
    if (e.detail.user && e.detail.user.isAdmin) loadSettings();
  });
})();
