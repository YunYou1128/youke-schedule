/**
 * 教务课表页 HTML 解析测试。
 *
 * 验证链路：抓回来的整页 HTML -> HtmlUtil（自研极简 HTML 解析器）
 *           -> EduGrab（课表提取）-> 课程数组
 *
 * 运行： node tools/test-eduhtml.js
 *
 * 这里用的 fixture 都按「真实教务页面结构」手写，
 * 覆盖：新版正方 jwglxt、老版正方 Table1、colspan/rowspan 表头、
 *       同一格两门课、div 版课表、iframe 拼接、script 里的裸 "<"。
 */
const fs = require('fs');
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
global.document = undefined;

require(path.join(root, 'web', 'js', 'store.js'));
require(path.join(root, 'web', 'js', 'html.js'));
require(path.join(root, 'web', 'js', 'edugrab.js'));

const H = global.HtmlUtil;
const G = global.EduGrab;
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

const SETTINGS = { totalWeeks: 18, sections: 12 };
const byName = (list, name) => list.filter((c) => c.name === name)[0];

/* ============================================================
   Fixture A：新版正方 jwglxt（主框架 + iframe 内容直接拼接）
   —— 通行做法是把主文档和 iframe 文档首尾拼起来当一篇解析
   ============================================================ */
const FRAME_MAIN = [
  '<!DOCTYPE html>',
  '<html><head><title>教学管理信息服务平台</title>',
  '<script type="text/javascript">',
  '  var a = 1 < 2 && "x" > "y";',
  '  if (a) document.write("<div>这行不该被当成标签</div>");',
  '</script>',
  '<style>td { color: #333 } </style>',
  '</head>',
  '<body class="menu">',
  '<div id="header">正方教务管理系统</div>',
  '<ul><li><a href="#">信息查询</a></li></ul>',
  '</body></html>'
].join('\n');

const FRAME_KB = [
  '<div class="main-content">',
  '<table id="kbgrid_table_0" class="kbgrid_table" style="width:100%">',
  '<thead><tr>',
  '  <th class="kbgrid_th">节次</th>',
  '  <th>星期一</th><th>星期二</th><th>星期三</th><th>星期四</th>',
  '  <th>星期五</th><th>星期六</th><th>星期日</th>',
  '</tr></thead>',
  '<tbody>',
  '<tr>',
  '  <td class="kbgrid_th">第一节</td>',
  '  <td id="1-1"><div class="kbcontent1" id="kx1-1">',
  '    <font title="课程名称">高等数学A</font><br>',
  '    <font title="周次">1-16周</font><br>',
  '    <font title="教师">张伟</font><br>',
  '    <font title="上课地点">教三-301</font>',
  '  </div></td>',
  '  <td id="2-1"></td>',
  '  <td id="3-1"><div class="kbcontent1">',
  '    <font title="课程名称">大学英语</font><br>',
  '    <font title="周次">1-16周</font><br>',
  '    <font title="教师">李娜</font><br>',
  '    <font title="上课地点">外语楼201</font>',
  '  </div></td>',
  '  <td id="4-1"></td><td id="5-1"></td><td id="6-1"></td><td id="7-1"></td>',
  '</tr>',
  '<tr>',
  '  <td class="kbgrid_th">第二节</td>',
  '  <td id="1-2"></td>',
  '  <td id="2-2"><div class="kbcontent1">',
  '    <font title="课程名称">线性代数</font><br>',
  '    <font title="周次">1-16周(单)</font><br>',
  '    <font title="教师">赵敏</font><br>',
  '    <font title="上课地点">教二-204</font>',
  '  </div></td>',
  '  <td id="3-2"></td><td id="4-2"></td><td id="5-2"></td><td id="6-2"></td><td id="7-2"></td>',
  '</tr>',
  '</tbody></table>',
  '</div>'
].join('\n');

/* 模拟抓取结果：主文档 + iframe 文档首尾拼接 */
const PAGE_NEW_ZF = FRAME_MAIN + '\n' + FRAME_KB;

console.log('\n[A] 新版正方 jwglxt（iframe 拼接的整页 HTML）');
const resA = G.extract(PAGE_NEW_ZF, SETTINGS);
eq('识别到 3 门课', resA.courses.length, 3);

const aMath = byName(resA.courses, '高等数学A');
check('高等数学A 存在', !!aMath);
if (aMath) {
  eq('  星期 = 1（周一）', aMath.day, 1);
  eq('  节次 = 1', aMath.start, 1);
  eq('  教师', aMath.teacher, '张伟');
  eq('  地点', aMath.location, '教三-301');
  eq('  周次文本', aMath.weeksText, '1-16周');
  eq('  周次展开 1-16', Store.formatWeeks(aMath.weeks), '1-16');
}
const aLin = byName(resA.courses, '线性代数');
check('线性代数 落在周二第 2 节', !!aLin && aLin.day === 2 && aLin.start === 2,
  aLin ? aLin.day + '-' + aLin.start : 'missing');
check('单周限制被识别（1-16周(单) -> 15 周）', !!aLin && aLin.weeks.length === 8 && aLin.weeks[0] === 1,
  aLin ? aLin.weeks.length : 'missing');
const aEn = byName(resA.courses, '大学英语');
check('大学英语 落在周三第 1 节', !!aEn && aEn.day === 3 && aEn.start === 1,
  aEn ? aEn.day + '-' + aEn.start : 'missing');
