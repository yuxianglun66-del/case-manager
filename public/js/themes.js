/* UI 主题预设 - 8 套（4 暗 + 4 亮），每套背景采用同色系渐变营造过渡层次，
 * 暗色之间、亮色之间色相/明度拉开差异；亮色不落纯白，暗色不落纯黑。
 * 运行时支持：管理员用它做全局切换（POST /api/settings 落库），员工仅本地 localStorage。
 * 这里仅管预设和"即时换肤"，保存动作由调用方决定。
 */
(function () {
  window.UI_THEMES = [
    {
      key: 'circuit-blue',
      name: '电路蓝',
      desc: '深海蓝底（深→提亮渐变）+ 电光蓝主色',
      mode: 'dark',
      primary: '#3b82f6',
      sidebar: '#071022',
      bg: 'linear-gradient(180deg, #04060f, #081226 40%, #0c1f47 75%, #12306b 100%)',
      fg: '#e2e8f0',
      muted: '#8fa8c8',
    },
    {
      key: 'matrix-green',
      name: '矩阵绿',
      desc: '黑→墨绿渐变底 + 终端荧光绿',
      mode: 'dark',
      primary: '#4ade80',
      sidebar: '#020a05',
      bg: 'linear-gradient(180deg, #000000, #04220f 45%, #0b4a1d 75%, #15703a 100%)',
      fg: '#dcfce7',
      muted: '#86efac',
    },
    {
      key: 'sunset-amber',
      name: '落日橙',
      desc: '暗棕→焦糖渐变底 + 高饱和橙主色',
      mode: 'dark',
      primary: '#f97316',
      sidebar: '#140a03',
      bg: 'linear-gradient(180deg, #150a03, #2c1a06 40%, #4a2a08 70%, #6b3d0d 100%)',
      fg: '#ffedd5',
      muted: '#fdba74',
    },
    {
      key: 'plasma-purple',
      name: '霓虹紫',
      desc: '深空紫→靛蓝渐变底 + 高饱和紫主色',
      mode: 'dark',
      primary: '#a855f7',
      sidebar: '#0b051d',
      bg: 'linear-gradient(180deg, #0a0418, #1a0f45 40%, #2a1a6b 70%, #3d2a96 100%)',
      fg: '#eeebfe',
      muted: '#c4b5fd',
    },
    {
      key: 'clean-light',
      name: '明快浅色',
      desc: '浅蓝白渐变底（非纯白）+ 海军蓝主色',
      mode: 'light',
      primary: '#1d4ed8',
      sidebar: '#334155',
      bg: 'linear-gradient(180deg, #eef2ff, #f5f8ff 45%, #dfe8fb 100%)',
      fg: '#0f172a',
      muted: '#5b6b84',
    },
    {
      key: 'paper-amber',
      name: '羊皮纸',
      desc: '米色渐变底 + 琥珀棕主色（白天护眼）',
      mode: 'light',
      primary: '#b45309',
      sidebar: '#451a03',
      bg: 'linear-gradient(180deg, #f5ecd8, #fbf4e3 45%, #efe3c6 100%)',
      fg: '#292524',
      muted: '#78716c',
    },
    {
      key: 'frost-cyan',
      name: '晨雾青',
      desc: '淡青白渐变底 + 青蓝主色',
      mode: 'light',
      primary: '#0891b2',
      sidebar: '#164e63',
      bg: 'linear-gradient(180deg, #ecfeff, #f4fdff 45%, #d7f3f8 100%)',
      fg: '#083344',
      muted: '#35707e',
    },
    {
      key: 'blush-pink',
      name: '蜜桃粉',
      desc: '淡粉白渐变底 + 玫红主色',
      mode: 'light',
      primary: '#db2777',
      sidebar: '#701a34',
      bg: 'linear-gradient(180deg, #fff1f2, #fff7f8 45%, #ffdbe0 100%)',
      fg: '#4c0519',
      muted: '#a35a70',
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