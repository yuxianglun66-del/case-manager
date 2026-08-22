const express = require('express');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { pool } = require('../src/db');
const { embedCjkFont } = require('../src/pdf-utils');
const { caseFolder } = require('../src/util');

const router = express.Router();
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

// 已签署 PDF 路径解析：兼容旧（contracts/signed/ 前缀）与新（案件文件夹相对路径）存储
function resolveSignedPdf(p) {
  if (!p) return null;
  const newPath = path.join(UPLOAD_DIR, p);
  if (fs.existsSync(newPath)) return newPath;
  const oldPath = path.join(UPLOAD_DIR, 'contracts', 'signed', p);
  return fs.existsSync(oldPath) ? oldPath : null;
}

// S5: 公开签署接口限流（提交签名 30 次/15分钟/IP；预览/下载轻量限制）
const signSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '操作过于频繁，请稍后再试' },
});
const signReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '操作过于频繁，请稍后再试' },
});

function parseJsonArray(v, fallback = []) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Array.isArray(v.value) ? v.value : fallback;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : fallback; } catch (e) { return fallback; }
  }
  return fallback;
}

/* ---------- 签署页面（公开，无需登录） ---------- */
// 通过 token 访问签署页（单链接可含多个签署记录：当事人与代理人依次签名）
router.get('/sign/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    const rows = (await pool.query(
      `SELECT cs.*, c.title, c.pdf_path, c.work_pdf_path, ct.pdf_path AS template_path, ct.sign_positions
       FROM contract_signatures cs
       JOIN contracts c ON c.id = cs.contract_id
       JOIN contract_templates ct ON ct.id = c.template_id
       WHERE cs.sign_token = $1 ORDER BY cs.id ASC`, [token]
    )).rows;
    if (!rows.length) return res.status(404).send('签署链接无效或已过期');
    const first = rows[0];
    const pending = rows.filter(s => s.status === 'pending');
    if (rows.every(s => s.status === 'expired')) {
      return res.send('<h2 style="text-align:center;margin-top:50px;font-family:sans-serif;color:#dc3545">签署链接已过期</h2>');
    }
    if (!pending.length) return res.send('<h2 style="text-align:center;margin-top:50px;font-family:sans-serif;color:#198754">已签署完成，无需重复签署</h2>');
    // M5: 令牌过期检查
    if (first.expires_at && new Date(first.expires_at) < new Date()) {
      await pool.query(`UPDATE contract_signatures SET status='expired' WHERE sign_token=$1 AND status='pending'`, [token]);
      return res.send('<h2 style="text-align:center;margin-top:50px;font-family:sans-serif;color:#dc3545">签署链接已过期</h2>');
    }

    const positions = parseJsonArray(first.sign_positions);
    // 签署记录按位置顺序创建：优先用创建序号对应位置，其次按角色匹配
    const allIds = (await pool.query(`SELECT id FROM contract_signatures WHERE contract_id=$1 ORDER BY id ASC`, [first.contract_id])).rows.map(r => r.id);
    const signers = rows.map(s => {
      const idx = allIds.indexOf(s.id);
      const pos = (idx >= 0 && positions[idx])
        ? positions[idx]
        : (positions.find(p => p.party_role && p.party_role === s.party_role) || positions[0] || {});
      return { id: s.id, party_name: s.party_name, party_role: s.party_role, status: s.status, position: pos };
    });
    const toSign = signers.filter(s => s.status === 'pending');

    res.render('contracts/sign', {
      token,
      contractTitle: first.title,
      signers,
      toSign,
      templatePath: first.template_path,
      layout: false
    });
  } catch (e) { next(e); }
});