check('script 里的裸 "<" 没有破坏后续解析（表格仍被找到）',
  PAGE_NEW_ZF.indexOf('这行不该被当成标签') > 0 && resA.courses.length === 3);

/* ============================================================
   Fixture B：老版正方 Table1 —— 纯文本字段 + <a> 课程名 + rowspan 连堂
   ============================================================ */
const PAGE_OLD_ZF = [
  '<html><body>',
  '<table id="Table1" class="kbgrid_table">',
  '<tr><td>节次</td><td>星期一</td><td>星期二</td><td>星期三</td>',
  '<td>星期四</td><td>星期五</td><td>星期六</td><td>星期日</td></tr>',
  '<tr>',
  '  <td>第一节</td>',
  '  <td id="td1-1" rowspan="2"><a href="#">数据结构</a><br>王强<br>1-16周<br>信息楼A305</td>',
  '  <td></td><td></td><td></td><td></td><td></td><td></td>',
  '</tr>',
  '<tr>',
  '  <td>第二节</td>',
  '  <td id="td2-2">操作系统<br>刘洋<br>3-14周<br>信息楼B212</td>',
  '  <td></td><td></td><td></td><td></td>',
  '</tr>',
  '</table></body></html>'
].join('\n');

console.log('\n[B] 老版正方 Table1（纯文本 + rowspan 连堂两节）');
const resB = G.extract(PAGE_OLD_ZF, SETTINGS);
eq('识别到 2 门课', resB.courses.length, 2);
const bDs = byName(resB.courses, '数据结构');
check('数据结构 存在', !!bDs);
if (bDs) {
  eq('  星期 = 1', bDs.day, 1);
  eq('  节次 1-2（rowspan 连堂被展开）', bDs.start + '-' + bDs.end, '1-2');
  eq('  教师', bDs.teacher, '王强');
  eq('  地点', bDs.location, '信息楼A305');
}
const bOs = byName(resB.courses, '操作系统');
check('操作系统 落在周二第 2 节', !!bOs && bOs.day === 2 && bOs.start === 2,
  bOs ? bOs.day + '-' + bOs.start : 'missing');
check('周次 3-14 被识别', !!bOs && bOs.weeks[0] === 3 && bOs.weeks[bOs.weeks.length - 1] === 14,
  bOs ? bOs.weeks.join(',') : 'missing');

/* ============================================================
   Fixture C：colspan / rowspan 表头 + 大节「第3-4节」
   ============================================================ */
const PAGE_BIG_HEADER = [
  '<html><body>',
  '<table id="kbgrid_table_0">',
  '<thead>',
  '  <tr><th rowspan="2">节次</th><th colspan="7">2026-2027学年第一学期</th></tr>',
  '  <tr><th>星期一</th><th>星期二</th><th>星期三</th><th>星期四</th>',
  '      <th>星期五</th><th>星期六</th><th>星期日</th></tr>',
  '</thead>',
  '<tbody>',
  '  <tr>',
  '    <td>第3-4节</td>',
  '    <td id="1-3"><div class="kbcontent1">计算机网络<br>陈静<br>1-12周<br>实验楼C401</div></td>',
  '    <td></td><td></td><td></td><td></td><td></td><td></td>',
  '  </tr>',
  '</tbody></table>',
  '</body></html>'
].join('\n');

console.log('\n[C] colspan / rowspan 表头 + 大节「第3-4节」');
const resC = G.extract(PAGE_BIG_HEADER, SETTINGS);
eq('识别到 1 门课', resC.courses.length, 1);
const cNet = resC.courses[0];
check('计算机网络 落在周一 3-4 节',
  !!cNet && cNet.day === 1 && cNet.start === 3 && cNet.end === 4,
  cNet ? cNet.day + ' / ' + cNet.start + '-' + cNet.end : 'missing');
check('表头 colspan 不影响星期列对齐（星期列应为第 2 列起）',
  !!cNet && cNet.day === 1);
eq('地点', cNet && cNet.location, '实验楼C401');

/* ============================================================
   Fixture D：同一格里两门课（冲突课表）
   ============================================================ */
const PAGE_CONFLICT = [
  '<table id="kbgrid_table_0" class="kbgrid_table">',
  '<tr><th>节次</th><th>星期一</th><th>星期二</th><th>星期三</th>',
  '<th>星期四</th><th>星期五</th><th>星期六</th><th>星期日</th></tr>',
  '<tr><td>第五节</td>',
  '  <td id="1-5">',
  '    <div class="kbcontent1">概率论与数理统计<br>孙丽<br>1-16周<br>教一-102</div>',
  '    <div class="kbcontent1">应用文写作<br>周涛<br>3-10周<br>文科楼305</div>',
  '  </td>',
  '  <td></td><td></td><td></td><td></td><td></td><td></td>',
  '</tr></table>'
].join('\n');

console.log('\n[D] 同一格两门课');
const resD = G.extract(PAGE_CONFLICT, SETTINGS);
eq('识别到 2 门课', resD.courses.length, 2);
const dProb = byName(resD.courses, '概率论与数理统计');
const dWrite = byName(resD.courses, '应用文写作');
check('概率论与数理统计 字段正确',
  !!dProb && dProb.day === 1 && dProb.start === 5 && dProb.teacher === '孙丽' && dProb.location === '教一-102',
  JSON.stringify(dProb));
