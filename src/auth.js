const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
const { hasPermission, ROLES } = require('./permissions');
const { audit } = require('./audit');
const { sendSecurityAlert } = require('./wecom');
const isProd = process.env.NODE_ENV === 'production';

// 密码复杂度：至少 8 位，且必须同时包含字母和数字
function validatePasswordStrength(pw) {
  if (!pw || pw.length < 8) return '密码至少 8 位';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return '密码必须同时包含字母和数字';
  return null;
}

// 登录失败锁定策略：连续 5 次失败锁定 15 分钟
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MINUTES = 15;

// 用户不存在时对比的假哈希：与真实 bcrypt.compare 耗时对齐，消除「用户是否存在」的时序侧信道
const DUMMY_PASSWORD_HASH = '$2a$10$Bt17JhxGIjJIOzk06u7Toe9NPBhC2sMNV8OANpZpr0.o0StLFVig2';

// 记录一次登录失败；达到阈值则写入锁定时间（锁定到期后自动归零重新计数）
async function recordLoginFailure(username) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO login_attempts (username, fail_count)
       VALUES ($1, 1)
       ON CONFLICT (username) DO UPDATE SET
         fail_count = CASE
           WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until < now() THEN 1
           ELSE login_attempts.fail_count + 1 END,
         locked_until = CASE
           WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until < now() THEN NULL
           WHEN (CASE
             WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until < now() THEN 1
             ELSE login_attempts.fail_count + 1 END) >= $2
           THEN now() + ($3 || ' minutes')::interval
           ELSE NULL END,
         updated_at = now()
       RETURNING fail_count, locked_until`,
      [username, LOGIN_MAX_FAILS, LOGIN_LOCK_MINUTES]
    );
    return rows[0] || null;
  } catch (e) {
    console.error('[auth] recordLoginFailure error:', e.message);
    return null;
  }
}

function createAuthRouter(loginLimiter) {
  const router = express.Router();

  router.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard');
    res.render('login', { title: '登录', error: null, layout: false });
  });

  // ====== H3: 登录限流 + H2: Session 重新生成 ======
  router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.render('login', { title: '登录', error: '请输入用户名和密码。', layout: false });
    }
    try {
      const uname = username.trim();
      // ====== 账号锁定的不变量检查 ======
      const { rows: laRows } = await pool.query(`SELECT fail_count, locked_until FROM login_attempts WHERE username = $1`, [uname]);
      const la = laRows[0];
      if (la && la.locked_until && new Date(la.locked_until) > new Date()) {
        console.log(`[auth] login locked, username=${uname}`);
        return res.render('login', { title: '登录', error: `登录失败次数过多，账号已锁定 ${LOGIN_LOCK_MINUTES} 分钟，请稍后再试。`, layout: false });
      }

      const { rows } = await pool.query(`SELECT * FROM users WHERE username = $1`, [uname]);
      const user = rows[0];
      // 用户不存在也走一次等价 bcrypt（对比假哈希），保证两条分支耗时一致
      const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
      if (!ok) {
        const after = await recordLoginFailure(uname);
        console.log(`[auth] login failed, username=${uname}`);
        // 刚触发账号锁定 → 异步推送安全告警，不阻塞登录响应
        if (after && after.locked_until && new Date(after.locked_until) > new Date()) {
          const when = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
          sendSecurityAlert(
            `【安全告警】账号被锁定\n账号: ${uname}\n来源IP: ${req.ip}\n时间: ${when}\n策略: 连续登录失败 ${LOGIN_MAX_FAILS} 次，锁定 ${LOGIN_LOCK_MINUTES} 分钟`
          ).catch(() => {});
        }
        return res.render('login', { title: '登录', error: '用户名或密码错误。', layout: false });
      }
      // 密码正确后再校验启用状态：避免用错误密码探测「账号存在且被禁用」
      if (!user.active) return res.render('login', { title: '登录', error: '账号已被禁用，请联系管理员。', layout: false });

      // 登录成功，清除失败计数
      await pool.query(`DELETE FROM login_attempts WHERE username = $1`, [uname]);

      // H2: 登录成功后重新生成 session ID，防止 session 固定攻击
      const oldSession = { ...req.session };
      req.session.regenerate((err) => {
        if (err) {
          console.error('[auth] session regenerate error:', err);
          return res.render('login', { title: '登录', error: '登录失败，请稍后再试。', layout: false });
        }
        req.session.userId = user.id;
        req.session.role = user.role;
        req.session.user = { id: user.id, username: user.username, display_name: user.display_name, role: user.role, active: user.active, must_change_password: user.must_change_password };
        // 保留 CSRF token
        if (oldSession.csrfToken) req.session.csrfToken = oldSession.csrfToken;
        console.log('[auth] login success, userId=', user.id, 'must_change_password=', user.must_change_password);
        audit(req, 'login', { entity_type: 'user', entity_id: user.id, detail: `用户 ${user.display_name} 登录系统` });
        req.session.save((saveErr) => {
          if (saveErr) { console.error('[auth] session save error:', saveErr); }
          // C4: 首次登录必须修改密码
          if (user.must_change_password) {
            console.log('[auth] redirecting to /change-password');
            return res.redirect('/change-password');
          }
          console.log('[auth] redirecting to /dashboard');
          res.redirect('/dashboard');
        });
      });
    } catch (e) {
      console.error('[auth] login error:', e.message);
      res.render('login', { title: '登录', error: '登录失败，请稍后再试。', layout: false });
    }
  });

  router.get('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie(isProd ? '__Host-sessionid' : 'case-session');
      // 兼容开发/生产环境切换后遗留的另一种 cookie 名
      res.clearCookie('__Host-sessionid');
      res.clearCookie('case-session');
      res.redirect('/login');
    });
  });

  // ====== C4: 修改密码页面 ======
  router.get('/change-password', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.render('change-password', {
      title: '修改密码',
      mustChange: req.session.user?.must_change_password || false,
      csrfToken: req.session.csrfToken || '',
      layout: false,
    });
  });

  router.post('/change-password', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { old_password, new_password, confirm_password } = req.body;
    const pwErr = validatePasswordStrength(new_password);
    if (pwErr) {
      return res.render('change-password', { title: '修改密码', error: pwErr, mustChange: req.session.user?.must_change_password || false, csrfToken: req.session.csrfToken || '', layout: false });
    }
    if (new_password !== confirm_password) {
      return res.render('change-password', { title: '修改密码', error: '两次输入的密码不一致', mustChange: req.session.user?.must_change_password || false, csrfToken: req.session.csrfToken || '', layout: false });
    }
    try {
      const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.session.userId]);
      const user = rows[0];
      // 非强制修改时需验证旧密码
      if (!req.session.user?.must_change_password) {
        if (!old_password) {
          return res.render('change-password', { title: '修改密码', error: '请输入旧密码', mustChange: false, csrfToken: req.session.csrfToken || '', layout: false });
        }
        const ok = await bcrypt.compare(old_password, user.password_hash);
        if (!ok) {
          return res.render('change-password', { title: '修改密码', error: '旧密码错误', mustChange: false, csrfToken: req.session.csrfToken || '', layout: false });
        }
      }
      const hash = await bcrypt.hash(new_password, 10);
      await pool.query(`UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2`, [hash, req.session.userId]);
      req.session.user.must_change_password = false;
      try { await audit({ session: req.session, ip: req.ip }, '修改密码', { entity_type: 'user', entity_id: req.session.userId, detail: '用户修改了自己的登录密码' }); } catch {}
      res.render('change-password', { title: '修改密码', success: true, mustChange: false, csrfToken: req.session.csrfToken || '', layout: false });
    } catch (e) {
      console.error('[auth] change-password error:', e.message);
      res.render('change-password', { title: '修改密码', error: '修改失败，请稍后再试', mustChange: req.session.user?.must_change_password || false, csrfToken: req.session.csrfToken || '', layout: false });
    }
  });

  // 忘记密码：自助安全答案重置已下线（安全答案存在弱口令后门风险），
  // 统一改为管理员在「系统管理 → 用户管理」中人工重置密码（POST /api/users/:id/reset）。

  return router;
}

// ====== M6: DEMO 模式只在非生产环境允许 ======
function isApi(req) {
  return (req.originalUrl || req.url || '').startsWith('/api');
}

function requireLogin(req, res, next) {
  if (process.env.DEMO === '1' && process.env.NODE_ENV !== 'production') {
    return next();
  }
  if (req.session && req.session.userId) {
    return next();
  }
  if (isApi(req)) {
    return res.status(401).json({ error: '未登录' });
  }
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  return requirePermission('system.settings')(req, res, next);
}

// 细粒度权限中间件：super_admin 始终放行
function requirePermission(perm) {
  return (req, res, next) => {
    if (process.env.DEMO === '1' && process.env.NODE_ENV !== 'production') {
      return next();
    }
    if (!req.session.userId) {
      if (isApi(req)) return res.status(401).json({ error: '未登录' });
      return res.redirect('/login');
    }
    if (hasPermission(req.session.user, perm)) return next();
    if (isApi(req)) {
      return res.status(403).json({ error: '没有执行该操作的权限' });
    }
    return res.status(403).render('error', {
      title: '无权访问',
      message: '您没有执行该操作的权限，请联系超级管理员。',
      user: req.session.user,
    });
  };
}

function canViewCase(reqUser, c) {
  if (reqUser.role === 'super_admin') return true;
  if (hasPermission(reqUser, 'cases.view_all')) return true;
  return c.assignee_id === reqUser.id;
}

function setLocalsPerms(user, res) {
  const { getRoleLabel } = require('./permissions');
  const roleLabel = user ? getRoleLabel(user.role) : '';
  res.locals.roleLabel = roleLabel;
  res.locals.can = (perm) => hasPermission(user, perm);
}

async function loadUser(req, res, next) {
  if (process.env.DEMO === '1' && process.env.NODE_ENV !== 'production') {
    if (req.session && req.session.userId) {
      // 用户已登录，从 DB 加载真实数据（包括 must_change_password）
      const { rows } = await pool.query(
        `SELECT id, username, display_name, role, active, must_change_password FROM users WHERE id = $1`,
        [req.session.userId]
      );
      if (rows.length > 0 && rows[0].active) {
        req.session.user = rows[0];
        req.session.role = rows[0].role;
        res.locals.user = rows[0];
        res.locals.admin = rows[0].role === 'admin' || rows[0].role === 'super_admin';
        setLocalsPerms(rows[0], res);
        return next();
      }
    }
    const demo = { id: 1, username: 'admin', display_name: '超级管理员', role: 'super_admin', active: true };
    req.session.user = demo;
    req.session.role = 'super_admin';
    res.locals.user = demo;
    res.locals.admin = true;
    setLocalsPerms(demo, res);
    return next();
  }
  if (req.session && req.session.userId) {
    const { rows } = await pool.query(
      `SELECT id, username, display_name, role, active, must_change_password FROM users WHERE id = $1`,
      [req.session.userId]
    );
    if (rows.length > 0 && rows[0].active) {
      req.session.user = rows[0];
      req.session.role = rows[0].role;
      res.locals.user = rows[0];
      res.locals.admin = rows[0].role === 'admin' || rows[0].role === 'super_admin';
      setLocalsPerms(rows[0], res);
    } else {
      req.session.destroy(() => {});
      res.locals.user = null;
      res.locals.admin = false;
    }
  } else {
    res.locals.user = null;
    res.locals.admin = false;
  }
  next();
}

module.exports = { createAuthRouter, requireLogin, requireAdmin, requirePermission, canViewCase, loadUser };
