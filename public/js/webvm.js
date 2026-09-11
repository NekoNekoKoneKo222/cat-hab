(function () {
  'use strict';

  const STATE = {
    STOPPED: 'stopped',
    LOADING: 'loading',
    BOOTING: 'booting',
    RUNNING: 'running',
    PAUSED: 'paused',
    ERROR: 'error',
  };

  const STATE_LABEL = {
    stopped: '停止中',
    loading: '読み込み中',
    booting: '起動中',
    running: '実行中',
    paused: '一時停止中',
    error: 'エラー',
  };

  let emulator = null;
  let currentState = STATE.STOPPED;
  let vmConfig = null;
  let destroyRequested = false;

  const el = {
    startBtn: document.getElementById('vm-start-btn'),
    stopBtn: document.getElementById('vm-stop-btn'),
    restartBtn: document.getElementById('vm-restart-btn'),
    pauseBtn: document.getElementById('vm-pause-btn'),
    fullscreenBtn: document.getElementById('vm-fullscreen-btn'),
    keyboardToggleBtn: document.getElementById('vm-keyboard-toggle-btn'),
    stateBadge: document.getElementById('vm-state-badge'),
    stateText: document.getElementById('vm-state-text'),
    alert: document.getElementById('vm-alert'),
    progressWrap: document.getElementById('vm-progress-wrap'),
    progressBar: document.getElementById('vm-progress-bar'),
    isoLabel: document.getElementById('vm-iso-label'),
    memoryLabel: document.getElementById('vm-memory-label'),
    screenContainer: document.getElementById('vm-screen-container'),
    placeholder: document.getElementById('vm-placeholder'),
    keyboardPanel: document.getElementById('vm-keyboard-panel'),
    hiddenInput: document.getElementById('vm-hidden-input'),
    textKey: document.getElementById('vm-text-key'),
  };

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function showAlert(message, type) {
    el.alert.innerHTML = '<div class="ch-alert ' + (type || 'error') + '">' + escapeHtml(message) + '</div>';
  }

  function clearAlert() {
    el.alert.innerHTML = '';
  }

  function setState(state, opts) {
    currentState = state;
    el.stateBadge.className = 'ch-vm-state ' + state;
    el.stateText.textContent = (opts && opts.label) || STATE_LABEL[state] || state;

    el.startBtn.disabled = !(state === STATE.STOPPED || state === STATE.ERROR);
    el.stopBtn.disabled = state === STATE.STOPPED;
    el.restartBtn.disabled = !(state === STATE.RUNNING || state === STATE.PAUSED || state === STATE.BOOTING);
    el.pauseBtn.disabled = !(state === STATE.RUNNING || state === STATE.PAUSED);
    el.pauseBtn.textContent = state === STATE.PAUSED ? '再開' : '一時停止';
    el.fullscreenBtn.disabled = !(state === STATE.RUNNING || state === STATE.PAUSED);

    if (state !== STATE.LOADING) {
      el.progressWrap.style.display = 'none';
    }
  }

  function setProgress(loaded, total) {
    el.progressWrap.style.display = 'block';
    if (total > 0) {
      const pct = Math.min(100, Math.round((loaded / total) * 100));
      el.progressBar.style.width = pct + '%';
    }
  }

  async function loadPublicConfig() {
    const res = await fetch('/api/config/public', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('設定の取得に失敗しました');
    return res.json();
  }

  /**
   * ISOへの到達可能性を事前確認する。
   * CORS等でHEADが失敗する場合もあるため、失敗時はGET(Range)でも試す。
   */
  async function preflightIso(url) {
    try {
      const headRes = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (headRes.ok) {
        const len = headRes.headers.get('content-length');
        return { ok: true, size: len ? Number(len) : null };
      }
      if (headRes.status === 404) {
        return { ok: false, reason: 'ISOファイルが見つかりません(404)' };
      }
      // HEADが許可されていないサーバーもあるためGETでも試す
    } catch (err) {
      // HEAD自体が失敗(CORS等) -> GETで再確認
    }

    try {
      const getRes = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        cache: 'no-store',
      });
      if (getRes.ok || getRes.status === 206) {
        const len = getRes.headers.get('content-range');
        return { ok: true, size: null, note: len ? undefined : undefined };
      }
      if (getRes.status === 404) {
        return { ok: false, reason: 'ISOファイルが見つかりません(404)' };
      }
      return { ok: false, reason: 'ISOの取得に失敗しました(HTTP ' + getRes.status + ')' };
    } catch (err) {
      return {
        ok: false,
        reason: 'ISOへ接続できませんでした(ネットワークエラーまたはCORS制限の可能性があります)',
      };
    }
  }

  function resetScreenContainer() {
    el.screenContainer.innerHTML =
      '<div style="white-space: pre; font: 14px monospace; line-height: 14px; color:#cdbdea;"></div>' +
      '<canvas style="display:none;"></canvas>';
  }

  function cleanupEmulator() {
    if (emulator) {
      try {
        emulator.destroy();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[webvm] destroy中にエラー', err);
      }
      emulator = null;
    }
    resetScreenContainer();
    el.placeholder && el.placeholder.remove();
  }

  async function startVm() {
    if (typeof window.V86 === 'undefined') {
      setState(STATE.ERROR);
      showAlert('お使いのブラウザはVMエンジン(WebAssembly/V86)をサポートしていません');
      return;
    }
    if (typeof WebAssembly === 'undefined') {
      setState(STATE.ERROR);
      showAlert('お使いのブラウザはWebAssemblyに対応していません');
      return;
    }

    clearAlert();
    setState(STATE.LOADING, { label: 'ISO確認中' });

    if (!vmConfig || !vmConfig.vmIsoUrl) {
      setState(STATE.ERROR);
      showAlert('VM_ISO_URLが設定されていません(管理者に確認してください)');
      return;
    }

    const preflight = await preflightIso(vmConfig.vmIsoUrl);
    if (!preflight.ok) {
      setState(STATE.ERROR);
      showAlert('ISOを読み込めませんでした: ' + preflight.reason);
      // eslint-disable-next-line no-console
      console.error('[webvm] ISO preflight failed:', preflight.reason);
      return;
    }
    if (
      preflight.size &&
      vmConfig.vmMaxIsoSizeMb &&
      preflight.size > vmConfig.vmMaxIsoSizeMb * 1024 * 1024
    ) {
      setState(STATE.ERROR);
      showAlert(
        'ISOサイズが上限(' + vmConfig.vmMaxIsoSizeMb + 'MB)を超えています。端末によっては動作しません。'
      );
      return;
    }

    setState(STATE.LOADING, { label: '起動準備中' });
    resetScreenContainer();

    const memoryBytes = (vmConfig.vmMemoryMb || 512) * 1024 * 1024;

    try {
      emulator = new window.V86({
        bios: { url: '/vm/bios/seabios.bin' },
        vga_bios: { url: '/vm/bios/vgabios.bin' },
        cdrom: preflight.size
          ? { url: vmConfig.vmIsoUrl, async: true, size: preflight.size }
          : { url: vmConfig.vmIsoUrl },
        memory_size: memoryBytes,
        vga_memory_size: 8 * 1024 * 1024,
        screen_container: el.screenContainer,
        autostart: false,
        disable_keyboard: false,
        disable_mouse: false,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[webvm] V86初期化エラー', err);
      setState(STATE.ERROR);
      showAlert('VMの初期化に失敗しました(メモリ不足の可能性があります): ' + err.message);
      return;
    }

    destroyRequested = false;

    emulator.add_listener('download-progress', (e) => {
      if (currentState === STATE.LOADING) setProgress(e.loaded, e.total);
    });

    emulator.add_listener('download-error', (e) => {
      // eslint-disable-next-line no-console
      console.error('[webvm] download-error', e);
      setState(STATE.ERROR);
      showAlert('ISOを読み込めませんでした');
      cleanupEmulator();
    });

    emulator.add_listener('emulator-ready', () => {
      if (!destroyRequested) setState(STATE.BOOTING);
    });

    emulator.add_listener('emulator-started', () => {
      if (!destroyRequested) setState(STATE.RUNNING);
    });

    emulator.add_listener('emulator-stopped', () => {
      if (destroyRequested) return;
      // stop()呼び出しによる一時停止、またはエラー以外での停止
      if (currentState === STATE.RUNNING || currentState === STATE.BOOTING) {
        setState(STATE.PAUSED);
      }
    });

    try {
      await emulator.run();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[webvm] run()エラー', err);
      setState(STATE.ERROR);
      showAlert('VMの起動に失敗しました: ' + err.message);
      cleanupEmulator();
    }
  }

  async function stopVm() {
    destroyRequested = true;
    cleanupEmulator();
    setState(STATE.STOPPED);
    clearAlert();
  }

  async function restartVm() {
    if (!emulator) {
      return startVm();
    }
    setState(STATE.BOOTING, { label: '再起動中' });
    try {
      emulator.restart();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[webvm] restart()エラー', err);
      setState(STATE.ERROR);
      showAlert('再起動に失敗しました: ' + err.message);
    }
  }

  async function togglePause() {
    if (!emulator) return;
    if (currentState === STATE.RUNNING) {
      try {
        await emulator.stop();
        setState(STATE.PAUSED);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[webvm] stop()エラー', err);
      }
    } else if (currentState === STATE.PAUSED) {
      try {
        await emulator.run();
        setState(STATE.RUNNING);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[webvm] run()再開エラー', err);
      }
    }
  }

  function toggleFullscreen() {
    if (!emulator) return;
    try {
      emulator.screen_go_fullscreen();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[webvm] fullscreenエラー', err);
      // フォールバック: コンテナ自体のFullscreen APIを試みる
      const wrap = document.querySelector('.ch-vm-screen-wrap');
      if (wrap && wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {});
    }
  }

  // --- 仮想キーボード ---
  const activeModifiers = new Set(); // 例: 'ControlLeft'

  function dispatchKey(type, codeName, extra) {
    const opts = Object.assign(
      {
        code: codeName,
        key: extra && extra.key ? extra.key : codeName,
        keyCode: extra && extra.keyCode ? extra.keyCode : 0,
        bubbles: true,
        ctrlKey: activeModifiers.has('ControlLeft'),
        altKey: activeModifiers.has('AltLeft'),
        shiftKey: activeModifiers.has('ShiftLeft'),
      },
      extra || {}
    );
    const event = new KeyboardEvent(type, opts);
    window.dispatchEvent(event);
  }

  function tapKey(codeName, extra) {
    dispatchKey('keydown', codeName, extra);
    setTimeout(() => dispatchKey('keyup', codeName, extra), 40);
  }

  function setupVirtualKeyboard() {
    document.querySelectorAll('.ch-vm-key[data-key]').forEach((keyEl) => {
      const codeName = keyEl.getAttribute('data-key');
      if (codeName === '_text') return;
      keyEl.addEventListener('click', () => tapKey(codeName));
    });

    document.querySelectorAll('.ch-vm-key[data-mod]').forEach((modEl) => {
      const modName = modEl.getAttribute('data-mod');
      modEl.addEventListener('click', () => {
        if (activeModifiers.has(modName)) {
          activeModifiers.delete(modName);
          modEl.classList.remove('active-mod');
          dispatchKey('keyup', modName);
        } else {
          activeModifiers.add(modName);
          modEl.classList.add('active-mod');
          dispatchKey('keydown', modName);
        }
      });
    });

    // 通常文字入力: 非表示textareaにiPad等のソフトキーボードで入力してもらい、
    // 差分文字を合成キーイベントとして転送する。
    let lastValue = '';
    el.textKey.addEventListener('click', () => {
      el.hiddenInput.value = '';
      lastValue = '';
      el.hiddenInput.focus();
    });

    el.hiddenInput.addEventListener('input', () => {
      const value = el.hiddenInput.value;
      if (value.length > lastValue.length) {
        const added = value.slice(lastValue.length);
        for (const ch of added) {
          sendChar(ch);
        }
      } else if (value.length < lastValue.length) {
        tapKey('Backspace');
      }
      lastValue = value;
      // 溜め込みすぎないよう定期的にリセット
      if (el.hiddenInput.value.length > 20) {
        el.hiddenInput.value = '';
        lastValue = '';
      }
    });
  }

  const CHAR_KEY_MAP = {
    ' ': { code: 'Space', key: ' ', keyCode: 32 },
    '\n': { code: 'Enter', key: 'Enter', keyCode: 13 },
  };

  function charKeyInfo(ch) {
    if (CHAR_KEY_MAP[ch]) return CHAR_KEY_MAP[ch];
    const upper = ch.toUpperCase();
    if (/[a-zA-Z]/.test(ch)) {
      return { code: 'Key' + upper, key: ch, keyCode: upper.charCodeAt(0), shiftKey: ch !== ch.toLowerCase() };
    }
    if (/[0-9]/.test(ch)) {
      return { code: 'Digit' + ch, key: ch, keyCode: ch.charCodeAt(0) };
    }
    // その他記号はkeyのみ設定し、v86側のtranslated key処理に委ねる
    return { code: 'Unidentified', key: ch, keyCode: ch.charCodeAt(0) };
  }

  function sendChar(ch) {
    const info = charKeyInfo(ch);
    dispatchKey('keydown', info.code, { key: info.key, keyCode: info.keyCode, shiftKey: !!info.shiftKey });
    dispatchKey('keypress', info.code, { key: info.key, keyCode: info.keyCode, shiftKey: !!info.shiftKey });
    setTimeout(() => {
      dispatchKey('keyup', info.code, { key: info.key, keyCode: info.keyCode, shiftKey: !!info.shiftKey });
    }, 30);
  }

  // --- 長押し=右クリック相当 (タッチ端末向け) ---
  function setupLongPressRightClick() {
    let pressTimer = null;
    let longPressFired = false;
    let startX = 0;
    let startY = 0;

    el.screenContainer.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) return;
        longPressFired = false;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        pressTimer = setTimeout(() => {
          longPressFired = true;
          const opts = { clientX: startX, clientY: startY, button: 2, bubbles: true };
          window.dispatchEvent(new MouseEvent('mousedown', opts));
          window.dispatchEvent(new MouseEvent('mouseup', opts));
          window.dispatchEvent(new MouseEvent('contextmenu', opts));
        }, 550);
      },
      { passive: true }
    );

    el.screenContainer.addEventListener('touchmove', (e) => {
      if (!e.touches[0]) return;
      const dx = Math.abs(e.touches[0].clientX - startX);
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dx > 12 || dy > 12) clearTimeout(pressTimer);
    });

    el.screenContainer.addEventListener('touchend', (e) => {
      clearTimeout(pressTimer);
      if (longPressFired) {
        e.preventDefault();
      }
    });
  }

  // --- 破棄処理: リソースリークを防ぐ ---
  function setupCleanupHandlers() {
    window.addEventListener('pagehide', () => {
      destroyRequested = true;
      if (emulator) {
        try {
          emulator.destroy();
        } catch (err) {
          /* noop */
        }
      }
    });
    document.addEventListener('visibilitychange', () => {
      // タブが非表示になっても即destroyはしない(一時停止のみ許容)。
      // ページ自体が閉じられる場合はpagehideで確実に解放する。
    });
  }

  async function init() {
    setState(STATE.STOPPED);
    try {
      vmConfig = await loadPublicConfig();
    } catch (err) {
      showAlert('設定の取得に失敗しました: ' + err.message);
      return;
    }

    if (!vmConfig.vmEnabled) {
      setState(STATE.ERROR);
      showAlert('Web VM機能は現在無効化されています(管理者設定)');
      el.startBtn.disabled = true;
      return;
    }

    el.isoLabel.textContent = vmConfig.vmIsoUrl || '(未設定)';
    el.memoryLabel.textContent = (vmConfig.vmMemoryMb || 512) + ' MB';

    el.startBtn.addEventListener('click', startVm);
    el.stopBtn.addEventListener('click', stopVm);
    el.restartBtn.addEventListener('click', restartVm);
    el.pauseBtn.addEventListener('click', togglePause);
    el.fullscreenBtn.addEventListener('click', toggleFullscreen);
    el.keyboardToggleBtn.addEventListener('click', () => {
      const visible = el.keyboardPanel.style.display !== 'none';
      el.keyboardPanel.style.display = visible ? 'none' : 'flex';
    });

    setupVirtualKeyboard();
    setupLongPressRightClick();
    setupCleanupHandlers();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
