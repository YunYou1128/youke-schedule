/**
 * 桌面小组件数据快照测试。
 *
 * 验证链路：localStorage 里的课表 -> Store.buildWidgetData()
 *           -> { days: { 'YYYY-MM-DD': [课程…] } } -> 原生按日期取用
 *
 * 为什么这层非测不可：桌面小组件读不到 localStorage，显示什么全看这份快照。
 * 快照算错（周次、单双周、节次→钟点、学期边界）**不会报任何错**，
 * 只会安静地在桌面上显示错课 —— 页面里怎么看都是对的，肉眼根本发现不了。
 * 所以这里逐条钉住「换算是真的」，而不是只断言「跑出了 56 个键」。
 *
 * 运行： node tools/test-widget.js
 */
const path = require('path');

const root = path.resolve(__dirname, '..');

/* ---------- 最小环境桩（store.js 需要 localStorage） ---------- */
const memStore = {};
global.localStorage = {
  getItem: (k) => (memStore[k] === undefined ? null : memStore[k]),
  setItem: (k, v) => { memStore[k] = String(v); },
  removeItem: (k) => { delete memStore[k]; }
};
global.window = global;

require(path.join(root, 'web', 'js', 'store.js'));
const Store = global.Store;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { console.log('  ✔ ' + name); pass++; }
  else {
    console.log('  ✘ ' + name + (extra !== undefined ? '  -> ' + extra : ''));
    failures.push(name);
    fail++;
  }
}
function eq(name, actual, expect) {
  check(name, actual === expect, 'actual=' + JSON.stringify(actual) + ' expect=' + JSON.stringify(expect));
}

/* ============================================================
   基准数据
   ------------------------------------------------------------
   学期第 1 周的周一 = 2026-08-31（刻意选一个真的是周一的日期，
   否则 toMonday() 会把它折到上一周的周一，整份测试的周次全部偏 1）。
   ============================================================ */
const START = '2026-08-31';
const day = (y, m, d) => new Date(y, m - 1, d);
const START_D = day(2026, 8, 31);                 // 第 1 周 周一
const mondayOf = (w) => Store.addDays(START_D, (w - 1) * 7);

function allWeeks(n) {
  const a = [];
  for (let i = 1; i <= (n || 18); i++) a.push(i);
  return a;
}

function settings(over) {
  return Object.assign({
    semesterStart: START,
    totalWeeks: 18,
    sections: 12,
    times: Store.defaultTimes(),
    fixedDuration: true,
    classDuration: 45
  }, over || {});
}

function course(over) {
  return Object.assign({
    id: 'c1', name: '高等数学', day: 1, start: 3, end: 4,
    location: '教三302', teacher: '张三',
    weeks: allWeeks(), weeksText: '1-18'
  }, over || {});
}

function sched(courses, over) {
  return { id: 's1', name: '测试课表', courses: courses, settings: settings(over) };
}

/* ============================================================
   1. 节次 -> 钟点（小组件显示的是钟点，课表存的是节次）
   ============================================================ */
console.log('\n[1] 节次换算成钟点');
{
  const s = sched([course({ day: 1, start: 3, end: 4 })]);
  const list = Store.dayCourses(START_D, s);
  eq('第 3-4 节 → 09:55-11:30（课表存的是节次，小组件要的是钟点）',
    list[0].start + '-' + list[0].end, '09:55-11:30');

  const s1 = sched([course({ day: 1, start: 1, end: 1 })]);
  eq('只上第 1 节 → 08:00-08:45', (() => {
    const l = Store.dayCourses(START_D, s1);
    return l[0].start + '-' + l[0].end;
  })(), '08:00-08:45');

  eq("'8:00' 这种少一位的写法会被规范化成 '08:00'",
    Store.sectionTime([{ start: '8:00', end: '8:45' }], 1, 'start'), '08:00');

  const sBad = sched([course({ day: 1, start: 30, end: 31 })]);   // 表里只有 12 节
  eq('时间表里没有这一节 → 这门课不进快照（而不是编一个钟点出来）',
    Store.dayCourses(START_D, sBad).length, 0);
}

/* ============================================================
   2. 排序：小组件从上到下就是「今天第 1 节 → 最后一节」
   ============================================================ */
console.log('\n[2] 按时间排序');
{
  const s = sched([
    course({ id: 'c1', name: '晚课', day: 1, start: 7, end: 8 }),     // 14:50
    course({ id: 'c2', name: '早课', day: 1, start: 1, end: 2 }),     // 08:00
    course({ id: 'c3', name: '午课', day: 1, start: 5, end: 5 })      // 11:35
  ]);
  const names = Store.dayCourses(START_D, s).map((c) => c.name).join(',');
  eq('乱序录入的课被按上课时间排好（第一项就是「接下来要去的那节」）',
    names, '早课,午课,晚课');
}

