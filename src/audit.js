const { pool } = require('./db');

// 记录操作日志。审计失败不阻断业务，仅打印警告。
async function audit(req, action, opts = {}) {
  try {
    const user = req && req.session && req.session.user;
    await pool.query(
      `INSERT INTO audit_logs (user_id, display_name, action, entity_type, entity_id, detail, before_data, after_data, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        user ? user.id : null,
        user ? user.display_name : null,
        action,
        opts.entity_type || null,
        opts.entity_id || null,
        opts.detail || null,
        opts.before != null ? JSON.stringify(opts.before) : null,
        opts.after != null ? JSON.stringify(opts.after) : null,
        (req && req.ip) || null,
      ]
    );
  } catch (e) {
    console.warn('[audit] 写入失败:', e.message);
  }
}

module.exports = { audit };
