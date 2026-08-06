const fs = require('fs');
const path = require('path');
const { rgb } = require('pdf-lib');

// 在 pdfDoc 中加载中文字体（找不到可用字体时返回 null，调用方跳过中文绘制）
async function embedCjkFont(pdfDoc) {
  try {
    const fontkit = require('@pdf-lib/fontkit');
    const candidates = [
      path.join(__dirname, '..', 'assets', 'fonts', 'DroidSansFallbackFull.ttf'),
      'C:/Windows/Fonts/simhei.ttf',
      'C:/Windows/Fonts/simsun.ttc',
      'C:/Windows/Fonts/msyh.ttc',
      '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
      '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    ];
    for (const f of candidates) {
      if (!fs.existsSync(f)) continue;
      try {
        const buf = fs.readFileSync(f);
        const probe = fontkit.create(buf);
        // .ttc 集合字体（TrueTypeCollection）没有 layout 方法，pdf-lib 在 drawText/save 时会抛
        // "this.font.layout is not a function"，必须跳过，只用单字体 .ttf/.otf
        if (typeof probe.layout !== 'function') continue;
        pdfDoc.registerFontkit(fontkit);
        return await pdfDoc.embedFont(buf);
      } catch (e) { /* 尝试下一个候选字体 */ }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// 文本占位符替换：{title}/{case_no}/{client_name}/{date}
function fillTemplateText(text, data = {}) {
  const dateStr = new Date().toLocaleDateString('zh-CN');
  const m = { '{title}': data.title || '', '{case_no}': data.case_no || '', '{client_name}': data.client_name || '', '{date}': dateStr };
  return String(text == null ? '' : text).replace(/\{(title|case_no|client_name|date)\}/g, (k) => m[k] || '');
}

// 在 pdfDoc 上绘制文本字段（坐标：PDF 点，原点左下角；与签名框一致）
function stampTextFields(pdfDoc, textFields, data = {}, cjkFont) {
  if (!textFields || !textFields.length) return false;
  const pages = pdfDoc.getPages();
  let drawn = 0;
  for (const tf of textFields) {
    const page = pages[tf.page - 1];
    if (!page) continue;
    const text = fillTemplateText(tf.text, data);
    if (!text) continue;
    const size = tf.size || 12;
    const x = tf.x || 72;
    const w = tf.width || 200;
    const yTop = tf.y || (page.getHeight() - 72);
    const h = tf.height || 40;
    // 自适应字号：按盒子宽高缩小字号（下限 7pt），保证长文本（如 18 位身份证号）能完整放进盒子
    const MIN_SIZE = 7;
    let effSize = MIN_SIZE;
    for (let s = size; s >= MIN_SIZE; s--) {
      const cpl = Math.max(1, Math.floor(w / s));
      const lh = s + 2;
      const ml = Math.max(1, Math.floor(h / lh));
      let need = 0;
      for (const rl of text.split('\n')) {
        need += Math.max(1, Math.ceil((rl || '').length / cpl));
      }
      if (need <= ml) { effSize = s; break; }
    }
    const lineH = effSize + 2;
    const charsPerLine = Math.max(1, Math.floor(w / effSize));
    const lines = [];
    for (const rl of text.split('\n')) {
      if (rl === '') { lines.push(''); continue; }
      for (let i = 0; i < rl.length; i += charsPerLine) lines.push(rl.slice(i, i + charsPerLine));
    }
    for (let i = 0; i < lines.length; i++) {
      // PDF 坐标 y 原点左下角，从上到下逐行绘制；即使超出盒子高度也全部绘制，避免丢失数据
      const y = page.getHeight() - yTop - i * lineH - effSize;
      page.drawText(lines[i], { x, y, size: effSize, font: cjkFont, color: rgb(0, 0, 0) });
    }
    drawn++;
  }
  return drawn > 0;
}

module.exports = { embedCjkFont, stampTextFields, fillTemplateText };
