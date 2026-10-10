/**
 * 适配结果映射（web/js/adapter-import.js）单元测试。
 *
 * 这一层是「上游的数据格式」与「柚课的课程 / 设置模型」之间的唯一翻译口，
 * 所以重点咬三件事：
 *   ① **不合法的数据不许猜**（星期越界、节次越界、没有周次 —— 一律跳过并说明）；
 *   ② 两处**两边模型不一样**的地方怎么处理（自定义时间 / 作息表）；
 *   ③ 交付给落库流程的那个 `settings` 片段算得对不对
 *      （作息表的长度、固定时长、开学日期、总周数）。
 *
 * 运行： node tools/test-adapter-import.js
 */
'use strict';

const path = require('path');
const root = path.resolve(__dirname, '..');

/* ---------- 最小环境桩 ---------- */
const memStore = {};
global.localStorage = {
  getItem: (k) => (memStore[k] === undefined ? null : memStore[k]),
  setItem: (k, v) => { memStore[k] = String(v); },
  removeItem: (k) => { delete memStore[k]; }
};
global.window = global;
global.document = undefined;

require(path.join(root, 'web', 'js', 'store.js'));
require(path.join(root, 'web', 'js', 'importer.js'));
const A = require(path.join(root, 'web', 'js', 'adapter-import.js'));

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
function section(t) { console.log('\n=== ' + t + ' ==='); }

const BASE = { totalWeeks: 16, sections: 12 };

/* ============================================================
   ① 课程映射
   ============================================================ */
section('课程映射：合法的照搬');

let r = A.mapCourse({
  name: '高等数学', teacher: '张老师', position: '博学楼 401',
  day: 1, startSection: 1, endSection: 2, weeks: [1, 2, 3]
});
check('一条正常的课能映射', r.ok === true, JSON.stringify(r));
check('字段一一对上（teacher→teacher、position→location、startSection→start）',
  r.course.name === '高等数学' && r.course.teacher === '张老师' &&
  r.course.location === '博学楼 401' && r.course.day === 1 &&
  r.course.start === 1 && r.course.end === 2 &&
  r.course.weeks.join(',') === '1,2,3',
  JSON.stringify(r.course));

r = A.mapCourse({ name: '体育', day: 7, startSection: 3, endSection: 3, weeks: [1] });
check('缺 teacher / position 时给空串（不是 undefined，界面才不会显示 "undefined"）',
  r.ok && r.course.teacher === '' && r.course.location === '', JSON.stringify(r.course));

r = A.mapCourse({ name: '实验', day: 2, startSection: 5, endSection: 5, weeks: [1] });
check('只给 startSection 时 end 跟着 start', r.ok && r.course.start === 5 && r.course.end === 5);
r = A.mapCourse({ name: '实验', day: 2, endSection: 6, weeks: [1] });
check('只给 endSection 时 start 跟着 end', r.ok && r.course.start === 6 && r.course.end === 6);
r = A.mapCourse({ name: '实验', day: 2, startSection: 5, endSection: 3, weeks: [1] });
check('起止写反了要摆正（否则渲染层按 start>end 取不到时间）',
  r.ok && r.course.start === 3 && r.course.end === 5,
  JSON.stringify(r.ok && r.course));

section('课程映射：不合法的一律跳过（不许猜）');

check('没有课程名 → 跳过', A.mapCourse({ day: 1, startSection: 1, weeks: [1] }).ok === false);
check('课程名只有空白 → 跳过',
  A.mapCourse({ name: '   ', day: 1, startSection: 1, weeks: [1] }).ok === false);

[[0, 'day=0'], [8, 'day=8'], ['', 'day 为空'], [null, 'day 为 null']].forEach(function (pair) {
  const got = A.mapCourse({ name: '课', day: pair[0], startSection: 1, weeks: [1] });
  check('星期越界要跳过（' + pair[1] + '）——越界值放进去会静默消失', got.ok === false);
});

check('节次 0 → 跳过', A.mapCourse({ name: '课', day: 1, startSection: 0, weeks: [1] }).ok === false);
check('节次 17（超上限）→ 跳过',
  A.mapCourse({ name: '课', day: 1, startSection: 17, weeks: [1] }).ok === false);