// 提交签名（Canvas 签名图片 base64；单链接一次提交全部签署记录）
router.post('/sign/:token', signSubmitLimiter, async (req, res, next) => {
  try {
    const { token } = req.params;
    // 新模型：signatures = [{ sig_id, signature_base64 }]；兼容旧单签：signature_base64
    let inputs = Array.isArray(req.body.signatures) ? req.body.signatures : null;
    if ((!inputs || !inputs.length) && req.body.signature_base64) {
      inputs = [{ signature_base64: req.body.signature_base64 }];
    }
    if (!inputs || !inputs.length) return res.status(400).json({ error: '签名数据为空' });
    if (inputs.length > 20) return res.status(400).json({ error: '签名数据过多' });
    for (const it of inputs) {
      if (typeof it.signature_base64 !== 'string' || it.signature_base64.length > 2 * 1024 * 1024) {
        return res.status(400).json({ error: '签名数据过大' });
      }
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(it.signature_base64)) {
        return res.status(400).json({ error: '签名数据格式无效' });
      }
    }

    const sigs = (await pool.query(
      `SELECT cs.*, c.id AS contract_id, c.case_no, c.template_id, c.pdf_path AS contract_pdf, c.work_pdf_path, ct.pdf_path AS template_path, ct.sign_positions
       FROM contract_signatures cs
       JOIN contracts c ON c.id = cs.contract_id
       JOIN contract_templates ct ON ct.id = c.template_id
       WHERE cs.sign_token = $1 ORDER BY cs.id ASC`, [token]
    )).rows;
    if (!sigs.length) return res.status(404).json({ error: '签署链接无效' });
    const first = sigs[0];
    const pending = sigs.filter(s => s.status === 'pending');
    if (!pending.length) return res.status(400).json({ error: '已签署' });
    // M5: 令牌过期检查
    if (first.expires_at && new Date(first.expires_at) < new Date()) {
      await pool.query(`UPDATE contract_signatures SET status='expired' WHERE sign_token=$1 AND status='pending'`, [token]);
      return res.status(400).json({ error: '链接已过期' });
    }

    // 解析待签署记录（按 sig_id 精确匹配，未提供则按创建顺序取未用记录）
    const targets = [];
    for (const it of inputs) {
      let rec;
      if (it.sig_id) rec = pending.find(s => s.id === Number(it.sig_id) && !s._used);
      else rec = pending.find(s => !s._used);
      if (!rec) return res.status(400).json({ error: '签署记录无效' });
      rec._used = true;
      targets.push({ rec, b64: it.signature_base64 });
    }

    // 用 pdf-lib 在合同当前合成稿（已叠加历史签名）上绘制全部签名，生成最新 PDF
    const positions = parseJsonArray(first.sign_positions);
    const allIds = (await pool.query(`SELECT id FROM contract_signatures WHERE contract_id=$1 ORDER BY id ASC`, [first.contract_id])).rows.map(r => r.id);

    const { PDFDocument, rgb } = require('pdf-lib');
    let basePath;
    if (first.contract_pdf && resolveSignedPdf(first.contract_pdf)) {
      // 已有历史签名，叠加到最新合成稿上
      basePath = resolveSignedPdf(first.contract_pdf);
    } else {
      // 首次签署：以工作稿（含预填文本）或模板为底
      basePath = path.join(UPLOAD_DIR, first.work_pdf_path || first.template_path);
    }
    if (!fs.existsSync(basePath)) return res.status(500).json({ error: '模板 PDF 不存在' });

    const pdfDoc = await PDFDocument.load(fs.readFileSync(basePath));
    const pages = pdfDoc.getPages();
    const cjkFont = await embedCjkFont(pdfDoc);

    // 保存签名图片并叠加到 PDF
    const signDir = path.join(UPLOAD_DIR, 'signatures');
    if (!fs.existsSync(signDir)) fs.mkdirSync(signDir, { recursive: true });
    const nowTs = Date.now();
    const savedFiles = [];
    for (let n = 0; n < targets.length; n++) {
      const t = targets[n];
      const idx = allIds.indexOf(t.rec.id);
      const myPos = (idx >= 0 && positions[idx])
        ? positions[idx]
        : (positions.find(p => p.party_role && p.party_role === t.rec.party_role) || positions[0] || {});
      if (!(myPos.page && myPos.page <= pages.length)) continue;
      const page = pages[myPos.page - 1];
      const signBuf = Buffer.from(t.b64.replace(/^data:image\/png;base64,/, ''), 'base64');
      // S5: 解码后体积上限（防止 PDF/内存膨胀）
      if (signBuf.length > 2 * 1024 * 1024) return res.status(400).json({ error: '签名数据过大' });
      const signFile = `sign_${t.rec.id}_${nowTs}_${n}.png`;
      fs.writeFileSync(path.join(signDir, signFile), signBuf);
      savedFiles.push({ id: t.rec.id, file: signFile });
      const signImage = await pdfDoc.embedPng(signBuf);
      const drawWidth = myPos.width || 180;
      const drawHeight = myPos.height || 60;
      const x = myPos.x || 100;
      const y = myPos.y || (page.getHeight() - 100); // pdf-lib 坐标原点左下角
      page.drawImage(signImage, { x, y: page.getHeight() - y - drawHeight, width: drawWidth, height: drawHeight });
      // 在签名下方画签署日期（需要中文字体）
      if (cjkFont) {
        page.drawText(`${new Date().toLocaleDateString('zh-CN')}`, { x: x + 5, y: page.getHeight() - y - drawHeight - 18, size: 9, font: cjkFont, color: rgb(0, 0, 0) });
      }
    }
    if (!savedFiles.length) return res.status(400).json({ error: '签名位置无效' });

    const pdfBytes = await pdfDoc.save();
    const folder = caseFolder({ case_no: first.case_no });
    const signedDir = path.join(UPLOAD_DIR, folder);
    if (!fs.existsSync(signedDir)) fs.mkdirSync(signedDir, { recursive: true });
    const signedFile = `signed_${first.contract_id}_${nowTs}.pdf`;
    fs.writeFileSync(path.join(signedDir, signedFile), pdfBytes);

    // 更新全部签署记录与合同状态
    for (const f of savedFiles) {
      await pool.query(
        `UPDATE contract_signatures SET signature_image_path=$1, signed_at=now(), status='signed', ip_address=$2, user_agent=$3 WHERE id=$4`,
        [f.file, req.ip, req.headers['user-agent'], f.id]
      );
    }
    await pool.query(`UPDATE contracts SET pdf_path=$1, status='signed', completed_at=now() WHERE id=$2`, [`${folder}/${signedFile}`, first.contract_id]);

    try {
      const { audit } = require('../src/audit');
      await audit({ session: { user: null }, ip: req.ip }, '签署合同', { entity_type: 'contract', entity_id: first.contract_id, detail: (targets.map(t => t.rec.party_name).filter(Boolean).join('、') || '当事人') + ' 完成签署' });
    } catch {}

    res.json({
      ok: true, signed: true, all_signed: true,
      signed_party_names: targets.map(t => t.rec.party_name),
      redirect: `/sign/${token}/done`
    });
  } catch (e) { console.error('[sign] submit error:', e); res.status(500).json({ error: '签署处理失败，请稍后重试' }); }
});

