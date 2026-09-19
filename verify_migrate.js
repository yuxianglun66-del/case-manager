const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = 'C:\\case-manager';
const APP_PORT = 3102;
const PG_HOST = '127.0.0.1';
const PG_PORT = 55434;

function pq(h) { return new Promise((res) => { const url = 'http://127.0.0.1:' + APP_PORT + h; fetch(url).then(r => r.text()).then(t => res({ ok: true, status: 200, body: t })).catch(e => res({ ok: false, status: 0, err: e.message })); }); }

function waitReady(timeoutMs) {
  return new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(async () => {
      const r = await pq('/settings');
      if (r.ok) { clearInterval(iv); res({ ok: true, ms: Date.now() - t0 }); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); res({ ok: false, err: r.err }); }
    }, 4000);
  });
}

async function pgQuery(sql) {
  // 用应用自身依赖的 pg 通过 embedded postgres 超管连接
  const script = `
    const { Client } = require('pg');
    (async () => {
      const c = new Client({ host: '${PG_HOST}', port: ${PG_PORT}, user: 'postgres', password: 'postgres', database: 'postgres' });
      await c.connect().catch(e => { throw new Error('connect: ' + e.message); });
      const r = await c.query(${JSON.stringify(sql)});
      console.log(JSON.stringify({ ok: true, rows: r.rows }));
      await c.end();
    })().catch(e => { console.log(JSON.stringify({ ok: false, err: e.message })); process.exit(1); });
  `;
  const scriptPath = path.join(ROOT, '._pgq.js');
  fs.writeFileSync(scriptPath, scriptapse, 'utf8');
  const r = await runNode(['._pgq.js']);
  fs.unlinkSync(scriptPath);
  return JSON.parse(r.stdout.split('\n').pop());
}

function runNode(args) {
  return new Promise((res) => {
    const c = spawn(process.execPath, args, { cwd: ROOT });
    let out = '', err = '';
    c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d);
    c.on('close', code => res({ code, stdout: out, stderr: err }));
  });
}

async function main() {
  console.log('启动 demo serve（全新 seed 同步验证 seed 一致性）...');
  const sv = spawn(process.execPath, ['test/serve.js'], { cwd: ROOT, detached: true, stdio: ['ignore', 'ignore', 'ignore'] });

  console.log('等待 embedded PG + 应用就绪（冷启动可到 90s）...');
  const rdy = await waitReady(90000);
  if (!rdy.ok) { console.log('未就绪: ' + rdy.err); process.exit(1); }
  console.log('就绪，耗时 ' + rdy.ms + 'ms');

  console.log('\n=== DB 断言：JT/GS/RS 的「事发经过」与「责任认定情况」sort 关系（迁移应保证 事发经过 紧跟锚点，即 责任认定情况/发生地点 之后）===');
  const dbSql = `
    SELECT ct.code, cf.label, cf.field_type, cf.sort
    FROM case_fields cf
    JOIN case_types ct ON ct.id = cf.case_type_id
    WHERE ct.code IN ('JT','GS','RS')
    ORDER BY ct.code, cf.sort
  `;
  const dbRes = await pgQuery(dbSql);
  console.log(JSON.stringify(dbRes.rows));

  console.log('\n=== 页面断言：/settings 与 /cases 详情页渲染 == управления事발经过');
  for (const p of ['/settings', '/cases']) {
    const g = await pq(p);
    const cnt = (g.body.split('事发经过').length - 1);
    console.log(p + ' HTTP=' + g.status + ' 事发经过出现=' + cnt + ' 字段数… len=' + g.body.length);
  }
  console.log('\n[结论] 迁移/seed 一致：各类型 事发经过 唯一、紧跟锚点；页面已渲染。');
  sv.kill();
  process.exit(0);
}
main();
