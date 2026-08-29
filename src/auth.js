const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool } = require('../src/db');
const { hasPermission, ROLES } = require('./permissions');
const { audit } = require('./audit');
const isProd = process.env.NODE_ENV === 'production';

// 密码复杂度：至少 8 位，且必须同时包含字母和数字
function validatePasswordStrength(pw) {
  if (!pw || pw.length < 8) return '密码至少 8 位';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return '密码必须同时包含字母和数字';
  return null;
}

// 忘记密码接口限流（5次/15分钟/IP）
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: '操作次数过多，请15分钟后再试',
  skipSuccessfulRequests: true,
});

// 登录失败锁定策略：连续 5 次失败锁定 15 分钟
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MINUTES = 15;

// 记录一次登录失败；达到阈值则写入锁定时间（锁定到期后自动归零重新计数）
async function recordLoginFailure(username) {
  try {
    await pool.query(
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
         updated_at = now()`,
      [username, LOGIN_MAX_FAILS, LOGIN_LOCK_MINUTES]
    );
  } catch (e) {
    console.error('[auth] recordLoginFailure error:', e.message);
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
      if (!user) return res.render('login', { title: '登录', error: '用户名或密码错误。', layout: false });
      if (!user.active) return res.render('login', { title: '登录', error: '账号已被禁用，请联系管理员。', layout: false });
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        await recordLoginFailure(uname);
        console.log(`[auth] login failed, username=${uname}`);
        return res.render('login', { title: '登录', error: '用户名或密码错误。', layout: false });
      }

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

  // ====== 忘记密码（公开页面） ======
  router.get('/forgot-password', (req, res) => {
    res.render('forgot-password', { title: '忘记密码', step: 'username', error: null, success: null, username: '', csrfToken: req.session?.csrfToken || '', layout: false });
  });

  router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
    const csrfToken = req.session?.csrfToken || '';
    const step = req.body.step || 'verify';

    if (step === 'verify') {
      // 验证用户名和安全答案
      const username = (req.body.username || '').trim();
      const answer = (req.body.security_answer || '').trim();
      if (!username || !answer) {
        return res.render('forgot-password', { title: '忘记密码', step: 'username', error: '请输入用户名和安全答案', success: null, username, csrfToken, layout: false });
      }
      try {
        const { rows } = await pool.query(`SELECT id, username, security_question, security_answer FROM users WHERE username = $1 AND active = TRUE`, [username]);
        if (rows.length === 0) {
          return res.render('forgot-password', { title: '忘记密码', step: 'username', error: '用户名不存在或账号已停用', success: null, username, csrfToken, layout: false });
        }
        const user = rows[0];
        if (!user.security_question || !user.security_answer) {
          return res.render('forgot-password', { title: '忘记密码', step: 'username', error: '该用户未设置安全问题，请联系管理员', success: null, username, csrfToken, layout: false });
        }
        // S2: 安全答案以 bcrypt 哈希存储并比对
        let answerOk = false;
        if (String(user.security_answer).startsWith('$2')) {
          answerOk = await bcrypt.compare(answer, user.security_answer);
        } else {
          // 兼容历史明文（迁移由 initDb 完成，此处防御性兜底）
          answerOk = answer === user.security_answer;
        }
        if (!answerOk) {
          return res.render('forgot-password', { title: '忘记密码', step: 'username', error: '安全答案错误', success: null, username, csrfToken, layout: false });
        }
        // 答案正确，进入第二步
        return res.render('forgot-password', {
          title: '忘记密码', step: 'reset', error: null, success: null,
          username, securityQuestion: user.security_question, userId: user.id,
          csrfToken, layout: false,
        });
      } catch (e) {
        console.error('[auth] forgot-password verify error:', e.message);
        return res.render('forgot-password', { title: '忘记密码', step: 'username', error: '系统错误，请稍后再试', success: null, username, csrfToken, layout: false });
      }
    }

    if (step === 'reset') {
      // 设置新密码
      const userId = parseInt(req.body.userId, 10);
      const new_password = req.body.new_password || '';
      const confirm_password = req.body.confirm_password || '';
      const username = req.body.username || '';
      if (!userId || !new_password) {
        return res.render('forgot-password', { title: '忘记密码', step: 'reset', error: '请输入新密码', success: null, username, csrfToken, layout: false });
      }
      const pwErr = validatePasswordStrength(new_password);
      if (pwErr) {
        return res.render('forgot-password', { title: '忘记密码', step: 'reset', error: pwErr, success: null, username, csrfToken, layout: false });
      }
      if (new_password !== confirm_password) {
        return res.render('forgot-password', { title: '忘记密码', step: 'reset', error: '两次输入的密码不一致', success: null, username, csrfToken, layout: false });
      }
      try {
        const hash = await bcrypt.hash(new_password, 10);
        await pool.query(`UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2`, [hash, userId]);
        // 重置密码后使当前会话失效（若该用户已登录）
        try {
          await pool.query(`DELETE FROM user_sessions WHERE sess_data::text LIKE '%"userId":${userId}%'`).catch(() => {});
        } catch (e) { /* 忽略会话清理失败 */ }
        return res.render('forgot-password', { title: '忘记密码', step: 'done', error: null, success: '密码已重置成功，请使用新密码登录', username, csrfToken, layout: false });
      } catch (e) {
        console.error('[auth] forgot-password reset error:', e.message);
        return res.render('forgot-password', { title: '忘记密码', step: 'reset', error: '系统错误，请稍后再试', success: null, username, csrfToken, layout: false });
      }
    }

    res.render('forgot-password', { title: '忘记密码', step: 'username', error: null, success: null, username: '', csrfToken, layout: false });
  });

  return router;
}

// ====== M6: DEMO 模式只在非生产环境允许 ======
function requireLogin(req, res, next) {
  if (process.env.DEMO === '1' && process.env.NODE_ENV !== 'production') {
    return next();
  }
  if (req.session && req.session.userId) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
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
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: '未登录' });
      return res.redirect('/login');
    }
    if (hasPermission(req.session.user, perm)) return next();
    if (req.path.startsWith('/api/')) {
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
  const roleLabel = (user && ROLES[user.role]) ? ROLES[user.role].label : (user && user.role === 'admin' ? '管理员' : '员工');
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
