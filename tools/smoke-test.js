/**
 * 渲染冒烟测试：用最小 DOM 桩驱动 app.js 完整跑一遍渲染流程，
 * 验证「顶部信息 + 七列课表 + 课程卡片定位」不抛异常且输出符合预期。
 * 运行： node tools/smoke-test.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.resolve(__dirname, '..');

/* ---------- 「崩了」不能长得像「全绿」 ----------
   出厂代码是**进程级** require 进来的（见下面「驱动渲染」一段）：里面哪怕只有
   一个未定义的函数名，`require` 也会当场抛出，测试进程在打印任何 ✔/✘ 之前就死了。
   而下游只认 `✘` 行 —— 「一个 ✘ 都没有」于是被读成「全绿」。
   （变异验红时真踩到：把 app.js 里的主按钮处理函数改个名，脚本报「一条都没红」。）
   所以挂一个出口哨兵：正常跑完要主动置 finished；没置 = 没跑完，补一条有名字的 ✘。 */
let smokeFinished = false;
process.on('exit', function () {
  if (!smokeFinished) {
    console.log('\n  ✘ 冒烟测试没跑完就退出了（载入出厂代码时抛异常、或进程被杀）'
      + '  -> 上面的通过数不代表全貌，必须当成失败处理');
  }
});

/* 原生源码目录。只在**这一行**出现包名 —— 下次再改包名时，
   [D] 段那几条断言会先指着这里，改一处即可，别在别处再写死一遍
   （v1.9.30 从 com/example/schedule 改成 cn/youke/schedule 时，
   散在三处的旧路径就是靠这条收敛掉的）。 */
const KT_DIR = path.join(root, 'android', 'app', 'src', 'main', 'java', 'cn', 'youke', 'schedule');

/* ---------- 「某所具体学校」的形状判据 ----------
   用来反向断言「出厂内容里再也没有任何一所学校的教务地址」。

   为什么不直接把校名 / 教务处域名写进断言：为了断言「源码里不许出现某校」，
   把校名原样抄进测试文件，这条**判据本身**就成了一份公开记录 —— 闭源上架时
   无所谓，一开源就全在公网上。所以这里只判**形状**，真词表另放
   `tools/privacy-words.local.txt`（已被 .gitignore 排除，见 [C-7] 段）。

   example / xxx / yyy / demo 这类主机名是占位示例（UI 里教用户怎么填），放行。 */
const PLACEHOLDER_HOST = /(^|\.)(example|xxx|yyy|demo|sample|test)\./i;
function realSchoolHosts(src) {
  const hosts = src.match(/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:edu\.cn|ac\.cn|edu)\b/g) || [];
  return hosts.filter(function (h) { return !PLACEHOLDER_HOST.test(h); });
}
/* 剥注释再判 —— 注释里为了说明「本工程不内置任何学校」会提到域名的形状，
   不剥的话断言会被自己那句话绊红（写这一组时真踩到过）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ---------- 最小 DOM 桩 ---------- */
const store = {};
const els = {};

function makeEl(id) {
  const el = {
    id,
    _html: '', _text: '', _attrs: {}, _cls: {},
    /* style 要真的支持自定义属性：app.js 会往节点上 setProperty('--bg', …)，
       早先这里只给了个空对象，一调 setProperty 就 TypeError（而不是断言变红） */
    style: {
      setProperty(k, v) { this[k] = String(v); },
      getPropertyValue(k) { return this[k] === undefined ? '' : this[k]; },
      removeProperty(k) { delete this[k]; }
    },
    classList: {
      add(c) { el._cls[c] = true; },
      remove(c) { delete el._cls[c]; },
      contains(c) { return !!el._cls[c]; }
    },
    addEventListener() {},
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return el._attrs[k] === undefined ? null : el._attrs[k]; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {}, remove() {},
    value: ''
  };
  return el;
}

global.window = global;
global.document = {
  readyState: 'complete',
  documentElement: {
    _attrs: {},
    style: { setProperty() {}, getPropertyValue() { return ''; } },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k] === undefined ? null : this._attrs[k]; }
  },
  getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() { return makeEl('new'); },
  addEventListener() {}
};
/* 模拟 CSS 变量读取：按变量名返回各自的真实值（与 web/css/app.css 对齐）。
   早先这里对所有变量都返回同一个 '56px'，一旦代码新增了别的变量
   （例如卡片留白 --card-pad-x）就会读到错的值，属于 mock 不够真实。 */
const CSS_VARS = {
  '--row-h': '56px',
  '--card-pad-x': '2px', '--card-pad-y': '3px',
  '--col-gap': '3px', '--card-edge-w': '2px'
};
global.getComputedStyle = () => ({ getPropertyValue: k => CSS_VARS[k] || '' });
global.addEventListener = () => {};
global.confirm = () => true;
// 测试环境固定为浅色系统偏好，保证主题断言可重复
global.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, addListener() {} });

/* ---------- 预置课表数据 ---------- */
/* 素材在 tools/fixtures/ —— web/ 是「出厂内容目录」，放任何文件都会被打进 APK */
const csvText = fs.readFileSync(path.join(root, 'tools', 'fixtures', '示例课表.csv'), 'utf8');
const settings = { totalWeeks: 16, sections: 12 };

require(path.join(root, 'web', 'js', 'store.js'));
require(path.join(root, 'web', 'js', 'csv.js'));

const parsed = global.CsvUtil.parse(csvText, settings);
// 模拟「老用户升级」：磁盘上只有 v1 的单课表数据，没有 v2 数据。
// 启动后应自动迁移为一个课表，之后所有读写都走 v2 的 key。
const LEGACY_PAYLOAD = JSON.stringify({
  courses: parsed.courses,
  settings: {
    semesterStart: '2026-09-07', totalWeeks: 16, sections: 12,
    times: global.Store.defaultTimes()
  }
});
global.localStorage = {
  getItem: (k) => (k === global.Store.LEGACY_KEY ? LEGACY_PAYLOAD : (store[k] || null)),
  setItem: (k, v) => { store[k] = v; },
  removeItem: (k) => { delete store[k]; }
};

/* ---------- 驱动渲染 ---------- */
require(path.join(root, 'web', 'js', 'schools.js'));
require(path.join(root, 'web', 'js', 'picker.js'));
/* 适配库两个模块必须在 app.js 之前载入：app.js 在加载那一刻就把它们
   取成了局部变量（`var WH = global.Warehouse`），晚一步就是 undefined。 */
require(path.join(root, 'web', 'js', 'warehouse.js'));
require(path.join(root, 'web', 'js', 'adapter-import.js'));
require(path.join(root, 'web', 'js', 'app.js'));

// 固定在第 1 周渲染，避免断言结果随运行当天日期漂移
const S = global.ScheduleApp.state;
S.viewWeek = 1;
global.ScheduleApp.render();

const html = els.schedule.innerHTML;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✔ ' + name); pass++; }
  else { console.log('  ✘ ' + name + (extra ? '  -> ' + extra : '')); fail++; }
}

console.log('\n[1] 顶部信息栏');
const nowD = new Date();
const expectDate = nowD.getFullYear() + '年' + (nowD.getMonth() + 1) + '月' + nowD.getDate() + '日';
check('显示年月日', els.dateText.textContent === expectDate, els.dateText.textContent);
check('显示星期几', /星期/.test(els.weekdayText.textContent), els.weekdayText.textContent);
check('显示第几周', /第\s*\d+\s*周/.test(els.weekText.textContent), els.weekText.textContent);
check('显示单/双周', /单周|双周/.test(els.parityText.textContent), els.parityText.textContent);

console.log('\n[2] 课表结构');
check('7 个日期表头', (html.match(/class="day-head/g) || []).length === 7, (html.match(/class="day-head/g) || []).length);
check('7 个日期列', (html.match(/class="day-col/g) || []).length === 7, (html.match(/class="day-col/g) || []).length);
check('12 个节次行', (html.match(/class="slot-time"/g) || []).length === 12, (html.match(/class="slot-time"/g) || []).length);
check('星期顺序 一~日', /dw">一</.test(html) && /dw">日</.test(html));

console.log('\n[3] 课程卡片（第 1 周视图）');
const cards = html.match(/class="course"/g) || [];
check('渲染出课程卡片', cards.length > 0, cards.length);
// 15 门中「编译原理(双周)」「Web前端开发(双周)」不在第 1 周 -> 13 门
check('第1周仅单周/全周课程（15门中应为13门）', cards.length === 13, cards.length);
const htmlText = html.replace(/<[^>]+>/g, '');   // 去标签后比对可见文本
check('卡片含课程名', /高等数学A/.test(html));
check('卡片含教室', /教三-301/.test(htmlText), htmlText.slice(0, 120));
check('教室名做了不可断行分组（窄列不拆门牌号）', /class="nb"/.test(html));
check('卡片含周次信息', /1-16/.test(html));
check('卡片使用绝对定位', /top:\d+px;height:\d+px/.test(html));
// 卡片上下留白 = --card-pad-y（3px），去线后相邻两节课全靠它分开
check('2节课卡片高度 = 2*56 - 2*3 = 106px', /height:106px/.test(html));

console.log('\n[4] 单双周过滤');
S.viewWeek = 2;
global.ScheduleApp.render();
const html2 = els.schedule.innerHTML;
const cards2 = (html2.match(/class="course"/g) || []).length;
check('切到第2周后渲染卡片', cards2 > 0, cards2);
check('编译原理（双周）出现在第2周', /编译原理/.test(html2));
check('线性代数（单周）不出现在第2周', !/线性代数/.test(html2));
check('第2周标记为双周', /双周/.test(els.curRangeText.textContent), els.curRangeText.textContent);

console.log('\n[5] Excel 日期化周次还原（真实课表踩坑：1-16 被转成“1月16日”）');
[['1月16日', '1-16'], ['5月8日', '5-8'], ['9月16日', '9-16'], ['1月12日', '1-12'], ['10月16日', '10-16']]
  .forEach(function (pair) {
    var p = Store.parseWeeksExpr(pair[0], 16);
    check(pair[0] + ' -> ' + pair[1], Store.formatWeeks(p.weeks) === pair[1], Store.formatWeeks(p.weeks));
  });

console.log('\n[6] 界面自适应参数');
check('行高可从 CSS 变量读取并参与计算', /style="height:672px"/.test(html) || /height:672px/.test(html));

