/**
 * 手机视口预览：把 web/ 复制到 ASCII 路径下，注入真实课表数据，
 * 供无头 Edge/Chrome 截图，用于验收界面需求（七列同屏 / 一屏 8 节 / 卡片精简）。
 *
 * 用法： node tools/preview-shot.js [周次]
 * 输出： 打印预览页面的 file:// URL
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const week = parseInt(process.argv[2], 10) || 3;
const outDir = process.env.PREVIEW_DIR || 'X:/preview-sched';
// 默认预览当前 web/；设 PREVIEW_SRC 可预览任意目录（如从历史 APK 提取出的旧版本），用于回放迭代过程截图
const srcDir = process.env.PREVIEW_SRC ? path.resolve(process.env.PREVIEW_SRC) : path.join(root, 'web');
const dataDir = path.join(root, 'web');   // 课表数据始终取当前版本（旧版本解析器 API 相同）

/* 递归复制（不用 fs.cpSync，个别环境下会异常退出） */
function copyDir(a, b) {
  if (fs.statSync(a).isDirectory()) {
    fs.mkdirSync(b, { recursive: true });
    fs.readdirSync(a).forEach(f => copyDir(path.join(a, f), path.join(b, f)));
  } else {
    fs.copyFileSync(a, b);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
copyDir(srcDir, outDir);

/* 解析真实课表，注入预览页面 */
global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
require(path.join(dataDir, 'js', 'store.js'));
require(path.join(dataDir, 'js', 'csv.js'));

/* 课表素材已从 web/ 移到 tools/fixtures/（web/ 是「出厂内容目录」，里面任何文件
   都会被 sync-assets.js 镜像进 assets/ 并打进 APK）。dataDir 仍指向 web/ ——
   上面两行 require 要从当前版本目录里取 store.js / csv.js。 */
const fixtureDir = path.join(root, 'tools', 'fixtures');
const csvName = fs.existsSync(path.join(fixtureDir, '大三上.csv')) ? '大三上.csv' : '示例课表.csv';
const buf = fs.readFileSync(path.join(fixtureDir, csvName));
let text = new TextDecoder('utf-8').decode(buf);
if (/\uFFFD/.test(text)) text = new TextDecoder('gbk').decode(buf);

const parsed = global.CsvUtil.parse(text, { totalWeeks: 16, sections: 12 });
const maxSection = parsed.courses.reduce((m, c) => Math.max(m, c.end), 0);

/* 多课表预览（PREVIEW_TWO=1）：再造一个「大三下」，
   数据取教务处下发的 .xls 真实课表，用来验证两个课表互不影响。 */
let second = null;
if (process.env.PREVIEW_TWO) {
  try {
    const xlsPath = path.join(root, 'tools', 'fixtures', '教务处课表.xls');
    if (fs.existsSync(xlsPath)) {
      require(path.join(dataDir, 'js', 'xls.js'));
      const b = fs.readFileSync(xlsPath);
      const r = global.XlsUtil.parse(
        new Uint8Array(b.buffer, b.byteOffset, b.byteLength), { totalWeeks: 18, sections: 12 });
      second = { name: process.env.PREVIEW_TWO || '大三下', courses: r.courses };
    }
  } catch (e) {
    console.error('（第二份课表解析失败，已跳过：' + e.message + '）');
  }
}

let html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');

/* 数据必须在 Store.load() 之后写入 —— load() 会重建课表列表，
   所以这里只把数据挂在 window 上，等页面 load 事件里再灌进去。 */
const seed = [
  '<script>',
  'window.__PREVIEW_PLAN__ = {',
  '  first: { name: "大三上", courses: ' + JSON.stringify(parsed.courses) + ',',
  '           totalWeeks: 16, sections: ' + Math.max(12, maxSection) + ', start: "2026-08-31" },',
  '  second: ' + (second
    ? '{ name: ' + JSON.stringify(second.name) + ', courses: ' + JSON.stringify(second.courses) +
      ', totalWeeks: 18, sections: 12, start: "2027-02-22" }'
    : 'null'),
  '};',
  '</script>'
].join('\n');

html = html.replace('<script src="js/app.js"></script>', seed + '\n<script src="js/app.js"></script>');

/* 页面 load 后：灌数据 -> 切到指定课表 / 主题 -> 渲染 */
const setup = [
  '<script>window.addEventListener("load",function(){',
  '  var P = window.__PREVIEW_PLAN__;',
  '  function build(plan){',
  '    var s = Store.list()[0];',
  '    if (s) { s.name = plan.name; s.courses = plan.courses; }',
  '    Store.state.settings.totalWeeks = plan.totalWeeks;',
  '    Store.state.settings.sections = plan.sections;',
  '    Store.state.settings.semesterStart = plan.start;',
  '    Store.syncTimesLength();',
  '  }',
  '  build(P.first);',
  '  if (P.second) {',
  '    var s2 = Store.create(P.second.name);',
  '    s2.courses = P.second.courses;',
  '    s2.settings.totalWeeks = P.second.totalWeeks;',
  '    s2.settings.sections = P.second.sections;',
  '    s2.settings.semesterStart = P.second.start;',
  '    Store.setActive(Store.list()[0].id);',
  '    Store.syncTimesLength();',
  '    Store.save();',
  '  }',
  '  Store.setTheme(' + JSON.stringify(process.env.PREVIEW_THEME || 'auto') + ');',
  '  ScheduleApp.applyTheme();',
  '  ScheduleApp.syncImportTarget();',
  '  ScheduleApp.state.viewWeek = ' + week + ';',
  '  ScheduleApp.render();',
  '  ScheduleApp.renderSchedList();',
  '  document.getElementById("gridWrap").scrollTop = 0;',
  (process.env.PREVIEW_UI === 'sched'
    ? '  document.getElementById("btnSched").click();'
    : process.env.PREVIEW_UI === 'settings'
      ? '  document.getElementById("btnSettings").click();'
      : process.env.PREVIEW_UI === 'import'
        ? '  document.getElementById("btnImport").click();'
        : ''),
  '});</script>'
].join('\n');

html = html.replace('</body>', setup + '\n</body>');

/* 加 --metrics 时把真实布局尺寸写进 DOM，便于 --dump-dom 读取 */
if (process.argv.includes('--metrics')) {
  html = html.replace('</body>', [
    '<script>window.addEventListener("load",function(){setTimeout(function(){',
    'var s=document.getElementById("schedule"),gw=document.getElementById("gridWrap");',
    'var hr=document.querySelector(".head-row"),dc=document.querySelector(".day-col");',
    'var m={viewportW:window.innerWidth,viewportH:window.innerHeight,',
    '  docW:document.documentElement.clientWidth,appW:document.getElementById("app").offsetWidth,',
    '  scheduleW:s.offsetWidth,headRowW:hr?hr.offsetWidth:0,dayColW:dc?dc.offsetWidth:0,',
    '  gridWrapH:gw.clientHeight,gridWrapW:gw.clientWidth,headH:hr?hr.offsetHeight:0,',
    '  rowH:getComputedStyle(document.documentElement).getPropertyValue("--row-h"),',
    '  bodyScrollW:document.body.scrollWidth,bodyScrollH:document.body.scrollHeight};',
    'var p=document.createElement("pre");p.id="metrics";',
    'p.textContent="METRICS "+JSON.stringify(m);document.body.appendChild(p);',
    '},400);});</script>\n</body>'
  ].join(''));
}

fs.writeFileSync(path.join(outDir, 'preview.html'), html);

const url = 'file:///' + path.join(outDir, 'preview.html').replace(/\\/g, '/');
console.log(url);