// 模板 PDF 预览（公开，token 校验）
router.get('/sign/:token/pdf', signReadLimiter, async (req, res, next) => {
  try {
    const { token } = req.params;
    const sig = (await pool.query(
      `SELECT cs.id, cs.status, c.pdf_path, c.work_pdf_path, ct.pdf_path AS template_path
       FROM contract_signatures cs
       JOIN contracts c ON c.id = cs.contract_id
       JOIN contract_templates ct ON ct.id = c.template_id
       WHERE cs.sign_token = $1`, [token]
    )).rows[0];
    if (!sig || sig.status === 'expired') return res.status(404).send('链接无效');
    let fp;
    if (sig.pdf_path && resolveSignedPdf(sig.pdf_path)) {
      fp = resolveSignedPdf(sig.pdf_path);
    } else {
      fp = path.join(UPLOAD_DIR, sig.work_pdf_path || sig.template_path);
    }
    if (!fs.existsSync(fp)) return res.status(404).send('模板文件不存在');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(fp).pipe(res);
  } catch (e) { next(e); }
});

// 下载已签署合同（公开，token 校验）
router.get('/sign/:token/download', signReadLimiter, async (req, res, next) => {
  try {
    const { token } = req.params;
    const sig = (await pool.query(
      `SELECT cs.*, c.title, c.pdf_path, c.status AS contract_status
       FROM contract_signatures cs JOIN contracts c ON c.id = cs.contract_id
       WHERE cs.sign_token = $1`, [token]
    )).rows[0];
    if (!sig) return res.status(404).send('链接无效');
    if (!sig.pdf_path || sig.contract_status !== 'signed') return res.status(404).send('合同尚未完成签署');
    const fp = resolveSignedPdf(sig.pdf_path);
    if (!fp) return res.status(404).send('文件不存在');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(sig.title + '.pdf')}`);
    res.setHeader('Content-Type', 'application/pdf');
    fs.createReadStream(fp).pipe(res);
  } catch (e) { next(e); }
});

// 签署完成页
router.get('/sign/:token/done', async (req, res, next) => {
  try {
    const { token } = req.params;
    const rows = (await pool.query(
      `SELECT cs.*, c.title, c.pdf_path, c.status AS contract_status FROM contract_signatures cs JOIN contracts c ON c.id = cs.contract_id WHERE cs.sign_token = $1 ORDER BY cs.id ASC`, [token]
    )).rows;
    if (!rows.length) return res.status(404).send('链接无效');
    const first = rows[0];
    const partyNames = rows.map(r => r.party_name).filter(Boolean);
    res.render('contracts/sign_done', { partyName: partyNames.join('、'), contractTitle: first.title, token, contractId: first.contract_id, layout: false });
  } catch (e) { next(e); }
});

module.exports = router;
