(function () {
  'use strict';

  const grid = document.getElementById('games-grid');
  const detailCard = document.getElementById('game-detail-card');
  const searchForm = document.getElementById('game-search-form');
  const searchInput = document.getElementById('game-search-input');
  const categorySelect = document.getElementById('game-category-select');
  const favoritesBtn = document.getElementById('show-favorites-btn');

  function esc(str) {
    return window.CatHub ? window.CatHub.escapeHtml(str) : String(str);
  }

  function starLabel(avg) {
    const rounded = Math.round(avg);
    return '★'.repeat(rounded) + '☆'.repeat(5 - rounded);
  }

  async function loadGames(params) {
    grid.innerHTML = '<p style="color:var(--ch-text-muted);">読み込み中...</p>';
    const query = new URLSearchParams(params || {});
    const res = await fetch('/api/games?' + query.toString(), { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) {
      grid.innerHTML = '<div class="ch-alert error">' + esc(data.error || '取得に失敗しました') + '</div>';
      return;
    }
    renderGrid(data.games);
    updateCategoryOptions(data.games);
  }

  async function loadFavorites() {
    grid.innerHTML = '<p style="color:var(--ch-text-muted);">読み込み中...</p>';
    const res = await fetch('/api/games/favorites', { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) {
      grid.innerHTML = '<div class="ch-alert error">' + esc(data.error || '取得に失敗しました') + '</div>';
      return;
    }
    renderGrid(
      data.games.map((g) => ({
        id: g.id,
        title: g.title,
        description: g.description,
        category: g.category,
        avgRating: 0,
        ratingCount: 0,
        isFavorited: true,
      }))
    );
  }

  const seenCategories = new Set();
  function updateCategoryOptions(games) {
    games.forEach((g) => {
      if (g.category && !seenCategories.has(g.category)) {
        seenCategories.add(g.category);
        const opt = document.createElement('option');
        opt.value = g.category;
        opt.textContent = g.category;
        categorySelect.appendChild(opt);
      }
    });
  }

  function renderGrid(games) {
    grid.innerHTML = '';
    if (games.length === 0) {
      grid.innerHTML = '<p style="color:var(--ch-text-muted);">ゲームが見つかりませんでした。</p>';
      return;
    }
    games.forEach((g) => {
      const tile = document.createElement('div');
      tile.className = 'ch-tile';
      tile.innerHTML =
        '<h3 style="cursor:pointer;">' + esc(g.title) + '</h3>' +
        '<p>' + esc(g.category || '') + '</p>' +
        '<p style="color:#c9a227;">' + starLabel(g.avgRating) + ' (' + g.ratingCount + ')</p>' +
        '<button class="ch-btn secondary fav-btn" data-id="' + g.id + '" data-fav="' + g.isFavorited + '" type="button">' +
        (g.isFavorited ? 'お気に入り解除' : 'お気に入り追加') +
        '</button>';
      tile.querySelector('h3').addEventListener('click', () => openDetail(g.id));
      tile.querySelector('.fav-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        await toggleFavorite(g.id);
      });
      grid.appendChild(tile);
    });
  }

  async function toggleFavorite(gameId) {
    const res = await fetch('/api/games/' + gameId + '/favorite', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (res.ok) {
      loadGames({});
    }
  }

  async function openDetail(gameId) {
    detailCard.style.display = 'block';
    detailCard.innerHTML = '<p style="color:var(--ch-text-muted);">読み込み中...</p>';
    detailCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const res = await fetch('/api/games/' + gameId, { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) {
      detailCard.innerHTML = '<div class="ch-alert error">' + esc(data.error || '取得に失敗しました') + '</div>';
      return;
    }

    const g = data.game;
    detailCard.innerHTML =
      '<h2 style="margin-top:0; color:var(--ch-purple-dark);">' + esc(g.title) + '</h2>' +
      '<p style="color:var(--ch-text-muted);">' + esc(g.description || '') + '</p>' +
      '<div style="position:relative; padding-top:66%; background:#000; border-radius:10px; overflow:hidden; margin-bottom:14px;">' +
      '<iframe src="' + esc(g.url) + '" style="position:absolute; top:0; left:0; width:100%; height:100%; border:0;" allowfullscreen></iframe>' +
      '</div>' +
      '<div style="margin-bottom:14px;">' +
      '<label style="font-size:0.85rem; color:var(--ch-text-muted);">評価: </label>' +
      [1, 2, 3, 4, 5]
        .map(
          (n) =>
            '<span class="rate-star" data-n="' + n + '" style="cursor:pointer; font-size:1.3rem; color:' +
            (data.myRating && n <= data.myRating ? '#c9a227' : '#ccc') +
            ';">★</span>'
        )
        .join('') +
      ' <span style="font-size:0.82rem; color:var(--ch-text-muted);">平均 ' + Number(data.avgRating).toFixed(1) + ' (' + data.ratingCount + '件)</span>' +
      '</div>' +
      '<h3 style="color:var(--ch-purple-dark);">コメント</h3>' +
      '<form id="comment-form" class="ch-form" style="max-width:none; flex-direction:row; margin-bottom:14px;">' +
      '<input id="comment-input" type="text" placeholder="コメントを入力" style="flex:1; border:1px solid var(--ch-border); border-radius:10px; padding:10px;" maxlength="1000" />' +
      '<button class="ch-btn" type="submit">送信</button>' +
      '</form>' +
      '<div id="comments-list">' +
      data.comments
        .map(
          (c) =>
            '<div style="padding:8px 0; border-bottom:1px solid var(--ch-border);"><strong>' +
            esc(c.display_name) +
            '</strong> <span style="color:var(--ch-text-muted); font-size:0.85rem;">' +
            esc(c.content) +
            '</span></div>'
        )
        .join('') +
      '</div>';

    fetch('/api/games/' + gameId + '/history', { method: 'POST', credentials: 'same-origin' }).catch(() => {});

    detailCard.querySelectorAll('.rate-star').forEach((star) => {
      star.addEventListener('click', async () => {
        const n = Number(star.getAttribute('data-n'));
        await fetch('/api/games/' + gameId + '/rating', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ rating: n }),
        });
        openDetail(gameId);
      });
    });

    document.getElementById('comment-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('comment-input');
      const content = input.value.trim();
      if (!content) return;
      const cres = await fetch('/api/games/' + gameId + '/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ content }),
      });
      if (cres.ok) {
        input.value = '';
        openDetail(gameId);
      }
    });
  }

  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    loadGames({ q: searchInput.value.trim(), category: categorySelect.value });
  });
  categorySelect.addEventListener('change', () => {
    loadGames({ q: searchInput.value.trim(), category: categorySelect.value });
  });
  favoritesBtn.addEventListener('click', loadFavorites);

  document.addEventListener('DOMContentLoaded', () => loadGames({}));
})();
