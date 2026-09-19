'use strict';
// 输出 A) info 区块的 EJS 结构标记行  B) 案件名称/客户 的行号  C) 精确定位 状态更新时间 块全文
const fs = require('fs');
const d = fs.readFileSync('C:/case-manager/views/cases/detail.ejs', 'utf8');
const L = d.split(/\r?\n/);
for (let i = 34; i < 80; i++) {
  const t = L[i - 1];
  if (t == null) continue;
  if (/info-grid|info-item|info-label|info-value|status_at|创建时间|最近更新|创建人|签单|客户|服务人员|当事人|创建人|案件名称/.test(t)) {
    console.log(i + ': ' + t.trim().replace(/\s+/g, ' ').slice(0, 108));
  }
}
