#!/usr/bin/env node
/* 从 NocoBase 的 PostgreSQL 迁移案件 / 当事人 / 文书附件到案件管理系统。
 *
 * 运行环境：case-manager-app-1 容器内（与 db 同网络，且已 connect 到 nocobase_noco_network）。
 * 前置：附件文件已 docker cp 到容器 /tmp/noco_files/。
 * 用法：
 *   docker exec -e NODE_PATH=/app/node_modules -e NOC_PG_PW=<noco DB 密码> case-manager-app-1 node /app/scripts/migrate-nocobase.js
 *
 * 环境变量：
 *   NOC_PG_PW     必填，NocoBase 库密码
 *   NOC_PG_HOST   默认 noco-postgres
 *   NOC_FILES_DIR 默认 /tmp/noco_files（附件文件目录）
 *   CM_PG_HOST    默认 db（case-manager 目标库）
 *   CM_PG_PW      默认 casemgr
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const NOC_HOST = process.env.NOC_PG_HOST || 'noco-postgres';
const NOC_PW = process.env.NOC_PG_PW || '';
const CM_HOST = process.env.CM_PG_HOST || 'db';
const CM_PW = process.env.CM_PG_PW || 'casemgr';
const FILES_DIR = process.env.NOC_FILES_DIR || '/tmp/noco_files';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

const C_COLL = 't_8han9xni2pb';   // 案件管理
const P_COLL = 't_exa4arnpjjk';   // 当事人
const D_COLL = 't_krzqq1k6p59';   // 案件文书
const LINK_DOC = 't_454h3b8f55t'; // 文书<->附件 关联表

const SRC = new Pool({ host: NOC_HOST, port: 5432, user: 'nocobase2', password: NOC_PW, database: 'nocobase2' });
const DST = new Pool({ host: CM_HOST, port: 5432, user: 'casemgr', password: CM_PW, database: 'casemgr' });

const report = { cases: 0, parties: 0, docs: 0, attachments: 0, users: 0, skipped: [] };

function log(s) { console.log(s); }

function toDateOnly(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

function stripHtml(v) {
  return String(v == null ? '' : v)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mimeFromExt(ext) {
  const m = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.bmp': 'image/bmp', '.webp': 'image/webp', '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip', '.rar': 'application/x-rar-compressed', '.txt': 'text/plain',
  };
  return m[(ext || '').toLowerCase()] || 'application/octet-stream';
}

async function main() {
  if (!NOC_PW) throw new Error('缺少环境变量 NOC_PG_PW（NocoBase 库密码）');

  /* ---------- 1. 字段元数据：标题 + select 选项解码 ---------- */
  const { rows: fieldRows } = await SRC.query(
    `SELECT "collectionName" coll, name, interface, options FROM fields WHERE "collectionName" IN ($1,$2,$3)`,
    [C_COLL, P_COLL, D_COLL]
  );
  const meta = {};
  for (const r of fieldRows) {
    meta[r.coll] = meta[r.coll] || {};
    let sel = null;
    try {
      const ui = r.options && r.options.uiSchema;
      const opts = (ui && ui['x-component-props'] && ui['x-component-props'].options) || [];
      const map = {};
      for (const o of opts) if (o && o.value != null) map[String(o.value)] = o.label || String(o.value);
      if (Object.keys(map).length) sel = map;
    } catch (e) { /* 忽略 */ }
    meta[r.coll][r.name] = {
      title: (r.options && r.options.uiSchema && r.options.uiSchema.title) || r.name,
      sel,
    };
  }
  const colTitle = (coll, col) => (meta[coll] && meta[coll][col] && meta[coll][col].title) || col;
  const decodeVal = (coll, col, v) => {
    if (v == null || v === '') return '';
    const m = meta[coll] && meta[coll][col] && meta[coll][col].sel;
    return (m && m[String(v)]) || String(v);
  };

  /* ---------- 2. 目标库参照 ---------- */
  const [statusRes, typeRes, usersRes, existingCases] = await Promise.all([
    DST.query('SELECT id, name FROM statuses ORDER BY id'),
    DST.query('SELECT id, code, name FROM case_types ORDER BY id'),
    DST.query('SELECT id, username, display_name FROM users'),
    DST.query('SELECT case_no FROM cases'),
  ]);
  const statusIdByName = {};
  for (const s of statusRes.rows) statusIdByName[s.name] = s.id;
  if (!statusIdByName['待受理'] || !statusIdByName['已结案']) throw new Error('目标库缺少状态：待受理/已结案');
  const typeByName = {};
  for (const t of typeRes.rows) typeByName[t.name] = { id: t.id, code: t.code };
  const userBy = {};
  for (const u of usersRes.rows) userBy[u.username] = u.id;
  const adminId = userBy['admin'];
  if (!adminId) throw new Error('目标库缺少 admin 用户');
  const usedNo = new Set(existingCases.rows.map((r) => r.case_no));
  const STATUS_MAP = {
    '意向': '待受理', '签约': '待受理', '保险调解': '调解中',
    '起诉立案': '诉讼中', '质证': '诉讼中', '鉴定': '诉讼中', '开庭': '诉讼中', '判决': '诉讼中',
    '结案': '已结案', '交强险已赔付待个人': '理赔中', '交强险已赔付待商险': '理赔中',
  };

  /* ---------- 3. 人员账号（签单人员 / 服务人员） ---------- */
  const staffRes = await SRC.query(`SELECT DISTINCT f_skkwo8wquy6 AS signer, f_yf83dm9dxo7 AS server FROM ${C_COLL}`);
  const staffNames = new Set();
  for (const r of staffRes.rows) {
    if (r.signer) staffNames.add(String(r.signer).trim());
    if (r.server) staffNames.add(String(r.server).trim());
  }
  for (const name of staffNames) {
    if (userBy[name]) continue;
    let uname = name;
    let n = 2;
    while (userBy[uname]) { uname = name + n; n++; }
    const pw = crypto.randomBytes(6).toString('hex');
    const hash = await bcrypt.hash(pw, 10);
    const ins = await DST.query(
      `INSERT INTO users (username, password_hash, display_name, role, must_change_password) VALUES ($1,$2,$3,'staff',TRUE) RETURNING id`,
      [uname, hash, name]
    );
    userBy[uname] = ins.rows[0].id;
    userBy[name] = ins.rows[0].id;
    report.users++;
    log(`建用户 ${name} (username=${uname}, 随机初始密码 ${pw})`);
  }

  /* ---------- 4. 案件类型补齐 ---------- */
  async function getTypeId(name) {
    if (!name) return 1;
    if (typeByName[name]) return typeByName[name].id;
    let code = 'NOC' + Math.floor(Math.random() * 90000 + 10000);
    const ins = await DST.query(
      `INSERT INTO case_types (code, name, color, sort) VALUES ($1,$2,'#6c757d',99) RETURNING id`,
      [code, name]
    );
    typeByName[name] = { id: ins.rows[0].id, code };
    log(`新建案件类型: ${name} (${code})`);
    return ins.rows[0].id;
  }

  /* ---------- 5. 案件 ---------- */
  const directCols = new Set([
    'id', 'createdAt', 'updatedAt',
    'f_foobx176vfr', 'f_1py1az6q6ee', 'f_h7ufgrn8pan', 'f_8oxf9st2t2r',
    'f_skkwo8wquy6', 'f_yf83dm9dxo7', 'f_trxiah8r352', 'f_0af2hto8xp1',
    'f_4ww9btboizy', 'f_bcsu88lz7bc', 'f_0x6u1zs2agz', 'f_eymhvtqjk2m',
    'f_mkpv52j0zas', 'f_rft40j95vwo', 'f_zeivvjxb09s', 'f_xrkr6jy7zdu',
  ]);
  const { rows: cases } = await SRC.query(`SELECT * FROM ${C_COLL} ORDER BY id`);
  const newCaseIdByNoco = {};
  for (const c of cases) {
    try {
      const rawNo = String(c.f_foobx176vfr || '').trim();
      if (usedNo.has(rawNo)) { report.skipped.push(`案件 ${c.id}: 案号 ${rawNo} 已存在，跳过（防重复迁移）`); continue; }
      let caseNo = rawNo || ('NOC' + String(c.id).slice(-8));
      usedNo.add(caseNo);

      const typeName = decodeVal(C_COLL, 'f_h7ufgrn8pan', c.f_h7ufgrn8pan) || '交通事故';
      const typeId = await getTypeId(typeName);

      const closed = c.f_0x6u1zs2agz === true || c.f_0x6u1zs2agz === 'true' || c.f_0x6u1zs2agz === 1 || !!c.f_eymhvtqjk2m;
      let statusId;
      if (closed) {
        statusId = statusIdByName['已结案'];
      } else {
        const st = decodeVal(C_COLL, 'f_8oxf9st2t2r', c.f_8oxf9st2t2r);
        const mapped = STATUS_MAP[st];
        statusId = (mapped && statusIdByName[mapped]) || statusIdByName['待受理'];
      }

      const signer = String(c.f_skkwo8wquy6 || '').trim();
      const server = String(c.f_yf83dm9dxo7 || '').trim();
      const title = String(c.f_1py1az6q6ee || '').trim() || caseNo;

      const parts = [];
      for (const key of Object.keys(c)) {
        if (directCols.has(key)) continue;
        const v = c[key];
        if (v == null || v === '') continue;
        let val;
        if (meta[C_COLL][key] && meta[C_COLL][key].sel) val = decodeVal(C_COLL, key, v);
        else val = stripHtml(v);
        if (val === '') continue;
        parts.push('【' + colTitle(C_COLL, key) + '】' + val);
      }
      const remark = parts.join('\n') || null;

      const ins = await DST.query(
        `INSERT INTO cases (case_no, case_type_id, title, client_name, assignee_id, status_id, status_at, created_by,
                            reminder_at, fee_agreement, fee_details, sign_staff_id, sign_date, remark, created_at, updated_at)
         VALUES ($1,$2,$3,NULL,$4,$5,now(),$6,$7,$8,$9,$10,$11,$12,COALESCE($13,now()),COALESCE($14,now())) RETURNING id`,
        [caseNo, typeId, title,
         userBy[server] || null, statusId, adminId,
         c.f_bcsu88lz7bc ? new Date(c.f_bcsu88lz7bc) : null,
         c.f_0af2hto8xp1 != null && String(c.f_0af2hto8xp1) !== '' ? stripHtml(c.f_0af2hto8xp1) : null,
         c.f_4ww9btboizy != null && String(c.f_4ww9btboizy) !== '' ? stripHtml(c.f_4ww9btboizy) : null,
         userBy[signer] || null, toDateOnly(c.f_trxiah8r352), remark,
         c.createdAt || null, c.updatedAt || null]
      );
      newCaseIdByNoco[String(c.id)] = ins.rows[0].id;
      report.cases++;
      log(`案件 ${c.id} -> ${ins.rows[0].id} ${caseNo} ${title}（状态${statusId}，签单${signer || '-'}，服务${server || '-'}）`);
    } catch (e) {
      report.skipped.push(`案件 ${c.id}: ${e.message}`);
    }
  }

  /* ---------- 6. 当事人 ---------- */
  const clientByCase = {};
  const { rows: parties } = await SRC.query(`SELECT * FROM ${P_COLL} ORDER BY id`);
  for (const p of parties) {
    try {
      const nocoCaseId = p.f_kh5nfxwncnq == null ? null : String(p.f_kh5nfxwncnq);
      if (!nocoCaseId || !newCaseIdByNoco[nocoCaseId]) {
        report.skipped.push(`当事人 ${p.f_r4v7tbuzs0j}: 未关联已迁入案件，跳过`);
        continue;
      }
      const cid = newCaseIdByNoco[nocoCaseId];
      const role = decodeVal(P_COLL, 'f_r7746acqxj3', p.f_r7746acqxj3) || '伤者';
      const genderLabel = decodeVal(P_COLL, 'f_kgmjiyr8uld', p.f_kgmjiyr8uld);
      const gender = genderLabel === '男' ? 'male' : genderLabel === '女' ? 'female' : null;
      const dob = toDateOnly(p.f_k6ug4fyeu8h);
      let age = null;
      if (dob) {
        const a = new Date().getFullYear() - parseInt(dob.slice(0, 4), 10);
        if (!isNaN(a) && a >= 0 && a < 150) age = a;
      }
      const name = String(p.f_r4v7tbuzs0j || '').trim() || '未命名';
      await DST.query(
        `INSERT INTO case_parties (case_id, name, role, gender, age, id_card, phone, address, injury_info, hospital_dept, remark, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [cid, name, role, gender, age,
         (p.f_0r3449booep || '').toString().trim() || null,
         (p.f_tug2havlm5t || '').toString().trim() || null,
         (p.f_2plluc7ya9k || '').toString().trim() || null,
         (p.f_g2y4dcif4bt || '').toString().trim() || null,
         (p.f_rkz7jzv6jsu || '').toString().trim() || null,
         (p.f_eus11sikunr || '').toString().trim() || null,
         p.sort || 0]
      );
      report.parties++;
      if (!clientByCase[cid]) clientByCase[cid] = { name, role };
      else if (role === '伤者' && clientByCase[cid].role !== '伤者') clientByCase[cid] = { name, role };
    } catch (e) {
      report.skipped.push(`当事人 ${p.f_r4v7tbuzs0j || p.id}: ${e.message}`);
    }
  }
  for (const [cid, c] of Object.entries(clientByCase)) {
    await DST.query(`UPDATE cases SET client_name = $2 WHERE id = $1`, [parseInt(cid, 10), c.name]);
  }

  /* ---------- 7. 文书与附件 ---------- */
  const { rows: docs } = await SRC.query(`SELECT * FROM ${D_COLL} ORDER BY id`);
  const { rows: links } = await SRC.query(`SELECT f_vfzciwrujmd AS doc_id, f_x24swcfobta AS att_id FROM ${LINK_DOC}`);
  const linkByDoc = {};
  const allAttIds = new Set();
  for (const l of links) {
    const docId = String(l.doc_id);
    const attId = String(l.att_id);
    (linkByDoc[docId] = linkByDoc[docId] || []).push(attId);
    allAttIds.add(attId);
  }
  const attMap = {};
  if (allAttIds.size) {
    const { rows } = await SRC.query(
      `SELECT id, filename, extname, size, mimetype, title FROM attachments WHERE id = ANY($1::bigint[])`,
      [[...allAttIds]]
    );
    for (const a of rows) attMap[String(a.id)] = a;
  }
  const copied = {};
  const ts = Date.now();
  let n = 0;
  for (const d of docs) {
    try {
      const nocoCaseId = d.f_9jy27grqr8y == null ? null : String(d.f_9jy27grqr8y);
      const cid = nocoCaseId && newCaseIdByNoco[nocoCaseId];
      if (!cid) { report.skipped.push(`文书 ${d.id}: 未关联已迁入案件`); continue; }
      const attIds = linkByDoc[String(d.id)] || [];
      if (!attIds.length) continue;
      const typeLabel = decodeVal(D_COLL, 'f_tehx4tvs7cs', d.f_tehx4tvs7cs);
      const docRemark = (d.f_5k7mr9baksu || '').toString().trim();
      const remark = typeLabel + (docRemark ? '；' + docRemark : '');
      for (const attId of attIds) {
        const att = attMap[attId];
        if (!att) { report.skipped.push(`文书 ${d.id}: 附件元数据缺失 #${attId}`); continue; }
        let storedName = copied[attId];
        if (!storedName) {
          const srcPath = path.join(FILES_DIR, att.filename);
          if (!fs.existsSync(srcPath)) { report.skipped.push(`文书 ${d.id}: 附件文件缺失 ${att.filename}`); continue; }
          n++;
          storedName = `mig_${cid}_${ts}_${n}${att.extname || ''}`;
          fs.copyFileSync(srcPath, path.join(UPLOAD_DIR, storedName));
          copied[attId] = storedName;
          report.attachments++;
        }
        let orig = String(att.filename || '');
        orig = orig.replace(/-[a-z0-9]{6}(\.[^.]+)$/i, '$1') || att.title || att.filename;
        const mime = att.mimetype || mimeFromExt(att.extname);
        await DST.query(
          `INSERT INTO attachments (case_id, original_name, stored_name, mime_type, size, uploaded_by, remark)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [cid, orig, storedName, mime, att.size || 0, adminId, remark || null]
        );
        report.docs++;
      }
    } catch (e) {
      report.skipped.push(`文书 ${d.id}: ${e.message}`);
    }
  }

  /* ---------- 8. 报告 ---------- */
  console.log('\n================ 迁移报告 ================');
  console.log(`案件: ${report.cases}`);
  console.log(`当事人: ${report.parties}`);
  console.log(`文书-附件记录: ${report.docs}`);
  console.log(`附件文件: ${report.attachments}`);
  console.log(`新建用户: ${report.users}`);
  console.log(`跳过/失败: ${report.skipped.length}`);
  if (report.skipped.length) {
    console.log('\n-- 明细 --');
    for (const s of report.skipped) console.log('  - ' + s);
  }
  console.log('=========================================');
  await SRC.end();
  await DST.end();
}

main().catch((e) => {
  console.error('迁移失败:', e);
  process.exit(1);
});