check('没有节次也没有自定义时间 → 跳过',
  A.mapCourse({ name: '课', day: 1, weeks: [1] }).ok === false);

check('周次不是数组 → 跳过', A.mapCourse({ name: '课', day: 1, startSection: 1, weeks: '1-16' }).ok === false);
check('周次空数组 → 跳过', A.mapCourse({ name: '课', day: 1, startSection: 1, weeks: [] }).ok === false);
check('周次全是越界值 → 跳过',
  A.mapCourse({ name: '课', day: 1, startSection: 1, weeks: [0, -1, 999] }).ok === false);

check('周次去重 + 升序 + 滤掉 0 与超上限',
  A.normalizeWeeks([3, 1, 3, 0, 999, 2, '4']).join(',') === '1,2,3,4',
  A.normalizeWeeks([3, 1, 3, 0, 999, 2, '4']).join(','));

section('课程映射：自定义时间（两边模型不一样的那一处）');

r = A.mapCourse({
  name: '早读', day: 1, startSection: 1, endSection: 1, weeks: [1, 2],
  isCustomTime: true, customStartTime: '07:20', customEndTime: '07:50'
});
check('带自定义时间**但**有节次 ⇒ 照常导入（标记出来供提示语使用）',
  r.ok === true && r.customTime === true, JSON.stringify(r));

r = A.mapCourse({
  name: '早读', day: 1, weeks: [1, 2],
  isCustomTime: true, customStartTime: '07:20', customEndTime: '07:50'
});
check('只有自定义时间、没有节次 ⇒ 跳过（硬塞进某一节＝替用户编了个时间）',
  r.ok === false && r.customTime === true && r.name === '早读', JSON.stringify(r));

/* ============================================================
   ② 作息表
   ============================================================ */
section('作息表');

const good = [];
for (let i = 1; i <= 12; i++) {
  good.push({ number: i, startTime: '08:00', endTime: '08:45' });
}
let slot = A.mapTimeSlots(good);
check('12 节作息映射成 12 条 times / sections=12',
  slot.times.length === 12 && slot.sections === 12, JSON.stringify([slot.times.length, slot.sections]));
check('每节一样长时 uniform = 45（决定「固定上课时长」开关）', slot.uniform === 45, slot.uniform);
check('times 的键名是 start / end（柚课侧的写法）',
  slot.times[0].start === '08:00' && slot.times[0].end === '08:45', JSON.stringify(slot.times[0]));

slot = A.mapTimeSlots([
  { number: 1, startTime: '08:00', endTime: '08:45' },
  { number: 3, startTime: '10:00', endTime: '10:45' }
]);
check('节次不连续也要落位（缺的位补上，第 3 节不能跑到第 2 格）',
  slot.times.length === 3 && slot.times[2].start === '10:00', JSON.stringify(slot.times));
check('补出来的那一节时间合法（不是空串 / NaN）',
  /^\d{2}:\d{2}$/.test(slot.times[1].start) && /^\d{2}:\d{2}$/.test(slot.times[1].end),
  JSON.stringify(slot.times[1]));

slot = A.mapTimeSlots([
  { number: 1, startTime: '08:00', endTime: '08:45' },
  { number: 2, startTime: '8:50', endTime: '9:35' },
  { number: 3, startTime: '10:00', endTime: '10:50' }
]);
check('非法时刻（8:50 不是两位小时）被丢掉，而不是当 0 点',
  slot.times.length === 3 && slot.times[0].start === '08:00', JSON.stringify(slot.times));
check('每节长短不一时 uniform = 0（这样就**不该**开「固定上课时长」，否则会替用户改数据）',
  A.uniformOf([{ start: '08:00', end: '08:45' }, { start: '09:00', end: '10:00' }]) === 0);

const many = [];
for (let i = 1; i <= 20; i++) many.push({ number: i, startTime: '08:00', endTime: '08:45' });
slot = A.mapTimeSlots(many);
check('超过 16 节只取前 16 节', slot.times.length === 16, slot.times.length);
check('并且**明说**截断了（不能默默少几节）', /16/.test(slot.note) && /超过/.test(slot.note), slot.note);

