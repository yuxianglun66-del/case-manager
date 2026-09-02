/* UI 主题预设 - 精简为 6 套高区分度配色（每套取不同色相，避免相近难辨）
 * 运行时支持：管理员用它做全局切换（POST /api/settings 落库），员工仅本地 localStorage。
 * 这里仅管预设和"即时换肤"，保存动作由调用方决定。
 */
(function () {
  window.UI_THEMES = [
    {
      key: 'circuit-blue',
      name: '电路蓝',
      desc: '深海蓝底 + 电光蓝主色',
      mode: 'dark',
      primary: '#3b82f6',
      sidebar: '#071022',
      bg: 'linear-gradient(180deg, #050a18, #0a1428 45%, #101e3a 100%)',
      fg: '#e2e8f0',
      muted: '#8fa8c8',
    },
    {
      key: 'matrix-green',
      name: '矩阵绿',
      desc: '全黑底 + 终端荧光绿',
      mode: 'dark',
      primary: '#4ade80',
      sidebar: '#000000',
      bg: 'linear-gradient(180deg, #000000, #0a1f10 45%, #0e2a15 100%)',
      fg: '#dcfce7',
      muted: '#86efac',
    },
    {
      key: 'sunset-amber',
      name: '落日橙',
      desc: '暗棕底 + 高饱和橙主色',
      mode: 'dark',
      primary: '#f97316',
      sidebar: '#160a02',
      bg: 'linear-gradient(180deg, #170b04, #2b1404 45%, #3d1d05 100%)',
      fg: '#ffedd5',
      muted: '#fdba74',
    },
    {
      key: 'plasma-purple',
      name: '霓虹紫',
      desc: '深空底 + 高饱和紫主色',
      mode: 'dark',
      primary: '#a855f7',
      sidebar: '#0d0725',
      bg: 'linear-gradient(180deg, #0d0725, #190e3f 45%, #251857 100%)',
      fg: '#eeebfe',
      muted: '#c4b5fd',
    },
    {
      key: 'clean-light',
      name: '明快浅色',
      desc: '亮白底 + 海军蓝主色（白天模式）',
      mode: 'light',
      primary: '#1d4ed8',
      sidebar: '#334155',
      bg: 'linear-gradient(180deg, #eef2ff, #ffffff 45%, #e2e8f0 100%)',
      fg: '#0f172a',
      muted: '#5b6b84',
    },
    {
      key: 'paper-amber',
      name: '羊皮纸',
      desc: '米色背景 + 琥珀棕主色（白天高对比）',
      mode: 'light',
      primary: '#b45309',
      sidebar: '#451a03',
      bg: 'linear-gradient(180deg, #faf5e6, #fdf6e3 45%, #f5efd8 100%)',
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
      try {
        await window.postJSON('/api/settings', {
          theme_mode: theme.mode,
          theme_primary: theme.primary,
          theme_sidebar: theme.sidebar,
          bg_gradient: theme.bg,
        });
        if (typeof window.toast === 'function') window.toast(`主题已切换为「${theme.name}」并设为默认`, 'success');
      } catch (err) {
        if (typeof window.toast === 'function') window.toast('本地已切换，但保存全局默认失败：' + err.message, 'warning');
        throw err;
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
