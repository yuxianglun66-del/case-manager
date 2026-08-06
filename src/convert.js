const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 将 Word(.doc/.docx/.wps/.rtf) 与 Excel(.xls/.xlsx/.csv) 转换为 PDF
// 生产环境（Docker/Linux）统一用 LibreOffice；Windows 开发机优先 LibreOffice，否则 Word 用 COM、Excel 报错
function convertOfficeToPdf(srcPath, destPath) {
  if (os.platform() === 'win32') {
    const lo = findLibreOffice();
    if (lo) return convertWithLibreOffice(lo, srcPath, destPath);
    if (/\.(xlsx?|csv)$/i.test(path.extname(srcPath))) {
      return Promise.reject(new Error('Excel 转 PDF 需要安装 LibreOffice'));
    }
    return convertWithWordCOM(srcPath, destPath);
  }
  return convertWithLibreOffice('libreoffice', srcPath, destPath);
}

function findLibreOffice() {
  if (os.platform() === 'win32') {
    for (const p of [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    ]) {
      if (fs.existsSync(p)) return p;
    }
  }
  return 'libreoffice';
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

function convertWithLibreOffice(bin, srcPath, destPath) {
  return new Promise((resolve, reject) => {
    const outDir = path.dirname(destPath);
    // 每次调用使用独立 UserInstallation，避免并发转换互相锁住 profile；
    // 容器内以 USER 1000 运行且无 HOME 环境变量，LibreOffice 找不到用户目录会失败，故把 HOME 指向可写临时目录
    const userInstall = path.join(os.tmpdir(), 'lo_profile_' + process.pid + '_' + Date.now());
    const installUrl = 'file:///' + userInstall.replace(/\\/g, '/').replace(/^\/+/, '');

    execFile(bin, [
      '--headless',
      '-env:UserInstallation=' + installUrl,
      '--convert-to', 'pdf',
      '--outdir', outDir,
      srcPath,
    ], {
      timeout: 120000,
      env: { ...process.env, HOME: os.tmpdir() },
    }, (err, stdout, stderr) => {
      // 无论成败都清理临时 profile
      try { fs.rmSync(userInstall, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      if (err) return reject(new Error(`文档转 PDF 失败：${stderr || err.message}`));

      // LibreOffice 输出文件名 = 源文件名改后缀为 .pdf
      const srcBase = path.basename(srcPath, path.extname(srcPath));
      const generatedPdf = path.join(outDir, srcBase + '.pdf');

      if (!fs.existsSync(generatedPdf)) {
        return reject(new Error('文档转 PDF 失败：未生成文件'));
      }

      // 如果生成的文件名与目标不同，重命名
      if (generatedPdf !== destPath) {
        try {
          fs.renameSync(generatedPdf, destPath);
        } catch (e) {
          return reject(new Error('文档转 PDF 失败：输出文件命名失败'));
        }
      }

      resolve(destPath);
    });
  });
}

module.exports = { convertOfficeToPdf };
