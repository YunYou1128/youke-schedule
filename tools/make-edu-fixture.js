/**
 * 生成「内嵌浏览器抓回来的教务课表页」测试样本。
 *
 * 产物：tools/fixtures/edu-kb-newzf.html
 *   —— 按新版正方 jwglxt 的结构手工构造：
 *      · 表格 id = kbgrid_table_0，类名 kbgrid_table
 *      · 单元格 id = 「星期-节次」
 *      · 连堂课用 rowspan 表示（更接近真实页面）
 *      · 课程字段在 div.kbcontent1 里用 <br> 分行，并带 font[title]
 *      · 最外面是「主框架 + iframe 内容」首尾拼接的形态，
 *        和 getPageHtml 递归穿透 iframe 的结果一致
 *
 * 用法： node tools/make-edu-fixture.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tools', 'fixtures');
const outFile = path.join(outDir, 'edu-kb-newzf.html');

/* 课程：名称、星期、起始节、连排节数、教师、地点、周次 */
const COURSES = [
  ['高等数学A', 1, 1, 2, '张建国', '教三-301', '1-16周'],
  ['大学英语', 1, 3, 2, '李晓燕', '外语楼-205', '1-16周'],
  ['概率论与数理统计', 1, 6, 2, '张建国', '教三-302', '1-16周(单)'],
  ['数据结构', 2, 1, 2, '王宏', '计算机楼-A102', '1-16周'],
  ['线性代数', 2, 6, 2, '赵敏', '教二-204', '1-16周(单)'],
  ['体育（篮球）', 2, 8, 2, '刘强', '体育馆', '1-16周'],
  ['操作系统', 3, 3, 2, '陈立', '计算机楼-B301', '1-16周'],
  ['算法设计与分析', 3, 6, 2, '王宏', '计算机楼-A102', '1-8,10-16周'],
  ['编译原理', 4, 1, 2, '孙志远', '教四-506', '2-16周(双)'],
  ['计算机网络', 4, 6, 2, '周涛', '计算机楼-A203', '1-16周'],
  ['Web前端开发', 4, 8, 2, '吴倩', '计算机楼-B402', '1-16周(双)'],
  ['软件工程', 5, 3, 2, '吴倩', '计算机楼-B402', '1-16周'],
  ['马克思主义基本原理', 5, 8, 2, '郑海', '教一-101', '1-12周'],
  ['学术讲座', 6, 3, 2, '外聘专家', '图书馆报告厅', '1,4,8,12周'],
  ['自习', 7, 1, 4, '', '图书馆', '1-16周']
];

const ROWS = 12;
const CN = ['一', '二', '三', '四', '五', '六', '日'];

/** 某行某天是否落在某门课里 */
function courseAt(day, row) {
  return COURSES.find((c) => c[1] === day && row >= c[2] && row < c[2] + c[3]) || null;
}

function cellHtml(day, row) {
  const c = courseAt(day, row);
  if (!c) return '      <td id="' + day + '-' + row + '"><div class="kbcontent1"></div></td>';
  if (c[2] !== row) return null;            // 被上面的 rowspan 覆盖，不输出
  const lines = [
    '<font title="课程名称">' + c[0] + '</font><br>',
    '<font title="教师">' + c[4] + '</font><br>',
    '<font title="周次">' + c[6] + '</font><br>',
    '<font title="上课地点">' + c[5] + '</font>'
  ];
  return '      <td id="' + day + '-' + row + '"' + (c[3] > 1 ? ' rowspan="' + c[3] + '"' : '') + '>' +
    '<div class="kbcontent1" id="kx' + day + '-' + row + '">' + lines.join('') + '</div></td>';
}

const rowsHtml = [];
for (let r = 1; r <= ROWS; r++) {
  const tds = [];
  for (let d = 1; d <= 7; d++) {
    const cell = cellHtml(d, r);
    if (cell !== null) tds.push(cell);
  }
  rowsHtml.push('    <tr>\n' +
    '      <td class="kbgrid_th">第' + r + '节<br>0' + (7 + r) + ':00-0' + (7 + r) + ':45</td>\n' +
    tds.join('\n') + '\n    </tr>');
}

/* 主框架（登录后的菜单页）＋ iframe 里的课表内容，首尾拼接 */
const page = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>教学管理信息服务平台</title>
<script type="text/javascript" src="/jwglxt/js/globalweb/jquery-1.8.3.min.js"></script>
<script type="text/javascript">
  // 教务页面的脚本里常有裸的 < 与未闭合引号，抓回来的 HTML 必须容错解析
  var menuUrl = "xtgl/index_initMenu.html?jsdm=&_t=" + new Date().getTime();
  if (3 > 2 && "a" < "b") { document.write("<span>菜单已加载</span>"); }
</script>
</head>
<body class="menu">
<div id="header"><div class="logo">教学管理信息服务平台</div></div>
<ul class="nav">
  <li><a href="javascript:;">信息查询</a></li>
  <li><a href="javascript:;" onclick="openKb()">学生个人课表</a></li>
</ul>
</body>
</html>
<div class="main-wrap">
<table id="kbgrid_table_0" class="kbgrid_table" border="0" cellspacing="0" cellpadding="0">
  <thead>
    <tr>
      <th class="kbgrid_th" style="width:56px;">节次</th>
${CN.map((d) => '      <th>星期' + d + '</th>').join('\n')}
    </tr>
  </thead>
  <tbody>
${rowsHtml.join('\n')}
  </tbody>
</table>
</div>
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, page, 'utf8');

const size = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log('已生成：' + path.relative(root, outFile) + '  (' + size + ' KB, ' + COURSES.length + ' 门课)');