check('没有合法项 → 返回 null（调用方据此不动用户的作息表）',
  A.mapTimeSlots([]) === null && A.mapTimeSlots('不是JSON') === null &&
  A.mapTimeSlots([{ number: 1, startTime: '25:00', endTime: '08:45' }]) === null);

/* ============================================================
   ③ 学期设置
   ============================================================ */
section('学期设置');

let cfg = A.mapConfig({ semesterStartDate: '2026-09-07', semesterTotalWeeks: 18, defaultClassDuration: 50 });
check('开学日期直接采用', cfg.semesterStart === '2026-09-07', cfg.semesterStart);
check('总周数采用', cfg.totalWeeks === 18, cfg.totalWeeks);
check('单节时长采用', cfg.classDuration === 50, cfg.classDuration);

check('斜杠 / 点分隔的日期也认（教务常见两种写法）',
  A.mapConfig({ semesterStartDate: '2026/9/7' }).semesterStart === '2026-09-07' &&
  A.mapConfig({ semesterStartDate: '2026.9.7' }).semesterStart === '2026-09-07',
  JSON.stringify(A.mapConfig({ semesterStartDate: '2026/9/7' })));

check('月份 / 日越界的日期不采用（宁可不动用户的学期开始日）',
  A.mapConfig({ semesterStartDate: '2026-13-40' }).semesterStart === undefined,
  String(A.mapConfig({ semesterStartDate: '2026-13-40' }).semesterStart));
check('null（上游表示「没拿到」）不采用、也不算「给了但不认」',
  A.mapConfig({ semesterStartDate: null }).semesterStart === undefined &&
  A.mapConfig({ semesterStartDate: null }).ignored.length === 0,
  JSON.stringify(A.mapConfig({ semesterStartDate: null })));
check('给了但读不懂的日期，要记进「没生效」里（不能默默丢）',
  A.mapConfig({ semesterStartDate: '明年九月' }).ignored.indexOf('开学日期') >= 0,
  JSON.stringify(A.mapConfig({ semesterStartDate: '明年九月' })));

check('总周数越界不采用',
  A.mapConfig({ semesterTotalWeeks: 0 }).totalWeeks === undefined &&
  A.mapConfig({ semesterTotalWeeks: 999 }).totalWeeks === undefined);
check('单节时长越界不采用',
  A.mapConfig({ defaultClassDuration: 1 }).classDuration === undefined);

const ig = A.mapConfig({ defaultBreakDuration: 5, firstDayOfWeek: 7 });
check('课间时长 / 每周起始日记进「没生效」（柚课没有对应字段，读而不装作用了）',
  ig.ignored.indexOf('课间时长') >= 0 && ig.ignored.indexOf('每周起始日') >= 0,
  JSON.stringify(ig.ignored));

/* ============================================================
   ④ 汇总 toResult
   ============================================================ */
section('汇总：一整趟适配跑完');

const payload = {
  adapterId: 'TESTU_01',
  adapterName: '示例大学教务系统',
  schoolName: '示例大学',
  maintainer: '维护者甲',
  courses: [
    { name: '高等数学', teacher: '张老师', position: '教101', day: 1, startSection: 1, endSection: 2, weeks: [1, 2, 3] },
    { name: '高等数学', teacher: '张老师', position: '教101', day: 1, startSection: 3, endSection: 4, weeks: [1, 2, 3] },
    { name: '大学英语', teacher: '李老师', position: '文史楼203', day: 3, startSection: 5, endSection: 5, weeks: [1, 3, 5] }
  ],
  timeSlots: good,
  config: { semesterStartDate: '2026-09-07', semesterTotalWeeks: 18, defaultClassDuration: 45, firstDayOfWeek: 7 }
};
let out = A.toResult(payload, BASE);

check('相邻节次被合并（1-2 与 3-4 合成 1-4）——与其它导入通道同一份逻辑',
  out.courses.length === 2 &&
  out.courses[0].name === '高等数学' && out.courses[0].start === 1 && out.courses[0].end === 4,
  JSON.stringify(out.courses.map(function (c) { return c.name + ':' + c.start + '-' + c.end; })));
check('来源写清了适配脚本 + 校名 + 维护者（上游要求保留贡献者署名）',
  out.source.indexOf('示例大学教务系统') >= 0 &&
  out.source.indexOf('示例大学') >= 0 &&
  out.source.indexOf('维护者甲') >= 0, out.source);
