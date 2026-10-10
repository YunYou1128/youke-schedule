/* ============================================================
   edugrab.js —— 从教务课表页 HTML 中提取课程
   ------------------------------------------------------------
   输入：教务系统课表页的整页 HTML（含 iframe 内容拼接）或已解析的节点树
   输出：{ courses, errors, notes, ... }，课程结构与 csv.js / xls.js 一致

   设计要点（为什么写成「几何 + 文本」而不是选择器硬编码）：
     · 正方教务的课表页有多个年代版本，表格 id 各不相同
       （kbgrid_table_0 / kbgrid_table / kbtable / Table1 / Table6 …）；
     · 单元格 id 的约定也不同（有的首段是星期，有的是周次），
       所以主依据是「表头行的星期 + 左侧列的节次」这种位置信息，
       单元格 id 只用来补全；
     · 表格用 rowspan/colspan 合并单元格，必须先把表格展开成网格再逐格读，
       否则跨行单元格会被重复计数。

   架构：多变体级联 + 每个变体自检（v1.8）
   ------------------------------------------------------------
   同一个页面可能有多种长得完全不同的课表，与其写一个「想覆盖所有情况」
   的巨型解析器（一改就回归），不如写成若干**互相独立的变体**，各自只赌
   一种页面结构，按顺序依次尝试：

     ① 课表网格   正方老版/新版最常见的「星期表头 + 左侧节次」大表
     ② 课程列表   正方新版「教学管理信息服务平台」的逐行列表页
     ③ 任意表格   任何含 4 个以上星期字样的表格（兜底）
     ④ 网页课程块 没有 table、课程块自带 id="星期-节次" 的 div 版

   每个变体跑完都做一次**字段体检**：每门课必须有课程名、星期 1-7、
   起始节次、结束节次，缺一个就算这个变体不可信。最后在「通过体检的变体」
   里取课程最多的那个；全部不通过时取课程最多的那个，并把每个变体的
   体检结果汇总给用户 —— 报错不再是「没识别到课程」这种无信息量的话，
   而是能看出「网格法认出了 5 天但 12 格缺节次」。
   ============================================================ */