/* ============================================================
   3. 周次与单双周：同一个星期几在不同周是不同的课
   ============================================================ */
console.log('\n[3] 周次过滤');
{
  const s = sched([
    course({ id: 'c1', name: '全程课', day: 1, start: 1, end: 1, weeks: allWeeks() }),
    course({ id: 'c2', name: '后八周课', day: 1, start: 3, end: 3, weeks: [3, 4, 5, 6, 7, 8, 9, 10].concat([11, 12, 13, 14, 15, 16, 17, 18]) }),
    course({ id: 'c3', name: '单周课', day: 1, start: 5, end: 5, weeks: [1, 3, 5, 7, 9, 11, 13, 15, 17] })
  ]);

  const w1 = Store.dayCourses(mondayOf(1), s).map((c) => c.name);
  const w2 = Store.dayCourses(mondayOf(2), s).map((c) => c.name);
  const w3 = Store.dayCourses(mondayOf(3), s).map((c) => c.name);

  eq('第 1 周：全程课 + 单周课（后八周课还没开）', w1.join(','), '全程课,单周课');
  eq('第 2 周：单周课不出现（这一条就是「单双周过滤真的生效」）', w2.join(','), '全程课');
  eq('第 3 周：后八周课开始了', w3.join(','), '全程课,后八周课,单周课');

  const wk = Store.weekOf(mondayOf(3), START);
  eq('第 3 周的周一算出来确实是第 3 周（周次算法本身没歪）', wk, 3);
}

/* ============================================================
   4. 学期边界：开始前与结束后都不该冒出课来
   ============================================================ */
console.log('\n[4] 学期边界');
{
  const s = sched([course({ day: 1, start: 1, end: 1, weeks: allWeeks() })]);
  eq('学期开始前一天 → 空（第 0 周不是「全周都有课」）',
    Store.dayCourses(Store.addDays(START_D, -1), s).length, 0);
  eq('第 18 周的正常日 → 有课',
    Store.dayCourses(mondayOf(18), s).length, 1);
  eq('第 19 周（超出总周数）→ 空',
    Store.dayCourses(mondayOf(19), s).length, 0);
  eq('把总周数调成 16，第 17 周就空了',
    Store.dayCourses(mondayOf(17), sched([course({ day: 1, start: 1, end: 1, weeks: allWeeks(16) })], { totalWeeks: 16 })).length, 0);
}

/* ============================================================
   5. 星期几的映射：课程里 1=周一 … 7=周日，而 Date.getDay() 里 0=周日
   ============================================================ */
console.log('\n[5] 周日映射');
{
  const s = sched([course({ day: 7, name: '周日课', start: 1, end: 1 })]);
  eq('day=7 的课落在周日（不是落在周一）',
    Store.dayCourses(Store.addDays(START_D, 6), s).length, 1);
  eq('同一天（周日）在周一那天不出现',
    Store.dayCourses(START_D, s).length, 0);
}

/* ============================================================
   6. 配色：小组件上的色条必须和课表卡片同色
   ============================================================ */
