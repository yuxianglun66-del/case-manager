const BASE = 'http://127.0.0.1:3102';
const fs = require('fs');
let cookie = '';
async function req(method, path, body, isForm = false, headers = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  let init = { method, headers: h };
  if (body) {
    if (isForm) {
      init.body = new URLSearchParams(body);
      h['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
      init.body = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(BASE + path, init);
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, text, json, headers: res.headers };
}

(async () => {
  let r = await req('POST', '/login', { username: 'admin', password: 'admin123' }, true);
  console.log('login:', r.status);

  // 1. 上传 Word 合同模板
  const wordBuf = fs.readFileSync('C:\\case-manager\\.test-uploads\\测试合同.docx');
  const fd = new FormData();
  fd.append('name', '测试Word合同模板');
  fd.append('sign_positions', JSON.stringify([{x:100,y:600,page:1,label:'甲方签名',width:180,height:60,party_role:'甲方'},{x:400,y:600,page:1,label:'乙方签名',width:180,height:60,party_role:'乙方'}]));
  fd.append('file', new Blob([wordBuf], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), '测试合同.docx');
  r = await fetch(BASE + '/api/contract-templates', { method: 'POST', headers: { Cookie: cookie }, body: fd });
  let t = await r.json();
  console.log('upload word template:', r.status, JSON.stringify(t).slice(0, 200));

  // 2. 创建合同（用该新模板），party_ids 用 case_parties 里真实存在的
  r = await req('GET', '/api/cases/1');
  console.log('case parties count check');
  const tplId = t.template.id;
  r = await req('POST', '/api/cases/1/contracts', { template_id: tplId, title: '测试Word合同签署', party_ids: [34, 35] });
  console.log('create contract:', r.status, JSON.stringify(r.json).slice(0, 120));
  const contractId = r.json.contract.id;

  // 3. 取 token
  r = await req('GET', '/api/cases/1/contracts');
  const c = r.json.contracts.find(x => x.id === contractId);
  const token1 = c.signatures[0].sign_token;
  const token2 = c.signatures[1].sign_token;
  console.log('sign tokens:', token1.slice(0, 8), token2.slice(0, 8));

  // 4. 签署页 + PDF 预览
  r = await req('GET', '/sign/' + token1);
  console.log('sign page:', r.status, 'hasIframe:', r.text.includes('pdfFrame'));
  r = await req('GET', '/sign/' + token1 + '/pdf');
  console.log('pdf preview:', r.status, 'type:', r.headers.get('content-type'), 'bytes:', r.text.length);

  // 5. 双方签名
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  r = await req('POST', '/sign/' + token1, { signature_base64: 'data:image/png;base64,' + pngBase64 });
  console.log('sign1:', r.status, JSON.stringify(r.json));
  r = await req('POST', '/sign/' + token2, { signature_base64: 'data:image/png;base64,' + pngBase64 });
  console.log('sign2:', r.status, JSON.stringify(r.json));

  // 6. 下载已签署 PDF
  r = await req('GET', '/sign/' + token1 + '/download');
  console.log('token download:', r.status, 'type:', r.headers.get('content-type'), 'bytes:', r.text.length);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
