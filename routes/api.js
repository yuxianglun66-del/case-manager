const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
const { requireLogin, requirePermission, canViewCase } = require('../src/auth');
const { hasPermission } = require('../src/permissions');
const { upload, validateUploadedFiles, contentTypeFor, isInlineSafe, getCaseForPermission, generateCaseNo } = require('../src/util');
const { convertOfficeToPdf } = require('../src/convert');
const { embedCjkFont, stampTextFields } = require('../src/pdf-utils');

const router = express.Router();
router.use(requireLogin);

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

// JSONB 字段可能是字符串也可能是已解析对象，统一解析为数组
function parseJsonArray(v, fallback = []) {
  if (v == null) return fallback;
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || fallback; } catch (e) { return fallback; }
}

// G4: 密码强度：至少 8 位，且必须同时包含字母和数字
function validatePasswordStrength(pw) {
  if (!pw || pw.length < 8) return '密码至少 8 位';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return '密码必须同时包含字母和数字';
  return null;
}

function needCase(req, res, next) {
  getCaseForPermission(req)
    .then((c) => {
      if (!c) return res.status(404).json({ error: '案件不存在' });
      if (!canViewCase(req.session.user, c)) return res.status(403).json({ error: '无权操作他人的案件' });
      req.caseRow = c;
      next();
    })
    .catch(next);
}

async function addHistory(client, caseId, action, operatorId, opts = {}) {
  await client.query(
    `INSERT INTO case_history (case_id, action, status_id, note, operator_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [caseId, action, opts.statusId || null, opts.note || null, operatorId]
  );
}

/* ---------- 案件创建 ---------- */
router.post('/cases/create', requirePermission('cases.create'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = req.session.user;
    const title = (req.body.title || '').trim();
    const typeId = parseInt(req.body.case_type_id, 10);
    const clientName = (req.body.client_name || '').trim();
    const assigneeId = hasPermission(user, 'cases.assign') ? (parseInt(req.body.assignee_id, 10) || user.id) : user.id;
    const statusId = parseInt(req.body.status_id, 10) || null;
    const nextAction = (req.body.next_action || '').trim() || null;
    const reminderAt = req.body.reminder_at ? new Date(req.body.reminder_at) : null;
    const signStaffId = parseInt(req.body.sign_staff_id, 10) || null;
    const signDate = (req.body.sign_date || '').trim() || null;

    if (!title || !typeId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '请填写案件名称并选择案件类型' });
    }

    const type = (await client.query(`SELECT * FROM case_types WHERE id = $1 AND active = TRUE`, [typeId])).rows[0];
    if (!type) { await client.query('ROLLBACK'); return res.status(400).json({ error: '案件类型不存在' }); }

    const fields = (await client.query(
      `SELECT * FROM case_fields WHERE case_type_id = $1 AND active = TRUE ORDER BY sort`, [typeId]
    )).rows;
    for (const f of fields) {
      if (f.required && !(req.body[`field_${f.id}`] || '').trim()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `请填写必填项「${f.label}」` });
      }
    }

    const caseNo = await generateCaseNo(client, typeId, type.code);
    const feeAgreement = (req.body.fee_agreement || '').trim() || null;
    const feeDetails = (req.body.fee_details || '').trim() || null;
    const ins = await client.query(
      `INSERT INTO cases (case_no, case_type_id, title, client_name, assignee_id, status_id, status_at, created_by, next_action, reminder_at, fee_agreement, fee_details, sign_staff_id, sign_date)
       VALUES ($1,$2,$3,$4,$5,$6, now(), $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [caseNo, typeId, title, clientName || null, assigneeId, statusId, user.id, nextAction, reminderAt, feeAgreement, feeDetails, signStaffId, signDate]
    );
    const caseId = ins.rows[0].id;

    for (const f of fields) {
      const val = (req.body[`field_${f.id}`] || '').trim();
      if (val !== '') {
        await client.query(
          `INSERT INTO case_field_values (case_id, field_id, value) VALUES ($1,$2,$3)`,
          [caseId, f.id, val]
        );
      }
    }

    await addHistory(client, caseId, 'created', user.id, { statusId, note: '创建案件' });
    await client.query('COMMIT');
    res.json({ ok: true, id: caseId, case_no: caseNo });
  } catch (e) { await client.query('ROLLBACK'); next(e); }
  finally { client.release(); }
});

/* ---------- 案件更新 ---------- */
router.post('/cases/:id/update', requirePermission('cases.edit'), needCase, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = req.session.user;
    const id = req.caseRow.id;
    const title = (req.body.title || '').trim();
    const clientName = (req.body.client_name || '').trim();
    const typeId = parseInt(req.body.case_type_id, 10);
    const assigneeId = hasPermission(user, 'cases.assign') ? (parseInt(req.body.assignee_id, 10) || null) : req.caseRow.assignee_id;
    const statusId = parseInt(req.body.status_id, 10) || null;
    const nextAction = (req.body.next_action || '').trim() || null;
    const reminderAt = req.body.reminder_at ? new Date(req.body.reminder_at) : null;
    const signStaffId = parseInt(req.body.sign_staff_id, 10) || null;
    const signDate = (req.body.sign_date || '').trim() || null;

    if (!title || !typeId) { await client.query('ROLLBACK'); return res.status(400).json({ error: '请填写案件名称并选择案件类型' }); }

    const type = (await client.query(`SELECT * FROM case_types WHERE id = $1 AND active = TRUE`, [typeId])).rows[0];
    if (!type) { await client.query('ROLLBACK'); return res.status(400).json({ error: '案件类型不存在' }); }

    const fields = (await client.query(
      `SELECT * FROM case_fields WHERE case_type_id = $1 AND active = TRUE ORDER BY sort`, [typeId]
    )).rows;
    for (const f of fields) {
      if (f.required && !(req.body[`field_${f.id}`] || '').trim()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `请填写必填项「${f.label}」` });
      }
    }

    const feeAgreement = (req.body.fee_agreement || '').trim() || null;
    const feeDetails = (req.body.fee_details || '').trim() || null;
    await client.query(
      `UPDATE cases SET title=$1, client_name=$2, case_type_id=$3, assignee_id=$4, status_id=$5,
              status_at = CASE WHEN status_id IS DISTINCT FROM $5 THEN now() ELSE status_at END,
              updated_at = now(), next_action=$7, reminder_at=$8, fee_agreement=$9, fee_details=$10,
              sign_staff_id=$11, sign_date=$12
       WHERE id=$6`,
      [title, clientName || null, typeId, assigneeId, statusId, id, nextAction, reminderAt, feeAgreement, feeDetails, signStaffId, signDate]
    );

    await client.query(`DELETE FROM case_field_values WHERE case_id = $1 AND field_id NOT IN (
      SELECT id FROM case_fields WHERE case_type_id = $2
    )`, [id, typeId]);

    const existing = (await client.query(`SELECT field_id, value FROM case_field_values WHERE case_id = $1`, [id])).rows;
    const existingMap = {};
    existing.forEach((e) => { existingMap[e.field_id] = e.value; });

    for (const f of fields) {
      const val = (req.body[`field_${f.id}`] || '').trim();
      if (existingMap[f.id] !== undefined) {
        if (val === '') {
          await client.query(`DELETE FROM case_field_values WHERE case_id=$1 AND field_id=$2`, [id, f.id]);
        } else {
          await client.query(`UPDATE case_field_values SET value=$1 WHERE case_id=$2 AND field_id=$3`, [val, id, f.id]);
        }
      } else if (val !== '') {
        await client.query(`INSERT INTO case_field_values (case_id, field_id, value) VALUES ($1,$2,$3)`, [id, f.id, val]);
      }
    }

    await addHistory(client, id, 'edit', user.id, { statusId, note: '更新案件信息' });
    await client.query('COMMIT');
    res.json({ ok: true, id });
  } catch (e) { await client.query('ROLLBACK'); next(e); }
  finally { client.release(); }
});

