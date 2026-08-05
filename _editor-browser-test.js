// 编辑器浏览器渲染验证（headless Chrome CDP）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const BASE = 'http://127.0.0.1:3102';

async function loginCookie() {
  const g = await fetch(BASE + '/login');
  const setc1 = g.headers.get('set-cookie');
  const body = new URLSearchParams({ username: 'admin', password: 'admin123' });
  const r = await fetch(BASE + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(setc1 ? { Cookie: setc1.split(';')[0] } : {}) }, body });
  const setc = r.headers.get('set-cookie');
  if (!setc) throw new Error('no session cookie from login: ' + r.status);
  return setc.split(';')[0];
}

function wsFrame(data) { return Buffer.concat([Buffer.from([0x81]), Buffer.from([data.length]), data]); }
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const len = buf[1] & 0x7f;
  let offset = 2, payload;
  if (len === 126) { offset = 4; } else if (len === 127) { offset = 10; }
  payload = buf.subarray(offset, offset + (len === 126 ? buf.readUInt16BE(2) : len));
  if (buf[0] & 0x80) {
    const mask = buf.subarray(offset, offset + 4);
    const out = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i % 4];
    payload = out;
  }
  return JSON.parse(payload.toString());
}

(async () => {
  const cookie = await loginCookie();
  const dir = path.join(__dirname, '.chrome-editor');
  fs.mkdirSync(dir, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${dir}`, '--no-proxy-server', 'about:blank'
  ], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 2500));

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pageTarget = list.find(t => t.type === 'page');
  if (!pageTarget) throw new Error('no page target');
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : decodeFrame(Buffer.from(ev.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
      logs.push('console: ' + args);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('exception: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    }
    if (msg.method === 'Log.entryAdded') {
      logs.push('log: ' + msg.params.entry.level + ' ' + msg.params.entry.text);
    }
    if (msg.method === 'Network.requestWillBeSent' && msg.params.request.url.includes('/api/contract-templates/1/pdf')) {
      logs.push('REQ ' + msg.params.request.method + ' headers=' + JSON.stringify(msg.params.request.headers));
    }
    if (msg.method === 'Network.responseReceived' && msg.params.response.url.includes('/api/contract-templates/1/pdf')) {
      logs.push('RESP status=' + msg.params.response.status + ' mime=' + (msg.params.response.mimeType||'') + ' headers=' + JSON.stringify(msg.params.response.headers) + ' fromCache=' + msg.params.response.fromDiskCache + '/' + msg.params.response.fromPrefetchCache);
    }
  };
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });

  await send('Network.enable');
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  const c = cookie.split('=');
  await send('Network.setCookie', { name: c[0], value: c.slice(1).join('='), url: BASE });

  const evalJs = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (res.error) return undefined;
    if (res.result && res.result.exceptionDetails) {
      console.log('  eval error:', res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text);
      return undefined;
    }
    return res.result?.result?.value;
  };

  await send('Page.navigate', { url: BASE + '/settings/templates/1/edit' });
  await new Promise(r => setTimeout(r, 7000));

  const canvases = await evalJs('document.querySelectorAll(".ed-page canvas").length');
  const canvasOk = await evalJs('(() => { const c = document.querySelector(".ed-page canvas"); if (!c) return false; const d = c.getContext("2d").getImageData(0,0,Math.min(50,c.width),Math.min(50,c.height)).data; return d.some(v => v > 0); })()');
  const pageCount = await evalJs('window.__pdfPages || 0');
  const toolbar = await evalJs('document.querySelectorAll("[data-tool]").length');
  const hasSave = await evalJs('!!document.getElementById("btnSave")');
  const propPanel = await evalJs('!!document.getElementById("propPanel")');
  const boxCount = await evalJs('document.querySelectorAll(".ed-box").length');

  console.log('editor page rendered canvases:', canvases);
  console.log('canvas has drawn pixels:', canvasOk);
  console.log('toolbar buttons:', toolbar, '| save btn:', hasSave, '| prop panel:', propPanel);
  console.log('initial boxes (from saved sign_positions):', boxCount);
  console.log('edLoading:', JSON.stringify(await evalJs('document.getElementById("edLoading") && document.getElementById("edLoading").innerHTML.slice(0,200)')));
  console.log('page fetch status:', await evalJs('fetch("/api/contract-templates/1/pdf").then(async r => JSON.stringify({ status: r.status, len: (await r.arrayBuffer()).byteLength, ct: r.headers.get("content-type") })).catch(e => "fetchERR:" + e.message)'));
  console.log('json fetch:', await evalJs('fetch("/api/contract-templates").then(r => r.status).catch(e => "ERR:" + e.message)'));
  console.log('css fetch:', await evalJs('fetch("/css/app.css").then(r => r.status).catch(e => "ERR:" + e.message)'));
  console.log('static pdf fetch:', await evalJs('fetch("/_t.pdf").then(async r => JSON.stringify({ status: r.status, len: (await r.arrayBuffer()).byteLength, ct: r.headers.get("content-type") })).catch(e => "ERR:" + e.message)'));
  console.log('bin fetch:', await evalJs('fetch("/_t.bin").then(async r => JSON.stringify({ status: r.status, len: (await r.arrayBuffer()).byteLength, ct: r.headers.get("content-type") })).catch(e => "ERR:" + e.message)'));
  console.log('same-origin fetch:', await evalJs('fetch("/_t.pdf", { mode: "same-origin" }).then(async r => JSON.stringify({ status: r.status, len: (await r.arrayBuffer()).byteLength })).catch(e => "ERR:" + e.message)'));
  console.log('xhr fetch:', await evalJs('new Promise(res => { const x = new XMLHttpRequest(); x.open("GET", "/_t.pdf"); x.responseType = "arraybuffer"; x.onload = () => res(JSON.stringify({ status: x.status, len: x.response ? x.response.byteLength : 0 })); x.onerror = () => res("ERR:" + x.statusText); x.send(); })'));
  console.log('img tag test:', await evalJs('new Promise(res => { const i = new Image(); i.onload = () => res("img ok " + i.naturalWidth); i.onerror = () => res("img err"); i.src = "/_t.bin"; setTimeout(() => res("img timeout"), 3000); })'));
  console.log('iframe test:', await evalJs('new Promise(res => { const f = document.createElement("iframe"); f.src = "/_t.pdf"; f.onload = () => { try { res("iframe loaded, content len=" + (f.contentDocument ? f.contentDocument.body ? "doc" : "pdfplugin" : "no-doc")); } catch(e) { res("iframe loaded (cross doc): " + e.message); } }; f.onerror = () => res("iframe error"); document.body.appendChild(f); setTimeout(() => res("iframe timeout"), 5000); })'));
  console.log('nav test:', await evalJs('new Promise(res => { const f = document.createElement("iframe"); f.src = "/_t.bin"; f.onload = () => { try { res("bin iframe loaded, doc=" + (f.contentDocument && f.contentDocument.body ? f.contentDocument.body.innerHTML.slice(0,50) : "binary-or-empty")); } catch(e) { res("bin iframe cross doc: " + e.message); } }; document.body.appendChild(f); setTimeout(() => res("bin iframe timeout"), 5000); })'));
  console.log('png img:', await evalJs('new Promise(res => { const i = new Image(); i.onload = () => res("png img ok " + i.naturalWidth + "x" + i.naturalHeight); i.onerror = () => res("png img err"); i.src = "/_t.png?_=" + Date.now(); setTimeout(() => res("png img timeout"), 3000); })'));
  console.log('png fetch:', await evalJs('fetch("/_t.png?_=" + Date.now()).then(async r => JSON.stringify({ status: r.status, len: (await r.arrayBuffer()).byteLength })).catch(e => "ERR:" + e.message)'));
  const pdfB64 = fs.readFileSync(path.join(__dirname, '.test-uploads', 'contracts', 'traffic_mediation.pdf')).toString('base64');
  const pdfDataTest = await evalJs(`(async () => {
    try {
      const pdfjsLib = await import('/vendor/pdfjs/pdf.min.mjs');
      const bytes = Uint8Array.from(atob(${JSON.stringify(pdfB64)}), c => c.charCodeAt(0));
      const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const d = ctx.getImageData(0, 0, Math.min(40, canvas.width), Math.min(40, canvas.height)).data;
      return JSON.stringify({ ok: true, pages: doc.numPages, w: canvas.width, h: canvas.height, hasPixels: d.some(v => v > 0) });
    } catch (e) { return JSON.stringify({ ok: false, err: e.message }); }
  })()`);
  console.log('pdfjs data-load test:', pdfDataTest);
  console.log('--- browser logs ---');
  logs.forEach(l => console.log(l));
  console.log('--- end logs ---');

  // 模拟：切换到添加签名框工具并点击页面空白，应创建一个框
  await evalJs('document.querySelector("[data-tool=sig]").click()');
  await evalJs(`(() => {
    const el = document.querySelector(".ed-page");
    const r = el.getBoundingClientRect();
    const cx = r.left + 300, cy = r.top + 300;
    el.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true }));
    document.dispatchEvent(new PointerEvent("pointermove", { clientX: cx + 120, clientY: cy + 50, bubbles: true }));
    document.dispatchEvent(new PointerEvent("pointerup", { clientX: cx + 120, clientY: cy + 50, bubbles: true }));
  })()`);
  await new Promise(r => setTimeout(r, 100));
  const boxAfter = await evalJs('document.querySelectorAll(".ed-box").length');
  console.log('boxes after creating a signature box:', boxAfter);

  chrome.kill();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  const pass = canvases >= 1 && canvasOk && toolbar >= 3 && hasSave && propPanel && boxCount >= 0 && boxAfter >= boxCount + 1;
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