/* ---------- 界面优化需求（对照图 2 参考设计） ---------- */
const css = fs.readFileSync(path.join(root, 'web', 'css', 'app.css'), 'utf8');
const appjs = fs.readFileSync(path.join(root, 'web', 'js', 'app.js'), 'utf8');
const storejs = fs.readFileSync(path.join(root, 'web', 'js', 'store.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
const kt = fs.readFileSync(path.join(KT_DIR, 'MainActivity.kt'), 'utf8');

console.log('\n[7] 需求1：顶部/底部让出状态栏与导航栏');
check('页面按安全区留白（--safe-top / --safe-bottom）',
  /padding:\s*var\(--safe-top\)/.test(css) && /--safe-bottom/.test(css));
check('安全区支持原生下发', /AndroidSafeArea/.test(appjs) && /AndroidSafeArea/.test(kt));
check('原生不再重复加 padding（避免双重留白）', !/updatePadding/.test(kt));
check('主界面 edge-to-edge 下自己消费 IME insets（否则软键盘直接盖住弹层里的输入框）',
  /WindowInsetsCompat\.Type\.ime\(\)/.test(kt) && /setPadding\(0, 0, 0, ime\)/.test(kt));
check('键盘弹起时底部安全区归零（导航栏已被键盘盖住，别在键盘上方再空一条）',
  /safeBottom = if \(ime > 0\) 0 else/.test(kt));
check('底部渐隐提示不覆盖导航栏', /bottom:\s*var\(--safe-bottom\)/.test(css));

console.log('\n[8] 需求2：一屏最多 8 节，纵向滑动看其余');
check('屏幕节数常量 = 8', /VISIBLE_ROWS\s*=\s*8/.test(appjs));
check('行高按可视高度动态计算', /function fitRows/.test(appjs) && /setProperty\('--row-h'/.test(appjs));
check('课表区域纵向可滚动', /\.grid-wrap\s*\{[^}]*overflow-y:\s*auto/.test(css));

console.log('\n[9] 需求3：周一至周日同屏完整显示，不横向滚动');
check('已移除横向最小宽度约束', !/min-width:\s*396px/.test(css) && !/min-width:\s*640px/.test(css));
check('七列等宽均分', /grid-template-columns:\s*var\(--time-col\)\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/.test(css));
check('课表区域不产生横向滚动', /overflow-x:\s*hidden/.test(css));
check('表头渲染 7 天（一~日）', /dw">一</.test(html) && /dw">日</.test(html));

console.log('\n[10] 需求4：左右滑动切换周次');
check('已绑定指针/触摸滑动', /function bindSwipe/.test(appjs) && /pointerdown/.test(appjs) && /touchstart/.test(appjs));
check('横向手势不与纵向滚动冲突（touch-action: pan-y）', /touch-action:\s*pan-y/.test(css));
check('滑动切周带动画', /slide-from-right/.test(css) && /slide-from-left/.test(css));
check('切周支持边界阻尼', /atEdge/.test(appjs));
check('goWeek 会被调用', /function goWeek/.test(appjs));

console.log('\n[11] 需求5：卡片默认仅显示课名与教室');
check('卡片含课程名与教室/地点', /class="c-name"/.test(html) && /class="c-meta loc"/.test(html));
check('老师与周次默认隐藏', /\.c-meta\.teacher,\s*[\s\S]{0,40}\.c-weeks\s*\{\s*display:\s*none/.test(css));
check('点击卡片弹出完整详情', /function showDetail/.test(appjs) && /maskDetail/.test(htmlSrc));
check('详情包含星期/节次/时间/地点/教师/周次',
  /星期[\s\S]*节次[\s\S]*时间[\s\S]*地点[\s\S]*教师[\s\S]*周次/.test(appjs));

console.log('\n[11a] 课程详情：拖拽关闭 + 编辑 / 复制');
// —— 关闭方式：去掉按钮，改成「向下拖拽」+「点弹层外」 ——
check('详情弹层不再有「关闭」按钮', !/btnDetailClose/.test(htmlSrc) && !/btnDetailClose/.test(appjs));
check('详情弹层顶部有拖拽把手', (htmlSrc.match(/sheet-grip/g) || []).length === 1);
check('拖拽把手有样式', /^\.sheet-grip\s*\{/m.test(css));
check('底部动作是 编辑 / 复制 / 删除',
  /btnDetailEdit[\s\S]*?btnDetailCopy[\s\S]*?btnDetailDelete/.test(htmlSrc));
check('点弹层外的空白处也能关（遮罩点击是遍历，不写死名单）',
  /querySelectorAll\('\.mask'\)/.test(appjs) && /if \(e\.target !== mask\) return;/.test(appjs));

// —— 拖拽的具体判据 ——
check('拖拽只在弹层内容滚到顶部时接管',
  /function bindSheetDrag/.test(appjs) && /sheet\.scrollTop > 0/.test(appjs));
check('touchmove 用 passive:false 才拦得住原生滚动',
  /'touchmove'[\s\S]{0,160}?passive:\s*false/.test(appjs));
check('按位移或速度判定关闭', /h \* 0\.25/.test(appjs) && /vel > 0\.5/.test(appjs));
check('没拖够会回弹', /resetSheetInline\(sheet, true\)/.test(appjs));
check('拖完吃掉补发的 click（否则落点压在卡片上会立刻又弹详情）',
  /function killClick/.test(appjs) && /addEventListener\('click', swallowClick, true\)/.test(appjs));
check('拖拽只绑在详情弹层上（其他弹层有输入框，手势会打架）',
  (appjs.match(/bindSheetDrag\(/g) || []).length === 2 && /bindSheetDrag\('maskDetail'\)/.test(appjs));
check('详情里也能用鼠标拖（桌面浏览器 / 调试）', /'mousedown'/.test(appjs) && /'mousemove'/.test(appjs));

// —— 复制 ——
check('复制弹层有两个选项：完整课程 / 课程名称',
  /btnCopyFull/.test(htmlSrc) && /btnCopyName/.test(htmlSrc) &&
  /复制完整课程/.test(htmlSrc) && /复制课程名称/.test(htmlSrc));
check('复制走三层兜底（原生桥 / execCommand / clipboard API）',
  /AndroidClipboard/.test(appjs) && /execCommand\('copy'\)/.test(appjs) &&
  /navigator\.clipboard\.writeText/.test(appjs));
check('完整课程文本带上时间/地点/教师/周次',
  /function courseFullText/.test(appjs) && /'时间：星期'/.test(appjs) &&
  /'地点：'/.test(appjs) && /'教师：'/.test(appjs) && /'周次：'/.test(appjs));
check('复制菜单收起后回到课程详情（取消 / 点外部 / 复制完都一样）',
  /function backToDetail/.test(appjs) && /btnCopyCancel'\)\.addEventListener\('click', backToDetail\)/.test(appjs));
check('打开复制菜单前先收掉详情（弹层不叠）',
  /closeMask\('maskDetail'\);\s*\n\s*openMask\('maskCopy'\)/.test(appjs));

// —— 编辑：复用「添加课程」表单 ——
check('「添加课程」弹层的标题可切换', /id="addTitle"/.test(htmlSrc));
check('编辑模式切标题与按钮文案',
  /function openCourseForm/.test(appjs) &&
  /'编辑课程'/.test(appjs) && /'保存修改'/.test(appjs));
check('编辑模式预填课程信息', /addWeeks'\)\.value = c\.weeksText/.test(appjs) &&
  /addTeacher'\)\.value = c\.teacher/.test(appjs) && /addLocation'\)\.value = c\.location/.test(appjs));
check('编辑是就地改这门课，不是新增一门',
  /if \(editId\)[\s\S]{0,900}?findCourse\(editId\)/.test(appjs) &&
  /fields\.id = Store\.uid\(\);[\s\S]{0,60}S\.courses\.push\(fields\)/.test(appjs));
check('保存后退出编辑模式，下次点「＋」回到添加',
  /function clearCourseForm/.test(appjs) && /function exitEditMode/.test(appjs));
check('改完落库并重排课表', /Store\.save\(\); render\(\); closeMask\('maskAdd'\); clearCourseForm\(\)/.test(appjs));

console.log('\n[11b] 界面美化：去除表格线条 + 统一底色');
// —— 去线：横线（时间列行分隔、天列背景条纹）与竖线（列分隔）全部移除 ——
check('天列不再有竖分隔线', !/\.day-col\s*\{[^}]*border-right/.test(css));
check('天列不再有横条纹线（repeating-linear-gradient）',
  !/\.day-col\s*\{[^}]*repeating-linear-gradient/.test(css));
check('表头不再有下边线', !/\.head-row\s*\{[^}]*border-bottom/.test(css));
check('表头不再有竖分隔线', !/\.day-head\s*\{[^}]*border-right/.test(css));
check('时间列不再有竖线', !/\.time-col\s*\{[^}]*border-right/.test(css));
check('节次行不再有横线', !/\.slot-time\s*\{[^}]*border-bottom/.test(css));

// —— 底色统一：整块底面只为一块，不再由各列各画一块拼起来 ——
check('整块底面统一由 .schedule 铺 --surface 并收圆角',
  /^\.schedule\s*\{[^}]*background:\s*var\(--surface\)/m.test(css) &&
  /^\.schedule\s*\{[^}]*border-radius:\s*var\(--radius\)/m.test(css));
check('天列自身不再画底色（列与列交界处不会有接缝）',
  !/^\.day-col\s*\{[^}]*background/m.test(css));
check('周末不再有独立底色（与工作日一致）', !/is-weekend\s*\{[^}]*background/.test(css));
check('今天不再有独立列底色（位置改由表头的高亮块标识）',
  !/\.day-col\.is-today\s*\{[^}]*background/.test(css));
check('表头周末文字不再弱化（七天视觉平权）', !/\.day-head\.is-weekend/.test(css));

// —— 表头「今天」的日期高亮块：圆角矩形（v1.9.10）——
// 原来是个 20×20 的圆点，但日期文字「10/2」宽 22.66px —— 按尺寸定宽而不是按内容，
// 文字就从右侧支出去一截（端到端量到溢出 2.66px）。这几条钉的是「矩形 + 宽度自适应」。
const todayDD = (css.match(/\.day-head\.is-today \.dd\s*\{[^}]*\}/) || [''])[0];
check('「今天」的日期块是圆角矩形，不再用 border-radius: 50% 画成圆',
  todayDD.length > 0 && !/border-radius:\s*50%/.test(todayDD) &&
  /border-radius:\s*5px/.test(todayDD) &&
  /* 注意别写成 /\bwidth:\s*\d/：`\b` 在 `min-width` 的连字符后面也算词边界，
     会把 min-width 误判成「写死了固定宽度」。 */
  !/[;{\s]width:\s*\d/.test(todayDD),
  todayDD.replace(/\s+/g, ' ').slice(0, 120));
check('日期块的宽度跟着文字走（width: fit-content + 左右 padding），不再写死 px',
  /width:\s*fit-content/.test(todayDD) && /padding:\s*0 4px/.test(todayDD),
  (todayDD.match(/width:[^;]+/) || [''])[0] + ' / ' + (todayDD.match(/padding:[^;]+/) || [''])[0]);
check('有 min-width 兜底：最短的日期（9/1，约 16.8px）也不会缩成方块',
  /min-width:\s*26px/.test(todayDD),
  (todayDD.match(/min-width:[^;]+/) || [''])[0]);
check('日期块的高与行高一致（18px），文字在块里垂直居中',
  /height:\s*18px/.test(todayDD) && /line-height:\s*18px/.test(todayDD));
check('时间列不再另用 --surface-2 底色', !/\.time-col\s*\{[^}]*var\(--surface-2\)/.test(css));
check('时间列与左上角透明，露出同一块底面',
  /\.time-col\s*\{[^}]*background:\s*transparent/.test(css) &&
  /\.corner\s*\{[^}]*background:\s*transparent/.test(css));
check('各列自身不再收圆角（圆角只保留在整块底面的外缘）',
  !/^\.day-col\s*\{[^}]*border-radius/m.test(css) &&
  !/^\.time-col\s*\{[^}]*border-radius/m.test(css));

// —— 去线后靠留白表达结构：列间距 + 卡片留白 ——
/* v1.9.11：相邻卡片之间必须留得下一条**看得见的缝**。
   卡片内缩出来的那点留白，会被相邻两条**向外扩**的包边各吃掉 edge-w，
   所以真正决定观感的是这个减法，不是「CSS 里写了 3px」：
       横向净缝 = --col-gap + 2×--card-pad-x − 2×--card-edge-w
       纵向净缝 =           2×--card-pad-y − 2×--card-edge-w
   v1.9.10 及以前横向恰好 0 + 4 − 4 = 0，两条包边严丝合缝贴成一条 4px 粗线
   ——用户看到的就是「描边重合、中间没有缝隙」。这两条断言钉的就是它。 */
const cssNum = (name) =>
  parseFloat((css.match(new RegExp(name + ':\\s*(-?[\\d.]+)px')) || [])[1]);
const EDGE_W = cssNum('--card-edge-w'), COL_GAP = cssNum('--col-gap');
const PAD_X = cssNum('--card-pad-x'), PAD_Y = cssNum('--card-pad-y');
const gapX = COL_GAP + 2 * PAD_X - 2 * EDGE_W;
const gapY = 2 * PAD_Y - 2 * EDGE_W;
check('四个间距量都读到了真值（哨兵：防止下面几条因正则失配而假绿）',
  [EDGE_W, COL_GAP, PAD_X, PAD_Y].every((n) => !isNaN(n)),
  'edge-w=' + EDGE_W + ' col-gap=' + COL_GAP + ' pad-x=' + PAD_X + ' pad-y=' + PAD_Y);
check('相邻两天的卡片之间有净缝（列间距 + 两侧留白 − 两条外扩包边 ≥ 2px）',
  gapX >= 2, gapX + 'px = ' + COL_GAP + ' + 2×' + PAD_X + ' − 2×' + EDGE_W);
check('同一列里上下相邻的两节课之间也有净缝（v1.9.10 及以前是 0，两节课粘连成一条）',
  gapY >= 1.5, gapY + 'px = 2×' + PAD_Y + ' − 2×' + EDGE_W);
check('留白横纵分开声明（横向参与列缝的宽度，纵向单独管行缝）',
  /--card-pad-x:\s*[\d.]+px/.test(css) && /--card-pad-y:\s*[\d.]+px/.test(css));
check('表头与主体共用同一个 --col-gap（列严格对齐）',
  /\.head-row\s*\{[^}]*column-gap:\s*var\(--col-gap\)/.test(css) &&
  /\.body\s*\{[^}]*column-gap:\s*var\(--col-gap\)/.test(css));
check('表头底色与整块底面同色（吸顶无接缝，且遮得住滚上来的卡片）',
  /\.head-row\s*\{[^}]*background:\s*var\(--surface\)/.test(css));
check('底部渐隐层用底面底色（不在整块底面上横出灰带）',
  /\.scroll-fade\s*\{[^}]*linear-gradient\(to top,\s*var\(--surface\)/.test(css));
check('卡片留白由 CSS 变量统一给出，代码里不再各写一份',
  /function cardPadX/.test(appjs) && /function cardPadY/.test(appjs) &&
  /cssPx\('--card-pad-x'/.test(appjs) && /cssPx\('--card-pad-y'/.test(appjs));
check('纵向留白走 top/height、横向走 left/width（两条分支各读各的变量）',
  /var top = \(c\.start - 1\) \* rh \+ padY/.test(appjs) &&
  /var h = span \* rh - padY \* 2/.test(appjs) &&
  /_l \+ '% \+ ' \+ padX/.test(appjs) &&
  /_w \+ '% - ' \+ \(padX \* 2\)/.test(appjs));

console.log('\n[11c] 弹层退出路径：子弹层退回父层，且不再有手写名单');
/* 回归 v1.8.3 埋下的缺口：「打开教务系统」那一层没被写进关闭名单，
   于是它的返回键与「点弹层外」双双失效——返回键还是被原生当成
   「已消费」吞掉的，按下去毫无反应。
   修法不是补一个字符串，而是把「手写名单」这个病根换掉。 */
const maskIds = (htmlSrc.match(/class="mask[^"]*"\s+id="(\w+)"/g) || [])
  .map(function (s) { return s.match(/id="(\w+)"/)[1]; });
check('页面上 15 层弹层都数出来了（哨兵：防止下面两条断言因正则失配而假绿）',
  maskIds.length === 15, maskIds.join(','));
check('「全关」不再写死名单，改为遍历现存的 .mask.show',
  /querySelectorAll\('\.mask\.show'\)/.test(appjs) &&
  !/'maskSched', 'maskCopy'\]/.test(appjs));
check('点弹层外也不写死名单，遍历每一个 .mask',
  /forEach\.call\(document\.querySelectorAll\('\.mask'\), function \(mask\)/.test(appjs));
check('子弹层退回父层的对应关系集中在一张表里（加新层只需加一行）',
  /var BULLET_BACK = \{/.test(appjs) &&
  /maskCopy: backToDetail/.test(appjs) && /maskSchool: backToImport/.test(appjs));
check('「打开教务系统」三个出口都走同一条路（关闭按钮 / 点外部 / 返回键）',
  /function backToImport/.test(appjs) &&
  /btnSchoolClose'\)\.addEventListener\('click', backToImport\)/.test(appjs) &&
  /if \(back\) back\(\); else closeMask\(mask\.id\)/.test(appjs));
check('退回导入弹层而不是直接扔回课表（上下文不丢）',
  /function backToImport\(\)[\s\S]{0,300}?closeMask\('maskSchool'\);[\s\S]{0,60}?openMask\('maskImport'\)/.test(appjs));
check('返回键：先处理子弹层，剩下的才整层关闭',
  /function handleBack/.test(appjs) &&
  /BULLET_BACK\[open\[i\]\.id\][\s\S]{0,60}?return true;/.test(appjs) &&
  /if \(open\.length\) \{ closeAllMasks\(\); return true; \}/.test(appjs));
check('网页把 handleBack 暴露给原生', /global\.handleBack = handleBack/.test(appjs));
check('原生返回键改为调 handleBack（不再自己猜层级）',
  /window\.handleBack&&window\.handleBack\(\)===true/.test(kt) && !/closeAllMasks/.test(kt));
check('页面异常时返回键不会失灵（handleBack 缺失就返回 false，交给系统）',
  /return !!\(window\.handleBack&&/.test(kt));

console.log('\n[11e] 自绘选择器：原生控件的弹层够不着主题，只能自己画');
/* v1.9.15：<select>、<input type="date">、<input type="time"> 点下去弹出来的
   那一层是浏览器 / 系统画的，皮肤取自 Activity 的主题（本工程在 values-night
   里把 Activity 换成了深色 Material），而应用自己的白天 / 夜晚是页面按
   localStorage 定的 —— 两者可以不一致，于是出现「页面是白天暖色、弹层是
   一块冷灰」。CSS 改不动它，所以四处全部换成自绘。
   下面这几条就是把这件事钉住：一旦有人图省事把原生控件加回来，这里会红。 */
const pickerjs = fs.readFileSync(path.join(root, 'web', 'js', 'picker.js'), 'utf8');
/* 注释里会出现 <select> 这类字样（说明历史），断言之前先把 HTML 注释剥掉，
   免得「已经没有原生控件了」这条被自己写的注释绊红。 */
const htmlNoComment = htmlSrc.replace(/<!--[\s\S]*?-->/g, '');
const wheelH = (/var WHEEL_H = (\d+);/.exec(pickerjs) || [])[1];
const wheelVis = (/var WHEEL_VIS = (\d+);/.exec(pickerjs) || [])[1];

check('页面里已经没有原生 picker 了（select / input[type=date] / input[type=time] 全数换掉）',
  !/<\s*select[\s>]/.test(htmlNoComment) &&
  !/type="date"/.test(htmlNoComment) && !/type="time"/.test(htmlNoComment));
check('「星期」「导入到哪个课表」「每节课时长」仍是 id 留在控件上（值走 .value）',
  /id="addDay"[^>]*value="1"/.test(htmlNoComment) &&
  /id="importTarget"/.test(htmlNoComment) && /id="ttDur"/.test(htmlNoComment));
check('时间格改成 button（原生 input[type=time] 一点就弹系统表盘 + 系统键盘）',
  /function timeInput[\s\S]{0,260}?createElement\('button'\)/.test(appjs) &&
  /el\.className = 'tp'/.test(appjs) &&
  /function setTimeBtn[\s\S]{0,120}?el\.textContent = v/.test(appjs));
check('picker.js 在 app.js 之前引入（app.js 的 bind() 里要用 Picker）',
  /src="js\/picker\.js"/.test(htmlSrc) &&
  htmlSrc.indexOf('js/picker.js') < htmlSrc.indexOf('js/app.js'));
check('三件控件都暴露出来了',
  !!(global.Picker && typeof global.Picker.list === 'function' &&
    typeof global.Picker.date === 'function' && typeof global.Picker.time === 'function'));
check('三层弹层的构件齐了',
  ['maskPick', 'maskDate', 'maskTime', 'pickList', 'pickCancel',
    'calPrev', 'calNext', 'calGrid', 'calSave', 'calCancel',
    'whlHour', 'whlMin', 'timeSave', 'timeCancel']
    .every(function (id) { return new RegExp('id="' + id + '"').test(htmlNoComment); }));
check('三层都登记进 BULLET_BACK（漏一层，返回键就会把人直接掀回课表）',
  /maskPick: backFromPick/.test(appjs) && /maskDate: backFromDate/.test(appjs) &&
  /maskTime: backFromTime/.test(appjs));
check('同一层三个出口共用同一份实现（取消按钮 / 返回键 / 点弹层外）',
  /function backFromPick/.test(appjs) && /onCancel: backFromPick/.test(appjs) &&
  /function backFromDate/.test(appjs) && /onCancel: backFromDate/.test(appjs) &&
  /function backFromTime/.test(appjs) && /onCancel: backFromTime/.test(appjs));
/* 滚轮项高是「JS 常量」与「CSS 高度」两处各写一次的数字。漂移之后错得很安静：
   选中值整体差一格，看上去还挺正常。这类两处必须一致的数字就得钉死。 */
check('滚轮项高：picker.js 的 WHEEL_H 与 .whl-i 的高度逐值一致',
  !!wheelH && new RegExp('\\.whl-i\\s*\\{[^}]*height:\\s*' + wheelH + 'px').test(css),
  'WHEEL_H=' + wheelH);
check('滚轮窗口高度与可见行数对得上（5 行 × 40px，垫片高度由它们推出来）',
  wheelVis === '5' &&
  new RegExp('\\.whl\\s*\\{[^}]*height:\\s*' + (Number(wheelH) * Number(wheelVis)) + 'px').test(css) &&
  new RegExp('\\.whl-pad\\s*\\{[^}]*height:\\s*' +
    (Number(wheelH) * (Number(wheelVis) - 1) / 2) + 'px').test(css));
check('月历固定 6 行 42 格（翻月时弹层高度不会跳一下）', /i < 42/.test(pickerjs));
check('日期与时间的算术一律借 store.js，没在 picker.js 里再造一份',
  /Store\.fmtDate/.test(pickerjs) && /Store\.parseDate/.test(pickerjs) &&
  /Store\.timeToMin/.test(pickerjs));

/* 三件套用 DOM 桩真跑一遍。桩里没有布局，所以不测长相，只测
   「调用链不炸 + 生成的 HTML 结构对」——这类错单看正则看不出来。 */
global.Picker.list({
  title: '每节课时长',
  value: '45',
  items: [{ v: '45', t: '45 分钟' }, { v: '50', t: '50 分钟' }],
  onPick: function () {}
});
check('单选列表：每一行都画出来了，当前值那行带 is-on（对勾靠它显示）',
  /class="pick-row is-on" data-v="45"/.test(els.pickList.innerHTML) &&
  /data-v="50"/.test(els.pickList.innerHTML) &&
  els.pickTitle.textContent === '每节课时长', els.pickTitle.textContent);

global.Picker.date({ value: '2026-08-31', note: function () { return 'x'; } });
check('月历：标题落在选中那天所在的月份',
  els.calTitle.textContent === '2026 年 8 月', els.calTitle.textContent);
check('月历：42 个日子都在，选中那天带 is-on，且 data-d 是标准 ISO',
  (els.calGrid.innerHTML.match(/data-d="/g) || []).length === 42 &&
  /class="cal-d is-on" data-d="2026-08-31"/.test(els.calGrid.innerHTML));
check('月历：选中那天显示成「8月31日 · 星期一」（星期名取自 store.js，不另存一份）',
  els.calPicked.textContent === '8月31日' && els.calPickedWd.textContent === '星期一',
  els.calPicked.textContent + ' / ' + els.calPickedWd.textContent);

global.Picker.time({ value: '08:45', title: '第 1 节课开始时间' });
/* 桩里没有布局（querySelector 全返回 null），所以这里不测 is-on 那个类名 ——
   只测「内容对不对」与「算出来的滚动位置对不对」。08:45 → 第 8 项 / 第 45 项，
   偏移 = 下标 × WHEEL_H：这条正好把「时间 → 下标 → 像素」整条换算盯住，
   而 WHEEL_H 与 CSS 漂移时最先坏的就是它。（类名与像素交给 e2e 真浏览器测。） */
check('滚轮：时 24 项、分 60 项，当前值换算出的下标与滚动位置都对',
  (els.whlHour.innerHTML.match(/data-i="/g) || []).length === 24 &&
  (els.whlMin.innerHTML.match(/data-i="/g) || []).length === 60 &&
  els.whlHour._on === 8 && els.whlMin._on === 45 &&
  els.whlHour.scrollTop === 8 * global.Picker.WHEEL_H &&
  els.whlMin.scrollTop === 45 * global.Picker.WHEEL_H,
  els.whlHour._on + '/' + els.whlMin._on + ' @' + els.whlHour.scrollTop + '/' + els.whlMin.scrollTop);
check('滚轮：上方读数跟着当前值走',
  els.timeBig.textContent === '08:45', els.timeBig.textContent);
check('滚轮：认不出的时间落到 08:00（不猜 00:00，那会让课表看起来像半夜上课）',
  (function () {
    global.Picker.time({ value: '哦', title: 'x' });
    return els.whlHour._on === 8 && els.whlMin._on === 0 && els.timeBig.textContent === '08:00';
  })(), els.timeBig.textContent);

console.log('\n[11f] 分享课表 + 自绘确认框（v1.9.20）');
/* ---------------------------------------------------------------
   A. 分享按钮落位：顶栏第三格让给「分享」，白天 / 夜晚开关挪到周次栏最右
   --------------------------------------------------------------- */
/* 只截「顶栏那一排」和「周次栏那一行」两段来数，避免整页正则失配后假绿。 */
/* 剥掉注释再断言：注释里会成段出现「window.confirm」「WRITE_EXTERNAL_STORAGE」
   这类字样（那正是在说明「为什么不用它」），不剥掉就会被自己写的解释绊红 ——
   和上面 HTML 那处是同一个坑。只剥行首的 // ，免得把 'https://' 也啃掉。 */
const appjsNoComment = appjs
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* Kotlin 那份**不能用一条正则剥**。
   源码里有 HTTP 请求头那一行 `setRequestProperty("Accept", …)`，值是个
   通配串，写法正好是「星号、斜杠、星号」。在一条块注释正则的眼里，
   里面那个「斜杠 + 星号」就是「块注释开始」，于是它一路吃到后面第一个
   「星号 + 斜杠」。实测被吃掉的量：
   EduLoginActivity 85352 → 57760（丢 27.6 KB）、MainActivity 34505 → 21151（丢 13.4 KB）。
   后果不是报错，是**那一整段里的断言全部变成「在一个空字符串上找东西」**——
   全绿，而且永远绿（「不许出现 removeJavascriptInterface」这类反向断言
   在空串上必然成立）。
   ⇒ 这里老老实实扫一遍：字符串（含 Kotlin 三引号原始串）、字符、行注释、
     块注释四种状态。注释丢掉，其余原样保留（换行也留着，别把行结构压掉）。 */
function stripKtComments(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '"' && src.slice(i, i + 3) === '"""') {
      const end = src.indexOf('"""', i + 3);
      const stop = end < 0 ? n : end + 3;
      out += src.slice(i, stop); i = stop; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        j++;
      }
      out += src.slice(i, j); i = j; continue;
    }
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      i = j; continue;                        // 只丢注释本身，换行留给下一轮
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2; continue;
    }
    out += c; i++;
  }
  return out;
}
/* 哨兵：剥离既不能吃掉代码，也不能**留下**该丢的注释。
   判据一：字符串字面量里的「星号 斜杠 星号」必须原样活着 ——
   它正是上面那个正则翻车的原因，也是一条能立刻验红的标尺。
   判据二：结果必须比老正则更长（老正则少剥了 4 万字符，方向不能反过来）。 */
function ktStripped(src, tag) {
  const nc = stripKtComments(src);
  const naive = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('剥注释：字符串里的通配串没被当成注释吃掉（' + tag + '）',
    nc.indexOf('*/*') >= 0 && nc.length > naive.length,
    src.length + ' → ' + nc.length + '（一条正则那种剥法会剥成 ' + naive.length + '）');
  check('剥注释没有吃掉代码（' + tag + '）',
    nc.length > src.length * 0.6 && nc.indexOf('fun ') > 0,
    src.length + ' → ' + nc.length);
  return nc;
}
const ktNoComment = ktStripped(kt, 'MainActivity.kt');

const tbBlock = (/<div class="tb-actions">([\s\S]*?)<\/div>/.exec(htmlNoComment) || [])[1] || '';
const weekbarBlock = (/<nav class="weekbar">([\s\S]*?)<\/nav>/.exec(htmlNoComment) || [])[1] || '';
check('顶栏那一排被正确切出来了（哨兵：切不出来下面两条会假绿）',
  tbBlock.length > 0 && weekbarBlock.length > 0,
  tbBlock.length + ' / ' + weekbarBlock.length);
check('顶栏改成「导入 / 添加 / 分享 / 设置」，主题开关已经让位',
  /id="btnShare"/.test(tbBlock) && !/id="btnTheme"/.test(tbBlock));
check('白天 / 夜晚开关落到周次栏、在「本周」按钮右侧',
  weekbarBlock.indexOf('id="btnToday"') >= 0 &&
  weekbarBlock.indexOf('id="btnTheme"') > weekbarBlock.indexOf('id="btnToday"'));
check('挪位置没把月亮 / 太阳的状态切换丢掉',
  /#btnTheme \.ic-sun \{ display: none; \}/.test(css) &&
  /:root\[data-theme="dark"\] #btnTheme \.ic-sun \{ display: block; \}/.test(css));
check('周次栏里的主题按钮收小一号（与 ‹ › 两个按钮齐平，不撑高这一行）',
  /\.weekbar \.icon-btn\s*\{[^}]*width:\s*30px/.test(css) &&
  /\.weekbar \.icon-btn\s*\{[^}]*height:\s*30px/.test(css));
check('设置页那句提示已经指向新位置（别再把人指去顶栏）',
  /周次栏最右边的月亮/.test(htmlNoComment) && !/顶栏右侧的月亮/.test(htmlNoComment));

/* ---------------------------------------------------------------
   B. 分享弹层：两个选项 + 出口。它是从顶栏直接开的**根层**，
      不是子弹层 —— 没有父层可退，所以不该登记进 BULLET_BACK。
   --------------------------------------------------------------- */
check('分享弹层的构件齐了（标题 / 说明 / 两个选项 / 取消）',
  ['maskShare', 'btnShare', 'btnShareCopy', 'btnShareCsv', 'btnShareCancel',
    'shareWhich', 'shareSummary']
    .every(function (id) { return new RegExp('id="' + id + '"').test(htmlNoComment); }));
check('分享层不是子弹层（根层，返回键直接整层关掉才是对的）',
  /btnShareCancel'\)\.addEventListener\('click', function \(\) \{ closeMask\('maskShare'\)/.test(appjs) &&
  !/maskShare:/.test(appjs));
check('分享入口绑的是打开分享弹层（不是绑到别的按钮上）',
  /\$\('btnShare'\)\.addEventListener\('click', openShareSheet\)/.test(appjs) &&
  /function openShareSheet/.test(appjs));

/* ---------------------------------------------------------------
   C. CSV 的列序必须与导入端同一口径
      —— 「分享出去的文件导不回来」这种事，单看哪一端都发现不了
         （两端各自都自洽），所以这条得跨端对账：真导一遍。
   --------------------------------------------------------------- */
check('CSV 表头与导入端的 A→G 列序逐字一致',
  /\['课程名称', '星期', '开始节数', '结束节数', '老师', '地点', '周数'\]/.test(appjs));
check('CSV 开头带 BOM（不然 Excel 双击打开中文是乱码）',
  /'\\uFEFF' \+ rows\.map/.test(appjs));
check('CSV 字段做了逗号 / 引号转义（地点里带逗号时不会把列挤歪）',
  /function csvField/.test(appjs) && /replace\(\/"\/g, '\"\"'\)/.test(appjs));

const csvOut = global.ScheduleApp.scheduleCsvText();
const csvBack = global.CsvUtil.parse(csvOut, S.settings);
const keyOf = function (c) {
  return c.day + '|' + c.start + '|' + c.end + '|' + c.name + '|' + c.location + '|' + c.teacher;
};
const keyBefore = S.courses.map(keyOf).sort();
const keyAfter = csvBack.courses.map(keyOf).sort();
check('导出的 CSV 用真解析器吃回来，一门课不多不少（' + keyBefore.length + ' 门）',
  csvBack.courses.length === S.courses.length &&
  keyAfter.every(function (k, i) { return k === keyBefore[i]; }),
  keyBefore.length + ' -> ' + csvBack.courses.length + '，错误 ' + csvBack.errors.length + ' 条');
check('周次也原样回来（含「1-16 单」「2-16 双」「1,4,8,12」这些写法）',
  S.courses.every(function (c, i) {
    const back = csvBack.courses.filter(function (b) { return keyOf(b) === keyOf(c); })[0];
    if (!back) return false;
    return String(back.weeks.slice().sort(function (a, b) { return a - b; })) ===
      String(c.weeks.slice().sort(function (a, b) { return a - b; }));
  }));
check('CSV 里 7 列都有对：表头 1 行 + N 门课各 1 行',
  csvOut.split('\r\n').filter(function (l) { return l.trim() !== ''; }).length ===
  S.courses.length + 1,
  csvOut.split('\r\n').length);

/* 分享文字：按星期分组，条数必须与实际课程数一致（分组写漏一天就少几条） */
const shareTxt = global.ScheduleApp.scheduleShareText();
check('分享文字里每门课一行，条数与实际课程数一致',
  (shareTxt.match(/^ {2}第 /gm) || []).length === S.courses.length,
  (shareTxt.match(/^ {2}第 /gm) || []).length + ' / ' + S.courses.length);
check('分享文字里每门课的课名都在（分组不能吃掉任何一天）',
  S.courses.every(function (c) { return shareTxt.indexOf(c.name) >= 0; }));
check('分享文字按星期分组（星期一…星期日都在，顺序也是这个顺序）',
  (function () {
    let last = -1;
    for (let d = 1; d <= 7; d++) {
      const at = shareTxt.indexOf(global.Store.WEEKDAY_CN[d % 7]);
      if (at < 0) continue;
      if (at < last) return false;
      last = at;
    }
    return last >= 0;
  })());
check('空课表不崩、也不吐一段空白（给一句实话代替课表）',
  (function () {
    const keep = S.courses;
    S.courses = [];
    let t = '';
    try { t = global.ScheduleApp.scheduleShareText(); } finally { S.courses = keep; }
    return /还没有课程/.test(t) && t.indexOf('undefined') < 0;
  })());

/* ---------------------------------------------------------------
   D. 保存 CSV 的落盘路径
   --------------------------------------------------------------- */
/* 这里的 \b 不能省：AndroidExports 也包含 AndroidExport 这段子串，
   不锚边界的话「桥名多打一个字母」这种最典型的错反而照样绿。 */
check('保存文件的原生桥名 JS 与 Kotlin 一致（差一个字母就静默失效）',
  /global\.AndroidExport\b/.test(appjs) && /"AndroidExport"/.test(kt) &&
  /fun saveFile\(/.test(kt));
check('三条路按「能不能真落盘」排序：原生桥 → Blob → 如实说存不了',
  /function shareByCsv[\s\S]{0,1200}?AndroidExport\b[\s\S]{0,900}?saveViaBlob[\s\S]{0,400}?存不了文件/
    .test(appjs));
check('桌面上退回 Blob + <a download>（电脑浏览器里直接打开网页时用）',
  /function saveViaBlob/.test(appjs) && /new Blob\(\[text\]/.test(appjs) &&
  /a\.download = fileName/.test(appjs));
check('Android 10+ 走 MediaStore 写进「下载」，不碰公共存储目录',
  /MediaStore\.Downloads/.test(kt) && /MediaStore\.Downloads\.IS_PENDING/.test(kt) &&
  /RELATIVE_PATH, Environment\.DIRECTORY_DOWNLOADS/.test(kt));
check('Android 9 及以下退回应用自己的外部目录（同样不需要权限）',
  /getExternalFilesDir\(Environment\.DIRECTORY_DOWNLOADS\)/.test(kt) &&
  /fun saveToAppDir/.test(kt));
check('保存文件不申请任何存储权限（权限清单仍是干净的「只有 INTERNET」）',
  !/WRITE_EXTERNAL_STORAGE/.test(ktNoComment) &&
  !/requestPermissions/.test(ktNoComment) &&
  !/getExternalStoragePublicDirectory/.test(ktNoComment));
/* 文件名里的斜杠 / 冒号必须剃掉，否则写入直接失败（而且报错很难懂） */
check('文件名会剃掉不能进文件的那些字符',
  /replace\(\/\[\\\\\/:\*"<>|\\s\]\+\/g, '_'\)/.test(appjs));
/* 写盘失败要如实说，不能默默啥也不干让用户以为存好了 */
check('落盘失败 / 存不了时都给一句实话，不假装成功',
  /保存失败：/.test(appjs) && /这个环境存不了文件/.test(appjs));

/* ---------------------------------------------------------------
   D2. 发送到聊天：把课表当文件发给同学（v1.9.21）

   「保存为 CSV」解决的是「手上有个文件」，但用户的下一步通常是「现在就发给
   同学」——存完让用户自己进文件管理器翻、再长按分享，等于把最后一公里丢回
   给用户。这一段钉住四件事：
     · 转发层是**子弹层**（能退回分享层，不是一路掀回课表）；
     · 发的是一份**真文件**（content:// + ACTION_SEND），不是一段被压扁的文字；
     · 定向三个应用时，包名三处（JS 的 key / Kotlin 的映射 / Manifest 的声明）对得上；
     · 最要紧的一条 —— **权限清单没有因此变脏**。
   --------------------------------------------------------------- */
const manifestShare = fs.readFileSync(
  path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');

check('转发层的构件齐了（说明 / 三个定向 / 其他应用 / 取消）',
  ['maskSendTo', 'sendToWhat', 'sendToHint', 'btnSendWechat', 'btnSendQQ',
    'btnSendDing', 'btnSendMore', 'btnSendCancel']
    .every(function (id) { return new RegExp('id="' + id + '"').test(htmlNoComment); }));
check('分享层多了「发送到聊天应用」这个入口',
  /id="btnShareSend"/.test(htmlNoComment) &&
  /\$\('btnShareSend'\)\.addEventListener\('click', function \(\) \{ openSendTo\(null\)/.test(appjs));
check('转发层登记进 BULLET_BACK（漏了的话按返回会一路掀回课表）',
  /maskSendTo: backToShare/.test(appjs));
check('三个出口共用一份实现，且是「退回分享层」而不是整层关掉',
  /function backToShare/.test(appjs) &&
  /\$\('btnSendCancel'\)\.addEventListener\('click', backToShare\)/.test(appjs) &&
  /function backToShare\(\) \{\s*closeMask\('maskSendTo'\);\s*openMask\('maskShare'\);/.test(appjs));
check('「保存为 CSV」存成功后顺手问一句要不要发出去（不是存完就结束）',
  /function shareByCsv[\s\S]{0,1500}?openSendTo\(\{ savedPath/.test(appjs));
/* 存完那一刻弹层说明里已经写着路径了，再叠一条 toast 会正好盖住弹层上的按钮
   （出预览图时踩过：toast 压住了两个选项）。 */
check('存成功那一步不再弹 toast（会和弹层提示互相盖住）',
  !/toast\('已保存到/.test(appjs));

/* ---- 原生侧：真文件 + 系统分享，且依然一个权限都不要 ---- */
check('发送文件的原生桥名 JS 与 Kotlin 一致（差一个字母就静默失效）',
  /global\.AndroidShare\b/.test(appjs) && /"AndroidShare"/.test(kt) &&
  /fun shareFile\(/.test(kt) && /fun hasApp\(/.test(kt));
check('走系统分享：ACTION_SEND + EXTRA_STREAM + 单独授予读取权',
  /Intent\.ACTION_SEND\b/.test(ktNoComment) && /Intent\.EXTRA_STREAM\b/.test(ktNoComment) &&
  /FLAG_GRANT_READ_URI_PERMISSION\b/.test(ktNoComment));
check('文件经 FileProvider 换成 content://（Android 7 起塞 file:// 会直接抛异常）',
  /FileProvider\.getUriForFile\(this@MainActivity, "\$packageName\.fileprovider"/.test(kt) &&
  /\$\{applicationId\}\.fileprovider/.test(manifestShare));
check('「其他应用」交回系统面板（不硬编码一份分享名单）',
  /Intent\.createChooser/.test(kt));
check('定向的三个包名写对了（微信 / QQ / 钉钉）',
  /"wechat" -> "com\.tencent\.mm"/.test(kt) &&
  /"qq" -> "com\.tencent\.mobileqq"/.test(kt) &&
  /"dingtalk" -> "com\.alibaba\.android\.rimet"/.test(kt));
/* Android 11 起不声明 <queries> 就查不到这些包，而且**返回空列表、不抛异常** ——
   症状是「明明装了微信却提示未安装」，极难查。JS 的 key / Kotlin 的包名 /
   Manifest 的声明这三处必须一一对上，所以这里**交叉核对**（不是各自查一遍就算）：
   从 Kotlin 里抽出映射出的包名，逐个回到 Manifest 的 <queries> 里找。
   正则右边要求「带点的包名」——`labelOf` 里也有一串 `"qq" -> "QQ"`，
   不咬住形状的话它会被一起捞进来。 */
const ktPkgs = [];
const ktPkgRe = /"(?:wechat|qq|dingtalk)" -> "([\w]+\.[\w.]+)"/g;
let ktPkgM;
while ((ktPkgM = ktPkgRe.exec(kt)) !== null) ktPkgs.push(ktPkgM[1]);
check('Kotlin 里映射出的三个包名，Manifest 的 <queries> 里一个不少',
  ktPkgs.length === 3 &&
  /<queries>[\s\S]*?<\/queries>/.test(manifestShare) &&
  ktPkgs.every(function (p) { return manifestShare.indexOf('"' + p + '"') >= 0; }),
  ktPkgs.join(','));
check('没装的就地置灰（点了才被告知「未安装」体验差一截）',
  /function syncSendTargets/.test(appjs) && /btn\.disabled = !ok/.test(appjs) &&
  /\.opt-row:disabled/.test(css));
check('查不到安装状态时当作装着（别把本来能用的入口误灰掉）',
  /catch \(e\) \{ ok = true; \}/.test(appjs));
check('微信不一定登记 text/csv ⇒ 退一步用 */* 再探一次，别直接失败',
  /listOf\(primary, "\*\/\*"\)/.test(kt) && /queryIntentActivities/.test(kt));
/* 零权限底线的哨兵：转发功能加进来之后，权限清单不能因此变脏。 */
check('加了转发之后权限仍然只有 INTERNET 一项',
  (manifestShare.match(/<uses-permission/g) || []).length === 1 &&
  /android\.permission\.INTERNET/.test(manifestShare) &&
  !/WRITE_EXTERNAL_STORAGE|READ_EXTERNAL_STORAGE|READ_MEDIA/.test(ktNoComment) &&
  !/requestPermissions/.test(ktNoComment));

/* 真跑一次：只拿正则看源码，测不出「点下去究竟把什么交给了系统」——
   桩一个 AndroidShare，量它收到的文件名 / 类型 / 目标 / 内容。
   判「弹层亮没亮」一律走 getElementById：els 里的元素是**惰性创建**的，
   某个 id 若在坏版本里从没被访问过就不存在，直接读 els.xxx 会 TypeError
   （那是测试自己崩掉，不是断言变红——验红时会看不到「红了哪一条」）。 */
const maskShown = function (id) {
  return global.document.getElementById(id).classList.contains('show');
};
let sentShare = null;
global.AndroidShare = {
  hasApp: function () { return 1; },
  shareFile: function (name, mime, text, target) {
    sentShare = { name: name, mime: mime, text: text, target: target };
    return 'ok:微信';
  }
};
global.ScheduleApp.openShareSheet();
check('前置：分享层真的先亮着（否则下面「收掉父层」那条是空转）',
  maskShown('maskShare'));
global.ScheduleApp.openSendTo({ savedPath: '下载/柚课-我的课表.csv' });
check('转发层写清了「哪张课表 / 以什么形式发 / 存到哪了」',
  els.sendToWhat.textContent.indexOf(Store.current().name) >= 0 &&
  /\.csv/.test(els.sendToWhat.textContent) &&
  els.sendToHint.textContent.indexOf('下载/柚课-我的课表.csv') >= 0,
  els.sendToWhat.textContent + ' | ' + els.sendToHint.textContent);
check('打开转发层时分享层被收掉（弹层不许叠）',
  !maskShown('maskShare') && maskShown('maskSendTo'));
check('装着的目标保持可点，说明行写的是「发到微信聊天」',
  !els.btnSendWechat.disabled && /发到微信聊天/.test(els.sendWechatD.textContent));

global.ScheduleApp.sendScheduleTo('wechat');
check('交给原生的是「真文件 + 系统分享」，不是一段文字',
  !!sentShare && /\.csv$/.test(sentShare.name) && sentShare.mime === 'text/csv' &&
  sentShare.target === 'wechat',
  sentShare ? (sentShare.name + ' | ' + sentShare.mime + ' | ' + sentShare.target) : '没调到桥');
check('发出去的就是与导入端同口径的那一份（带 BOM，且能被真解析器吃回来）',
  !!sentShare && sentShare.text.charCodeAt(0) === 0xFEFF &&
  global.CsvUtil.parse(sentShare.text, S.settings).courses.length === S.courses.length);
check('成功之后两个弹层都收干净（不把用户留在半路的弹层上）',
  !maskShown('maskSendTo') && !maskShown('maskShare'));

/* 没装的那个置灰，但不能连累另一个 */
global.AndroidShare.hasApp = function (t) { return t === 'qq' ? 0 : 1; };
global.ScheduleApp.openSendTo(null);
check('没装的那个就地置灰并说明原因，另一个不受影响',
  els.btnSendQQ.disabled === true && /没装QQ/.test(els.sendQQD.textContent) &&
  !els.btnSendWechat.disabled,
  els.sendQQD.textContent);
global.ScheduleApp.backToShare();
check('取消 / 返回键退回分享层（两个层不并存）',
  !maskShown('maskSendTo') && maskShown('maskShare'));
delete global.AndroidShare;

/* ---------------------------------------------------------------
   E. window.confirm 换成自绘确认框（v1.9.20 起四处，v1.9.45 加「从备份恢复」共五处）
   --------------------------------------------------------------- */
check('页面里已经没有 window.confirm 了（破坏性动作全部换掉）',
  !/\bconfirm\(/.test(appjsNoComment));
/* v1.9.45：新增第 5 个调用点「从备份恢复」（它会整份替换用户所有课表与设置，
   破坏性不比「清空课表」小），所以这里不再写死 4。
   但也不只是把 4 改成 5 —— 只数个数的话，**删掉一处、再在别处补一个**照样
   能凑回这个数。改成逐个钉住**标题**：五处少一处、或哪一处被换回原生
   confirm，都会当场现形。
   标题只从每个 `openConfirm({` 之后取**第一处**（非贪婪），免得把 openPicker
   的 title（「星期」「导入到哪个课表」…）也一起算进来。 */
const confirmTitles = ['从备份恢复', '删除课表', '调小每天节数', '清空课表', '删除课程'];
const confirmFound = (appjsNoComment.match(/openConfirm\(\{[\s\S]*?title:\s*'([^']+)'/g) || [])
  .map((s) => /title:\s*'([^']+)'$/.exec(s)[1]);
check('五处破坏性动作都换成了自绘确认框（删课表 / 调小每天节数 / 清空课表 / 删课程 / 从备份恢复）',
  (appjsNoComment.match(/\bopenConfirm\(\{/g) || []).length === confirmTitles.length &&
  confirmTitles.every((t) => confirmFound.indexOf(t) >= 0),
  (appjsNoComment.match(/\bopenConfirm\(\{/g) || []).length + ' 处：' + confirmFound.join(' / '));
check('确认框的构件齐了（标题 / 正文 / 取消 / 确定）',
  ['maskConfirm', 'confirmTitle', 'confirmMsg', 'confirmCancel', 'confirmOk']
    .every(function (id) { return new RegExp('id="' + id + '"').test(htmlNoComment); }));
check('确认框是居中小窗（不是贴底的整条面板）',
  /class="mask mask-center" id="maskConfirm"/.test(htmlNoComment) &&
  /\.confirm-sheet\s*\{[^}]*max-width:\s*360px/.test(css));
check('确认框正文保留换行（「几门课会一起删」和「不可撤销」要分两段）',
  /\.confirm-msg\s*\{[^}]*white-space:\s*pre-line/.test(css));
check('确认框登记进 BULLET_BACK（漏了的话按返回会一路掀回课表）',
  /maskConfirm: backFromConfirm/.test(appjs));
check('三个出口共用同一份实现（取消按钮 / 返回键 / 点弹层外）',
  /function backFromConfirm/.test(appjs) &&
  /\$\('confirmCancel'\)\.addEventListener\('click', backFromConfirm\)/.test(appjs));

/* 真跑一遍这条链：只拿正则看字符串，测不出「点确定到底有没有执行动作」。 */
let confirmRuns = 0;
global.ScheduleApp.openConfirm({
  parent: 'maskSettings',
  title: '清空课表',
  message: '第一段\n\n第二段',
  okText: '清空',
  onOk: function () { confirmRuns += 1; }
});
check('打开确认框：父层被收掉、确认框亮起、标题 / 正文 / 按钮文案都写对了',
  !els.maskSettings.classList.contains('show') &&
  els.maskConfirm.classList.contains('show') &&
  els.confirmTitle.textContent === '清空课表' &&
  els.confirmMsg.textContent === '第一段\n\n第二段' &&
  els.confirmOk.textContent === '清空');
check('破坏性动作的「确定」是红字样式，不是主色实心',
  els.confirmOk.className === 'btn btn-danger', els.confirmOk.className);

global.ScheduleApp.backFromConfirm();
check('取消：确认框收起、动作一次都没执行、父层原样亮回来',
  !els.maskConfirm.classList.contains('show') && confirmRuns === 0 &&
  els.maskSettings.classList.contains('show'));

global.ScheduleApp.openConfirm({
  parent: 'maskSettings',
  onOk: function () { confirmRuns += 1; }
});
global.ScheduleApp.okConfirm();
check('确定：动作执行且只执行一次、确认框收起、不再亮回父层（收尾由动作自己决定）',
  confirmRuns === 1 && !els.maskConfirm.classList.contains('show') &&
  !els.maskSettings.classList.contains('show'));
check('确定之后「确定」按钮的文案回到默认值（下次打开不会被上次的文案粘住）',
  (function () {
    global.ScheduleApp.openConfirm({ parent: 'maskSettings', message: 'x', onOk: function () {} });
    const t = els.confirmOk.textContent;
    global.ScheduleApp.backFromConfirm();
    return t === '确定';
  })(), els.confirmOk.textContent);

console.log('\n[11d] 编辑时间表：整页草稿 + 固定时长「整体平移」');

/* 时间表的算术放在 store.js 里是纯函数，所以这一段的**核心几条是真断言
   （直接调用），不是正则**。平移与夹取写错了肉眼很难发现，而它一错，
   用户的课表会被静默改乱——这类算术必须真算一遍。 */
/* 注意：这里不能写 `const Store = ...`。store.js 是把 Store 挂到 global 上的，
   本文件前面的段落一直在直接用它；一旦在这里用 const 声明，就会在整份文件
   里给它加上 TDZ，前面所有 `Store.xxx` 会在运行到这一行之前就抛
   「Cannot access 'Store' before initialization」。直接沿用全局的那个。 */
const dTimes = Store.defaultTimes();
const seq = (ts) => ts.map(function (t) { return t.start + '-' + t.end; }).join(' ');

check('设置里不再有手打「开始-结束」的文本框，只剩一个跳转行',
  !/id="setTimes"/.test(htmlSrc) && /id="btnTimes"/.test(htmlSrc) &&
  /id="timesSummary"/.test(htmlSrc));
check('「重置时间表」按钮从设置里搬走了（避免和草稿两套保存）',
  !/id="btnResetTimes"/.test(htmlSrc) && /id="ttReset"/.test(htmlSrc));
check('编辑时间表是一整页，不是底部弹层',
  /class="mask mask-page" id="maskTimetable"/.test(htmlSrc) && /\.mask-page\b/.test(css));

/* v1.9.16：大屏那条「让底部弹层居中成小卡片」的规则必须把整页表单排除在外。
   不排除的话，内容比视口高的整页（.page 的高度是内容撑出来的）会被一起居中、
   页顶被推到屏幕上方：页头跑出屏幕、右上角「固定上课时长」的开关只剩 8px 露在
   屏内，点不着。当时四套测试全绿也没拦住，因为**每条断言都只跑手机视口**。
   所以这里补一条静态哨兵：只要 820 那一档里出现裸 .mask 居中，立刻红。
   （真正的几何验证在 edu-e2e 的 [20] 段——那一段会真开平板视口去量像素。） */
const wideBlock = (css.match(/@media \(min-width: 820px\)\s*\{[\s\S]*?\n\}/) || [''])[0];
check('大屏的「居中」只作用于底部弹层，整页表单排除在外',
  /\.mask:not\(\.mask-page\)/.test(wideBlock) && !/^\s*\.mask\s*\{/m.test(wideBlock),
  wideBlock.replace(/\s+/g, ' ').slice(0, 100));
check('页内结构齐了：返回 / 保存 / 固定时长开关 / 每节时长 / 添加 / 列表',
  ['ttBack', 'ttSave', 'ttFixed', 'ttDur', 'ttAdd', 'ttList', 'ttReset']
    .every(function (id) { return new RegExp('id="' + id + '"').test(htmlSrc); }));
check('开关与时长同在一张卡里（开关在上、时长在下）',
  /固定上课时长[\s\S]{0,300}?id="ttFixed"[\s\S]{0,700}?每节课时长（分钟）[\s\S]{0,300}?id="ttDur"/.test(htmlSrc));
check('「24 小时制」提示与「添加」在同一行',
  /请注意是 24 小时制！[\s\S]{0,200}?id="ttAdd"/.test(htmlSrc));

check('改第 1 节开始时间：从这一节起整体后移 10 分钟',
  (function () {
    const r = Store.shiftTimes(dTimes, 0, '08:10', 45);
    return r[0].start === '08:10' && r[1].start === '09:00' && r[11].start === '20:20';
  })());
check('整体平移后每节仍然是「开始 + 时长」',
  Store.shiftTimes(dTimes, 0, '08:10', 45)
    .every(function (t) { return Store.timeToMin(t.end) - Store.timeToMin(t.start) === 45; }));
check('整体平移保持课间间隔不变',
  (function () {
    const r = Store.shiftTimes(dTimes, 0, '08:10', 45);
    return Store.timeToMin(r[1].start) - Store.timeToMin(r[0].end) ===
      Store.timeToMin(dTimes[1].start) - Store.timeToMin(dTimes[0].end);
  })());
check('下夹：改到上一节还没下课，就顶在上一节结束那一刻',
  (function () {
    const r = Store.shiftTimes(dTimes, 2, '09:00', 45);
    return r[2].start === '09:35' && r[3].start === '10:25';
  })());
check('上夹：最后一节不会跨过 23:59',
  Store.shiftTimes(dTimes, 11, '23:30', 45)[11].end === '23:59');
check('认不出的时间一律当没改（宁可不动，也不猜一个值出来）',
  seq(Store.shiftTimes(dTimes, 0, '哦', 45)) === seq(dTimes));
check('平移不修改入参（草稿和已保存的数据不能互相串）',
  seq(dTimes) === seq(Store.defaultTimes()));
check('不固定时长时：改哪一节只动哪一节',
  (function () {
    const r = Store.setTime(dTimes, 1, 'end', '09:40');
    return r[1].end === '09:40' && r[2].start === dTimes[2].start;
  })());
check('改「每节课时长」：每节都统一成新时长，第一节的起点不动',
  (function () {
    const r = Store.withDuration(dTimes, 50);
    return r[0].start === '08:00' && r[0].end === '08:50' &&
      r.every(function (t) { return Store.timeToMin(t.end) - Store.timeToMin(t.start) === 50; });
  })());
check('改时长不会把变长的课压进下一节里（以时长为准往下排，课间间隔保持）',
  (function () {
    const r = Store.withDuration(dTimes, 50);
    // 第 1 节原本 08:45 下课、第 2 节 08:50 上课（课间 5 分钟）-> 第 2 节应变 08:55
    return r[1].start === '08:55' &&
      r.every(function (t, i) {
        return i === 0 || Store.timeToMin(t.start) >= Store.timeToMin(r[i - 1].end);
      });
  })());
check('时长排到 23:59 就停住，不会溢出到第二天',
  (function () {
    const r = Store.withDuration(dTimes, 90);
    return r[r.length - 1].end === '23:59';
  })());
check('「添加」补出来的节接在最后一节后面（不是抄一份默认时间表）',
  (function () {
    const r = Store.fitTimes(dTimes, 14, 45);
    return r.length === 14 && r[12].start === '21:05' && r[13].start === '22:00';
  })());
check('「每节时长是否一致」判定正确（老数据靠它推断开关默认值）',
  Store.uniformDuration(dTimes) === 45 &&
  Store.uniformDuration([{ start: '08:00', end: '08:45' }, { start: '09:00', end: '10:00' }]) === 0);
check('老数据缺这两个字段时按现有时间表推断，不硬套默认值',
  /fixedDuration: st\.fixedDuration === undefined \? uni > 0 : !!st\.fixedDuration/.test(storejs) &&
  /classDuration: \+st\.classDuration \|\| uni \|\| ds\.classDuration/.test(storejs));

check('改动只进草稿，点「保存」才写回当前课表',
  /function saveTimetable[\s\S]{0,500}?S\.settings\.times = ttTimes/.test(appjs) &&
  /S\.settings\.fixedDuration = ttFixed/.test(appjs));
check('返回 = 丢草稿（不写回，也不留半保存状态）',
  /function backToSettings\(\)[\s\S]{0,120}?closeMask\('maskTimetable'\);[\s\S]{0,80}?openMask\('maskSettings'\)/.test(appjs));
check('时间表页也是子弹层的一员：返回键退回「设置」而不是掀回课表',
  /maskTimetable: backToSettings/.test(appjs));
check('改完必须用返回值回写输入框（位移被夹过，显示的得是真生效的时间）',
  /if \(ttFixed && key === 'start'\)/.test(appjs) &&
  /function onTimeChange[\s\S]{0,400}?setRowValues\(\)/.test(appjs));
check('固定时长开着时结束时间 disabled（不给改）；只剩一节时删除按钮也禁用',
  /ttRows\.forEach\([\s\S]{0,200}?r\.end\.disabled = ttFixed/.test(appjs) &&
  /r\.del\.disabled = ttSections <= 1/.test(appjs));
check('固定时长关掉时「每节时长」灰掉（那一项当时不归用户管）',
  /sel\.disabled = !ttFixed/.test(appjs) && /classList\.add\('off'\)/.test(appjs));
check('每行的时间行是动态生成的，事件走委托（逐个绑必漏）',
  /\$\('ttList'\)\.addEventListener\('change'/.test(appjs) &&
  /function renderTimes/.test(appjs));

/* ---------- v1.9.4：左滑删掉一节 ---------- */
check('删掉中间一节：后面几节整体上移，空出来的位置被补掉',
  (function () {
    const r = Store.removeSection(dTimes, 2);
    const shift = Store.timeToMin(dTimes[11].start) - Store.timeToMin(r[10].start);
    return r.length === 11 &&
      r[2].start === dTimes[2].start &&     // 原第 4 节正好落进被删掉的那个槽位
      r[2].end === dTimes[2].end &&
      shift === 50 &&                       // 末尾那一节也跟着上移了一个槽位
      Store.timeToMin(r[10].end) - Store.timeToMin(r[10].start) === 45;
  })());
check('删一节不会把课间休息吃掉（间隔按原表保留）',
  (function () {
    const r = Store.removeSection(dTimes, 2);
    // 原表 第 2 节 09:35 下课、第 3 节 09:40 上课 —— 这 5 分钟不能消失
    return Store.timeToMin(r[2].start) - Store.timeToMin(r[1].end) ===
      Store.timeToMin(dTimes[2].start) - Store.timeToMin(dTimes[1].end) &&
      r.every(function (t) { return Store.timeToMin(t.end) - Store.timeToMin(t.start) === 45; });
  })());
check('删掉最后一节：前面各节原地不动（后面没人要挪）',
  (function () {
    const r = Store.removeSection(dTimes, dTimes.length - 1);
    return r.length === 11 && seq(r) === seq(dTimes.slice(0, 11));
  })());
check('只剩一节时不允许再删（原样返回，不删空）',
  (function () {
    const one = [{ start: '08:00', end: '08:45' }];
    return seq(Store.removeSection(one, 0)) === seq(one);
  })());
check('越界的删除请求不猜、原样返回',
  seq(Store.removeSection(dTimes, 99)) === seq(dTimes) &&
  seq(Store.removeSection(dTimes, -1)) === seq(dTimes));
check('删一节不修改入参（草稿和已保存的数据不能互相串）',
  (function () { Store.removeSection(dTimes, 3); return seq(dTimes) === seq(Store.defaultTimes()); })());

check('每一节外面再套一层裁剪容器：行滑出去的那块靠它挡住',
  /tt-row-wrap/.test(appjs) &&
  /\.tt-row-wrap \{ position: relative; overflow: hidden; \}/.test(css) &&
  /\.tt-del \{[\s\S]{0,400}?background: var\(--del-bg\)/.test(css));
check('删除按钮用两主题共用的深红（--danger 在深色下白字只有 2.5:1，太糊）',
  /--del-bg: #d92d33;/.test(css));
check('行本身必须不透明，否则红色按钮会从行底下透出来',
  /\.tt-row \{[\s\S]{0,200}?background: var\(--surface\)/.test(css));
check('删除按钮宽度与 SWIPE_W 必须对上（对不上就露半截或露出一块白）',
  /var SWIPE_W = 76;/.test(appjs) && /width: 76px;/.test(css));
check('没滑开时按钮藏在行底下，不该被点到（键盘 / 辅助功能也走这条）',
  /classList\.contains\('open'\)/.test(appjs) &&
  /\$\('ttList'\)\.addEventListener\('click'[\s\S]{0,800}?getAttribute\('data-del'\)/.test(appjs));
check('横向意图明确（|dx| > |dy|）才接管，否则把竖向手势让给页面滚动',
  /Math\.abs\(ax\) <= Math\.abs\(ay\)/.test(appjs));
check('没滑够要回弹：按位移过半或速度判定',
  /dx <= -SWIPE_W \/ 2/.test(appjs) && /vx < -0\.5/.test(appjs) && /vx > 0\.5/.test(appjs));
check('同一时刻只允许一行是滑开的',
  /function closeOpenRow/.test(appjs) && /openWrap && openWrap !== wrap/.test(appjs));
check('滑动结束后吃掉浏览器补发的 click（不然滑完会弹出系统时间选择器）',
  /suppressClick = true/.test(appjs) && /if \(!suppressClick\) return;/.test(appjs));
check('补发的 click 只吃「紧跟着的那一个」，不按时间窗（滑完立刻点删除不能被自己吞掉）',
  /suppressClick = false;\s*\/\/ 新的一次按下/.test(appjs) &&
  /if \(!suppressClick\) return;\s*\n\s*suppressClick = false;/.test(appjs) &&
  /targetIsDelete\(t, wrap\)\) return;/.test(appjs) &&
  !/setTimeout\(function \(\) \{ suppressClick = false; \}/.test(appjs));
check('触摸与鼠标是两条独立分支，都要能跑（真机走触摸）',
  /addEventListener\('touchstart'/.test(appjs) && /addEventListener\('touchend', end\)/.test(appjs) &&
  /addEventListener\('mousedown'/.test(appjs) && /addEventListener\('mouseup'/.test(appjs));
check('删到只剩一节就停手，并说清为什么',
  /if \(ttSections <= 1\) \{ toast\('至少要保留 1 节'\); return; \}/.test(appjs));
check('删完重新渲染（行数变了，不能只赋值）并同步节数',
  /function deleteSection[\s\S]{0,300}?ttSections = ttTimes\.length;[\s\S]{0,80}?renderTimes\(\)/.test(appjs));
check('页面上把「左滑可删」写出来了（不然这个手势没人发现）',
  /请注意是 24 小时制！[\s\S]{0,40}?左滑/.test(htmlSrc));

console.log('\n[11e] 课程卡配色：鲜艳实心纯色底 + 可选颜色');

/* 卡片上是不透明白字，「够不够清楚」这件事是可以算出来的（WCAG 相对亮度），
   所以这一段的核心几条也是**真断言**而不是正则。
   **v1.9.7 起规则反过来了**：以前是「白字优先」，明度按色相各求（28%~52%），
   代价是整排卡片深浅不齐、黄绿那几张发闷；现在**鲜艳优先**——明度固定一个
   鲜艳值，对比度只当兜底线。白字对比度因此从 4.60:1 掉到 1.35:1，
   这是用户明确接受的取舍（「哪怕阳光下看不清楚」），不是 bug。
   这里钉住的是：①没有一档掉到兜底线以下；②明度确实统一了；
   ③那条兜底线真的还在拦（黄绿被压下来）；④12 档色值仍然两两不同。 */
const satPct = Math.round(Store.CARD_SAT * 100);
const worstHue = Store.HUE_CHOICES.reduce(function (p, h) {
  return Store.whiteContrast(h) < Store.whiteContrast(p) ? h : p;
}, Store.HUE_CHOICES[0]);

const cardLights = Store.HUE_CHOICES.map(function (h) { return Store.cardLight(h); });
const lMin = Math.min.apply(null, cardLights), lMax = Math.max.apply(null, cardLights);

check('每一档的白字对比度都不低于兜底线（v1.9.7 起不再是 4.5:1）',
  Store.HUE_CHOICES.every(function (h) {
    return Store.whiteContrast(h) >= Store.CARD_CONTRAST_MIN - 1e-9;
  }),
  '最差 ' + worstHue + ' = ' + Store.whiteContrast(worstHue).toFixed(2) + ':1 / 兜底 ' +
  Store.CARD_CONTRAST_MIN.toFixed(2) + ':1');
check('明度统一取鲜艳值 —— 整排卡片深浅一致（不再按色相各算各的）',
  Store.HUE_CHOICES.every(function (h) {
    var l = Store.cardLight(h);
    return l > 0.5 && l <= Store.CARD_LIGHT + 1e-9;
  }) && lMax - lMin < 0.05,
  '明度 ' + (lMin * 100).toFixed(1) + '% ~ ' + (lMax * 100).toFixed(1) + '%（旧规则是 28%~52%）');
check('兜底线真的在拦：黄绿被压到鲜艳值之下，蓝紫原样取鲜艳值',
  Store.cardLight(78) < Store.CARD_LIGHT - 1e-9 &&
  Math.abs(Store.cardLight(238) - Store.CARD_LIGHT) < 1e-9 &&
  Store.whiteContrast(78) < Store.CARD_CONTRAST_MIN + 0.05,
  '78=' + (Store.cardLight(78) * 100).toFixed(1) + '%/' + Store.whiteContrast(78).toFixed(2) +
  ':1 · 238=' + (Store.cardLight(238) * 100).toFixed(1) + '%/' +
  Store.whiteContrast(238).toFixed(2) + ':1');
check('12 档色值两两不同（换算写错就会有两档撞成同一个色）',
  new Set(Store.HUE_CHOICES.map(function (h) { return Store.cardHex(h); })).size ===
  Store.HUE_CHOICES.length);
check('底色内联成 --bg 传进来，CSS 里不写死明度（就地算，两处不会漂移）',
  satPct === 86 &&
  /background: var\(--bg/.test(css) &&
  /* 卡片底色只由 courseBg 一处决定 —— 表单里的调色盘走的是另一条路
     （显示的是同一个色的 hex），两条路都从 store.js 拿值，不会各算一套 */
  (appjs.match(/Store\.cardBg\(/g) || []).length === 1 &&
  /--bg:' \+ courseBg\(c\)/.test(appjs) &&
  /function courseBg[\s\S]{0,200}?Store\.cardBg\(hueOfCourse\(c\)\)/.test(appjs));

const courseBlock = (css.match(/\.course \{[\s\S]*?\n\}/) || [''])[0];
check('卡片是实心纯色底 + 白字，左侧那道色条撤掉了',
  /background: var\(--bg/.test(courseBlock) &&
  /color: #fff/.test(courseBlock) &&
  !/border-left/.test(courseBlock));
check('卡片有一圈包边，且是 box-shadow 外描边而不是 border',
  /* border 会从内容盒里扣宽：课程名「一行三个字」只剩 2.5px 余量（37 - 34.5），
     一扣就退回两行。box-shadow 不参与布局，所以特意断言 border 宽度为 0。 */
  /0 0 0 var\(--card-edge-w\) var\(--card-edge\)/.test(courseBlock) &&
  !/(^|[\s;{])border(-left|-top|-right|-bottom)?\s*:/.test(courseBlock));

/* v1.9.9：包边颜色**跟着主题走**（v1.9.7~v1.9.8 是「两个主题都用白」，白天等于没画）。
   白天底面是近白的暖白 #fffdf8，包边必须够深；夜晚底面是 #1d1913，包边是纯白。
   三条都得钉住：只改一处、或两处写反（白天给白、夜晚给深色），都会让某个主题下的
   边界彻底消失 —— 而 CSS 与渲染都不会报错，只有量像素才看得出来（v1.9.7 的教训）。 */
const lightBlock = (css.match(/:root,\s*\n:root\[data-theme="light"\] \{[\s\S]*?\n\}/) || [''])[0];
const darkBlock = (css.match(/:root\[data-theme="dark"\] \{[\s\S]*?\n\}/) || [''])[0];

/* 两色对比度（WCAG 相对亮度）。store.js 只导出了「对白色」的 hexContrast，
   这里要的是任意两色，所以拿它导出的 relLum / hexToRgb 自己算。 */
const contrastOf = (a, b) => {
  const la = Store.relLum(Store.hexToRgb(a)), lb = Store.relLum(Store.hexToRgb(b));
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
};
const lightSurface = (lightBlock.match(/--surface:\s*(#[0-9a-f]{6})/i) || [])[1] || '';
const lightEdge = (lightBlock.match(/--card-edge:\s*(#[0-9a-f]{3,6})/i) || [])[1] || '';
const edgeVsSurface = lightEdge && lightSurface ? contrastOf(lightEdge, lightSurface) : 0;

/* v1.9.13：白天包边从「暖深灰 #3a342b」改成「浅暖灰 #a89a86」。
   起因是用户报「黑色描边有点突兀」—— 那道线对底面是 **12.11:1**，等于一圈黑框，
   而且它跟卡片本身的颜色毫无关系。
   **这条断言不写死「够不够柔和」，而是卡一个区间**：太深重回黑框、太浅等于没画
   （v1.9.7 的「白压白」就是这么来的），两头都不能过。只钉一个 hex 名字挡不住这个。 */
check('白天包边是浅暖灰，对底面亮度比落在 1.8~5.0 的 divider 量级（不再是 12:1 的黑框，也不能淡到看不见）',
  /--card-edge:\s*#a89a86/i.test(lightBlock) && edgeVsSurface >= 1.8 && edgeVsSurface <= 5,
  lightEdge + ' vs ' + lightSurface + ' = ' + edgeVsSurface.toFixed(2) + ':1');
check('夜晚包边是纯白（底面够深，白边自己就清楚）',
  /--card-edge:\s*#fff\b/i.test(darkBlock),
  (darkBlock.match(/--card-edge:[^;]+/) || [''])[0]);
check('包边恰好声明两处（白天一处、夜晚一处），v1.9.8 那条暗线已彻底撤掉',
  (css.match(/--card-edge:/g) || []).length === 2 &&
  (css.match(/--card-line/g) || []).length === 0,
  'card-edge ' + (css.match(/--card-edge:/g) || []).length + ' 处 / card-line ' +
  (css.match(/--card-line/g) || []).length + ' 处');
check('包边只有一层 box-shadow，投影垫在最后（写到前面会把包边弄脏）',
  (courseBlock.match(/box-shadow:/g) || []).length === 1 &&
  /var\(--card-edge-w\) var\(--card-edge\),\s*var\(--shadow\)/.test(courseBlock));
const cNameBlock = (css.match(/\.c-name \{[\s\S]*?\n\}/) || [''])[0];
const cMetaBlock = (css.match(/\.c-meta \{[\s\S]*?\n\}/) || [''])[0];
check('课程名与教室都**横向**居中（不是左对齐）',
  /text-align: center/.test(courseBlock) &&
  !/text-align: left/.test(courseBlock) &&
  !/text-align: left/.test(cNameBlock) &&
  !/text-align: left/.test(cMetaBlock));

/* v1.9.13：卡片内部补上**纵向**分配（v1.9.7 只做了横向居中，两行内容全堆在顶部，
   2 节连排的卡片有 106px 高、内容只占 25px，下面一大片空的 —— 用户报的「课程名没居中」）。
   做法是 flex 纵向容器 + 课程名上下 auto margin：auto margin 会吸走剩余空间，
   上下平分 ⇒ 课程名落在「内容区顶 ~ 教室顶」的正中，教室自然留在最后、贴着底边。
   ⚠ 这条同时是**哨兵**：flex 里 auto margin 的优先级高于容器的 justify-content，
   若有人「顺手」给 .course 加一句 justify-content: center，它不会生效、只会看着像实现了。 */
check('卡片是 flex 纵向容器，课程名靠上下 auto margin 垂直居中（教室因此被留在最后）',
  /display:\s*flex/.test(courseBlock) && /flex-direction:\s*column/.test(courseBlock) &&
  /margin-top:\s*auto/.test(cNameBlock) && /margin-bottom:\s*auto/.test(cNameBlock) &&
  !/justify-content:\s*center/.test(courseBlock),
  'justify-content: center 会与 auto margin 打架（auto margin 赢），别写');

/* 「教室沉底但不被遮挡」的两条保障：
   ①教室 flex: none —— **不参与收缩**，窄列里地址折成两行、又赶上单节卡时，
     让课程名先去压缩，教室必须整行完整；
   ②课程名 min-height: 0 —— flex 子项默认 min-height: auto 会被内容顶住、拒绝收缩，
     置 0 之后它才肯让（配合已有的 overflow: hidden，裁掉的是课程名自己的行）。 */
check('教室沉底且不被遮挡：教室不收缩（flex:none），课程名可收缩（min-height:0）先让位',
  /flex:\s*none/.test(cMetaBlock) && /min-height:\s*0/.test(cNameBlock));
check('教室信息不再降透明度（鲜艳实色底上再降就糊了）',
  /\.c-meta \{[^}]*?font-size: var\(--fs-meta\)/.test(css) &&
  /\.c-meta \{[^}]*?\n\}/.test(css) &&
  !/\.c-meta \{[^}]*?opacity/.test(css));

/* 「一行三个字」靠的是把卡片内边距省出来，**不是缩字号**。
   v1.9.11 把左右内边距从 5px 收到 2px（省出的 3px 买了那道列缝），
   所以这里不再比对 padding 的字面量，而是**按真值把内容宽算一遍**：
   缝一变列宽就变、列宽一变内容宽就变，字面量断言看不出这串连锁反应。
       列宽   = (屏宽 − 时间列 − 6×列间距) / 7
       内容宽 = 列宽 − 2×卡片横向留白 − 左右内边距
   时间列宽与字号按 web/css/app.css 里那几个 @media 档位取（320 走窄屏档、
   421 起走大屏档，360~430 是 44px 那档；390 是 edu-e2e.js 实际用的视口）。 */
const coursePadM = courseBlock.match(/padding:\s*([\d.]+)px(?:\s+([\d.]+)px)?/);
const COURSE_PAD_X = coursePadM
  ? parseFloat(coursePadM[2] !== undefined ? coursePadM[2] : coursePadM[1]) : NaN;
check('解析到了卡片左右内边距（哨兵：下面几条都建在它上面）',
  !isNaN(COURSE_PAD_X), COURSE_PAD_X + 'px');
[
  { name: '窄屏 320dp', vw: 320, timeCol: 32, fs: 10.5 },
  { name: '常见 360dp', vw: 360, timeCol: 38, fs: 11.5 },
  { name: 'e2e 视口 390dp', vw: 390, timeCol: 38, fs: 11.5 },
  { name: '大屏 430dp', vw: 430, timeCol: 44, fs: 12.5 }
].forEach((c) => {
  const cw = (c.vw - c.timeCol - 6 * COL_GAP) / 7 - 2 * PAD_X - COURSE_PAD_X;
  check(c.name + ' 的内容宽放得下三个汉字（' + cw.toFixed(2) + 'px ≥ ' + (3 * c.fs) + 'px）',
    cw >= 3 * c.fs);
});
check('窄屏档不再单独收内边距（基础值 2px 已经比它更省，留着反而是往回放宽）',
  /* 必须先把窄屏媒体块整段切出来再看 —— 直接拿 /@media \(max-width: 359px\)[\s\S]*?
     \.course \{/ 去测会跨过块尾、匹配到大屏档那条 padding，
     断言就永远为真（这里是先写成跨块才发现的）。 */
  !/\.course \{/.test((css.match(/@media \(max-width: 359px\) \{[\s\S]*?\n\}/) || [''])[0]));
check('字号没有为了塞下三个字而调小（课程名仍是 var(--fs-name)）',
  /\.c-name \{[^}]*?font-size: var\(--fs-name\)/.test(css));

/* 颜色字段的判据：**看「存没存过」，不看「值真不真」**。
   两种判据在 hue=0（正红）上会给出不同结果，而它偏偏是个合法色相。 */
check('没存过颜色 → 按课程名算（老数据零迁移：升级后现有课表的颜色一个都不变）',
  global.ScheduleApp.hueOfCourse({ name: '高等数学' }) === global.ScheduleApp.hueOf('高等数学') &&
  global.ScheduleApp.hueOfCourse({ name: '高等数学', hue: null }) === global.ScheduleApp.hueOf('高等数学') &&
  global.ScheduleApp.hueOfCourse({ name: '高等数学', hue: '' }) === global.ScheduleApp.hueOf('高等数学') &&
  global.ScheduleApp.hueOfCourse({ name: '高等数学', hue: 'abc' }) === global.ScheduleApp.hueOf('高等数学'));
check('存过颜色 → 用课程自己存的（字符串数字也认，越界归一化）',
  global.ScheduleApp.hueOfCourse({ name: 'x', hue: 158 }) === 158 &&
  global.ScheduleApp.hueOfCourse({ name: 'x', hue: '342' }) === 342 &&
  global.ScheduleApp.hueOfCourse({ name: 'x', hue: 400 }) === 40);
check('hue = 0 也算「存过」（0 是合法的正红，不能被当成「没存」）',
  global.ScheduleApp.storedHue({ name: 'x', hue: 0 }) === 0 &&
  global.ScheduleApp.hueOfCourse({ name: 'x', hue: 0 }) === 0 &&
  global.ScheduleApp.storedHue({ name: 'x' }) === null);

check('卡片把算好的色相写进内联样式（渲染与表单回显共用同一个判据）',
  new RegExp('class="course"[^>]*--h:' + global.ScheduleApp.hueOfCourse(S.courses[0])).test(html));

check('自动色池被 12 档代表色相完全覆盖，且有序无重复（HUE_CHOICES 现在只作测试夹具）',
  Store.HUES.every(function (h) { return Store.HUE_CHOICES.indexOf(h) >= 0; }) &&
  Store.HUE_CHOICES.length === Store.HUES.length + 4 &&
  Store.HUE_CHOICES.every(function (h, i, a) { return i === 0 || a[i - 1] < h; }));

/* ---- 自定义颜色（v1.9.6）----
   取色器给出的是 #RRGGBB，所以判据、回退、往返都要重新钉一遍。 */
const App = global.ScheduleApp;

check('自定义色值优先于色相（同一门课两个键都在时，用用户自己挑的那个）',
  App.courseColor({ name: 'x', color: '#1149A6', hue: 212 }) === '#1149A6' &&
  App.courseBg({ name: 'x', color: '#1149A6', hue: 212 }) === '#1149A6');
check('v1.9.5 只存了色相的老数据 → 折算成等价色值（升级后颜色一个都不变）',
  App.courseColor({ name: 'x', hue: 212 }) === Store.cardHex(212) &&
  App.courseColor({ name: 'x', hue: 0 }) === Store.cardHex(0));
check('自定义色值大小写 / 带不带 # 都认，认不出来的回退（不把坏值塞进 style）',
  App.courseColor({ name: 'x', color: '#1149a6' }) === '#1149A6' &&
  App.courseColor({ name: 'x', color: '1149A6' }) === '#1149A6' &&
  App.courseColor({ name: 'x', color: 'red' }) === null &&
  App.courseColor({ name: 'x', color: '#1149A' }) === null &&
  App.courseColor({ name: 'x', color: 123 }) === null);
check('认不出的自定义色不会顶掉按课程名算出来的色（回退链路完整）',
  App.courseBg({ name: '高等数学', color: 'oops' }) === Store.cardBg(App.hueOf('高等数学')) &&
  Store.cardBg(App.hueOf('高等数学')) === App.courseBg({ name: '高等数学' }) &&
  App.courseColor({ name: '高等数学' }) === null &&
  App.courseColor({ name: '高等数学', color: 'oops' }) === null);

/* 取色器要在「方块上的坐标」与「#RRGGBB」之间来回换算，往返必须严格无损，
   否则每拖一下颜色就漂一点、松手和按住看到的色不一样。 */
const RT = ['#1149A6', '#E3251F', '#46E6C2', '#FFFFFF', '#000000', '#7F7F7F', '#0A0B0C'];
check('HSV ↔ 色值 往返无损（拖完松手，颜色不会漂）',
  RT.every(function (x) {
    var v = Store.hexHsv(x);
    return v && Store.hsvHex(v.h, v.s, v.v) === Store.normalizeHex(x);
  }));
check('灰阶（饱和度 0）也往返得回来，色相不会被算成 NaN',
  (function () {
    var v = Store.hexHsv('#808080');
    return v && v.s === 0 && isFinite(v.h) && Store.hsvHex(v.h, v.s, v.v) === '#808080';
  })());
check('色值归一只认 6 位十六进制，其余一律 null（含 3 位缩写与英文色名）',
  Store.normalizeHex('#1149A6') === '#1149A6' &&
  Store.normalizeHex(' 1149a6 ') === '#1149A6' &&
  Store.normalizeHex('#abc') === null &&
  Store.normalizeHex('#1149A67') === null &&
  Store.normalizeHex('blue') === null &&
  Store.normalizeHex(null) === null);
check('自定义色的白字对比度算得出来（取色器里那句提示靠它）',
  Math.abs(Store.hexContrast('#000000') - 21) < 0.01 &&
  Math.abs(Store.hexContrast('#FFFFFF') - 1) < 0.01 &&
  Math.abs(Store.hexContrast('#1149A6') - 8.31) < 0.05 &&
  Store.hexContrast('nope') === null);
check('cardHex 与 cardBg 说的是同一个颜色（取色器起点 = 卡片现在长什么样）',
  (function () {
    var l = Store.cardLight(212);
    var viaHsl = Store.rgbHex(Store.hslToRgb(212, Store.CARD_SAT, l));
    return Store.cardHex(212) === viaHsl && /^#[0-9A-F]{6}$/.test(Store.cardHex(212));
  })());
check('饱和度与参考图同档（0.86，原来是偏灰的 0.55，v1.9.6 的 0.78 还是差一点）',
  Math.abs(Store.CARD_SAT - 0.86) < 1e-9);

const F = Store.HUE_CHOICES.map(function (h) { return Store.cardHex(h); });
check('12 档色相折算出来的色值互不相同（没有两门课撞成同一个色）',
  F.every(function (x, i) { return F.indexOf(x) === i; }));

check('表单里是「一个调色盘 + 一个自动」，不再是排一屏色点',
  /id="btnPickColor"/.test(htmlSrc) && /id="btnAutoColor"/.test(htmlSrc) &&
  !/id="addHues"/.test(htmlSrc) &&
  /\.color-pick \{/.test(css) && /\.color-auto \{/.test(css) &&
  /* 彩虹环是「这里能选颜色」的唯一提示，不能省 */
  /conic-gradient/.test(css));
check('调色盘中间那块显示当前实际会用的颜色（自动时也显示按课名算的色）',
  /pick\.style\.setProperty\('--bg'/.test(appjs) &&
  /isAuto \? autoHex\(\) : formColor/.test(appjs) &&
  /function autoHex[\s\S]{0,200}?Store\.cardHex\(hueOf\(/.test(appjs));
check('两个按钮的选中态都只是切 class（不重建 DOM，重建会打断按下的反馈）',
  /function syncColorRow/.test(appjs) &&
  /pick\.className = 'color-pick' \+ \(isAuto \? '' : ' is-on'\)/.test(appjs) &&
  /auto\.className = 'color-auto' \+ \(isAuto \? ' is-on' : ''\)/.test(appjs));
check('课名一改、自动色跟着刷新（否则圆圈里还是上一门课的颜色）',
  /\$\('addName'\)\.addEventListener\('input'[\s\S]{0,120}?if \(formColor === null\) syncColorRow\(\)/.test(appjs));

check('保存时 color 与 hue 都显式写：color 记自定义色，hue 一律清成 null',
  /color: formColor/.test(appjs) &&
  /hue: null/.test(appjs) &&
  !/hue: formHue/.test(appjs) &&
  /formColor = courseColor\(c\)/.test(appjs) &&
  /formColor = null;/.test(appjs) &&
  /for \(var k in fields\)/.test(appjs));

/* ---- 取色器弹层 ---- */
check('取色器是子弹层：进来前先收表单，退回去时表单亮回来（BULLET_BACK 在册）',
  /maskColor: backToAdd/.test(appjs) &&
  /function backToAdd\(\)[\s\S]{0,160}?closeMask\('maskColor'\);[\s\S]{0,60}?openMask\('maskAdd'\)/.test(appjs) &&
  /function openColorPicker[\s\S]{0,900}?closeMask\('maskAdd'\)[\s\S]{0,120}?openMask\('maskColor'\)/.test(appjs));
check('取色器三个出口走同一条路（取消 / 保存 / 返回键与点外部都退回表单）',
  /\$\('btnCpCancel'\)\.addEventListener\('click', backToAdd\)/.test(appjs) &&
  /function saveColorPick[\s\S]{0,200}?backToAdd\(\)/.test(appjs));
check('取色器从一个「用户看得见的颜色」起步，不是一个凭空默认值',
  /function openColorPicker[\s\S]{0,200}?var start = formColor \|\| autoHex\(\)/.test(appjs) &&
  /Store\.hexHsv\(start\)/.test(appjs));
check('方块与色相条都能拖，触摸与鼠标两条分支都在（真机只走触摸）',
  (appjs.match(/bindPick\(\$\('cpArea'\)/g) || []).length === 1 &&
  (appjs.match(/bindPick\(\$\('cpHueBar'\)/g) || []).length === 1 &&
  /addEventListener\('mousedown'/.test(appjs) &&
  /addEventListener\('touchstart'/.test(appjs) &&
  /touchmove'[\s\S]{0,220}?passive: false/.test(appjs));
check('拖的是方块本身，两个指示点不接事件（接了就变成「压住圆点反而拖不动」）',
  /\.cp-dot \{[\s\S]{0,320}?pointer-events: none/.test(css) &&
  /\.cp-hue-dot \{[\s\S]{0,320}?pointer-events: none/.test(css));
check('色值可以直接敲，但敲到合法才生效（半截输入不当真）',
  /\$\('cpHex'\)\.addEventListener\('input'[\s\S]{0,160}?var ok = Store\.normalizeHex\(this\.value\);\s*\n\s*if \(!ok\) return;/.test(appjs) &&
  /addEventListener\('blur'[\s\S]{0,120}?this\.value = cpHexValue/.test(appjs));
check('自定义色不自动调明度，所以取色器必须把「看不看得清」说出来',
  /Store\.hexContrast\(cpHexValue\)/.test(appjs) &&
  /* 阈值跟着卡片配色走（v1.9.7）：默认色本身就是鲜艳档（对比度最低 1.35），
     再拿 4.5 当分界就会「默认色都在报警」。现在是「低于兜底线才报警」。 */
  /c >= 2 \? '' :/.test(appjs) &&
  /c >= 1\.35 \? /.test(appjs) &&
  /\.cp-tip \{/.test(css) &&
  /\.cp-preview \{/.test(css));
check('自定义色按用户挑的原样用，不被悄悄改掉（改了他会发现「我选的色变了」）',
  /function courseBg[\s\S]{0,160}?return col \? col : Store\.cardBg/.test(appjs));


console.log('\n[12] 切周后纵向位置固定在第 1-8 节');
// 回归：曾经切周会调用 scrollToNow() 自动定位到当前时间所在节次，
// 导致下午滑到下一周时视图停在 5-12 节，必须手动上滑才能看到 1-4 节。
const gw = global.document.getElementById('gridWrap');
S.viewWeek = 3;
gw.scrollTop = 420;                       // 模拟用户已下滑到 5-12 节
global.ScheduleApp.goWeek(4, 'left');
check('左滑切到下一周后滚动位置归零', gw.scrollTop === 0, String(gw.scrollTop));
gw.scrollTop = 300;
global.ScheduleApp.goWeek(3, 'right');
check('右滑切回上一周后滚动位置同样归零', gw.scrollTop === 0, String(gw.scrollTop));
check('切换周次不再自动定位到当前时间节次', !/scrollToNow\s*\(/.test(appjs) && !/function\s+scrollToNow/.test(appjs));
check('goWeek 内改为回到顶部', /function goWeek[\s\S]{0,220}scrollToTop\(\)/.test(appjs));
check('启动/旋转/「本周」也统一回到顶部', (appjs.match(/scrollToTop\(\)/g) || []).length >= 5);

console.log('\n[13] 课表格式自动识别（按文件头，不依赖扩展名）');
require(path.join(root, 'web', 'js', 'xls.js'));
require(path.join(root, 'web', 'js', 'pdf.js'));
require(path.join(root, 'web', 'js', 'importer.js'));

const Import = global.ImportUtil;
const fixture = p => new Uint8Array(fs.readFileSync(path.join(root, 'tools', 'fixtures', p)));

/* ---------- 隐私词表 + 「把容器里压着的字节摊开」----------
   真词不进仓库：本机有 `tools/privacy-words.local.txt` 才有效，没有返回 []
   （别人 clone 后这两组都打印「跳过」，测试照样全绿）。 */
const privacyWords = (function () {
  const p = path.join(root, 'tools', 'privacy-words.local.txt');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s && s.charAt(0) !== '#'; });
})();

/* 一个词要在三种编码下都比：`.xls`（BIFF8 的 SST）与 `.pdf`（UCS2 串）里字符串
   是 UTF-16，只按 UTF-8 读二进制会「查不出」—— 假绿过一次。 */
function privacyEnc(w) {
  const le = Buffer.from(w, 'utf16le');
  const be = Buffer.from(le); be.swap16();
  return [Buffer.from(w, 'utf8'), le, be];
}
function privacyHit(buf, w) {
  return privacyEnc(w).some(function (n) { return buf.indexOf(n) >= 0; });
}

/* 把「容器里真正装着的字节」摊开：PDF 的 Flate 内容流、xlsx 的 zip 条目。
   ⚠️ 不摊开就只扫得到压缩后的乱码 —— 判据全绿、而文件里满是明文（真踩过）。
   另一类假绿它治不了：名字被字宽**切成两个字面串**时，摊开也扫不到，
   那种得靠「解析出来的文本」那把尺子（解析器会拼回来）。 */
function privacyLayers(buf) {
  const out = [buf];
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') {
    /* ⚠️ 这里必须**纯字节**扫描：`/re/.exec(buffer)` 会先把 Buffer 按 UTF-8
       转成字符串再匹配，拿到的偏移是**字符**索引 —— 拿去 slice 字节就错位、
       解压必然失败，于是「摊开」这一步静默少解一层、下面那条断言假绿。 */
    const S = Buffer.from('stream');
    const E = Buffer.from('endstream');
    const isWord = function (c) {
      return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
        || (c >= 0x30 && c <= 0x39) || c === 0x5f;
    };
    let i = 0;
    while ((i = buf.indexOf(S, i)) >= 0) {
      if (i > 0 && isWord(buf[i - 1])) { i += S.length; continue; }   // endstream
      let s = i + S.length;
      if (buf[s] === 0x0d) s++;
      if (buf[s] === 0x0a) s++;
      const e = buf.indexOf(E, s);
      if (e < 0) break;
      try { out.push(zlib.inflateSync(buf.slice(s, e))); } catch (_) { /* 不是 Flate 流 */ }
      i = e + E.length;
    }
  }
  if (buf.slice(0, 2).toString('latin1') === 'PK') {
    const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    let i = buf.indexOf(sig);
    while (i >= 0) {
      const method = buf.readUInt16LE(i + 8);
      const compSize = buf.readUInt32LE(i + 18);
      const start = i + 30 + buf.readUInt16LE(i + 26) + buf.readUInt16LE(i + 28);
      if (compSize > 0) {
        const blob = buf.slice(start, start + compSize);
        try { out.push(method === 8 ? zlib.inflateRawSync(blob) : blob); } catch (_) { /* 该项没压过 */ }
      }
      i = buf.indexOf(sig, i + 4);
    }
  }
  return out;
}

check('OLE2 文件头 -> xls', Import.sniff(fixture('教务处课表.xls')) === 'xls');
check('ZIP 文件头 -> xlsx', Import.sniff(fixture('教务处课表.xlsx')) === 'xlsx');
check('%PDF 文件头 -> pdf', Import.sniff(fixture('教务系统课表.pdf')) === 'pdf');
check('纯文本 -> csv', Import.sniff(new Uint8Array(Buffer.from('课程名称,星期\n高等数学,1'))) === 'csv');

/* ---------- 异步：真实文件端到端解析 ---------- */
(async function () {
  console.log('\n[14] 教务处 Excel 课表（.xls）解析');
  const xlsRes = await Promise.resolve(global.XlsUtil.parse(fixture('教务处课表.xls'), settings));
  check('.xls 解析无错误', xlsRes.errors.length === 0, JSON.stringify(xlsRes.errors));
  check('.xls 解析出课程', xlsRes.courses.length >= 14, xlsRes.courses.length);

  const W = ['一', '二', '三', '四', '五', '六', '日'];
  const weekNames = ['Linux系统管理', '路由与交换技术', '计算机组成原理与接口技术', '软件工程',
    '软件工程课程设计', '德育与班主任工作', '中国特色现代职业教育体系概论', '形势与政策（五）'];
  const got = [...new Set(xlsRes.courses.map(c => c.name))];
  check('.xls 识别出全部 8 门课程', weekNames.every(n => got.includes(n)), got.join('/'));

  const linux = xlsRes.courses.find(c => c.name === 'Linux系统管理');
  check('.xls 节次正确（周一 1-2 节）', linux && linux.day === 1 && linux.start === 1 && linux.end === 2,
    linux ? W[linux.day - 1] + ' ' + linux.start + '-' + linux.end : '未找到');
  check('.xls 地点正确', linux && /明理（5）-401/.test(linux.location), linux && linux.location);
  check('.xls 教师正确', linux && linux.teacher === '李明', linux && linux.teacher);
  check('.xls 单双周正确（2-16周(双) -> 偶数周）',
    linux && linux.weeks.join(',') === '2,4,6,8,10,12,14,16', linux && linux.weeks.join(','));
  const odd = xlsRes.courses.find(c => c.name === '路由与交换技术' && c.day === 1 && c.start === 3);
  check('.xls 单周正确（周一 3-4 节 1-15周(单) -> 奇数周）',
    odd && odd.weeks.join(',') === '1,3,5,7,9,11,13,15', odd && odd.weeks.join(','));
  check('.xls 无固定时间的实践课程会给出提示而非静默丢弃',
    xlsRes.notes.some(n => /劳动教育/.test(n)), JSON.stringify(xlsRes.notes));

  console.log('\n[15] 教务系统 PDF 课表解析');
  const pdfRes = await global.PdfUtil.parse(fixture('教务系统课表.pdf'), settings);
  check('PDF 解析无错误', pdfRes.errors.length === 0, JSON.stringify(pdfRes.errors));
  check('PDF 解析出课程', pdfRes.courses.length >= 14, pdfRes.courses.length);
  check('PDF 页眉姓名被识别', /林晓东/.test(pdfRes.source || ''), pdfRes.source);
  const pdfNames = [...new Set(pdfRes.courses.map(c => c.name))];
  check('PDF 识别出全部 8 门课程', weekNames.every(n => pdfNames.includes(n)), pdfNames.join('/'));
  const pLinux = pdfRes.courses.find(c => c.name === 'Linux系统管理' && c.day === 1);
  check('PDF 节次/地点/教师正确',
    pLinux && pLinux.start === 1 && pLinux.end === 2 && /明理（5）-401/.test(pLinux.location) && pLinux.teacher === '李明',
    pLinux ? [pLinux.start, pLinux.location, pLinux.teacher].join('|') : '未找到');
  check('PDF 跨页折行的教室名完整（未被截断）',
    pdfRes.courses.every(c => !/[（(]$/.test(c.location || '')), JSON.stringify(pdfRes.courses.map(c => c.location)));
  check('PDF 星期列归属正确（周三路由与交换技术在 1-2 节）',
    pdfRes.courses.some(c => c.name === '路由与交换技术' && c.day === 3 && c.start === 1));

  console.log('\n[16] 统一入口（自动识别 + 合并 + 去重）');
  const uni = await Import.parseBuffer(fixture('教务处课表.xls'), '教务处课表.xls', settings);
  check('统一入口能识别 .xls 并给出来源', uni.format === 'xls' && /教务处/.test(uni.source), uni.source);
  check('相邻节次自动合并（周二 软件工程课程设计 1-2 + 3-4 -> 1-4）',
    uni.courses.some(c => c.name === '软件工程课程设计' && c.day === 2 && c.start === 1 && c.end === 4),
    JSON.stringify(uni.courses.filter(c => c.name === '软件工程课程设计').map(c => c.day + ':' + c.start + '-' + c.end)));
  check('合并后与 PDF 课表条目数一致（14 条）', uni.courses.length === 14, uni.courses.length);
  check('总周数超出设置时会给出建议', uni.suggestTotalWeeks === 0 || uni.suggestTotalWeeks >= 16, uni.suggestTotalWeeks);

  const dupTest = Import.mergeAdjacent([
    { id: 'a', name: 'X', day: 1, start: 1, end: 2, teacher: 'T', location: 'L', weeks: [1, 2], weeksText: '1-2' },
    { id: 'b', name: 'X', day: 1, start: 3, end: 4, teacher: 'T', location: 'L', weeks: [1, 2], weeksText: '1-2' },
    { id: 'c', name: 'X', day: 1, start: 5, end: 6, teacher: 'T', location: 'L', weeks: [3, 4], weeksText: '3-4' }
  ]);
  check('mergeAdjacent：相邻同课合并、周次不同不合并', dupTest.length === 2, dupTest.length);
  check('mergeAdjacent：合并后跨度为 1-4 节', dupTest[0].start === 1 && dupTest[0].end === 4,
    dupTest[0].start + '-' + dupTest[0].end);

  const xlsxRes = await Import.parseBuffer(fixture('教务处课表.xlsx'), '教务处课表.xlsx', settings);
  check('.xlsx（zip+XML）也能解析', xlsxRes.format === 'xlsx' && xlsxRes.courses.length >= 10, xlsxRes.courses.length);

  /* ---------- 夹具脱敏：两把尺子 ----------
     夹具（`tools/fixtures/`）是随仓库一起公开的，里面的真实姓名 / 楼栋
     一个都不许剩。**只用一把尺子一定会漏**，两条都真踩过：
       · 只扫文件字节 → PDF / xlsx 的内容是压过的，任何编码的字节比对都命不中
         （全绿，而文件里满是明文）
       · 只扫解析结果 → 解析器没读出来的字段（某门课的教师列压根没进结果）照样漏
     所以两把都上，各配一条哨兵（否则「空集合恒绿」会再把假绿装回去）。 */
  if (!privacyWords.length) {
    check('未配置本地隐私词表（tools/privacy-words.local.txt）→ 夹具脱敏这组跳过', true,
      '跳过：别人 clone 后本来就该是这样');
  } else {
    const fxText = JSON.stringify({ xls: xlsRes, pdf: pdfRes, xlsx: xlsxRes });
    check('哨兵：三个夹具解析出来的文本够长（为空则下面那条会假绿）',
      fxText.length > 2000, fxText.length + ' 字符');
    const hitText = privacyWords.filter(function (w) { return fxText.indexOf(w) >= 0; });
    check('三个夹具「解析出来的内容」里不出现隐私词表里的词', hitText.length === 0, hitText.join('、'));

    const hitDeep = [];
    const layerInfo = [];
    ['教务处课表.xls', '教务处课表.xlsx', '教务系统课表.pdf', '示例课表.csv'].forEach(function (f) {
      const buf = fs.readFileSync(path.join(root, 'tools', 'fixtures', f));
      const layers = privacyLayers(buf);
      layerInfo.push(f + ':' + layers.length);
      layers.forEach(function (seg, i) {
        privacyWords.forEach(function (w) {
          if (privacyHit(seg, w)) hitDeep.push(f + '#L' + i + ':' + w);
        });
      });
    });
    check('哨兵：压缩容器确实被摊开了（PDF 的 Flate 流 / xlsx 的 zip 条目）',
      (function () {
        const kv = {};
        layerInfo.forEach(function (s) { const p = s.split(':'); kv[p[0]] = +p[1]; });
        return kv['教务系统课表.pdf'] >= 3 && kv['教务处课表.xlsx'] >= 2;
      })(),
      layerInfo.join(' '));
    check('三个夹具「压着的字节摊开之后」也不出现（这一层专治压缩容器的假绿）',
      hitDeep.length === 0, hitDeep.slice(0, 8).join('、'));
  }

  const csvRes = await Import.parseBuffer(
    new Uint8Array(fs.readFileSync(path.join(root, 'tools', 'fixtures', '示例课表.csv'))), '示例课表.csv', settings);
  check('CSV 走同一入口且结果一致', csvRes.format === 'csv' && csvRes.courses.length === 15, csvRes.courses.length);

  const badRes = await Import.parseBuffer(
    new Uint8Array(Buffer.from('这不是课表')), 'x.txt', settings);
  check('非课表文件给出可读提示而非抛异常',
    badRes.courses.length === 0 && badRes.errors.length > 0, JSON.stringify(badRes.errors));

  console.log('\n[17] 多课表：切换 / 新建 / 重命名 / 复制 / 删除 / 隔离性');
  // 启动时是 v1 旧数据，应自动迁移成一个课表
  check('旧版单课表数据自动迁移为 1 个课表', Store.list().length === 1, Store.list().length);
  check('迁移后课表名称为「我的课表」', Store.current().name === '我的课表', Store.current().name);
  check('迁移后课程数与原数据一致', Store.current().courses.length === parsed.courses.length,
    Store.current().courses.length);

  const firstId = Store.state.activeId;
  const firstCount = Store.current().courses.length;
  const firstWeeks = Store.current().settings.totalWeeks;

  // 新建一个课表（模拟「大三下」）
  const second = Store.create('大三下');
  Store.setActive(second.id);
  check('新建后课表数量为 2', Store.list().length === 2, Store.list().length);
  check('新建的课表是空课表', Store.current().courses.length === 0, Store.current().courses.length);
  check('当前课表已切换到「大三下」', Store.current().name === '大三下', Store.current().name);

  // 核心：两个课表互不影响
  check('新课表为空不影响原课表课程数', Store.get(firstId).courses.length === firstCount,
    Store.get(firstId).courses.length);
  Store.current().settings.totalWeeks = 12;
  check('每个课表的学期设置相互独立',
    Store.get(firstId).settings.totalWeeks === firstWeeks && Store.current().settings.totalWeeks === 12,
    Store.get(firstId).settings.totalWeeks + '/' + Store.current().settings.totalWeeks);

  // 通过顶栏切换器切回第一个课表
  global.ScheduleApp.switchTo(firstId);
  check('switchTo 能切回原课表', Store.state.activeId === firstId, Store.state.activeId);
  check('切回后原课表课程仍是 ' + firstCount + ' 门',
    Store.get(firstId).courses.length === firstCount, Store.get(firstId).courses.length);
  check('切换课表后课表名同步到顶栏',
    els.curSchedName.textContent === '我的课表', els.curSchedName.textContent);

  // 重命名
  check('重命名成功', Store.rename(firstId, '大三上') === true);
  check('重命名后名称生效', Store.get(firstId).name === '大三上', Store.get(firstId).name);
  check('空名称会被拒绝', Store.rename(firstId, '   ') === false);

  // 复制
  const copy = Store.duplicate(firstId);
  check('复制课表成功', !!copy && copy.id !== firstId);
  check('副本课程数与源课表一致', copy.courses.length === firstCount, copy.courses.length);
  check('副本课程 id 全部重新生成（不与源共享对象）',
    copy.courses.every(c => !Store.get(firstId).courses.some(o => o.id === c.id)));
  check('副本名称带「副本」', /副本/.test(copy.name), copy.name);

  // 导入到指定课表：先解析一份真实课表，再落库到「大三下」
  global.ScheduleApp.syncImportTarget();
  const uni2 = await Import.parseBuffer(fixture('教务处课表.xls'), '教务处课表.xls', settings);
  global.ScheduleApp.applyImport(uni2);
  check('导入预览给出「覆盖 / 追加」两种落库方式',
    /data-imp="replace"/.test(els.importResult.innerHTML) && /data-imp="append"/.test(els.importResult.innerHTML));

  // 让下拉指向「大三下」（空课表）后提交
  const sel = global.document.getElementById('importTarget');
  sel.value = second.id;
  global.ScheduleApp.commitImport('replace');
  check('导入落到下拉选中的课表，而不是当前课表',
    Store.get(second.id).courses.length > 0 && Store.get(firstId).courses.length === firstCount,
    Store.get(second.id).courses.length + '/' + Store.get(firstId).courses.length);
  check('导入后自动切换到目标课表', Store.state.activeId === second.id, Store.state.activeId);

  /* —— v1.9.39 · 导入的课必须带 id ——
     卡片详情是 `data-id` → findCourse(id) 打开的；解析层一律给 id: null
     （adapter-import.js 写着「由 Store 侧补」），而 Store 侧以前**谁也没补**。
     症状不是报错，是「点卡片没反应」—— 所以必须钉在落库这一环。

     刻意**自己造一份 `id: null` 的课程**（交割给 commitImport 的正是这个形状），
     不去翻环境里已有的课：那些可能已经被上面的「载入兜底」补过 id 了，
     断言会假绿（写这条时真踩到过：红2 只红了源码那条，运行期那条没红）。 */
  const idProbe = Store.create('id 探针');
  global.document.getElementById('importTarget').value = idProbe.id;
  global.ScheduleApp.applyImport({
    format: 'adapter', source: '探针', courses: [
      { id: null, name: '探针甲', teacher: 'T', location: 'A101', day: 1, start: 1, end: 2, weeks: [1, 2] },
      { id: null, name: '探针乙', teacher: 'T', location: 'A102', day: 3, start: 5, end: 6, weeks: [1, 2] }
    ], errors: [], notes: [], settings: null
  });
  global.ScheduleApp.commitImport('replace');
  const probeCourses = Store.get(idProbe.id).courses;
  check('导入落库的每门课都补上了 id（解析层给的是 id: null）',
    probeCourses.length === 2 &&
    probeCourses.every(c => typeof c.id === 'string' && c.id.length > 0),
    probeCourses.map(c => String(c.id)).join(','));
  check('导入的课程 id 互不重复',
    new Set(probeCourses.map(c => c.id)).size === probeCourses.length);
  S.viewWeek = 1;
  global.ScheduleApp.render();
  const gridHtmlId = els.schedule.innerHTML;
  check('课表上每张卡片都带非空 data-id（空 data-id = 点了没反应）',
    (gridHtmlId.match(/class="course"/g) || []).length === 2 &&
    /class="course" data-id="c/.test(gridHtmlId) &&
    !/data-id="(undefined|null|)"/.test(gridHtmlId));
  Store.remove(idProbe.id);
  Store.setActive(second.id);
  global.document.getElementById('importTarget').value = second.id;

  // 删除：此时共有 3 个课表（大三上 / 大三下 / 大三上 副本）
  check('删除非当前课表成功', Store.remove(copy.id) === true);
  check('删除副本后剩余 2 个课表', Store.list().length === 2, Store.list().length);
  check('删除非当前课表不影响当前选择', Store.state.activeId === second.id, Store.state.activeId);

  // 删除「当前课表」应自动切到剩下的那个
  global.ScheduleApp.switchTo(firstId);
  check('删除当前课表成功', Store.remove(firstId) === true);
  check('删除当前课表后自动切到剩下的课表', Store.state.activeId === second.id, Store.state.activeId);
  check('删除后仅剩 1 个课表', Store.list().length === 1, Store.list().length);
  check('最后一个课表不允许删除（否则 App 会没有课表可用）',
    Store.remove(second.id) === false);

  // 持久化：结构应为 v2，且能再次载入
  const saved = JSON.parse(store[Store.KEY]);
  check('落盘结构为 v2（含 schedules / prefs）',
    saved.version === 2 && Array.isArray(saved.schedules) && saved.schedules.length === 1,
    saved.version);
  check('落盘含 activeId', typeof saved.activeId === 'string' && saved.activeId === second.id);
  check('落盘保留主题偏好', saved.prefs && typeof saved.prefs.theme === 'string',
    saved.prefs && saved.prefs.theme);

  const beforeName = Store.current().name;
  const beforeCount = Store.current().courses.length;
  Store.load();                                  // 模拟重新打开 App
  check('重新载入后课表与课程都还在',
    Store.list().length === 1 && Store.current().name === beforeName &&
    Store.current().courses.length === beforeCount,
    Store.current().name + '/' + Store.current().courses.length);

  /* 老数据兜底（v1.9.39）：把盘里课程的 id 抹掉再载入，装上新版必须自愈 ——
     不能要求用户「重新导入一遍」才点得开。 */
  {
    const rawNoId = JSON.parse(store[Store.KEY]);
    rawNoId.schedules[0].courses.forEach(c => { delete c.id; });
    store[Store.KEY] = JSON.stringify(rawNoId);
    Store.load();
    check('载入时给缺 id 的老课程补上 id（老用户不必重新导入）',
      Store.current().courses.length > 0 &&
      Store.current().courses.every(c => typeof c.id === 'string' && c.id.length > 0),
      Store.current().courses.map(c => String(c.id)).join(','));
  }

  console.log('\n[18] 白天模式 / 夜晚模式');
  const css2 = fs.readFileSync(path.join(root, 'web', 'css', 'app.css'), 'utf8');

  Store.setTheme('dark');
  global.ScheduleApp.applyTheme();
  check('切到夜晚模式后 <html data-theme="dark">',
    global.document.documentElement.getAttribute('data-theme') === 'dark',
    global.document.documentElement.getAttribute('data-theme'));

  Store.setTheme('light');
  global.ScheduleApp.applyTheme();
  check('切到白天模式后 <html data-theme="light">',
    global.document.documentElement.getAttribute('data-theme') === 'light');

  Store.setTheme('auto');
  global.ScheduleApp.applyTheme();
  check('「跟随系统」按系统偏好解析（测试环境为浅色 -> light）',
    global.document.documentElement.getAttribute('data-theme') === 'light' &&
    Store.theme() === 'auto');

  Store.setTheme('dark');
  global.ScheduleApp.toggleTheme();
  check('顶栏按钮可从夜晚切回白天', Store.theme() === 'light', Store.theme());
  global.ScheduleApp.toggleTheme();
  check('顶栏按钮可再切到夜晚', Store.theme() === 'dark', Store.theme());

  check('非法主题值回退为「跟随系统」', Store.setTheme('rainbow') === 'auto');

  check('CSS 用 data-theme 属性选择器驱动主题',
    /:root\[data-theme="dark"\]/.test(css2) && /:root\[data-theme="light"\]/.test(css2));
  check('CSS 不再依赖 prefers-color-scheme 决定主题色',
    !/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[\s\S]{0,400}--bg/.test(css2));
  check('两套主题令牌都定义了 --bg / --surface / --ink',
    (css2.match(/--bg:/g) || []).length >= 2 &&
    (css2.match(/--surface:/g) || []).length >= 2 &&
    (css2.match(/--ink:/g) || []).length >= 2);
  /* 卡片底色是**不透明的实色**，且两个主题共用一份：
     切主题只该换界面外壳，不该让用户自己选的颜色跟着跳。
     所以这里钉的是「深色主题**没有**覆盖 .course」——与旧版正好相反。 */
  check('卡片底色两个主题共用，深色主题不覆盖它（用户选的颜色不该跟着主题跳）',
    !/:root\[data-theme="dark"\]\s*\.course/.test(css2) &&
    /\.course \{[\s\S]*?background: var\(--bg/.test(css2));
  check('表单控件跟随主题（color-scheme）',
    /color-scheme:\s*light/.test(css2) && /color-scheme:\s*dark/.test(css2));

  /* ---- 品牌色（v1.9.12）----
     主色从「通用蓝 #4a6cf7」换成取自应用图标的**柚子绿**，中性色整体从冷蓝灰调暖。
     这个令牌在代码里**身兼两职**（填充底 + 文字色），所以光钉住 hex 不够，
     还得钉住「两条路都读得清」：白字压在它上面 ≥ 4.5:1、它当文字压在 --surface
     上 ≥ 4.5:1。只钉 hex 的话，哪天有人把它调亮一档，CSS 与渲染都不报错，
     只有真机上「今天」那个日期块糊掉才看得出来。 */
  const cssVar = (block, name) => {
    const m = block.match(new RegExp('--' + name + ':\\s*(#[0-9a-f]{6})', 'i'));
    return m ? m[1].toUpperCase() : '';
  };
  const lightAccent = cssVar(lightBlock, 'accent');
  const darkAccent = cssVar(darkBlock, 'accent');
  const lightSurf = cssVar(lightBlock, 'surface');
  const lightSoft = cssVar(lightBlock, 'accent-soft');
  const darkSurf = cssVar(darkBlock, 'surface');
  /* 复用 store.js 的真函数反推相对亮度，而不是在测试里再抄一份公式 */
  const lumOf = (hex) => 1.05 / global.Store.hexContrast(hex) - 0.05;
  const contrastOf = (a, b) => {
    const la = lumOf(a), lb = lumOf(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  check('主色是品牌柚子绿（白天 #3E7C2E / 夜晚 #8FCB6E），不再是通用蓝',
    lightAccent === '#3E7C2E' && darkAccent === '#8FCB6E',
    lightAccent + ' / ' + darkAccent);
  check('主色恰好声明两处（白天一处、夜晚一处），没有第三处漏网',
    (css2.match(/--accent:/g) || []).length === 2,
    (css2.match(/--accent:/g) || []).length + ' 处');
  check('白字压在白天主色上读得清（≥ 4.5:1）',
    contrastOf('#FFFFFF', lightAccent) >= 4.5,
    contrastOf('#FFFFFF', lightAccent).toFixed(2) + ':1');
  check('白天主色当文字压在 --surface 上读得清（≥ 4.5:1，「今天」的星期标签就是这个组合）',
    contrastOf(lightAccent, lightSurf) >= 4.5,
    contrastOf(lightAccent, lightSurf).toFixed(2) + ':1');
  check('白天主色当文字压在 --accent-soft 上读得清（≥ 4.5:1，顶栏信息片就是这个组合）',
    contrastOf(lightAccent, lightSoft) >= 4.5,
    contrastOf(lightAccent, lightSoft).toFixed(2) + ':1');
  check('夜晚主色在深底上够亮、且配深字读得清（两条都 ≥ 4.5:1）',
    contrastOf(darkAccent, darkSurf) >= 4.5 &&
    contrastOf(darkAccent, cssVar(darkBlock, 'on-accent')) >= 4.5,
    contrastOf(darkAccent, darkSurf).toFixed(2) + ':1 / ' +
    contrastOf(darkAccent, cssVar(darkBlock, 'on-accent')).toFixed(2) + ':1');
  check('中性色已整体调暖（底色不再是冷蓝灰 #eef1f8 / #0f1218）',
    cssVar(lightBlock, 'bg') === '#F5EFE3' && cssVar(darkBlock, 'bg') === '#16130D' &&
    !/#eef1f8|#0f1218/i.test(css2));

  /* 原生侧（内嵌教务浏览器）有一份**镜像** web 令牌的 colors.xml。
     两处漂移是静默的：课表页已经是绿的、教务浏览器里还是蓝的，没人会报错。
     所以这里把两边读出来逐值比 —— 顺带也是「改了 web 令牌忘了改原生」的哨兵。 */
  const mirrorOf = (xml, name) =>
    (xml.match(new RegExp('name="' + name + '">(#[0-9A-Fa-f]{6})<')) || [])[1] || '';
  const androidLightXml = fs.readFileSync(path.join(
    root, 'android', 'app', 'src', 'main', 'res', 'values', 'colors.xml'), 'utf8');
  const androidNightXml = fs.readFileSync(path.join(
    root, 'android', 'app', 'src', 'main', 'res', 'values-night', 'colors.xml'), 'utf8');
  const MIRROR = [['bg', 'edu_bg'], ['surface', 'edu_surface'], ['surface-2', 'edu_surface2'],
    ['ink', 'edu_ink'], ['ink-2', 'edu_ink2'], ['line', 'edu_line'],
    ['accent', 'edu_accent'], ['on-accent', 'edu_on_accent']];
  const driftOf = (block, xml) => MIRROR
    .filter(([v, res]) => cssVar(block, v) !== mirrorOf(xml, res).toUpperCase())
    .map(([v]) => v);
  const driftDay = driftOf(lightBlock, androidLightXml);
  const driftNight = driftOf(darkBlock, androidNightXml);
  check('Android 白天 colors.xml 与 web 主题令牌逐值一致（教务浏览器不能还停在旧配色）',
    driftDay.length === 0, driftDay.join(',') || 'ok');
  check('Android 夜晚 colors.xml 与 web 主题令牌逐值一致',
    driftNight.length === 0, driftNight.join(',') || 'ok');

  check('顶栏有白天 / 夜晚快捷切换按钮', /id="btnTheme"/.test(htmlSrc));
  check('设置里有「跟随系统 / 白天 / 夜晚」三段选择',
    /data-theme="auto"/.test(htmlSrc) && /data-theme="light"/.test(htmlSrc) && /data-theme="dark"/.test(htmlSrc));
  check('首帧前用内联脚本定好主题，避免闪屏',
    /<script>[\s\S]*?data-theme[\s\S]*?<\/script>/.test(htmlSrc.slice(0, htmlSrc.indexOf('</head>'))));
  check('原生侧提供状态栏反色接口（AndroidTheme.setDark）',
    /AndroidTheme/.test(appjs) && /ThemeBridge/.test(kt) && /setDark/.test(kt));

  console.log('\n[19] 顶栏布局：课表切换器不影响周次信息');
  check('顶栏第一行含课表切换器', /class="sched-chip"[\s\S]*?id="curSchedName"/.test(htmlSrc));
  check('课表名超长时省略而不是挤掉周次',
    /\.sched-chip\s*\{[\s\S]*?max-width:\s*112px/.test(css2) &&
    /\.sched-chip\s+\.sc-name\s*\{[\s\S]*?text-overflow:\s*ellipsis/.test(css2));
  check('课表切换器可收缩（flex-shrink 不为 0）',
    /\.sched-chip\s*\{[\s\S]*?flex:\s*0 1 auto/.test(css2));
  check('课表切换器有最小宽度，极窄屏也不会被挤成一个字',
    /\.sched-chip\s*\{[\s\S]*?min-width:\s*58px/.test(css2));
  check('周次与单双周不参与收缩（优先保住它们）',
    /\.tb-line1 \.tb-week,[\s\S]{0,40}\.tb-line1 \.chip\s*\{\s*flex:\s*none/.test(css2));
  check('窄屏（<390dp）日期省掉年份，把空间让给课表名与周次',
    /innerWidth[\s\S]{0,30}<\s*390/.test(appjs));
  check('「共 N 周 / 距开学 N 天」空间不足时自行省略',
    /\.tb-line2 \.term\s*\{[\s\S]*?text-overflow:\s*ellipsis/.test(css2));
  check('开学前隐藏单双周徽标（那里没有单双周可显示）',
    /\.chip\.is-off\s*\{\s*display:\s*none/.test(css2) && /is-off/.test(appjs));

  console.log('\n[20] 从教务系统导入：应用内嵌真浏览器');
  const eduKt = fs.readFileSync(path.join(KT_DIR, 'EduLoginActivity.kt'), 'utf8');
  const manifest = fs.readFileSync(path.join(
    root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  const eduLayout = fs.readFileSync(path.join(
    root, 'android', 'app', 'src', 'main', 'res', 'layout', 'activity_edu.xml'), 'utf8');
  const eduHtmlJs = fs.readFileSync(path.join(root, 'web', 'js', 'edugrab.js'), 'utf8');
  const htmlParserJs = fs.readFileSync(path.join(root, 'web', 'js', 'html.js'), 'utf8');
  const importerJs = fs.readFileSync(path.join(root, 'web', 'js', 'importer.js'), 'utf8');

  check('导入弹层第一个入口是「打开教务系统并导入课表」',
    /id="btnEduImport"/.test(htmlSrc) && htmlSrc.indexOf('btnEduImport') < htmlSrc.indexOf('fileInput'));
  check('页面引入了自研 HTML 解析器与课表提取器',
    /src="js\/html\.js"/.test(htmlSrc) && /src="js\/edugrab\.js"/.test(htmlSrc));
  check('两者在 importer.js 之前加载（解析时才拿得到）',
    htmlSrc.indexOf('js/edugrab.js') < htmlSrc.indexOf('js/importer.js'));
  check('网页嗅探能识破「伪装成 .xls 的 HTML 表格」',
    /<!doctype\\s\+html|<html\[\\s>\]|<table\[\\s>\]/.test(importerJs) ||
    /doctype/.test(importerJs) && /'html'/.test(importerJs));
  check('importer 暴露 parseHtml 入口',
    /function parseHtml/.test(importerJs) && /parseHtml:\s*parseHtml/.test(importerJs));
  /* v1.9.43：回传入口从三个减到两个 —— `onEduHtml` 是自研抓页那条路的入口，
     随它一起拆了。这里翻成反向断言，同时留着**正面**那两条（别把两个都删了
     变成「一个入口都没有」也算过）。 */
  check('app.js 提供原生回传的两个入口 onEduBuffer / onEduAdapter',
    /onEduBuffer:\s*onEduBuffer/.test(appjs) && /onEduAdapter:\s*onEduAdapter/.test(appjs));
  /* 用 appjsNoComment（早就剥好的那份）—— 别在这里现调 stripComments(appjs)：
     一是同一份文件两套剥法容易漂，二是下面那条「app.js 里不许出现内置快照」
     用的也是 appjsNoComment，统一口径。 */
  check('app.js 不再导出 onEduHtml / importHtml（抓整页 HTML 那条路已拆）',
    !/onEduHtml/.test(appjsNoComment) && !/importHtml/.test(appjsNoComment));
  check('网页通过 AndroidEdu 桥打开内嵌浏览器',
    /AndroidEdu/.test(appjs) && /AndroidEdu/.test(kt));
  check('MainActivity 注册了 AndroidEdu 桥并跳转 EduLoginActivity',
    /addJavascriptInterface\(EduBridge\(\),\s*"AndroidEdu"\)/.test(kt) &&
    /EduLoginActivity::class\.java/.test(kt));

  check('内嵌浏览器是独立 Activity', /class EduLoginActivity/.test(eduKt));
  /* ============================================================
     v1.9.43：内嵌浏览器里**只剩一条导入通道**（适配脚本）
     ------------------------------------------------------------
     原来那条「自研抓页」——注入 JS 递归穿透 iframe 抓整页 HTML、经
     @JavascriptInterface 回传、交网页侧 edugrab.js 认课表——整条拆掉了，
     连它底栏那颗「导入课表」按钮与「适应屏幕 / 怎么用」一起。
     留档：留档/课表导入-自研抓页-v1.9.43/。

     ⚠️ 这一节大半是**反向断言**（「某某不再存在」）—— 最容易永远绿。
     所以先钉一条**正面哨兵**：正文真的读进来了、而且有内容。
     哨兵不绿时下面那些负向断言全是假绿，等于没写。
     验红方式只有一个：退回 v1.9.42 的源码跑这一节。
     ============================================================ */
  const eduKtNoComment = ktStripped(eduKt, 'EduLoginActivity.kt');
  check('切出了 EduLoginActivity 正文（哨兵：下面反向断言的假绿守门员）',
    eduKtNoComment.length > 4000 && /class EduLoginActivity/.test(eduKtNoComment),
    eduKtNoComment.length);

  /* 在**剥注释后**的源码里查。删掉的东西只会在墓碑注释里被提到名字 ——
     不剥注释的话，注释自己会把负向断言绊红（写这一节时踩过一次）。 */
  const GONE_FROM_EDU_KT = [
    'CaptureBridge', 'AndroidEduCapture', 'armedToken', 'armCapture', 'disarmCapture',
    'claimArmed', 'probeGrabDiag', 'GRAB_DIAG_JS', 'grabJs', 'grabPage', 'dumpCurrentPage',
    'dumpPage', 'offerShare', 'shareDump', 'openDump', 'showTip', 'frameWarning',
    'looksLikeSchedulePage', 'hasWeekdayHeading', 'showHelp', 'togglePageMode',
    'applyPageMode', 'applyViewportFix', 'btnFit', 'fitWidth',
    'BRIDGE_TIMEOUT_MS', 'MAX_HTML_CHARS', 'VIEWPORT_FIT_JS', 'VIEWPORT_RAW_JS',
    'KEY_FIT_WIDTH', 'forceGrab', 'lastTipKey', 'lastTipAt', 'Dumped'
  ];
  /* ⚠️ 不要往上面加 `BRIDGE_NAME`：它是 `ADAPTER_BRIDGE_NAME` 的子串，
     加进去就是一条恒红的断言。桥名的判据交给 `AndroidEduCapture` 那一条。 */
  const eduLeftovers = GONE_FROM_EDU_KT.filter(function (n) { return eduKtNoComment.indexOf(n) >= 0; });
  check('自研抓页那一套（抓取桥 / 门闩 / 注入 JS / 预检 / 长文案 / 落盘分享 / 显示模式开关）一个都不剩',
    eduLeftovers.length === 0, eduLeftovers.join(', '));

  check('布局里「导入课表」「适应屏幕」「怎么用」三个按钮都没了',
    !/btnEduGrab/.test(eduLayout) && !/btnEduFit/.test(eduLayout) &&
    !/btnEduHelp/.test(eduLayout) &&
    !/btnEduGrab|btnEduFit|btnEduHelp/.test(eduKtNoComment));

  /* 底栏容器**要留着**（承接导航栏 inset），但里面只剩适配条；
     适配条必须排在 WebView **之后** —— 这才是「执行导入下移」的判据。
     只查「xml 里有这个 id」是查不出上下位置反了的。 */
  check('「执行导入」那一栏排到了 WebView 之后（下移到拇指区）',
    eduLayout.indexOf('@+id/eduWebView') >= 0 &&
    eduLayout.indexOf('@+id/eduWebView') < eduLayout.indexOf('@+id/eduAdapterBar'));
  check('顶部三步提示条留在顶部（在 WebView 之前）—— 信息在顶、动作在底',
    eduLayout.indexOf('@+id/eduTipText') >= 0 &&
    eduLayout.indexOf('@+id/eduTipText') < eduLayout.indexOf('@+id/eduWebView'));
  check('底栏容器常驻、里面那栏在没适配脚本时 GONE（容器负责让出导航栏，别跟着一起消失）',
    /id="@\+id\/eduBottom"/.test(eduLayout) &&
    /id="@\+id\/eduAdapterBar"[\s\S]{0,700}?visibility="gone"/.test(eduLayout) &&
    /bottomBar\.setPadding\(bl, bt, br/.test(eduKtNoComment));

  /* —— 页面上唯一的一座桥：适配脚本宿主 ——
     v1.9.24 那条教训（「随用随挂」真机上不成立 ⇒ 桥必须常驻 + 门闩）
     **没有**随抓页那座桥一起消失：它现在写在 setupWebView 的注释里，
     也是下面这几条断言的理由。 */
  const edAddCount = (eduKtNoComment.match(/addJavascriptInterface\(/g) || []).length;
  check('常驻桥**只剩一个**（多挂一个就多一个「任意网页都能调到」的原生入口）',
    edAddCount === 1, 'addJavascriptInterface × ' + edAddCount);

  const setupBlock43 =
    (/private fun setupWebView\(\)[\s\S]*?\n    \}/.exec(eduKtNoComment) || [])[0] || '';
  check('切出了 setupWebView 函数体（哨兵：切不出来下面两条会假绿）',
    setupBlock43.length > 200, setupBlock43.length);
  check('那座桥在 setupWebView 里**常驻**挂上、且用常量引名字（写死字符串会挂桥/注入两边漂移）',
    /addJavascriptInterface\(AdapterHost\(\), ADAPTER_BRIDGE_NAME\)/.test(setupBlock43));
  check('「为什么不能随用随挂」的理由留在注释里（真机踩过，别再被当废话删掉）',
    /不保序/.test(eduKt) && /挂摘时序本身不可靠/.test(eduKt));

  check('适配宿主只暴露一个 host(...) 入口，方法用字符串分派',
    /fun host\(method: String\?, token: String\?, reqId: String\?, args: String\?\)/
      .test(eduKtNoComment));
  check('适配宿主按「这一趟的 token」放行，不作令牌就哑掉**且不给任何反馈**',
    /if \(t != adapterToken\) return/.test(eduKtNoComment));
  /* 光关门闩不够：门闩只挡住原生那一侧，页面手上那份 window.shiguang* 还在，
     等这一趟结束、用户以为过去了，页面脚本还能接着往里灌数据。 */
  check('收尾要连页面上的宿主一起删掉（否则「这一趟结束了」只是我们这边结束了）',
    /delete window\.shiguangBridge/.test(eduKt) &&
    /delete window\.AndroidBridgePromise/.test(eduKt));
  check('全文件不许出现 removeJavascriptInterface —— 一次迟到的 remove 会把常驻桥永久摘掉',
    !/removeJavascriptInterface/.test(eduKtNoComment));
  check('桥名只有一处定义，挂桥 / 注入 shim 两边引用同一个常量',
    /const val ADAPTER_BRIDGE_NAME = "AndroidAdapterHost"/.test(eduKt) &&
    /window\.\$ADAPTER_BRIDGE_NAME\b/.test(eduKt));

  /* 门闩仍然是**令牌**不是布尔量 —— 这条纪律与抓页那条通道无关：
     它保的是「runAdapter 到注入脚本真正执行之间那一次 IPC 往返」，
     布尔量的「先到先得」在那段窗口里挡不住页面脚本抢跑。 */
  check('门闩仍声明成 `@Volatile private var adapterToken: String?`（不是布尔量）',
    /@Volatile\s+private var adapterToken: String\? = null/.test(eduKtNoComment));
  check('一趟一个令牌：runAdapter 现生成 UUID 并写进 adapterToken',
    /val t = UUID\.randomUUID\(\)\.toString\(\)/.test(eduKtNoComment) &&
    /adapterToken = t/.test(eduKtNoComment));
  check('宿主按令牌比对放行，**不是**先到先得',
    /if \(t != adapterToken\) return/.test(eduKtNoComment));

  /* 显示方式固定一档：写死在 setupWebView 里，不许再冒出一个开关。 */
  check('页面显示方式固定「适应屏幕」一档（loadWithOverviewMode 写死 true）',
    /loadWithOverviewMode = true/.test(eduKtNoComment) &&
    !/loadWithOverviewMode = fitWidth/.test(eduKtNoComment));

  /* —— 页面文案不许再指向那颗已经删掉的按钮 ——
     症状很难查：用户会在页面上找一颗永远不会出现的按钮，
     然后说「点了没反应」，而根本没有东西可点。 */
  check('文案里不再出现「导入课表」按钮或「右下角」这种方位指路',
    !/「导入课表」/.test(eduKtNoComment) && !/右下角/.test(eduKtNoComment));
  check('没有适配脚本的学校，第三步指向教务系统自己的「导出 / 下载课表」',
    /private fun stepText/.test(eduKtNoComment) && /导出 \/ 下载课表/.test(eduKt));

  check('大文件走同进程通道而不是 Intent extra',
    /object EduBus/.test(eduKt) && /EduBus\.fileBase64/.test(kt) &&
    !/putExtra\([^)]*html/i.test(eduKt));
  check('EduBus 里**不再有 html 字段**（抓页那条出口连同它的字段一起拆）',
    !/var html: String\?/.test(eduKtNoComment) && !/EduBus\.html/.test(kt));
  check('MainActivity 的回灌只剩两条：适配脚本 / 下载文件',
    /callJs\("onEduAdapter"/.test(kt) && /callJs\("onEduBuffer"/.test(kt) &&
    !/callJs\("onEduHtml"/.test(kt));
  check('超过阈值时分块注入，避免单次脚本过长',
    /JS_CHUNK/.test(kt) && /__eduChunks/.test(kt) && /pushChunks/.test(kt));

  check('JS 字符串转义处理了 U+2028 / U+2029（实现只有一处，两个 Activity 共用）',
    /u2028/.test(eduKt) && /u2029/.test(eduKt) &&
    /internal fun jsQuoteString\(/.test(eduKt) &&
    /private fun jsQuote\(s: String\): String = jsQuoteString\(s\)/.test(kt));
  check('转义实现没有第二份（各写一份必然漂移，症状是「某些校名带引号就炸」）',
    (kt.match(/internal fun jsQuoteString\(/g) || []).length === 0);

  check('支持教务系统「导出课表」的下载',
    /setDownloadListener/.test(eduKt) && /startDownload/.test(eduKt));
  check('下载时带上浏览器会话的 Cookie（否则登录态丢失）',
    /CookieManager\.getInstance\(\)\.getCookie/.test(eduKt));
  check('下载结果以 base64 回传网页侧统一嗅探', /Base64\.encodeToString/.test(eduKt));
  check('下载体积有上限保护', /MAX_DOWNLOAD/.test(eduKt));
  /* v1.9.43：原来还有一条「抓到的页面过大时给出可操作的提示」，
     判据是 MAX_HTML_CHARS —— 那是自研抓页的长度上限，随它一起删了。
     换成正向一条：下载失败时给出的出路必须指向**教务系统自己的导出按钮**，
     而不是已经不存在的那颗按钮。 */
  check('下载失败时指向教务系统自己的「导出 / 下载课表」（不是那颗已删的按钮）',
    /导出 \/ 下载课表/.test(eduKt));

  check('WebView 保持登录态（Cookie / DOM storage）',
    /domStorageEnabled\s*=\s*true/.test(eduKt) && /setAcceptCookie\(true\)/.test(eduKt));
  check('放行混合内容，避免教务站 http 资源白屏',
    /MIXED_CONTENT_ALWAYS_ALLOW/.test(eduKt));

  /* —— v1.9.22 · N2：SSL 错误按类型分流，不再一律 proceed() ——
     原来那句理由（「课表导入是低敏感场景、页面内不输入支付类信息」）说不通：
     用户在这一页输入的正是**教务账号和密码**。更要紧的是，无条件 proceed()
     会把 SSL_IDMISMATCH（证书里的域名和实际访问的域名对不上）一起放行 ——
     那正是中间人攻击的典型特征，不是校园网的常见毛病。 */
  check('SSL 错误不再是「拿到 handler 就放行」的形状',
    /onReceivedSslError/.test(eduKt) && !/handler\?\.proceed\(\)/.test(eduKtNoComment));
  check('证书域名不符（SSL_IDMISMATCH）一律拦下，连「继续」都不给',
    /SslError\.SSL_IDMISMATCH/.test(eduKtNoComment) &&
    /warnSslMismatch\(host\)/.test(eduKtNoComment));
  check('「域名不符」分支里只有 cancel，没有 proceed',
    (() => {
      const seg = (/primaryError == SslError\.SSL_IDMISMATCH[\s\S]{0,160}?return/.exec(eduKtNoComment) || [])[0] || '';
      return seg.length > 0 && seg.indexOf('.cancel()') > 0 && seg.indexOf('.proceed()') < 0;
    })());
  check('自签 / 过期证书先弹窗让用户确认（继续访问 / 取消，v1.9.37 起走自绘底座）',
    /askSslTrust\(host, h\)/.test(eduKtNoComment) &&
    /EduAction\("继续访问"\) \{ resolveSslTrust\(true\) \}/.test(eduKtNoComment) &&
    /EduAction\("取消"\) \{ resolveSslTrust\(false\) \}/.test(eduKtNoComment));
  check('确认过的域名按域名记住，同一个域名不再反复问',
    /fun rememberSslHost\(host: String\)/.test(eduKt) &&
    /getStringSet\(KEY_SSL_HOSTS/.test(eduKt) &&
    /putStringSet\(KEY_SSL_HOSTS/.test(eduKt));
  check('记住的域名有上限，不会无限膨胀', /MAX_SSL_TRUSTED/.test(eduKt));
  check('一页里多个资源同时失败只弹一个窗（同域名的排队等同一个答复）',
    /if \(host == sslAskHost\)/.test(eduKtNoComment) &&
    /sslPending\.add\(handler\)/.test(eduKtNoComment));
  check('proceed() 只剩「用户已确认」与「域名已记住」两条路（恰好 2 处）',
    (eduKtNoComment.match(/\.proceed\(\)/g) || []).length === 2,
    (eduKtNoComment.match(/\.proceed\(\)/g) || []).length);

  /* —— v1.7.1 的三件（显示方式开关 / 抓错页面预检 / 存页面排查）——
     v1.9.43 全删了，这里翻成**反向断言**。
     读的是剥好注释的 `eduKtNoComment`：墓碑注释里为了讲「删了什么」会
     成段出现 `fitWidth`、`looksLikeSchedulePage` 这些名字，用未剥的
     `eduKt` 去查「不许出现」必然被自己的解释绊绿 —— 上面 [v1.9.43] 那节
     已经踩过一次，这里不重复踩。
     下面「UA 恒定」「顶栏放大缩小」「IME insets」三条是**活的**，与抓页无关，
     只是原来跟它们排在一起，一并留下。 */
  check('不再提供 UA 切换：教务只有 PC 版，恒定桌面 UA',
    /UA_DESKTOP/.test(eduKt) && !/UA_MOBILE/.test(eduKt));
  check('显示方式固定一档：整页缩放到屏宽（不再有「适应屏幕 / 原始大小」开关）',
    /useWideViewPort\s*=\s*true/.test(eduKtNoComment) &&
    /loadWithOverviewMode\s*=\s*true/.test(eduKtNoComment) &&
    /* 反面：那档「按内容宽度缩放」的绑定值不许再出现 —— 它正是开关的载体 */
    !/loadWithOverviewMode\s*=\s*fitWidth/.test(eduKtNoComment) &&
    !/适应屏幕/.test(eduKtNoComment) && !/原始大小/.test(eduKtNoComment));
  check('顶栏提供放大 / 缩小，方便在手机上点教务的 PC 菜单',
    /btnEduZoomIn/.test(eduLayout) && /btnEduZoomOut/.test(eduLayout) &&
    /zoomIn\(\)/.test(eduKtNoComment) && /zoomOut\(\)/.test(eduKtNoComment));
  check('edge-to-edge 下自己消费 IME insets（否则键盘挡住登录框）',
    /WindowInsetsCompat\.Type\.ime\(\)/.test(eduKtNoComment));

  /* 抓错页面预检 / 长按强制导入 / 失败时存原始页面 —— 这三条随自研抓页整条拆掉。 */
  check('抓页时代的预检 / 长按强制导入 / 存页面排查三件都没了（读剥注释后的正文）',
    !/looksLikeSchedulePage/.test(eduKtNoComment) &&
    !/forceGrab/.test(eduKtNoComment) &&
    !/MediaStore\.Downloads/.test(eduKtNoComment) &&
    !/dumpPage/.test(eduKtNoComment));

  check('原生侧不再预置任何学校入口（DEFAULT_URL 为空），空地址时显示起步页',
    /const val DEFAULT_URL = ""/.test(eduKt) &&
    /START_PAGE_HTML/.test(eduKt) &&
    /loadDataWithBaseURL\(null, START_PAGE_HTML/.test(eduKt) &&
    /* 反向断言只判**形状**（不许出现任何真实的教务域名），不写死是哪一所学校。 */
    realSchoolHosts(stripComments(eduKt)).length === 0,
    realSchoolHosts(stripComments(eduKt)).join('、'));
  check('记住上次访问的教务地址', /KEY_LAST_URL/.test(eduKt));
  check('承接 window.open 新窗口，不让导出按钮点不动', /onCreateWindow/.test(eduKt));
  check('返回键先网页后退再退出', /onBackPressedDispatcher/.test(eduKt) && /canGoBack/.test(eduKt));

  check('Manifest 申请联网权限（仅此一项）',
    /android\.permission\.INTERNET/.test(manifest) &&
    (manifest.match(/uses-permission/g) || []).length === 1);
  check('Manifest 注册了内嵌浏览器 Activity', /android:name="\.EduLoginActivity"/.test(manifest));

  /* —— v1.9.37 · 弹窗柚课化 + 导入诊断 ——
     两个真机反馈：①执行导入的弹窗是系统默认的灰底青字 AlertDialog，
     跟柚课完全两种画风；②导入的课卡片节次落位不对，而链路上每一环
     都验过是对的 —— 根因锁定在本校教务系统实际回包与标准正方不同，且解析对
     读不懂的行**静默丢弃**。修法：弹窗全部换自绘底座（edu_* 镜像令牌）；
     丢弃行带样本回传，预览里亮出来；端点序改成「学生个人课表」优先。 */
  const adImpJs = fs.readFileSync(path.join(root, 'web', 'js', 'adapter-import.js'), 'utf8');
  check('弹窗全部走自绘底座 showEduDialog（系统 AlertDialog 只剩 setView 一处容器）',
    /private fun showEduDialog\(/.test(eduKtNoComment) &&
    (eduKtNoComment.match(/AlertDialog\.Builder\(this\)/g) || []).length === 1 &&
    /AlertDialog\.Builder\(this\)\.setView\(root\)\.create\(\)/.test(eduKtNoComment));
  check('自绘弹窗用镜像令牌取色（edu_surface / edu_ink / edu_accent），不写死十六进制',
    /eduColor\(R\.color\.edu_surface\)/.test(eduKtNoComment) &&
    /eduColor\(R\.color\.edu_ink\)/.test(eduKtNoComment) &&
    /eduColor\(R\.color\.edu_accent\)/.test(eduKtNoComment) &&
    !/0xFF[0-9A-Fa-f]{6}\s*\)/.test(eduKtNoComment.split('showEduDialog')[1] || ''));
  check('弹窗助手造不出来时调用方都有兜底（不能让桥的 Promise 悬着 / 页面 alert 卡死）',
    (eduKtNoComment.match(/if \(dlg == null\)/g) || []).length >= 5);
  check('跳过行诊断：原生 saveCourses 认对象包装并透传 dropped',
    /optJSONArray\("courses"\)/.test(eduKtNoComment) &&
    /optJSONArray\("dropped"\)/.test(eduKtNoComment) &&
    /adapterDropped \?: "null"/.test(eduKtNoComment));
  check('适配映射把 dropped / rawJcs 样本写进预览 notes（课表少了半截时这是唯一线索）',
    /没认出来/.test(adImpJs) && /节次原始写法样本/.test(adImpJs) && /rawJcs/.test(adImpJs));
  check('适配脚本的导入预览逐门列出落位（节次错了当场能看见）',
    /课程落位/.test(appjs));

  /* —— v1.9.38 · 节次字段兜底 + 原始记录字段快照 ——
     用户补了一句关键信息：「课表是 1-2 节的，导入却只有第 2 节」。
     ⇒ 起始节丢了、只剩结束节 ⇒ 教务给的**不是** "1-2" 这种标准写法。
     ⚠️ v1.9.42：脚本侧那几条（`pickSections` / `summarizeItem` / `secFrom` /
     `sample`）原本断在**我们自研的那只脚本**上，那只脚本已按用户拍板停用、
     整条路拆掉，所以这里只留下**宿主侧**的两条 —— 宿主仍然认对象包装、
     仍然把 dropped / sample 透传进预览：上游脚本哪天愿意带诊断，链路是通的。 */
  check('原生 saveCourses 透传 sample 且不吞空串',
    /optString\("sample"/.test(eduKtNoComment) &&
    /adapterSample = obj\.optString\("sample", ""\)\.takeIf \{ it\.isNotEmpty\(\) \}/.test(eduKtNoComment) &&
    /jsQuoteString\(adapterSample \?: ""\)/.test(eduKtNoComment) &&
    /adapterSample = null/.test(eduKtNoComment));
  check('适配映射把原始记录样本与「节次不在 jcs 里」写进 notes',
    /教务原始记录样本/.test(adImpJs) &&
    /不在标准的 jcs 字段里/.test(adImpJs) &&
    /secFrom/.test(adImpJs));

  /* —— v1.9.39 · 导入课程 id 的收口只在 Store 一处 ——
     解析层（适配脚本 / Excel / PDF / CSV 四条通道）一律不生成 id，
     两处入口各补一次：commitImport（新导入当场补）+ normalizeSchedule
     （载入兜底）。缺任何一处，导入的课在课表里就点不开。 */
  const storeJs39 = fs.readFileSync(path.join(root, 'web', 'js', 'store.js'), 'utf8');
  check('commitImport 给导入的课程补 id（四条导入通道的共同收口）',
    /var incoming = res\.courses\.slice\(\);/.test(appjs) &&
    /incoming\.forEach\(function \(c\) \{ if \(c && typeof c === 'object' && !c\.id\) c\.id = Store\.uid\(\); \}\);/.test(appjs) &&
    /sched\.courses = incoming;/.test(appjs));
  check('normalizeSchedule 与 readLegacy 都走 ensureCourseIds 兜底',
    /function ensureCourseIds\(/.test(storeJs39) &&
    (storeJs39.match(/ensureCourseIds\(/g) || []).length >= 3);
  check('解析层仍然不生成 id（口径只留在 Store 一处，别两头各生成一次）',
    /id: null,/.test(adImpJs) && !/id:\s*'c'/.test(adImpJs));

  /* ============================================================
     [20b] 社区适配库（v1.9.32）

     与上一段是两条**完全不同**的路：
       · 抓页解析 = 我们猜（页面像课表就抽字段）；
       · 适配库   = 上游那所学校的维护者写的脚本，在**我们这边的浏览器**里
                    以真实页面上下文执行，用它自己的规则把课表交回来。
     换来的能力是「一所学校改版，脚本作者跟着改，不用我们发版」，
     代价是多了三件必须钉住的事：

       ① **名单只在运行时来** —— 仓库里不许再出现任何一所学校的名字与
          教务地址（改回「内置一份」就等于回到 v1.8 那套，且那套已经
          因为「搬同业数据」做过一次整改）；
       ② **桥的两头只能各有一处** —— 网页挂 `WarehouseHost.onBinary`、
          原生调它。名字漂了不是报错，是「更新适配库」永远转圈；
       ③ **原生那个下载口只能指向官方域** —— 它是网页能直接调到的
          `@JavascriptInterface`，不设限就等于开了「让原生去下载任意地址」的口子。
     ============================================================ */
  console.log('\n[20b] 社区适配库：名单在运行时来，脚本由上游按校维护');
  const whJs = fs.readFileSync(path.join(root, 'web', 'js', 'warehouse.js'), 'utf8');
  const adJs = fs.readFileSync(path.join(root, 'web', 'js', 'adapter-import.js'), 'utf8');
  /* 原生侧那两个常量与体积上限都在 MainActivity.kt 里，就是全局的 `kt`
     （用全局那份**已经剥过注释**的副本，别再自己剥一遍 —— 见 stripKtComments 上方的教训）。 */
  const whKt = kt;

  check('页面引入适配库那两个模块，且都排在 app.js 之前',
    /src="js\/warehouse\.js"/.test(htmlSrc) && /src="js\/adapter-import\.js"/.test(htmlSrc) &&
    htmlSrc.indexOf('js/warehouse.js') < htmlSrc.indexOf('js/app.js') &&
    htmlSrc.indexOf('js/adapter-import.js') < htmlSrc.indexOf('js/app.js'));
  check('分发源收在**一张表**里（地址不外散；日后加一条镜像只改这一处）',
    /var SOURCES = \[/.test(whJs) &&
    /var INDEX_URLS = SOURCES\.map/.test(whJs) &&
    /var SCRIPT_BASES = SOURCES\.map/.test(whJs) &&
    (whJs.match(/ShiGuangSchedule\/shiguang_warehouse/g) || []).length === 1 &&
    /var OWNER = 'ShiGuangSchedule\/shiguang_warehouse'/.test(whJs));
  /* 反向断言扩到新模块。`example.edu.cn` 这类占位值在 realSchoolHosts 里
     显式放行（夹具与注释都要用），真实教务域名一律判红。 */
  check('适配库两个模块里同样没有真实教务域名（名单一律运行时来）',
    realSchoolHosts(stripComments(whJs)).length === 0 &&
    realSchoolHosts(stripComments(adJs)).length === 0,
    realSchoolHosts(stripComments(whJs)).concat(realSchoolHosts(stripComments(adJs))).join('、'));
  check('索引解码只认一个协议版本，且版本号有名字（上游升版时要在这里红）',
    /var SUPPORTED_PROTOCOL = 2;/.test(whJs) &&
    /idx\.protocol !== SUPPORTED_PROTOCOL/.test(whJs));
  check('协议不兼容是「终点」：不再换源（换几个源都是同一份数据，只会拖时间）',
    /版本不兼容/.test(whJs) && /if \(\/版本不兼容\/\.test/.test(whJs));

  /* 接入策略：判据必须是**结构性的**，不能是一张 id 名单 ——
     上游每加一个通用教务家族，名单化就静默漏一所（试过：拿真索引一跑就漏两所）。
     这段话咬的是「判据长什么样」，真数据在 tools/test-warehouse.js 里跑。 */
  check('通用工具的判据是「import_url 为空」而不是 id 名单（新增家族自动进得来）',
    /return !adapter\.importUrl;/.test(whJs) &&
    /adapter\.category === CAT_BACHELOR \|\| adapter\.category === CAT_POSTGRAD/.test(whJs));
  check('唯一那张名单只装上游的演示 / 测试脚本，且只有两项',
    /var TOOL_DENY = \{ 'GENERAL_TOOL_01': 1, 'GENERAL_TOOL_02': 1 \};/.test(whJs));
  check('没有脚本路径的条目一概不要（拿不到脚本 = 没法执行）',
    /if \(!a\.jsPath\) return false|!a\.jsPath/.test(whJs));

  /* —— 桥的两头 —— */
  check('网页侧把回包入口挂在**一个固定的全局名字**上（原生只能靠 evaluateJavascript 回来）',
    /global\.WarehouseHost = \{ onBinary: _onBinary \};/.test(whJs));
  check('原生侧注册 AndroidWarehouse 桥，且名字只写这一处',
    (ktNoComment.match(/addJavascriptInterface\(WarehouseBridge\(\), "AndroidWarehouse"\)/g) || []).length === 1 &&
    (ktNoComment.match(/"AndroidWarehouse"/g) || []).length === 1);
  /* ⚠️ 这条是 v1.9.33 真机翻车的根因，也是「弱断言放走真 bug」的标本：
     旧断言写成 /WarehouseHost\.onBinary/.test(whKt) —— 而「只有 if 判断、
     没有调用」的坏注入串里**同样含有这串字**，全绿、永远绿。
     现在咬的是「真的在**调用**」：判断（…onBinary)）与调用（onBinary(）都要在。 */
  check('原生侧回包的注入串里真的在调用 WarehouseHost.onBinary（只有 if 判断 = 下载成功也收不到）',
    /replyWarehouse/.test(ktNoComment) &&
    /window\.WarehouseHost&&window\.WarehouseHost\.onBinary\)/.test(ktNoComment) &&
    /window\.WarehouseHost\.onBinary\(/.test(ktNoComment));
  /* 下载口是个网页能直接调到的原生入口。地址本身来自上游索引，
     与 web/js/warehouse.js 的 SOURCES 是同一组前缀 —— 所以这里判
     「只放行那一组」，别处一律拒。
     v1.9.40 起源从两条扩到四条，断言也从「两个常量」改成**与源表逐条对齐**：
     少一条 = 那条源被原生拒掉，症状是「点了更新没反应」，而且界面上
     **不会有任何报错**（静默失败，最难查的那种）。 */
  const whSources = global.Warehouse.SOURCES;
  const ktPrefixBlock = ktNoComment.match(/WAREHOUSE_PREFIXES\s*=\s*listOf\(([\s\S]*?)\)/);
  const ktPrefixes = ktPrefixBlock
    ? (ktPrefixBlock[1].match(/"(https:\/\/[^"]*)"/g) || []).map(s => s.slice(1, -1))
    : [];
  check('原生白名单与源表**逐条对齐**（条数 / 顺序 / 前缀形状；对不上就是那条源被拒且不报错）',
    ktPrefixes.length > 0 && ktPrefixes.length === whSources.length &&
    whSources.every((s, i) => ktPrefixes[i] &&
      s.indexUrl.startsWith(ktPrefixes[i]) && s.scriptBase.startsWith(ktPrefixes[i])),
    ktPrefixes.length + ' 条：' + ktPrefixes.join(' , '));
  check('放行判据收在**一个函数**里，两处调用不许各写一遍 startsWith 链',
    /fun isWarehouseUrl\(u: String\?\): Boolean/.test(ktNoComment) &&
    /if \(isWarehouseUrl\(u\)\) out\.add\(u\)/.test(ktNoComment) &&
    /if \(!isWarehouseUrl\(u\)\) \{/.test(ktNoComment) &&
    (ktNoComment.match(/isWarehouseUrl\(/g) || []).length === 3);
  check('白名单里没有过分宽的前缀（`https://` / 裸主机这种等于没设限）',
    ktPrefixes.every(p => /^https:\/\/[a-z0-9.-]+\/.+/.test(p)));
  check('原生下载有体积上限（上游脚本最大 50 KB 级，上限是为了防「拉到一坨东西」）',
    /const val MAX_WAREHOUSE_BYTES/.test(whKt) &&
    /out\.size\(\) > MAX_WAREHOUSE_BYTES/.test(ktNoComment));
  check('网页侧等桥有超时（桥不回调就是一个永不 settle 的 Promise：界面永远转圈）',
    /var BRIDGE_TIMEOUT_MS = \d+;/.test(whJs) && /setTimeout\(function \(\) \{/.test(whJs));

  /* —— 走一遍真链路：拉索引 → 解码 → 落盘 → 搜出来 → 画出来 → 交给原生 ——
     这一条是本节唯一「跑起来」的断言。前面那些咬形状，咬不出
     「模块在、但接不上」这类错（例如 app.js 里 `var WH = global.Warehouse`
     取早了，拿到 undefined，全程静默降级）。 */
  const wire = { openCalls: [], asked: [] };
  const prevAW = global.AndroidWarehouse, prevAE = global.AndroidEdu;
  const idxFixture = require(path.join(root, 'tools', 'index-fixture.js'));
  global.AndroidWarehouse = {
    getBinary: function (url, id) {
      wire.asked.push(url);
      const b64 = Buffer.from(idxFixture.buildSampleIndex()).toString('base64');
      /* 同步回调，避免「先应答后注册」的时序竞态把断言变红 */
      setTimeout(function () { global.Warehouse._onBinary(id, 'ok:' + b64); }, 0);
    }
  };
  global.AndroidEdu = {
    /* 记录**实参个数**：原生那个方法按「方法名 + 参数个数」反射找，
       网页多传或少传一个就是静默失配 —— 光断「第 6 参是空串」已经不够了
       （v1.9.42 起根本没有第 6 参）。 */
    openWithAdapter: function (school, aName, maint, urlsJson, importUrl) {
      wire.openCalls.push({ school: school, adapter: aName, maintainer: maint,
        urls: JSON.parse(urlsJson), importUrl: importUrl, argc: arguments.length });
    }
  };
  if (global.Warehouse.clearAll) global.Warehouse.clearAll();
  let whIdx = null;
  try {
    whIdx = await global.Warehouse.update();
  } catch (e) { whIdx = { error: e && e.message }; }
  check('真链路：拉索引 → 解码成功（走的是 AndroidWarehouse，不是 fetch）',
    !!whIdx && !whIdx.error && global.Warehouse.loaded() && wire.asked.length >= 1,
    whIdx && whIdx.error ? whIdx.error : 'asked=' + wire.asked.length);
  check('真链路：合成索引里的 3 所学校全部进来，GLOBAL_TOOLS 被整组挡掉',
    !!whIdx && !whIdx.error && whIdx.schools.length === 3 &&
    !whIdx.schools.some(function (s) { return s.id === 'GLOBAL_TOOLS'; }),
    whIdx && whIdx.schools ? whIdx.schools.map(function (s) { return s.id; }).join('、') : '');
  check('真链路：通用教务家族（import_url 为空）没有被 id 名单漏掉',
    !!whIdx && !whIdx.error &&
    whIdx.schools.some(function (s) {
      return s.adapters.some(function (a) { return a.adapterId === 'newfamily_01'; });
    }));
  const blk = global.ScheduleApp.libraryBlock();
  check('真链路：适配库那一块认出「已载入」（不是「还没载入」）',
    /已载入/.test(blk) && !/还没有载入/.test(blk));
  const hits = global.ScheduleApp.libraryHits('示例大学');
  check('真链路：搜校名能搜出来，并且带上了维护者署名',
    /示例大学/.test(hits) && /维护者/.test(hits) && /data-lib="/.test(hits));
  const hitKey = (/data-lib="([^"]+)"/.exec(hits) || [])[1] || '';
  check('真链路：搜出来的行带着可点的 data-lib 键（键 = 学校id|适配器id）',
    /^TESTU\|/.test(hitKey) || hitKey.split('|').length === 2, hitKey);
  global.ScheduleApp.openLibraryPick(hitKey);
  check('真链路：点一行就把「学校 + 脚本地址（每源一条） + import_url」交给原生',
    wire.openCalls.length === 1 && wire.openCalls[0].urls.length === whSources.length &&
    wire.openCalls[0].urls[0] === global.Warehouse.SOURCES[0].scriptBase + 'TESTU/testu_01.js' &&
    wire.openCalls[0].school === '示例大学',
    JSON.stringify(wire.openCalls[0] || null).slice(0, 160));
  const pu = wire.openCalls[0] ? wire.openCalls[0].importUrl : '';
  const back = pu ? global.ScheduleApp.pickFor(pu) : null;
  check('真链路：这个地址记住了「上次用哪段脚本」（否则第二次就退回「只搬 HTML 猜」）',
    !!back, pu || '（这一趟没带 import_url）');
  check('真链路：记住的确实是同一所学校同一段脚本',
    !!back && back.school.id === 'TESTU' &&
    back.adapter.maintainer === wire.openCalls[0].maintainer);

  /* —— 字母总览（v1.9.34）：A–Z 分组 + 右侧字母条 + 用过置顶 ——
     同样走真数据：分组字母必须与 libLetter 对同一所学校的判值一致，
     否则「字母条点了跳不到」这类错咬不住。 */
  const alpha = global.ScheduleApp.libraryAlphabet();
  const tSchool = whIdx.schools.filter(function (s) { return s.id === 'TESTU'; })[0];
  const tLetter = global.ScheduleApp.libLetter(tSchool);
  check('真链路：字母总览按首字母分组，TESTU 挂在 libLetter 判出的那一组下',
    /class="lib-scroll"/.test(alpha) && /class="lib-index"/.test(alpha) &&
    alpha.indexOf('data-letter-head="' + tLetter + '"') >= 0 &&
    alpha.indexOf('data-letter="' + tLetter + '"') >= 0, tLetter);
  check('真链路：总览里每所学校都是可点的行（与搜索结果同一套 data-lib）',
    /data-lib="TESTU\|/.test(alpha));
  check('libLetter：取上游拼音首字母的首字符，取不出 A–Z 的进「#」兜底组',
    global.ScheduleApp.libLetter({ initial: 'bq', name: 'x' }) === 'B' &&
    global.ScheduleApp.libLetter({ initial: '', name: '测试' }) === '#' &&
    global.ScheduleApp.libLetter(null) === '#');
  const alpha2 = global.ScheduleApp.libraryAlphabet();   // 这一趟已经 rememberPick 过了
  check('真链路：用过的学校置顶（★ 组在最前面，字母组都在它后面）',
    /★ 用过的学校/.test(alpha2) &&
    alpha2.indexOf('★ 用过的学校') < alpha2.indexOf('data-letter-head'));
  check('点字母条能跳到那一组（jumpToLetter 挂在 schoolList 的点击分发里）',
    /function jumpToLetter/.test(appjs) &&
    /closestBy\(t, 'data-letter'\)/.test(appjs));
  check('打开面板就自动拉一次（v1.9.41 起包里没有清单，第一次必须联网，更不该让用户先弄懂按钮）',
    /function maybeAutoLoadWarehouse/.test(appjs) &&
    /maybeAutoLoadWarehouse\(\);/.test(appjs) &&
    /refreshWarehouse\(true\)/.test(appjs));
  check('真链路：打开教务那一刻**恰好传 5 个实参**（多一个少一个都是静默失配）',
    wire.openCalls.length === 1 && wire.openCalls[0].argc === 5,
    wire.openCalls[0] ? ('实参 ' + wire.openCalls[0].argc + ' 个') : '（一次都没调）');
  global.AndroidWarehouse = prevAW;
  global.AndroidEdu = prevAE;

  /* —— 内置快照**已经取消**（v1.9.41）：社区清单与脚本全部运行时下载 ——
     这一段换成了**反向断言**：包内不许再有 warehouse 资产、网页侧与原生侧
     不许再有内置快照的接线、本地那只脚本只能走「正文」。
     反向断言最容易永远绿（断的东西本来就没有，怎么写都过），
     所以每一条都退回 v1.9.40 的源码验过红 —— 见当日日志。 */
  check('网页侧不再有内置快照那条路的接线（hasBundledBridge / isBundled / scriptPath / canLoadBundled / BUNDLED_TIMEOUT_MS）',
    !/hasBundledBridge/.test(whJs) && !/function isBundled/.test(whJs) &&
    !/scriptPath: scriptPath/.test(whJs) && !/canLoadBundled/.test(whJs) &&
    !/BUNDLED_TIMEOUT_MS/.test(whJs));
  check('update() 就是 online()（唯一那条路），成功后仍踢一次静默刷新（补正滞后的镜像）',
    /function update\(\) \{\s*return online\(\)\.then\(function \(idx\) \{\s*_silentRefresh\(\);\s*return idx;/.test(whJs));
  /* —— 自研脚本这条路**整条拆掉**（v1.9.42）——
     用户拍板：本校那一行不再自带脚本，改用社区适配库里的「正方教务-通用教务」
     （上游 `zhengfang_jiaowu/zhengfang_01.js`），与所有社区学校一样运行时下载。
     于是「随包脚本正文」这一整套（内联产物 / 生成器 / 桥的第 6 参 / 原生收文本
     的那个入口）全部退场。这里仍然全是**反向断言**，每一条都退回 v1.9.41 的
     源码验过红 —— 断「某东西不存在」最容易永远绿。 */
  check('网页侧不再有「随包脚本正文」这条路（localSourceOf / isLocalScript / LocalAdapters 全退场）',
    !/localSourceOf/.test(stripComments(whJs)) && !/isLocalScript/.test(stripComments(whJs)) &&
    !/global\.LocalAdapters/.test(stripComments(whJs)));
  check('scriptUrls 对任何条目一视同仁（不再有「自带正文的返回空数组」那条分支）',
    /function scriptUrls\(school, adapter\) \{\s*if \(!school \|\| !adapter \|\| !adapter\.jsPath\) return \[\];/.test(whJs) &&
    !/isLocalScript\(school, adapter\)\) return \[\];/.test(whJs));
  check('静默刷新吞掉一切错误（锦上添花的动作，失败不许在任何地方冒头）',
    /function _silentRefresh/.test(whJs) &&
    /catch\(function \(\) \{ \/\* 静默/.test(whJs));
  check('界面不再有「内置快照」这个说法（空态要讲清「第一次需要联网下载」）',
    !/内置快照/.test(stripComments(appjs)) && /第一次需要联网/.test(appjs));

  check('原生侧读内置索引的桥方法没了，那几个常量也一并删了',
    !/getBundledIndex/.test(ktNoComment) && !/BUNDLED_INDEX_ASSET/.test(whKt) &&
    !/MAX_BUNDLED_BYTES/.test(whKt) && !/BUNDLED_SCRIPT_PREFIX/.test(eduKtNoComment) &&
    !/sanitizeAssetPath/.test(eduKtNoComment));
  check('原生侧「收一段脚本文本」那个入口也没了（EXTRA_ADAPTER_SOURCE / MAX_SCRIPT_SOURCE_CHARS / adapterScriptSource 全退场）',
    !/EXTRA_ADAPTER_SOURCE/.test(ktNoComment) && !/EXTRA_ADAPTER_SOURCE/.test(eduKtNoComment) &&
    !/MAX_SCRIPT_SOURCE_CHARS/.test(ktNoComment) && !/MAX_SCRIPT_SOURCE_CHARS/.test(eduKtNoComment) &&
    !/adapterScriptSource/.test(eduKtNoComment) &&
    !/assets\.open/.test(eduKtNoComment));
  /* ⚠️ 参数个数**必须与网页侧那句调用一致**：Java 桥按「方法名 + 参数个数」
     反射找方法，个数不一就是静默失配（什么都不发生、连报错都没有）。
     v1.9.41 是 6 个（第 6 参是脚本正文），v1.9.42 正文没了 ⇒ **回到 5 个**，
     下面那两条一起管：原生声明几个、网页就传几个。 */
  check('openWithAdapter 是 **5 个参数**（v1.9.42 拆掉正文那一参）',
    (function () {
      const m = ktNoComment.match(/fun openWithAdapter\(([\s\S]*?)\)\s*\{/);
      if (!m) return false;
      return m[1].split(',').filter(function (s) { return s.trim(); }).length === 5;
    })());
  check('网页侧那句调用也是 5 个实参，且最后一个仍是 import_url',
    (function () {
      const m = appjs.match(/openWithAdapter\(([\s\S]*?)\);/);
      if (!m) return false;
      const parts = m[1].split(',').filter(function (s) { return s.trim(); });
      return parts.length === 5 && /String\(adapter\.importUrl \|\| ''\)/.test(parts[4]);
    })());
  check('一个地址都编不出来就不打开（不打开空壳页面）',
    /val urls = parseScriptUrls\(scriptsJson\)\s*\n\s*if \(urls\.isEmpty\(\)\) return/.test(ktNoComment));
  check('网页侧只按地址走（不再分「本地 / 社区」两条来源）',
    /var urls = WH\.scriptUrls\(school, adapter\);/.test(appjs) &&
    !/WH\.isLocalScript/.test(appjs) && !/WH\.localSourceOf/.test(appjs));
  check('fetchScript 只剩联网一条路（不再先认自带正文）',
    !/adapterScriptSource/.test(eduKtNoComment) && !/adapterScriptPath/.test(eduKtNoComment));

  /* —— 资产盘点：**整个 assets/warehouse/ 都不许存在** ——
     这是本版最要紧的一条：它同时是「APK 从 7.1 MB 回到 2.6 MB」与
     「不再随包分发 256 只第三方脚本」这两句结论的凭据。 */
  const bundledDir = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'warehouse');
  check('assets/warehouse/ 整个目录已经不存在（社区清单与脚本不再进包）',
    !fs.existsSync(bundledDir), fs.existsSync(bundledDir) ? '（目录还在）' : '（已移除）');
  check('出内置快照那个工具 tools/pack-warehouse.js 已经删掉',
    !fs.existsSync(path.join(root, 'tools', 'pack-warehouse.js')));
  /* —— v1.9.41 追加发现：assets/ 里还躺着**第二份**内置快照 ——
     `library.pack`（1.14 MB，v1.9.33 之前「整包 zip 塞 assets」那套废弃设计的遗留）
     与它的工具 `tools/fetch-library.js` / `tools/zip-lite.js`。
     三者全仓零引用（没有代码、测试、文档碰它），却被原样打进了 v1.9.33~v1.9.40
     的每一个包 —— 8 个版本、每个包白背 1.14 MB 的上游数据。
     ⚠️ 反向断言（「某文件不存在」）最容易永远绿 ⇒ 这三条已用「删前跑一遍见红」验过。 */
  const assetsDir = path.join(root, 'android', 'app', 'src', 'main', 'assets');
  check('assets/ 下只剩 web/ 这一项（第二份内置快照 library.pack 已经清掉）',
    (function () {
      if (!fs.existsSync(assetsDir)) return false;
      return fs.readdirSync(assetsDir).filter(function (f) { return f !== 'web'; }).length === 0;
    })(),
    (function () {
      if (!fs.existsSync(assetsDir)) return '（assets 目录不存在）';
      const left = fs.readdirSync(assetsDir).filter(function (f) { return f !== 'web'; });
      return left.length ? '仍有：' + left.join('、') : '只剩 web/';
    })());
  check('那份快照的工具（tools/fetch-library.js 与它依赖的 tools/zip-lite.js）也一并删掉',
    !fs.existsSync(path.join(root, 'tools', 'fetch-library.js')) &&
    !fs.existsSync(path.join(root, 'tools', 'zip-lite.js')));
  /* —— 自研脚本那一整套文件都删干净了（v1.9.42）——
     以前这里断的是「生成物 == render()」（产物被截断时照样绿的那种断法）。
     现在源、生成器、产物**三者都不该在**，于是改成三条「不存在」。
     ⚠️ 真机上「留着一个没人引用的旧产物」不会报错，只会让下次改动白改 ——
     所以这条必须留。 */
  check('自研脚本那一整套都删干净了（tools/adapter-local/ + 生成器 + 内联产物）',
    !fs.existsSync(path.join(root, 'tools', 'adapter-local')) &&
    !fs.existsSync(path.join(root, 'tools', 'gen-adapter-local.js')) &&
    !fs.existsSync(path.join(root, 'web', 'js', 'adapter-local.js')));
  check('index.html 不再引 js/adapter-local.js（引了就是一个 404 的空 script）',
    !/adapter-local\.js/.test(htmlSrc));
  const schJsLocal = fs.readFileSync(path.join(root, 'web', 'js', 'schools.js'), 'utf8');
  check('本校那一行改指上游那只「正方教务-通用教务」（folder/jsPath 就是下载地址的两段）',
    /upstreamFolder: 'zhengfang_jiaowu'/.test(schJsLocal) &&
    /upstreamJsPath: 'zhengfang_01\.js'/.test(schJsLocal) &&
    /folder: b\.upstreamFolder,/.test(schJsLocal) &&
    /jsPath: b\.upstreamJsPath,/.test(schJsLocal));
  check('本校那一行的 adapterId 与上游那只**刻意不同**（同名会让「正方教务-通用教务」那行查不出来）',
    /adapterId: 'youke_b' \+ i \+ '_01',/.test(schJsLocal) &&
    /upstreamAdapterId: 'zhengfang_01'/.test(schJsLocal));
  check('本校那一行不再自带脚本正文（BUILTIN 里没有 adapterJs 这个字段了）',
    !/adapterJs/.test(schJsLocal));

  /* ============================================================
     [11f] 桌面小组件
     这一层最容易静默出错：组件不在应用里，改坏了没有任何界面会报错，
     用户看到的只是「桌面上那块东西怪怪的」。所以这里把三件事钉住：
     通道两头名字一致、**规则不重写**、两个组件的 id 不打架。
     ============================================================ */
  console.log('\n[11f] 桌面小组件：数据由页面算好推过来，原生只负责显示');
  {
    const ktOf = (n) => {
      const p = path.join(KT_DIR, n);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    };
    const resOf = (rel) => {
      const p = path.join(root, 'android', 'app', 'src', 'main', rel);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    };

    const wData = ktOf('WidgetData.kt');
    const wProv = ktOf('WidgetProvider.kt');
    const wSvc = ktOf('WidgetListService.kt');
    const wRender = ktOf('WidgetRender.kt');

    check('原生四个文件到位（数据 / 渲染 / 组件 / 列表服务）',
      !!wData && !!wProv && !!wSvc && !!wRender);

    // —— 通道两头：桥名必须一致，钩子必须挂上 ——
    check('页面把快照推给 AndroidWidget.sync',
      /AndroidWidget/.test(appjs) && /\.sync\(/.test(appjs));
    check('原生注册的桥名与页面一致',
      /addJavascriptInterface\(WidgetBridge\(\), "AndroidWidget"\)/.test(kt));
    check('推送挂在 Store 的保存钩子上（任何一次写盘都重推，不靠调用方记得）',
      /Store\.onSave\(pushWidget\)/.test(appjs));
    check('启动时补推一次（补上上次没同步的改动）', /pushWidget\(\);/.test(appjs));

    // —— 规则只有一份：原生不许自己算周次 ——
    check('原生不重算周次 / 单双周，只按日期取数组',
      !/weekOf|isOddWeek|parseWeeks|parity/.test(wData + wProv + wSvc));
    check('周次与单双周过滤留在 store.js 一处',
      /weeks\.indexOf\(wk\)/.test(storejs) && /function dayCourses/.test(storejs));
    check('store.js 导出了快照与钩子',
      /buildWidgetData: buildWidgetData/.test(storejs) && /onSave: onSave/.test(storejs));
    check('快照给每一天都写键（原生才分得清「这天没课」和「快照过期」）',
      /days\[fmtDate\(d\)\] = dayCourses/.test(storejs));

    // —— 清单 ——
    check('两个小组件 = 两个 receiver（一个 receiver 只挂得下一份 provider 元数据）',
      (manifest.match(/android\.appwidget\.action\.APPWIDGET_UPDATE/g) || []).length === 2);
    check('两份 appwidget-provider 各自指向真实布局',
      /@xml\/widget_today_info/.test(manifest) && /@xml\/widget_twoday_info/.test(manifest));
    check('列表 Service 声明 BIND_REMOTEVIEWS（不声明，列表永远出不来）',
      /android:permission="android\.permission\.BIND_REMOTEVIEWS"/.test(manifest));
    check('小组件没引入任何新权限（清单里仍只有 INTERNET）',
      (manifest.match(/uses-permission/g) || []).length === 1);

    // —— v1.9.44：两个 receiver 的 exported 必须是 true ——
    //   红米 / HyperOS 上「长按桌面 → 小部件 → 找不到柚课」就是这个属性挡的：
    //   桌面是**另一个应用**，它在枚举组件选择列表这一步会按 exported 过滤。
    //   ⚠️ 必须读**剥注释**的清单 —— 上面那段注释里正写着「从 false 改回来」，
    //      不剥注释就会把注释里的 false 当成代码，永远红。
    const manifestNoComment = manifest.replace(/<!--[\s\S]*?-->/g, '');
    const recvBlocks = manifestNoComment.match(/<receiver[\s\S]*?<\/receiver>/g) || [];
    const widgetRecv = recvBlocks.filter((b) => /Widget(?:Today|TwoDay)Provider/.test(b));
    check('两个小组件 receiver 的 exported 都是 true（桌面是另一个应用，false 会被定制桌面在选择列表里挡掉）',
      widgetRecv.length === 2 &&
      widgetRecv.every((b) => /android:exported="true"/.test(b)),
      widgetRecv.length + ' 个 receiver');
    check('清单里不许再出现 exported="false" 的 receiver（写回去立刻红）',
      !/<receiver[^>]*android:exported="false"/.test(manifestNoComment));

    // —— 资源 ——
    const todayXml = resOf('res/layout/widget_today.xml');
    const twodayXml = resOf('res/layout/widget_twoday.xml');
    const rowXml = resOf('res/layout/widget_row.xml');
    check('三个布局到位', !!todayXml && !!twodayXml && !!rowXml);
    check('滑动靠 ListView（AppWidget 里唯一能让用户上下滑的视图）',
      /<ListView/.test(todayXml) && /<ListView/.test(twodayXml));

    const t2Ids = twodayXml.match(/android:id="@\+id\/(\w+)"/g) || [];
    check('4×2 两栏的 id 互不重复（RemoteViews 靠 id 定位，撞名会把明天的课写进今天）',
      t2Ids.length > 0 && new Set(t2Ids).size === t2Ids.length,
      t2Ids.length + ' 个 id');

    const infoToday = resOf('res/xml/widget_today_info.xml');
    const infoTwo = resOf('res/xml/widget_twoday_info.xml');
    check('2×2 声明 110dp / 4×2 声明 250dp（≈2 格与 4 格）',
      /android:minWidth="110dp"/.test(infoToday) && /android:minWidth="250dp"/.test(infoTwo));
    check('两个组件都 30 分钟刷新一次（顺带负责跨天换日）',
      /updatePeriodMillis="1800000"/.test(infoToday) && /updatePeriodMillis="1800000"/.test(infoTwo));

    const dayColors = resOf('res/values/colors.xml');
    const nightColors = resOf('res/values-night/colors.xml');
    const wNames = ['widget_bg', 'widget_ink', 'widget_ink2', 'widget_line',
      'widget_accent', 'widget_focus_bg', 'widget_accent_soft', 'widget_row_hl'];
    check('小组件配色日夜两套齐全（漏一个，夜色下就是黑块或透明）',
      wNames.every((n) => new RegExp('name="' + n + '"').test(dayColors)) &&
      wNames.every((n) => new RegExp('name="' + n + '"').test(nightColors)));

    // —— 逻辑与兼容 ——
    check('「最近一节课」= 正在上的最优先，否则下一节',
      /Phase\.NOW/.test(wData) && /startMin <= nowMin && nowMin < c\.endMin/.test(wData));
    check('明天那一栏不判「正在上课」（那天还没到）',
      /dayOffset == 0\) nowMinutes\(\) else -1/.test(wSvc));
    check('setRemoteAdapter 对新旧系统分开调用（不带 appWidgetId 的重载 API 31 才有）',
      /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S/.test(wProv) &&
      /setRemoteAdapter\(widgetId, listId, intent\)/.test(wProv) &&
      !/setRemoteAdapter\(intArrayOf/.test(wProv));

    /* —— v1.9.18：真机上摔出来的三条 ——
       ①RemoteViews **不是**普通布局，它只 inflate 白名单里的类
         （FrameLayout / LinearLayout / RelativeLayout / GridLayout + TextView /
          ImageView / ListView / GridView / … ），`android.view.View` 不在里面
         （javap 验过：View 的 @RemoteView 注解计数为 0，上面几个都有）。
         写成 `<View>` 干什么都不报错 —— 编译过、冒烟过、e2e 也过 ——
         只在桌面上变成「载入窗口小部件时出现问题」且点击毫无反应。
         用一条静态断言守住它，这类错本来就不需要浏览器。
       ②collection 项的点击模板必须是 FLAG_MUTABLE（IMMUTABLE 填不进 fillInIntent）。
       ③两栏的 Intent 只差一个 extra，而 filterEquals **不比较 extras** ——
         不 setData 让它们可区分，可能被当成同一个连接复用。 */
    const wLayouts = [
      ['widget_today.xml', todayXml],
      ['widget_twoday.xml', twodayXml],
      ['widget_row.xml', rowXml]
    ];
    const RV_ALLOWED = /^(LinearLayout|FrameLayout|RelativeLayout|GridLayout|TextView|ImageView|Button|ImageButton|ProgressBar|ListView|GridView|StackView|AdapterViewFlipper|ViewFlipper|ViewStub|AnalogClock|Chronometer|TextClock)$/;
    for (const [name, src] of wLayouts) {
      // 注释里的说明文字不算（widget_twoday 的注释里就写着 "<View>" 三个字）
      const body = src.replace(/<!--[\s\S]*?-->/g, '');
      const tags = (body.match(/<[A-Za-z][\w.]*/g) || []).map((t) => t.slice(1));
      const bad = tags.filter((t) => !RV_ALLOWED.test(t));
      check('组件布局只用 RemoteViews 认识的视图（' + name + '，写错整个组件加载失败）',
        tags.length > 0 && bad.length === 0, bad.join(' / '));
    }
    check('列表点击模板用 FLAG_MUTABLE（IMMUTABLE 的 PendingIntent 填不进 fillInIntent）',
      /FLAG_MUTABLE/.test(wProv) && /openAppTemplate/.test(wProv) &&
      /setPendingIntentTemplate\(ids\.list, templatePi\)/.test(wRender));
    check('两栏的列表 Intent 用 data 区分（filterEquals 不看 extras，只靠 extra 分不开）',
      /Uri\.parse\("youke:\/\/widget\//.test(wSvc));
    check('4×2 两栏之间的缝隙也挂点击（不然正好戳中间会「没反应」）',
      /R\.id\.w_twoday_root/.test(wProv) && /id="@\+id\/w_twoday_root"/.test(twodayXml));

    /* —— v1.9.19：教室旁边补上「上课时间」——
       两个容易「静默地错」的点：
       ① 时间必须**自己占一列**。跟教室拼成一个字符串看着最省事，但
          ellipsize 是从末尾吃的，被吃掉的正好是「-11:30」——用户要看的那一截；
          2×2 那一行也只有 ~110dp（还不算 4×2 每栏）。所以断言的是
          「教室」与「时间」是**两个 TextView**、且在**同一个横向 LinearLayout** 里。
       ② 时间文案必须**只有一份**（`timeRange`）。面板一处、列表行一处，
          各自拼一遍的话早晚变成一处 `09:55-11:30`、一处 `9:55`，
          而桌面上看不出这是 bug。 */
    const tagOf = (xml, id) => {
      const m = new RegExp('<TextView\\s+android:id="@\\+id/' + id + '"[\\s\\S]*?/>').exec(xml);
      return m ? m[0] : '';
    };
    // 两个 id 之间若夹着 </LinearLayout>，说明它们不在同一行里
    const sameRow = (xml, a, b) => {
      const s = xml.indexOf('@+id/' + a);
      const e = xml.indexOf('@+id/' + b);
      return s >= 0 && e > s && !/<\/LinearLayout>/.test(xml.slice(s, e));
    };
    const placeTimePairs = [
      [todayXml, 'w_today_focus_place', 'w_today_focus_time'],
      [twodayXml, 'w_t1_focus_place', 'w_t1_focus_time'],
      [twodayXml, 'w_t2_focus_place', 'w_t2_focus_time'],
      [rowXml, 'w_row_loc', 'w_row_time']
    ];
    for (const [xml, placeId, timeId] of placeTimePairs) {
      const place = tagOf(xml, placeId);
      const time = tagOf(xml, timeId);
      check('教室与上课时间是两列、同一行（' + placeId + '）',
        !!place && !!time && sameRow(xml, placeId, timeId));
      check('教室可缩（weight=1）、时间不可缩（wrap_content，被截就没意义了）',
        /layout_weight="1"/.test(place) && /layout_width="wrap_content"/.test(time));
      check('教室的省略号用 middle（截尾会正好切掉「401」这种门牌号）',
        /ellipsize="middle"/.test(place) && /maxLines="1"/.test(place));
      check('时间用主色（整个组件「时间 == accent」是一条规则）',
        /textColor="@color\/widget_accent"/.test(time));
    }
    check('面板上的时间也是 timeRange 出来的（与列表行同一份文案）',
      /fun timeRange\(/.test(wRender) &&
      /setTextViewText\(ids\.focusTime, timeRange\(c\)\)/.test(wRender));
    check('列表行的时间走同一个 timeRange（不是自己拼的）',
      /setTextViewText\(R\.id\.w_row_time, timeRange\(course\)\)/.test(wRender));
    /* v1.9.45（F3）：原先这边钉的是 `toMinutes(c.end) > toMinutes(c.start)` ——
       等于渲染层**自己也解析一遍 end**，与入口（WidgetData.coursesOn）成了两套
       口径：入口判不出来就整条剔掉，渲染层却是「能解析就拼、解析不了只给
       start」，读起来像一条常态分支。现在渲染层直接用 WidgetCourse 里已经算好
       的 `endMin`，判据与入口同源 ⇒ 断言跟着换口径。
       另**补一条正面哨兵**：入口那三道判据必须还在。它是这条链的第一道闸；
       只剩渲染层兜底的话，「09:55-」就真能拼出来了。 */
    check('timeRange 用 course 里已算好的 endMin，不再自己解析一遍 end',
      /c\.endMin > c\.startMin/.test(wRender) &&
      !/toMinutes\(c\.end\)\s*>/.test(wRender));
    check('入口仍拦着认不出时间的课（渲染层那个 if 是兜底、不是唯一防线）',
      /toMinutes\(start\) < 0 \|\| toMinutes\(end\) < 0/.test(wData));
    check('「正在上课 / 下一节 / 第一节」是分开的三个状态词（不再和教室拼在一起）',
      /"正在上课"/.test(wRender) && /"第一节"/.test(wRender) && /"下一节"/.test(wRender) &&
      /setTextViewText\(ids\.focusState, state\)/.test(wRender));

    /* —— v1.9.25 → v1.9.26：「今天的课已上完」那一块经过了三次迭代 ——
       用户先说「将『今天的课已上完』所在的方框缩小，同时使文字居中」（v1.9.25 做成
       贴合文字的小胶囊），随后改口径：「改成通栏但压成一行高、并且宽度与课程一致」（v1.9.26）。
       根因始终是**它原先借用了 focus 面板** —— 那块里面两行是按「课名 / 教室 + 时间」排的，
       塞一句状态词就成了**两行高的空框、字贴左上角**。
       断言咬形状（不是 grep 某个字样在不在）：
       ① 每个面板各有一块 `*_done`，且**夹在面板与列表之间**（位置错了白搭）；
       ② `layout_width=match_parent` ⇒ **通栏**；**不是** wrap_content —— 那会长短不一、
          与课程行对不齐（v1.9.25 的胶囊形状，写回去就退回上一版）；
       ③ **不许有左右 margin** —— 加了就不再与课程同宽（要留白得改根布局 padding，三处一起动）；
       ④ 「与课程同宽」靠的是**同一个宽度上下文**：课程行的宿主 ListView 与这块在同一个父
          容器里 ⇒ 直接断言两边宽度写法一致；
       ⑤ `wrap_content` 高 + `maxLines=1` + 纵向内边距 ≤ 3dp ⇒ **一行高**（固定高度或大纵向
          内边距就是「没内容还占一块大框」的来源）；
       ⑥ 横向内边距与同一份布局里的焦点面板**取同一个值** ⇒ 文字起点对齐（两边各写一个
          数字早晚会漂）；
       ⑦ `gravity=center` ⇒ 字居中，且**不再有 `layout_gravity`**（那是胶囊时代用来居中的）；
       ⑧ Kotlin 侧四条出口都摆对：已上完 → 藏面板显这块；有课 / 空态 / 过期 → 藏起来。 */
    const wRenderNoComment = wRender
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const previewJs = fs.existsSync(path.join(root, 'tools', 'widget-preview.js'))
      ? fs.readFileSync(path.join(root, 'tools', 'widget-preview.js'), 'utf8') : '';

    /* 取「某个 id 的开始标签」——**不能**复用上面的 tagOf：它写死了 `<TextView`，
       取不到 LinearLayout（焦点面板）的 padding。 */
    const openTagOf = (xml, id) =>
      (new RegExp('<\\w+\\s+android:id="@\\+id/' + id + '"[\\s\\S]*?(?:/>|>)').exec(xml) || [''])[0];
    const padOf = (tag, side) => {
      const m = new RegExp('android:padding' + side + '="(\\d+)dp"').exec(tag);
      return m ? Number(m[1]) : null;
    };

    const donePills = [
      [todayXml, 'w_today_focus', 'w_today_done', 'w_today_list'],
      [twodayXml, 'w_t1_focus', 'w_t1_done', 'w_t1_list'],
      [twodayXml, 'w_t2_focus', 'w_t2_done', 'w_t2_list']
    ];
    for (const [xml, focusId, doneId, listId] of donePills) {
      const pill = openTagOf(xml, doneId);
      const focusTag = openTagOf(xml, focusId);
      const listTag = openTagOf(xml, listId);
      const iF = xml.indexOf('@+id/' + focusId);
      const iD = xml.indexOf('@+id/' + doneId);
      const iL = xml.indexOf('@+id/' + listId);
      check('「已上完」有专用的一块，且夹在面板与列表之间（' + doneId + '）',
        !!pill && !!focusTag && !!listTag && iF >= 0 && iD > iF && iL > iD);
      check('那块是通栏的：match_parent 宽、**不是** wrap_content（' + doneId + '）',
        /layout_width="match_parent"/.test(pill) &&
        !/layout_width="wrap_content"/.test(pill));
      check('通栏但不加左右 margin —— 加了就不与课程行同宽了（' + doneId + '）',
        !/layout_margin(Start|End|Left|Right)/.test(pill));
      check('与课程同宽靠的是同一个宽度上下文：课程行的宿主 ListView 也是 match_parent（' + doneId + '）',
        /layout_width="match_parent"/.test(listTag));
      check('压成一行高：wrap_content 高 + 只许一行 + 纵向内边距 ≤ 3dp（' + doneId + '）',
        /layout_height="wrap_content"/.test(pill) && /maxLines="1"/.test(pill) &&
        padOf(pill, 'Top') !== null && padOf(pill, 'Top') <= 3 &&
        padOf(pill, 'Bottom') !== null && padOf(pill, 'Bottom') <= 3,
        /* detail 三个分量都打出来：只打 padding 的话，「删掉 maxLines」看起来会像
           「padding 有问题」，排查时容易往错的方向找 */
        'height=' + (/layout_height="([^"]+)"/.exec(pill) || [])[1] +
        ' maxLines=' + (/maxLines="(\d+)"/.exec(pill) || [])[1] +
        ' padY=' + padOf(pill, 'Top') + '/' + padOf(pill, 'Bottom'));
      check('横向内边距与同布局的焦点面板取同一个值（文字起点才对齐）（' + doneId + '）',
        padOf(pill, 'Start') !== null && padOf(pill, 'Start') === padOf(focusTag, 'Start') &&
        padOf(pill, 'End') === padOf(focusTag, 'End'),
        'done=' + padOf(pill, 'Start') + '/' + padOf(pill, 'End') +
        ' focus=' + padOf(focusTag, 'Start') + '/' + padOf(focusTag, 'End'));
      check('字在框里居中，且不再有 layout_gravity（那是胶囊时代用来居中的）（' + doneId + '）',
        /android:gravity="center"/.test(pill) && !/layout_gravity/.test(pill));
      check('那块默认是藏着的（页面一进来不该先闪一下这句话）',
        /android:visibility="gone"/.test(pill));
    }
    check('「已上完」时藏掉面板、换成通栏的那块',
      /setViewVisibility\(ids\.focus, View\.GONE\)[\s\S]{0,80}setViewVisibility\(ids\.done, View\.VISIBLE\)/
        .test(wRenderNoComment) &&
      /setTextViewText\(ids\.done, "今天的课已上完"\)/.test(wRenderNoComment));
    check('有「最近一节课」时反过来：面板显示、那块藏掉',
      /setViewVisibility\(ids\.done, View\.GONE\)[\s\S]{0,80}setViewVisibility\(ids\.focus, View\.VISIBLE\)/
        .test(wRenderNoComment));
    const hintFn = (/private fun showHint\([\s\S]*?\n    \}/.exec(wRenderNoComment) || [])[0] || '';
    check('切出了 showHint 函数体（哨兵：切不出来下面那条会假绿）', hintFn.length > 100, hintFn.length);
    check('空态 / 过期态也把那块藏掉（出口漏一条就会一直挂着上一句话）',
      /setViewVisibility\(ids\.done, View\.GONE\)/.test(hintFn));
    check('三块的 id 都从 Provider 传进去（少一个，那一路状态就画不出来）',
      /done = R\.id\.w_today_done/.test(wProv) &&
      /done = R\.id\.w_t1_done/.test(wProv) && /done = R\.id\.w_t2_done/.test(wProv));
    check('「今天的课已上完」在渲染与预览里各只写一次（两处同一个字符串，不许各写一版）',
      (wRenderNoComment.match(/今天的课已上完/g) || []).length === 1 &&
      (previewJs.replace(/\/\*[\s\S]*?\*\//g, '').match(/今天的课已上完/g) || []).length === 1);
    /* 预览必须与真机同形 —— v1.9.25 的预览里包了一个 `justify-content:center` 的壳子，
       画出来是个居中的小胶囊；真机上（v1.9.26）已经是通栏。**拿一张真机不存在的图给人看**，
       比不画还糟：用户会照着图提要求。所以这里把「不套壳子」也钉住。 */
    check('预览里那块不再是「居中胶囊」：没有居中壳子，且是容器的直接子项（真机上也如此）',
      !/w-donewrap/.test(previewJs) &&
      /<div class="w-done" style="background:/.test(previewJs));
    const doneCss = (previewJs.match(/\.w-done \{[^}]*\}/g) || []).join(' ');
    check('预览里那块文字居中、且自己不写 flex（通栏靠父容器的 stretch）',
      /text-align:\s*center/.test(doneCss) && !/display:\s*flex/.test(doneCss), doneCss.length);
    const padX = (re) => Number((re.exec(previewJs) || [])[1]);
    check('预览的横向内边距与同一容器里的焦点面板取同一个值（真机上也要求两边相等）',
      padX(/\.w\.today \.w-done \{[^}]*padding:\s*\d+px (\d+)px/) ===
        padX(/\.w\.today \.w-focus \{[^}]*padding:\s*\d+px (\d+)px/) &&
      Number.isFinite(padX(/\.w\.twoday \.w-done \{[^}]*padding:\s*\d+px (\d+)px/)) &&
      padX(/\.w\.twoday \.w-done \{[^}]*padding:\s*\d+px (\d+)px/) ===
        padX(/\.w\.twoday \.w-focus \{[^}]*padding:\s*\d+px (\d+)px/));
    /* 预览页整个是**一条模板字符串**：注释里写反引号会把模板当场截断
       （SyntaxError: Unexpected identifier '…'），而且报错指着注释里的字，
       看着完全不像语法问题 —— v1.9.25 / v1.9.26 各栽一次。
       这种错**静态断言抓不到别的**，只能专门钉这一条：模板内容里一个反引号都不许有。 */
    const tplStart = previewJs.indexOf('`<!doctype html>');
    const tplEnd = tplStart < 0 ? -1 : previewJs.indexOf('\n`;', tplStart);
    const tplInner = (tplStart >= 0 && tplEnd > tplStart)
      ? previewJs.slice(tplStart + 1, tplEnd) : '';
    check('切出了预览的模板字符串（哨兵：切不出来下面那条会假绿）',
      tplInner.length > 2000, tplInner.length);
    check('模板字符串内部一个反引号都不许有（注释里要引 CSS 属性名请用「」）',
      tplInner.length > 0 && tplInner.indexOf('`') < 0);
    /* ⚠️ 这条最初写成 `/DONE_MIN/.test(previewJs)` —— 把 `var DONE_MIN = 23 * 60`
       改成 `= NOW` 之后照样绿（字样还在），又是一条**只查名字在不在**的弱断言。
       改法：读**值**（推到 20 点以后才算「当天最后」）并且**认使用处**。 */
    const doneMinDecl = /var DONE_MIN = (\d+) \* 60;/.exec(previewJs);
    check('预览里的「已上完」是把时间推到当天最后（写回 NOW 就不是这一态了）',
      !!doneMinDecl && Number(doneMinDecl[1]) >= 20,
      doneMinDecl ? doneMinDecl[1] + ' 点' : '没找到 DONE_MIN');
    check('两个「已上完」预览实例真的用 DONE_MIN（漏一个那一路还是「正在上课」）',
      /panel\('w3'[\s\S]{0,160}?DONE_MIN/.test(previewJs) &&
      /panel\('w4a'[\s\S]{0,160}?DONE_MIN/.test(previewJs));
  }
  /* v1.9.43：原来这条是正向的「布局含「导入课表」主按钮与「适应屏幕」开关」。
     三个按钮删掉之后翻成反向断言 —— 但**必须配一条正面锚点**，
     否则「eduLayout 没读到 / 读成空串」时这条会假绿。 */
  check('切出了内嵌浏览器的布局（哨兵：下面那条反向断言的假绿守门员）',
    eduLayout.length > 800 && /id="@\+id\/eduRoot"/.test(eduLayout), eduLayout.length);
  check('布局里不再有「导入课表」主按钮与「适应屏幕」开关',
    !/btnEduGrab/.test(eduLayout) && !/btnEduFit/.test(eduLayout) &&
    !/btnEduHelp/.test(eduLayout));
  check('布局含地址栏，可改其它学校的教务地址', /id="@\+id\/eduUrl"/.test(eduLayout));
  check('布局含放大 / 缩小按钮',
    /id="@\+id\/btnEduZoomIn"/.test(eduLayout) &&
    /id="@\+id\/btnEduZoomOut"/.test(eduLayout));

  check('自研解析器不依赖任何第三方库', !/require\(|import\s|from\s+['"]/.test(eduHtmlJs) &&
    !/require\(|import\s|from\s+['"]/.test(htmlParserJs));
  check('提取器覆盖正方多个版本的表格 id',
    /kbgrid_table/.test(eduHtmlJs) && /kbtable/.test(eduHtmlJs) && /Table1/.test(eduHtmlJs));
  check('提取器用「表头星期 + 左侧节次」定位，而非写死单元格 id',
    /colDay/.test(eduHtmlJs) && /rowSec/.test(eduHtmlJs));

  /* —— v1.8：解析器改成「多变体级联 + 每个变体自检」——
     照搬同业实现的架构：与其写一个想覆盖所有情况的巨型解析器（一改就回归），
     不如写若干互相独立的变体，各自只赌一种页面结构，跑完统一体检。 */
  check('提取器是变体级联：课表网格 / 课程列表 / 任意星期表 / 网页课程块',
    /VARIANTS/.test(eduHtmlJs) && /'kbgrid'/.test(eduHtmlJs) && /'list'/.test(eduHtmlJs) &&
    /'table'/.test(eduHtmlJs) && /'div'/.test(eduHtmlJs));
  check('每个变体跑完做字段体检，缺字段即判不可信',
    /function auditCourses/.test(eduHtmlJs) && /课程名不像课名/.test(eduHtmlJs));
  check('只在「通过体检」的变体里比课程数',
    /attempts\.filter/.test(eduHtmlJs) && /a\.ok/.test(eduHtmlJs));
  check('新增列表式课表变体（正方新版 sycjlrtabGrid：一行一门课）',
    /function extractFromListTable/.test(eduHtmlJs) && /sycjlrtabGrid/.test(eduHtmlJs) &&
    /aria-describedby/.test(eduHtmlJs) && /roleOfHeader/.test(eduHtmlJs));
  check('一行式文本扫描器：星期 / 节次 / 周次 / 地点 / 教师一次抽全',
    /function scanText/.test(eduHtmlJs) && /function hasTimeStructure/.test(eduHtmlJs));
  check('扫描器会对纯课程名提前退出，不误判成人名',
    /if \(!hasTimeStructure\(t\)\) return out/.test(eduHtmlJs));
  check('覆盖多代正方表格 id（含 table_tb / td_ 系列）',
    /table_tb/.test(eduHtmlJs) && /td_/.test(eduHtmlJs) && /kbgrid/.test(eduHtmlJs));
  check('td.id 首段当星期的脏约定有兜底（列表路径同样取星期与节次）',
    /sectionFromId/.test(eduHtmlJs) && /idSecRow/.test(eduHtmlJs) &&
    /if \(!idSecRow\)/.test(eduHtmlJs));
  check('失败时区分三种场景：翻错页 / 课表没显示节次 / 解析不出',
    /这个页面里没有课表/.test(eduHtmlJs) && /齿轮/.test(eduHtmlJs) &&
    /输出 PDF \/ 导出课表/.test(eduHtmlJs) && /长按左下角「怎么用」/.test(eduHtmlJs));
  check('失败时附上各变体的尝试记录，便于用户回传定位',
    /解析尝试记录/.test(eduHtmlJs) && /attempts/.test(eduHtmlJs));

  /* —— v1.8.1：真机现场（正方「课表列表」/「表格」视图）暴露的解析缺口 —— */
  check('剥掉「教师：」「上课地点：」「周数：」这类字段名外壳',
    /function stripLabel/.test(eduHtmlJs) && /LABEL_SEP/.test(eduHtmlJs) &&
    /LABEL_BARE/.test(eduHtmlJs) && /function labelRole/.test(eduHtmlJs));
  check('地点形状覆盖「明理（5）-401」（楼名（楼号）-房间号）',
    /楼栋号/.test(eduHtmlJs) && /\[（\(\]/.test(eduHtmlJs));
  check('课程名兜底不再把节次「1-2」当课名',
    /function looksCourseName/.test(eduHtmlJs) && /function pickCourseName/.test(eduHtmlJs) &&
    /NOT_A_COURSE_NAME/.test(eduHtmlJs));
  check('「课表信息」一列被当成课程块整格拆（roleOfHeader -> info）',
    /return 'info'/.test(eduHtmlJs) && /课表信息/.test(eduHtmlJs) &&
    /got\['info'\]/.test(eduHtmlJs));
  check('表格 id 换了也不失效：任意表格兜底（allTables）',
    /function pickTables\(doc, selectors, allTables\)/.test(eduHtmlJs) &&
    /function tableHasContent/.test(eduHtmlJs) && /pickTables\(doc, LIST_SELECTORS, true\)/.test(eduHtmlJs));
  check('节次列只写「1-2」也认（sectionOf 非严格模式兜底）',
    /sectionOf\(tText, false\)/.test(eduHtmlJs) && /sTry\.end <= 14/.test(eduHtmlJs));
  check('周次保留单双周：「2-16周(双)」不被截成「2-16周」',
    /\[（\(\]\\s\*\[单双\]\\s\*\[）\)\]/.test(eduHtmlJs));
  check('同一格里多行文本按课程块拆（课程名与教师不会串位）',
    /bLines\.length < 2/.test(eduHtmlJs) && /cellLines\(bc\.node\)/.test(eduHtmlJs));

  /* —— v1.9.43：原生侧的「自研抓页」相关件全没了 ——
     先说清楚这一节的性质：**全是反向断言**（「某某不再存在」），
     而反向断言最容易永远绿 —— 文件读空、路径写错时它们统统通过。
     所以末尾钉了一条「eduKt 正文确实读到了」的守门员，
     而且这一段的所有判据都走**剥注释后**的正文（删掉的东西只剩墓碑注释里提名字，
     不剥的话断言会被注释自己绊红 —— 写这组时真踩到）。 */
  check('每页加载完校正 viewport 的机制已删（只剩一档显示方式，没什么可校正的）',
    !/applyViewportFix/.test(eduKtNoComment) && !/VIEWPORT_FIT_JS/.test(eduKtNoComment) &&
    !/VIEWPORT_RAW_JS/.test(eduKtNoComment));
  check('内嵌框架可读统计（frameWarning / frames++）已删',
    !/frameWarning/.test(eduKtNoComment) && !/frames\+\+/.test(eduKtNoComment));
  check('「长按把当前页面存下来」那条排查出口已删（dumpCurrentPage / onDump 都不在）',
    !/dumpCurrentPage/.test(eduKtNoComment) && !/fun onDump/.test(eduKtNoComment));
  check('注入式抓取脚本（grabJs + onHtml/onDump 分派）已删',
    !/fun grabJs/.test(eduKtNoComment) && !/fun onHtml/.test(eduKtNoComment));
  check('「是不是课表页」的预检与那几张长文案已删',
    !/hasWeekdayHeading/.test(eduKtNoComment) && !/looksLikeSchedulePage/.test(eduKtNoComment) &&
    !/课表还没显示节次/.test(eduKtNoComment));
  check('弹窗式长文案底座已删，toast 那条节流留着（适配脚本会成串发提示）',
    !/private fun showTip/.test(eduKtNoComment) && /private fun toast/.test(eduKtNoComment));
  check('守门员：eduKt 正文确实读到了（上面 6 条反向断言的前提，读空就全假绿）',
    eduKtNoComment.length > 4000, eduKtNoComment.length);

  const filePathsXml = fs.readFileSync(path.join(
    root, 'android', 'app', 'src', 'main', 'res', 'xml', 'file_paths.xml'), 'utf8');

  /* ⚠️ 「分享课表」这条正路的断言**搬家了**：原来查的是 eduKt 里那份
     「把教务页面存下来再分享」（offerShare / shareDump），随抓页一起删了。
     真正给用户用的那份在 MainActivity（ShareBridge 的 cacheDir/share 那份 .csv），
     所以判据要跟着搬到 kt —— 不搬的话这一组会「因为文件被删而变绿」，
     等于把「分享功能还在不在」这条覆盖悄悄丢了。 */
  check('分享课表走系统分享面板（ACTION_SEND + 授予读权限 + 自绘选择器）',
    /Intent\.ACTION_SEND/.test(ktNoComment) &&
    /FLAG_GRANT_READ_URI_PERMISSION/.test(ktNoComment) &&
    /Intent\.createChooser/.test(ktNoComment));
  check('分享落盘用自家 FileProvider 换成 content://（不塞 file://）',
    /FileProvider\.getUriForFile/.test(ktNoComment));
  /* ⚠️ 反向断言必须读**剥了 XML 注释**的那份。
     file_paths.xml 的注释里为了讲「v1.9.43 为什么删掉 dumps 那条」，
     白纸黑字写着 `dumps` 与 `external-files-path` —— 用原文去查「不许出现」，
     会被自己的解释绊红（第一次就是栽在这上面，7 条红里占了 2 条）。 */
  const filePathsNoComment = filePathsXml.replace(/<!--[\s\S]*?-->/g, '');
  check('FileProvider 白名单只剩 cacheDir/share/ 一条（dumps 那条随抓页一起删）',
    /<cache-path\s+name="share"\s+path="share\/"\s*\/>/.test(filePathsNoComment) &&
    !/dumps/.test(filePathsNoComment));

  check('Manifest 注册 FileProvider（老机型兜底，不新增任何权限）',
    /androidx\.core\.content\.FileProvider/.test(manifest) &&
    /android:grantUriPermissions="true"/.test(manifest) &&
    /@xml\/file_paths/.test(manifest));
  /* v1.9.43：原来这条是「只暴露 dumps / cache 两个目录」。
     dumps 随自研抓页一起删了，现在**只剩一条** —— 判据跟着翻过来，
     但保留「不许放开整个存储」的底线（那是这条断言真正的价值）。 */
  check('FileProvider 只剩 share/ 一条目录，且不许放开整个存储',
    /cache-path/.test(filePathsNoComment) && !/external-files-path/.test(filePathsNoComment) &&
    !/<external-path|root-path/.test(filePathsNoComment));

  /* —— 一键打包脚本的前置 ——
     v1.9.42 起 `build-apk.bat` **只剩一步 Node**：把 web/ 镜像进 assets/。
     （v1.9.41 那一步「先生成内置脚本正文」随自研脚本一起拆掉了。）
     判据锚的是**真实调用行**（`"%~dp0xxx.js"`），不是「文件名出现没出现过」——
     第一版按名字找，被脚本头部那句「等价于手工执行 node tools/sync-assets.js」
     的**注释**骗了。（「只查字符串在不在、不锚住它在哪」是个反复踩的坑。） */
  const batBuild = fs.existsSync(path.join(root, 'tools', 'build-apk.bat'))
    ? fs.readFileSync(path.join(root, 'tools', 'build-apk.bat'), 'utf8') : '';
  const batSync = batBuild.indexOf('"%~dp0sync-assets.js"');
  check('一键打包脚本同步 web/ 那一步还在（真实调用行）', batSync >= 0, 'sync@' + batSync);
  check('一键打包脚本不再调用已删掉的生成器（留着就是一个必然失败的步骤）',
    batBuild.indexOf('gen-adapter-local') < 0);

  /* —— 资源同步检查 ——
     APK 里装的是 android/app/src/main/assets/web/，改完 web/ 忘记同步的话，
     打出来的包跑的还是旧页面（本次就踩到了：解析器已重写，APK 里还是旧的）。
     tools/build-apk.bat 现在会在构建前自动同步，这里再静态兜一道。 */
  console.log('\n[21] 打开教务系统：地址簿纯用户数据，本校只走适配库通道（v1.9.36）');
  const schoolsJs = fs.readFileSync(path.join(root, 'web', 'js', 'schools.js'), 'utf8');
  const Schools = global.Schools;

  check('引入了学校列表模块，且在 app.js 之前（否则 app.js 拿不到）',
    /src="js\/schools\.js"/.test(htmlSrc) &&
    htmlSrc.indexOf('js/schools.js') < htmlSrc.indexOf('js/app.js'));
  check('模块已加载并暴露 Schools', !!(Schools && typeof Schools.search === 'function'));
  /* v1.9.36 拍板：本校**不做特例**。内置数据只喂 localLibrary()（适配库
     字母列表通道），地址簿（all/search/一键直达）回归纯用户数据。
     判据**只咬形状**，校名不进测试文件 —— 真值在 schools.js 里。 */
  const builtinList = Schools.builtin();
  check('内置适配数据：恰好一条、带教务地址（不进地址簿）',
    Array.isArray(builtinList) && builtinList.length === 1 &&
    !!builtinList[0].url &&
    /jwglxt\/xtgl\/login_slogin\.html$/.test(builtinList[0].url) &&
    /^[a-z0-9.-]+\.edu\.cn$/i.test(Schools.hostOf(builtinList[0].url)),
    builtinList.length + ' 条 / ' + String(builtinList[0] && builtinList[0].url));
  check('内置这条**只给地址、不给脚本**（v1.9.42：脚本改用上游那只，运行时下载）',
    !/adapterJs/.test(schoolsJs) &&
    /upstreamFolder:/.test(schoolsJs) && /upstreamJsPath:/.test(schoolsJs));
  check('本校不做特例：primary 已拆除（API 不存在、条目无 primary 标记、app.js 无调用）',
    typeof Schools.primary === 'undefined' &&
    builtinList[0].primary === undefined &&
    !/SCH\.primary\(\)/.test(appjs) &&
    !/本校（点一下即打开）/.test(appjs));
  check('地址簿是纯用户数据：清空后 all() 为 0，自建一条变 1，删掉归 0',
    (function () {
      Schools.clearAll();
      Schools.reload();
      const empty = Schools.all().length === 0;
      Schools.addCustom('甲大学', 'jw.jia.edu.cn');
      const one = Schools.all().some(function (s) { return s.name === '甲大学'; });
      Schools.removeCustom(Schools.customList()[0].id);
      return empty && one && Schools.all().length === 0;
    })());
  check('地址簿搜索只认用户加过的学校（不假装认识没加过的）',
    Schools.search('示例师范大学').length === 0 &&
    Schools.search('demo').length === 0);
  check('只填域名时能按正方规则补全登录路径',
    Schools.standardZfUrl('jwgl.example.edu.cn') ===
    'https://jwgl.example.edu.cn/jwglxt/xtgl/login_slogin.html');
  check('缺协议头时自动补 https',
    Schools.normalizeUrl('jwxt.example.edu.cn') === 'https://jwxt.example.edu.cn');
  check('能认出「只填了域名」（用于给出补全提示）',
    Schools.isBareHost('jwgl.example.edu.cn') === true &&
    Schools.isBareHost('https://jwgl.example.edu.cn/jwglxt/') === false);
  check('自定义学校能存能删',
    (function () {
      Schools.clearAll(); Schools.reload();
      const it = Schools.addCustom('测试大学', 'jw.test.edu.cn', '湖南');
      const has = Schools.customList().some(function (x) { return x.id === it.id; });
      const gone = Schools.removeCustom(it.id);
      return has && gone &&
        !Schools.customList().some(function (x) { return x.id === it.id; });
    })());
  check('地址里没有域名时拒绝保存（不静默存坏数据）',
    (function () {
      try { Schools.addCustom('坏学校', '没有域名'); return false; }
      catch (e) { return /域名/.test(e.message); }
    })());
  check('最近使用按 URL 去重并置顶',
    (function () {
      Schools.clearRecent();
      Schools.pushRecent('A 校', 'https://a.edu.cn/jwglxt/', '');
      Schools.pushRecent('B 校', 'https://b.edu.cn/jwglxt/', '');
      Schools.pushRecent('A 校', 'https://a.edu.cn/jwglxt/', '');
      return Schools.recent().length === 2 && Schools.recent()[0].name === 'A 校';
    })());
  check('批量导入能吃「校名,地址」与「校名 地址」两种写法；再导入一次全跳过',
    (function () {
      Schools.clearAll(); Schools.reload();
      const text =
        '甲大学,湖南,https://jw.jia.edu.cn/jwglxt/xtgl/login_slogin.html\n' +
        '乙学院 jwglxt.yi.edu.cn\n' +
        '# 注释行';
      const r1 = Schools.parseImport(text);
      const r2 = Schools.parseImport(text);
      const names = Schools.customList().map(function (x) { return x.name; });
      return r1.added === 2 && r1.skipped === 0 &&
        r2.added === 0 && r2.skipped === 2 &&
        names.indexOf('甲大学') >= 0 && names.indexOf('乙学院') >= 0;
    })());
  check('批量导入也接受 JSON 数组',
    (function () {
      Schools.clearAll(); Schools.reload();
      const r = Schools.parseImport(JSON.stringify([{ name: '丙大学', url: 'jwgling.edu.cn' }]));
      return r.added === 1 &&
        Schools.customList().some(function (x) { return x.name === '丙大学'; });
    })());
  check('导出的「我的学校」是可再次导入的格式',
    (function () {
      Schools.clearAll(); Schools.reload();
      Schools.addCustom('甲大学', 'jw.jia.edu.cn', '湖南');
      const first = Schools.exportText().split('\n')[0];
      return first.split(',').length === 3 && /https?:\/\//.test(first);
    })());
  check('坏 JSON 不抛异常，只回报错误',
    (function () { const r = Schools.parseImport('[坏'); return r.added === 0 && r.errors.length > 0; })());
  check('数据只存本机 localStorage，不上传任何服务器',
    /localStorage/.test(schoolsJs) && !/fetch\(|XMLHttpRequest/.test(schoolsJs));
  check('学校列表模块零第三方依赖（只用原生 API）',
    !/\brequire\(/.test(schoolsJs) && !/^\s*import\s/m.test(schoolsJs));

  /* —— 中性化：整个仓库不再指认任何一所具体学校 —— */
  check('「打开教务系统」的主按钮默认不写死校名（文案跟着用户添加的学校走）',
    /id="btnEduEntry"/.test(htmlSrc) && /id="eduEntryLabel"/.test(htmlSrc) &&
    /打开我的学校教务系统/.test(htmlSrc) &&
    /function syncEduEntry/.test(appjs) && /eduEntryLabel/.test(appjs));
  check('导入面板保留「第一次用」引导且不再写「本校已内置」特例口径',
    /第一次用/.test(htmlSrc) && /社区适配库/.test(htmlSrc) &&
    !/本校已内置/.test(htmlSrc) && !/一步直达/.test(htmlSrc));
  /* ⚠️ 这条一开始写的是「整个 app.js 里有没有这几块字样」—— 变异 #2 把它抓出来了：
     删掉 `if (!p) { … return; }` 整段，`SCH.primary() || …` 与 `openSchoolSheet()` 在别处
     照样存在（`syncEduEntry` / 别处也调），于是断言**照样绿**。
     修法：**先切出主按钮那个函数的函数体**，再断言「兜底分支在里面、而且它在 openEduBrowser 之前」。 */
  const eduEntryFn = sliceFn(appjs, 'function openEduEntry() {') || '';
  check('切出了主按钮处理函数的函数体（哨兵：切不出来下面那条会假绿）',
    eduEntryFn.length > 120, eduEntryFn.length + ' 字符');
  check('一条学校都没有时先把用户送到添加页，而不是去打开空地址',
    /if\s*\(\s*!p\s*\)\s*\{/.test(eduEntryFn) &&
    /openSchoolSheet\(\)/.test(eduEntryFn) &&
    /return;/.test(eduEntryFn) &&
    /SCH\.recent\(\)\[0\]\s*\|\|\s*SCH\.customList\(\)\[0\]/.test(eduEntryFn) &&
    !/SCH\.primary\(\)/.test(eduEntryFn) &&
    eduEntryFn.indexOf('if (!p)') < eduEntryFn.indexOf('openEduBrowser'));
  /* 文案在 v1.9.32 改了：入口现在同时通向「社区适配库」和「我的学校」，
     原「选择 / 添加我的学校」只说了后一半，会让人以为要先自己填地址。 */
  check('导入入口文案已同时讲明两条路（社区适配库 / 我的学校）',
    /id="btnEduImport"/.test(htmlSrc) && /选择学校（社区适配库 \/ 我的学校）/.test(htmlSrc) &&
    !/选择 \/ 添加我的学校/.test(htmlSrc));
  check('选择页空态给出「手动输入 / 批量导入」引导（没有「本校」特例组）',
    /还没有添加学校/.test(appjs) && /手动输入/.test(appjs) &&
    !/本校在「本校」一组里/.test(appjs) && !/内置只有/.test(appjs));
  check('打开教务系统弹层有搜索框与列表，省份筛选已移除',
    /id="schoolSearch"/.test(htmlSrc) && /id="schoolList"/.test(htmlSrc) &&
    !/id="schoolProvs"/.test(htmlSrc));
  check('可手动输入地址，并提供「按正方规则补全」',
    /id="schName"/.test(htmlSrc) && /id="schUrl"/.test(htmlSrc) && /id="btnSchZf"/.test(htmlSrc));
  check('可批量导入 / 导出学校列表',
    /id="schImportArea"/.test(htmlSrc) && /id="btnSchImportDo"/.test(htmlSrc) &&
    /id="btnSchExport"/.test(htmlSrc));
  check('选中学校后把地址交给原生浏览器（不再靠用户改地址栏）',
    /AndroidEdu\.open\(url/.test(appjs) && /function launchEdu/.test(appjs));
  check('点「删除」不会连带打开浏览器（先判 data-del 再判 data-url）',
    appjs.indexOf("closestBy(t, 'data-del')") < appjs.indexOf("closestBy(t, 'data-url')"));
  check('样式表补了学校列表相关类（省份筛选样式已随功能移除）',
    /\.sch-group\s*\{/.test(css2) && /\.school-list\s*\{/.test(css2) &&
    !/\.prov-chips\s*\{/.test(css2));
  /* v1.9.35：内置本校的地址**只允许**出现在 schools.js 里（htmlSrc / appjs
     仍一概不许）。形状判据不变，只是给 schools.js 一处显式豁免。 */
  check('本校教务地址只出现在 schools.js（其他出厂内容仍是零真实主机）',
    realSchoolHosts(schoolsJs).length === 1 &&
    realSchoolHosts(htmlSrc + appjs).length === 0,
    realSchoolHosts(schoolsJs).join('、') + ' | ' +
    realSchoolHosts(htmlSrc + appjs).join('、'));

  /* —— v1.9.35：本校适配挂进适配库查询层（setLocalSchools → 查询层合并） ——
     本校不在上游索引里，全靠这条链进列表：schools.localLibrary() →
     app.init() → Warehouse.setLocalSchools() → schools()/search()/adapterById()。
     任何一环断了，字母列表里就又没有用户的学校了 —— 每一环都要咬住。 */
  (function () {
    const WH = global.Warehouse;
    if (!WH || typeof WH.setLocalSchools !== 'function') {
      check('Warehouse 暴露 setLocalSchools / localSchools', false,
        'setLocalSchools 不存在（合并 API 丢了）');
      return;
    }
    const lib = Schools.localLibrary();
    WH.setLocalSchools(lib);
    const id = lib[0].id;
    const aid = lib[0].adapters[0].adapterId;
    check('localLibrary 产出仓库同形条目（id/name/initial/folder/adapters）',
      lib.length === 1 && !!id && !!lib[0].name && !!lib[0].initial &&
      /* folder 必须是**上游那只脚本所在的目录**，不是 'local'（v1.9.42）——
         它同时是 scriptUrls() 拼地址的第一段，写错了就是四条 404 */
      lib[0].folder === 'zhengfang_jiaowu' && lib[0].adapters.length === 1);
    check('注册后 schools() 里有本校（适配库没载入时也查得到）',
      WH.schools().some(function (s) { return s.id === id; }));
    check('adapterById 能找到本校适配并带回学校',
      (function () { const f = WH.adapterById(aid); return !!f && f.school.id === id; })());
    /* ⚠️ 这一条不能只断「aid !== 'zhengfang_01'」—— 那是拿常量跟常量比，永远绿。
       真要把「撞 id」这件事咬死，得**让两只同时存在**再各查一次：
       `adapterById()` 只返回第一个命中，同名的话点「正方教务-通用教务」那行
       会查到本校、随后被学校 id 校验挡掉，界面显示「这所学校的适配脚本没找到」——
       用户与排查的人都不会想到是 id 撞了。 */
    check('本校那条与上游那只**同场也不互相截胡**（id 撞了会把「正方教务-通用教务」那行打挂）',
      (function () {
        const KEY = WH.KEY;
        const prev = global.localStorage.getItem(KEY);
        try {
          global.localStorage.setItem(KEY, JSON.stringify({
            versionId: 'test', cachedAt: Date.now(), srcId: '',
            schools: [{
              id: 'zhengfang_jiaowu', name: '正方教务-通用教务', initial: 'Z',
              folder: 'zhengfang_jiaowu',
              adapters: [{
                adapterId: 'zhengfang_01', name: '正方教务html通用获取', category: 1,
                jsPath: 'zhengfang_01.js', importUrl: '', description: '', maintainer: '星河欲转'
              }]
            }]
          }));
          WH.reload();
          const up = WH.adapterById('zhengfang_01');
          const mine = WH.adapterById(aid);
          return !!up && up.school.id === 'zhengfang_jiaowu' &&
                 !!mine && mine.school.id === id;
        } finally {
          if (prev === null) global.localStorage.removeItem(KEY);
          else global.localStorage.setItem(KEY, prev);
          WH.reload();
        }
      })());
    check('本校那一行**照常给出四条上游下载地址**（v1.9.42：脚本不再随包）',
      (function () {
        const f = WH.adapterById(aid);
        const urls = WH.scriptUrls(f.school, f.adapter);
        return urls.length === 4 &&
          urls.every(function (u) { return /\/resources\/zhengfang_jiaowu\/zhengfang_01\.js$/.test(u); });
      })());
    check('网页侧不再有「自带正文」这个出口（localSourceOf / isLocalScript 已拆）',
      typeof WH.localSourceOf === 'undefined' && typeof WH.isLocalScript === 'undefined');
    check('搜索本校能搜到', WH.search(lib[0].name.slice(0, 2))
      .some(function (s) { return s.id === id; }));
    check('setLocalSchools 是整体替换（重复调用不叠加）',
      (function () {
        WH.setLocalSchools(lib); WH.setLocalSchools(lib);
        return WH.localSchools().length === 1;
      })());
    check('形状不合格的注册条目整条丢弃（不让坏数据混进列表）',
      (function () {
        WH.setLocalSchools([{ id: 'x' }, { id: 'y', name: 'n' }].concat(lib));
        const onlyLib = WH.localSchools().length === 1;
        WH.setLocalSchools(lib);
        return onlyLib;
      })());
    check('app.js 启动时真的注册（init 里 setLocalSchools(SCH.localLibrary())）',
      /setLocalSchools\(SCH\.localLibrary\(\)\)/.test(appjs));
    check('一键直达先认本地适配（openEduEntry 里的 pickFor 覆盖本校）',
      (function () {
        const fn = sliceFn(appjs, 'function pickFor(') || '';
        return /localPickFor/.test(fn);
      })());
    check('点学校行也先认本地适配（launchEdu 里 localPickFor 先于 openEduBrowser）',
      (function () {
        const fn = sliceFn(appjs, 'function launchEdu(') || '';
        return /localPickFor/.test(fn) &&
          fn.indexOf('localPickFor') < fn.indexOf('openEduBrowser');
      })());
  })();

  const assetsWeb = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'web');
  if (fs.existsSync(assetsWeb)) {
    const syncFiles = ['index.html', 'manifest.webmanifest', 'css/app.css', 'js/app.js',
      'js/store.js', 'js/importer.js', 'js/html.js', 'js/edugrab.js', 'js/xls.js',
      'js/pdf.js', 'js/csv.js', 'js/schools.js', 'js/picker.js',
      'js/warehouse.js', 'js/adapter-import.js',
      'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
      'icons/apple-touch-icon-180.png'];
    const stale = syncFiles.filter(function (f) {
      const a = path.join(root, 'web', f), b = path.join(assetsWeb, f);
      if (!fs.existsSync(a)) return false;
      if (!fs.existsSync(b)) return true;
      return fs.readFileSync(a).compare(fs.readFileSync(b)) !== 0;
    });
    check('assets/web 与 web/ 已同步（否则 APK 里跑的是旧代码）',
      stale.length === 0, stale.join('、'));

    /* 反向：assets/web 里**不许**有白名单之外的文件。
       web/ 是「出厂内容目录」——sync-assets.js 是整个目录镜像进 assets/，
       往里放任何东西（开发用 CSV、备份、误拖进来的一张图）都会静默进包。
       上面那条只回答「白名单内的有没有漏同步」，永远查不出「多出来的」，
       于是 v1.9.26 包里一直躺着一份用户真实课表（含真实教师姓名）而全绿。
       哨兵必须有：目录读不到时 actualFiles 为空、extraFiles 也为空 ⇒ 静默变绿。 */
    var relFiles = function (dir, base) {
      var out = [];
      fs.readdirSync(dir).forEach(function (name) {
        var p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) out = out.concat(relFiles(p, base));
        else out.push(path.relative(base, p).split(path.sep).join('/'));
      });
      return out;
    };
    var actualFiles = relFiles(assetsWeb, assetsWeb).sort();
    check('assets/web 文件数不少于白名单（目录读不到要报错，不能静默变绿）',
      actualFiles.length >= syncFiles.length,
      actualFiles.length + ' < ' + syncFiles.length);
    var extraFiles = actualFiles.filter(function (f) { return syncFiles.indexOf(f) < 0; });
    check('assets/web 的文件集与白名单一致（开发素材不许进包）',
      extraFiles.length === 0, '多出：' + extraFiles.join('、'));
  }

  /* ===============================================================
     C 批（v1.9.28）：数据可靠性
     ---------------------------------------------------------------
     这一批全是「跑上三个月才会发现」的隐性问题：写盘失败却说「已保存」、
     调小节数把时间表砍掉不吭声、一门的课的数组里混进 null 就多出一张空课表……
     所以断言尽量**咬行为**（真的调一次 save / syncTimesLength / parse），
     咬源码的那几条也一律先切出函数体再断言，配「切出来了」哨兵。
     =============================================================== */

  /* 按大括号配对切出函数体。匿名监听器也能切（给搜索前缀即可）。
     ⚠️ 它不认字符串/注释里的大括号，所以只用来切**没有花括号字面量**的函数。 */
  /* ⚠️ 写成**函数声明**而不是 `const sliceFn = function …`：
     函数声明会被提升到整个函数体顶部，所以 [21] 那一段（行号更靠前）也能用；
     写成 const 的话前面用它就是 TDZ 报错（第一次就这么踩的）。
     返回 null 表示没切到，**调用方必须自己防空**。 */
  function sliceFn(src, sig) {
    const i = src.indexOf(sig);
    if (i < 0) return null;
    let depth = 0, started = false;
    for (let k = i; k < src.length; k++) {
      if (src[k] === '{') { depth++; started = true; }
      else if (src[k] === '}') { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
    }
    return null;
  }

  console.log('\n[C-1] 写盘失败必须说出来');
  {
    let errHits = 0;
    Store.onSaveError(function () { errHits++; });

    const rawSetItem = global.localStorage.setItem;
    global.localStorage.setItem = function () { throw new Error('QuotaExceededError'); };
    let saveRet = null;
    try { saveRet = Store.save(); } catch (e) { saveRet = 'threw'; }
    global.localStorage.setItem = rawSetItem;

    check('写盘失败时 save() 返回 false（不是 undefined，也不抛）', saveRet === false, String(saveRet));
    check('写盘失败会响一次失败钩子（页面据此弹「保存失败」）', errHits === 1, errHits + ' 次');
    check('lastSaveOk() 跟着变 false（写盘发生在 Store 内部的路径靠它判断）',
      Store.lastSaveOk() === false, String(Store.lastSaveOk()));

    Store.save();   // 恢复正常写盘，别把后面的用例带进「失败态」
    check('恢复正常写盘后 lastSaveOk() 回到 true', Store.lastSaveOk() === true, String(Store.lastSaveOk()));

    const saveBody = sliceFn(storejs, 'function save() {');
    check('切出了 save() 函数体（否则下面几条是空断言）',
      !!saveBody && saveBody.length > 300, saveBody ? String(saveBody.length) : 'null');
    check('save() 有显式的写盘结果变量并把它返回出去',
      !!saveBody && /var ok = true/.test(saveBody) && /return ok;/.test(saveBody));
    check('save() 的 catch 不再是一句「忽略」就算完（要留下失败痕迹）',
      !!saveBody && !/catch \(e\) \{ \/\* 隐私模式等场景下忽略 \*\/ \}/.test(saveBody) &&
      /ok = false/.test(saveBody));
    check('onSaveError 与 onSave 是两套监听（「内存变了」不能被当成「落盘成功」）',
      /var saveErrorListeners = \[\]/.test(storejs) &&
      /function fireSaveError\(\)/.test(storejs) &&
      !/savedListeners\.push\(fn\)[\s\S]{0,80}saveErrorListeners\.push/.test(storejs));

    const notifyBody = sliceFn(appjs, 'function notifySaveError() {');
    check('切出了 notifySaveError 函数体（哨兵）',
      !!notifyBody && notifyBody.length > 100, notifyBody ? String(notifyBody.length) : 'null');
    check('页面把失败提示挂在 Store.onSaveError 上',
      /Store\.onSaveError\(notifySaveError\)/.test(appjs));
    check('失败提示说的是「没写进去」，不是含糊的一句「保存失败」',
      /SAVE_FAIL_MSG = '[^']*没有写入/.test(appjs) && /toast\(SAVE_FAIL_MSG\)/.test(notifyBody || ''));
    check('失败提示有节流（连续写盘失败不至于刷屏）',
      !!notifyBody && /lastSaveErrAt/.test(notifyBody) && /4000/.test(notifyBody));

    /* 同一个坑的第二处：学校地址簿有自己的存储，写盘失败同样不能说「已保存 / 已删除」 */
    const schoolsjs = fs.readFileSync(path.join(root, 'web', 'js', 'schools.js'), 'utf8');
    check('地址簿写盘失败也留痕（write() 有失败分支、结果拿得到）',
      /_lastWriteOk = false/.test(schoolsjs) && /function lastWriteOk\(\)/.test(schoolsjs) &&
      /return _lastWriteOk;/.test(schoolsjs));
    check('地址簿的「已删除 / 已保存」跟着写盘结果走，不假报成功',
      /SCH\.lastWriteOk\(\) \? '已删除' : SAVE_FAIL_MSG/.test(appjs) &&
      /SCH\.lastWriteOk\(\)\s*\n?\s*\? '已保存/.test(appjs));

    /* 「已保存」这三个字是要负责任的话：写盘失败时一个都不许弹。
       做法是每一处成功文案都过一道守卫（savedOk / lastSaveOk）。 */
    const successMsgs = ['设置已保存', '时间表已保存', '已添加课程', '已保存修改',
      '已删除', '已清空当前课表', '已切换到「', '已新建课表', '已导入 '];
    function guardedCount(src, msg) {
      const forms = ["if (savedOk) toast('" + msg, "if (savedOk2) toast('" + msg,
        "if (Store.lastSaveOk()) toast('" + msg];
      return forms.reduce(function (n, f) { return n + (src.split(f).length - 1); }, 0);
    }
    function bareCount(src, msg) {
      return (src.split("toast('" + msg).length - 1) - guardedCount(src, msg);
    }
    const unguarded = successMsgs.filter(function (m) { return bareCount(appjs, m) > 0; });
    check('写盘失败时不再有裸弹的「已保存」这类成功文案（成功提示都过了守卫）',
      unguarded.length === 0, unguarded.join('、'));
    check('守卫是真的用上了，不是把成功文案整段删掉（抽样两处）',
      guardedCount(appjs, '设置已保存') === 1 && guardedCount(appjs, '已添加课程') === 1 &&
      bareCount(appjs, '设置已保存') === 0);
  }

  console.log('\n[C-2] 调小每天节数不许静默截断时间表');
  {
    const sch = Store.current();
    const keepSec = sch.settings.sections;
    const keepTimesRef = sch.settings.times;
    const have = (sch.settings.times || []).length;
    check('前提：当前时间表至少 5 条（不然下面量不出「砍掉了几条」）', have >= 5, String(have));

    const target = Math.max(1, have - 4);
    sch.settings.sections = target;
    const r = Store.syncTimesLength();
    check('syncTimesLength() 把「砍掉了多少条」回传出来（不是默默截断）',
      !!r && r.truncated === have - target && r.had === have && r.need === target,
      JSON.stringify(r));
    check('截断本身仍然生效（时间表长度跟着每天节数走）',
      sch.settings.times.length === target, String(sch.settings.times.length));

    sch.settings.sections = keepSec;
    sch.settings.times = keepTimesRef;

    const ssBody = sliceFn(appjs, 'function saveSettings() {');
    const csBody = sliceFn(appjs, 'function commitSettings(');
    check('切出了 saveSettings / commitSettings 两个函数体（哨兵）',
      !!ssBody && ssBody.length > 200 && !!csBody && csBody.length > 100,
      (ssBody ? ssBody.length : 'null') + ' / ' + (csBody ? csBody.length : 'null'));
    check('调小每天节数之前要先问一句（saveSettings 里出现 openConfirm）',
      !!ssBody && /openConfirm\(\{/.test(ssBody));
    check('确认框里写清了「会丢什么」与「不可撤销」',
      !!ssBody && /条时间设置/.test(ssBody) && /不可撤销/.test(ssBody));
    check('点「取消」时设置原样不动 —— sections 的赋值只发生在 commitSettings 里',
      !!ssBody && !!csBody &&
      !/S\.settings\.sections\s*=/.test(ssBody) &&
      /S\.settings\.sections\s*=\s*wantSec/.test(csBody));
    check('「要不要问」只在真的变小时才拦（调大 / 不变不该弹确认框）',
      !!ssBody && /wantSec\s*<\s*S\.settings\.sections/.test(ssBody));
  }

  console.log('\n[C-3] CSV 未闭合引号要指名报错');
  {
    const badCsv = '课程名称,星期,开始节数,结束节数,老师,地点,周数\n' +
      '"高等数学A,一,1,2,李明,明理(5)-401,1-16周\n';
    const badRes = CsvUtil.parse(badCsv, settings);
    check('未闭合引号会被指名报出来（不是含糊的「0 门课程」）',
      badRes.errors.some(function (e) { return /引号/.test(e) && /未闭合/.test(e); }),
      badRes.errors.join(' | '));
    check('这条错误排在最前面 —— 它是「为什么一门课都没解析出来」的答案',
      /引号/.test(badRes.errors[0] || ''), badRes.errors[0] || '(无)');
    check('报错带行号（用户才知道去改哪一行）',
      badRes.errors.some(function (e) { return /第\s*2\s*行/.test(e); }),
      badRes.errors.join(' | '));

    const goodRes = CsvUtil.parse(csvText, settings);
    check('正常课表不会被误报（示例课表解析零错误）', goodRes.errors.length === 0,
      goodRes.errors.join(' | '));
    check('正常课表仍然解析出课程（报错逻辑没有顺手把好文件也挡掉）',
      goodRes.courses.length > 0, goodRes.courses.length + ' 门');

    const csvjs = fs.readFileSync(path.join(root, 'web', 'js', 'csv.js'), 'utf8');
    check('未闭合的状态是从解析函数**返回**出来的（不是只 console 一下）',
      /parseCsvTextEx/.test(csvjs) && /error: error/.test(csvjs) && /if \(inQuotes\)/.test(csvjs));
    check('旧的 parseCsvText(text) 签名没被破坏（仍返回二维数组）',
      /function parseCsvText\(text\) \{\s*\n\s*return parseCsvTextEx\(text\)\.rows;/.test(csvjs));
  }

  console.log('\n[C-4] 课表数组里的脏数据不许变成空课表');
  {
    const keepList = Store.state.schedules.slice();
    const keepActive = Store.state.activeId;

    const v2 = JSON.stringify({
      version: 2, activeId: 'a',
      schedules: [null, { id: 'a', name: '我的课表', courses: [], settings: {} }]
    });
    const rawGet = global.localStorage.getItem;
    global.localStorage.getItem = function (k) { return k === Store.KEY ? v2 : null; };
    let loadErr = null;
    try { Store.load(); } catch (e) { loadErr = String(e && e.message); }
    global.localStorage.getItem = rawGet;
    const got = Store.list().length;

    Store.state.schedules = keepList;
    Store.state.activeId = keepActive;

    check('数组里混进一个 null 不会凭空多出一张空课表', !loadErr && got === 1,
      loadErr || got + ' 份');
    check('读盘时先滤掉非对象（而不是让 normalizeSchedule 兜底造一个）',
      /filter\(function \(x\) \{\s*\n\s*return x && typeof x === 'object';/.test(storejs));
  }

  console.log('\n[C-5] 添加课程的节次越界要报错');
  {
    const addBody = sliceFn(appjs, "$('btnAddSave').addEventListener('click', function ()");
    check('切出了「保存课程」那份处理器（否则下面两条是空断言）',
      !!addBody && addBody.length > 400, addBody ? String(addBody.length) : 'null');
    check('越界时明确报错，并说清当前每天几节、去哪里改',
      !!addBody && /S\.settings\.sections/.test(addBody) && /节次要在/.test(addBody) &&
      /设置/.test(addBody));
    check('不做静默夹取（夹取是替用户改输入，存下去他反而以为保存失败）',
      !!addBody && !/Math\.(min|max)\([^)]*S\.settings\.sections/.test(addBody) &&
      !/st = Math\./.test(addBody));
  }

  console.log('\n[C-6] 小组件推送要节流、要认内容');
  {
    const pwBody = sliceFn(appjs, 'function pushWidget() {');
    const pwnBody = sliceFn(appjs, 'function pushWidgetNow() {');
    check('切出了 pushWidget / pushWidgetNow 两个函数体（哨兵）',
      !!pwBody && pwBody.length > 80 && !!pwnBody && pwnBody.length > 300,
      (pwBody ? pwBody.length : 'null') + ' / ' + (pwnBody ? pwnBody.length : 'null'));
    check('挂在写盘钩子上的 pushWidget 是防抖的（连续写盘只推最后一次）',
      !!pwBody && /clearTimeout\(widgetTimer\)/.test(pwBody) && /setTimeout/.test(pwBody) &&
      /Store\.onSave\(pushWidget\)/.test(appjs));
    check('防抖延迟落在 100~1000ms（太短等于没防，太长桌面看着像卡住）',
      !!pwBody && (function () {
        const m = /setTimeout\(function[\s\S]*?\},\s*(\d+)\)/.exec(pwBody);
        const n = m ? Number(m[1]) : NaN;
        return n >= 100 && n <= 1000;
      })(), (pwBody && /setTimeout\(function[\s\S]*?\},\s*(\d+)\)/.exec(pwBody)) || '(没找到延迟)');
    check('内容指纹里不含 pushedAt（那是时间戳，拿它比等于没比）',
      !!pwnBody && !/pushedAt/.test(pwnBody) && /widgetLastKey/.test(pwnBody));

    /* 真的驱动一遍：桥是假的，量的是「调了几次 sync」 */
    const pushes = [];
    const prevBridge = global.AndroidWidget;
    global.AndroidWidget = { sync: function (j) { pushes.push(j); } };
    global.ScheduleApp.pushWidgetNow();
    const firstCount = pushes.length;
    global.ScheduleApp.pushWidgetNow();
    global.ScheduleApp.pushWidgetNow();
    check('内容没变就不重复推（改主题这类写盘不该跨进程）',
      firstCount === 1 && pushes.length === 1, firstCount + ' / ' + pushes.length);

    const probe = Store.current();
    const keepName = probe.name;
    probe.name = keepName + '·C6探针';
    global.ScheduleApp.pushWidgetNow();
    const changedCount = pushes.length;
    probe.name = keepName;
    global.ScheduleApp.pushWidgetNow();
    global.AndroidWidget = prevBridge;

    check('内容真的变了就一定要推（不能把真改动也省掉）', changedCount === 2, changedCount + ' 次');
    check('推出去的确实是完整快照（56 天 + 版本号）', (function () {
      let d = null;
      try { d = JSON.parse(pushes[0] || 'null'); } catch (e) { d = null; }
      return !!d && d.v === 1 && Object.keys(d.days || {}).length === 56;
    })(), String(pushes[0]).slice(0, 60));
  }

  console.log('\n[C-7] 顺手项：口径统一 / 注释脱敏 / 本地隐私词表');
  {
    /* 整个 web/ 递归列出来扫 —— **不用白名单**。
       白名单会漏掉「往里丢了个没写进名单的文件」这条通道，而 web/ 是**出厂内容目录**：
       里面任何文件都会被 sync-assets.js 原样镜像进 assets/ 并打进 APK（v1.9.27 的教训）。
       顺便，二进制也照样扫（三编码），所以「往 web/ 丢一份真实课表 .xls」也拦得住。 */
    const webAll = (function walk(dir, base) {
      let out = [];
      fs.readdirSync(dir).forEach(function (f) {
        const abs = path.join(dir, f);
        const rel = base ? base + '/' + f : f;
        if (fs.statSync(abs).isDirectory()) out = out.concat(walk(abs, rel));
        else out.push(rel);
      });
      return out;
    })(path.join(root, 'web'), '');

    /* 真实姓名 / 楼栋这类词**不进仓库** —— 写在断言里，判据本身就成了泄露源
       （曾经就是这么干的：为了钉住「源码里不许出现真实姓名」，把六个真实姓名
       原样抄进了测试与报告，闭源上架时无所谓，一开源就全在公网上）。
       现在真正的词表放 tools/privacy-words.local.txt，已被 .gitignore 排除、
       只在本机生效；没配时这一组打印「跳过」，别人 clone 照样全绿。 */
    const pwPath = path.join(root, 'tools', 'privacy-words.local.txt');
    const pwWords = fs.existsSync(pwPath)
      ? fs.readFileSync(pwPath, 'utf8').split(/\r?\n/)
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s && s.charAt(0) !== '#'; })
      : [];

    /* 一个词要在三种编码下都比 —— .xls/.pdf 是 UTF-16 存字符串，
       只按 UTF-8 读二进制文件会「查不出」真实数据（假绿过）。 */
    const encodings = function (w) {
      const utf8 = Buffer.from(w, 'utf8');
      const le = Buffer.from(w, 'utf16le');
      const be = Buffer.from(le); be.swap16();
      return [utf8, le, be];
    };
    const hitsIn = function (buf, w) {
      return encodings(w).some(function (n) { return buf.indexOf(n) >= 0; });
    };

    if (!pwWords.length) {
      check('未配置本地隐私词表（tools/privacy-words.local.txt）——本组跳过', true,
        '跳过：别人 clone 后本来就该是这样');
    } else {
      const leaked = [];
      const scanRel = function (rel, sink) {
        const p = path.join(root, rel);
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return;
        const buf = fs.readFileSync(p);
        pwWords.forEach(function (w) { if (hitsIn(buf, w)) (sink || leaked).push(rel + ':' + w); });
      };
      webAll.forEach(function (f) { scanRel(path.join('web', f)); });
      /* 哨兵：递归没读到东西＝后面那条恒绿。曾经真的发生过「扫描范围为空也是绿」。 */
      check('递归扫到了 web/ 下的文件（哨兵：范围为空则下面那条会假绿）',
        webAll.length >= 17, webAll.length + ' 个文件');
      fs.readdirSync(path.join(root, 'tools', 'fixtures')).forEach(function (f) {
        scanRel(path.join('tools', 'fixtures', f));
      });
      check('web/ 出厂内容（递归 ' + webAll.length + ' 个文件）里不再出现隐私词表里的词（注释也算，它同样随 APK 出厂）',
        leaked.length === 0, leaked.join('、'));

      /* 反向自查：**判据本身**不许成为泄露源。
         脱敏时真踩过这一跤 —— 为了断言「源码里不许出现真实姓名」，把六个真实
         姓名原样抄进了测试脚本与体检报告；闭源上架时无所谓，一开源就全在公网上。
         所以工具脚本与根目录文档也要扫一遍自己。
         ⚠️ 范围**枚举目录、不写名单**：手写名单一定会漏 —— 本轮新增的两个脚本
         就没被列进去，于是 `test-adapter-import.js` 里一个**真实楼栋名**安安静静
         过了关（判据在、名单漏）。枚举目录则「新增文件自动纳入」。 */
      const toolFiles = fs.readdirSync(path.join(root, 'tools'), { withFileTypes: true })
        .filter(function (d) { return d.isFile(); })
        .map(function (d) { return d.name; })
        .filter(function (f) { return f !== 'privacy-words.local.txt'; });   // 词表里当然有词
      /* v1.9.42：`tools/adapter-local/`（自研适配脚本源码）已删，这一段的
         枚举不用再兜它 —— 目录枚举本身就是「新增文件自动纳入」，
         那个子目录不在了自然也就没什么可漏的。 */
      const rootDocs = fs.readdirSync(root, { withFileTypes: true })
        .filter(function (d) { return d.isFile() && (/\.md$/i.test(d.name) || d.name === 'LICENSE'); })
        .map(function (d) { return d.name; });
      check('哨兵：tools 目录枚举到了脚本、根目录枚举到了文档（为空则下面那条会假绿）',
        toolFiles.length >= 15 && rootDocs.length >= 3,
        toolFiles.length + ' 个脚本 / ' + rootDocs.length + ' 份文档');

      const toolLeaks = [];
      toolFiles.forEach(function (f) { scanRel(path.join('tools', f), toolLeaks); });
      rootDocs.forEach(function (f) { scanRel(f, toolLeaks); });
      check('测试脚本与根目录文档自己也不出现词表里的词（判据不许变成泄露源）',
        toolLeaks.length === 0, toolLeaks.slice(0, 8).join('、'));

      const stillInReadme = pwWords.filter(function (w) { return hitsIn(fs.readFileSync(path.join(root, 'README.md')), w); });
      check('README 里也不出现（仓库一开源它就在公网上）',
        stillInReadme.length === 0, stillInReadme.join('、'));

      /* 第三类泄露源：**本机账号名**。它不属于「学校信息」，上面那张词表管不着，
         但路径写成 `C:\Users\<名>\…` 就等于把维护者的本机账号名随仓库公开了。
         判据**不把名字写进断言**（那就是又一次「判据变成泄露源」）——
         用本机环境变量 `USERNAME` / `USER` 当场取，机器换了判据也跟着换。 */
      const localUser = process.env.USERNAME || process.env.USER || '';
      const userScan = [];
      webAll.forEach(function (f) {                       // 二进制（png）读成 utf8 只会乱码，匹配不上，无害
        userScan.push({ rel: 'web/' + f, text: fs.readFileSync(path.join(root, 'web', f), 'utf8') });
      });
      /* 范围同样**枚举目录**（名单会漏掉新增的文件，这条纪律上面刚说过一次）。 */
      toolFiles.concat(['privacy-words.local.txt', 'privacy-words.example.txt'])
        .forEach(function (f) {
          const p = path.join(root, 'tools', f);
          if (fs.existsSync(p)) userScan.push({ rel: 'tools/' + f, text: fs.readFileSync(p, 'utf8') });
        });
      rootDocs.concat(['.gitignore']).forEach(function (f) {
        userScan.push({ rel: f, text: fs.readFileSync(path.join(root, f), 'utf8') });
      });
      check('本机账号名扫描覆盖到位（哨兵：文件集为空则下面那条会假绿）',
        userScan.length >= 20, userScan.length + ' 个文件');
      let userHits = [];
      if (localUser.length >= 3) {
        const ure = new RegExp(localUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        userHits = userScan.filter(function (x) { return ure.test(x.text); })
          .map(function (x) { return x.rel; });
      }
      check('源码与文档里不出现本机账号名（从环境变量当场取，不把名字写进断言）',
        userHits.length === 0,
        userHits.join('、') || (localUser.length >= 3 ? '' : '本机取不到 USERNAME → 这一条只验证了扫描范围'));
    }

    const gitignoreD = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    check('隐私词表本身不进版本库（.gitignore 里有它，且示例文件是允许留下的那份）',
      /^tools\/privacy-words\.local\.txt$/m.test(gitignoreD) &&
      fs.existsSync(path.join(root, 'tools', 'privacy-words.example.txt')));
    check('脱敏是换成虚构样例，不是把示例整段删掉（注释还有内容）',
      /明理（5）-401/.test(fs.readFileSync(path.join(root, 'web', 'js', 'edugrab.js'), 'utf8')));

    check('星期比较口径统一：课表页也按数字比，与 store.js 的 dayCourses 一致',
      (appjs.match(/\+\s*c\.day\s*===/g) || []).length >= 2 &&
      !/[^+]c\.day\s*===\s*(day|d)\b/.test(appjs),
      '带加号 ' + (appjs.match(/\+\s*c\.day\s*===/g) || []).length + ' 处');
    check('store.js 那侧仍是 +c.day（两边同一口径）', /\+\s*c\.day\s*!==\s*day/.test(storejs));
  }

  /* ---------------------------------------------------------------
     [B] 安全面（v1.9.29）：桥门闩令牌化之外的五条原生改动

     B-1（门闩令牌化）的断言在 [20] 那一段里（与桥的其他断言放一起）。
     这里收 B-2~B-7 —— 它们全都落在**原生侧 / 清单 / 资源 XML**，无头浏览器够不着，
     所以判据是「源码的形状」+「两处必须一致的东西互相比对」。
     --------------------------------------------------------------- */
  console.log('\n[B] 安全面：Cookie / 导航 / 开关 / 文件名 / 备份');
  {
    /* —— B-2 关掉第三方 Cookie ——
       「能加载任意网址」+「允许明文与混合内容」+「收第三方 Cookie」三者叠在一起
       才是风险；第三方 Cookie 本功能用不到（正方在子域间跳是同站，走 first-party）。 */
    check('内嵌教务浏览器只接受**同站 Cookie**（第三方 Cookie 关掉，且不留 true 的老写法）',
      /setAcceptThirdPartyCookies\(webView, false\)/.test(eduKtNoComment) &&
      !/setAcceptThirdPartyCookies\(webView, true\)/.test(eduKtNoComment) &&
      /setAcceptCookie\(true\)/.test(eduKtNoComment));

    /* —— B-3 FileProvider 白名单收窄到 cacheDir/share/ —— */
    const filePathsB = fs.readFileSync(path.join(
      root, 'android', 'app', 'src', 'main', 'res', 'xml', 'file_paths.xml'), 'utf8');
    /* 断言结构的部分先**剥掉 XML 注释** —— 新注释里为了说明「改了什么」会引用
       旧的 `path="."`，不剥的话那句负向断言会被注释自己绊红（写这一组时真踩到）。 */
    const fpBNoComment = filePathsB.replace(/<!--[\s\S]*?-->/g, '');
    check('FileProvider 的 cache 白名单收窄到 share/ 子目录（原先 path="." 等于整个 cacheDir）',
      /<cache-path\s+name="share"\s+path="share\/"\s*\/>/.test(fpBNoComment) &&
      !/name="cache"/.test(fpBNoComment) &&
      !/path="\."/.test(fpBNoComment));
    /* v1.9.43：dumps 那一条（存教务页面的排查出口）随自研抓页一起删了。
       这条判据从「有 dumps」翻成「**没有** dumps」—— 白名单里留一条
       没人写、也没人读的目录，下一轮复核时会以为「还有一条导出页面的路」。 */
    check('dumps 那条白名单已删（存的页面没人再写，留着等于虚报能力）',
      !/external-files-path/.test(fpBNoComment) && !/dumps/.test(fpBNoComment));
    check('注释也跟着改了（还宣称整个缓存目录都在白名单里的那句必须消失）',
      /收窄/.test(filePathsB) && !/整个 cache 都在白名单内/.test(filePathsB));

    /* —— B-4 主 WebView 补导航拦截 ——
       主页面是 file://，正常不发生导航；但一旦发生，这个 WebView 上挂着一排原生桥，
       不能没有拦截点。只有 shouldOverrideUrlLoading 一处，切开函数体再断言。 */
    const sovFn =
      (/override fun shouldOverrideUrlLoading\([\s\S]*?\n            \}/.exec(ktNoComment) || [])[0] || '';
    check('切出了主 WebView 的 shouldOverrideUrlLoading 函数体（哨兵：切不出来下面那条会假绿）',
      sovFn.length > 80, sovFn.length);
    check('只放行本地 assets 页面，其余导航一律吃掉（拿不到 URL 时也吃掉，不是放行）',
      /request\?\.url\?\.toString\(\) \?: return true/.test(sovFn) &&
      /return !u\.startsWith\(ASSET_PREFIX\)/.test(sovFn));
    check('前缀只有一处定义：ASSET_URL 由 ASSET_PREFIX 拼出（两处写死迟早漂）',
      /const val ASSET_PREFIX = "file:\/\/\/android_asset\/"/.test(ktNoComment) &&
      /const val ASSET_URL = ASSET_PREFIX \+ "web\/index\.html"/.test(ktNoComment));

    /* —— B-5 主 WebView 的「file:// 跨源访问」两条关掉 ——
       前提是页面里**一处网络请求都没有**；这条前提本身就写成断言，
       将来谁往页面里加了 fetch，这里会红，提醒他重新评估这两个开关。 */
    const webJsDir = path.join(root, 'web', 'js');
    /* v1.9.32 起 `warehouse.js` **有**网络请求代码，但那是「电脑浏览器里跑单测 /
       开调试页」时的兜底通道，App 里 `hasNative()`（原生桥在）为真 ⇒ 走
       `AndroidWarehouse.getBinary`，fetch 一行都不会执行。所以这条断言从
       「一处都没有」改成「只有白名单里的文件可以有，且它必须被 hasNative() 门住」。
       白名单是**点名**的：多出第三个文件就红，逼后来人重新评估这两个跨源开关。 */
    /* v1.9.42：白名单**收回到一个文件**。v1.9.41 时 `adapter-local.js`（自研脚本
       的正文，作为数据）也在名单里；那个文件随自研脚本一起删了，于是页面里
       含网络 API 的文件只剩 `warehouse.js` —— 有第三个就红，逼后来人重新评估
       这两个跨源开关。 */
    const NET_OK = ['warehouse.js'];
    const netUsers = fs.readdirSync(webJsDir).filter(function (f) {
      const s = fs.readFileSync(path.join(webJsDir, f), 'utf8');
      return /\bfetch\s*\(|new\s+XMLHttpRequest|new\s+WebSocket|new\s+EventSource|new\s+Worker/.test(s);
    });
    check('页面里含网络请求 API 的文件只有 warehouse.js 一个（其余一律不许有）',
      netUsers.length === NET_OK.length && netUsers.every(function (f) { return NET_OK.indexOf(f) >= 0; }),
      netUsers.join('、') || '（一个都没有）');
    const whSrc = fs.readFileSync(path.join(webJsDir, 'warehouse.js'), 'utf8');
    check('白名单那个文件的 fetch **只在原生桥缺席时**才走（App 里一律走 AndroidWarehouse）',
      /function fetchBinary\(url\) \{/.test(whSrc) &&
      /if \(hasNative\(\)\) \{/.test(whSrc) &&
      /global\.AndroidWarehouse\.getBinary\(url, id\)/.test(whSrc) &&
      /global\.fetch\(url, \{ cache: 'no-store' \}\)/.test(whSrc) &&
      /* 顺序即语义：原生那支写在前面并 return，fetch 只可能在 hasNative() 为假时才够到 */
      whSrc.indexOf('if (hasNative())') < whSrc.indexOf('global.fetch('));
    check('两条 file:// 跨源开关都关掉（复检报告里一直挂着的 allowUniversalAccessFromFileURLs）',
      /allowFileAccessFromFileURLs = false/.test(ktNoComment) &&
      /allowUniversalAccessFromFileURLs = false/.test(ktNoComment));
    check('allowFileAccess 仍为 true（否则本地页面本身就加载不出来）',
      /allowFileAccess = true/.test(ktNoComment));
    check('allowContentAccess **刻意保持 true** 并写明理由（选文件回来的 content:// 读取依赖它）',
      /allowContentAccess = true/.test(ktNoComment) &&
      /content:\/\//.test(kt) && /allowContentAccess/.test(kt));

    /* —— B-6 导出文件名在原生侧也清洗 —— */
    check('抽出了共用的 safeFileName（原来只有 writeShareCache 洗了、saveFile 没洗）',
      /private fun safeFileName\(name: String\?, fallback: String\): String/.test(ktNoComment));
    check('两条落盘出口都改用它（同一个 `val safe = safeFileName(name, "课表.csv")` 出现两处）',
      (ktNoComment.match(/val safe = safeFileName\(name, "课表\.csv"\)/g) || []).length === 2,
      '出现 × ' + (ktNoComment.match(/val safe = safeFileName\(/g) || []).length);
    check('saveFile 不再拿原始 name 直接落盘（两条分支都传清洗过的 safe）',
      /saveToDownloads\(safe, type, text\)/.test(ktNoComment) &&
      /saveToAppDir\(safe, text\)/.test(ktNoComment));

    /* —— B-7 备份口径：保「换机不丢」+ 排掉教务浏览器痕迹 —— */
    const manifestB = fs.readFileSync(path.join(
      root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
    const backupB = fs.readFileSync(path.join(
      root, 'android', 'app', 'src', 'main', 'res', 'xml', 'backup_rules.xml'), 'utf8');
    const extractionB = fs.readFileSync(path.join(
      root, 'android', 'app', 'src', 'main', 'res', 'xml', 'data_extraction_rules.xml'), 'utf8');
    check('备份口径 = 保「换机不丢」：<application> 上仍写着 allowBackup="true"',
      // 锚到 `<application …>` 上 —— 注释里也有一处 `android:allowBackup="true"`
      // 用来解释这个取舍，不锚标签的话改掉属性、留着注释照样绿（验红时会跑出「0 条变红」）。
      /<application\b[^>]*\sandroid:allowBackup="true"/.test(manifestB));
    check('并写明云备份会带走课表（「保存在本机」的准确口径）',
      /云备份/.test(manifestB) && /allowBackup/.test(manifestB));
    check('排掉教务浏览器痕迹（last_url / ssl_trusted_hosts）：两条规则文件都 exclude',
      /<exclude\s+domain="sharedpref"\s+path="edu_browser\.xml"\s*\/>/.test(backupB) &&
      (extractionB.match(/<exclude\s+domain="sharedpref"\s+path="edu_browser\.xml"\s*\/>/g) || []).length === 2,
      'data_extraction_rules 里 × ' + (extractionB.match(/edu_browser\.xml/g) || []).length);
    check('云备份与换机迁移是两套规则，两边都要各自排一遍（只写一边另一边照样带走）',
      (extractionB.match(/<cloud-backup>[\s\S]*?<\/cloud-backup>/g) || []).length === 1 &&
      (extractionB.match(/<device-transfer>[\s\S]*?<\/device-transfer>/g) || []).length === 1);
  }

  /* ---------------------------------------------------------------
     [D] 发布合规（v1.9.30）：换正式包名 + 研究产物搬出项目根

     换包名「漏一处」不会报错，只会出一串难查的症状：
       · 只改声明没搬目录 → Kotlin 报含糊的 unresolved reference（这还算好的）；
       · 某个地方还留着旧包名字符串（文档 / 核验脚本 / FileProvider authority）
         → **一路静默**，直到装到手机上才发现「分享失败」「组件点不动」。
     所以这条的判据是「换得干净」：正向钉住新包名，反向钉住旧包名 0 残留。
     --------------------------------------------------------------- */
  console.log('\n[D] 发布合规：正式包名 / 研究产物不在项目里');
  {
    const gradle = fs.readFileSync(path.join(root, 'android', 'app', 'build.gradle'), 'utf8');
    // 剥掉 // 注释：注释里会成段写「由占位包名 com.example.schedule 改来」，
    // 那正是改动的记录，不该被下面那条反向断言绊红。
    const gradleNoComment = gradle.replace(/^\s*\/\/.*$/gm, '');
    const gNamespace = (/namespace\s+'([^']*)'/.exec(gradleNoComment) || [])[1];
    const gAppId = (/applicationId\s+"([^"]*)"/.exec(gradleNoComment) || [])[1];

    check('namespace 与 applicationId 都是正式包名，且两者一致（写岔了能编过、但会装出两个应用）',
      gNamespace === 'cn.youke.schedule' && gAppId === 'cn.youke.schedule',
      'namespace=' + gNamespace + ' applicationId=' + gAppId);
    check('build.gradle 里旧占位包名 0 残留（剥注释后判）',
      !/com\.example/.test(gradleNoComment));

    /* 目录与声明必须一致 —— 这是改包名最经典的错法：改了 package 声明没搬目录，
       或搬了目录没改声明。两种都编不过，但报错信息指向别处，最费时间。 */
    const ktFiles = fs.existsSync(KT_DIR)
      ? fs.readdirSync(KT_DIR).filter(function (f) { return /\.kt$/.test(f); }).sort()
      : [];
    const badPkg = ktFiles.filter(function (f) {
      const head = fs.readFileSync(path.join(KT_DIR, f), 'utf8').split('\n')[0].trim();
      return head !== 'package cn.youke.schedule';
    });
    check('切出了新包目录下的源文件（哨兵：切不出来下面两条会假绿）',
      ktFiles.length === 6, '找到 ' + ktFiles.length + ' 个 .kt');
    check('每个源文件首行 package 声明都与所在目录一致（' + ktFiles.length + ' 个）',
      badPkg.length === 0, badPkg.join('、'));
    check('旧的 java/com/example 目录已彻底移除（留个空目录也会被 aapt 收进去）',
      !fs.existsSync(path.join(root, 'android', 'app', 'src', 'main', 'java', 'com')));

    /* 全源码树扫一遍旧包名字符串。清单 / res XML / 各 .kt 一起查 ——
       只查 kotlin 会漏掉「清单里写成绝对类名」这种漏改。 */
    const offenders = [];
    (function walk(dir) {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'build') walk(full); return; }
        if (!/\.(kt|xml|gradle|pro)$/.test(e.name)) return;
        if (/com\.example/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(root, full));
      });
    })(path.join(root, 'android', 'app', 'src'));
    check('android/ 源码树里旧包名字符串 0 残留（清单、res XML、.kt 一起查）',
      offenders.length === 0, offenders.join('、'));

    const manifestD = fs.readFileSync(path.join(
      root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
    const manifestDNoComment = manifestD.replace(/<!--[\s\S]*?-->/g, '');
    check('清单里五个组件仍用相对类名（.XxxActivity / .WidgetXxxProvider —— 绝对写法漏改不留痕）',
      ['\\.MainActivity', '\\.EduLoginActivity', '\\.WidgetTodayProvider',
        '\\.WidgetTwoDayProvider', '\\.WidgetListService'].every(function (re) {
        return new RegExp('android:name="' + re + '"').test(manifestDNoComment);
      }));
    check('FileProvider 的 authority 仍由 ${applicationId} 推出（不写死包名 ⇒ 跟着包名走，改包名不用再动它）',
      /android:authorities="\$\{applicationId\}\.fileprovider"/.test(manifestDNoComment));

    /* —— D-1 研究产物必须在项目根之外 ——
       这就是合规清单里「打包前必删」那条命令的固化版：每次跑冒烟都顺手复核一遍，
       不用指望出包的人记得手动执行。 */
    const stray = fs.readdirSync(root).filter(function (f) {
      return /^_analysis/.test(f);
    });
    check('项目根没有研究产物（`_analysis*` 已移出到项目根之外）',
      stray.length === 0, stray.join('、'));
    const gitignoreD = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    check('.gitignore 里临时产物规则保留作双保险（*.har / captures/）',
      /^\*\.har$/m.test(gitignoreD) && /^captures\/$/m.test(gitignoreD));

    /* 合规清单是**维护者本机笔记**，已被 .gitignore 排除、不随仓库公开
       —— 别人 clone 下来这个文件根本不存在。所以必须先探存在再读：
       少了这一步，整条冒烟会在这一行抛 ENOENT **直接崩掉**
       （不是「红一条」，是**后面所有断言全部不执行**，退出码 1 而
       报错信息长得像脚本自己坏了）。范式同上面隐私词表那一段：
       取不到就打印「跳过」，别人 clone 照样全绿。
       ⚠️ 验红方式：在 clone 快照里跑，必须**跑到底**并且全绿；
       在本机（文件在）跑，这 4 条必须照常执行 —— 两边都要过。 */
    const compliancePath = path.join(root, '发布前合规自查清单.md');
    const compliance = fs.existsSync(compliancePath)
      ? fs.readFileSync(compliancePath, 'utf8') : null;
    if (compliance === null) {
      check('本地维护者笔记《发布前合规自查清单.md》不随仓库公开 —— 本节跳过', true,
        '跳过：别人 clone 后本来就该是这样');
    } else {
      check('合规清单把「打包前必删」摆成第 0 项、且排在所有章节之前（摆在最后等于没人看）',
        /第 0 项/.test(compliance) &&
        compliance.indexOf('第 0 项') < compliance.indexOf('## 0. 先纠正一个前提'));
      check('合规清单里的包名已更新为正式包名（不再留「当前是占位包名」的未完成口径）',
        /cn\.youke\.schedule/.test(compliance) && !/当前是占位包名/.test(compliance));
      /* D-3 查出来的那件事必须一直躺在清单里。它不是「已解决」，是**当前全部
         对外行为都建立在它之上**的一个约束（不上架）。记录一旦被删，
         约束也就跟着静默消失 —— 而没有任何东西会报错。

         ⚠️ 必须**先切出 §2.5 那一节**再断言。第一版写的是「这三个词在不在」，
         结果验红时跑出「红 0 条」—— 因为 §5 的结论段里同样提到了注册号与「不上架」，
         把 §2.5 整节删掉、这三条断言照样绿。又一次印证：
         **只查字符串在不在、不锚住它在哪，就是弱断言。** */
      const sec25 = (compliance.split('## 2.5 ')[1] || '').split('\n## 3. ')[0];
      check('切出了 §2.5 商标核查那一节（哨兵：切不出来下面那条会假绿）',
        sec25.length > 400, sec25.length + ' 字符');
      check('§2.5 记着「第 9 类已有『柚课』在先注册」及其处置（注册号 + 它盖住的商品 + 不上架）',
        /41501035/.test(sec25) &&
        /可下载的手机应用软件/.test(sec25) &&
        /不上架/.test(sec25));
    }

    /* —— 开源材料（v1.9.31 上传 GitHub 前补齐）—— */
    const licPath = path.join(root, 'LICENSE');
    const lic = fs.existsSync(licPath) ? fs.readFileSync(licPath, 'utf8') : '';
    check('有 LICENSE，且是完整 MIT 正文（免责声明整段都在，不是一句「MIT」了事）',
      /^MIT License/m.test(lic) &&
      /Permission is hereby granted, free of charge/.test(lic) &&
      /WITHOUT WARRANTY OF ANY KIND/.test(lic) &&
      /* 正文里这句是**折行**的（"IN NO EVENT SHALL THE\nAUTHORS OR …"），
         按整行匹配会假红 —— 用空白容错。 */
      /IN NO EVENT SHALL THE\s+AUTHORS OR COPYRIGHT HOLDERS BE LIABLE/.test(lic));
    check('LICENSE 的版权人是 GitHub ID 而不是真实姓名（要改署名就改这一行）',
      /Copyright \(c\) \d{4} YunYou1128/.test(lic));

    /* 项目根会「随手」多出东西：打出来的 APK、签名文件、网络存档（.har）。
       它们大多在 .gitignore 里，但物理存在就可能被某次 `git add -f` 或压缩包带出去，
       所以这里物理查一遍。 */
    const strayPublic = fs.readdirSync(root).filter(function (f) {
      return /\.(apk|aab|keystore|jks|har)$/i.test(f) || f === 'captures';
    });
    check('项目根没有不该公开的产物（APK / AAB / 签名文件 / .har / captures/）',
      strayPublic.length === 0, strayPublic.join('、'));

    /* —— 核验脚本必须跟得上版本 ——
       脚本里的 EXPECT_VERSION_* / EXPECT_PACKAGE 是**钉死**的（每版复制一份改名）。
       改版本号或包名时忘了同步脚本，它反而会拿旧值去核验、然后报「全部通过」。

       ⚠️ 文件名**按 build.gradle 的 versionName 推**（1.9.43 → verify-apk-1943.py），
       不再写死一个版本号：写死的话每次升版都要来改这一行，而漏改的表现是
       「核验脚本查的是上一版那份」—— 它照样全绿，只是核的不是这一版。
       推导出来再断言文件存在，漏建新脚本时这里直接红。 */
    const gVc = (/versionCode\s+(\d+)/.exec(gradleNoComment) || [])[1];
    const gVn = (/versionName\s+"([^"]*)"/.exec(gradleNoComment) || [])[1];
    const verifyPyName = 'verify-apk-' + String(gVn).replace(/\./g, '') + '.py';
    const verifyPyPath = path.join(root, 'tools', verifyPyName);
    check('本版核验脚本存在（名字按 versionName 推：' + verifyPyName + '）',
      fs.existsSync(verifyPyPath), verifyPyName);
    const verifyPy = fs.existsSync(verifyPyPath) ? fs.readFileSync(verifyPyPath, 'utf8') : '';
    check('核验脚本钉的版本号 = build.gradle 的（vc ' + gVc + ' / vn ' + gVn + '）',
      verifyPy.indexOf("EXPECT_VERSION_CODE = '" + gVc + "'") >= 0 &&
      verifyPy.indexOf("EXPECT_VERSION_NAME = '" + gVn + "'") >= 0);
    check('核验脚本钉的包名 = build.gradle 的 applicationId（' + gAppId + '）',
      verifyPy.indexOf("EXPECT_PACKAGE = '" + gAppId + "'") >= 0);

    /* 反向断言（「某个东西必须不存在」）是最容易永远绿的一类。
       v1.9.42 的核心交付是「随包脚本正文整条拆掉」、v1.9.43 是「自研抓页整条拆掉」，
       所以顺势钉住核验脚本里**确实带着**这几批判据 —— 有人手滑删掉它们，这里先红。 */
    check('核验脚本带着「随包脚本正文已拆」的反向断言（文件 + 桥参数两条）',
      verifyPy.indexOf('EXPECT_ADAPTER_INLINE_ABSENT') >= 0 &&
      verifyPy.indexOf('EXPECT_BRIDGE_ARG_COUNT') >= 0);
    check('核验脚本带着「自研抓页已拆」的反向断言（dex 名称 + 回传入口 + 底栏 id 三批）',
      verifyPy.indexOf('EXPECT_GRAB_PAGE_ABSENT') >= 0 &&
      verifyPy.indexOf('EXPECT_EDU_CALLBACKS_ABSENT') >= 0 &&
      verifyPy.indexOf('EXPECT_EDU_BOTTOM_IDS_ABSENT') >= 0);

    /* EXPECT_WEB_FILES 也是钉死的。web/ 里加了文件忘同步这个数字，核验脚本会拿
       旧数字去数包、报「文件数不对」——那时已经是出包之后了。这里让源码层先红。
       （CSV 是开发素材，另有第 8 条管；这里只数非 CSV 的。） */
    const webFileCount = (function () {
      let n = 0;
      (function walk(d) {
        fs.readdirSync(d).forEach(function (f) {
          const p = path.join(d, f);
          if (fs.statSync(p).isDirectory()) walk(p);
          else n++;
        });
      })(path.join(root, 'web'));
      return n;
    })();
    const expectFiles = (/EXPECT_WEB_FILES\s*=\s*(\d+)/.exec(verifyPy) || [])[1];
    check('核验脚本钉的 EXPECT_WEB_FILES = web/ 实际文件数（' + webFileCount + '）',
      expectFiles === String(webFileCount), '脚本里是 ' + expectFiles);
  }

  /* manifest 是「加到主屏幕」用的：写坏了浏览器不报错，只是静默失效（名字变回网址、
     图标用截图），所以这里把关键字段钉死。icons 的 src 必须真存在于 web/ 里，
     否则那份图标会被浏览器忽略、退回上一档。 */
  const mfPath = path.join(root, 'web', 'manifest.webmanifest');
  check('有 web/manifest.webmanifest', fs.existsSync(mfPath));
  if (fs.existsSync(mfPath)) {
    let mf = null;
    try { mf = JSON.parse(fs.readFileSync(mfPath, 'utf8')); } catch (e) { mf = null; }
    check('manifest 是合法 JSON', !!mf);
    if (mf) {
      check('manifest 的 name 与 short_name 都是「柚课」',
        mf.name === '柚课' && mf.short_name === '柚课',
        mf.name + ' / ' + mf.short_name);
      check('manifest 声明 standalone 且 start_url 指向本页',
        mf.display === 'standalone' && /^\.\/?index\.html$/.test(mf.start_url || ''),
        mf.display + ' / ' + mf.start_url);
      const mfIcons = mf.icons || [];
      const mfMissing = mfIcons.filter(function (ic) {
        return !ic || !ic.src || !fs.existsSync(path.join(root, 'web', ic.src));
      });
      check('manifest 的图标文件都真实存在于 web/（' + mfIcons.length + ' 个）',
        mfIcons.length >= 3 && mfMissing.length === 0,
        mfMissing.map(function (ic) { return ic && ic.src; }).join('、'));
      check('manifest 含 maskable 图标（否则安卓圆形遮罩会切到主体）',
        mfIcons.some(function (ic) { return /maskable/.test((ic && ic.purpose) || ''); }));
    }
  }
  check('index.html 引用了 manifest',
    /<link[^>]+rel="manifest"[^>]+href="manifest\.webmanifest"/.test(htmlSrc));

  /* ============================================================
     [F] v1.9.45 体检修复的守护桩
     ------------------------------------------------------------
     这批修的都是**静默**问题：转义漂移、解析跑偏、协议降级、无障碍缺项、
     备份漏字段 —— 共同点是「改错了不会有任何界面报错」，用户只是觉得
     「有点怪」。所以每条修复都要就地钉一根桩，桩必须**能验红**。
     ============================================================ */
  console.log('\n[F] v1.9.45 体检修复：转义收口 / 解析锚定 / 协议 / 无障碍 / 备份');
  {
    const storejsNC = stripComments(storejs);
    const pickerjsNC = stripComments(pickerjs);
    const cssNC = stripComments(css);
    const csvjs = fs.readFileSync(path.join(root, 'web', 'js', 'csv.js'), 'utf8');
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    const eduKtNC = ktStripped(
      fs.readFileSync(path.join(KT_DIR, 'EduLoginActivity.kt'), 'utf8'), 'EduLoginActivity.kt');

    /* —— F4：转义函数只有一份实现 ——
       原先 app.js 与 picker.js 各写一份，且已经漂了（一份 5 字符会转 `'`、
       一份 4 字符不转）。同一个语义两处实现 ⇒ 早晚发散。
       现在实现收在 store.js（`index.html` 里的第一只 script，谁都能拿到），
       另两处只留同名转发 —— 这也正是 hueOf / storedHue 那批函数的下沉先例。 */
    const escImplBody = (/function esc\s*\(\s*s\s*\)\s*\{([\s\S]*?)\n\s*\}/.exec(storejs) || [])[1] || '';
    const ESC_FORWARD = /function esc\s*\(\s*s\s*\)\s*\{\s*return Store\.esc\(s\);\s*\}/;
    check('转义函数只有一份实现，在 store.js（5 个字符一个不漏）',
      ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;']
        .every((e) => escImplBody.indexOf(e) >= 0) &&
      /\besc:\s*esc\b/.test(storejs),
      escImplBody.trim().slice(0, 60));
    check('app.js / picker.js 都只是转发，没有第二份实现',
      ESC_FORWARD.test(appjsNoComment) && ESC_FORWARD.test(pickerjsNC));
    check('第二份转义表没有偷偷长回来（两处都不许再出现实体字面量）',
      !/&amp;/.test(appjsNoComment) && !/&amp;/.test(pickerjsNC));

    /* —— F5：parseDay 的整串锚定 ——
       前缀（星期 / 周 / 礼拜）可以省 ⇒ 正则**必须锚死两头**。不锚的话
       `13:00` 会在中间匹配到 `1` 被判成「周一」，把「列错位」这种数据问题
       悄悄变成「导入成周一」，用户看不出来。 */
    const pd = global.CsvUtil.parseDay;
    check('parseDay 仍认得出各种星期写法（前缀可省、数字可写、8=周一 兼容）',
      pd('周一') === 1 && pd('星期一') === 1 && pd('礼拜一') === 1 && pd('周1') === 1 &&
      pd('1') === 1 && pd('周日') === 7 && pd('天') === 7 && pd('7') === 7 &&
      pd('0') === 7 && pd('11') === 4,
      [pd('周一'), pd('星期天'), pd('1'), pd('11')].join('/'));
    check('parseDay 不会把「13:00」这类时间当星期（前缀可省 ⇒ 整串必须锚死）',
      pd('13:00') === null && pd('1.0') === null && pd('') === null &&
      pd('周') === null && pd('星期八') === null && pd('1234') === null,
      [pd('13:00'), pd('1.0'), pd(''), pd('周'), pd('星期八'), pd('1234')]
        .map((v) => JSON.stringify(v)).join(' / '));

    /* —— F6：补协议补的是 https ——
       用户只填了域名时补协议，补 `http://` 等于**替用户把这一趟降级成明文**，
       而且他不会知道（浏览器不拦 302 echo 出来的明文）。 */
    check('内嵌浏览器补协议时补 https，不替用户把这一趟降级成明文',
      /u\s*=\s*"https:\/\/\$u"/.test(eduKtNC) &&
      !/"http:\/\/\$u"/.test(eduKtNC));

    /* —— F7：死代码不许长回来 ——
       这四处都是「已经不生效但看着还在」的东西：留着会让下一个改样式的人
       以为 `--head-h` 还能调行高、以为 `.muted` 是个可用类名。 */
    check('删掉的死代码没有再长回来（--head-h / .muted / border-left-color 过渡）',
      !/--head-h/.test(cssNC) && !/\.muted\s*[,{:]/.test(cssNC) &&
      !/border-left-color\s*:/.test(cssNC));
    check('totalCourses 与桥上的 available() 都已撤掉（没有任何调用方）',
      !/totalCourses/.test(appjsNoComment) && !/totalCourses/.test(storejsNC) &&
      !/available\s*\(\s*\)\s*:\s*Int/.test(ktNoComment));

    /* —— F10：Python 缓存不许进仓库 —— */
    check('.gitignore 排除了 Python 编译缓存（核验脚本跑一次就会生成）',
      /^__pycache__\/$/m.test(gitignore) && /^\*\.pyc$/m.test(gitignore));

    /* —— F12：无障碍三件 —— */
    check('toast 是**常驻**节点且声明了 live region（每次新建的节点读屏不认）',
      /<div[^>]*id="toast"[^>]*role="status"[^>]*aria-live="polite"[^>]*>/.test(htmlNoComment));
    const toastFn = (/function toast\s*\(\s*msg\s*\)\s*\{([\s\S]*?)\n\s*\}/.exec(appjsNoComment) || [])[1] || '';
    check('toast 用的就是页面里那个常驻节点（不是弹之前 createElement 一个）',
      /\$\('toast'\)/.test(toastFn) && !/createElement/.test(toastFn),
      toastFn.trim().slice(0, 50));
    check('课程卡能聚焦、能当按钮用（键盘用户不是二等公民）',
      /class="course"/.test(html) && /tabindex="0"/.test(html) &&
      /role="button"/.test(html) && /aria-label="/.test(html));
    check('课程卡有键盘路径（回车 / 空格等同于点一下，且拦掉空格滚屏）',
      /function bindCourseClicks/.test(appjsNoComment) &&
      /addEventListener\('keydown'/.test(appjsNoComment) &&
      /e\.keyCode === 13/.test(appjsNoComment) && /e\.keyCode === 32/.test(appjsNoComment) &&
      /e\.preventDefault\(\)/.test(appjsNoComment));
    check('键盘焦点环看得见，且用 :focus-visible（鼠标点击不显环）',
      /\.course:focus-visible\s*\{/.test(cssNC) &&
      /outline-offset:\s*-\d/.test(cssNC));

    /* 输入控件的名字。判据不是「每个控件都得有 for=」——
       被 <label> 包着的（如那个开关）、藏在无障碍树之外的（hidden）本来
       就不需要。剩下的一律要: for= / 包一层 label / aria-label 三者之一。 */
    const ctrlRe = /<(input|select|textarea)\b([^>]*)>/g;
    const bareCtrls = [];
    let ctrlM;
    while ((ctrlM = ctrlRe.exec(htmlNoComment))) {
      const attrs = ctrlM[2];
      if (/\shidden\b/.test(attrs)) continue;
      if (/aria-label=/.test(attrs)) continue;
      const idm = /id="([^"]+)"/.exec(attrs);
      const id = idm ? idm[1] : '';
      if (id && new RegExp('for="' + id + '"').test(htmlNoComment)) continue;
      const before = htmlNoComment.slice(0, ctrlM.index);
      if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue;
      bareCtrls.push(id || ctrlM[1]);
    }
    check('每个输入控件都有可读的名字（label for / 包一层 label / aria-label）',
      bareCtrls.length === 0, '没有名字的：' + bareCtrls.join('、'));
    /* 反向：`for="x"` 指向一个不存在的 id —— 比不写更坏，它**看着**关联上了 */
    const forIds = (htmlNoComment.match(/\bfor="([^"]+)"/g) || [])
      .map((s) => /for="([^"]+)"/.exec(s)[1]);
    const dangling = forIds.filter((id) => !new RegExp('id="' + id + '"').test(htmlNoComment));
    check('label 的 for 都指向真实存在的控件 id（悬空的 for 比不写更坏）',
      forIds.length >= 10 && dangling.length === 0, '悬空：' + dangling.join('、'));

    /* —— 旧 2.1 / 旧 2.9：缩放与缓存模式 —— */
    check('viewport 不再禁用户缩放（去掉 user-scalable=no / maximum-scale）',
      !/user-scalable\s*=\s*no/.test(htmlNoComment) && !/maximum-scale/.test(htmlNoComment));
    check('两处 WebView 都放开了缩放（此前是 setSupportZoom(false)）',
      !/setSupportZoom\(false\)/.test(ktNoComment) && !/setSupportZoom\(false\)/.test(eduKtNC));
    check('两处 WebView 都用 LOAD_DEFAULT（LOAD_NO_CACHE 只会让每次启动重读磁盘）',
      /LOAD_DEFAULT/.test(ktNoComment) && /LOAD_DEFAULT/.test(eduKtNC) &&
      !/LOAD_NO_CACHE/.test(ktNoComment) && !/LOAD_NO_CACHE/.test(eduKtNC));

    /* —— 旧 N8：桥上的 IO 不许阻塞 JS 线程（评估结论：不必改，但要钉住）——
       热路径是 `AndroidWidget.sync`：**每一次写盘**都会调它（新增 / 编辑 /
       删除课程、切课表、改设置全都算），所以它必须在 JS 线程上只是「收下这串
       JSON」就返回。判据两条：落盘走 apply()（内存值同步、刷盘异步）而不是
       commit()（当场同步刷盘）；重画组件甩回 UI 线程。
       另两个桥（导出 / 转发）确实在 JS 线程上同步写盘，但它们都是**用户点一下
       才发生一次**、且要拿返回值告诉用户成不成功 —— 改成异步回调等于把「回调
       丢了就永远不返回」这个新故障引进来，收益不抵风险，所以维持现状。
       注意别用 ktStripped()：它自带一条「字符串里的通配串还活着」哨兵
       （见它自己的注释），WidgetData.kt 里没有 HTTP 头，借它剥注释会被
       哨兵误红。这里直接用 stripKtComments。 */
    const wDataNC = stripKtComments(
      fs.readFileSync(path.join(KT_DIR, 'WidgetData.kt'), 'utf8'));
    check('小组件桥不在 JS 线程上同步刷盘（apply 而非 commit）',
      /prefs\(ctx\)\.edit\(\)\.putString\(KEY, json\)\.apply\(\)/.test(wDataNC) &&
      !/\.commit\(\)/.test(wDataNC));
    check('重画组件甩回 UI 线程（JS 线程只负责收下那串 JSON）',
      /runOnUiThread \{ refreshAllWidgets\(ctx\) \}/.test(ktNoComment));

    /* —— 旧 N5：全量备份 / 恢复 ——
       判据是**真跑一个来回**，不是「两端口径看着一样」：
       导出 → 把 state 弄脏 → 用导出的文本恢复 → 逐字段比回来。
       这样连「序列化漏字段」（save 与 exportAll 各写一遍那种漂移）一起测掉。 */
    const backup = global.Store.exportAll();
    const parsed0 = global.Store.parseBackup(backup);
    check('导出的是带自家标记的备份（恢复端靠这个标记才敢落地）',
      !parsed0.error && /"kind":\s*"youke-backup"/.test(backup) &&
      parsed0.data.schedules.length === global.Store.list().length,
      parsed0.error || (parsed0.data.schedules.length + ' 张'));
    check('选错文件会被挡下，而不是把用户数据悄悄清空（三种典型输入）',
      !!global.Store.parseBackup('{"hello":1}').error &&
      !!global.Store.parseBackup('[1,2,3]').error &&
      !!global.Store.parseBackup('{oops').error &&
      !!global.Store.parseBackup('').error,
      global.Store.parseBackup('{"hello":1}').error);
    global.Store.create('往返测试-临时');
    const dirty = global.Store.exportAll();
    check('哨兵：把 state 弄脏之后导出结果确实变了（否则下面那条往返是假绿）',
      dirty !== backup);
    const back = global.Store.importAll(backup);
    check('用自己的备份恢复能跑通', !back.error, back.error || ('恢复出 ' + back.count + ' 张'));
    /* 逐字段比，但**分两条**：
       · 键集合必须完全一致 —— 这条才是抓「序列化漏字段」的那把钳子；
       · 值上只放行「最后修改时间」—— 恢复本身就是一次写盘，它会顺带刷新
       `updatedAt`，这是对的、不是漏字段。
       逐叶子摊平再比（`#len` 用来把数组长度也变成一条可比的值）。 */
    const leaves = (v, p, out) => {
      if (v === null || typeof v !== 'object') { out[p] = v; return out; }
      if (v instanceof Array) {
        out[p + '#len'] = v.length;
        v.forEach((x, i) => leaves(x, p + '[' + i + ']', out));
        return out;
      }
      Object.keys(v).forEach((k) => leaves(v[k], p + '.' + k, out));
      return out;
    };
    const la = leaves(JSON.parse(global.Store.exportAll()).state, '', {});
    const lb = leaves(JSON.parse(backup).state, '', {});
    const keyDiff = Object.keys(lb).filter((k) => !(k in la))
      .concat(Object.keys(la).filter((k) => !(k in lb)));
    const valDiff = Object.keys(lb).filter((k) => (k in la) && la[k] !== lb[k]);
    check('恢复后与备份的字段**一个不漏、一个不多**（漏字段会被这条抓住）',
      Object.keys(lb).length > 50 && keyDiff.length === 0,
      (Object.keys(lb).length + ' 个字段；差异：' + keyDiff.join('、')));
    check('除「最后修改时间」外，恢复后每个值都与备份相同',
      valDiff.every((k) => /(^|\.)updatedAt$/.test(k)), valDiff.join('、'));
  }

  console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败\n');
  smokeFinished = true;
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('测试异常：' + (e && e.stack ? e.stack : e));
  smokeFinished = true;
  process.exit(1);
});