/* ---------- 状态流转 ---------- */
router.post('/cases/:id/status', requirePermission('cases.edit'), needCase, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const statusId = parseInt(req.body.status_id, 10);
    const note = (req.body.note || '').trim();
    if (!statusId) { await client.query('ROLLBACK'); return res.status(400).json({ error: '请选择状态' }); }

    const st = (await client.query(`SELECT id, name FROM statuses WHERE id = $1 AND active = TRUE`, [statusId])).rows[0];
    if (!st) { await client.query('ROLLBACK'); return res.status(400).json({ error: '状态不存在' }); }

    await client.query(
      `UPDATE cases SET status_id=$1, status_note=$2, status_at=now(), updated_at=now() WHERE id=$3`,
      [statusId, note || null, req.caseRow.id]
    );
    await addHistory(client, req.caseRow.id, 'status', req.session.user.id, {
      statusId,
      note: note || `状态变更为「${st.name}」`,
    });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); next(e); }
  finally { client.release(); }
});

/* ---------- 案件删除（仅管理员） ---------- */
router.post('/cases/:id/delete', requirePermission('cases.delete'), needCase, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = req.caseRow.id;
    const files = (await client.query(`SELECT stored_name FROM attachments WHERE case_id = $1`, [id])).rows;
    const contracts = (await client.query(`SELECT pdf_path, work_pdf_path FROM contracts WHERE case_id = $1`, [id])).rows;
    const sigs = (await client.query(
      `SELECT s.signature_image_path FROM contract_signatures s JOIN contracts c ON c.id = s.contract_id WHERE c.case_id = $1`,
      [id]
    )).rows;
    await client.query(`DELETE FROM cases WHERE id = $1`, [id]);
    await client.query('COMMIT');
    const removeFile = (p) => { if (!p) return; const fp = path.join(UPLOAD_DIR, p); if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch {} } };
    for (const f of files) {
      removeFile(f.stored_name);
      removeFile(f.stored_name + '.preview.pdf');
    }
    for (const c of contracts) { removeFile(c.pdf_path); removeFile(c.work_pdf_path); }
    for (const s of sigs) { removeFile(s.signature_image_path); }
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); next(e); }
  finally { client.release(); }
});

