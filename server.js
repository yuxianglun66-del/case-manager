const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { pool, initDb } = require('./src/db');
const { loadUser } = require('./src/auth');
const expressLayouts = require('express-ejs-layouts');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// ====== C2+C3: 生产环境强制要求环境变量 ======
if (isProd) {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('changeme123')) {
    console.error('[FATAL] 生产环境必须设置 DATABASE_URL 且不能使用默认密码');
    process.exit(1);
  }
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'case-manager-session-secret') {
    console.error('[FATAL] 生产环境必须设置 SESSION_SECRET 环境变量');
    process.exit(1);
  }
}

// ====== G1: 反向代理信任（生产环境需 Nginx/Caddy 转发 HTTPS） ======
// 必须放在限流/会话之前，否则所有请求都来自代理 IP，导致限流误伤与 secure cookie 失效
if (isProd) app.set('trust proxy', 1);

// ====== G1: 健康检查（无需登录，供 Docker/K8s 探活） ======
app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, uptime: process.uptime() });
  } catch (e) {
    res.status(503).json({ ok: false, error: '数据库不可用' });
  }
});

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ====== H5: 安全响应头 ======
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "blob:"],
      imgSrc: ["'self'", "data:", "blob:"],
      frameSrc: ["'self'", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));

// ====== H3: 全局限流 ======
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 400,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
  // 静态资源与上传文件不计数（页面加载会请求大量 CSS/JS/图标）
  skip: (req) => req.method === 'GET' && (
    req.path.startsWith('/css/') || req.path.startsWith('/js/') ||
    req.path.startsWith('/vendor/') || req.path.startsWith('/uploads/') ||
    req.path.startsWith('/favicon') || req.path === '/favicon.ico'
  ),
});
app.use(globalLimiter);

// ====== 登录限流（更严格） ======
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: '登录尝试次数过多，请15分钟后再试',
  skipSuccessfulRequests: true,
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');
app.use(expressLayouts);

// ====== H4: XSS 防护 — EJS 安全 JSON 输出辅助函数 ======
app.locals.safeJson = (data) => {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
};

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

// ====== H6: 安全 Cookie ======
app.use(session({
  store: new pgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  }),
  name: isProd ? '__Host-sessionid' : 'case-session',
  secret: process.env.SESSION_SECRET || 'case-manager-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: isProd,
  },
}));

// ====== CSRF 保护 ======
app.use((req, res, next) => {
  if (req.method === 'GET') {
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.locals.csrfToken = req.session.csrfToken;
  }
  next();
});

function csrfProtect(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const token = req.body._csrf || req.headers['x-csrf-token'] || req.query._csrf;
  if (!token || token !== req.session.csrfToken) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'CSRF 令牌无效' });
    }
    return res.status(403).render('error', {
      title: '安全验证失败',
      message: 'CSRF 令牌无效，请刷新页面重试。',
      user: req.session.user || null,
    });
  }
  next();
}

// 对所有 POST 请求启用 CSRF（排除公开路由）
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const publicPaths = ['/sign/', '/login'];
  if (publicPaths.some(p => req.path.startsWith(p))) return next();
  csrfProtect(req, res, next);
});

app.use(loadUser);

/* ---- 全局注入 settings ---- */
app.use(async (req, res, next) => {
  try {
    const rows = (await pool.query(`SELECT key, value FROM app_settings`)).rows;
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.locals.settings = settings;
    next();
  } catch (e) { next(e); }
});

app.locals.MAX_MB = require('./src/util').MAX_MB;

app.use(express.static(path.join(__dirname, 'public')));

// 上传文件静态访问（logo 等）
const _uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
app.use('/uploads', (req, res, next) => {
  const fp = path.join(_uploadDir, req.path);
  if (!fp.startsWith(path.resolve(_uploadDir))) return res.status(403).end();
  express.static(_uploadDir)(req, res, next);
});

// 前端框架资源
app.use('/vendor/bootstrap', express.static(path.join(__dirname, 'node_modules', 'bootstrap', 'dist')));
app.use('/vendor/bootstrap-icons', express.static(path.join(__dirname, 'node_modules', 'bootstrap-icons', 'font')));
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));
app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'legacy', 'build')));

app.use('/', require('./src/auth').createAuthRouter(loginLimiter));
app.use('/', require('./routes/public'));
app.use('/api', require('./routes/api'));
app.use('/', require('./routes/pages'));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  res.status(404).render('error', { title: '页面不存在', message: '您访问的页面不存在。', user: req.session.user || null });
});

// ====== M4: 安全错误处理 ======
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  if (isProd) console.error(err.stack);
  if (req.path.startsWith('/api/')) {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : (err.statusCode || 500);
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '文件超过大小限制' : (isProd ? '服务器内部错误' : err.message);
    return res.status(code).json({ error: msg });
  }
  res.status(500).render('error', {
    title: '服务器错误',
    message: isProd ? '服务器出现错误，请稍后再试。' : (err.message || '服务器内部错误'),
    user: req.session.user || null,
  });
});

async function start() {
  await initDb();
  await require('./src/permissions').loadPermissions();
  const server = app.listen(PORT, () => {
    console.log(`[app] 案件管理系统已启动，端口 ${PORT} [${isProd ? '生产' : '开发'}模式]`);
  });
  require('./src/backup').startBackupScheduler();

  // ====== G2: 优雅停机（Docker stop / Ctrl+C 时先停服务再关连接池） ======
  const shutdown = async (signal) => {
    console.log(`[app] 收到 ${signal}，正在优雅停机...`);
    const force = setTimeout(() => { console.error('[app] 强制退出'); process.exit(1); }, 10000);
    force.unref();
    server.close(async () => {
      try { await pool.end(); } catch {}
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((e) => {
  console.error('[app] 启动失败:', e);
  process.exit(1);
});