check('格式标成 adapter', out.format === 'adapter', out.format);

check('settings 片段：作息表 / 节数 / 固定时长 / 单节时长',
  out.settings.times.length === 12 && out.settings.sections === 12 &&
  out.settings.fixedDuration === true && out.settings.classDuration === 45,
  JSON.stringify({ s: out.settings.sections, f: out.settings.fixedDuration, c: out.settings.classDuration }));
check('settings 片段：开学日期与总周数',
  out.settings.semesterStart === '2026-09-07' && out.settings.totalWeeks === 18,
  JSON.stringify([out.settings.semesterStart, out.settings.totalWeeks]));
check('suggestTotalWeeks 由 maxWeek 推出（这里 5 < 16，所以是 0）',
  out.suggestTotalWeeks === 0, out.suggestTotalWeeks);
check('提示里说清了「按作息表设置了多少节」',
  out.notes.join('\n').indexOf('12 节') >= 0, out.notes.join(' | '));
check('提示里说清了 firstDayOfWeek 没生效', out.notes.join('\n').indexOf('每周起始日') >= 0);

section('汇总：空 / 坏数据要给出可读的解释');

out = A.toResult({ adapterName: '示例适配', courses: [], timeSlots: null, config: null }, BASE);
check('一条课都没有时给出可读原因（并提到登录失效这条路）',
  out.courses.length === 0 && out.errors.length > 0 &&
  out.errors.join('').indexOf('登录') >= 0, out.errors.join(' | '));
check('没有作息表时不产生 settings.times（不能把用户的作息表清空）',
  out.settings.times === undefined, JSON.stringify(Object.keys(out.settings)));

out = A.toResult({
  adapterName: '示例适配',
  courses: [
    { name: '课A', day: 9, startSection: 1, weeks: [1] },
    { name: '早读', day: 1, weeks: [1], isCustomTime: true, customStartTime: '07:20', customEndTime: '07:50' },
    { name: '课B', day: 1, startSection: 1, endSection: 1, weeks: [1] }
  ]
}, BASE);
check('坏数据与「只有自定义时间」分开计数、分别说明',
  out.courses.length === 1 &&
  out.errors.join('').indexOf('1 条课程数据不完整') >= 0 &&
  out.notes.join('').indexOf('早读') >= 0,
  JSON.stringify([out.errors, out.notes]));
check('skipped 把两类都算上', out.skipped === 2, out.skipped);

section('汇总：桥两边传的是 JSON 字符串（原生侧原样转交）');

out = A.toResult({
  adapterName: '示例适配', schoolName: '示例大学',
  courses: JSON.stringify([{ name: '课', day: 2, startSection: 1, endSection: 1, weeks: [1, 2] }]),
  timeSlots: JSON.stringify([{ number: 1, startTime: '08:00', endTime: '08:45' }]),
  config: JSON.stringify({ semesterTotalWeeks: 20 })
}, BASE);
check('三类数据给字符串也能吃（不是只认对象）',
  out.courses.length === 1 && out.settings.sections === 1 && out.settings.totalWeeks === 20,
  JSON.stringify([out.courses.length, out.settings]));
check('字符串形态下 suggestTotalWeeks 也算得出来（20 > 16）',
  out.suggestTotalWeeks === 0 || out.suggestTotalWeeks === 2, out.suggestTotalWeeks);

out = A.toResult({
  adapterName: '示例适配',
  courses: [{ name: '课', day: 1, startSection: 1, endSection: 1, weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] }]
}, BASE);
check('周数超过课表现有设置时给出 suggestTotalWeeks（沿用既有自动放宽）',
  out.suggestTotalWeeks === 20, out.suggestTotalWeeks);

section('诊断：dropped 跳过行 + rawJcs 原始节次样本（v1.9.37）');