check('应用文写作 字段正确（教师「周涛」不被当成周次）',
  !!dWrite && dWrite.teacher === '周涛' && dWrite.location === '文科楼305',
  JSON.stringify(dWrite));

/* ============================================================
   Fixture E：新版正方：每行一节 + rowspan 连堂 + 单元格 id
   —— 这是正方 jwglxt 最常见的排法：连堂课占两行，且格内不写「1-2节」，
      节次只能从 rowspan 与单元格 id 推出来
   ============================================================ */
const PAGE_ROWSPAN_ID = [
  '<table id="kbgrid_table_0" class="kbgrid_table">',
  '<thead><tr><th>节次</th><th>星期一</th><th>星期二</th><th>星期三</th>',
  '<th>星期四</th><th>星期五</th><th>星期六</th><th>星期日</th></tr></thead>',
  '<tbody>',
  '<tr><td class="kbgrid_th">第一节</td>',
  '  <td id="1-1" rowspan="2"><div class="kbcontent1">高等数学A<br>张建国<br>1-16周<br>教三-301</div></td>',
  '  <td id="2-1"></td><td id="3-1"></td><td id="4-1"></td>',
  '  <td id="5-1"></td><td id="6-1"></td><td id="7-1"></td>',
  '</tr>',
  '<tr><td class="kbgrid_th">第二节</td>',
  '  <td id="2-2"><div class="kbcontent1">数据结构<br>王宏<br>1-16周<br>计算机楼-A102</div></td>',
  '  <td id="3-2"></td><td id="4-2"></td><td id="5-2"></td><td id="6-2"></td><td id="7-2"></td>',
  '</tr>',
  '</tbody></table>'
].join('\n');

console.log('\n[E] 每行一节 + rowspan 连堂 + 单元格 id');
const resE2 = G.extract(PAGE_ROWSPAN_ID, SETTINGS);
eq('识别到 2 门课', resE2.courses.length, 2);
const e2Math = byName(resE2.courses, '高等数学A');
check('高等数学A 周一 1-2 节（rowspan 连堂）',
  !!e2Math && e2Math.day === 1 && e2Math.start === 1 && e2Math.end === 2,
  e2Math ? e2Math.day + ' / ' + e2Math.start + '-' + e2Math.end : 'missing');
const e2Ds = byName(resE2.courses, '数据结构');
check('数据结构 周二第 2 节',
  !!e2Ds && e2Ds.day === 2 && e2Ds.start === 2 && e2Ds.end === 2,
  e2Ds ? e2Ds.day + ' / ' + e2Ds.start + '-' + e2Ds.end : 'missing');

/* ============================================================
   Fixture F：div 版课表（没有 table，块 id 自带星期-节次）
   ============================================================ */
const PAGE_DIV = [
  '<html><body><div class="kbwrap">',
  '<div class="kbcontent1" id="1-1">大学物理<br>吴敏<br>1-16周<br>理科楼101</div>',
  '<div class="kbcontent1" id="3-2">程序设计<br>郑凯<br>1-16周<br>机房A</div>',
  '</div></body></html>'
].join('\n');

console.log('\n[F] div 版课表（无 table）');
const resE = G.extract(PAGE_DIV, SETTINGS);
eq('识别到 2 门课', resE.courses.length, 2);
const ePhy = byName(resE.courses, '大学物理');
check('大学物理 落在周一第 1 节', !!ePhy && ePhy.day === 1 && ePhy.start === 1,
  ePhy ? ePhy.day + '-' + ePhy.start : 'missing');
const eProg = byName(resE.courses, '程序设计');
check('程序设计 落在周三第 2 节 + 地点「机房A」',
  !!eProg && eProg.day === 3 && eProg.start === 2 && eProg.location === '机房A',
  JSON.stringify(eProg));

/* ============================================================
   Fixture G：翻错页 / 没登录 —— 应当给出可操作的提示
   ============================================================ */
const PAGE_WRONG = '<html><body><div>用户登录</div><form>学号 密码</form></body></html>';
console.log('\n[G] 不是课表页');
const resF = G.extract(PAGE_WRONG, SETTINGS);
eq('没有识别出课程', resF.courses.length, 0);
check('给出「页面里没有课表」的提示', resF.errors.length > 0 && /没有课表/.test(resF.errors[0]),
  resF.errors[0]);
check('失败时附上各变体的尝试记录（便于定位）',
  resF.attempts && resF.attempts.length === 4 &&
  resF.notes.some((n) => /解析尝试记录/.test(n)),
  JSON.stringify(resF.attempts));

/* 有「星期」但一个「节」字都没有：这是正方课表最常见的坑 ——
   课表默认不显示上课时间 / 教室 / 教师，得去课表页的齿轮里打开。
   文档指出同业 App 官方文档里那句「请去教务网设置（或网页课表左上角齿轮）
   设置显示上课时间、教室、老师信息」就是这条的代码根源。 */
const PAGE_WEEK_EMPTY = '<html><body><div>课表查询</div><p>星期一 星期二 星期三</p></body></html>';
const resF2 = G.extract(PAGE_WEEK_EMPTY, SETTINGS);
check('有「星期」无「节次」-> 指点去课表页齿轮打开显示项',
  resF2.errors.length > 0 && /节次/.test(resF2.errors[0]) && /齿轮/.test(resF2.errors[0]),
  resF2.errors[0]);

