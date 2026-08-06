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
    const lineH = size + 2;
    const maxLines = Math.max(1, Math.floor((tf.height || 40) / lineH));
    const charsPerLine = Math.max(1, Math.floor(w / size));
    const rawLines = text.split('\n');
    const lines = [];
    for (const rl of rawLines) {
      for (let i = 0; i < rl.length; i += charsPerLine) lines.push(rl.slice(i, i + charsPerLine));
    }
    const useLines = lines.slice(0, maxLines);
    for (let i = 0; i < useLines.length; i++) {
      // PDF 坐标 y 原点左下角，从上到下逐行绘制
      const y = page.getHeight() - yTop - i * lineH - size;
      page.drawText(useLines[i], { x, y, size, font: cjkFont, color: rgb(0, 0, 0) });
    }
    drawn++;
  }
  return drawn > 0;
}

module.exports = { embedCjkFont, stampTextFields, fillTemplateText };
