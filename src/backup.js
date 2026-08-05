const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'), 'backups');

const APP_NAME = 'case-manager';
const BACKUP_VERSION = 1;

const MAIN_TABLES = [
  'users', 'role_permissions', 'case_types', 'case_fields', 'statuses',
  'contract_templates', 'cases', 'case_field_values', 'case_history',
  'app_settings', 'case_parties', 'contracts', 'contract_signatures'
];

const RESTORE_ORDER = [
  'users', 'role_permissions', 'case_types', 'case_fields', 'statuses',
  'contract_templates', 'cases', 'case_field_values', 'case_history',
  'case_parties', 'contracts', 'contract_signatures', 'app_settings'
];

const SETTING_KEYS = [
  'backup_enabled', 'backup_schedule_type', 'backup_time', 'backup_weekday',
  'backup_retention_days', 'backup_last_run', 'backup_last_result'
];

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function backupFileName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}

function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('backup-') && f.endsWith('.json'))
    .map((f) => {
      const full = path.join(BACKUP_DIR, f);
      let size = 0;
      let mtime = null;
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtime = st.mtime;
      } catch (e) {}
      return { name: f, size, created_at: mtime ? mtime.toISOString() : null };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

async function readBackupSettings() {
  const res = await pool.query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [SETTING_KEYS]);
  const m = {};
  for (const r of res.rows) m[r.key] = r.value;
  return {
    backup_enabled: m.backup_enabled === '1',
    backup_schedule_type: m.backup_schedule_type === 'weekly' ? 'weekly' : 'daily',
    backup_time: m.backup_time || '02:00',
    backup_weekday: parseInt(m.backup_weekday, 10) || 0,
    backup_retention_days: parseInt(m.backup_retention_days, 10) || 7,
    backup_last_run: m.backup_last_run || null,
    backup_last_result: m.backup_last_result || null
  };
}

async function saveBackupSettings(input) {
  const patch = {};
  if (input.backup_enabled !== undefined) patch.backup_enabled = input.backup_enabled ? '1' : '0';
  if (input.backup_schedule_type !== undefined) patch.backup_schedule_type = input.backup_schedule_type === 'weekly' ? 'weekly' : 'daily';
  if (input.backup_time !== undefined) patch.backup_time = String(input.backup_time);
  if (input.backup_weekday !== undefined) patch.backup_weekday = String(parseInt(input.backup_weekday, 10) || 0);
  if (input.backup_retention_days !== undefined) patch.backup_retention_days = String(parseInt(input.backup_retention_days, 10) || 7);
  const keys = Object.keys(patch);
  if (!keys.length) return readBackupSettings();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const k of keys) {
      await client.query(
        `INSERT INTO app_settings (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [k, patch[k]]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return readBackupSettings();
}

async function setLastRun(result, note) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('backup_last_run', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [new Date().toISOString()]
  );
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('backup_last_result', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [result ? 'ok' : (note || 'err')]
  );
}

async function runBackup() {
  ensureBackupDir();
  const dump = { app: APP_NAME, version: BACKUP_VERSION, created_at: new Date().toISOString(), tables: {} };
  for (const t of MAIN_TABLES) {
    const res = await pool.query(`SELECT * FROM ${t}`);
    dump.tables[t] = res.rows;
  }
  const file = backupFileName();
  fs.writeFileSync(path.join(BACKUP_DIR, file), JSON.stringify(dump, null, 2), 'utf8');
  const cfg = await readBackupSettings();
  pruneOldBackups(cfg.backup_retention_days);
  return { file, size: fs.statSync(path.join(BACKUP_DIR, file)).size };
}

async function restoreBackup(file) {
  const safe = path.basename(file);
  const full = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(full)) throw new Error('备份文件不存在');
  const dump = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (!dump || dump.app !== APP_NAME || !dump.tables) throw new Error('无效的备份文件');
  for (const t of RESTORE_ORDER) {
    if (!Array.isArray(dump.tables[t])) throw new Error(`备份文件缺少数据表：${t}`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`TRUNCATE TABLE ${MAIN_TABLES.join(', ')} CASCADE`);
    for (const t of RESTORE_ORDER) {
      const rows = dump.tables[t];
      if (!rows.length) continue;
      const colRes = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public'`,
        [t]
      );
      const known = colRes.rows.map((r) => r.column_name);
      const typeRes = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public' AND data_type IN ('json','jsonb')`,
        [t]
      );
      const jsonCols = new Set(typeRes.rows.map((r) => r.column_name));
      const sample = rows[0];
      const cols = Object.keys(sample).filter((c) => known.includes(c));
      if (!cols.length) continue;
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${placeholders})`;
      for (const row of rows) {
        const vals = cols.map((c) => {
          const v = row[c] === undefined ? null : row[c];
          if (v !== null && jsonCols.has(c)) return JSON.stringify(v);
          return v;
        });
        await client.query(sql, vals);
      }
      if (known.includes('id')) {
        const seq = await client.query(
          `SELECT pg_get_serial_sequence($1, 'id') AS seq`, [t]
        );
        const seqName = seq.rows[0].seq;
        if (seqName) {
          const maxId = rows.reduce((m, r) => (typeof r.id === 'number' ? Math.max(m, r.id) : m), 0);
          await client.query(`SELECT setval($1, $2, true)`, [seqName, maxId > 0 ? maxId : 1]);
        }
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const { loadPermissions } = require('./permissions');
  await loadPermissions();
  return dump;
}

function pruneOldBackups(retentionDays) {
  if (!retentionDays || retentionDays < 1) retentionDays = 7;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  ensureBackupDir();
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!f.startsWith('backup-') || !f.endsWith('.json')) continue;
    const full = path.join(BACKUP_DIR, f);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch (e) {}
  }
  return removed;
}

function deleteBackup(file) {
  const safe = path.basename(file);
  const full = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(full)) throw new Error('备份文件不存在');
  fs.unlinkSync(full);
  return true;
}

let schedulerTimer = null;

function startBackupScheduler() {
  if (schedulerTimer) return schedulerTimer;
  const tick = async () => {
    try {
      const cfg = await readBackupSettings();
      if (!cfg.backup_enabled) return;
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (cfg.backup_time !== hhmm) return;
      if (cfg.backup_schedule_type === 'weekly') {
        const weekday = now.getDay();
        if (weekday !== cfg.backup_weekday) return;
      }
      const lastRun = cfg.backup_last_run ? new Date(cfg.backup_last_run) : null;
      const stamp = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
      const lastStamp = lastRun ? `${lastRun.getFullYear()}-${lastRun.getMonth()}-${lastRun.getDate()}` : '';
      if (lastStamp === stamp) return;
      try {
        await runBackup();
        await setLastRun(true);
      } catch (e) {
        console.error('[backup] 自动备份失败:', e.message);
        await setLastRun(false, e.message);
      }
    } catch (e) {
      console.error('[backup] 调度检查失败:', e.message);
    }
  };
  tick();
  schedulerTimer = setInterval(tick, 60 * 1000);
  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
  return schedulerTimer;
}

module.exports = {
  BACKUP_DIR,
  MAIN_TABLES,
  runBackup,
  restoreBackup,
  listBackups,
  deleteBackup,
  pruneOldBackups,
  readBackupSettings,
  saveBackupSettings,
  startBackupScheduler,
  backupFileName
};