/* ============================================================
   Fixture J：列表式课表（正方新版「教学管理信息服务平台」）
   —— 一行一门课，没有「星期表头 + 左侧节次」的网格结构，
      网格法必然认不出来，只能按列名读
   ============================================================ */
const PAGE_LIST = [
  '<html><body>',
  '<table id="sycjlrtabGrid" class="table_tb">',
  '<thead><tr><td>序号</td><td>课程名称</td><td>上课时间地点</td>',
  '<td>项目名称</td><td>周次</td></tr></thead>',
  '<tbody>',
  '<tr><td>1</td><td>高等数学A</td><td>星期一第1-2节</td><td>张建国</td><td>1-16周</td></tr>',
  '<tr><td>2</td><td>大学英语</td><td>星期三第3-4节</td><td>李娜</td><td>1-16周</td></tr>',
  '<tr><td>3</td><td>线性代数</td><td>星期二第5-6节</td><td>赵敏</td><td>2-16周(双)</td></tr>',
  '</tbody></table>',
  '</body></html>'
].join('\n');

console.log('\n[J] 列表式课表（一行一门课）');
const resJ = G.extract(PAGE_LIST, SETTINGS);
eq('识别到 3 门课', resJ.courses.length, 3);
const jMath = byName(resJ.courses, '高等数学A');
check('列表变体：高等数学A = 周一 1-2 节',
  !!jMath && jMath.day === 1 && jMath.start === 1 && jMath.end === 2,
  jMath ? jMath.day + ' / ' + jMath.start + '-' + jMath.end : 'missing');
check('列表变体：教师来自「项目名称」列',
  !!jMath && jMath.teacher === '张建国', jMath ? jMath.teacher : 'missing');
const jLin = byName(resJ.courses, '线性代数');
check('列表变体：周次列「2-16周(双)」只取偶数周',
  !!jLin && jLin.weeks.length === 8 && jLin.weeks.every((w) => w % 2 === 0),
  jLin ? jLin.weeks.join(',') : 'missing');
check('采用的结果来自「课程列表」变体',
  resJ.notes.some((n) => /课程列表/.test(n)), JSON.stringify(resJ.notes));
const jList = resJ.attempts.filter((a) => a.key === 'list')[0];
check('变体自检：课程列表通过体检',
  !!jList && jList.ok === true && jList.count === 3, JSON.stringify(jList));

/* ============================================================
   Fixture K：字段名藏在属性里 + 业界常见的「1-2节/1-16周(地点)」一行式
   —— aria-describedby="sycjlrtabGrid_kcmc" 这种字段后缀是正方新版的习惯；
      星期则落在单元格 id 的首段（正方系通行的约定：拿 td.id 首段当星期）
   ============================================================ */
const PAGE_LIST_ATTR = [
  '<table id="sycjlrtabGrid">',
  '<thead><tr>',
  '  <th id="sycjlrtabGrid_kcmc">课程名称</th>',
  '  <th id="sycjlrtabGrid_sksjdd">上课时间地点</th>',
  '  <th id="sycjlrtabGrid_xmmc">项目名称</th>',
  '</tr></thead>',
  '<tbody>',
  '<tr><td id="1-1">算法设计与分析</td>',
  '    <td>第1-2节/1-16周(实验楼C401)</td><td>陈静</td></tr>',
  '<tr><td id="4-2">数据结构</td>',
  '    <td>第7-8节/1-16周(计算机楼-A102)</td><td>王宏</td></tr>',
  '</tbody></table>'
].join('\n');

console.log('\n[K] 属性里的字段名 + 「1-2节/1-16周(地点)」一行式 + id 首段当星期');
const resK = G.extract(PAGE_LIST_ATTR, SETTINGS);
eq('识别到 2 门课', resK.courses.length, 2);
const kAlg = byName(resK.courses, '算法设计与分析');
check('算法设计与分析：星期从单元格 id「1-1」取到 1，节次 1-2',
  !!kAlg && kAlg.day === 1 && kAlg.start === 1 && kAlg.end === 2,
  kAlg ? kAlg.day + ' / ' + kAlg.start + '-' + kAlg.end : 'missing');
check('一行式里的括号地点被拆出来', !!kAlg && kAlg.location === '实验楼C401',
  kAlg ? kAlg.location : 'missing');
const kDs = byName(resK.courses, '数据结构');
check('数据结构：id「4-2」-> 周四 7-8 节', !!kDs && kDs.day === 4 && kDs.start === 7,
  kDs ? kDs.day + ' / ' + kDs.start : 'missing');

/* ============================================================
   Fixture L：表头没写全的星期列 —— 靠单元格 id 首段补星期
   ============================================================ */
const PAGE_ID_DAY = [
  '<table id="kbgrid_table_0" class="kbgrid_table">',
  '<tr><td>节次</td><td>星期一</td><td>星期二</td><td>星期三</td>',
  '<td>星期四</td><td>星期五</td><td></td><td></td></tr>',
  '<tr><td>第三节</td><td></td><td></td><td></td><td></td><td></td>',
  '  <td id="6-3"><div class="kbcontent1">形势与政策<br>周敏<br>9-12周<br>文科楼201</div></td>',
  '  <td></td></tr>',
  '</table>'
].join('\n');

