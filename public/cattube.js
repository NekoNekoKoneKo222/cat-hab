(function () {
  'use strict';

  const form = document.getElementById('search-form');
  const input = document.getElementById('search-input');
  const alertBox = document.getElementById('search-alert');
  const grid = document.getElementById('results-grid');
  const playerCard = document.getElementById('player-card');
  const playerFrame = document.getElementById('player-frame');
  const playerTitle = document.getElementById('player-title');
  const playerChannel = document.getElementById('player-channel');
  const playerDesc = document.getElementById('player-desc');

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function showAlert(message) {
    alertBox.innerHTML = '<div class="ch-alert error">' + escapeHtml(message) + '</div>';
  }
  function clearAlert() {
    alertBox.innerHTML = '';
  }

  /**
   * YouTube URLから動画IDを抽出する。URLでなければnullを返す。
   * 対応形式: youtube.com/watch?v=, youtu.be/, youtube.com/embed/, youtube.com/shorts/
   */
  function parseYoutubeUrl(text) {
    let url;
    try {
      url = new URL(text);
    } catch (err) {
      return null;
    }
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return id || null;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (url.pathname === '/watch') {
        return url.searchParams.get('v');
      }
      const embedMatch = url.pathname.match(/^\/embed\/([a-zA-Z0-9_-]+)/);
      if (embedMatch) return embedMatch[1];
      const shortsMatch = url.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]+)/);
      if (shortsMatch) return shortsMatch[1];
    }
    return null;
  }

  function playVideo(videoId, fallbackTitle) {
    playerFrame.src = 'https://www.youtube.com/embed/' + encodeURIComponent(videoId) + '?rel=0';
    playerTitle.textContent = fallbackTitle || '';
    playerChannel.textContent = '';
    playerDesc.textContent = '';
    playerCard.style.display = 'block';
    playerCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

    fetch('/api/cattube/video/' + encodeURIComponent(videoId), { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        const v = data.video;
        playerTitle.textContent = v.title;
        playerChannel.textContent = v.channelTitle + (v.viewCount ? ' ・ 再生回数 ' + Number(v.viewCount).toLocaleString() : '');
        playerDesc.textContent = v.description || '';
      })
      .catch(() => {
        /* 詳細情報は補助的なものなので取得失敗しても致命的ではない */
      });
  }

  function renderResults(items) {
    grid.innerHTML = '';
    if (items.length === 0) {
      grid.innerHTML = '<p style="color:var(--ch-text-muted);">該当する動画が見つかりませんでした。</p>';
      return;
    }
    items.forEach((item) => {
      const tile = document.createElement('div');
      tile.className = 'ch-tile';
      tile.style.cursor = 'pointer';
      tile.innerHTML =
        '<img src="' + escapeHtml(item.thumbnail ? item.thumbnail.url : '') + '" alt="" style="width:100%; border-radius:8px; aspect-ratio:16/9; object-fit:cover;" />' +
        '<h3>' + escapeHtml(item.title) + '</h3>' +
        '<p>' + escapeHtml(item.channelTitle) + '</p>';
      tile.addEventListener('click', () => playVideo(item.videoId, item.title));
      grid.appendChild(tile);
    });
  }

  async function search(query) {
    clearAlert();
    grid.innerHTML = '<p style="color:var(--ch-text-muted);">検索中...</p>';
    try {
      const res = await fetch('/api/cattube/search?q=' + encodeURIComponent(query), {
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (!res.ok) {
        grid.innerHTML = '';
        showAlert(data.error || '検索に失敗しました');
        return;
      }
      renderResults(data.items);
    } catch (err) {
      grid.innerHTML = '';
      showAlert('検索に失敗しました: ' + err.message);
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    const videoId = parseYoutubeUrl(text);
    if (videoId) {
      clearAlert();
      grid.innerHTML = '';
      playVideo(videoId);
      return;
    }
    search(text);
  });
})();
