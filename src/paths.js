const path = require('path');
const { pool } = require('./db');

const DEFAULT_UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const DEFAULT_BACKUP_DIR = process.env.BACKUP_DIR || path.join(DEFAULT_UPLOAD_DIR, 'backups');

let _uploadDir = null;
let _backupDir = null;

async function loadPaths() {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM app_settings WHERE key IN ('upload_dir', 'backup_dir')`
    );
    for (const r of rows) {
      if (r.key === 'upload_dir' && r.value) _uploadDir = r.value;
      if (r.key === 'backup_dir' && r.value) _backupDir = r.value;
    }
  } catch (_) {
    // table may not exist yet during first boot
  }
}

function getUploadDir() {
  return _uploadDir || DEFAULT_UPLOAD_DIR;
}

function getBackupDir() {
  return _backupDir || DEFAULT_BACKUP_DIR;
}

async function savePaths(uploadDir, backupDir) {
  if (uploadDir != null && uploadDir.trim()) {
    await pool.query(
      `INSERT INTO app_settings (key, value, description) VALUES ('upload_dir', $1, '附件存储路径')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [uploadDir.trim()]
    );
    _uploadDir = uploadDir.trim();
  }
  if (backupDir != null && backupDir.trim()) {
    await pool.query(
      `INSERT INTO app_settings (key, value, description) VALUES ('backup_dir', $1, '备份存储路径')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [backupDir.trim()]
    );
    _backupDir = backupDir.trim();
  }
}

module.exports = { getUploadDir, getBackupDir, savePaths, loadPaths, DEFAULT_UPLOAD_DIR, DEFAULT_BACKUP_DIR };