console.log('\n[L] 表头缺列时靠单元格 id 首段定星期');
const resL = G.extract(PAGE_ID_DAY, SETTINGS);
const lPol = byName(resL.courses, '形势与政策');
check('形势与政策 = 周六第 3 节（id「6-3」）',
  !!lPol && lPol.day === 6 && lPol.start === 3,
  lPol ? lPol.day + ' / ' + lPol.start : 'missing');

/* ============================================================
   Fixture M：级联选择 —— 同一页里两种结构都读得出，取课程多的那个
   ============================================================ */
const PAGE_MIXED = [
  '<html><body>',
  '<table id="kbgrid_table_0" class="kbgrid_table">',
  '<tr><td>节次</td><td>星期一</td><td>星期二</td><td>星期三</td>',
  '<td>星期四</td><td>星期五</td></tr>',
  '<tr><td>第一节</td>',
  '  <td id="1-1"><div class="kbcontent1">体育<br>孙倩<br>1-16周<br>体育馆</div></td>',
  '  <td></td><td></td><td></td><td></td></tr>',
  '</table>',
  '<table id="sycjlrtabGrid">',
  '<tr><td>课程名称</td><td>上课时间地点</td><td>项目名称</td></tr>',
  '<tr><td>中国近现代史纲要</td><td>星期一第1-2节</td><td>何伟</td></tr>',
  '<tr><td>马克思主义基本原理</td><td>星期四第3-4节</td><td>郑霞</td></tr>',
  '<tr><td>大学物理</td><td>星期五第5-6节</td><td>吴敏</td></tr>',
  '</table>',
  '</body></html>'
].join('\n');

console.log('\n[M] 级联选择：两种结构都读得出时取课程多的');
const resM = G.extract(PAGE_MIXED, SETTINGS);
eq('取到 3 门（列表法的结果，多于网格法的 1 门）', resM.courses.length, 3);
check('识别来源写明用的是列表法',
  resM.notes.some((n) => /课程列表/.test(n)), JSON.stringify(resM.notes));
check('把「另一条路读出几门」也说明白，便于排查',
  resM.notes.some((n) => /课表网格/.test(n) && /1 门/.test(n)), JSON.stringify(resM.notes));
eq('四个变体都留下了尝试记录', resM.attempts.length, 4);
check('尝试记录里带变体名与原因',
  resM.attempts.every((a) => a.label && a.reason && typeof a.count === 'number'),
  JSON.stringify(resM.attempts));

/* ============================================================
   [N] 一行式文本扫描器（单行里同时含星期 / 节次 / 周次 / 地点 / 教师）
   ============================================================ */
console.log('\n[N] 一行式文本扫描');
const n1 = G.scanText('星期一第1-2节{1-16周} 教三-301 张建国');
check('抽出星期 1', n1.day === 1, n1.day);
check('抽出节次 1-2', !!n1.sec && n1.sec.start === 1 && n1.sec.end === 2, JSON.stringify(n1.sec));
eq('抽出周次', n1.weeksText, '1-16周');
eq('抽出地点', n1.location, '教三-301');
eq('抽出教师', n1.teacher, '张建国');
eq('剩余词为空（都被认领了）', n1.leftovers.length, 0);

const n2 = G.scanText('1-2节/1-16周(教三-301)');
check('「1-2节/1-16周(地点)」形状：节次 1-2', !!n2.sec && n2.sec.start === 1 && n2.sec.end === 2,
  JSON.stringify(n2.sec));
eq('  周次', n2.weeksText, '1-16周');
eq('  地点（括号被剥掉）', n2.location, '教三-301');
eq('  没有星期时 day = 0', n2.day, 0);

const n3 = G.scanText('高等数学A');
check('纯课程名不会被扫描器误判（matched=false，交回调用方按位置判断）',
  n3.matched === false && n3.teacher === '', JSON.stringify(n3));

/* ============================================================
   [O] 字段体检：把「表头文字被当成课程名」这类误读拦下来
   ============================================================ */
console.log('\n[O] 字段体检');
const oOk = G.auditCourses([
  { name: '高等数学A', day: 1, start: 1, end: 2, weeks: [1, 2, 3], location: '教三-301' }
]);
check('正常课程通过体检', oOk.ok === true, oOk.reason);
const oBad = G.auditCourses([
  { name: '第一节', day: 1, start: 1, end: 2, weeks: [1], location: '' },
  { name: '周次', day: 2, start: 1, end: 2, weeks: [1], location: '' }
]);
check('「第一节」「周次」这类表头文字被判为可疑', oBad.ok === false && oBad.bad === 2, oBad.reason);
check('体检结论里点明缺什么', oBad.missed.indexOf('课程名不像课名') >= 0,
  JSON.stringify(oBad.missed));
const oNoDay = G.auditCourses([{ name: '大学英语', day: 0, start: 1, end: 2, weeks: [1] }]);
check('定不出星期的课程不通过', oNoDay.ok === false && oNoDay.missed.indexOf('星期') >= 0, oNoDay.reason);
check('空结果不算通过', G.auditCourses([]).ok === false);
const oSoft = G.auditCourses([{ name: '大学英语', day: 5, start: 3, end: 4, weeks: [], location: '' }]);
check('缺周次 / 缺地点只提示、不判失败', oSoft.ok === true && oSoft.soft.length === 2,
  JSON.stringify(oSoft));

