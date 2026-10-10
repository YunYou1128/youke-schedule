/* 用真实文件回归测试 Excel 课表解析器 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
global.window = global;
require(path.join(root, 'web', 'js', 'store.js'));
const Xls = require(path.join(root, 'web', 'js', 'xls.js'));

/* 默认拿仓库里的脱敏夹具跑，不然这一行就得写某台机器的绝对路径
   （`C:\Users\<账号>\Downloads\...`）—— 那也是会随仓库公开的个人信息。 */
const file = process.argv[2] || path.join(root, 'tools', 'fixtures', '教务处课表.xls');
const buf = new Uint8Array(fs.readFileSync(file));

console.log('=== 节次标签解析 ===');
['第一二节', '第三四节', '第五六节', '第七八节', '第九十节', '第十一十二节', '1-2', '5', '上午', '下午', '晚上', '节次', '实践课程：劳动教育◆周敏(共4周)/9-12周'].forEach(t => {
  console.log('  ' + JSON.stringify(t).padEnd(42) + ' -> ' + JSON.stringify(Xls.parseSectionLabel(t)));
});

const t0 = Date.now();
const res = Xls.parse(buf, { totalWeeks: 18, sections: 12 });
console.log('\n=== 解析结果 ===');
console.log('来源: ' + res.source);
console.log('课程数: ' + res.courses.length + ' | 跳过: ' + res.skipped + ' | 错误: ' + res.errors.length + ' | 耗时 ' + (Date.now() - t0) + 'ms');
res.errors.forEach(e => console.log('  ✘ ' + e));
res.notes.forEach(n => console.log('  · ' + n));

const W = ['一', '二', '三', '四', '五', '六', '日'];
console.log('\n=== 课程明细 ===');
res.courses.sort((a, b) => a.day - b.day || a.start - b.start)
  .forEach((c, i) => {
    console.log(String(i + 1).padStart(2) + '. 周' + W[c.day - 1] + ' ' +
      (c.start + '-' + c.end + '节').padEnd(8) +
      c.name.padEnd(18) + '| ' + (c.teacher || '—').padEnd(5) + '| ' +
      (c.location || '—').padEnd(14) + '| ' + c.weeksText.padEnd(12) + '=> ' +
      global.Store.formatWeeks(c.weeks));
  });

console.log('\n=== 自检 ===');
const bad = res.courses.filter(c => !c.name || c.day < 1 || c.day > 7 || c.start < 1 || c.end < c.start);
console.log(bad.length ? '✘ 有 ' + bad.length + ' 条字段异常：' + JSON.stringify(bad[0]) : '✔ 全部课程字段完整');
const expect = ['Linux系统管理', '路由与交换技术', '计算机组成原理与接口技术', '软件工程', '软件工程课程设计', '德育与班主任工作', '中国特色现代职业教育体系概论', '形势与政策（五）'];
const got = [...new Set(res.courses.map(c => c.name))];
const miss = expect.filter(n => !got.includes(n));
console.log(miss.length ? '✘ 缺少课程: ' + miss.join('、') : '✔ 8 门课程全部识别（' + got.length + ' 个课程名）');
