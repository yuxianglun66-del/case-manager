const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
const { caseFolder } = require('./util');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const FLAG = 'storage_migrated_v1';

function moveFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return true;
}

// 一次性迁移：把历史文件移动到各案件编号文件夹
async function migrateFilesToCaseFolders() {
  const flag = (await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [FLAG])).rows[0];
  if (flag && flag.value === '1') return { migrated: false, moved: 0 };

  let moved = 0;

  // 1. 附件：stored_name 为纯文件名 → 移到 案件文件夹/文件名
  const atts = (await pool.query(
    `SELECT a.id, a.stored_name, c.case_no
     FROM attachments a JOIN cases c ON c.id = a.case_id
     WHERE a.stored_name IS NOT NULL AND a.stored_name NOT LIKE '%/%'`
  )).rows;
  for (const a of atts) {
    const folder = caseFolder({ case_no: a.case_no });
    const src = path.join(UPLOAD_DIR, a.stored_name);
    const dest = path.join(UPLOAD_DIR, folder, a.stored_name);
    if (!moveFile(src, dest)) continue;
    await pool.query(`UPDATE attachments SET stored_name = $1 WHERE id = $2`, [`${folder}/${a.stored_name}`, a.id]);
    moved++;
  }

  // 2. 合同工作稿：work_pdf_path 以 contracts/ 开头 → 移到案件文件夹
  const works = (await pool.query(
    `SELECT c.id, c.work_pdf_path, k.case_no
     FROM contracts c JOIN cases k ON k.id = c.case_id
     WHERE c.work_pdf_path IS NOT NULL AND c.work_pdf_path LIKE 'contracts/%'`
  )).rows;
  for (const w of works) {
    const folder = caseFolder({ case_no: w.case_no });
    const base = path.basename(w.work_pdf_path);
    const src = path.join(UPLOAD_DIR, w.work_pdf_path);
    const dest = path.join(UPLOAD_DIR, folder, base);
    if (!moveFile(src, dest)) continue;
    await pool.query(`UPDATE contracts SET work_pdf_path = $1 WHERE id = $2`, [`${folder}/${base}`, w.id]);
    moved++;
  }

  // 3. 已签署合同：pdf_path 为纯文件名（存在 contracts/signed/ 下）→ 移到案件文件夹
  const signed = (await pool.query(
    `SELECT c.id, c.pdf_path, k.case_no
     FROM contracts c JOIN cases k ON k.id = c.case_id
     WHERE c.pdf_path IS NOT NULL AND c.pdf_path NOT LIKE '%/%'`
  )).rows;
  for (const s of signed) {
    const folder = caseFolder({ case_no: s.case_no });
    const src = path.join(UPLOAD_DIR, 'contracts', 'signed', s.pdf_path);
    const dest = path.join(UPLOAD_DIR, folder, s.pdf_path);
    if (!moveFile(src, dest)) continue;
    await pool.query(`UPDATE contracts SET pdf_path = $1 WHERE id = $2`, [`${folder}/${s.pdf_path}`, s.id]);
    moved++;
  }

  await pool.query(
    `INSERT INTO app_settings (key, value, description) VALUES ($1, '1', '附件按案件文件夹迁移完成')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [FLAG]
  );
  return { migrated: true, moved };
}

module.exports = { migrateFilesToCaseFolders };