/* ---------- 下一步流程 ---------- */
router.post('/cases/:id/next-action', requirePermission('cases.remind'), needCase, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = req.caseRow.id;
    const nextAction = (req.body.next_action || '').trim() || null;
    const reminderAt = req.body.reminder_at ? new Date(req.body.reminder_at) : null;
    await client.query(
      `UPDATE cases SET next_action=$1, reminder_at=$2, reminder_ack_at=NULL, reminder_ack_by=NULL, updated_at=now() WHERE id=$3`,
      [nextAction, reminderAt, id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
  finally { client.release(); }
});

router.post('/cases/:id/reminder/ack', needCase, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = req.caseRow.id;
    await client.query(
      `UPDATE cases SET reminder_ack_at=now(), reminder_ack_by=$1, updated_at=now() WHERE id=$2`,
      [req.session.user.id, id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
  finally { client.release(); }
});

router.post('/cases/:id/fee', requirePermission('cases.fee'), needCase, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = req.caseRow.id;
    const feeAgreement = (req.body.fee_agreement || '').trim() || null;
    const feeDetails = (req.body.fee_details || '').trim() || null;
    await client.query(
      `UPDATE cases SET fee_agreement=$1, fee_details=$2, updated_at=now() WHERE id=$3`,
      [feeAgreement, feeDetails, id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
  finally { client.release(); }
});

/* ---------- 附件上传 ---------- */
router.post('/cases/:id/attachments', requirePermission('attachments.manage'), needCase, upload.array('files', 10), validateUploadedFiles, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const files = req.files || [];
    const user = req.session.user;
    const remark = (req.body.remark || '').trim();
    if (files.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: '未选择文件' }); }

    const list = [];
    for (const f of files) {
      const fixedName = Buffer.from(f.originalname, 'latin1').toString('utf8');
      // 兜底：若客户端未提供准确 mime，则按扩展名推断
      let mime = f.mimetype || 'application/octet-stream';
      if (mime === 'application/octet-stream') {
        const ext = path.extname(f.originalname).toLowerCase();
        const mimeMap = {
          '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
          '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
          '.pdf': 'application/pdf',
          '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          '.txt': 'text/plain', '.csv': 'text/csv',
          '.zip': 'application/zip', '.rar': 'application/x-rar-compressed', '.7z': 'application/x-7z-compressed',
        };
        mime = mimeMap[ext] || 'application/octet-stream';
      }
      const ins = await client.query(
        `INSERT INTO attachments (case_id, original_name, stored_name, mime_type, size, uploaded_by, remark)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [req.caseRow.id, fixedName, f.filename, mime, f.size, user.id, remark || null]
      );
      list.push({ id: ins.rows[0].id, original_name: fixedName, remark });
    }
    await addHistory(client, req.caseRow.id, 'attachment', user.id, { note: `上传附件 ${files.length} 个` });
    await client.query('COMMIT');
    res.json({ ok: true, files: list });
  } catch (e) { await client.query('ROLLBACK'); next(e); }
  finally { client.release(); }
});

/* ---------- 附件替换 ---------- */
router.post('/attachments/:id/replace', requirePermission('attachments.manage'), upload.single('file'), validateUploadedFiles, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未选择文件' });
    const id = parseInt(req.params.id, 10);
    const att = (await pool.query(`SELECT * FROM attachments WHERE id = $1`, [id])).rows[0];
    if (!att) { if (req.file) fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)); return res.status(404).json({ error: '附件不存在' }); }

    const caseRow = await getCaseForPermission({ params: { id: att.case_id } });
    if (!canViewCase(req.session.user, caseRow)) {
      if (req.file) fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename));
      return res.status(403).json({ error: '无权操作' });
    }

    const oldPath = path.join(UPLOAD_DIR, att.stored_name);
    // 同理兜底 mime
    let mime = req.file.mimetype || 'application/octet-stream';
    if (mime === 'application/octet-stream') {
      const ext = path.extname(req.file.originalname).toLowerCase();
      const mimeMap = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.pdf': 'application/pdf',
        '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.txt': 'text/plain', '.csv': 'text/csv',
        '.zip': 'application/zip', '.rar': 'application/x-rar-compressed', '.7z': 'application/x-7z-compressed',
      };
      mime = mimeMap[ext] || 'application/octet-stream';
    }
    await pool.query(
      `UPDATE attachments SET original_name=$1, stored_name=$2, mime_type=$3, size=$4 WHERE id=$5`,
      [Buffer.from(req.file.originalname, 'latin1').toString('utf8'), req.file.filename, mime, req.file.size, id]
    );
    await pool.query(
      `INSERT INTO case_history (case_id, action, note, operator_id) VALUES ($1,'attachment',$2,$3)`,
      [att.case_id, '替换附件', req.session.user.id]
    );
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    const oldCache = oldPath + '.preview.pdf';
    if (fs.existsSync(oldCache)) fs.unlinkSync(oldCache);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- 附件删除 ---------- */
router.post('/attachments/:id/delete', requirePermission('attachments.manage'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const att = (await pool.query(`SELECT * FROM attachments WHERE id = $1`, [id])).rows[0];
    if (!att) return res.status(404).json({ error: '附件不存在' });

    const caseRow = await getCaseForPermission({ params: { id: att.case_id } });
    if (!canViewCase(req.session.user, caseRow)) return res.status(403).json({ error: '无权操作' });

    await pool.query(`DELETE FROM attachments WHERE id = $1`, [id]);
    await pool.query(
      `INSERT INTO case_history (case_id, action, note, operator_id) VALUES ($1,'attachment-del',$2,$3)`,
      [att.case_id, `删除附件：${att.original_name}`, req.session.user.id]
    );
    const fp = path.join(UPLOAD_DIR, att.stored_name);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    const cachePath = fp + '.preview.pdf';
    if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- 附件下载/预览 ---------- */
async function serveAttachment(req, res, inline) {
  try {
    const id = parseInt(req.params.id, 10);
    const att = (await pool.query(`SELECT * FROM attachments WHERE id = $1`, [id])).rows[0];
    if (!att) return res.status(404).json({ error: '附件不存在' });

    const caseRow = await getCaseForPermission({ params: { id: att.case_id } });
    if (!caseRow || !canViewCase(req.session.user, caseRow)) return res.status(403).json({ error: '无权访问' });

    const fp = path.join(UPLOAD_DIR, att.stored_name);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: '文件已被删除' });

    const safeName = Buffer.from(att.original_name, 'utf8').toString('latin1');
    // I1: 按扩展名映射安全 Content-Type；仅图片/PDF 内联，其它一律下载，避免存储型 XSS
    const mapped = contentTypeFor(att.stored_name);
    const canInline = isInlineSafe(att.stored_name);
    const ct = (inline && canInline) ? mapped : 'application/octet-stream';
    res.setHeader('Content-Disposition', `${(inline && canInline) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.original_name)}; filename="${safeName}"`);
    res.setHeader('Content-Type', ct);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    fs.createReadStream(fp).pipe(res);
  } catch (e) { next(e); }
}

router.get('/attachments/:id/download', (req, res, next) => serveAttachment(req, res, false).catch(next));
router.get('/attachments/:id/file', (req, res, next) => serveAttachment(req, res, true).catch(next));

/* 预览：图片/PDF 渲染页面，Word 转换 PDF 预览，其它类型直接内联（浏览器自行处理） */
router.get('/attachments/:id/preview', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const att = (await pool.query(`SELECT * FROM attachments WHERE id = $1`, [id])).rows[0];
    if (!att) return res.status(404).render('error', { title: '附件不存在', message: '附件不存在或已被删除。', user: req.session.user });

    const caseRow = await getCaseForPermission({ params: { id: att.case_id } });
    if (!caseRow || !canViewCase(req.session.user, caseRow)) return res.status(403).render('error', { title: '无权访问', message: '您无权查看该附件。', user: req.session.user });

    const fp = path.join(UPLOAD_DIR, att.stored_name);
    if (!fs.existsSync(fp)) return res.status(404).render('error', { title: '文件丢失', message: '文件已被删除。', user: req.session.user });

    const mime = att.mime_type || '';
    const lower = att.original_name.toLowerCase();
    const isImage = mime.startsWith('image/');
    const isPdf = mime === 'application/pdf' || lower.endsWith('.pdf');
    const isWord = mime.includes('wordprocessing') || mime === 'application/msword' || /\.(docx?|wps|rtf)$/.test(lower);
    const isExcel = mime.includes('spreadsheet') || mime === 'application/vnd.ms-excel' || /\.(xlsx?|csv)$/.test(lower);

    if (isImage || isPdf || isWord || isExcel) {
      res.render('cases/preview', { att, caseId: caseRow.id, isImage, isPdf, isWord, isExcel, layout: false });
    } else {
      // 其他类型直接内联流式传输，浏览器若支持则预览，否则下载
      serveAttachment(req, res, true).catch(next);
    }
  } catch (e) { next(e); }
});

/* 预览文件流：PDF 直接内联；Word 转换 PDF 后内联（带缓存） */
router.get('/attachments/:id/preview-file', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const att = (await pool.query(`SELECT * FROM attachments WHERE id = $1`, [id])).rows[0];
    if (!att) return res.status(404).json({ error: '附件不存在' });

    const caseRow = await getCaseForPermission({ params: { id: att.case_id } });
    if (!caseRow || !canViewCase(req.session.user, caseRow)) return res.status(403).json({ error: '无权访问' });

    const fp = path.join(UPLOAD_DIR, att.stored_name);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: '文件已被删除' });

    const lower = att.original_name.toLowerCase();
    const isOffice = (att.mime_type || '').includes('wordprocessing') || att.mime_type === 'application/msword'
      || (att.mime_type || '').includes('spreadsheet') || att.mime_type === 'application/vnd.ms-excel'
      || /\.(docx?|wps|rtf|xlsx?|csv)$/.test(lower);

    let servePath = fp;
    let mime = att.mime_type || 'application/octet-stream';

    if (isOffice) {
      const cached = path.join(UPLOAD_DIR, att.stored_name + '.preview.pdf');
      if (!fs.existsSync(cached)) {
        try {
          await convertOfficeToPdf(fp, cached);
        } catch (e) {
          return serveAttachment(req, res, true).catch(next);
        }
      }
      if (fs.existsSync(cached)) { servePath = cached; mime = 'application/pdf'; }
    }

    const safeName = Buffer.from(att.original_name, 'utf8').toString('latin1');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(att.original_name)}; filename="${safeName}"`);
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(servePath).pipe(res);
  } catch (e) { next(e); }
});

/* ---------- 类型字段（表单切换用） ---------- */
router.get('/types/:id/fields', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const fields = (await pool.query(
      `SELECT * FROM case_fields WHERE case_type_id = $1 AND active = TRUE ORDER BY sort`, [id]
    )).rows;
    res.json(fields);
  } catch (e) { next(e); }
});