/* ============================================================
   [P] 网格表里的一门课被压成一行 —— 扫描器与 parseBlock 的配合
   ============================================================ */
const PAGE_ONELINE = [
  '<table id="kbgrid_table_0" class="kbgrid_table">',
  '<tr><td>节次</td><td>星期一</td><td>星期二</td><td>星期三</td>',
  '<td>星期四</td><td>星期五</td></tr>',
  '<tr><td>第一节</td>',
  '  <td id="1-1"><div class="kbcontent1">高等数学A<br>',
  '    星期一第1-2节{1-16周} 教三-301 张建国</div></td>',
  '  <td></td><td></td><td></td><td></td></tr>',
  '</table>'
].join('\n');

console.log('\n[P] 网格表里一门课压成一行');
const resP = G.extract(PAGE_ONELINE, SETTINGS);
const pMath = byName(resP.courses, '高等数学A');
check('课程名与其它字段都被分开（课程名没被整行吞掉）',
  !!pMath, JSON.stringify(resP.courses));
check('一行式里的周次 / 地点 / 教师都抽到了',
  !!pMath && pMath.weeksText === '1-16周' && pMath.location === '教三-301' &&
  pMath.teacher === '张建国',
  pMath ? JSON.stringify([pMath.weeksText, pMath.location, pMath.teacher]) : 'missing');
check('节次按一行的写法取 1-2', !!pMath && pMath.start === 1 && pMath.end === 2,
  pMath ? pMath.start + '-' + pMath.end : 'missing');

/* ============================================================
   Fixture Q：真机现场 —— 正方「课表列表」视图（用户截图的那一页）
   ------------------------------------------------------------
   和前面几个 fixture 的关键差别，也是一页全读不出来的四个原因：
     · 表头是「星期 / 节次 / 课表信息」，「课表信息」一列把一门课的
       所有字段装在同一格里 —— 它不是单一字段，得整格当课程块拆；
     · 节次列只写「1-2」，连一个「节」字都没有；
     · 地点是「明理（5）-401」这种「楼名（楼号）-房间号」写法；
     · 每个值都带「字段名：」外壳（教师：李明 / 上课地点：明理（5）-401）。
   ============================================================ */
const PAGE_LIST_REAL = [
  '<html><body>',
  '<div class="list-top">2026-2027学年第1学期</div>',
  '<table id="sycjlrtabGrid" class="table_tb">',
  '<thead><tr><th>星期</th><th>节次</th><th>课表信息</th></tr></thead>',
  '<tbody>',
  '<tr>',
  '  <td>星期一</td><td>1-2</td>',
  '  <td>',
  '    <div><font>Linux系统管理★</font></div>',
  '    <div>周数：2-16周(双)</div>',
  '    <div>校区:北校区校区(南区)</div>',
  '    <div>上课地点：明理（5）-401</div>',
  '    <div>教师：李明</div>',
  '    <div>教学班：Linux系统管理1班</div>',
  '  </td>',
  '</tr>',
  '<tr>',
  '  <td>星期二</td><td>3-4</td>',
  '  <td>',
  '    <div>数据库原理及应用★</div>',
  '    <div>周数：1-16周</div>',
  '    <div>校区:北校区校区(南区)</div>',
  '    <div>上课地点：明理（5）-302</div>',
  '    <div>教师：李伟</div>',
  '    <div>教学班：数据库原理及应用1班</div>',
  '  </td>',
  '</tr>',
  '</tbody></table>',
  '</body></html>'
].join('\n');

console.log('\n[Q] 真机现场：正方「课表列表」视图（星期 / 节次 / 课表信息）');
const resQ = G.extract(PAGE_LIST_REAL, SETTINGS);
eq('识别到 2 门课', resQ.courses.length, 2);
const qLinux = byName(resQ.courses, 'Linux系统管理★');
check('Linux系统管理★ 存在（课程名没被节次「1-2」顶掉）', !!qLinux,
  JSON.stringify(resQ.courses.map(function (c) { return c.name; })));
if (qLinux) {
  eq('  星期 = 1（星期一列）', qLinux.day, 1);
  eq('  节次 = 1-2（节次列只写「1-2」，没有「节」字）',
    qLinux.start + '-' + qLinux.end, '1-2');
  eq('  教师（剥掉「教师：」外壳）', qLinux.teacher, '李明');
  eq('  地点（楼名（楼号）-房间号 形状）', qLinux.location, '明理（5）-401');
  eq('  周次文本保留单双周', qLinux.weeksText, '2-16周(双)');
  check('  双周限制生效（2-16 里的偶数周共 8 周）',
    qLinux.weeks.length === 8 && qLinux.weeks.every(function (w) { return w % 2 === 0; }),
    qLinux.weeks.join(','));
}
const qDb = byName(resQ.courses, '数据库原理及应用★');
check('数据库原理及应用★ = 周二 3-4 节 + 地点「明理（5）-302」',
  !!qDb && qDb.day === 2 && qDb.start === 3 && qDb.end === 4 && qDb.location === '明理（5）-302',
  JSON.stringify(qDb));
check('「课表信息」列被当成课程块整格拆（走的是列表变体）',
  resQ.notes.some(function (n) { return /课程列表/.test(n); }), JSON.stringify(resQ.notes));

