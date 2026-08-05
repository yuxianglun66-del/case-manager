/* UI 主题预设 - 高对比、科技感成套主题
 * 运行时支持：管理员用它做全局切换（POST /api/settings 落库），员工仅本地 localStorage。
 * 这里仅管预设和"即时换肤"，保存动作由调用方决定。
 */
(function () {
  window.UI_THEMES = [
    {
      key: 'circuit-blue',
      name: '电路蓝',
      desc: '深空蓝底 + 电光蓝主色',
      mode: 'dark',
      primary: '#3b82f6',
      sidebar: '#080c18',
      bg: 'linear-gradient(180deg, #060a14, #0b1120 40%, #0f172a 100%)',
      fg: '#e2e8f0',
      muted: '#94a3b8',
    },
    {
      key: 'neon-cyan',
      name: '霓虹青',
      desc: '暗青底 + 高饱和霓虹青',
      mode: 'dark',
      primary: '#00e5ff',
      sidebar: '#001a22',
      bg: 'linear-gradient(180deg, #001a22, #002b36 45%, #003a4d 100%)',
      fg: '#cffafe',
      muted: '#67e8f9',
    },
    {
      key: 'matrix-green',
      name: '矩阵绿',
      desc: '全黑底 + 终端荧光绿',
      mode: 'dark',
      primary: '#22c55e',
      sidebar: '#000000',
      bg: 'linear-gradient(180deg, #000000, #0a1a0a 40%, #102410 100%)',
      fg: '#dcfce7',
      muted: '#86efac',
    },
    {
      key: 'sunset-amber',
      name: '落日橙',
      desc: '暗棕底 + 暖橙主色',
      mode: 'dark',
      primary: '#f59e0b',
      sidebar: '#1a1108',
      bg: 'linear-gradient(180deg, #1a1108, #2d2200 40%, #3d2c00 100%)',
      fg: '#fef3c7',
      muted: '#fcd34d',
    },
    {
      key: 'plasma-purple',
      name: '等离子紫',
      desc: '深空底 + 等离子蓝紫',
      mode: 'dark',
      primary: '#a855f7',
      sidebar: '#0b0820',
      bg: 'linear-gradient(180deg, #0b0820, #170d33 45%, #221a4f 100%)',
      fg: '#ede9fe',
      muted: '#c4b5fd',
    },
    {
      key: 'crimson-law',
      name: '律政红',
      desc: '深红底 + 法律红主色（高对比）',
      mode: 'dark',
      primary: '#ef4444',
      sidebar: '#170505',
      bg: 'linear-gradient(180deg, #0a0404, #1e0808 45%, #2d0e0e 100%)',
      fg: '#fee2e2',
      muted: '#fca5a5',
    },
    {
      key: 'clean-light',
      name: '明快浅色',
      desc: '亮白底 + 海军蓝主色（白天模式）',
      mode: 'light',
      primary: '#1d4ed8',
      sidebar: '#1e293b',
      bg: 'linear-gradient(180deg, #f1f5f9, #ffffff 40%, #e2e8f0 100%)',
      fg: '#0f172a',
      muted: '#475569',
    },
    {
      key: 'paper-amber',
      name: '羊皮纸',
      desc: '米色背景 + 墨绿主色（白天高对比）',
      mode: 'light',
      primary: '#15803d',
      sidebar: '#451a03',
      bg: 'linear-gradient(180deg, #faf5e6, #fdf6e3 40%, #f5efd8 100%)',
      fg: '#1c1917',
      muted: '#57534e',
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
