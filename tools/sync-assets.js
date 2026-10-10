/**
 * 把 web/ 目录同步到 Android 工程的 assets/web/。
 * 修改 web/ 下的页面后，运行： node tools/sync-assets.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'web');
const dst = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'web');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const f = path.join(from, name);
    const t = path.join(to, name);
    if (fs.statSync(f).isDirectory()) copyDir(f, t);
    else {
      fs.copyFileSync(f, t);
      console.log('  + ' + path.relative(root, t));
    }
  }
}

if (!fs.existsSync(src)) {
  console.error('未找到 web/ 目录');
  process.exit(1);
}

fs.rmSync(dst, { recursive: true, force: true });
console.log('同步 web/ -> android/app/src/main/assets/web/');
copyDir(src, dst);
console.log('完成。');
