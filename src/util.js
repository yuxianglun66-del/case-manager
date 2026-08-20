const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pool } = require('./db');

const ALLOWED_EXT = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.wps', '.et', '.txt', '.csv',
  '.zip', '.rar', '.7z',
];

const MAX_MB = parseInt(process.env.MAX_FILE_MB || '50', 10);

// I1: 扩展名 → 安全 Content-Type 映射（不信任用户提交的 mime_type）
const EXT_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic',
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.wps': 'application/vnd.ms-works', '.et': 'application/vnd.ms-excel',
  '.txt': 'text/plain', '.csv': 'text/csv',
  '.zip': 'application/zip', '.rar': 'application/x-rar-compressed', '.7z': 'application/x-7z-compressed',
};
const EXT_CONTENT_DISPOSITION_INLINE = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.pdf']);

function contentTypeFor(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

function isInlineSafe(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return EXT_CONTENT_DISPOSITION_INLINE.has(ext);
}

// I1: 上传文件魔数嗅探，防止伪装类型/可执行内容
function sniffValidSignature(ext, buf) {
  if (!buf || buf.length < 16) return true; // 过小文件放行（由业务层校验）
  const hex = buf.subarray(0, 16).toString('hex');
  const sigs = {
    '.jpg': /^ffd8ff/,
    '.jpeg': /^ffd8ff/,
    '.png': /^89504e470d0a1a0a/,
    '.gif': /^47494638/,
    '.webp': /^52494646/,
    '.pdf': /^25504446/,
    '.zip': /^504b0304/,
    '.7z': /^377abcaf271c/,
    '.rar': /^52617221/,
    '.txt': null, '.csv': null,
    '.doc': /^d0cf11e0/,
    '.xls': /^d0cf11e0/,
    '.ppt': /^d0cf11e0/,
  };
  const sig = sigs[ext];
  if (!sig) return true; // 无魔数定义（office 新版/docx 为 zip 容器、heic 等）→ 放行
  return sig.test(hex);
}

// I1: multer 保存到磁盘后校验魔数；失败则删除文件并返回错误
function validateUploadedFiles(req, res, next) {
  const files = req.files || (req.file ? [req.file] : []);
  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase();
    let buf = null;
    try {
      buf = fs.readFileSync(f.path).subarray(0, 16);
    } catch (e) { /* 读不到则跳过校验 */ }
    if (buf && !sniffValidSignature(ext, buf)) {
      if (f.path) fs.unlink(f.path, () => {});
      return res.status(400).json({ error: `文件内容与扩展名不匹配：${f.originalname}` });
    }
  }
  next();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let dir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
    // 附件按案件编号独立文件夹存放
    if (req && req.caseRow) {
      dir = path.join(dir, caseFolder(req.caseRow));
    }
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return cb(new Error(`不支持的文件类型：${ext || '(无扩展名)'}`));
    }
    cb(null, true);
  },
});

const feeStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    let dir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
    if (req && req.caseRow) {
      dir = path.join(dir, caseFolder(req.caseRow), 'fees');
    }
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `fee-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const feeUpload = multer({
  storage: feeStorage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return cb(new Error(`不支持的文件类型：${ext || '(无扩展名)'}`));
    }
    cb(null, true);
  },
});

const libraryStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'), 'library');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `lib-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const libraryUpload = multer({
  storage: libraryStorage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return cb(new Error(`不支持的文件类型：${ext || '(无扩展名)'}`));
    }
    cb(null, true);
  },
});

function isAllowedExt(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return ALLOWED_EXT.includes(ext);
}

async function getCaseForPermission(req) {
  const id = parseInt(req.params.id || req.params.caseId, 10);
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT c.*, u.display_name AS assignee_name, t.name AS type_name, t.color AS type_color, t.code AS type_code,
            s.name AS status_name, s.color AS status_color
     FROM cases c
     LEFT JOIN users u ON u.id = c.assignee_id
     LEFT JOIN case_types t ON t.id = c.case_type_id
     LEFT JOIN statuses s ON s.id = c.status_id
     WHERE c.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function generateCaseNo(client, caseTypeId, code) {
  const year = new Date().getFullYear();
  const prefix = `${code}-${year}-`;
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS cnt FROM cases WHERE case_type_id = $1 AND case_no LIKE $2`,
    [caseTypeId, `${prefix}%`]
  );
  const seq = rows[0].cnt + 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// 案件文件夹名：以案件编号命名（不可变、唯一、纯安全字符）
function caseFolder(row) {
  const raw = (row && row.case_no) ? String(row.case_no) : '';
  let s = raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.\s]+/, '').slice(0, 60);
  if (!s || s === '.' || s === '..') s = 'case';
  return s;
}

module.exports = { upload, feeUpload, libraryUpload, validateUploadedFiles, contentTypeFor, isInlineSafe, isAllowedExt, getCaseForPermission, generateCaseNo, caseFolder, MAX_MB, ALLOWED_EXT };
