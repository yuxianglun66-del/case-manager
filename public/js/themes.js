/* UI 主题预设 - 6 套精选（4 暗 + 2 亮），不求数量、只求特色：
 * 每套背景由「主色光晕 + 同色系渐变」两层构成，暗色有重点光效不死黑，亮色通透不刺白。
 * 运行时支持：管理员用它做全局切换（POST /api/settings 落库），员工仅本地 localStorage。
 * 这里仅管预设和"即时换肤"，保存动作由调用方决定。
 */
(function () {
  window.UI_THEMES = [
    {
      key: 'circuit-blue',
      name: '电路蓝',
      desc: '深海蓝渐变 + 顶部靛蓝光晕「电路板」气质',
      mode: 'dark',
      primary: '#3b82f6',
      sidebar: '#071022',
      bg: 'radial-gradient(1100px 520px at 18% -8%, rgba(59,130,246,.22), transparent 60%), radial-gradient(900px 500px at 85% 108%, rgba(37,132,252,.10), transparent 55%), linear-gradient(180deg, #04060f, #0c1f47 78%, #15356f 100%)',
      fg: '#e2e8f0',
      muted: '#8fa8c8',
    },
    {
      key: 'matrix-green',
      name: '矩阵绿',
      desc: '黑墨绿渐变 + 中央荧光绿光晕「终端」气质',
      mode: 'dark',
      primary: '#4ade80',
      sidebar: '#020a05',
      bg: 'radial-gradient(1000px 480px at 50% 0%, rgba(74,222,128,.12), transparent 60%), linear-gradient(180deg, #000000, #062315 55%, #0e4a24 100%)',
      fg: '#dcfce7',
      muted: '#86efac',
    },
    {
      key: 'sunset-amber',
      name: '落日橙',
      desc: '暗棕到焦糖渐变 + 右上落日光晕「余晖」气质',
      mode: 'dark',
      primary: '#f97316',
      sidebar: '#140a03',
      bg: 'radial-gradient(1000px 500px at 80% -6%, rgba(249,115,22,.18), transparent 58%), linear-gradient(180deg, #180b03, #4a2a08 75%, #6b3d0d 100%)',
      fg: '#ffedd5',
      muted: '#fdba74',
    },
    {
      key: 'plasma-purple',
      name: '霓虹紫',
      desc: '深空紫到靛蓝渐变 + 左上方紫光晕「等离子」气质',
      mode: 'dark',
      primary: '#a855f7',
      sidebar: '#0b051d',
      bg: 'radial-gradient(1000px 520px at 22% -10%, rgba(168,85,247,.20), transparent 60%), linear-gradient(180deg, #0a0418, #1a0f45 55%, #3d2a96 100%)',
      fg: '#eeebfe',
      muted: '#c4b5fd',
    },
    {
      key: 'clean-light',
      name: '明快浅色',
      desc: '浅蓝白渐变 + 右上角海军蓝光晕，通透不刺白',
      mode: 'light',
      primary: '#1d4ed8',
      sidebar: '#334155',
      bg: 'radial-gradient(1000px 460px at 80% -10%, rgba(29,78,216,.10), transparent 55%), linear-gradient(180deg, #eef2ff, #e7eefc 60%, #dbe5f9 100%)',
      fg: '#0f172a',
      muted: '#5b6b84',
    },
    {
      key: 'paper-amber',
      name: '羊皮纸',
      desc: '米色渐变 + 左上琥珀光晕，纸张护眼质感',
      mode: 'light',
      primary: '#b45309',
      sidebar: '#451a03',
      bg: 'radial-gradient(1000px 460px at 70% -8%, rgba(180,83,9,.10), transparent 55%), linear-gradient(180deg, #f5ecd8, #f6eeda 60%, #ecdfbe 100%)',
      fg: '#292524',
      muted: '#78716c',
    },
  ];

  function findTheme(key) {
    return window.UI_THEMES.find(t => t.key === key);
  }

  /* 即时将预设应用为当前主题（仅界面，不持久化）。需要 applyThemeContrast() (layout.ejs)。 */
  function applyThemeNow(theme) {
    if (!theme) return;
    const root = document.documentElement;
    root.style.setProperty('--bs-primary', theme.primary);
    root.style.setProperty('--sidebar-bg', theme.sidebar);
    root.style.setProperty('--body-bg-gradient', theme.bg);
    const mode = theme.mode || 'dark';
    if (mode === 'dark') {
      document.body.classList.add('theme-dark');
    } else {
      document.body.classList.remove('theme-dark');
    }
    if (typeof window.applyThemeContrast === 'function') window.applyThemeContrast();
  }

  /* 将 theme.primary / sidebar 写入设置页表单字段（如果当前正在设置页面）。 */
  function syncSettingsForm(theme) {
    if (!theme) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
    set('inpThemePrimary', theme.primary);
    set('inpThemeSidebar', theme.sidebar);
    set('inpThemeMode', theme.mode);
    set('inpBgGradient', theme.bg);
  }

  /* 返回当前激活的 theme key（读取 localStorage，回退至匹配 DB 默认值的项） */
  function currentKey() {
    const saved = localStorage.getItem('uiTheme');
    if (saved) return saved;
    const root = getComputedStyle(document.documentElement);
    const p = (root.getPropertyValue('--bs-primary') || '').trim();
    const s = (root.getPropertyValue('--sidebar-bg') || '').trim();
    const m = document.body.classList.contains('theme-dark') ? 'dark' : 'light';
    const exact = window.UI_THEMES.find(t => t.primary.toLowerCase() === (p||'').toLowerCase() && t.sidebar.toLowerCase() === (s||'').toLowerCase());
    return exact ? exact.key : (m === 'dark' ? 'circuit-blue' : 'clean-light');
  }

  /* 快速切换：非管理员只本地换肤（localStorage）；管理员可选 save=true 落库。返回 Promise。 */
  async function quickApplyTheme(themeKey, opts) {
    opts = opts || {};
    const theme = findTheme(themeKey);
    if (!theme) return;
    localStorage.setItem('uiTheme', themeKey);
    applyThemeNow(theme);
    syncSettingsForm(theme);
    document.querySelectorAll('[data-ui-theme]').forEach(el => {
      el.classList.toggle('active', el.dataset.uiTheme === themeKey);
    });
    if (opts.save) {
      const payload = {
        theme_mode: theme.mode,
        theme_primary: theme.primary,
        theme_sidebar: theme.sidebar,
        bg_gradient: theme.bg,
      };
      let saved = false;
      try {
        await window.postJSON('/api/settings', payload);
        saved = true;
      } catch (firstErr) {
        /* 会话/CSRF 失效时，刷新页面 CSRF token 后重试一次 */
        if (firstErr && (firstErr.message === 'CSRF 令牌无效' || firstErr.message === '未登录' || firstErr.message === '请求失败')) {
          try {
            const meta = document.querySelector('meta[name="csrf-token"]');
            const r = await fetch(location.href, { credentials: 'same-origin' });
            const html = await r.text();
            const m = html.match(/csrf-token[^>]*content="([^"]+)"/);
            if (m && meta) meta.setAttribute('content', m[1]);
            await window.postJSON('/api/settings', payload);
            saved = true;
          } catch (_) { /* 重试也失败，走下面的提示 */ }
        }
      }
      if (saved) {
        if (typeof window.toast === 'function') window.toast(`主题已切换为「${theme.name}」并设为默认`, 'success');
      } else {
        if (typeof window.toast === 'function') window.toast('本地已切换，但保存全局默认失败，请刷新页面后重试', 'warning');
      }
    } else {
      if (typeof window.toast === 'function') window.toast(`主题已切换为「${theme.name}」（仅自己本次会话）`, 'success');
    }
  }

  window.uiTheme = {
    list: window.UI_THEMES,
    find: findTheme,
    currentKey: currentKey,
    applyNow: applyThemeNow,
    quickApply: quickApplyTheme,
    syncForm: syncSettingsForm,
  };
})();