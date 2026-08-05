const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function convertWordToPdf(srcPath, destPath) {
  const isWin = os.platform() === 'win32';

  if (isWin) {
    return convertWithWordCOM(srcPath, destPath);
  } else {
    return convertWithLibreOffice(srcPath, destPath);
  }
}

function convertWithWordCOM(srcPath, destPath) {
  return new Promise((resolve, reject) => {
    const ps = [
      `$ErrorActionPreference = 'Stop'`,
      `$word = New-Object -ComObject Word.Application`,
      `$word.Visible = $false`,
      `$word.DisplayAlerts = 0`,
      `$doc = $word.Documents.Open('${srcPath.replace(/'/g, "''")}', $false, $true)`,
      `$doc.ExportAsFixedFormat('${destPath.replace(/'/g, "''")}', 17)`,
      `$doc.Close($false)`,
      `$word.Quit()`,
      `[System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null`,
      `[System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null`,
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Word 转 PDF 失败：${stderr || err.message}`));
      if (!fs.existsSync(destPath)) return reject(new Error('Word 转 PDF 失败：未生成文件'));
      resolve(destPath);
    });
  });
}

function convertWithLibreOffice(srcPath, destPath) {
  return new Promise((resolve, reject) => {
    const outDir = path.dirname(destPath);
    const baseName = path.basename(destPath);

    // LibreOffice 导出为 PDF：--convert-to pdf --outdir 输出目录
    execFile('libreoffice', [
      '--headless',
      '--convert-to', 'pdf',
      '--outdir', outDir,
      srcPath,
    ], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Word 转 PDF 失败：${stderr || err.message}`));

      // LibreOffice 输出文件名 = 源文件名改后缀为 .pdf
      const srcBase = path.basename(srcPath, path.extname(srcPath));
      const generatedPdf = path.join(outDir, srcBase + '.pdf');

      if (!fs.existsSync(generatedPdf)) {
        return reject(new Error('Word 转 PDF 失败：未生成文件'));
      }

      // 如果生成的文件名与目标不同，重命名
      if (generatedPdf !== destPath) {
        fs.renameSync(generatedPdf, destPath);
      }

      resolve(destPath);
    });
  });
}

module.exports = { convertWordToPdf };
