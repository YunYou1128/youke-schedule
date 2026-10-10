/**
 * 桌面小组件预览图：按**真实布局与渲染规则**搭一份预览页，供无头浏览器截图。
 *
 * 为什么不用真机/模拟器截图：本机没有 AVD、也没有连着的设备
 * （`adb devices` 是空的），所以出的是「按 widget_today.xml / widget_twoday.xml
 * 与 WidgetRender.kt 的规则复刻」的预览图，不是真机截图。
 * 复刻的是**规则**、不是像素：尺寸取真实 dp（2×2 = 175×155dp、
 * 4×2 = 358×155dp，390dp 宽桌面上按 4 列算），颜色与文案全部取自
 * Android 侧的 widget_* 令牌与 WidgetRender 的分支，
 * **课程色值则由 web/js/store.js 现算**（Store.courseHex）——
 * 这一点是有意的：小组件上那根色条必须和课表卡片同色，
 * 如果预览里我把色值手抄一遍，就正好把「两边可能不一致」这个风险盖住了。
 *
 * 用法：node tools/widget-preview.js
 * 输出：打印两份预览页的 file:// URL（白天 / 夜晚），交给 tools/shot.js 截图。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = process.env.PREVIEW_DIR || 'X:/preview-widget';

/* ---------- 1. 把 web/ 复制到 ASCII 路径（file:// 下中文路径不稳） ---------- */
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
copyDir(path.join(root, 'web'), outDir);

/* ---------- 2. 色令牌：与 android/.../res/values(-night)/colors.xml 逐项对应 ---------- */
const TOKENS = {
  light: {
    bg: '#FFFDF8', ink: '#241E16', ink2: '#6A6152', line: '#EFE8D9',
    accent: '#3E7C2E', focus: '#F6F1E7', soft: '#E4EFDC', hl: '#EDF4E7',
    wall: 'linear-gradient(155deg, #f7e9d3 0%, #e8efdc 45%, #d9e6f2 100%)',
    cap: 'rgba(36,30,22,.55)'
  },
  night: {
    bg: '#1D1913', ink: '#F1EBDF', ink2: '#A79E8C', line: '#2A251C',
    accent: '#8FCB6E', focus: '#241F17', soft: '#26331D', hl: '#232E1B',
    wall: 'linear-gradient(155deg, #2b2418 0%, #1b2119 45%, #161b21 100%)',
    cap: 'rgba(241,235,223,.5)'
  }
};

/* ---------- 3. 预览用的课表数据 ----------
   weeks 用真数组（单双周已在 store 里展平），周次覆盖第 5 周；
   「今天」刻意固定成 2026-10-07（周三）——那一天课多、状态齐
   （正在上课 / 后面还有几节 / 明天第一节都有），
   比拿真实的今天（周六，只有一两节）更能把三种状态都显出来。 */
const PREVIEW_TODAY = '2026-10-07';
const PREVIEW_NOW_MIN = 10 * 60 + 20;      // 10:20 —— 正落在第 3-4 节里
const W16 = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
const EVEN16 = W16.filter(w => w % 2 === 0);   // 双周（第 5 周有、第 6 周这类偶数周才有）

const WED = [
  { name: '高等数学A', teacher: '张建国', location: '教三-301', day: 3, start: 1, end: 2, weeks: W16 },
  { name: '计算机组成原理', teacher: '李伟', location: '明理（5）-401', day: 3, start: 3, end: 4, weeks: W16 },
  { name: '形势与政策（五）', teacher: '王芳', location: '文科楼-205', day: 3, start: 5, end: 5, weeks: W16 },
  { name: '软件工程', teacher: '陈静', location: '明理（5）-302', day: 3, start: 7, end: 8, weeks: EVEN16 }
];
const THU = [
  { name: 'Linux系统管理', teacher: '李明', location: '明理（5）-401', day: 4, start: 1, end: 2, weeks: W16 },
  { name: '路由与交换技术', teacher: '刘洋', location: '教二-108', day: 4, start: 3, end: 4, weeks: W16 },
  { name: '德育与班主任工作', teacher: '赵敏', location: '文科楼-301', day: 4, start: 6, end: 7, weeks: W16 }
];

