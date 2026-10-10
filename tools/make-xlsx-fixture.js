/* 生成一份与教务处 xls 同版面的 .xlsx 测试样本，用于验证 zip + XML 解析路径 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const rows = [
  ['2026-2027年第1学期', '', '', '2025级示例学院示例专业1班课表', '', '', '', '专业：示例工程技术方向(示例）', ''],
  ['节次', '', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'],
  ['上午', '第一二节', 'Linux系统管理/(1-2节)2-16周(双)/ 明理（5）-401/李明/2025级示例学院示例专业1班/52', '形势与政策（五）/(1-2节)5-8周/ 博学（4）-504/周敏/2025级示例学院示例专业1班/90', '路由与交换技术/(1-2节)1-16周/ 博学（4）-403/陈志远/2025级示例学院示例专业1班/52', '', '计算机组成原理与接口技术/(1-2节)1-15周(单)/ 明理（5）-401/王磊/2025级示例学院示例专业1班/52', '', ''],
  ['', '第三四节', '路由与交换技术/(3-4节)1-15周(单)/ 明理（5）-302/陈志远/2025级示例学院示例专业1班/52', '软件工程课程设计/(1-4节)9-15周(单)/ 博学（4）-203/孙悦/2025级示例学院示例专业1班/52', '软件工程/(3-4节)2-16周(双)/ 明理（5）-302/孙悦/2025级示例学院示例专业1班/52', '德育与班主任工作/(3-4节)9-16周/ 明理（5）-406/郑海涛/2025级示例学院示例专业1班/41', '', '', ''],
  ['下午', '第五六节', '计算机组成原理与接口技术/(5-6节)1-16周/ 明理（5）-506/王磊/2025级示例学院示例专业1班/52', '软件工程/(5-6节)1-15周(单)/ 博学（4）-203/孙悦/2025级示例学院示例专业1班/52', '', '中国特色现代职业教育体系概论/(5-6节)1-12周/ 明理（5）-506/陈志远/2025级示例学院示例专业1班/52', 'Linux系统管理/(5-6节)1-16周/ 博学（4）-403/李明/2025级示例学院示例专业1班/52', '', ''],
  ['晚上', '第九十节', '', '', '', '', '', '', ''],
  ['实践课程：劳动教育◆周敏(共4周)/9-12周;   教育见习/专业见习◆陈志远(共16周)/1-16周;', '', '', '', '', '', '', '', '']
];

const merges = ['A1:C1', 'D1:G1', 'H1:I1', 'A2:B2', 'A3:A4', 'A5:A6', 'A7:A8', 'A9:I9'];

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function colName(n) { let s = ''; n++; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; } return s; }

/* 收集所有字符串进 sharedStrings，数字直接内联 */
const sst = [], sstMap = {};
function sid(v) {
  if (sstMap[v] === undefined) { sstMap[v] = sst.length; sst.push(v); }
  return sstMap[v];
}

let sheetRows = '';
rows.forEach((row, ri) => {
  let cellsXml = '';
  row.forEach((val, ci) => {
    if (val === '' || val == null) return;
    cellsXml += '<c r="' + colName(ci) + (ri + 1) + '" t="s"><v>' + sid(String(val)) + '</v></c>';
  });
  if (cellsXml) sheetRows += '<row r="' + (ri + 1) + '">' + cellsXml + '</row>';
});

const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<sheetData>' + sheetRows + '</sheetData>' +
  '<mergeCells count="' + merges.length + '">' + merges.map(m => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' +
  '</worksheet>';

const sstXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + sst.length + '" uniqueCount="' + sst.length + '">' +
  sst.map(s => '<si><t xml:space="preserve">' + esc(s) + '</t></si>').join('') + '</sst>';

const wbXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>' +
  '<sheet name="课表" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>' +
  '</sheets></workbook>';

/* ---- 打包成 zip ---- */
const files = [
  ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'],
  ['xl/workbook.xml', wbXml],
  ['xl/sharedStrings.xml', sstXml],
  ['xl/worksheets/sheet1.xml', sheetXml]
];

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

const locals = [], centrals = [];
let offset = 0;
files.forEach(([name, content]) => {
  const nameBuf = Buffer.from(name, 'utf8');
  const data = Buffer.from(content, 'utf8');
  const comp = zlib.deflateRawSync(data);
  const crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
  locals.push(lh, nameBuf, comp);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
  ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
  centrals.push(ch, nameBuf);

  offset += lh.length + nameBuf.length + comp.length;
});

const cdBuf = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);

const out = Buffer.concat([Buffer.concat(locals), cdBuf, eocd]);
fs.writeFileSync(path.join(__dirname, 'fixtures', '教务处课表.xlsx'), out);
console.log('已生成 tools/fixtures/教务处课表.xlsx  ' + out.length + 'B，共享字符串 ' + sst.length + ' 条');
