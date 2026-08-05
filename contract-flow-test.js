const BASE = 'http://127.0.0.1:3102';
let cookie = '';
let csrfToken = '';

async function req(method, path, body, isForm = false) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  let init = { method, headers, redirect: 'manual' };
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
    if (isForm) {
      init.body.append('_csrf', csrfToken);
    } else {
      headers['x-csrf-token'] = csrfToken;
    }
  }
  const res = await fetch(BASE + path, init);
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  // follow redirects manually
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (loc) return req('GET', loc);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  // extract csrf from meta tag if present
  const csrfMatch = text.match(/name="csrf-token"\s+content="([^"]+)"/);
  if (csrfMatch) csrfToken = csrfMatch[1];
  return { status: res.status, text, json, headers: res.headers };
}

(async () => {
  // GET login page first (get session + CSRF token)
  let r = await req('GET', '/login');
  console.log('login page:', r.status, 'csrf:', csrfToken ? 'found' : 'missing');

  // login (must_change_password = TRUE for admin → will redirect to /change-password)
  r = await req('POST', '/login', { username: 'admin', password: 'admin123' }, true);
  console.log('login:', r.status, r.json ? JSON.stringify(r.json) : r.text.substring(0, 100));

  // if redirected to change-password, change it
  if (r.text.includes('修改密码') || r.text.includes('change-password')) {
    // extract csrf from this page
    const csrfMatch = r.text.match(/name="csrf-token"\s+content="([^"]+)"/);
    if (csrfMatch) csrfToken = csrfMatch[1];
    r = await req('POST', '/change-password', { old_password: 'admin123', new_password: 'Admin@1234', confirm_password: 'Admin@1234' }, true);
    console.log('change-password:', r.status, r.text.substring(0, 120));
    // now go to dashboard
    r = await req('GET', '/dashboard');
    console.log('after change-password redirect:', r.status);
  }

  // templates
  r = await req('GET', '/api/contract-templates');
  const tpl = r.json.templates[0];
  console.log('template:', tpl.id, tpl.name);

  // create contract
  r = await req('POST', '/api/cases/1/contracts', { template_id: 1, title: '张伟交通事故调解协议书', party_ids: [34, 35] });
  console.log('create contract:', r.status, JSON.stringify(r.json));
  const contractId = r.json.contract.id;

  // list contracts to get tokens
  r = await req('GET', '/api/cases/1/contracts');
  const c = r.json.contracts.find(x => x.id === contractId);
  console.log('contract:', c.id, c.status, 'sigs:', JSON.stringify(c.signatures));
  const token1 = c.signatures[0].sign_token;
  const token2 = c.signatures[1].sign_token;

  // access sign page
  r = await req('GET', '/sign/' + token1);
  console.log('sign page:', r.status, 'hasIframe:', r.text.includes('pdfFrame'), 'hasCanvas:', r.text.includes('signCanvas'));

  // preview pdf
  r = await req('GET', '/sign/' + token1 + '/pdf');
  console.log('pdf preview:', r.status, 'type:', r.headers.get('content-type'));

  // create a fake PNG signature
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  // party 1 signs
  r = await req('POST', '/sign/' + token1, { signature_base64: 'data:image/png;base64,' + pngBase64 });
  console.log('sign1:', r.status, JSON.stringify(r.json));

  // party 2 signs
  r = await req('POST', '/sign/' + token2, { signature_base64: 'data:image/png;base64,' + pngBase64 });
  console.log('sign2:', r.status, JSON.stringify(r.json));

  // done page
  r = await req('GET', '/sign/' + token1 + '/done');
  console.log('done page:', r.status, 'hasDownload:', r.text.includes('/sign/' + token1 + '/download'));

  // download signed pdf
  r = await req('GET', '/api/contracts/' + contractId + '/download');
  console.log('download signed:', r.status, 'type:', r.headers.get('content-type'));

  // token download
  r = await req('GET', '/sign/' + token1 + '/download');
  console.log('token download:', r.status, 'type:', r.headers.get('content-type'));

  // revoke a new contract
  r = await req('POST', '/api/cases/1/contracts', { template_id: 1, title: '待撤回合同', party_ids: [34] });
  const cid2 = r.json.contract.id;
  r = await req('POST', '/api/cases/' + 1 + '/contracts/' + cid2 + '/revoke');
  console.log('revoke:', r.status, JSON.stringify(r.json));
  r = await req('GET', '/api/cases/1/contracts');
  const c2 = r.json.contracts.find(x => x.id === cid2);
  console.log('revoked contract status:', c2.status);

  // invalid token
  r = await req('GET', '/sign/deadbeef');
  console.log('invalid token page:', r.status);

  console.log('\n✅ ALL TESTS COMPLETE');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
