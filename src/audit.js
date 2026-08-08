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

const AUDIT_SETTING_KEYS = ['audit_retention_days', 'audit_last_cleanup'];

async function readAuditSettings() {
  const res = await pool.query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [AUDIT_SETTING_KEYS]);
  const m = {};
  for (const r of res.rows) m[r.key] = r.value;
  return {
    audit_retention_days: parseInt(m.audit_retention_days, 10) || 0,
    audit_last_cleanup: m.audit_last_cleanup || null,
  };
}

// 清理超过保留天数的操作日志，返回删除条数。失败时仅记录并继续。
async function pruneAuditLogs(retentionDays) {
  if (!retentionDays || retentionDays < 1) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const res = await pool.query(`DELETE FROM audit_logs WHERE created_at < $1`, [cutoff]);
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('audit_last_cleanup', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [new Date().toISOString()]
  );
  return res.rowCount || 0;
}

let cleanupTimer = null;

function startAuditCleanupScheduler() {
  if (cleanupTimer) return cleanupTimer;
  const tick = async () => {
    try {
      const cfg = await readAuditSettings();
      if (!cfg.audit_retention_days || cfg.audit_retention_days < 1) return;
      const last = cfg.audit_last_cleanup ? new Date(cfg.audit_last_cleanup) : null;
      const now = new Date();
      const stamp = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
      const lastStamp = last ? `${last.getFullYear()}-${last.getMonth()}-${last.getDate()}` : '';
      if (lastStamp === stamp) return;
      const removed = await pruneAuditLogs(cfg.audit_retention_days);
      if (removed > 0) console.log(`[audit] 已自动清理 ${removed} 条超过 ${cfg.audit_retention_days} 天的操作日志`);
    } catch (e) {
      console.error('[audit] 清理调度失败:', e.message);
    }
  };
  tick();
  cleanupTimer = setInterval(tick, 60 * 60 * 1000);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
  return cleanupTimer;
}

module.exports = { audit, readAuditSettings, pruneAuditLogs, startAuditCleanupScheduler };
