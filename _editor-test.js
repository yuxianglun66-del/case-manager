// 可视化编辑器 + 文本预填充 端到端验证
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3102';
let cookie = '';
let csrfToken = '';
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

async function req(method, path2, body, isForm = false) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  const init = { method, headers, redirect: 'manual' };
  if (body) {
    if (isForm) {
      init.body = new URLSearchParams(body);
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
      init.body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
  }
  if (csrfToken && method !== 'GET') {
    if (isForm) init.body.append('_csrf', csrfToken);
    else headers['x-csrf-token'] = csrfToken;
  }
  const res = await fetch(BASE + path2, init);
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (loc) return req('GET', loc);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  const m = text.match(/name="csrf-token"\s+content="([^"]+)"/);
  if (m) csrfToken = m[1];
  return { status: res.status, text, json, headers: res.headers };
}

(async () => {
  // 0) 重置 admin 密码，绕过首次修改
  const pool = new Pool({ connectionString: 'postgres://casemgr:changeme123@127.0.0.1:55434/casemgr' });
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('admin123', 10);
  await pool.query(`UPDATE users SET password_hash=$1, must_change_password=FALSE WHERE username='admin'`, [hash]);
  console.log('[setup] admin 密码已重置');

  // 1) 登录
  let r = await req('GET', '/login');
  r = await req('POST', '/login', { username: 'admin', password: 'admin123' }, true);
  console.log('login:', r.status);
  ok(r.status === 200 && (r.text.includes('dashboard') || r.text.includes('系统')), '登录成功进入后台');

  // 2) 设置页含可视化编辑入口
  r = await req('GET', '/settings');
  ok(r.status === 200 && r.text.includes('/settings/templates/1/edit'), '设置页含「编辑位置」按钮');

  // 3) 编辑器页面渲染
  r = await req('GET', '/settings/templates/1/edit');
  ok(r.status === 200 && r.text.includes('模板编辑器') && r.text.includes('pdfjs') && r.text.includes('btnSave'), '编辑器页面渲染 200');
  console.log('  editor body size:', r.text.length);

  // 4) 模板 PDF 加载接口
  r = await req('GET', '/api/contract-templates/1/pdf');
  ok(r.status === 200 && (r.headers.get('content-type') || '').includes('pdf'), '模板 PDF 接口 200');

  // 5) 保存位置 + 文本
  const sign_positions = [{ page: 1, x: 80, y: 640, width: 200, height: 60, party_role: '原告', label: '受害人签名' }, { page: 1, x: 360, y: 640, width: 200, height: 60, party_role: '被告', label: '肇事方签名' }];
  const text_fields = [{ page: 1, x: 80, y: 720, width: 360, height: 40, text: '案件编号：{case_no}  日期：{date}', size: 12 }];
  r = await req('POST', '/api/contract-templates/1/positions', { sign_positions, text_fields });
  ok(r.status === 200 && r.json && r.json.ok, '保存位置配置 ok');

  // 6) 校验已保存
  r = await req('GET', '/api/contract-templates');
  const tpl = r.json.templates.find(t => t.id === 1);
  ok(tpl && JSON.stringify(tpl.sign_positions).includes('party_role'), '模板已保存 sign_positions');
  ok(tpl && JSON.stringify(tpl.text_fields).includes('案件编号'), '模板已保存 text_fields');

  // 7) 创建合同 → 应生成 work PDF
  r = await req('POST', '/api/cases/1/contracts', { template_id: 1, title: '可视化编辑器验证合同', party_ids: [34, 35] });
  ok(r.status === 200 && r.json && r.json.ok, '创建合同 ok');
  const contractId = r.json.contract.id;
  const cRow = (await pool.query(`SELECT work_pdf_path FROM contracts WHERE id=$1`, [contractId])).rows[0];
  ok(cRow.work_pdf_path, '合同已生成 work_pdf_path: ' + (cRow.work_pdf_path || ''));
  if (cRow.work_pdf_path) {
    const fp = path.join(__dirname, '.test-uploads', cRow.work_pdf_path);
    ok(fs.existsSync(fp), 'work PDF 文件存在');
  }

  // 8) 签署流程
  r = await req('GET', '/api/cases/1/contracts');
  const c = r.json.contracts.find(x => x.id === contractId);
  const t1 = c.signatures[0].sign_token, t2 = c.signatures[1].sign_token;
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  r = await req('POST', '/sign/' + t1, { signature_base64: 'data:image/png;base64,' + pngBase64 });
  ok(r.status === 200 && r.json && r.json.all_signed === false, '签署方1完成 all_signed:false');
  r = await req('POST', '/sign/' + t2, { signature_base64: 'data:image/png;base64,' + pngBase64 });
  ok(r.status === 200 && r.json && r.json.all_signed === true, '签署方2完成 all_signed:true');

  // 9) 下载已签署 PDF 并提取文本验证
  const dlRes = await fetch(BASE + '/sign/' + t1 + '/download', { headers: { Cookie: cookie }, redirect: 'manual' });
  ok(dlRes.status === 200 && (dlRes.headers.get('content-type') || '').includes('pdf'), '签署后下载 200');
  const pdfPath = path.join(__dirname, '.editor-signed-test.pdf');
  fs.writeFileSync(pdfPath, Buffer.from(await dlRes.arrayBuffer()));

  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const page = await doc.getPage(1);
    const tc = await page.getTextContent();
    const text = tc.items.map(i => i.str).join('');
    console.log('  签署 PDF 提取文本(前80):', text.slice(0, 80));
    ok(text.includes('案件编号'), '签署 PDF 内含预填充文本');
  } catch (e) {
    fail++;
    console.log('  FAIL 文本提取校验:', e.message);
  }

  // 10) 已签署合同应无法撤回（正确行为），直接用 DB 清理
  r = await req('POST', '/api/cases/1/contracts/' + contractId + '/revoke', {});
  ok(r.status === 400, '已签署合同不可撤回（返回400）');
  fs.unlinkSync(pdfPath);
  await pool.query(`DELETE FROM contracts WHERE id=$1`, [contractId]);
  await pool.query(`UPDATE contract_templates SET sign_positions='[{"page":1,"x":100,"y":600,"width":180,"height":60,"party_role":"原告","label":"受害人签名"},{"page":1,"x":400,"y":600,"width":180,"height":60,"party_role":"被告","label":"肇事方签名"}]', text_fields='[]' WHERE id=1`);
  await pool.end();

  console.log(`\n结果: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