/* ---- Q2：这一页依赖的三个基础能力，单独钉住 ---- */
console.log('\n[Q2] 字段名外壳 / 地点形状 / 课程名判别');
const IN2 = G._internal;
eq('剥掉「教师：」', IN2.stripLabel('教师：李明'), '李明');
eq('剥掉「上课地点：」', IN2.stripLabel('上课地点：明理（5）-401'), '明理（5）-401');
eq('剥掉「周数：」', IN2.stripLabel('周数：2-16周(双)'), '2-16周(双)');
eq('半角冒号也认', IN2.stripLabel('教师:李明'), '李明');
eq('不带分隔符的「课程名称」也剥', IN2.stripLabel('课程名称高等数学A'), '高等数学A');
eq('普通课程名原样不动', IN2.stripLabel('大学英语'), '大学英语');
eq('「时间序列分析」不会被削成「序列分析」', IN2.stripLabel('时间序列分析'), '时间序列分析');
check('「明理（5）-401」认得出是地点', IN2.looksLocation('明理（5）-401') === true);
check('「教三-301」认得出是地点', IN2.looksLocation('教三-301') === true);
check('「1-2」不会被当成课程名（这条错了会连累所有课程）',
  IN2.looksCourseName('1-2') === false);
check('「1-16周」不会被当成课程名', IN2.looksCourseName('1-16周') === false);
check('「第三节」不会被当成课程名', IN2.looksCourseName('第三节') === false);
check('「Linux系统管理★」是课程名', IN2.looksCourseName('Linux系统管理★') === true);
check('「高等数学A」是课程名（像人名不算排除理由）',
  IN2.looksCourseName('高等数学A') === true);

/* ============================================================
   Fixture R：真机现场 —— 正方「表格」视图
   —— 一张 时间段 / 节次 / 星期一…星期日 的网格，且**表格没有 id**
      （只靠 class 选择器一定匹配不到，必须靠「页面里任意表格」兜底）
   ============================================================ */
const PAGE_GRID_REAL = [
  '<html><body>',
  '<table class="table_bg">',
  '<thead><tr><th>时间段</th><th>节次</th>',
  '  <th>星期一</th><th>星期二</th><th>星期三</th><th>星期四</th>',
  '  <th>星期五</th><th>星期六</th><th>星期日</th></tr></thead>',
  '<tbody>',
  '<tr>',
  '  <td rowspan="2">上午</td><td>1</td>',
  '  <td></td><td></td><td></td><td></td>',
  '  <td id="5-1" rowspan="2"><div class="kbcontent1">Linux系统管理★<br>',
  '      周数：2-16周(双)<br>校区:北校区校区(南区)<br>',
  '      上课地点：明理（5）-401<br>教师：李明</div></td>',
  '  <td></td><td></td>',
  '</tr>',
  '<tr><td>2</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>',
  '</tbody></table>',
  '</body></html>'
].join('\n');

console.log('\n[R] 真机现场：正方「表格」视图（表格没有 id，靠任意表格兜底）');
const resR = G.extract(PAGE_GRID_REAL, SETTINGS);
eq('识别到 1 门课', resR.courses.length, 1);
const rLinux = byName(resR.courses, 'Linux系统管理★');
check('Linux系统管理★ = 周五 1-2 节（rowspan 连堂）',
  !!rLinux && rLinux.day === 5 && rLinux.start === 1 && rLinux.end === 2,
  rLinux ? rLinux.day + ' / ' + rLinux.start + '-' + rLinux.end : 'missing');
check('表格没 id 也认得出来（表格 id 换了不该导致整页失效）',
  resR.notes.some(function (n) { return /Linux/.test(JSON.stringify(resR.courses)); }),
  JSON.stringify(resR.notes));
check('带「教师：」的教师与「明理（5）-401」地点都抽到了',
  !!rLinux && rLinux.teacher === '李明' && rLinux.location === '明理（5）-401',
  rLinux ? JSON.stringify([rLinux.teacher, rLinux.location]) : 'missing');
check('单双周（周数：2-16周(双)）在网格版里也保住了',
  !!rLinux && rLinux.weeksText === '2-16周(双)', rLinux ? rLinux.weeksText : 'missing');

/* ============================================================
   Fixture S：星期 / 节次两列在 DOM 里是空的，只有最后一格有内容
   —— 真机截图里那两列看起来就是空的。此时唯一还带位置信息的东西
      是单元格 id（正方 td.id = 星期-节次），所以它必须被当成最后一档兜底。
   ============================================================ */
const PAGE_LIST_IDONLY = [
  '<table id="sycjlrtabGrid" class="table_tb">',
  '<thead><tr><th>星期</th><th>节次</th><th>课表信息</th></tr></thead>',
  '<tbody>',
  '<tr><td></td><td></td>',
  '  <td id="3-3">',
  '    <div>大学物理★</div>',
  '    <div>周数：1-16周</div>',
  '    <div>上课地点：明理（5）-203</div>',
  '    <div>教师：吴敏</div>',
  '  </td>',
  '</tr>',
  '</tbody></table>'
].join('\n');

