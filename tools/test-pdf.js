/* 用真实文件回归测试 PDF 课表解析器 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
global.window = global;
require(path.join(root, 'web', 'js', 'store.js'));
const Pdf = require(path.join(root, 'web', 'js', 'pdf.js'));

console.log('环境: DecompressionStream=' + (typeof DecompressionStream) + ' Blob=' + (typeof Blob) + ' Response=' + (typeof Response));

/* 默认拿仓库里的脱敏夹具跑，不然这一行就得写某台机器的绝对路径
   （`E:\<下载目录>\<姓名>课表.pdf`）—— 那也是会随仓库公开的个人信息。
   与 `tools/test-xls.js` 同一条口径。 */
const file = process.argv[2] || path.join(root, 'tools', 'fixtures', '教务系统课表.pdf');
const buf = new Uint8Array(fs.readFileSync(file));

const W = ['一', '二', '三', '四', '五', '六', '日'];
const t0 = Date.now();

Pdf.parse(buf, { totalWeeks: 18, sections: 12 }).then(res => {
  console.log('\n=== 解析结果 ===');
  console.log('来源: ' + res.source);
  console.log('课程数: ' + res.courses.length + ' | 跳过: ' + res.skipped + ' | 错误: ' + res.errors.length + ' | 耗时 ' + (Date.now() - t0) + 'ms');
  res.errors.forEach(e => console.log('  ✘ ' + e));
  res.notes.forEach(n => console.log('  · ' + n));

  console.log('\n=== 课程明细 ===');
  res.courses.slice().sort((a, b) => a.day - b.day || a.start - b.start).forEach((c, i) => {
    console.log(String(i + 1).padStart(2) + '. 周' + W[c.day - 1] + ' ' +
      (c.start + '-' + c.end + '节').padEnd(8) + c.name.padEnd(20) + '| ' +
      (c.teacher || '—').padEnd(5) + '| ' + (c.location || '—').padEnd(14) + '| ' +
      c.weeksText.padEnd(12) + '=> ' + global.Store.formatWeeks(c.weeks));
  });

  console.log('\n=== 自检 ===');
  const bad = res.courses.filter(c => !c.name || c.day < 1 || c.day > 7 || c.start < 1 || c.end < c.start || !c.weeks.length);
  console.log(bad.length ? '✘ 字段异常 ' + bad.length + ' 条：' + JSON.stringify(bad[0]) : '✔ 全部课程字段完整');
  const expect = ['Linux系统管理', '路由与交换技术', '计算机组成原理与接口技术', '软件工程', '软件工程课程设计', '德育与班主任工作', '中国特色现代职业教育体系概论', '形势与政策（五）'];
  const got = [...new Set(res.courses.map(c => c.name))];
  const miss = expect.filter(n => !got.includes(n));
  console.log(miss.length ? '✘ 缺少课程: ' + miss.join('、') : '✔ 8 门课程全部识别（' + got.length + ' 个课程名）');
  console.log('\n识别到的课程名: ' + got.join(' / '));
});
