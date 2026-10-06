document.addEventListener('catHubAdminReady', event => {
  document.querySelector('[data-auth-message]').textContent = '管理者として認証されました。';
  document.querySelector('[data-auth-message]').style.color = 'var(--green)';
  document.querySelector('[data-admin-content]').hidden = false;
  document.querySelector('[data-uptime]').textContent = Math.floor(event.detail.uptimeSeconds / 60) + '分';
  const list = document.querySelector('[data-services]');
  event.detail.services.forEach(name => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.textContent = name;
    list.append(item);
  });
});
