const express = require('express');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { pool } = require('../src/db');
const { embedCjkFont } = require('../src/pdf-utils');

const router = express.Router();
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

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
// 通过 token 访问签署页
router.get('/sign/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    const sig = (await pool.query(
      `SELECT cs.*, c.title, c.pdf_path, c.work_pdf_path, ct.pdf_path AS template_path, ct.sign_positions
       FROM contract_signatures cs
       JOIN contracts c ON c.id = cs.contract_id
       JOIN contract_templates ct ON ct.id = c.template_id
       WHERE cs.sign_token = $1`, [token]
    )).rows[0];
    if (!sig) return res.status(404).send('签署链接无效或已过期');
    if (sig.status === 'signed') return res.send('<h2 style="text-align:center;margin-top:50px;font-family:sans-serif;color:#198754">已签署完成，无需重复签署</h2>');
    if (sig.status === 'expired') return res.send('<h2 style="text-align:center;margin-top:50px;font-family:sans-serif;color:#dc3545">签署链接已过期</h2>');
    // M5: 令牌过期检查
    if (sig.expires_at && new Date(sig.expires_at) < new Date()) {
      await pool.query(`UPDATE contract_signatures SET status='expired' WHERE id=$1 AND status='pending'`, [sig.id]);
      return res.send('<h2 style="text-align:center;margin-top:50px;font-family:sans-serif;color:#dc3545">签署链接已过期</h2>');
    }

    const positions = parseJsonArray(sig.sign_positions);
    const myPos = positions.find(p => p.party_role === sig.party_role) || positions[0] || {};

    res.render('contracts/sign', {
      token,
      contractTitle: sig.title,
      partyName: sig.party_name,
      partyRole: sig.party_role,
      signPosition: myPos,
      templatePath: sig.template_path,
      layout: false
    });
  } catch (e) { next(e); }
});