/* ---------- 用户管理 ---------- */
router.post('/users/create', requirePermission('system.users'), async (req, res, next) => {
  try {
    const username = (req.body.username || '').trim();
    const displayName = (req.body.display_name || '').trim();
    const password = req.body.password || '';
    const isSuperAdmin = req.session.user.role === 'super_admin';
    const role = (req.body.role === 'admin' && isSuperAdmin) ? 'admin' : 'staff';
    const securityQuestion = (req.body.security_question || '').trim();
    const securityAnswer = (req.body.security_answer || '').trim();
    const pwErr = validatePasswordStrength(password);
    if (!username || !displayName || pwErr) {
      return res.status(400).json({ error: pwErr || '用户名、姓名必填，密码至少 8 位且须包含字母和数字' });
    }
    const dup = (await pool.query(`SELECT id FROM users WHERE username = $1`, [username])).rows;
    if (dup.length) return res.status(400).json({ error: '用户名已存在' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, display_name, role, security_question, security_answer) VALUES ($1,$2,$3,$4,$5,$6)`,
      [username, hash, displayName, role, securityQuestion || null, securityAnswer || null]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/users/:id/update', requirePermission('system.users'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const displayName = (req.body.display_name || '').trim();
    const isSuperAdmin = req.session.user.role === 'super_admin';
    const active = req.body.active === '1';
    if (!displayName) return res.status(400).json({ error: '姓名不能为空' });
    const target = (await pool.query(`SELECT * FROM users WHERE id = $1`, [id])).rows[0];
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if (target.role === 'super_admin' || target.role === 'admin') {
      if (!isSuperAdmin) return res.status(403).json({ error: '仅超级管理员可管理管理员账号' });
    } else if (req.body.role === 'admin' && !isSuperAdmin) {
      return res.status(403).json({ error: '仅超级管理员可创建管理员账号' });
    }
    const role = target.role === 'super_admin' ? 'super_admin' : ((req.body.role === 'admin' && isSuperAdmin) ? 'admin' : 'staff');
    if (target.id === req.session.user.id && target.role === 'super_admin') {
      return res.status(400).json({ error: '不能修改超级管理员账号的权限或停用自己' });
    }
    if (target.id === req.session.user.id && (target.role === 'admin') && role !== 'admin') {
      return res.status(400).json({ error: '不能移除自己的管理员权限' });
    }
    await pool.query(
      `UPDATE users SET display_name=$1, role=$2, active=$3 WHERE id=$4`,
      [displayName, role, active, id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/users/:id/reset', requirePermission('system.users'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const password = req.body.password || '';
    const pwErr = validatePasswordStrength(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const target = (await pool.query(`SELECT role FROM users WHERE id = $1`, [id])).rows[0];
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if ((target.role === 'super_admin' || target.role === 'admin') && req.session.user.role !== 'super_admin') {
      return res.status(403).json({ error: '仅超级管理员可重置管理员账号密码' });
    }
    const hash = await bcrypt.hash(password, 10);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/users/:id/security-question', requirePermission('system.users'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const question = (req.body.security_question || '').trim();
    const answer = (req.body.security_answer || '').trim();
    if (!question || !answer) return res.status(400).json({ error: '安全问题和答案都不能为空' });
    const target = (await pool.query(`SELECT role FROM users WHERE id = $1`, [id])).rows[0];
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if ((target.role === 'super_admin' || target.role === 'admin') && req.session.user.role !== 'super_admin') {
      return res.status(403).json({ error: '仅超级管理员可修改管理员账号的安全问题' });
    }
    const answerHash = await bcrypt.hash(answer, 10);
    await pool.query(`UPDATE users SET security_question = $1, security_answer = $2 WHERE id = $3`, [question, answerHash, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/users/:id/delete', requirePermission('system.users'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.session.user.id) return res.status(400).json({ error: '不能删除自己' });
    const target = (await pool.query(`SELECT role FROM users WHERE id = $1`, [id])).rows[0];
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if ((target.role === 'super_admin' || target.role === 'admin') && req.session.user.role !== 'super_admin') {
      return res.status(403).json({ error: '仅超级管理员可停用管理员账号' });
    }
    await pool.query(`UPDATE users SET active = FALSE WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- 角色权限配置 ---------- */
router.post('/roles/permissions', requirePermission('system.roles'), async (req, res, next) => {
  try {
    const role = (req.body.role || '').trim();
    const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : [];
    if (role !== 'admin' && role !== 'staff') {
      return res.status(400).json({ error: '仅可配置管理员或员工的权限' });
    }
    const { setPermissions } = require('../src/permissions');
    await setPermissions(role, permissions);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- 案件类型 ---------- */
router.post('/types/create', requirePermission('system.settings'), async (req, res, next) => {
  try {
    const code = (req.body.code || '').trim().toUpperCase();
    const name = (req.body.name || '').trim();
    const color = (req.body.color || '#0d6efd').trim();
    if (!code || !name) return res.status(400).json({ error: '类型编码和名称必填' });
    if (!/^[A-Z]{1,6}$/.test(code)) return res.status(400).json({ error: '编码只能是大写字母，1-6 位（如 JT）' });
    const dup = (await pool.query(`SELECT id FROM case_types WHERE code = $1`, [code])).rows;
    if (dup.length) return res.status(400).json({ error: '编码已存在' });
    const ins = await pool.query(
      `INSERT INTO case_types (code, name, color) VALUES ($1,$2,$3) RETURNING id`,
      [code, name, color]
    );
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});

router.post('/types/:id/update', requirePermission('system.settings'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const name = (req.body.name || '').trim();
    const color = (req.body.color || '#0d6efd').trim();
    const sort = parseInt(req.body.sort, 10) || 0;
    const active = req.body.active === '1';
    if (!name) return res.status(400).json({ error: '类型名称不能为空' });
    await pool.query(`UPDATE case_types SET name=$1, color=$2, sort=$3, active=$4 WHERE id=$5`, [name, color, sort, active, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/types/:id/delete', requirePermission('system.settings'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cnt = (await pool.query(`SELECT COUNT(*)::int AS n FROM cases WHERE case_type_id = $1`, [id])).rows[0].n;
    if (cnt > 0) return res.status(400).json({ error: `该类型下还有 ${cnt} 起案件，无法删除。可将类型设为停用。` });
    await pool.query(`DELETE FROM case_types WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- 动态字段 ---------- */
router.post('/fields/create', requirePermission('system.settings'), async (req, res, next) => {
  try {
    const typeId = parseInt(req.body.case_type_id, 10);
    const label = (req.body.label || '').trim();
    const fieldType = req.body.field_type || 'text';
    const required = req.body.required === '1';
    const placeholder = (req.body.placeholder || '').trim();
    const optionsRaw = (req.body.options || '').trim();
    if (!typeId || !label) return res.status(400).json({ error: '所属类型和字段名称必填' });
    if (!['text', 'textarea', 'number', 'date', 'select', 'phone'].includes(fieldType)) {
      return res.status(400).json({ error: '字段类型不正确' });
    }
    if (fieldType === 'select' && !optionsRaw) return res.status(400).json({ error: '下拉选项不能为空，用逗号分隔' });
    const options = fieldType === 'select' ? JSON.stringify(optionsRaw.split(/[,，]/).map((o) => ({ label: o.trim() })).filter((o) => o.label)) : null;
    const sort = parseInt(req.body.sort, 10) || 999;
    const ins = await pool.query(
      `INSERT INTO case_fields (case_type_id, label, field_type, options, required, placeholder, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [typeId, label, fieldType, options, required, placeholder || null, sort]
    );
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});

router.post('/fields/:id/update', requirePermission('system.settings'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const label = (req.body.label || '').trim();
    const required = req.body.required === '1';
    const placeholder = (req.body.placeholder || '').trim();
    const sort = parseInt(req.body.sort, 10) || 999;
    if (!label) return res.status(400).json({ error: '字段名称不能为空' });
    await pool.query(`UPDATE case_fields SET label=$1, required=$2, placeholder=$3, sort=$4 WHERE id=$5`, [label, required, placeholder || null, sort, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/fields/:id/toggle', requirePermission('system.settings'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const active = req.body.active === '1';
    await pool.query(`UPDATE case_fields SET active=$1 WHERE id=$2`, [active, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/fields/:id/delete', requirePermission('system.settings'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query(`DELETE FROM case_field_values WHERE field_id = $1`, [id]);
    await pool.query(`DELETE FROM case_fields WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- 状态管理 ---------- */
const CATEGORY_LABELS = {
  pending: '待处理', processing: '处理中', litigation: '诉讼中', closed: '已结案', archived: '已归档',
};
router.post('/statuses/create', requirePermission('system.settings'), async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    const category = req.body.category || 'processing';
    const color = (req.body.color || '#0d6efd').trim();
    if (!name) return res.status(400).json({ error: '状态名称必填' });
    if (!CATEGORY_LABELS[category]) return res.status(400).json({ error: '状态分类不正确' });
    await pool.query(`INSERT INTO statuses (name, category, color) VALUES ($1,$2,$3)`, [name, category, color]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/statuses/:id/update', requirePermission('system.settings'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const name = (req.body.name || '').trim();
    const category = req.body.category || 'processing';
    const color = (req.body.color || '#0d6efd').trim();
    const sort = parseInt(req.body.sort, 10) || 0;
    const active = req.body.active === '1';
    if (!name) return res.status(400).json({ error: '状态名称必填' });
    await pool.query(`UPDATE statuses SET name=$1, category=$2, color=$3, sort=$4, active=$5 WHERE id=$6`, [name, category, color, sort, active, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/statuses/:id/delete', requirePermission('system.settings'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cnt = (await pool.query(`SELECT COUNT(*)::int AS n FROM cases WHERE status_id = $1`, [id])).rows[0].n;
    if (cnt > 0) return res.status(400).json({ error: `还有 ${cnt} 起案件处于该状态，无法删除。可将状态设为停用。` });
    await pool.query(`DELETE FROM case_history WHERE status_id = $1`, [id]);
    await pool.query(`DELETE FROM statuses WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- 应用设置（公司品牌/主题） ---------- */
router.get('/settings', requirePermission('system.settings'), async (req, res, next) => {
  try {
    const rows = (await pool.query(`SELECT key, value, description FROM app_settings ORDER BY id`)).rows;
    const obj = {};
    for (const r of rows) obj[r.key] = r.value;
    res.json({ ok: true, settings: obj });
  } catch (e) { next(e); }
});

router.post('/settings', requirePermission('system.settings'), async (req, res, next) => {
  try {
    const allowed = ['company_name', 'theme_mode', 'theme_primary', 'theme_sidebar', 'bg_gradient', 'app_url', 'reminder_advance_days'];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const k of allowed) {
        if (req.body[k] !== undefined) {
          const val = String(req.body[k]).trim();
          await client.query(
            `INSERT INTO app_settings (key, value) VALUES ($1,$2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [k, val]
          );
        }
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) { next(e); }
});

/* Logo 上传 */
router.post('/settings/logo', requirePermission('system.settings'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未选择文件' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename));
      return res.status(400).json({ error: '仅支持 png/jpg/webp' });
    }
    const logoDir = path.join(UPLOAD_DIR, 'logo');
    if (!fs.existsSync(logoDir)) fs.mkdirSync(logoDir, { recursive: true });
    const stored = 'logo' + ext;
    const dest = path.join(logoDir, stored);
    fs.renameSync(path.join(UPLOAD_DIR, req.file.filename), dest);
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('company_logo', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [stored]
    );
    res.json({ ok: true, logo: stored });
  } catch (e) { next(e); }
});

/* ---------- 备份与恢复（仅超级管理员） ---------- */
const {
  runBackup, restoreBackup, listBackups, deleteBackup, pruneOldBackups,
  readBackupSettings, saveBackupSettings, BACKUP_DIR
} = require('../src/backup');

function requireSuperAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'super_admin') {
    return res.status(403).json({ error: '仅超级管理员可执行此操作' });
  }
  next();
}

router.get('/backup/list', requireSuperAdmin, async (req, res, next) => {
  try {
    res.json({ ok: true, files: listBackups(), dir: BACKUP_DIR });
  } catch (e) { next(e); }
});

router.get('/backup/download/:file', requireSuperAdmin, async (req, res, next) => {
  try {
    const name = path.basename(String(req.params.file || ''));
    if (!/^backup-\d{8}-\d{6}\.json$/.test(name)) return res.status(400).json({ error: '非法的备份文件名' });
    const full = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(full)) return res.status(404).json({ error: '备份文件不存在' });
    res.download(full, name);
  } catch (e) { next(e); }
});

router.post('/backup/create', requireSuperAdmin, async (req, res, next) => {
  try {
    const r = await runBackup();
    res.json({ ok: true, file: r.file, size: r.size });
  } catch (e) { next(e); }
});

router.post('/backup/restore', requireSuperAdmin, async (req, res, next) => {
  try {
    const file = String(req.body.file || '').trim();
    if (!file) return res.status(400).json({ error: '未指定备份文件' });
    await restoreBackup(file);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/backup/delete', requireSuperAdmin, async (req, res, next) => {
  try {
    const file = String(req.body.file || '').trim();
    if (!file) return res.status(400).json({ error: '未指定备份文件' });
    deleteBackup(file);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/backup/settings', requireSuperAdmin, async (req, res, next) => {
  try {
    res.json({ ok: true, settings: await readBackupSettings() });
  } catch (e) { next(e); }
});

router.post('/backup/settings', requireSuperAdmin, async (req, res, next) => {
  try {
    const s = await saveBackupSettings(req.body);
    res.json({ ok: true, settings: s });
  } catch (e) { next(e); }
});

/* ---------- 案件当事人 ---------- */
router.get('/cases/:id/parties', async (req, res, next) => {
  try {
    const c = await getCaseForPermission(req);
    if (!c || !canViewCase(req.session.user, c)) return res.status(403).json({ error: '无权访问' });
    const { rows } = await pool.query(
      `SELECT * FROM case_parties WHERE case_id = $1 ORDER BY sort, id`, [c.id]
    );
    res.json({ ok: true, parties: rows });
  } catch (e) { next(e); }
});

router.post('/cases/:id/parties', requirePermission('parties.manage'), async (req, res, next) => {
  try {
    const c = await getCaseForPermission(req);
    if (!c || !canViewCase(req.session.user, c)) return res.status(403).json({ error: '无权操作' });
    const { name, role, gender, age, id_card, phone, address, contact_person, contact_phone, injury_info, hospital_dept, remark, sort } = req.body;
    if (!name || !role) return res.status(400).json({ error: '姓名和角色必填' });
    const ins = await pool.query(
      `INSERT INTO case_parties (case_id, name, role, gender, age, id_card, phone, address, contact_person, contact_phone, injury_info, hospital_dept, remark, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [c.id, name, role, gender || null, age ? parseInt(age) : null, id_card || null, phone || null, address || null, contact_person || null, contact_phone || null, injury_info || null, hospital_dept || null, remark || null, parseInt(sort) || 0]
    );
    await addHistory(pool, c.id, 'edit', req.session.user.id, { note: `新增当事人：${name} (${role})` });
    res.json({ ok: true, party: ins.rows[0] });
  } catch (e) { next(e); }
});

router.post('/cases/:id/parties/:pid', requirePermission('parties.manage'), async (req, res, next) => {
  try {
    const c = await getCaseForPermission(req);
    if (!c || !canViewCase(req.session.user, c)) return res.status(403).json({ error: '无权操作' });
    const pid = parseInt(req.params.pid, 10);
    const { name, role, gender, age, id_card, phone, address, contact_person, contact_phone, injury_info, hospital_dept, remark, sort } = req.body;
    if (!name || !role) return res.status(400).json({ error: '姓名和角色必填' });
    await pool.query(
      `UPDATE case_parties SET name=$1, role=$2, gender=$3, age=$4, id_card=$5, phone=$6, address=$7, contact_person=$8, contact_phone=$9, injury_info=$10, hospital_dept=$11, remark=$12, sort=$13
       WHERE id=$14 AND case_id=$15`,
      [name, role, gender || null, age ? parseInt(age) : null, id_card || null, phone || null, address || null, contact_person || null, contact_phone || null, injury_info || null, hospital_dept || null, remark || null, parseInt(sort) || 0, pid, c.id]
    );
    await addHistory(pool, c.id, 'edit', req.session.user.id, { note: `编辑当事人：${name} (${role})` });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/cases/:id/parties/:pid/delete', requirePermission('parties.manage'), async (req, res, next) => {
  try {
    const c = await getCaseForPermission(req);
    if (!c || !canViewCase(req.session.user, c)) return res.status(403).json({ error: '无权操作' });
    const pid = parseInt(req.params.pid, 10);
    const old = (await pool.query(`SELECT name, role FROM case_parties WHERE id=$1 AND case_id=$2`, [pid, c.id])).rows[0];
    await pool.query(`DELETE FROM case_parties WHERE id=$1 AND case_id=$2`, [pid, c.id]);
    if (old) await addHistory(pool, c.id, 'edit', req.session.user.id, { note: `删除当事人：${old.name} (${old.role})` });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- 导出：CSV（仅管理员） ---------- */
router.get('/cases/export/csv', requirePermission('cases.import_export'), async (req, res, next) => {
  try {
    const user = req.session.user;
    const canViewAll = hasPermission(user, 'cases.view_all');
    const kw = (req.query.kw || '').trim();
    const typeId = parseInt(req.query.type, 10) || null;
    const statusId = parseInt(req.query.status, 10) || null;
    const assigneeId = parseInt(req.query.assignee, 10) || null;

    const where = [];
    const params = [];
    if (kw) { params.push(`%${kw}%`); where.push(`(c.case_no ILIKE $${params.length} OR c.title ILIKE $${params.length} OR c.client_name ILIKE $${params.length})`); }
    if (typeId) { params.push(typeId); where.push(`c.case_type_id = $${params.length}`); }
    if (statusId) { params.push(statusId); where.push(`c.status_id = $${params.length}`); }
    if (assigneeId && canViewAll) { params.push(assigneeId); where.push(`c.assignee_id = $${params.length}`); }
    if (!canViewAll) { params.push(user.id); where.push(`c.assignee_id = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows: cases } = await pool.query(
      `SELECT c.case_no, c.title, c.client_name, c.created_at, c.updated_at,
              t.name AS type_name, s.name AS status_name, u.display_name AS assignee_name
       FROM cases c
       LEFT JOIN case_types t ON t.id = c.case_type_id
       LEFT JOIN statuses s ON s.id = c.status_id
       LEFT JOIN users u ON u.id = c.assignee_id
       ${whereSql}
       ORDER BY c.updated_at DESC`,
      params
    );

    const headers = ['案号', '案件名称', '客户/当事人', '类型', '状态', '负责人', '创建时间', '最近更新'];
    const rows = cases.map(c => [
      c.case_no, c.title, c.client_name || '', c.type_name || '', c.status_name || '',
      c.assignee_name || '', new Date(c.created_at).toLocaleString('zh-CN'),
      new Date(c.updated_at).toLocaleString('zh-CN')
    ]);

    const csv = [headers.join(',')].concat(rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(','))).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('案件列表_' + new Date().toISOString().slice(0,10) + '.csv')}`);
    res.send('\uFEFF' + csv); // BOM for Excel
  } catch (e) { next(e); }
});

/* ---------- 导出：Excel (XLSX)（仅管理员） ---------- */
router.get('/cases/export/xlsx', requirePermission('cases.import_export'), async (req, res, next) => {
  try {
    const ExcelJS = require('exceljs');
    const user = req.session.user;
    const canViewAll = hasPermission(user, 'cases.view_all');
    const kw = (req.query.kw || '').trim();
    const typeId = parseInt(req.query.type, 10) || null;
    const statusId = parseInt(req.query.status, 10) || null;
    const assigneeId = parseInt(req.query.assignee, 10) || null;

    const where = [];
    const params = [];
    if (kw) { params.push(`%${kw}%`); where.push(`(c.case_no ILIKE $${params.length} OR c.title ILIKE $${params.length} OR c.client_name ILIKE $${params.length})`); }
    if (typeId) { params.push(typeId); where.push(`c.case_type_id = $${params.length}`); }
    if (statusId) { params.push(statusId); where.push(`c.status_id = $${params.length}`); }
    if (assigneeId && canViewAll) { params.push(assigneeId); where.push(`c.assignee_id = $${params.length}`); }
    if (!canViewAll) { params.push(user.id); where.push(`c.assignee_id = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows: cases } = await pool.query(
      `SELECT c.case_no, c.title, c.client_name, c.created_at, c.updated_at,
              t.name AS type_name, s.name AS status_name, u.display_name AS assignee_name
       FROM cases c
       LEFT JOIN case_types t ON t.id = c.case_type_id
       LEFT JOIN statuses s ON s.id = c.status_id
       LEFT JOIN users u ON u.id = c.assignee_id
       ${whereSql}
       ORDER BY c.updated_at DESC`,
      params
    );

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('案件列表');
    ws.columns = [
      { header: '案号', key: 'case_no', width: 20 },
      { header: '案件名称', key: 'title', width: 30 },
      { header: '客户/当事人', key: 'client_name', width: 20 },
      { header: '类型', key: 'type_name', width: 12 },
      { header: '状态', key: 'status_name', width: 12 },
      { header: '负责人', key: 'assignee_name', width: 15 },
      { header: '创建时间', key: 'created_at', width: 22 },
      { header: '最近更新', key: 'updated_at', width: 22 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const c of cases) {
      ws.addRow({
        case_no: c.case_no,
        title: c.title,
        client_name: c.client_name || '',
        type_name: c.type_name || '',
        status_name: c.status_name || '',
        assignee_name: c.assignee_name || '',
        created_at: new Date(c.created_at).toLocaleString('zh-CN'),
        updated_at: new Date(c.updated_at).toLocaleString('zh-CN'),
      });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('案件列表_' + new Date().toISOString().slice(0,10) + '.xlsx')}`);
    await wb.xlsx.write(res);
  } catch (e) { next(e); }
});

/* ---------- 导入模板下载（CSV，仅管理员） ---------- */
router.get('/cases/import/template', requirePermission('cases.import_export'), (req, res) => {
  const headers = ['case_type_code', 'title', 'client_name', 'assignee_username', 'status_name'];
  // 示例行
  const sample = ['JT', '张三交通事故理赔案', '张三', 'lisi', '理赔中'];
  const csv = [headers.join(','), sample.join(',')].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('案件导入模板.csv')}`);
  res.send('\uFEFF' + csv);
});

/* ---------- 导入（CSV，仅管理员） ---------- */
router.post('/cases/import', requirePermission('cases.import_export'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未选择文件' });
    const content = req.file.buffer.toString('utf8');
    const lines = content.trim().split(/\r?\n/);
    if (lines.length < 2) return res.status(400).json({ error: '文件内容为空' });
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const expected = ['case_type_code', 'title', 'client_name', 'assignee_username', 'status_name'];
    if (!expected.every((h, i) => headers[i]?.toLowerCase() === h)) {
      return res.status(400).json({ error: 'CSV 表头不匹配，请使用模板文件' });
    }

    const user = req.session.user;
    const results = { success: 0, failed: 0, errors: [] };

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      if (cols.length < 5) { results.failed++; results.errors.push(`第 ${i+1} 行：列数不足`); continue; }
      const [caseTypeCode, title, clientName, assigneeUsername, statusName] = cols;
      if (!title) { results.failed++; results.errors.push(`第 ${i+1} 行：案件名称必填`); continue; }

      // 查类型
      const typeRow = (await pool.query(`SELECT id FROM case_types WHERE code = $1 AND active = TRUE`, [caseTypeCode.toUpperCase()])).rows[0];
      if (!typeRow) { results.failed++; results.errors.push(`第 ${i+1} 行：案件类型代码 "${caseTypeCode}" 不存在或已停用`); continue; }

      // 查负责人（可选）
      let assigneeId = null;
      if (assigneeUsername) {
        const urow = (await pool.query(`SELECT id FROM users WHERE username = $1 AND active = TRUE`, [assigneeUsername])).rows[0];
        if (!urow) { results.failed++; results.errors.push(`第 ${i+1} 行：负责人 "${assigneeUsername}" 不存在`); continue; }
        if (!hasPermission(user, 'cases.assign') && urow.id !== user.id) { results.failed++; results.errors.push(`第 ${i+1} 行：无权指定该负责人`); continue; }
        assigneeId = urow.id;
      } else if (!hasPermission(user, 'cases.assign')) {
        assigneeId = user.id;
      }

      // 查状态
      const srow = (await pool.query(`SELECT id FROM statuses WHERE name = $1 AND active = TRUE`, [statusName])).rows[0];
      if (!srow) { results.failed++; results.errors.push(`第 ${i+1} 行：状态 "${statusName}" 不存在或已停用`); continue; }

      // 必填字段校验
      const fields = (await pool.query(`SELECT id FROM case_fields WHERE case_type_id = $1 AND required = TRUE AND active = TRUE`, [typeRow.id])).rows;
      // 这里简化：仅校验有必填字段存在，实际导入需更复杂的字段映射，暂跳过
      if (fields.length > 0) {
        results.failed++; results.errors.push(`第 ${i+1} 行：该类型有必填动态字段，请在系统中手动完善`);
        continue;
      }

      // 生成案号并插入
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const year = new Date().getFullYear();
        const prefix = `${typeRow.code}-${year}-`;
        const { rows: cntRows } = await client.query(`SELECT COUNT(*)::int AS cnt FROM cases WHERE case_type_id = $1 AND case_no LIKE $2`, [typeRow.id, `${prefix}%`]);
        const caseNo = `${prefix}${String(cntRows[0].cnt + 1).padStart(4, '0')}`;
        const ins = await client.query(
          `INSERT INTO cases (case_no, case_type_id, title, client_name, assignee_id, status_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [caseNo, typeRow.id, title, clientName || null, assigneeId, srow.id, user.id]
        );
        await addHistory(client, ins.rows[0].id, 'created', user.id, { note: 'CSV 导入创建' });
        await client.query('COMMIT');
        results.success++;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally { client.release(); }
    }

    fs.unlinkSync(req.file.path);
    res.json({ ok: true, ...results });
  } catch (e) { next(e); }
});

/* ---------- 合同模板 ---------- */
router.get('/contract-templates', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ct.*, t.name AS type_name FROM contract_templates ct
       LEFT JOIN case_types t ON t.id = ct.case_type_id
       WHERE ct.active = TRUE ORDER BY ct.id`
    );
    res.json({ ok: true, templates: rows });
  } catch (e) { next(e); }
});

router.post('/contract-templates', requirePermission('contracts.manage'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传合同文件（PDF 或 Word）' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!['.pdf', '.doc', '.docx'].includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: '仅支持 PDF 或 Word（.doc/.docx）格式' });
    }
    const { name, case_type_id, sign_positions, text_fields } = req.body;
    if (!name) return res.status(400).json({ error: '模板名称必填' });
    const contractsDir = path.join(UPLOAD_DIR, 'contracts');
    if (!fs.existsSync(contractsDir)) fs.mkdirSync(contractsDir, { recursive: true });
    const base = `tpl_${Date.now()}_${req.file.filename.replace(/\.(docx?|pdf)$/i, '')}`;
    let pdfName = null;
    if (ext === '.pdf') {
      pdfName = `${base}.pdf`;
      fs.renameSync(req.file.path, path.join(contractsDir, pdfName));
    } else {
      const wordPath = path.join(contractsDir, `${base}${ext}`);
      fs.renameSync(req.file.path, wordPath);
      pdfName = `${base}.pdf`;
      try {
        await convertOfficeToPdf(wordPath, path.join(contractsDir, pdfName));
        fs.unlinkSync(wordPath);
      } catch (e) {
        fs.unlinkSync(wordPath);
        return res.status(500).json({ error: `Word 转 PDF 失败：${e.message}` });
      }
    }
    const ins = await pool.query(
      `INSERT INTO contract_templates (name, case_type_id, pdf_path, sign_positions, text_fields) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, case_type_id || null, `contracts/${pdfName}`, sign_positions || '[]', text_fields || '[]']
    );
    res.json({ ok: true, template: ins.rows[0] });
  } catch (e) { next(e); }
});

router.post('/contract-templates/:id/delete', requirePermission('contracts.manage'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const tpl = (await pool.query(`SELECT pdf_path FROM contract_templates WHERE id = $1`, [id])).rows[0];
    if (tpl?.pdf_path) {
      const fp = path.join(UPLOAD_DIR, tpl.pdf_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await pool.query(`UPDATE contract_templates SET active = FALSE WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 重命名模板
router.post('/contract-templates/:id/rename', requirePermission('contracts.manage'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: '模板名称必填' });
    const tpl = (await pool.query(`SELECT id FROM contract_templates WHERE id = $1 AND active = TRUE`, [id])).rows[0];
    if (!tpl) return res.status(404).json({ error: '模板不存在' });
    await pool.query(`UPDATE contract_templates SET name = $1 WHERE id = $2`, [name, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 可视化编辑器：保存签名位置与文本字段（仅管理员）
router.post('/contract-templates/:id/positions', requirePermission('contracts.manage'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { sign_positions, text_fields } = req.body;
    if (!Array.isArray(sign_positions)) return res.status(400).json({ error: 'sign_positions 必须是数组' });
    if (!Array.isArray(text_fields)) return res.status(400).json({ error: 'text_fields 必须是数组' });
    const tpl = (await pool.query(`SELECT id FROM contract_templates WHERE id = $1 AND active = TRUE`, [id])).rows[0];
    if (!tpl) return res.status(404).json({ error: '模板不存在' });
    await pool.query(
      `UPDATE contract_templates SET sign_positions=$1, text_fields=$2 WHERE id=$3`,
      [JSON.stringify(sign_positions), JSON.stringify(text_fields), id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 可视化编辑器：加载模板 PDF（仅管理员）
router.get('/contract-templates/:id/pdf', requirePermission('contracts.manage'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const tpl = (await pool.query(`SELECT pdf_path FROM contract_templates WHERE id = $1 AND active = TRUE`, [id])).rows[0];
    if (!tpl?.pdf_path) return res.status(404).json({ error: '模板不存在' });
    const fp = path.join(UPLOAD_DIR, tpl.pdf_path);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: '模板文件不存在' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(fp).pipe(res);
  } catch (e) { next(e); }
});

/* ---------- 合同管理 ---------- */
// 创建合同：选择模板、指定签署当事人、生成签署链接
router.post('/cases/:id/contracts', requirePermission('contracts.manage'), async (req, res, next) => {
  try {
    const c = await getCaseForPermission(req);
    if (!c || !canViewCase(req.session.user, c)) return res.status(403).json({ error: '无权操作' });
    const { template_id, title, party_ids } = req.body; // party_ids: 当事人ID数组，顺序对应模板签名位置
    if (!template_id || !title) return res.status(400).json({ error: '模板和标题必填' });

    const tpl = (await pool.query(`SELECT * FROM contract_templates WHERE id = $1 AND active = TRUE`, [template_id])).rows[0];
    if (!tpl) return res.status(404).json({ error: '模板不存在' });

    const parties = (await pool.query(`SELECT * FROM case_parties WHERE case_id = $1 AND id = ANY($2) ORDER BY sort`, [c.id, party_ids || []])).rows;
    if (!parties.length) return res.status(400).json({ error: '至少选择一位签署当事人' });

    // 创建合同记录
    const ins = await pool.query(
      `INSERT INTO contracts (case_id, template_id, title, status, initiator_id) VALUES ($1,$2,$3,'sent',$4) RETURNING *`,
      [c.id, template_id, title, req.session.user.id]
    );
    const contract = ins.rows[0];

    // 为每个签名位置生成签署记录：优先按角色匹配当事人，未匹配的位置用框标签作为签署人
    const signPositions = parseJsonArray(tpl.sign_positions);
    const crypto = require('crypto');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    // 单链接多人签署：整份合同共用一个签署令牌，当事人与代理人在同一链接内依次签字
    const contractToken = crypto.randomBytes(32).toString('hex');
    const insertSig = (partyId, partyName, partyRole) => {
      return pool.query(
        `INSERT INTO contract_signatures (contract_id, party_id, party_name, party_role, sign_token, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
        [contract.id, partyId, partyName, partyRole, contractToken, expiresAt]
      );
    };
    if (!signPositions.length) {
      // 模板未配置签名位置：按选择的当事人逐个生成
      for (const p of parties) await insertSig(p.id, p.name, p.role || '');
    } else {
      // 按位置顺序分配当事人：先按角色精确匹配，再按剩余顺序补位
      const used = new Set();
      const slotParty = signPositions.map((pos) => {
        const byRole = parties.find(pp => !used.has(pp.id) && pos.party_role && pos.party_role === pp.role);
        if (byRole) { used.add(byRole.id); return byRole; }
        const any = parties.find(pp => !used.has(pp.id));
        if (any) { used.add(any.id); return any; }
        return null;
      });
      for (let i = 0; i < signPositions.length; i++) {
        const pos = signPositions[i] || {};
        const p = slotParty[i];
        if (p) {
          await insertSig(p.id, p.name, p.role || pos.party_role || '');
        } else {
          const name = pos.label || pos.party_role || '待签署';
          await insertSig(null, name, pos.party_role || name);
        }
      }
    }

    // 预填充文本：把模板的文本字段绘制到 PDF 副本上，作为合同工作稿
    const textFields = parseJsonArray(tpl.text_fields);
    if (textFields.length) {
      try {
        const { PDFDocument } = require('pdf-lib');
        const tplPath = path.join(UPLOAD_DIR, tpl.pdf_path);
        if (fs.existsSync(tplPath)) {
          const pdfDoc = await PDFDocument.load(fs.readFileSync(tplPath));
          const cjkFont = await embedCjkFont(pdfDoc);
          if (cjkFont) {
            const ok = stampTextFields(pdfDoc, textFields, {
              title: contract.title,
              case_no: c.case_no,
              client_name: c.client_name,
              parties
            }, cjkFont);
            if (ok) {
              const pdfBytes = await pdfDoc.save();
              const workFile = `work_${contract.id}_${Date.now()}.pdf`;
              const workPath = path.join(UPLOAD_DIR, 'contracts', workFile);
              fs.writeFileSync(workPath, pdfBytes);
              await pool.query(`UPDATE contracts SET work_pdf_path = $1 WHERE id = $2`, [`contracts/${workFile}`, contract.id]);
            }
          } else {
            console.warn('[contracts] 未找到中文字体，跳过文本预填充');
          }
        }
      } catch (e) { /* 文本预填充失败不影响合同创建 */ console.error('[contracts] 预填充文本失败:', e.message); }
    }

    await addHistory(pool, c.id, 'edit', req.session.user.id, { note: `发起合同签署：${title}` });
    res.json({ ok: true, contract });
  } catch (e) { next(e); }
});

// 获取案件的合同列表
router.get('/cases/:id/contracts', async (req, res, next) => {
  try {
    const c = await getCaseForPermission(req);
    if (!c || !canViewCase(req.session.user, c)) return res.status(403).json({ error: '无权访问' });
    const { rows } = await pool.query(
      `SELECT c.*, ct.name AS template_name,
              (SELECT json_agg(json_build_object('id', cs.id, 'party_name', cs.party_name, 'party_role', cs.party_role, 'status', cs.status, 'signed_at', cs.signed_at, 'sign_token', cs.sign_token))
               FROM contract_signatures cs WHERE cs.contract_id = c.id) AS signatures
       FROM contracts c
       LEFT JOIN contract_templates ct ON ct.id = c.template_id
       WHERE c.case_id = $1 ORDER BY c.created_at DESC`, [c.id]
    );
    res.json({ ok: true, contracts: rows });
  } catch (e) { next(e); }
});

/* ---------- 下载已签署合同 ---------- */
router.get('/contracts/:id/download', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const c = (await pool.query(`SELECT * FROM contracts WHERE id = $1`, [id])).rows[0];
    if (!c) return res.status(404).json({ error: '合同不存在' });
    // 权限检查
    const caseRow = await getCaseForPermission({ params: { id: c.case_id } });
    if (!caseRow || !canViewCase(req.session.user, caseRow)) return res.status(403).json({ error: '无权下载' });
    if (!c.pdf_path) return res.status(404).json({ error: '合同尚未完成签署' });
    const fp = path.join(UPLOAD_DIR, 'contracts', 'signed', c.pdf_path);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(c.title + '.pdf')}`);
    res.setHeader('Content-Type', 'application/pdf');
    fs.createReadStream(fp).pipe(res);
  } catch (e) { next(e); }
});

// 撤回合同
router.post('/cases/:caseId/contracts/:id/revoke', requirePermission('contracts.manage'), async (req, res, next) => {
  try {
    const c = await getCaseForPermission({ params: { id: req.params.caseId } });
    if (!c || !canViewCase(req.session.user, c)) return res.status(403).json({ error: '无权操作' });
    const contractId = parseInt(req.params.id, 10);
    const contract = (await pool.query(`SELECT * FROM contracts WHERE id = $1 AND case_id = $2`, [contractId, c.id])).rows[0];
    if (!contract) return res.status(404).json({ error: '合同不存在' });
    if (contract.status === 'signed') return res.status(400).json({ error: '已完成签署的合同无法撤回' });
    await pool.query(`UPDATE contracts SET status='revoked' WHERE id = $1`, [contractId]);
    await pool.query(`UPDATE contract_signatures SET status='expired' WHERE contract_id = $1 AND status='pending'`, [contractId]);
    await addHistory(pool, c.id, 'edit', req.session.user.id, { note: `撤回合同：${contract.title}` });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 删除合同（仅超级管理员/管理员）
router.post('/cases/:caseId/contracts/:id/delete', async (req, res, next) => {
  try {
    const role = req.session.user && req.session.user.role;
    if (role !== 'super_admin' && role !== 'admin') {
      return res.status(403).json({ error: '仅超级管理员或管理员可删除合同' });
    }
    const c = await getCaseForPermission({ params: { id: req.params.caseId } });
    if (!c || !canViewCase(req.session.user, c)) return res.status(403).json({ error: '无权操作' });
    const contractId = parseInt(req.params.id, 10);
    const contract = (await pool.query(`SELECT * FROM contracts WHERE id = $1 AND case_id = $2`, [contractId, c.id])).rows[0];
    if (!contract) return res.status(404).json({ error: '合同不存在' });
    const sigs = (await pool.query(`SELECT signature_image_path FROM contract_signatures WHERE contract_id = $1`, [contractId])).rows;
    await pool.query(`DELETE FROM contracts WHERE id = $1`, [contractId]);
    const removeFile = (p) => { if (!p) return; const fp = path.join(UPLOAD_DIR, p); if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch {} } };
    removeFile(contract.pdf_path);
    removeFile(contract.work_pdf_path);
    for (const s of sigs) removeFile(s.signature_image_path);
    await addHistory(pool, c.id, 'edit', req.session.user.id, { note: `删除合同：${contract.title}` });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 删除进度记录（仅超级管理员）
router.post('/cases/:id/history/:hid/delete', async (req, res, next) => {
  try {
    if (!req.session.user || req.session.user.role !== 'super_admin') {
      return res.status(403).json({ error: '仅超级管理员可删除进度记录' });
    }
    const c = await getCaseForPermission(req);
    if (!c || !canViewCase(req.session.user, c)) return res.status(403).json({ error: '无权操作' });
    const hid = parseInt(req.params.hid, 10);
    const h = (await pool.query(`SELECT * FROM case_history WHERE id = $1 AND case_id = $2`, [hid, c.id])).rows[0];
    if (!h) return res.status(404).json({ error: '进度记录不存在' });
    await pool.query(`DELETE FROM case_history WHERE id = $1`, [hid]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
