/* ============================================================
   csv.js —— 课表 CSV 解析
   列映射（A→G）：
     A 课程名称   B 星期   C 开始节数   D 结束节数
     E 老师       F 地点   G 周数
   ============================================================ */
(function (global) {
  'use strict';

  var Store = global.Store;

  /* ---------------- CSV 文本 -> 二维数组 ----------------
     返回 { rows, error }。error 有两个用途：
       · 引号没闭合 —— 文件末尾还在引号里的那种；
       · 解析本身没问题时是 null。
     为什么要报出来：一个落单的 `"` 会把**整个文件**吞成一个字段，
     最终表现是「识别到 0 门课程」。用户从这五个字里永远猜不到
     「是你文件里少了一个双引号」——所以必须把原因说出来。 */
  function parseCsvTextEx(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var quoteLine = 0;          // 进入引号时所处的行号（1 起），用于报错
    var i = 0;

    // 去掉 BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    while (i < text.length) {
      var ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }

      if (ch === '"') { inQuotes = true; quoteLine = rows.length + 1; i++; continue; }
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += ch; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    var error = null;
    if (inQuotes) {
      error = '文件格式有误：第 ' + quoteLine + ' 行的双引号未闭合' +
        '（少了一个 "），整份文件会被当成一行';
    }

    return {
      rows: rows.filter(function (r) {
        return r.some(function (c) { return String(c).trim() !== ''; });
      }),
      error: error
    };
  }

  /** 只要二维数组的旧签名（返回的行里不含错误信息） */
  function parseCsvText(text) {
    return parseCsvTextEx(text).rows;
  }

  /* ---------------- 星期解析 ---------------- */
  var DAY_MAP = {
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7,
    '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7
  };

  function parseDay(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return null;

    if (/^\d{1,2}$/.test(s)) {                // 纯数字写法
      var num = parseInt(s, 10);
      if (num === 0) return 7;                 // 0 视为周日
      if (num >= 1 && num <= 7) return num;
      if (num >= 8 && num <= 14) return num - 7; // 兼容 8=周一 的写法
      return null;
    }

    s = s.replace(/\s/g, '');
    /* 前缀（星期 / 周 / 礼拜）可以省，但**整串必须正好是一个星期写法**。
       不锚定的话，`13:00` 这种（只有列错位时才会出现）会在中间匹配到 '1'
       被判成「周一」—— 把「数据错位」悄悄变成「导入成周一」，用户看不出。
       锚定之后它会被上面那句 `day == null` 拦下来、并报出是哪一行。 */
    var m = /^(?:星期|周|礼拜)?([一二三四五六日天1-7])$/.exec(s);
    if (m && DAY_MAP[m[1]] != null) return DAY_MAP[m[1]];

    var en = s.toLowerCase();
    var enMap = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
    for (var k in enMap) {
      if (en.indexOf(k) === 0) return enMap[k];
    }
    return null;
  }

  /* ---------------- 节数解析 ---------------- */
  function parseSection(v) {
    var m = /(\d+)/.exec(String(v == null ? '' : v));
    if (!m) return null;
    var n = parseInt(m[1], 10);
    if (isNaN(n) || n < 1 || n > 24) return null;
    return n;
  }

  /* ---------------- 判断是否表头行 ---------------- */
  var HEADER_WORDS = ['课程', '名称', '课名', '科目', '星期', '节数', '老师', '教师', '地点', '教室', '周数', '周次', 'name', 'day', 'teacher', 'week'];

  function looksLikeHeader(row) {
    var joined = row.join('').toLowerCase();
    var hit = 0;
    for (var i = 0; i < HEADER_WORDS.length; i++) {
      if (joined.indexOf(HEADER_WORDS[i].toLowerCase()) >= 0) hit++;
    }
    return hit >= 2;
  }

  /* ---------------- 主入口 ---------------- */
  /**
   * @param {string} text      CSV 文本
   * @param {object} settings  当前设置（提供默认周数、最大节数）
   * @returns {{courses:Array, errors:Array, skipped:number}}
   */
  function parse(text, settings) {
    settings = settings || {};
    var totalWeeks = settings.totalWeeks || 18;
    var sections = settings.sections || 12;

    var parsedCsv = parseCsvTextEx(String(text || ''));
    var rows = parsedCsv.rows;
    var courses = [], errors = [], skipped = 0;

    /* 未闭合的引号排在最前面说：它解释了「为什么整份文件一门课都没有」 */
    if (parsedCsv.error) errors.push(parsedCsv.error);

    if (!rows.length) return { courses: courses, errors: errors.length ? errors : ['文件为空或无法解析'], skipped: 0 };

    var startIdx = 0;
    if (looksLikeHeader(rows[0])) startIdx = 1;

    for (var i = startIdx; i < rows.length; i++) {
      var r = rows[i];
      var name = (r[0] || '').trim();
      if (!name) { skipped++; continue; }

      var day = parseDay(r[1]);
      var st = parseSection(r[2]);
      var en = parseSection(r[3]);

      if (day == null) { errors.push('第 ' + (i + 1) + ' 行：星期无法识别（“' + (r[1] || '') + '”），已跳过'); skipped++; continue; }
      if (st == null) { errors.push('第 ' + (i + 1) + ' 行：开始节数无法识别（“' + (r[2] || '') + '”），已跳过'); skipped++; continue; }
      if (en == null) en = st;
      if (en < st) { var t = st; st = en; en = t; }
      if (st > sections) { errors.push('第 ' + (i + 1) + ' 行：开始节数 ' + st + ' 超过设置的 ' + sections + ' 节，已跳过'); skipped++; continue; }
      if (en > sections) en = sections;

      var weeksRaw = (r[6] || '').trim();
      var wp = Store.parseWeeksExpr(weeksRaw, totalWeeks);
      if (!wp.weeks.length) {
        errors.push('第 ' + (i + 1) + ' 行：周数无法识别（“' + weeksRaw + '”），按全学期处理');
        wp = Store.parseWeeksExpr('', totalWeeks);
      }

      courses.push({
        id: Store.uid(),
        name: name,
        day: day,
        start: st,
        end: en,
        teacher: (r[4] || '').trim(),
        location: (r[5] || '').trim(),
        weeks: wp.weeks,
        weeksText: weeksRaw || Store.formatWeeks(wp.weeks)
      });
    }

    return { courses: courses, errors: errors, skipped: skipped };
  }

  /* ---------------- 读文件（自动识别 UTF-8 / GBK） ---------------- */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();

      reader.onload = function () {
        var text = String(reader.result || '');
        // 出现替换字符 => 大概率是 GBK/GB18030 编码（Excel 导出的中文 CSV 常见）
        if (/\uFFFD/.test(text)) {
          var r2 = new FileReader();
          r2.onload = function () { resolve(String(r2.result || '')); };
          r2.onerror = function () { resolve(text); };
          r2.readAsText(file, 'GBK');
        } else {
          resolve(text);
        }
      };

      reader.onerror = function () { reject(new Error('文件读取失败')); };
      reader.readAsText(file, 'UTF-8');
    });
  }

  global.CsvUtil = {
    parseCsvText: parseCsvText,
    parseCsvTextEx: parseCsvTextEx,
    parse: parse,
    parseDay: parseDay,
    parseSection: parseSection,
    looksLikeHeader: looksLikeHeader,
    readFile: readFile
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.CsvUtil;
  }

})(typeof window !== 'undefined' ? window : globalThis);