console.log('\n[6] 课程配色');
{
  const withColor = course({ color: '#1a2b3c', name: '手动配色课' });
  const auto = course({ id: 'c2', name: '自动配色课' });
  const withHue = course({ id: 'c3', name: '老数据色相课', hue: 200 });

  const s = sched([withColor, auto, withHue]);
  const byName = {};
  Store.dayCourses(START_D, s).forEach((c) => { byName[c.name] = c.color; });

  eq('手动指定的颜色原样传给小组件（大写化）', byName['手动配色课'], '#1A2B3C');
  check('没配过色的课拿到的是一个真色值（小组件画不了「自动」这个概念）',
    /^#[0-9A-F]{6}$/.test(byName['自动配色课'] || ''), byName['自动配色课']);
  eq('老数据里的 hue 照旧折算成色值（这条是硬判据：具体输入 200 对具体色值）',
    byName['老数据色相课'], Store.cardHex(200));

  /* 下面这条**不能**写成 eq(byName[...], Store.courseHex(auto))：
     两边都调 courseHex，它坏了两边一起坏，是一条永远为真的空断言。
     要判的是「自动配色真的按课程名分散」，所以拿四个不同名字去比。 */
  const autoHexes = ['语文', '数学', '英语', '物理'].map(
    (n) => Store.courseHex(course({ name: n })));
  check('不同课程名的自动色互不相同（不是所有课都糊成同一个色）',
    new Set(autoHexes).size > 1, autoHexes.join(','));
  check('自动色全是合法色值', autoHexes.every((h) => /^#[0-9A-F]{6}$/.test(h)),
    autoHexes.join(','));
}

/* ============================================================
   7. 快照整体：原生靠「键在、值为空数组」区分「这天没课」和「快照过期」
   ============================================================ */
console.log('\n[7] 快照结构');
{
  const s = sched([course({ day: 1, start: 1, end: 1, weeks: allWeeks() })]);
  Store.state.schedules = [s];
  Store.state.activeId = s.id;

  const snap = Store.buildWidgetData();
  eq('版本号存在（原生据此判断要不要重新解析）', snap.v, 1);
  eq('带上课表名（小组件标题要显示这是哪张课表）', snap.schedule, '测试课表');
  check('带 pushedAt 时间戳', typeof snap.pushedAt === 'number' && snap.pushedAt > 0);
  eq('覆盖的天数 = Store.WIDGET_DAYS', Object.keys(snap.days).length, Store.WIDGET_DAYS);

  const today = Store.fmtDate(new Date());
  check('包含今天这一键（否则小组件开箱就是「请打开柚课更新」）',
    Object.prototype.hasOwnProperty.call(snap.days, today), today);
  check('值为数组（空数组=这天没课，缺键=快照过期，两者含义不能混）',
    Object.values(snap.days).every((v) => Array.isArray(v)));
  eq('快照的第一天就是今天（不早一天也不晚一天）', snap.start, today);
  // 注意：快照只覆盖「从今天起 56 天」，学期第 1 周（8/31）在它之前，
  // 所以下面这条**不能**去 snap.days 里找，要直接调 dayCourses。
  eq('直接用第 1 周的周一取课 → 有那门课（周次换算在快照之外也成立）',
    Store.dayCourses(mondayOf(1), s).length, 1);

  const one = Store.dayCourses(mondayOf(1), s)[0];
  const keys = ['id', 'name', 'teacher', 'loc', 'start', 'end', 'color'].every(
    (k) => Object.prototype.hasOwnProperty.call(one, k));
  check('每一项都带齐原生要用的字段（id/name/teacher/loc/start/end/color）', keys,
    JSON.stringify(one));

  const tomorrow = Store.fmtDate(Store.addDays(Store.startOfDay(new Date()), 1));
  eq('没课的日子给的是空数组而不是缺键',
    Array.isArray(snap.days[tomorrow]), true);
}

/* ============================================================
   8. 保存钩子：任何一次写盘都要重推快照
   ============================================================ */
console.log('\n[8] 保存钩子');
{
  let hits = 0;
  Store.onSave(() => { hits++; });
  Store.save();
  eq('save() 之后钩子被调用（新增/编辑/删除/换课表都走 save，漏一处桌面就是旧的）', hits, 1);
  Store.save();
  eq('再存一次再触发一次', hits, 2);

  let threw = false;
  Store.onSave(() => { throw new Error('钩子自己炸了'); });
  try { Store.save(); } catch (e) { threw = true; }
  eq('钩子抛异常不会把 save() 带崩（课表存不下去比小组件不刷新严重得多）', threw, false);
}

/* ============================================================
   9. 没有课表 / 空课表时不能炸
   ============================================================ */
console.log('\n[9] 兜底');
{
  eq('课程为空的课表 → 每天都是空数组', Store.dayCourses(START_D, sched([])).length, 0);
  eq('不传课表 → 用「当前课表」（dayCourses(date) 的默认行为，快照就是这么调的）',
    Store.dayCourses(START_D).length, 1);

  // 真·没有课表：把 state 清空（用户刚装完、还没来得及建课表的情形）
  const keepList = Store.state.schedules, keepId = Store.state.activeId;
  Store.state.schedules = []; Store.state.activeId = '';
  let boom = false;
  let empty = null;
  try { empty = Store.dayCourses(START_D); } catch (e) { boom = true; }
  eq('一门课表都没有 → 返回空数组而不是抛异常', boom ? 'threw' : empty.length, 0);
  Store.state.schedules = keepList; Store.state.activeId = keepId;

  const noTimes = sched([course({ day: 1, start: 1, end: 1 })], { times: [] });
  eq('时间表是空的 → 不产出钟点，这门课跳过', Store.dayCourses(START_D, noTimes).length, 0);
}

console.log('\n============================================');
if (fail === 0) {
  console.log('  通过 ' + pass + ' 项，失败 0 项');
  console.log('  桌面小组件数据快照全部通过 ✔');
} else {
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('  失败项：');
  failures.forEach((f) => console.log('   - ' + f));
  process.exitCode = 1;
}