console.log('\n[S] 星期 / 节次列为空，只靠单元格 id 兜位置');
const resS = G.extract(PAGE_LIST_IDONLY, SETTINGS);
eq('识别到 1 门课', resS.courses.length, 1);
const sPhy = byName(resS.courses, '大学物理★');
check('大学物理★ = 周三第 3 节（id「3-3」）',
  !!sPhy && sPhy.day === 3 && sPhy.start === 3 && sPhy.end === 3,
  sPhy ? sPhy.day + ' / ' + sPhy.start + '-' + sPhy.end : 'missing');
check('空白列不影响其余字段（教师 / 地点 / 周次照抽）',
  !!sPhy && sPhy.teacher === '吴敏' && sPhy.location === '明理（5）-203' &&
  sPhy.weeksText === '1-16周',
  sPhy ? JSON.stringify([sPhy.teacher, sPhy.location, sPhy.weeksText]) : 'missing');


/* ============================================================
   [H] HtmlUtil 自身的行为
   ============================================================ */
console.log('\n[H] HtmlUtil 基础能力');
const doc = H.parse('<div id="a" class="x y"><span>1</span><span>2</span></div>'
  + "<p data-v='单引号'>p1</p><br><input type=text value=abc>");
eq('querySelector 命中 #id', H.querySelector(doc, '#a').tagName, 'DIV');
eq('后代选择器', H.querySelectorAll(doc, '#a span').length, 2);
eq('属性选择器（单引号值）', H.attr(H.querySelector(doc, "p[data-v='单引号']"), 'data-v'), '单引号');
eq('无引号属性值', H.attr(H.querySelector(doc, 'input'), 'value'), 'abc');
eq('class 匹配', H.hasClass(H.querySelector(doc, '.y'), 'x'), true);
eq('子元素选择器', H.querySelectorAll(doc, 'div > span').length, 2);
eq('多选择器', H.querySelectorAll(doc, 'p, span').length, 3);
eq('innerText 把 <br> 变成换行', H.innerText(H.parse('<div>a<br>b</div>')).indexOf('\n') > 0, true);
eq('未闭合标签自动补全', H.querySelectorAll(H.parse('<table><tr><td>a<td>b</table>'), 'td').length, 2);
eq('实体解码', H.text(H.parse('<div>A&amp;B&nbsp;C</div>')), 'A&B\u00A0C');
eq('注释被忽略', H.querySelector(H.parse('<div><!-- <span>x</span> -->ok</div>'), 'span'), null);
eq('script 内容不参与解析',
  H.querySelectorAll(H.parse('<script>var a = "<div>";</script><div id="real">x</div>'), 'div').length, 1);
eq('多文档拼接都保留（模拟 iframe 抓取）',
  H.querySelectorAll(H.parse('<html><body>a</body></html><div class="f">b</div>'), '.f').length, 1);

/* ============================================================
   [I] 完整页面样本：主框架 + iframe 内容拼接的整页（15 门课）
   由 tools/make-edu-fixture.js 生成
   ============================================================ */
const sampleHtml = path.join(root, 'tools', 'fixtures', 'edu-kb-newzf.html');
if (fs.existsSync(sampleHtml)) {
  const resI = G.extract(fs.readFileSync(sampleHtml, 'utf8'), SETTINGS);
  eq('15 门课程全部识别', resI.courses.length, 15);

  const iMath = byName(resI.courses, '高等数学A');
  check('连堂课「高等数学A」= 周一 1-2 节',
    !!iMath && iMath.day === 1 && iMath.start === 1 && iMath.end === 2,
    iMath ? iMath.day + ' / ' + iMath.start + '-' + iMath.end : 'missing');
  check('连堂课字段完整', !!iMath && iMath.teacher === '张建国' && iMath.location === '教三-301',
    JSON.stringify(iMath));

  const iSelf = byName(resI.courses, '自习');
  check('4 节连排的「自习」= 周日 1-4 节',
    !!iSelf && iSelf.day === 7 && iSelf.start === 1 && iSelf.end === 4,
    iSelf ? iSelf.day + ' / ' + iSelf.start + '-' + iSelf.end : 'missing');

  const iLecture = byName(resI.courses, '学术讲座');
  check('散点周次「1,4,8,12周」被正确展开',
    !!iLecture && iLecture.weeks.join(',') === '1,4,8,12',
    iLecture ? iLecture.weeks.join(',') : 'missing');

  const iProb = byName(resI.courses, '概率论与数理统计');
  check('单周课程只落在奇数周',
    !!iProb && iProb.weeks.length > 0 && iProb.weeks.every(function (w) { return w % 2 === 1; }),
    iProb ? iProb.weeks.join(',') : 'missing');

  const iAlg = byName(resI.courses, '算法设计与分析');
  check('「1-8,10-16周」跳过第 9 周',
    !!iAlg && iAlg.weeks.indexOf(9) < 0 && iAlg.weeks.indexOf(8) >= 0 && iAlg.weeks.indexOf(10) >= 0,
    iAlg ? iAlg.weeks.join(',') : 'missing');

  check('七个星期列都有课程落位',
    [1, 2, 3, 4, 5, 6, 7].every(function (d) {
      return resI.courses.some(function (c) { return c.day === d; });
    }));
} else {
  console.log('  (跳过：请先运行 node tools/make-edu-fixture.js 生成样本)');
}

/* ---------- 汇总 ---------- */
console.log('\n============================================');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('  失败项：' + failures.join('、'));
  process.exit(1);
}
console.log('  教务课表 HTML 解析全部通过 ✔');