(function (global) {
  'use strict';

  var H = global.HtmlUtil;
  var Store = global.Store;

  function uid() {
    if (Store && Store.uid) return Store.uid();
    return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ============================================================
     一、通用小工具
     ============================================================ */

  /** 归一化：去掉空白与全角空格，用于文本比较 */
  function norm(s) {
    return String(s == null ? '' : s).replace(/[\s\u00A0\u3000]+/g, '');
  }

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/\u00A0/g, ' ')
      .replace(/[\u3000]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  var CN_NUM = {
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7,
    '八': 8, '九': 9, '十': 10, '壹': 1, '贰': 2, '叁': 3, '肆': 4,
    '伍': 5, '陆': 6, '柒': 7, '捌': 8, '玖': 9, '拾': 10
  };

  function cnToNum(s) {
    if (s == null) return null;
    s = String(s).trim();
    if (/^\d{1,2}$/.test(s)) return parseInt(s, 10);
    if (s === '十' || s === '拾') return 10;
    var m = /^十([一二三四五六七八九])$/.exec(s);
    if (m) return 10 + CN_NUM[m[1]];
    m = /^([一二三四五六七八九])十([一二三四五六七八九])?$/.exec(s);
    if (m) return CN_NUM[m[1]] * 10 + (m[2] ? CN_NUM[m[2]] : 0);
    return CN_NUM[s] || null;
  }

  /* ---------------- 星期 ---------------- */
  var EN_DAY = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
  var CN_DAY = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };

  function dayOf(text) {
    if (!text) return 0;
    // 表头常见两种排法：「星期一」「星期一<br>9月7日」，也有可能被拆成两行
    var first = clean(String(text).split('\n').slice(0, 2).join(''));
    if (!first) return 0;

    var m = /(?:星期|周|礼拜)\s*([一二三四五六日天1-7])/.exec(first.replace(/\s/g, ''));
    if (m && CN_DAY[m[1]] != null) return CN_DAY[m[1]];
    if (m && /[1-7]/.test(m[1])) return parseInt(m[1], 10);

    var low = first.toLowerCase().replace(/[^a-z]/g, '');
    for (var k in EN_DAY) {
      if (low === k || low.indexOf(k) === 0) return EN_DAY[k];
    }
    return 0;
  }

  /* ---------------- 节次 ---------------- */
  var CN_SEC = '[一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾0-9]{1,3}';

  /**
   * 从一段文字里抽节次。
   * @param {string} text
   * @param {boolean} strict 严格模式：不把「1-16」这类无单位的数字区间当节次
   *                        （课程块内必须严格，否则周次"1-16"会被误读成节次）
   */
  function sectionOf(text, strict) {
    if (!text) return null;
    var t = clean(String(text).split('\n')[0]).replace(/\s/g, '');
    // 去掉括号里的时间说明，如「第一节(08:00-08:45)」
    t = t.replace(/[（(][^）)]*[）)]/g, '');
    if (!t) return null;

    var m = new RegExp('第?(' + CN_SEC + ')[-~—至](' + CN_SEC + ')节').exec(t);
    if (m) {
      var a = cnToNum(m[1]), b = cnToNum(m[2]);
      if (a && b) return { start: Math.min(a, b), end: Math.max(a, b), range: true };
    }
    m = new RegExp('第\\s*(' + CN_SEC + ')\\s*节').exec(t);
    if (m) {
      var n = cnToNum(m[1]);
      if (n) return { start: n, end: n, range: false };
    }
    m = /^(\d{1,2})[-~—](\d{1,2})节$/.exec(t);
    if (m) return { start: +m[1], end: +m[2], range: true };

    if (strict) return null;

    m = /^(\d{1,2})[-~—](\d{1,2})$/.exec(t);
    if (m) {
      var x = +m[1], y = +m[2];
      if (x >= 1 && x <= 24 && y >= 1 && y <= 24) {
        return { start: Math.min(x, y), end: Math.max(x, y), range: true };
      }
    }
    if (/^\d{1,2}$/.test(t)) {
      var k = +t;
      if (k >= 1 && k <= 24) return { start: k, end: k, range: false };
    }
    return null;
  }

  /**
   * 单元格 id 形如 "1-2" 时的解析。
   * 正方系（含列表页）的约定是「第一个数字段 = 星期」——
   * 各家 app 的实现都直接拿它当星期用，所以这里也照此解释，
   * 同时把第二个数字段当节次。三段式（周次-星期-节次）另按三段式猜。
   * 认不出的约定一律返回 null，绝不瞎猜。
   */
  function sectionFromId(id) {
    if (!id) return null;
    var parts = String(id).trim().split('-');
    if (parts.length === 3) {
      // 形如 周次-星期-节次
      var d4 = parseInt(parts[1], 10), s4 = parseInt(parts[2], 10);
      if (d4 >= 1 && d4 <= 7 && s4 >= 1 && s4 <= 24) return { day: d4, start: s4, end: s4 };
      return null;
    }
    if (parts.length !== 2) return null;
    var d = parseInt(parts[0], 10), s = parseInt(parts[1], 10);
    if (d >= 1 && d <= 7 && s >= 1 && s <= 24) return { day: d, start: s, end: s };
    return null;
  }

  /* ---------------- 一行式文本扫描 ---------------- */

  /**
   * 这段文本里有没有「时间结构信息」（星期 / 节次 / 周次之一）。
   *
   * 必须先判这个再决定要不要扫描：`scanText` 是按「像不像地点 / 像不像教师」
   * 来归类单词的，而「高等数学A」这种纯课程名恰好长得像人名，
   * 直接丢进去会被误判成教师。
   */
  function hasTimeStructure(t) {
    if (!t) return false;
    var s = String(t).replace(/\s/g, '');
    if (/节/.test(s)) return true;
    if (/(?:星期|周|礼拜)[一二三四五六日天1-7]/.test(s)) return true;
    if (/\d/.test(s) && /周/.test(s) && s.length <= 40) return true;
    return false;
  }

  /**
   * 从任意一段文本里同时抽出 星期 / 节次 / 周次 / 地点 / 教师。
   *
   * 为什么需要它：正方新版「教学管理信息服务平台」把一门课压成一行，
   *     高等数学A   星期一第1-2节{1-16周}   教三-301   张建国
   * 老版正方也有把节次、周次、地点挤在一行的写法。同业通行的做法是用正则反解
   * （例如拿 /\d+节\/[单双]*周\((.*?)\)/ 从「1-2节/1-16周(教三-301)」里
   * 反推出周次和地点），比「按行分类 + 猜」稳得多。
   *
   * @returns {{day:number, sec:object|null, weeksText:string, location:string,
   *            teacher:string, leftovers:string[], matched:boolean}}
   *          matched=false 表示这段文本里没有任何结构信息，调用方应保持原判断。
   */
  function scanText(text) {
    var out = {
      day: 0, sec: null, weeksText: '', location: '', teacher: '',
      leftovers: [], matched: false
    };
    var t = clean(String(text == null ? '' : text));
    if (!t) return out;
    // 整段里连一点时间结构都没有（例如只有课程名）就直接退出，
    // 否则「高等数学A」会恰好长得像人名而被误判成教师。
    if (!hasTimeStructure(t)) return out;
    var s = t;

    // 先把「(08:00-08:45)」这类时刻区间去掉，否则括号里的数字会干扰后面的切词
    s = s.replace(/\d{1,2}\s*:\s*\d{2}\s*[-~—至]\s*\d{1,2}\s*:\s*\d{2}/g, ' ');
    s = s.replace(/[（(]\s*[）)]/g, ' ');

    /* 星期：星期一 / 周一 / 礼拜一 / 星期1 */
    var md = /(?:星期|周|礼拜)\s*([一二三四五六日天])/.exec(s);
    if (md) out.day = CN_DAY[md[1]] || 0;
    if (!out.day) {
      md = /(?:星期|周|礼拜)\s*([1-7])/.exec(s);
      if (md) out.day = parseInt(md[1], 10) || 0;
    }

    /* 周次：优先取被括号包起来的（正方常用 {1-16周}），
       否则取「1-16周 / 3,5,7周 / 单周 / 双周」 */
    var mw = /\{\s*([^{}]{0,40}周[^{}]{0,20})\s*\}/.exec(s);
    if (!mw) mw = /[（(【\[]\s*([^）)】\]{}]{0,40}周[^）)】\]{}]{0,20})\s*[）)】\]]/.exec(s);
    if (mw) out.weeksText = clean(mw[1]);
    if (!out.weeksText) {
      // 结尾的「(双)」「（单）」必须一起吃掉：正方新版写的是
      // 「周数：2-16周(双)」，只取到「2-16周」会丢掉单双周这个关键限制。
      mw = /((?:\d{1,2}\s*[-~—]\s*\d{1,2}|\d{1,2})(?:\s*[,，、]\s*(?:\d{1,2}\s*[-~—]\s*\d{1,2}|\d{1,2}))*\s*周(?:\s*[（(]\s*[单双]\s*[）)])?)/
        .exec(s);
      if (mw) out.weeksText = clean(mw[1]);
      else if (/单周/.test(s)) out.weeksText = '单周';
      else if (/双周/.test(s)) out.weeksText = '双周';
    }
    if (mw && mw[0]) s = s.replace(mw[0], ' ');
    if (out.weeksText) s = s.replace(out.weeksText, ' ');

    /* 节次：第1-2节 / 1-2节 / 第一节 / 第1节 */
    var ms = new RegExp('第?\\s*(' + CN_SEC + ')\\s*[-~—至]\\s*(' + CN_SEC + ')\\s*节').exec(s);
    if (ms) {
      var a1 = cnToNum(ms[1]), b1 = cnToNum(ms[2]);
      if (a1 && b1) out.sec = { start: Math.min(a1, b1), end: Math.max(a1, b1), range: true };
      s = s.replace(ms[0], ' ');
    }
    if (!out.sec) {
      var ms1 = new RegExp('第\\s*(' + CN_SEC + ')\\s*节').exec(s);
      if (ms1) {
        var n1 = cnToNum(ms1[1]);
        if (n1) out.sec = { start: n1, end: n1, range: false };
        s = s.replace(ms1[0], ' ');
      }
    }
    // 去掉「星期X」本身，免得它被当成课程名的一部分
    s = s.replace(/(?:星期|周|礼拜)\s*[一二三四五六日天1-7]/g, ' ');

    /* 剩下的按空白 / 常见分隔符切词，逐个归类 */
    var parts = s.split(/[\s,，、;；|]+/);
    for (var i = 0; i < parts.length; i++) {
      var raw = clean(parts[i])
        .replace(/^[-–—/／\[\]()（）]+/, '')
        .replace(/[-–—/／\[\]()（）]+$/, '');
      if (!raw || /^\d{1,2}$/.test(raw)) continue;

      // 「教学班：Linux系统管理」这类值是班级名，长得像人名
      // （纯汉字/字母、没有数字），不专门挡一下会被当成教师
      if (/^(?:教学班|上课班级|行政班|班级|学部|学院|专业|学号|学分|学时|考核方式|考试方式)[：:]/.test(raw)) {
        out.leftovers.push(raw);
        continue;
      }

      // 剥掉「教师：」「上课地点：」「周数：」这层字段名外壳再判断。
      // 正方新版几乎都带这层壳，不剥的话「李明」不是教师、「明理（5）-401」不是地点。
      var w = stripLabel(raw);
      if (!w) continue;
      if (!out.location && looksLocation(w)) { out.location = w; continue; }
      if (!out.teacher && looksTeacher(w)) { out.teacher = w; continue; }
      // 放进 leftovers 的仍是原样（带壳）的那份，免得课程名被削掉一截
      out.leftovers.push(raw);
    }

    out.matched = !!(out.day || out.sec || out.weeksText || out.location || out.teacher);
    return out;
  }

  /* ============================================================
     二、表格网格化
     ============================================================ */

  /** 只取属于本表格的行（跳过内嵌的 table） */
  function ownRows(table) {
    var rows = [];
    (function walk(node) {
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k.nodeType !== 1) continue;
        var t = k.tagName;
        if (t === 'TR') rows.push(k);
        else if (t === 'TABLE') continue;
        else if (t === 'THEAD' || t === 'TBODY' || t === 'TFOOT' || t === 'CAPTION') walk(k);
        else walk(k);
      }
    })(table);
    return rows;
  }

  function ownCells(tr) {
    var out = [];
    var kids = tr.children || [];
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.nodeType !== 1) continue;
      if (k.tagName === 'TD' || k.tagName === 'TH') out.push(k);
    }
    return out;
  }

  function spanOf(node, name, max) {
    var v = parseInt(H.attr(node, name), 10);
    if (isNaN(v) || v < 1) return 1;
    return Math.min(v, max);
  }

  /**
   * 把表格展开成网格：grid[r][c] = {node, row, col, colSpan, rowSpan, text, header}
   * rowspan 覆盖到的位置会指向同一个 cell 对象，后面靠 cell.row === r 去重。
   */
  function buildGrid(trs) {
    var grid = [], occupied = {};
    for (var r = 0; r < trs.length; r++) {
      var cells = ownCells(trs[r]);
      var row = [];
      var c = 0;
      for (var i = 0; i < cells.length; i++) {
        while (occupied[r + ',' + c]) { row[c] = occupied[r + ',' + c]; c++; }
        var cell = cells[i];
        var cs = spanOf(cell, 'colspan', 50);
        var rs = spanOf(cell, 'rowspan', 200);
        var info = {
          node: cell,
          row: r,
          col: c,
          colSpan: cs,
          rowSpan: rs,
          header: cell.tagName === 'TH',
          text: H.innerText(cell)
        };
        for (var dr = 0; dr < rs; dr++) {
          for (var dc = 0; dc < cs; dc++) occupied[(r + dr) + ',' + (c + dc)] = info;
        }
        for (var k = 0; k < cs; k++) row[c + k] = info;
        c += cs;
      }
      while (occupied[r + ',' + c]) { row[c] = occupied[r + ',' + c]; c++; }
      grid.push(row);
    }
    return grid;
  }

  /* ============================================================
     三、单元格内的行 / 块拆分
     ============================================================ */

  /**
   * 把一个单元格拆成「行」数组（<br> 与块级元素边界换行，空行保留为 ''）。
   * 不用 innerText 是因为需要保留空行信息来切分「同一格里的两门课」。
   */
  function cellLines(node) {
    var lines = [], buf = [];
    (function walk(n) {
      var kids = n.children || [];
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k.nodeType === 3) { buf.push(k.data); continue; }
        if (k.nodeType !== 1) continue;
        var t = k.tagName;
        if (t === 'SCRIPT' || t === 'STYLE') continue;
        if (t === 'BR') { lines.push(buf.join('')); buf = []; continue; }
        if (t === 'DIV' || t === 'P' || t === 'LI') {
          walk(k);
          lines.push(buf.join(''));
          buf = [];
          continue;
        }
        walk(k);
      }
    })(node);
    lines.push(buf.join(''));
    return lines.map(function (s) {
      return s.replace(/\u00A0/g, ' ').replace(/[\u3000]/g, ' ').replace(/[ \t]+/g, ' ').trim();
    });
  }

  /** 按空行把一个单元格的行数组切成多段（同一格里的多门课） */
  function splitByBlank(lines) {
    var groups = [], cur = [];
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i]) {
        if (cur.length) { groups.push(cur); cur = []; }
      } else cur.push(lines[i]);
    }
    if (cur.length) groups.push(cur);
    return groups.length ? groups : [lines];
  }

  /* ============================================================
     四、字段识别
     ============================================================ */

  /**
   * 剥掉值前面的字段名外壳。
   *
   * 正方新版（教学管理信息服务平台）把一门课的每个字段都写成「字段名：值」：
   *     教师：李明        上课地点：明理（5）-401        周数：2-16周(双)
   * 不剥这层壳，`李明` 会因为多了一个全角冒号而通不过 looksTeacher，
   * `明理（5）-401` 同理 —— 结果是「一眼就有的信息，解析器视而不见」。
   *
   * 两条规则，刻意不合并：
   *   · 带分隔符的：`XX：值` / `XX:值` —— 短标签也认（「校区」「周数」都很短）；
   *   · 不带分隔符的：只认那些长到不可能属于课程名的字段名，
   *     免得把「时间序列分析」「体育舞蹈」这类正常课程名削掉一截。
   */
  var LABEL_SEP = /^[\u4e00-\u9fa5A-Za-z]{1,8}\s*[：:]\s*/;
  var LABEL_BARE = new RegExp('^(?:课程名称|课程名|上课时间地点|上课时间|上课地点|上课教室|' +
    '任课教师|授课教师|上课教师|教师姓名|起止周|教学班|上课班级|周次|周数|节次|' +
    '校区|学分|学时|考核方式|考试方式|备注)\\s*');

  function stripLabel(text) {
    var s = clean(text);
    var prev;
    var guard = 0;
    while (s && s !== prev && guard++ < 4) {
      prev = s;
      s = clean(s.replace(LABEL_SEP, ''));
      if (s === prev) s = clean(s.replace(LABEL_BARE, ''));
    }
    return s;
  }

  /**
   * 「字段名：值」里的字段名 -> 结构角色。
   * 只映射到我们真正要用的几项，认不出的返回 null（例如「教学班」「校区」）。
   * 「校区」故意不映射：它是学校地址，不该抢走「上课地点」的位置。
   */
  function labelRole(name) {
    var t = clean(name);
    if (/^(?:上课地点|上课教室|地点|教室|场地|实训室|实验室|机房)$/.test(t)) return 'location';
    if (/^(?:教师|老师|任课教师|授课教师|上课教师|教师姓名)$/.test(t)) return 'teacher';
    if (/^(?:周次|周数|起止周|上课周次)$/.test(t)) return 'weeksText';
    if (/^(?:节次|上课节次)$/.test(t)) return 'sec';
    if (/^(?:课程名称|课程名|科目|课名)$/.test(t)) return 'name';
    return null;
  }

  var LOC_WORDS = /(教学楼|教室|实验室|实训|机房|体育馆|操场|球场|报告厅|礼堂|会议室|中心|校区|楼|室|馆|场|厅|座|号|区|院)/;
  var TEACHER_BAD = /(楼|室|馆|场|厅|楼|中心|校区|学院|班级|班$)/;

  function looksWeeks(t) {
    if (!t) return false;
    var s = t.replace(/\s/g, '');
    if (/^(单|双|全|每周)周?$/.test(s)) return true;
    if (/(单|双)周/.test(s) && s.length <= 24) return true;
    if (/\d/.test(s) && /周/.test(s) && s.length <= 30) return true;
    return false;
  }

  function looksSection(t) {
    return !!sectionOf(t, true);
  }

  function looksLocation(t) {
    if (!t) return false;
    var s = t.replace(/\s/g, '');
    if (s.length > 24) return false;
    if (/[\/／]/.test(s)) return true;                       // 教三/301
    if (/^[A-Za-z]{1,4}\d{2,}/.test(s)) return true;          // A101 / B2-305
    if (/[\u4e00-\u9fa5]{1,6}\d{2,}/.test(s)) return true;    // 教三301 / 文A101
    // 汉字 + 横杠 + 数字：正方最常见的是「教三-301」「教一-102」
    if (/^[\u4e00-\u9fa5]{1,6}[-—－]\d{1,4}[室馆楼号]?$/.test(s)) return true;
    // 汉字 + （楼栋号） + 横杠 + 房间号：如「明理（5）-401」「明理(5)-401」
    // 正方新版把楼名和楼号拆开写，横杠前面多一层括号，上面那条会漏
    if (/^[\u4e00-\u9fa5]{1,8}(?:[（(]\s*\d{1,3}\s*[）)])?[-—－]?\d{1,4}[室馆楼号]?$/.test(s)) {
      return true;
    }
    if (LOC_WORDS.test(s)) return true;                       // 文科楼 / 体育馆
    return false;
  }

  function looksTeacher(t) {
    if (!t) return false;
    var s = t.replace(/\s/g, '');
    if (/^(老师|教师|授课教师|任课教师|教师姓名)$/.test(s)) return false;  // 只是字段名
    if (/\d/.test(s)) return false;
    if (s.length < 2 || s.length > 12) return false;
    if (!/^[\u4e00-\u9fa5·,，、A-Za-z\.]+$/.test(s)) return false;
    if (TEACHER_BAD.test(s)) return false;
    return true;
  }

  /**
   * 这块文本像不像「课程名」。
   *
   * 用途是兜底挑名字：一格里字段太多、又没有任何字段名线索时，
   * 只能靠排除法。要排掉的是「长得很像课名的表头文字」（「第一节」「周次」「序号」）
   * 和纯时间信息（「1-2」「1-16周」）—— 之前就是这里漏了，
   * 把节次列的「1-2」当成了课程名，于是每门课都因为「没有节次」被丢掉。
   *
   * 注意「像人名」不算排除理由：课表块里课程名写在最前面，
   * 「高等数学A」本身就长得像人名。顺序才是这里的强信号。
   */
  function looksCourseName(t) {
    if (!t) return false;
    var s = clean(t).replace(/\s/g, '');
    if (!s || s.length > 40) return false;
    if (NOT_A_COURSE_NAME.test(s)) return false;
    if (/^(?:星期|周|礼拜)[一二三四五六日天1-7]/.test(s)) return false;
    if (sectionOf(s, false)) return false;
    if (looksWeeks(s)) return false;
    if (looksLocation(s)) return false;
    return true;
  }

  /** 从候选文本里挑课程名：从左到右取第一个「不像时间信息」的（课程名总在最前面） */
  function pickCourseName(cands) {
    for (var i = 0; i < cands.length; i++) {
      if (looksCourseName(cands[i])) return clean(cands[i]);
    }
    return '';
  }

  /** 带 title 属性的标签 -> 字段名 */
  function roleOfTitle(title) {
    var t = String(title || '').trim();
    if (!t) return null;
    if (/备注|选课|学分|考核|类型|周学时|总学时/.test(t)) return null;
    if (/周/.test(t)) return 'weeksText';
    if (/教师|老师|授课|讲师|任课/.test(t)) return 'teacher';
    if (/地点|教室|场地|实验室/.test(t)) return 'location';
    if (/节/.test(t)) return 'secText';
    if (/时间/.test(t)) return 'timeText';
    if (/课程|科目|名称|课名/.test(t)) return 'name';
    return null;
  }

  /* ============================================================
     五、单个课程块 -> 课程
     ============================================================ */

  function parseBlock(blockNode, lines, ctx) {
    var c = {
      name: '', teacher: '', location: '', weeksText: '', secText: '',
      sec: null, day: 0, note: ''
    };
    var claimed = [];

    /* 5.1 优先读带 title 的标签（新版正方会标出每个字段是什么） */
    var titled = H.querySelectorAll(blockNode, '[title]');
    for (var i = 0; i < titled.length; i++) {
      var role = roleOfTitle(H.attr(titled[i], 'title'));
      if (!role) continue;
      var txt = clean(H.innerText(titled[i]));
      if (!txt) continue;
      if (role === 'name') { if (!c.name) c.name = txt; }
      else if (role === 'weeksText') { if (!c.weeksText) c.weeksText = txt; }
      else if (role === 'teacher') { if (!c.teacher) c.teacher = txt; }
      else if (role === 'location') { if (!c.location) c.location = txt; }
      else if (role === 'secText') { if (!c.secText) c.secText = txt; }
      else if (role === 'timeText') {
        var s = sectionOf(txt, true);
        if (s && !c.sec) c.sec = s;
        if (!c.weeksText && looksWeeks(txt)) c.weeksText = txt;
      }
      claimed.push(norm(txt));
    }

    function isClaimed(line) {
      var n = norm(line);
      if (!n) return false;
      for (var k = 0; k < claimed.length; k++) {
        var cl = claimed[k];
        if (!cl) continue;
        if (n === cl || n.indexOf(cl) >= 0 || cl.indexOf(n) >= 0) return true;
      }
      return false;
    }

    /* 5.1b 「字段名：值」写法先按字段名把值认领下来。
       正方新版的课程块几乎全这么写（教师：李明 / 上课地点：明理（5）-401 /
       周数：2-16周(双)），先认领的好处是顺序问题一次解决：
       「校区」写在「上课地点」前面也不会把地点抢走。 */
    for (var li = 0; li < lines.length; li++) {
      var ln = clean(lines[li]);
      if (!ln) continue;
      var mm = /^([\u4e00-\u9fa5A-Za-z]{1,8})\s*[：:]\s*(.+)$/.exec(ln);
      if (!mm) continue;
      var lrole = labelRole(mm[1]);
      if (!lrole) continue;
      var lval = clean(mm[2]);
      if (!lval) continue;
      if (lrole === 'name') { if (!c.name) c.name = lval; }
      else if (lrole === 'teacher') { if (!c.teacher && looksTeacher(lval)) c.teacher = lval; }
      else if (lrole === 'location') { if (!c.location && looksLocation(lval)) c.location = lval; }
      else if (lrole === 'weeksText') { if (!c.weeksText) c.weeksText = lval; }
      else if (lrole === 'sec') {
        if (!c.sec) { var sv = sectionOf(lval, false); if (sv) c.sec = sv; }
      }
      claimed.push(norm(ln));
    }

    /* 5.2 其余文本行按特征分类。
       含「星期 / 节次 / 周次」的行交给 scanText 一次抽全 ——
       正方经常把它们挤在同一行（如「星期一第1-2节{1-16周} 教三-301 张建国」），
       按行分类会漏掉后面几项，扫描能把它们都捡回来。 */
    var rest = [];
    for (var j = 0; j < lines.length; j++) {
      var line = clean(lines[j]);
      if (!line) continue;
      if (isClaimed(line)) continue;

      if (!hasTimeStructure(line)) { rest.push(line); continue; }

      var scanned = scanText(line);
      if (!scanned.matched) { rest.push(line); continue; }

      if (!c.sec && scanned.sec) c.sec = scanned.sec;
      if (!c.day && scanned.day) c.day = scanned.day;
      if (!c.weeksText && scanned.weeksText) c.weeksText = scanned.weeksText;
      if (!c.location && scanned.location) c.location = scanned.location;
      if (!c.teacher && scanned.teacher) c.teacher = scanned.teacher;
      for (var q = 0; q < scanned.leftovers.length; q++) rest.push(scanned.leftovers[q]);
    }

    /* 5.3 剩下的行：挑一行当课程名，末两行当教师 / 地点。
       挑名字用排除法（pickCourseName）而不是「无条件取第一行」——
       带壳的时间行被剥壳后可能留下「1-2」「1-16周」之类的残渣，
       盲目取第一行就会把节次当成课程名。 */
    if (!c.name && rest.length) {
      c.name = pickCourseName(rest);
      if (c.name) {
        var ni = rest.indexOf(c.name);
        if (ni >= 0) rest.splice(ni, 1);
        else rest.shift();
      } else {
        c.name = rest.shift();
      }
    }

    if (!c.location && rest.length) {
      var last = stripLabel(rest[rest.length - 1]);
      if (looksLocation(last)) { c.location = last; rest.pop(); }
    }
    if (!c.teacher && rest.length) {
      var last2 = stripLabel(rest[rest.length - 1]);
      if (looksTeacher(last2)) { c.teacher = last2; rest.pop(); }
    }
    while (rest.length) {
      var t = rest.shift();
      var tv = stripLabel(t);
      if (!c.location && looksLocation(tv)) { c.location = tv; continue; }
      if (!c.teacher && looksTeacher(tv)) { c.teacher = tv; continue; }
      // 教务课表块的行顺序基本固定：课程名 / (节次) / (周次) / 教师 / 地点，
      // 所以「剩下的最后一行」当地点是相当可靠的兜底
      if (!c.location && !rest.length) { c.location = tv || t; continue; }
      c.note = c.note ? c.note + ' ' + t : t;
    }

    c.name = clean(c.name);
    if (!c.name && c.note) { c.name = c.note; c.note = ''; }
    return c;
  }

  /** 块 -> 最终课程对象；定不出课程的返回 null */
  function toCourse(block, day, sec, totalWeeks) {
    if (!block.name) return null;
    if (!day && block.day) day = block.day;
    if (!day || !sec) return null;

    var weeksText = clean(block.weeksText);
    var wp = Store
      ? Store.parseWeeksExpr(weeksText, totalWeeks)
      : { weeks: [] };
    if (!wp.weeks.length) {
      wp = Store ? Store.parseWeeksExpr('', totalWeeks) : { weeks: [] };
      if (!weeksText) weeksText = '';
    }

    return {
      id: uid(),
      name: block.name,
      day: day,
      start: sec.start,
      end: sec.end,
      teacher: clean(block.teacher),
      location: clean(block.location),
      weeks: wp.weeks,
      weeksText: weeksText || (Store ? Store.formatWeeks(wp.weeks) : '')
    };
  }

  /* ============================================================
     六、从一张表格里抽课程
     ============================================================ */

  function extractFromTable(table, totalWeeks) {
    var result = { courses: [], notes: [], skipped: 0, tableId: H.attr(table, 'id') || '' };
    var trs = ownRows(table);
    if (trs.length < 2) return result;

    var grid = buildGrid(trs);

    /* 6.1 找表头行：命中「星期一 …」最多的那一行 */
    var headerRow = -1, colDay = {}, best = 0;
    for (var r = 0; r < grid.length; r++) {
      var hits = 0, map = {};
      var row = grid[r];
      for (var c = 0; c < row.length; c++) {
        var cell = row[c];
        if (!cell || map[c] !== undefined) continue;
        var d = dayOf(cell.text);
        if (d) { map[c] = d; hits++; }
      }
      if (hits > best) { best = hits; headerRow = r; colDay = map; }
    }
    if (best < 3) return result;                 // 认不出星期的表格不是课表
    result.notes.push('表头第 ' + (headerRow + 1) + ' 行识别到 ' + best + ' 天');

    /* 6.2 左侧列（星期列之前）-> 节次 */
    var dayCols = Object.keys(colDay).map(Number).sort(function (a, b) { return a - b; });
    var minDayCol = dayCols[0];
    var rowSec = {};
    for (var rr = headerRow + 1; rr < grid.length; rr++) {
      for (var cc = 0; cc < minDayCol; cc++) {
        var lc = grid[rr][cc];
        if (!lc) continue;
        var s = sectionOf(lc.text, false);
        if (s) { rowSec[rr] = s; break; }
      }
    }

    /* 6.3 逐格读课程 */
    var seen = {};
    for (var r2 = headerRow + 1; r2 < grid.length; r2++) {
      for (var i2 = 0; i2 < dayCols.length; i2++) {
        var col = dayCols[i2];
        var cell2 = grid[r2][col];
        if (!cell2) continue;
        if (cell2.row !== r2) continue;            // rowspan 覆盖到的行交给起始行处理
        if (cell2.row <= headerRow) continue;
        if (!cell2.text.trim()) continue;

        var colDayVal = colDay[col];
        var idSec = sectionFromId(H.attr(cell2.node, 'id'));
        var rowS = rowSec[r2] || null;

        /* 连堂推断：单元格跨了 n 行时，先看左侧节次列是不是依次递增 1 ——
           这既是最可靠的证据，也顺带确认了「每行代表一节课」这个前提。
           退一步，若单元格 id 带了起始节次，也可以按 rowspan 直接推出结束节次。 */
        var spanSec = null;
        if (rowS && !rowS.range && cell2.rowSpan > 1) {
          var st0 = rowS.start;
          if (rowS.end === st0) {
            var want = st0, okSpan = true;
            for (var q = 1; q < cell2.rowSpan; q++) {
              var nxt = rowSec[r2 + q];
              if (!nxt || nxt.start !== want + 1) { okSpan = false; break; }
              want = nxt.start;
            }
            if (okSpan) spanSec = { start: st0, end: want };
          }
        } else if (idSec && cell2.rowSpan > 1 && (!rowS || !rowS.range)) {
          spanSec = { start: idSec.start, end: idSec.start + cell2.rowSpan - 1 };
        }

        /* 节次来源的优先级：
             1) 块内文本写明「3-4节」（在 parseBlock 里，最准）
             2) 左侧节次列写明「第3-4节」——大节课表全靠它
             3) 上面的连堂推断
             4) 单元格 id 里的节次段
             5) 左侧节次列的单个节次
           注意 2 必须排在 4 前面：大节课表的单元格 id 只标「3」，
           而真正要的是左列写的「第3-4节」。 */
        var fallback = (rowS && rowS.range) ? rowS : (spanSec || idSec || rowS);

        /* 同一格里可能并排/上下排着两门课 */
        var kids = H.childElements(cell2.node).filter(function (k) {
          return k.tagName === 'DIV' && clean(H.innerText(k));
        });
        var groups;
        if (kids.length) {
          groups = kids.map(function (k) { return { node: k, lines: cellLines(k) }; });
        } else {
          var lines = cellLines(cell2.node);
          groups = splitByBlank(lines).map(function (ls) {
            return { node: cell2.node, lines: ls };
          });
        }

        for (var gi = 0; gi < groups.length; gi++) {
          var blk = parseBlock(groups[gi].node, groups[gi].lines, null);
          var sec = blk.sec || fallback;
          if (!sec) { result.skipped++; continue; }
          if (!blk.name) { result.skipped++; continue; }

          /* 星期来源：表头列 > 块内文字写明的「星期X」 > 单元格 id 首段。
             最后这条是正方系的脏约定（td.id 的第一个数字段就是星期），
             表头识别不全会用上它。 */
          var useDay = colDayVal || blk.day || (idSec ? idSec.day : 0);
          var course = toCourse(blk, useDay, sec, totalWeeks);
          if (!course) { result.skipped++; continue; }

          /* 同一门课在表格里可能出现多次（教学班不同），按内容去重 */
          var key = [course.name, course.day, course.start, course.end,
            course.teacher, course.location, course.weeksText].join('|');
          if (seen[key]) continue;
          seen[key] = 1;
          result.courses.push(course);
        }
      }
    }
    return result;
  }

  /* ============================================================
     七、变体二：列表式课表（一行一门课）
     ------------------------------------------------------------
     正方新版「教学管理信息服务平台」的课程列表 / 选课结果页长这样：

       课程名称       上课时间地点              项目名称
       高等数学A      星期一第1-2节{1-16周}     张建国
       大学英语       星期三第3-4节{1-16周}     李娜

     它没有「星期表头 + 左侧节次」的网格结构，网格法一定认不出来，
     只能按列的角色读：先由表头文字（或 aria-describedby 的
     `sycjlrtabGrid_kcmc` 这类字段后缀）建立「列号 -> 字段角色」的映射，
     再逐行抽课程。课程名 / 教师 / 地点各占一列时直接取，
     时间列里「星期一第1-2节{1-16周}」这种一行式文本交给 scanText 拆。
     ============================================================ */

  /**
   * 表头文字或单元格属性 -> 字段角色。
   * 属性里带字段名是正方新版的习惯（aria-describedby / headers / id / class），
   * 所以把它们一起拿来当线索，比只看可见文字稳。
   */
  function roleOfHeader(text, node) {
    var s = (clean(text) + ' ' +
      (H.attr(node, 'aria-describedby') || '') + ' ' +
      (H.attr(node, 'headers') || '') + ' ' +
      (H.attr(node, 'id') || '') + ' ' +
      (H.attr(node, 'class') || '')).replace(/\s/g, '');
    if (!s) return null;
    // 「课表信息」这一列把一门课的所有字段（课程名 / 周数 / 地点 / 教师）装在
    // 同一个格子里，它不是单一字段，得整格当课程块拆 —— 单独给一个角色走 parseBlock
    if (/课表信息|课程信息|上课信息|kbxx/.test(s)) return 'info';
    if (/课程名|课程名称|科目|课名|kcmc|教学班/.test(s)) return 'name';
    if (/上课时间地点|上课时间|时间地点|节次|sksjdd|sksj|skjc/.test(s)) return 'time';
    if (/上课地点|地点|教室|场地|skdd|jsmc|room/i.test(s)) return 'location';
    if (/教师|老师|任课|授课|项目名称|jsxx|xmmc|jsxm/.test(s)) return 'teacher';
    if (/周次|起止周|周数|zcbh|kkzc/.test(s)) return 'weeks';
    if (/星期|周几|xqmc/.test(s)) return 'day';
    return null;
  }

  function extractFromListTable(table, totalWeeks) {
    var result = { courses: [], notes: [], skipped: 0, tableId: H.attr(table, 'id') || '' };
    var trs = ownRows(table);
    if (trs.length < 2) return result;
    var grid = buildGrid(trs);

    /* 7.1 找表头行：命中字段角色的列最多的那一行（只在前 6 行里找） */
    var headerRow = -1, colRole = {}, best = 0;
    for (var r = 0; r < grid.length && r < 6; r++) {
      var hits = 0, map = {}, row = grid[r];
      for (var c = 0; c < row.length; c++) {
        var cell = row[c];
        if (!cell || map[c] !== undefined) continue;
        var role = roleOfHeader(cell.text, cell.node);
        if (role) { map[c] = role; hits++; }
      }
      if (hits > best) { best = hits; headerRow = r; colRole = map; }
    }
    if (best < 2) return result;
    var roles = [];
    for (var k in colRole) roles.push(colRole[k]);
    if (roles.indexOf('name') < 0 && roles.indexOf('time') < 0 &&
      roles.indexOf('info') < 0) return result;
    result.notes.push('表头第 ' + (headerRow + 1) + ' 行识别到 ' + best + ' 个字段列');

    /* 7.2 逐行读一门课 */
    var seen = {};
    for (var r2 = headerRow + 1; r2 < grid.length; r2++) {
      var row2 = grid[r2];
      if (!row2 || !row2.length) continue;

      var got = {}, gotNode = {}, cells = [], idSecRow = null;
      for (var c2 = 0; c2 < row2.length; c2++) {
        var cell2 = row2[c2];
        if (!cell2 || cell2.row !== r2) continue;   // rowspan 覆盖到的位置交给起始行
        // 正方系的脏约定：单元格 id 的第一个数字段是星期，第二个是节次。
        // 注意要在「跳过空单元格」之前取 —— 课表里大量格子是空的，
        // 而它恰恰是唯一还带着位置信息的格子。
        if (!idSecRow) {
          var idSec0 = sectionFromId(H.attr(cell2.node, 'id'));
          if (idSec0) idSecRow = idSec0;
        }
        var txt = clean(cell2.text);
        if (!txt) continue;
        cells.push(txt);
        var role2 = colRole[c2];
        if (role2 && !got[role2]) { got[role2] = txt; gotNode[role2] = cell2.node; }
      }
      if (!cells.length) continue;

      var rowText = cells.join(' ');
      /* 重复出现的表头行（有些教务在 tbody 里又贴一遍）应当跳过。
         但判据必须严：真正的课程块里同样会出现「周次」「上课地点」这些词，
         只看词就跳过会把课程整片丢掉（列表页的「课表信息」一格正是这样）。
         所以再要求「整行连一个数字都没有」—— 表头行不会带数字，课程块一定带。 */
      if (cells.length === 1 && !/\d/.test(rowText) &&
        /课程名称|上课时间|上课地点|任课教师|周次/.test(rowText)) {
        result.skipped++;
        continue;
      }

      var name = '', teacher = '', location = '', weeksText = '';
      var sec = null, day = 0;

      /* 「课表信息」这类「一格装一节课所有字段」的列：它不是单一字段，
         整格交给 parseBlock 按课程块拆最准（课程名 / 周数 / 校区 / 地点 / 教师
         一次全下来，比逐列猜位置稳）。 */
      if (got['info'] && gotNode['info']) {
        var blk0 = parseBlock(gotNode['info'], cellLines(gotNode['info']), null);
        name = blk0.name || '';
        teacher = blk0.teacher || '';
        location = blk0.location || '';
        weeksText = blk0.weeksText || '';
        sec = blk0.sec || null;
        day = blk0.day || 0;
      }

      // 单字段列：值上常带「教师：」这类外壳，先剥壳再判断
      if (!name && got['name']) name = stripLabel(got['name']);
      if (!teacher && got['teacher']) {
        var tv = stripLabel(got['teacher']);
        if (looksTeacher(tv)) teacher = tv;
      }
      if (!location && got['location']) {
        var lv = stripLabel(got['location']);
        if (looksLocation(lv)) location = lv;
      }
      if (!weeksText && got['weeks']) weeksText = stripLabel(got['weeks']);
      if (!day && got['day']) day = dayOf(got['day']);

      /* 「一格装一门课」的课程块。
         除了表头明确标出的「课表信息」列，任何列里出现多行文本的那一格都可能是
         完整课程块（正方列表页的最后一列就是这种：课程名 / 周数 / 地点 / 教师 挤在一格）。
         按整格拆出来的课程名和教师比在整行文本里瞎猜准得多 ——
         一行式文本里「形势与政策」和「周敏」同样像人名，只有「谁在前面」这个顺序
         能区分它们，而格内换行天然把这个顺序保留了。 */
      for (var bi = 0; bi < row2.length; bi++) {
        var bc = row2[bi];
        if (!bc || bc.row !== r2) continue;
        if (bc.node === gotNode['info']) continue;
        var bLines = cellLines(bc.node).map(clean).filter(Boolean);
        if (bLines.length < 2) continue;
        var blk = parseBlock(bc.node, bLines, null);
        if (!name && blk.name) name = blk.name;
        if (!teacher && blk.teacher) teacher = blk.teacher;
        if (!location && blk.location) location = blk.location;
        if (!weeksText && blk.weeksText) weeksText = blk.weeksText;
        if (!sec && blk.sec) sec = blk.sec;
        if (!day && blk.day) day = blk.day;
      }

      /* 「节次」列 / 「上课时间地点」列。
         关键：这一列经常只写「1-2」或「第1-2节」，连一个「周 / 星期」字样都没有，
         scanText 会被 hasTimeStructure 挡在门外直接返回空 ——
         所以扫完必须再用 sectionOf 按节次本身解析一次，
         否则「有节次列却定不出节次」这种最冤的失败就会一直发生。 */
      if (got['time']) {
        var tText = stripLabel(got['time']);
        var st = scanText(tText);
        if (!day && st.day) day = st.day;
        if (!sec && st.sec) sec = st.sec;
        if (!weeksText && st.weeksText) weeksText = st.weeksText;
        if (!location && st.location) location = st.location;
        if (!teacher && st.teacher) teacher = st.teacher;
        if (!sec) {
          var sOnly = sectionOf(tText, false);
          if (sOnly) sec = sOnly;
        }
        if (!day) {
          var dOnly = dayOf(tText);
          if (dOnly) day = dOnly;
        }
      }

      // 还有缺的：把整行拼起来再扫一遍（单列大文本的列表页走这条）
      if (!name || !day || !sec) {
        var sa = scanText(rowText);
        if (!day && sa.day) day = sa.day;
        if (!sec && sa.sec) sec = sa.sec;
        if (!weeksText && sa.weeksText) weeksText = sa.weeksText;
        if (!location && sa.location) location = sa.location;
        if (!teacher && sa.teacher) teacher = sa.teacher;
        if (!name) name = pickCourseName(sa.leftovers);
      }
      // 兜底：整行扫不出课程名时，在整行的单元格里挑一个「像课程名」的
      if (!name) name = pickCourseName(cells);

      // 星期最后一档来源：单元格 id 的首个数字段
      if (!day && idSecRow && idSecRow.day) day = idSecRow.day;

      /* 节次最后一档来源：整行扫描里也没有「第 N 节」写法时，
         先在单元格里找一个「孤零零的数字区间」（限制在 14 节以内，
         免得把「1-16」这种周次区间误当成节次）；
         再不行才退回单元格 id 的第二段 —— 它确实encode了节次，
         但拿不到连堂的跨度，所以放在最后。 */
      if (!sec) {
        for (var si = 0; si < cells.length; si++) {
          var sTry = sectionOf(cells[si], false);
          if (sTry && sTry.start >= 1 && sTry.end <= 14) { sec = sTry; break; }
        }
      }
      if (!sec && idSecRow && idSecRow.start >= 1) {
        sec = { start: idSecRow.start, end: idSecRow.start, range: false };
      }

      if (!name) { result.skipped++; continue; }
      // 教师 / 地点列若拿到的是「不像」的内容，别硬塞进去
      if (teacher && !looksTeacher(teacher)) teacher = '';
      if (location && !looksLocation(location)) location = '';

      var block = { name: name, teacher: teacher, location: location,
        weeksText: weeksText, sec: sec, day: day };
      var course = toCourse(block, day, sec, totalWeeks);
      if (!course) { result.skipped++; continue; }

      var key = [course.name, course.day, course.start, course.end,
        course.teacher, course.location, course.weeksText].join('|');
      if (seen[key]) continue;
      seen[key] = 1;
      result.courses.push(course);
    }

    if (result.courses.length) result.notes.push('课表是列表式（一行一门课），按列名提取');
    return result;
  }

  /* ============================================================
     七之二、变体四：兜底 —— div 版课表（没有 table，课程块自带 id="星期-节次"）
     ============================================================ */

  function extractFromDivs(doc, totalWeeks) {
    var out = { courses: [], notes: [], skipped: 0, tableId: '' };
    var blocks = H.querySelectorAll(doc,
      '.kbcontent, .kbcontent1, .kbcontent2, [id^="kbcontent"], [class*="kbcontent"]');
    if (!blocks.length) return out;

    var seen = {};
    for (var i = 0; i < blocks.length; i++) {
      var node = blocks[i];
      var txt = clean(H.innerText(node));
      if (!txt) continue;

      /* 从自身或最多 4 层祖先里找形如 1-2 的 id */
      var sec = null, n = node, hops = 0;
      while (n && hops < 5 && !sec) {
        sec = sectionFromId(H.attr(n, 'id'));
        n = n.parent; hops++;
      }
      if (!sec) continue;

      var lines = cellLines(node);
      var blk = parseBlock(node, lines, null);
      if (!blk.name) continue;
      var course = toCourse(blk, sec.day, blk.sec || sec, totalWeeks);
      if (!course) continue;

      var key = [course.name, course.day, course.start, course.end].join('|');
      if (seen[key]) continue;
      seen[key] = 1;
      out.courses.push(course);
    }
    if (out.courses.length) out.notes.push('课表是 div 布局，已按课程块的位置信息识别');
    return out;
  }

  /* ============================================================
     八、主入口：变体级联
     ============================================================ */

  /** 单个页面最多处理这么多张候选表，避免超大页面拖住主线程 */
  var MAX_TABLES = 60;

  var WEEKDAY_WORDS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日',
    '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  /** 变体一：正方各代课表网格的表格 id / class */
  var KBGRID_SELECTORS = [
    '#kbgrid_table_0',
    '[id^="kbgrid_table"]',
    'table.kbgrid_table',
    '[class*="kbgrid"]',
    '#kbtable',
    '[id^="kbtable"]',
    '#Table1',
    '#table1',
    '#Table6',
    'table[id*="Table"]',
    'table[id*="kb"]'
  ];

  /** 变体二：列表式课表（含正方新版 sycjlrtabGrid 与 .table_tb / td_ 系列） */
  var LIST_SELECTORS = [
    '#sycjlrtabGrid',
    '[id*="sycjlrtab"]',
    '[aria-describedby*="sycjlrtabGrid"]',
    'table[id*="Grid"]',
    'table[class*="table_tb"]',
    'table[class*="td_"]',
    'table[class*="list"]'
  ];

  /** 表格里至少要有这么多个字符才值得试着解析（空表格纯属浪费） */
  function tableHasContent(t) {
    var txt = H.innerText(t);
    return !!txt && txt.replace(/\s/g, '').length >= 4;
  }

  /**
   * 按选择器挑表格。
   * @param {boolean} allTables true 时把页面里**所有**表格也一并纳进候选。
   *
   * 为什么要这一步：教务表格的 id / class 各版本各学校都不一样，选择器只能是
   * 「先手」，不能是唯一入口 —— 学校一升级改了 id，选择器全军覆没，解析器就退化成
   * 「页面里没有符合这种结构的表格」。与其赌 id，不如把命中不到的所有表格也过一遍：
   * 两个提取器各带结构自检（网格法要认得出 3 个以上星期列，列表法要认得出
   * 2 个以上字段列），结构对不上的表格自然什么都不产出，不会有副作用。
   */
  function pickTables(doc, selectors, allTables) {
    var found = [], seen = [];
    function push(t) {
      if (!t || t.tagName !== 'TABLE') return;
      if (seen.indexOf(t) >= 0) return;
      if (found.length >= MAX_TABLES) return;
      if (!tableHasContent(t)) return;
      seen.push(t);
      found.push(t);
    }
    for (var i = 0; i < selectors.length; i++) {
      var list = H.querySelectorAll(doc, selectors[i]);
      for (var j = 0; j < list.length; j++) push(list[j]);
    }
    if (allTables) {
      var all = H.getElementsByTagName(doc, 'table');
      for (var k = 0; k < all.length; k++) push(all[k]);
    }
    return found;
  }

  /** 变体三：任何一张含 4 个以上星期字样的表格 */
  function pickWeekdayTables(doc) {
    var out = [], all = H.getElementsByTagName(doc, 'table');
    for (var i = 0; i < all.length; i++) {
      if (out.length >= MAX_TABLES) break;
      var txt = H.innerText(all[i]);
      var days = 0;
      for (var d = 0; d < WEEKDAY_WORDS.length; d++) {
        if (txt.indexOf(WEEKDAY_WORDS[d]) >= 0) days++;
      }
      if (days >= 4) out.push(all[i]);
    }
    return out;
  }

  /** 明显不是课程名的东西：节次、星期、字段名、纯数字 */
  var NOT_A_COURSE_NAME = new RegExp('^(?:第?[一二三四五六七八九十0-9]{1,3}节|' +
    '第[一二三四五六七八九十]{1,2}大?节|星期[一二三四五六日天]|周[一二三四五六日天]|' +
    '序号|备注|周次|起止周|周数|上课周次|' +
    '教师|老师|任课教师|授课教师|上课教师|教师姓名|' +
    '地点|教室|场地|上课地点|上课教室|实验室|实训室|机房|' +
    '时间|上课时间|上课时间地点|节次|上课节次|时段|时间段|' +
    '课表信息|课程信息|上课信息|项目名称|教学班|上课班级|校区|' +
    '学分|学时|考核方式|考试方式|课程名|课程名称|科目|\\d{1,3})$');

  /**
   * 字段体检 —— 「每个变体自检」的那道关。
   * 硬性项：每门课都要能定出课程名、星期、起止节次；
   *   另外课程名本身要「像课程名」—— 误读最常见的表现就是把
   *   「第一节」「周次」这类表头文字当成了课程名，这里把它拦住。
   * 软性项（只提示不判失败）：缺周次、缺地点 ——
   *   不少课表本来就不显示，不该因此否定整个变体。
   */
  function auditCourses(courses) {
    if (!courses || !courses.length) {
      return { ok: false, bad: 0, missed: [], soft: [], reason: '没识别到课程' };
    }
    var bad = 0, missed = {}, noWeeks = 0, noPlace = 0;
    for (var i = 0; i < courses.length; i++) {
      var c = courses[i], issues = [];
      if (!c.name) issues.push('课程名');
      if (!(c.day >= 1 && c.day <= 7)) issues.push('星期');
      if (!(c.start >= 1)) issues.push('起始节次');
      if (!(c.end >= c.start)) issues.push('结束节次');

      var nm = clean(c.name).replace(/\s/g, '');
      if (nm) {
        if (NOT_A_COURSE_NAME.test(nm)) issues.push('课程名不像课名');
        else if (/^(?:星期|周)[一二三四五六日天]|周次|节次/.test(nm)) issues.push('课程名混入了时间信息');
        else if (nm.length > 30) issues.push('课程名过长');
      }
      if (!(c.weeks && c.weeks.length)) noWeeks++;
      if (!c.location) noPlace++;

      if (issues.length) {
        bad++;
        for (var k = 0; k < issues.length; k++) missed[issues[k]] = 1;
      }
    }
    var keys = Object.keys(missed);
    var soft = [];
    if (noWeeks) soft.push(noWeeks + ' 门没有周次');
    if (noPlace) soft.push(noPlace + ' 门没有地点');
    if (!keys.length) {
      return {
        ok: true, bad: 0, missed: [], soft: soft,
        reason: courses.length + ' 门课字段齐全' + (soft.length ? '（' + soft.join('、') + '）' : '')
      };
    }
    return {
      ok: false, bad: bad, missed: keys, soft: soft,
      reason: courses.length + ' 门课里有 ' + bad + ' 门可疑（' + keys.join('、') + '）'
    };
  }

  /**
   * 变体表。顺序只代表优先级与诊断先后，
   * 最终选择看「课程数」，所以顺序不会牺牲召回。
   *
   * 前两个变体的 pick 都带 allTables=true：先吃选择器命中的表格，
   * 再把页面里剩下的表格也过一遍。这样即使某个学校的课表表格换了 id /
   * class，也还有兜底；而各自的结构自检保证不会读到别的表格。
   */
  var VARIANTS = [
    {
      key: 'kbgrid', label: '课表网格（星期表头 + 左侧节次）',
      unit: '张表格',
      noneReason: '页面里没有能当课表网格读的表格',
      pick: function (doc) { return pickTables(doc, KBGRID_SELECTORS, true); },
      run: function (node, ctx) { return extractFromTable(node, ctx.totalWeeks); }
    },
    {
      key: 'list', label: '课程列表（一行一门课）',
      unit: '张表格',
      noneReason: '页面里没有能当课程列表读的表格',
      pick: function (doc) { return pickTables(doc, LIST_SELECTORS, true); },
      run: function (node, ctx) { return extractFromListTable(node, ctx.totalWeeks); }
    },
    {
      key: 'table', label: '含星期表头的表格',
      unit: '张表格',
      noneReason: '页面里没有含 4 个以上星期字样的表格',
      pick: function (doc) { return pickWeekdayTables(doc); },
      run: function (node, ctx) { return extractFromTable(node, ctx.totalWeeks); }
    },
    {
      key: 'div', label: '网页课程块',
      unit: '个页面',
      noneReason: '页面里没有 .kbcontent 这类课程块',
      pick: function (doc) { return [doc]; },
      run: function (node, ctx) { return extractFromDivs(node, ctx.totalWeeks); }
    }
  ];

  /** 在候选节点里挑出课程数最多的那份结果 */
  function runVariant(variant, nodes, ctx) {
    var best = null;
    for (var i = 0; i < nodes.length; i++) {
      var r;
      try { r = variant.run(nodes[i], ctx); } catch (e) { continue; }
      if (r && r.courses && r.courses.length &&
        (!best || r.courses.length > best.courses.length)) best = r;
    }
    return best;
  }

  function diagOf(a) {
    return { key: a.key, label: a.label, count: a.count, ok: a.ok, reason: a.reason };
  }

  /**
   * @param {string|object} input  HTML 字符串，或 HtmlUtil.parse 出来的节点树
   * @param {object} settings      当前课表设置（取 totalWeeks）
   * @returns {{courses:Array, errors:Array, notes:Array, skipped:number,
   *            attempts:Array, format:string, source:string}}
   */
  function extract(input, settings) {
    settings = settings || {};
    var ctx = { totalWeeks: settings.totalWeeks || 18 };
    var doc = (input && input.nodeType) ? input : H.parse(String(input || ''));

    var errors = [], notes = [];

    /* 8.1 每个变体各跑一遍，跑完立刻体检 */
    var attempts = [];
    for (var v = 0; v < VARIANTS.length; v++) {
      var variant = VARIANTS[v];
      var nodes = [];
      try { nodes = variant.pick(doc) || []; } catch (e) { nodes = []; }

      var best = runVariant(variant, nodes, ctx);
      if (!best) {
        attempts.push({
          key: variant.key, label: variant.label, count: 0, ok: false,
          reason: nodes.length
            ? '找到 ' + nodes.length + ' ' + variant.unit + '，但结构对不上，没读出课程'
            : variant.noneReason
        });
        continue;
      }
      var audit = auditCourses(best.courses);
      attempts.push({
        key: variant.key, label: variant.label, count: best.courses.length,
        ok: audit.ok, reason: audit.reason,
        tableId: best.tableId || '', skipped: best.skipped || 0,
        subNotes: best.notes || [], courses: best.courses
      });
    }

    /* 8.2 只在「通过体检」的变体里比课程数；
       全都不通过时退而求其次，取课程最多的那个，并把体检结果报给用户 */
    var pool = attempts.filter(function (a) { return a.ok; });
    if (!pool.length) pool = attempts;

    var chosen = null;
    for (var p = 0; p < pool.length; p++) {
      if (!chosen || pool[p].count > chosen.count) chosen = pool[p];
    }
    if (chosen && !chosen.count) chosen = null;

    /* 8.3 一门都没读出来 —— 分场景给出「下一步该点什么」 */
    if (!chosen) {
      var pageText = H.innerText(doc);
      var hasWeekday = /星\s*期\s*[一二三四五六日天]|周\s*[一二三四五六日天]/.test(pageText);
      var hasSection = pageText.indexOf('节') >= 0;

      if (!hasWeekday) {
        errors.push('这个页面里没有课表：可能还没登录、没翻到课表页，' +
          '或者当前显示的是首页 / 其他页面。\n' +
          '请进入「信息查询 → 学生个人课表」（或「我的课表」），选好学期，' +
          '确认表格已经显示出来，再点一次下面的「导入课表」。');
      } else if (!hasSection) {
        errors.push('这个页面里有「星期 X」，但没有任何「第 N 节」的节次字样，' +
          '所以定不出课程落在第几节。\n\n' +
          '多数教务的课表默认会把上课时间 / 教室 / 教师藏起来，需要先打开：\n' +
          '① 在课表页左上角（或右上角）找到齿轮 / 设置图标；\n' +
          '② 勾选「显示上课时间」「显示教室」「显示教师」这类选项；\n' +
          '③ 等课表重新排布、完整显示出来，再点「导入课表」。\n\n' +
          '另外确认打开的是「学生个人课表」整页课表，' +
          '而不是首页上的课表缩略卡片 —— 卡片通常只写课程名。');
      } else {
        errors.push('页面里能看到课表字样，但没能从中读出课程。\n\n' +
          '可以按这个顺序试：\n' +
          '① 课表页上常有「表格 / 列表」两个视图按钮，' +
          '把两个都切一次、各点一次「导入课表」—— 两种排布走的是不同的识别路径；\n' +
          '② 回到课表页的齿轮 / 设置，勾上「显示上课时间」「显示教室」「显示教师」，' +
          '让课表重新排布后再导入；\n' +
          '③ 点教务系统自己的「输出 PDF / 导出课表」，' +
          '把文件存下来后用 App 的「选择文件」导入。');
      }

      // 失败提示最怕「只说了失败、没给下一步」。补一条能把问题交回来的路：
      // 内置教务浏览器里长按左下角「怎么用」会把当前这一页原样存进系统「下载」目录。
      errors[errors.length - 1] += '\n\n如果反复导不进去：回到内置的教务浏览器，' +
        '长按左下角「怎么用」，当前这一页会原样存到系统「下载」目录' +
        '（文件名形如「教务页面-0919-2030.html」），把那个文件发给我们，' +
        '就能照着真实页面把识别补对，不用再猜。';

      notes.push('解析尝试记录：\n' + attempts.map(function (a) {
        return '· ' + a.label + '：' + a.reason;
      }).join('\n') + '\n（把这段原样发给开发者，就能定位是哪一步没走通）');
    } else {
      /* 8.4 成功 —— 说明来源，并把「其它变体也读出了东西」这种情况提一句 */
      notes.push('识别来源：' + chosen.label +
        (chosen.tableId ? '（表格 #' + chosen.tableId + '）' : ''));
      if (chosen.subNotes && chosen.subNotes.length) notes = notes.concat(chosen.subNotes);

      var others = attempts.filter(function (a) {
        return a !== chosen && a.count > 0 && a.count < chosen.count;
      });
      if (others.length) {
        notes.push('（另外 ' + others.map(function (a) {
          return '「' + a.label + '」可读出 ' + a.count + ' 门';
        }).join('、') + '，本次采用课程更多的「' + chosen.label + '」）');
      }
    }

    return {
      courses: chosen ? chosen.courses : [],
      errors: errors,
      notes: notes,
      skipped: chosen ? (chosen.skipped || 0) : 0,
      attempts: attempts.map(diagOf),
      format: 'html',
      source: '教务系统网页'
    };
  }

  global.EduGrab = {
    extract: extract,
    dayOf: dayOf,
    sectionOf: sectionOf,
    sectionFromId: sectionFromId,
    scanText: scanText,
    auditCourses: auditCourses,
    extractFromTable: extractFromTable,
    extractFromListTable: extractFromListTable,
    extractFromDivs: extractFromDivs,
    buildGrid: buildGrid,
    cellLines: cellLines,
    variants: VARIANTS,
    _internal: {
      looksWeeks: looksWeeks,
      looksLocation: looksLocation,
      looksTeacher: looksTeacher,
      looksCourseName: looksCourseName,
      pickCourseName: pickCourseName,
      stripLabel: stripLabel,
      labelRole: labelRole,
      roleOfTitle: roleOfTitle,
      roleOfHeader: roleOfHeader,
      hasTimeStructure: hasTimeStructure,
      cnToNum: cnToNum
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.EduGrab;

})(typeof window !== 'undefined' ? window : globalThis);
