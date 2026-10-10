/**
 * 检查本机 Android SDK 是否具备出包条件
 * SDK 路径取环境变量 ANDROID_HOME，或命令行第一个参数：
 *   node tools/check-sdk.js            （读 ANDROID_HOME）
 *   node tools/check-sdk.js D:\Sdk     （显式指定）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SDK = process.env.ANDROID_HOME || process.argv[2] || '';
if (!SDK) {
  console.log('未指定 SDK 路径：请先设置 ANDROID_HOME 环境变量，或把路径作为第一个参数传入。');
  process.exit(1);
}
const out = [];
const log = (s) => out.push(s);

function list(p) {
  try { return fs.readdirSync(p); } catch (e) { return null; }
}

log('SDK 根目录: ' + SDK);
log('顶层: ' + (list(SDK) || '(不可读)').join(', '));

['platforms', 'build-tools', 'platform-tools', 'cmdline-tools', 'licenses'].forEach((d) => {
  const p = path.join(SDK, d);
  const l = list(p);
  log(`  ${d}: ` + (l === null ? '❌ 缺失' : l.join(', ')));
});

// platform 36 关键文件
const p36 = path.join(SDK, 'platforms', 'android-36');
log('\nplatforms/android-36 关键文件:');
['android.jar', 'build.prop', 'core-for-system-modules.jar'].forEach((f) => {
  const fp = path.join(p36, f);
  log('  ' + (fs.existsSync(fp) ? '✔ ' : '✘ ') + f + (fs.existsSync(fp) ? '  (' + (fs.statSync(fp).size / 1048576).toFixed(1) + ' MB)' : ''));
});

// build-tools
const btRoot = path.join(SDK, 'build-tools');
if (fs.existsSync(btRoot)) {
  list(btRoot).forEach((v) => {
    const d = path.join(btRoot, v);
    log(`\nbuild-tools/${v}: ` + list(d).join(', '));
    ['aapt2.exe', 'd8.bat', 'apksigner.bat', 'zipalign.exe'].forEach((f) => {
      log('  ' + (fs.existsSync(path.join(d, f)) ? '✔ ' : '✘ ') + f);
    });
  });
}

// platform-tools
const pt = path.join(SDK, 'platform-tools');
log('\nplatform-tools: ' + (fs.existsSync(path.join(pt, 'adb.exe')) ? '✔ adb.exe' : '✘'));

// licenses
const lic = path.join(SDK, 'licenses');
if (fs.existsSync(lic)) log('\nlicenses: ' + list(lic).join(', '));

// gradle wrapper dists
log('\n=== gradle wrapper dists ===');
const wd = path.join(os.homedir(), '.gradle', 'wrapper', 'dists');
function walk(p, depth, max) {
  if (depth > max) return;
  let items;
  try { items = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return; }
  items.forEach((it) => {
    const fp = path.join(p, it.name);
    if (it.isDirectory()) { log('  '.repeat(depth) + '[D] ' + it.name); walk(fp, depth + 1, max); }
    else log('  '.repeat(depth) + it.name + '  ' + fs.statSync(fp).size + 'B');
  });
}
walk(wd, 0, 3);

// 是否有可直接调用的 gradle
log('\n=== 可用 gradle 可执行文件 ===');
const wdGradle = path.join(wd, 'gradle-8.11.1-bin');
if (fs.existsSync(wdGradle)) {
  list(wdGradle).forEach((h) => {
    const g = path.join(wdGradle, h, 'gradle-8.11.1', 'bin');
    if (fs.existsSync(g)) log('  ✔ ' + g + ' -> ' + list(g).join(', '));
  });
}

// debug keystore
log('\n=== 签名 ===');
const ks = path.join(os.homedir(), '.android', 'debug.keystore');
log('  debug.keystore: ' + (fs.existsSync(ks) ? '✔ 已存在' : '✘ 缺失（构建时自动生成）'));

// JDK
log('\n=== JDK ===');
['C:\\Program Files\\Java\\jdk-21', 'C:\\Program Files\\Java'].forEach((p) => {
  if (fs.existsSync(p)) log('  ' + p + ' -> ' + list(p).join(', '));
});

fs.writeFileSync(path.join(__dirname, '..', '_sdk-check.txt'), out.join('\n'));
console.log(out.join('\n'));