function idOf(c, i) { return 'c' + i; }
const COURSES = WED.concat(THU).map((c, i) => Object.assign({ id: idOf(c, i) }, c));

const SNAPSHOT = {
  version: 2,
  activeId: 'preview',
  prefs: { theme: 'light' },
  schedules: [{
    id: 'preview',
    name: '大三上',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
    courses: COURSES,
    settings: { semesterStart: '2026-08-31', totalWeeks: 18, sections: 12, fixedDuration: true, classDuration: 45 }
  }]
};

/* ---------- 4. 预览页 ---------- */
function buildPage(t) {
  const T = TOKENS[t];
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>桌面小组件预览（${t === 'night' ? '夜晚' : '白天'}）</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Noto Sans SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
    background: ${T.wall};
    -webkit-font-smoothing: antialiased;
  }
  .wrap { padding: 20px 20px 22px; display: flex; flex-direction: column; }
  .cap {
    font-size: 11px; line-height: 1; font-weight: 600; letter-spacing: .4px;
    color: ${T.cap}; margin: 0 0 8px 2px;
  }
  .gap { height: 20px; }

  /* ---- 小组件底板：对应 drawable/widget_bg.xml（圆角 + 1dp 描边）---- */
  .w {
    background: ${T.bg};
    border: 1px solid ${T.line};
    border-radius: 16px;
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  /* ---- 头部：日期（bold / ink）+ 门数（accent）---- */
  .w-head { display: flex; align-items: center; }
  .w-date { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .w-count { white-space: nowrap; color: ${T.accent}; }
  /* ---- 焦点课块：第 1 行课名 + 状态；第 2 行教室 + 上课时间 ---- */
  .w-focus { display: flex; flex-direction: column; }
  .w-frow { display: flex; align-items: center; }
  .w-fname { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .w-fstate { white-space: nowrap; color: ${T.accent}; }
  .w-fsrow { display: flex; align-items: center; }
  /* 教室靠左、可缩；时间靠右、不可缩（与三个布局里的 weight / wrap_content 一致） */
  .w-fplace { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; }
  .w-ftime { white-space: nowrap; color: ${T.accent}; }
  /* ---- 「今天的课已上完」：**通栏、一行高、字居中** ----
     对应三个布局里的 *_done：layout_width=match_parent（⇒ 与课程行同宽，**没有左右 margin**）
     + wrap_content 高 + maxLines=1 + gravity=center。
     它是 flex column 容器（.w / .pane）的直接子项 ⇒ 交叉轴默认 stretch，宽度自动通栏，
     这里**不能再包一层 justify-content:center 的 flex**：那会画出一个真机上不存在的
     居中胶囊，等于拿一张错的图给人看。
     ⚠️ 本文件整个页面是**一条模板字符串**：注释里写 CSS 属性名时**不要用反引号**
     （v1.9.25 / v1.9.26 各栽过一次，报错指着注释里的字，看着完全不像语法问题）。
     要引号就用「」。 */
  .w-done { white-space: nowrap; text-align: center; }
  /* ---- 列表（真机上这里是可滚动的 ListView，预览里按可视高度裁掉多余行）---- */
  .w-list { flex: 1; min-height: 0; overflow: hidden; }
  .r { display: flex; align-items: center; }
  .r-bar { flex: none; border-radius: 1.5px; }
  .r-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .r-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .r-sub  { display: flex; align-items: center; }
  .r-loc  { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; }
  .r-time { white-space: nowrap; margin-left: 5px; color: ${T.accent}; }

  /* ================= 2×2 今日课程（175×155dp）================= */
  .w.today { width: 175px; height: 155px; padding: 10px; }
  .w.today .w-date  { font-size: 12px; font-weight: 700; line-height: 1.2; color: ${T.ink}; }
  .w.today .w-count { font-size: 11px; margin-left: 6px; }
  .w.today .w-focus { margin-top: 6px; padding: 5px 8px; }
  .w.today .w-fname { font-size: 13px; font-weight: 700; line-height: 1.25; }
  .w.today .w-fstate { font-size: 10px; margin-left: 6px; }
  .w.today .w-fplace { font-size: 10px; line-height: 1.4; }
  .w.today .w-ftime { font-size: 10px; margin-left: 6px; }
  .w.today .w-done { margin-top: 6px; font-size: 11px; font-weight: 700; line-height: 1.25; padding: 3px 8px; }
  .w.today .w-list  { margin-top: 4px; }
  .w.today .r       { padding: 3px 0; }
  .w.today .r-bar   { width: 3px; height: 24px; }
  .w.today .r-txt   { margin-left: 7px; }
  .w.today .r-name  { font-size: 11px; line-height: 1.25; color: ${T.ink}; }
  .w.today .r-loc   { font-size: 9px;  line-height: 1.25; color: ${T.ink2}; }
  .w.today .r-time  { font-size: 9px;  line-height: 1.25; }

  /* ================= 4×2 今明日课程（358×155dp）================= */
  .w.twoday { width: 358px; height: 155px; padding: 8px; flex-direction: row; }
  .w.twoday .pane { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .w.twoday .vline { flex: none; width: 1px; margin: 0 8px; background: ${T.line}; }
  .w.twoday .pane { }
  .w.twoday .w-date  { font-size: 11px; font-weight: 700; line-height: 1.2; color: ${T.ink}; }
  .w.twoday .w-count { font-size: 10px; margin-left: 4px; }
  .w.twoday .w-focus { margin-top: 5px; padding: 4px 6px; }
  .w.twoday .w-fname { font-size: 12px; font-weight: 700; line-height: 1.25; }
  .w.twoday .w-fstate { font-size: 9px; margin-left: 4px; }
  .w.twoday .w-fplace { font-size: 9px; line-height: 1.4; }
  .w.twoday .w-ftime { font-size: 9px; margin-left: 4px; }
  .w.twoday .w-done { margin-top: 5px; font-size: 10px; font-weight: 700; line-height: 1.25; padding: 2px 6px; }
  .w.twoday .w-list  { margin-top: 3px; }
  .w.twoday .r       { padding: 3px 0; }
  .w.twoday .r-bar   { width: 3px; height: 24px; }
  .w.twoday .r-txt   { margin-left: 7px; }
  .w.twoday .r-name  { font-size: 11px; line-height: 1.25; color: ${T.ink}; }
  .w.twoday .r-loc   { font-size: 9px;  line-height: 1.25; color: ${T.ink2}; }
  .w.twoday .r-time  { font-size: 9px;  line-height: 1.25; }
</style></head>
<body>
<div class="wrap">
  <p class="cap">2×2 今日课程 · 10:20「正在上课」</p>
  <div class="w today" id="w1"></div>
  <div class="gap"></div>
  <p class="cap">4×2 今明日课程 · 10:20「正在上课」</p>
  <div class="w twoday" id="w2"></div>
  <div class="gap"></div>
  <p class="cap">2×2 今日课程 · 23:00 今天已上完</p>
  <div class="w today" id="w3"></div>
  <div class="gap"></div>
  <p class="cap">4×2 今明日课程 · 23:00 今天已上完</p>
  <div class="w twoday" id="w4"></div>
</div>

<!-- 先把课表塞进 localStorage，再加载 store.js：色值走 Store.courseHex，
     与课表卡片同一套算法（不在预览里手抄色值） -->
<script>localStorage.setItem('schedule_app_v2', ${JSON.stringify(JSON.stringify(SNAPSHOT))});</script>
<script src="js/store.js"></script>
<script>
(function () {
  var T = ${JSON.stringify(TOKENS[t])};
  var TODAY = '${PREVIEW_TODAY}';
  var NOW = ${PREVIEW_NOW_MIN};
  var WEEK_CN = ['周一','周二','周三','周四','周五','周六','周日'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function d(iso) {
    var p = iso.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function plus(iso, n) {
    var x = d(iso); x.setDate(x.getDate() + n); return Store.fmtDate(x);
  }
  /* 与 WidgetRender.dateLabel 同一套（compact = '10/7 周三'） */
  function dateLabel(iso, compact) {
    var x = d(iso), w = WEEK_CN[(x.getDay() + 6) % 7];
    return compact ? (x.getMonth() + 1) + '/' + x.getDate() + ' ' + w
                   : (x.getMonth() + 1) + '月' + x.getDate() + '日 ' + w;
  }
  /* 与 WidgetLogic.focus 同一套规则：正在上的最优先（重叠取开始最晚的），
     否则第一门「开始时间晚于现在」的，都没有则上完了 */
  function toMin(hhmm) {
    var m = /^(\\d{1,2}):(\\d{2})$/.exec(hhmm || '');
    return m ? (+m[1]) * 60 + (+m[2]) : -1;
  }
  function focus(list, nowMin) {
    if (!list.length) return { course: null, phase: 'DONE' };
    if (nowMin >= 0) {
      var cur = null;
      list.forEach(function (c) {
        if (toMin(c.start) <= nowMin && nowMin < toMin(c.end)) {
          if (!cur || toMin(c.start) > toMin(cur.start)) cur = c;
        }
      });
      if (cur) return { course: cur, phase: 'NOW' };
    }
    var next = list.filter(function (c) { return nowMin < 0 || toMin(c.start) > nowMin; })[0];
    if (next) return { course: next, phase: 'NEXT' };
    return { course: null, phase: 'DONE' };
  }

  /* store.js 自己不会加载 —— 真实页面里是 app.js 的 init() 调 Store.load()，
     少这一步 state.schedules 是空的，组件会一路显示「今天没有课」 */
  Store.load();
  var sched = Store.current();

  /* 与 WidgetRender.timeRange 同一套：结束时间算不出来就只给开始时间
     （不拼出「09:55-」这种半截） */
  function timeRange(c) {
    return (toMin(c.end) > toMin(c.start)) ? (c.start + '-' + c.end) : c.start;
  }

  function rowHtml(c, hl) {
    var bg = hl ? T.hl : 'transparent';
    return '<div class="r" style="background:' + bg + '">' +
             '<div class="r-bar" style="background:' + Store.courseHex(c) + '"></div>' +
             '<div class="r-txt">' +
               '<div class="r-name">' + esc(c.name) + '</div>' +
               '<div class="r-sub">' +
                 '<div class="r-loc">' + esc(c.loc || c.teacher) + '</div>' +
                 '<div class="r-time">' + esc(timeRange(c)) + '</div>' +
               '</div>' +
             '</div>' +
           '</div>';
  }

  /* courses = null → 快照没这天；[] → 这天没课；与 bindPanel 的分支一致 */
  function panel(target, dateIso, courses, nowMin, compact) {
    var box = document.getElementById(target);
    var label = dateLabel(dateIso, compact);
    if (!courses || !courses.length) {
      var hint = !courses ? '打开柚课导入课表' : (nowMin < 0 ? '这天没有课' : '今天没有课');
      box.innerHTML =
        '<div class="w-head"><div class="w-date">' + esc(label) + '</div></div>' +
        '<div class="w-list" style="display:flex;align-items:center;justify-content:center;' +
          'color:' + T.ink2 + ';font-size:' + (compact ? 10 : 11) + 'px">' + esc(hint) + '</div>';
      return;
    }
    var f = focus(courses, nowMin);
    var c = f.course;
    /* 与 WidgetRender.bindPanel 的分支一致：有「最近一节课」→ 两行的面板；
       课都上完了 → **通栏、一行高的那一块**（不是把面板留着只写一句话，
       也不是包一层居中壳 —— 宽度靠 flex column 的 stretch 通栏，与课程行同宽）。 */
    var focusHtml;
    if (c) {
      /* 状态词在课名那一行的右侧（原先是拼在第二行开头，把教室挤掉一半）；
         4×2 每栏只有 ~110dp，「明天第一节」太长，缩短成「第一节」（表头写着明天） */
      var state = f.phase === 'NOW' ? '正在上课' : (nowMin < 0 ? '第一节' : '下一节');
      focusHtml =
        '<div class="w-focus" style="background:' + (f.phase === 'NOW' ? T.soft : T.focus) + '">' +
          '<div class="w-frow">' +
            '<div class="w-fname" style="color:' + T.ink + '">' + esc(c.name) + '</div>' +
            '<div class="w-fstate">' + esc(state) + '</div>' +
          '</div>' +
          '<div class="w-fsrow">' +
            '<div class="w-fplace" style="color:' + T.ink2 + '">' + esc(c.loc || '—') + '</div>' +
            '<div class="w-ftime">' + esc(timeRange(c)) + '</div>' +
          '</div>' +
        '</div>';
    } else {
      focusHtml =
        '<div class="w-done" style="background:' + T.focus +
          ';color:' + T.ink + '">今天的课已上完</div>';
    }
    box.innerHTML =
      '<div class="w-head">' +
        '<div class="w-date">' + esc(label) + '</div>' +
        '<div class="w-count">' + courses.length + '门</div>' +
      '</div>' + focusHtml +
      '<div class="w-list">' + courses.map(function (x) {
        return rowHtml(x, c && x.id === c.id);
      }).join('') + '</div>';
  }

  /* --- 2×2：只画今天 --- */
  panel('w1', TODAY, Store.dayCourses(d(TODAY), sched), NOW, false);

  /* --- 4×2：今天（判正在上课）+ 明天（不判，nowMin = -1） --- */
  var box2 = document.getElementById('w2');
  box2.innerHTML =
    '<div class="pane" id="w2a"></div><div class="vline"></div><div class="pane" id="w2b"></div>';
  panel('w2a', TODAY,          Store.dayCourses(d(TODAY),   sched), NOW, true);
  panel('w2b', plus(TODAY, 1), Store.dayCourses(d(plus(TODAY, 1)), sched), -1, true);

  /* --- 「今天的课已上完」态 ---
     把 nowMin 推到当天最后一节之后，就会走到 bindPanel 里「focus.course == null」
     那条分支。这条分支原先**从来没进过预览**，而用户反馈的问题恰好就出在这里
     （最初是复用面板 ⇒ 满宽两行高、字贴左上角；现在是**通栏 + 一行高 + 字居中**）
     —— 一条没人看过的分支，等于没被验过。 */
  var DONE_MIN = 23 * 60;
  panel('w3', TODAY, Store.dayCourses(d(TODAY), sched), DONE_MIN, false);
  var box4 = document.getElementById('w4');
  box4.innerHTML =
    '<div class="pane" id="w4a"></div><div class="vline"></div><div class="pane" id="w4b"></div>';
  panel('w4a', TODAY,          Store.dayCourses(d(TODAY),   sched), DONE_MIN, true);
  panel('w4b', plus(TODAY, 1), Store.dayCourses(d(plus(TODAY, 1)), sched), -1, true);

  /* 教室的省略号要跟真机一致：那边写的是 ellipsize="middle"
     （截尾会正好切掉「401」这种门牌号）。CSS 只有末尾省略号，
     所以这里自己二分一次 —— 保留首尾两段、中间插「…」，直到宽度塞得下。
     不复刻这一步的话，预览图上教室看着是「明理（5）-40…」，
     真机上是「明理…-401」，我等于在拿一张错的图给用户看。 */
  function middleEllipsize(el) {
    var full = el.getAttribute('data-full') || el.textContent;
    el.setAttribute('data-full', full);
    el.textContent = full;
    if (!full.length || el.scrollWidth <= el.clientWidth) return;
    var lo = 1, hi = full.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      var h = Math.ceil(mid / 2), t = mid - h;
      el.textContent = full.slice(0, h) + '…' + (t > 0 ? full.slice(full.length - t) : '');
      if (el.scrollWidth <= el.clientWidth) lo = mid; else hi = mid - 1;
    }
    var h2 = Math.ceil(lo / 2), t2 = lo - h2;
    el.textContent = full.slice(0, h2) + '…' + (t2 > 0 ? full.slice(full.length - t2) : '');
  }
  Array.prototype.forEach.call(
    document.querySelectorAll('.w-fplace, .r-loc'), middleEllipsize
  );
})();
</script>
</body></html>
`;
}

fs.writeFileSync(path.join(outDir, 'widget-light.html'), buildPage('light'));
fs.writeFileSync(path.join(outDir, 'widget-dark.html'), buildPage('night'));

console.log('预览页已生成：');
console.log('  白天  file:///' + path.join(outDir, 'widget-light.html').replace(/\\/g, '/'));
console.log('  夜晚  file:///' + path.join(outDir, 'widget-dark.html').replace(/\\/g, '/'));
