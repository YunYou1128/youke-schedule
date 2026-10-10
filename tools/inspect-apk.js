/**
 * 检查 APK 内容：列出 zip 条目（只读中央目录），确认 assets/web 资源已打入
 */
const fs = require('fs');
const path = require('path');

const apk = process.argv[2] || path.join(__dirname, '..', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const buf = fs.readFileSync(apk);

// 找 EOCD
let eocd = -1;
for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.log('未找到 EOCD，可能不是有效 zip'); process.exit(1); }

const total = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);

const names = [];
for (let n = 0; n < total; n++) {
  if (buf.readUInt32LE(off) !== 0x02014b50) break;
  const nameLen = buf.readUInt16LE(off + 28);
  const extraLen = buf.readUInt16LE(off + 30);
  const cmtLen = buf.readUInt16LE(off + 32);
  const size = buf.readUInt32LE(off + 24);
  const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
  names.push({ name, size });
  off += 46 + nameLen + extraLen + cmtLen;
}

console.log('APK: ' + apk);
console.log('文件大小: ' + (buf.length / 1048576).toFixed(2) + ' MB');
console.log('zip 条目总数: ' + names.length);

console.log('\n=== assets/web（应用页面资源）===');
const web = names.filter((x) => x.name.startsWith('assets/web/'));
web.forEach((x) => console.log('  ' + x.name.padEnd(52) + (x.size / 1024).toFixed(1) + ' KB'));
if (!web.length) console.log('  ✘ 未找到 assets/web！');

console.log('\n=== 关键文件 ===');
['AndroidManifest.xml', 'classes.dex', 'resources.arsc'].forEach((k) => {
  const hit = names.find((x) => x.name === k);
  console.log('  ' + (hit ? '✔' : '✘') + ' ' + k + (hit ? '  (' + (hit.size / 1024).toFixed(1) + ' KB)' : ''));
});

const dexCount = names.filter((x) => /^classes\d*\.dex$/.test(x.name)).length;
console.log('  ✔ classes*.dex 共 ' + dexCount + ' 个');

console.log('\n=== META-INF（签名）===');
names.filter((x) => x.name.startsWith('META-INF/')).forEach((x) => console.log('  ' + x.name));

// 校验 assets 中的 store.js 是最新版（含 Excel 日期化还原逻辑）
console.log('\n=== 内容校验 ===');
const assetStore = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'web', 'js', 'store.js');
const src = fs.readFileSync(assetStore, 'utf8');
console.log('  assets/store.js 含 Excel 日期还原逻辑: ' + (/月/.test(src) && /\\d\{1,2\}/.test(src) ? '✔' : '✘'));
console.log('  assets/store.js 含周次区间解析: ' + (/parseWeeksExpr/.test(src) ? '✔' : '✘'));