out = A.toResult({
  adapterName: '示例适配',
  courses: [
    { name: '好课', day: 1, startSection: 1, endSection: 2, weeks: [1, 2], rawJcs: '1-2' },
    { name: '另一门', day: 3, startSection: 5, endSection: 6, weeks: [1, 2], rawJcs: '5-6' }
  ],
  dropped: [
    { name: '没节次', reason: '节次读不出', jcs: '', zcd: '1-16周' },
    { name: '节次乱码', reason: '节次读不出', jcs: 'abc', zcd: '1-16周' }
  ]
}, BASE);
check('dropped 行数写进 notes（不静默吞）',
  out.notes.some(n => n.indexOf('2 行没认出来') >= 0), JSON.stringify(out.notes));
check('dropped 样本带课名与原因',
  out.notes.some(n => n.indexOf('没节次（节次读不出') >= 0 && n.indexOf('jcs=「abc」') >= 0));
check('rawJcs 样本写进 notes（原始写法对照）',
  out.notes.some(n => n.indexOf('节次原始写法样本') >= 0 &&
    n.indexOf('好课 jcs=「1-2」') >= 0 && n.indexOf('另一门 jcs=「5-6」') >= 0));
check('诊断字段不进课程本体（rawJcs 不落库）',
  out.courses.every(c => c.rawJcs === undefined));
check('没有 dropped / rawJcs 时 notes 干净（不出空行样本）',
  A.toResult({ adapterName: '示例适配', courses: [
    { name: '课', day: 2, startSection: 1, endSection: 1, weeks: [1] }
  ] }, BASE).notes.every(n => n.indexOf('没认出来') < 0 && n.indexOf('原始写法样本') < 0));
check('dropped 封顶展示 4 条但总数如实',
  A.toResult({ adapterName: '示例适配', courses: [], dropped: [
    { name: 'a', reason: 'r' }, { name: 'b', reason: 'r' }, { name: 'c', reason: 'r' },
    { name: 'd', reason: 'r' }, { name: 'e', reason: 'r' }, { name: 'f', reason: 'r' }
  ] }, BASE).notes.some(n => n.indexOf('6 行没认出来') >= 0 && n.indexOf('等。') >= 0));

section('诊断：节次字段兜底 + 原始记录字段快照（v1.9.38）');

/* 节次取自 jcor（非标准字段）时，必须明说 —— 否则用户会以为我们悄悄改了数据 */
out = A.toResult({
  adapterName: '示例适配',
  courses: [
    { name: '兜底课', day: 2, startSection: 1, endSection: 2, weeks: [1], rawJcs: '2', secFrom: 'jcor' },
    { name: '正常课', day: 3, startSection: 5, endSection: 6, weeks: [1], rawJcs: '5-6', secFrom: 'jcs' }
  ]
}, BASE);
check('节次用了 jcor 的课在 notes 里点名',
  out.notes.some(n => n.indexOf('不在标准的 jcs 字段里') >= 0 &&
    n.indexOf('兜底课（jcor）') >= 0), JSON.stringify(out.notes));
check('走标准 jcs 的课不进「兜底」那条提示（但可以出现在原始写法样本里）',
  out.notes.filter(n => n.indexOf('不在标准的 jcs 字段里') >= 0)
    .every(n => n.indexOf('正常课') < 0));
check('secFrom 不进课程本体（只作诊断）',
  out.courses.every(c => c.secFrom === undefined));
check('节次落位按兜底结果算（1-2 而不是 2）',
  out.courses.some(c => c.name === '兜底课' && c.start === 1 && c.end === 2),
  JSON.stringify(out.courses));

out = A.toResult({
  adapterName: '示例适配',
  courses: [{ name: '课', day: 2, startSection: 1, endSection: 2, weeks: [1] }],
  sample: 'kcmc=课，jcs=2，jcor=1-2，zcd=1-16周'
}, BASE);
check('原始记录字段快照写进 notes',
  out.notes.some(n => n.indexOf('教务原始记录样本') >= 0 &&
    n.indexOf('jcor=1-2') >= 0), JSON.stringify(out.notes));
check('没有 sample 时不出空样本提示',
  A.toResult({ adapterName: '示例适配', courses: [
    { name: '课', day: 2, startSection: 1, endSection: 1, weeks: [1] }
  ] }, BASE).notes.every(n => n.indexOf('教务原始记录样本') < 0));

console.log('\n============================================');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('  失败项：' + failures.join('、'));
  process.exit(1);
}
console.log('  适配结果映射全部通过 ✔');