// 提交签名（Canvas 签名图片 base64）
router.post('/sign/:token', signSubmitLimiter, async (req, res, next) => {
  try {
    const { token } = req.params;
    const { signature_base64 } = req.body; // data:image/png;base64,...
    if (!signature_base64) return res.status(400).json({ error: '签名数据为空' });
    if (typeof signature_base64 !== 'string' || signature_base64.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: '签名数据过大' });
    }

    const sig = (await pool.query(
      `SELECT cs.*, c.id AS contract_id, c.template_id, c.pdf_path, c.work_pdf_path, ct.pdf_path AS template_path, ct.sign_positions
       FROM contract_signatures cs
       JOIN contracts c ON c.id = cs.contract_id
       JOIN contract_templates ct ON ct.id = c.template_id
       WHERE cs.sign_token = $1`, [token]
    )).rows[0];
    if (!sig) return res.status(404).json({ error: '签署链接无效' });
    if (sig.status === 'signed') return res.status(400).json({ error: '已签署' });
    if (sig.status === 'expired') return res.status(400).json({ error: '链接已过期' });
    // M5: 令牌过期检查
    if (sig.expires_at && new Date(sig.expires_at) < new Date()) {
      await pool.query(`UPDATE contract_signatures SET status='expired' WHERE id=$1`, [sig.id]);
      return res.status(400).json({ error: '链接已过期' });
    }
    // L3: 验证签名数据格式
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature_base64)) {
      return res.status(400).json({ error: '签名数据格式无效' });
    }

    // 保存签名图片
    const base64Data = signature_base64.replace(/^data:image\/png;base64,/, '');
    const signBuf = Buffer.from(base64Data, 'base64');
    // S5: 解码后体积上限（防止 PDF/内存膨胀）
    if (signBuf.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: '签名数据过大' });
    }
    const signDir = path.join(UPLOAD_DIR, 'signatures');
    if (!fs.existsSync(signDir)) fs.mkdirSync(signDir, { recursive: true });
    const signFile = `sign_${sig.id}_${Date.now()}.png`;
    const signPath = path.join(signDir, signFile);
    fs.writeFileSync(signPath, signBuf);

    // 用 pdf-lib 在合同工作稿（或模板）PDF 上绘制签名，生成最终 PDF
    const { PDFDocument, rgb } = require('pdf-lib');
    const basePath = path.join(UPLOAD_DIR, sig.work_pdf_path || sig.template_path);
    if (!fs.existsSync(basePath)) return res.status(500).json({ error: '模板 PDF 不存在' });

    const templateBytes = fs.readFileSync(basePath);
    const pdfDoc = await PDFDocument.load(templateBytes);
    const pages = pdfDoc.getPages();
    const positions = parseJsonArray(sig.sign_positions);
    const myPos = positions.find(p => p.party_role === sig.party_role) || positions[0] || {};

    // 尝试加载中文字体用于绘制签名下方文字
    const cjkFont = await embedCjkFont(pdfDoc);

    if (myPos.page && myPos.page <= pages.length) {
      const page = pages[myPos.page - 1];
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

    const pdfBytes = await pdfDoc.save();
    const signedDir = path.join(UPLOAD_DIR, 'contracts', 'signed');
    if (!fs.existsSync(signedDir)) fs.mkdirSync(signedDir, { recursive: true });
    const signedFile = `signed_${sig.contract_id}_${Date.now()}.pdf`;
    const signedPath = path.join(signedDir, signedFile);
    fs.writeFileSync(signedPath, pdfBytes);

    // 更新签名记录
    await pool.query(
      `UPDATE contract_signatures SET signature_image_path=$1, signed_at=now(), status='signed', ip_address=$2, user_agent=$3 WHERE id=$4`,
      [signFile, req.ip, req.headers['user-agent'], sig.id]
    );

    // 检查是否全部签署完成
    const allSigs = (await pool.query(`SELECT id, status FROM contract_signatures WHERE contract_id=$1`, [sig.contract_id])).rows;
    const allSigned = allSigs.every(s => s.status === 'signed');
    if (allSigned) {
      await pool.query(`UPDATE contracts SET pdf_path=$1, status='signed', completed_at=now() WHERE id=$2`, [signedFile, sig.contract_id]);
    }

    res.json({ ok: true, signed: true, all_signed: allSigned, redirect: `/sign/${token}/done` });
  } catch (e) { next(e); }
});

// 模板 PDF 预览（公开，token 校验）
router.get('/sign/:token/pdf', signReadLimiter, async (req, res, next) => {
  try {
    const { token } = req.params;
    const sig = (await pool.query(
      `SELECT cs.id, cs.status, c.work_pdf_path, ct.pdf_path AS template_path
       FROM contract_signatures cs
       JOIN contracts c ON c.id = cs.contract_id
       JOIN contract_templates ct ON ct.id = c.template_id
       WHERE cs.sign_token = $1`, [token]
    )).rows[0];
    if (!sig || sig.status === 'expired') return res.status(404).send('链接无效');
    const fp = path.join(UPLOAD_DIR, sig.work_pdf_path || sig.template_path);
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
    const fp = path.join(UPLOAD_DIR, 'contracts', 'signed', sig.pdf_path);
    if (!fs.existsSync(fp)) return res.status(404).send('文件不存在');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(sig.title + '.pdf')}`);
    res.setHeader('Content-Type', 'application/pdf');
    fs.createReadStream(fp).pipe(res);
  } catch (e) { next(e); }
});

// 签署完成页
router.get('/sign/:token/done', async (req, res, next) => {
  try {
    const { token } = req.params;
    const sig = (await pool.query(
      `SELECT cs.*, c.pdf_path, c.status AS contract_status FROM contract_signatures cs JOIN contracts c ON c.id = cs.contract_id WHERE cs.sign_token = $1`, [token]
    )).rows[0];
    if (!sig) return res.status(404).send('链接无效');
    res.render('contracts/sign_done', { partyName: sig.party_name, contractTitle: sig.title, token, contractId: sig.contract_id, layout: false });
  } catch (e) { next(e); }
});

module.exports = router;
