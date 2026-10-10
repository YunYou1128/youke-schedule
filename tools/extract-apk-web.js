/**
 * 从 APK 中提取 assets/web/ 到指定目录（用于回放历史版本的界面截图）。
 * 用法： node tools/extract-apk-web.js <apk路径> <输出目录>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const apk = process.argv[2];
const outDir = process.argv[3] || 'X:/preview-apk';
if (!apk || !fs.existsSync(apk)) { console.error('APK 不存在: ' + apk); process.exit(1); }

const buf = fs.readFileSync(apk);

// 定位中央目录
let p = buf.length - 22;
while (p > 0 && buf.readUInt32LE(p) !== 0x06054b50) p--;
if (p <= 0) { console.error('不是合法 zip'); process.exit(1); }

const total = buf.readUInt16LE(p + 10);
const cdOff = buf.readUInt32LE(p + 16);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

let q = cdOff, n = 0;
for (let i = 0; i < total; i++) {
  const nameLen = buf.readUInt16LE(q + 28);
  const extraLen = buf.readUInt16LE(q + 30);
  const cmtLen = buf.readUInt16LE(q + 32);
  const csize = buf.readUInt32LE(q + 20);
  const usize = buf.readUInt32LE(q + 24);
  const lho = buf.readUInt32LE(q + 42);
  const name = buf.toString('utf8', q + 46, q + 46 + nameLen);

  if (name.startsWith('assets/web/')) {
    const nl = buf.readUInt16LE(lho + 26);
    const el = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + nl + el;
    const data = buf.slice(start, start + csize);
    let raw;
    try { raw = csize === usize ? data : zlib.inflateRawSync(data); }
    catch (e) { raw = Buffer.alloc(0); }

    const rel = name.slice('assets/web/'.length);
    const dst = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, raw);
    console.log('  提取 ' + rel + '  ' + raw.length + 'B');
    n++;
  }
  q += 46 + nameLen + extraLen + cmtLen;
}
console.log('完成，共 ' + n + ' 个文件 -> ' + outDir);
