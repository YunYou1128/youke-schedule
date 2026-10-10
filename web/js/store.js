/* ============================================================
   store.js —— 数据模型、本地持久化、日期与周次计算
   ------------------------------------------------------------
   v2 数据模型（多课表）：
     {
       version: 2,
       activeId: '...',                    // 当前显示的课表
       prefs: { theme: 'auto'|'light'|'dark' },
       schedules: [
         { id, name, createdAt, updatedAt, courses: [...], settings: {...} }
       ]
     }
   每个课表**各自独立**持有 courses 与 settings（学期开始日、总周数、
   节数、时间表），因此「大三上」与「大三下」互不影响。

   v1 的旧数据（{courses, settings}）会在首次加载时自动迁移为一个课表，
   用户无感。
   ============================================================ */
(function (global) {
  'use strict';

  var KEY = 'schedule_app_v2';
  var LEGACY_KEY = 'schedule_app_v1';

  var THEMES = ['auto', 'light', 'dark'];

  /* ============================================================
     课程卡配色
     ------------------------------------------------------------
     HUES —— 没手动选色时，按课程名哈希分配的那 8 个色相。
     **顺序与取值是历史行为，不能改**：改了，所有老课表的课程颜色会一起变。

     HUE_CHOICES —— HUES + 4 个补隙色，按色相排序。
     v1.9.6 起**它已经不是 UI 色板**（色板换成了「调色盘 + 自动」两个按钮，
     用户可以选任意色）。现在它只作为测试用的「12 档代表色相」存在：
     对比度是否达标、两处夹取是否生效、12 个色值是否互不相同，都在它上面量。
     保留 12 档而不是拿全部 360 个色相跑，是为了让失败信息一眼能读。
     ============================================================ */
  var HUES = [212, 265, 342, 22, 46, 158, 190, 300];
  var HUE_CHOICES = HUES.concat([2, 78, 118, 238]).sort(function (a, b) { return a - b; });

  /* 卡片底色：**鲜艳优先**（v1.9.7 起，规则和 v1.9.5/v1.9.6 相反）。
     ------------------------------------------------------------
     旧规则是「先保证白字看得清，能不暗就不暗」：二分求「白字达标的最亮明度」，
     明度就从 28%（黄绿）到 52%（蓝紫）各算各的 —— **卡片深浅不齐**，黄绿那几张
     明显发闷，整排看上去不像一套配色。

     用户明确要求「颜色鲜艳一点，哪怕阳光下看不清楚」，所以反过来：
     **明度固定一个鲜艳值，对比度只当兜底**。
       CARD_LIGHT  0.60 —— 鲜艳明度。对着参考实现量的（实测 L 58%~74%，
                            12 档取同一个值 ⇒ 整排深浅一致）。
       CARD_CONTRAST_MIN 1.35 —— 兜底线，**不是目标**。只在某个色相于该明度下
                            连 1.35:1 都到不了时，把它往下压一点点（目前只有
                            黄绿 h=78 会被压到 59.5%）。它拦不住「不好读」，
                            只拦「完全看不见」。
     CARD_SAT 0.86 —— 同样是量出来的（薄荷绿 #46E6C2 的 S=76%、红 #F63D66 的 S=91%）。

     **代价是明说的**：白字对比度从 4.60:1 掉到 1.35:1（12 档实测 1.35~6.18，
     参考实现是 1.57~3.63）。这是用户知情的取舍，不是 bug ——
     smoke-test 里那条「≥ 4.5:1」已相应改成「≥ 兜底线」。

     算出来的值内联成 --bg（见 app.js），CSS 里不写死明度。 */
  var CARD_SAT = 0.86;
  var CARD_LIGHT = 0.60;        // 鲜艳明度：12 档色相统一取它
  var CARD_CONTRAST_MIN = 1.35; // 兜底线（不是目标）：连它都到不了才往下压

  /** 指定明度下，该色相的底色与白字的对比度（随明度单调递减） */
  function whiteContrastAt(h, l) {
    return 1.05 / (relLum(hslToRgb(h, CARD_SAT, l)) + 0.05);
  }

  /** 卡片明度：取鲜艳值；只有兜底线撑不住时才往下让一点（对比度随明度单调递减） */
  function cardLight(h) {
    var lo = 0.01, hi = 0.99;          // 纯数学边界（这两头肯定一个达标、一个不达标）
    for (var i = 0; i < 24; i++) {
      var mid = (lo + hi) / 2;
      if (whiteContrastAt(h, mid) >= CARD_CONTRAST_MIN) lo = mid; else hi = mid;
    }
    /* lo = 还能站住兜底线的最亮明度。正常情况 lo 远高于 CARD_LIGHT（蓝紫要到 83% 才碰到
       1.35），于是取鲜艳值；只有黄绿这种「同样明度下亮得多」的色相，lo 落到 59.5%，
       才用它把卡片压下来一点。 */
    return Math.min(CARD_LIGHT, lo);
  }

  /** 卡片底色（内联成 --bg）。明度**向下**取到 0.1%，取整只会更暗 ⇒ 对比度只会更高 */
  function cardBg(h) {
    var v = Math.floor(cardLight(Number(h)) * 1000) / 10;
    return 'hsl(' + h + ' ' + Math.round(CARD_SAT * 100) + '% ' + v + '%)';
  }

  /** HSL -> [r, g, b]，各分量 0~1（h 允许 0~360，s/l 为 0~1） */
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 60;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(h % 2 - 1));
    var m = l - c / 2;
    var rgb = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x]
      : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
  }

  /** WCAG 相对亮度（先把 sRGB 分量线性化，再按 0.2126 / 0.7152 / 0.0722 加权） */
  function relLum(rgb) {
    var lin = rgb.map(function (v) {
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  /** 某个色相**实际落到画面上**的底色与白字的对比度（把「够不够清楚」变成一条可断言的线） */
  function whiteContrast(h) {
    return whiteContrastAt(h, cardLight(Number(h)));
  }

  /* ---------- 色值换算（取色器与自定义颜色用，全是纯函数） ----------
     为什么不用 CSS 的 hsl()/rgb() 就完事：取色器要在「方块上那个点的坐标」
     和「#RRGGBB 色值」之间来回换算，而 CSS 只肯单向解析字符串、算不出坐标。
     所以换算必须自己做，并放在 store.js —— 这样才能直接调真函数断言，
     而不是拿正则去猜 app.js 里写了什么。
     ------------------------------------------------------------------ */

  /** 把用户输入 / 老数据里的颜色串规整成 '#RRGGBB'（大写）；认不出来返回 null */
  function normalizeHex(hex) {
    if (typeof hex !== 'string') return null;
    var s = hex.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return '#' + s.toUpperCase();
  }

  /** [r, g, b]（各 0~1）→ '#RRGGBB' */
  function rgbHex(rgb) {
    var out = '#';
    for (var i = 0; i < 3; i++) {
      var v = Math.round(Math.max(0, Math.min(1, rgb[i])) * 255);
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out.toUpperCase();
  }

  /** '#RRGGBB' → [r, g, b]（各 0~1）；认不出来返回 null */
  function hexToRgb(hex) {
    var s = normalizeHex(hex);
    if (s === null) return null;
    return [
      parseInt(s.slice(1, 3), 16) / 255,
      parseInt(s.slice(3, 5), 16) / 255,
      parseInt(s.slice(5, 7), 16) / 255
    ];
  }

  /** HSV → '#RRGGBB'（h 0~360，s/v 0~1）。取色器把「方块上的点」变成色值 */
  function hsvHex(h, s, v) {
    h = ((h % 360) + 360) % 360 / 60;
    s = Math.max(0, Math.min(1, s));
    v = Math.max(0, Math.min(1, v));
    var c = v * s;
    var x = c * (1 - Math.abs(h % 2 - 1));
    var m = v - c;
    var t = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x]
      : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    return rgbHex([t[0] + m, t[1] + m, t[2] + m]);
  }

  /** '#RRGGBB' → { h: 0~360, s: 0~1, v: 0~1 }。取色器打开时用它定位那个指示点 */
  function hexHsv(hex) {
    var rgb = hexToRgb(hex);
    if (rgb === null) return null;
    var mx = Math.max(rgb[0], rgb[1], rgb[2]);
    var mn = Math.min(rgb[0], rgb[1], rgb[2]);
    var d = mx - mn;
    var h = 0;
    if (d > 0) {
      if (mx === rgb[0]) h = 60 * (((rgb[1] - rgb[2]) / d) % 6);
      else if (mx === rgb[1]) h = 60 * ((rgb[2] - rgb[0]) / d + 2);
      else h = 60 * ((rgb[0] - rgb[1]) / d + 4);
    }
    return { h: (h + 360) % 360, s: mx === 0 ? 0 : d / mx, v: mx };
  }

  /** HSL → '#RRGGBB'（把老数据里的 hue 折算成等价色值用，见 app.js 的 courseColor） */
  function hslHex(h, s, l) { return rgbHex(hslToRgb(h, s, l)); }

  /** 某个色相在卡片上**实际长什么样**的色值 —— 取色器就从这里起步，颜色不会跳 */
  function cardHex(h) {
    h = ((Number(h) % 360) + 360) % 360;
    return rgbHex(hslToRgb(h, CARD_SAT, cardLight(h)));
  }

  /* ---------- 课程取色 ----------
     这三个函数原来长在 app.js 里。下沉到 store.js 是因为桌面小组件
     （由 store.js 算好快照交给原生）也要给课程上色：留两份实现必然漂移，
     表现就是「课表上是薄荷绿、小组件上是深蓝」。app.js 现在转发到这里。
     ------------------------------------------------------------------ */

  /** 课程名 → 色相。**算法是历史行为，逐字不能改**：改了所有自动配色一起变 */
  function hueOf(text) {
    var s = String(text == null ? '' : text);
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return HUES[h % HUES.length];
  }

  /** 这门课**手动存过**的色相，没存过返回 null（判据同 storedColor：看有没有存过，不看值真不真） */
  function storedHue(c) {
    var raw = c && c.hue;
    if (raw === null || raw === undefined || raw === '') return null;
    var h = parseFloat(raw);
    return isFinite(h) ? ((h % 360) + 360) % 360 : null;
  }

  /** 课程色相：**课程自己存的优先，没存才按课程名算** */
  function hueOfCourse(c) {
    var h = storedHue(c);
    return h === null ? hueOf(c ? c.name : '') : h;
  }

  /**
   * 课程色（'#RRGGBB'），三级回退：自定义色值 → 存过的色相 → 按课程名算。
   * 与 app.js 的 courseColor 的区别：那个在「全自动」时返回 null（表示「跟随自动」），
   * 小组件需要一个**真色值**（RemoteViews 画不了「自动」这个概念），所以这里兜到底。
   */
  function courseHex(c) {
    var col = storedColor(c);
    return col ? col : cardHex(hueOfCourse(c));
  }

  /** 任意色值的白字对比度（自定义颜色的可读性提示用它）；认不出色值返回 null */
  function hexContrast(hex) {
    var rgb = hexToRgb(hex);
    return rgb === null ? null : 1.05 / (relLum(rgb) + 0.05);
  }

  /**
   * 这门课**手动挑过**的自定义颜色（'#RRGGBB'），没挑过返回 null。
   * 判据同样是「有没有存过」而不是「值真不真」：存了但认不出来的
   * （手改坏的老数据）返回 null，回退到色相 / 课程名，
   * 而不是把一个坏字符串塞进 style（那会得到一张透明底的卡）。
   */
  function storedColor(c) {
    return c ? normalizeHex(c.color) : null;
  }

  /* ---------- 默认上课时间表（12 节） ---------- */
  function defaultTimes() {
    return [
      { start: '08:00', end: '08:45' },
      { start: '08:50', end: '09:35' },
      { start: '09:55', end: '10:40' },
      { start: '10:45', end: '11:30' },
      { start: '11:35', end: '12:20' },
      { start: '14:00', end: '14:45' },
      { start: '14:50', end: '15:35' },
      { start: '15:55', end: '16:40' },
      { start: '16:45', end: '17:30' },
      { start: '18:30', end: '19:15' },
      { start: '19:20', end: '20:05' },
      { start: '20:10', end: '20:55' }
    ];
  }

  /* ---------- 默认学期开始日：当年 9 月 1 日所在周的周一 ---------- */
  function defaultSemesterStart() {
    var now = new Date();
    var d = new Date(now.getFullYear(), 8, 1); // 9月1日
    return toMonday(d);
  }

  function defaultSettings() {
    return {
      semesterStart: fmtDate(defaultSemesterStart()),
      totalWeeks: 18,
      sections: 12,
      times: defaultTimes(),
      // 「固定上课时长」打开后，每一节只填开始时间，结束时间 = 开始 + classDuration。
      // 默认时间表恰好每节都是 45 分钟，所以默认为开、45 分钟。
      fixedDuration: true,
      classDuration: 45
    };
  }

  /* ---------- HTML 转义（全应用唯一一份，v1.9.45） ----------
     为什么放在 store.js：它是**最先加载、被所有页面脚本依赖**的那个模块
     （index.html 里第一只 `<script>`）。以前 app.js 与 picker.js 各有一份，
     而且已经漂移了 —— 一份转义 5 个字符（含单引号）、一份只转 4 个。
     转义函数一分成两份，早晚一份修了另一份没修，而它的失效方式（XSS）
     恰恰是最不该「安静地错」的那一类。这里只留一份，两边都转发过来。 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 日期工具 ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parseDate(s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s).trim());
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /** 取某日期所在周的周一（周一为一周之首） */
  function toMonday(d) {
    var x = startOfDay(d);
    var w = x.getDay();          // 0=周日 … 6=周六
    var back = w === 0 ? 6 : w - 1;
    x.setDate(x.getDate() - back);
    return x;
  }

  function addDays(d, n) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  /* ============================================================
     时间表工具
     ------------------------------------------------------------
     刻意全部写成**不碰全局状态的纯函数**（只吃参数、只返回新数组），
     这样「整体平移」「夹取」「按固定时长重算结束时间」这些容易写错的
     算术可以直接在测试里调用来验证，而不是靠正则去猜源码写了什么。

     时间一律用 'HH:MM' 字符串存，内部换算成「当天第几分钟」再算。
     ============================================================ */

  var DAY_END = 23 * 60 + 59;      // 23:59，时间表允许的下限

  /** 'HH:MM' -> 分钟数；非法返回 NaN（宁可判非法，也别猜一个值出来） */
  function timeToMin(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
    if (!m) return NaN;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return NaN;
    return h * 60 + mi;
  }

  /** 分钟数 -> 'HH:MM'，超范围夹到 00:00 ~ 23:59 */
  function minToTime(v) {
    var m = Math.max(0, Math.min(DAY_END, Math.round(v)));
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  }

  function cloneTimes(times) {
    return (times || []).map(function (t) {
      return { start: t ? t.start : '', end: t ? t.end : '' };
    });
  }

  /**
   * 每节时长（分钟）。有一节不是这个长度就返回 0（表示「不规则」）。
   * 用来给老数据推断「固定上课时长」该默认开还是关——
   * 明明是长短不一的时间表，一进去就默认勾上「固定时长」，会让人以为数据被改了。
   */
  function uniformDuration(times) {
    if (!times || !times.length) return 0;
    var d = timeToMin(times[0].end) - timeToMin(times[0].start);
    if (!(d > 0)) return 0;
    for (var i = 1; i < times.length; i++) {
      if (timeToMin(times[i].end) - timeToMin(times[i].start) !== d) return 0;
    }
    return d;
  }

  /**
   * 把整张表改成「每一节都是 duration 分钟」，**课间间隔保持原样**。
   *
   * 为什么不是「只把每节的结束时间改成 开始 + duration」：那样第 i 节一变长，
   * 就会直接压进第 i + 1 节里，做出「上一节 10:00 才下课、下一节 09:55 就上课」
   * 这种时间倒挂的表来（v1.9.3 第一次截图就是这么被发现的）。
   * 时长是用户刚刚指定的规则，所以以它为准往下排；要保留的是**休息时间**。
   * 第一节的起点不动，用户不需要重新对着钟找一遍。
   */
  function withDuration(times, duration) {
    var src = cloneTimes(times);
    var dur = duration > 0 ? duration : 45;
    var out = [];
    var prevStart = NaN;
    for (var i = 0; i < src.length; i++) {
      var s = timeToMin(src[i].start);
      var start;
      if (i === 0) {
        start = isNaN(s) ? 8 * 60 : s;                     // 第一节：起点原样
      } else {
        /* 课间间隔必须从**原表**里量（原上一节的结束 -> 本节的开始）。
           拿重排后的上一节结束去量就错了：那个结束值本身已经被新时长撑大，
           量出来的间隔会变成 0，等于悄悄把休息时间吃掉。 */
        var pe = timeToMin(src[i - 1].end);
        var gap = (isNaN(s) || isNaN(pe)) ? 10 : Math.max(0, s - pe);
        start = prevStart + dur + gap;
      }
      start = Math.max(0, Math.min(DAY_END - dur, start));
      out.push({ start: minToTime(start), end: minToTime(start + dur) });
      prevStart = start;
    }
    return out;
  }

  /**
   * 把时间表补到 n 节 / 裁到 n 节。多出来的节接在最后一节后面
   * （间隔 10 分钟），而不是抄一份默认时间表——照抄出来的第 13 节
   * 往往是「18:30」这种跟前面完全不接的时间。
   */
  function fitTimes(times, n, duration) {
    var need = Math.max(1, n || 1);
    var out = cloneTimes(times);
    var dur = duration > 0 ? duration : 45;
    while (out.length < need) {
      var last = out[out.length - 1];
      var s = last ? timeToMin(last.end) : NaN;
      var start = isNaN(s) ? 8 * 60 : Math.min(DAY_END - dur, s + 10);
      out.push({ start: minToTime(start), end: minToTime(start + dur) });
    }
    if (out.length > need) out.length = need;
    return out;
  }

  /**
   * 「固定上课时长」下改第 idx 节的开始时间：这一节改成 newStart，
   * **它之后的所有节整体平移相同位移**（课间间隔不变）。
   *
   * 两个夹取，都是为了不产出「时间倒流」的表：
   *   1. 不能早于上一节的结束（否则第 3 节跑到第 2 节里面去了）；
   *   2. 最后一节的结束不能超过 23:59。
   * 夹取后实际位移可能与用户输入不一致——所以调用方必须用返回值重绘，
   * 让用户看到真正生效的时间，而不是他敲进去的那个。
   */
  function shiftTimes(times, idx, newStart, duration) {
    var out = cloneTimes(times);
    var cur = out[idx];
    if (!cur) return out;
    var ns = timeToMin(newStart);
    if (isNaN(ns)) return out;                       // 输入非法：整表原样返回
    var dur = duration > 0 ? duration : 45;

    var os = timeToMin(cur.start);
    if (isNaN(os)) {                                 // 这一节原本没填开始时间
      cur.start = minToTime(ns);
      cur.end = minToTime(ns + dur);
      return out;
    }

    var delta = ns - os;
    if (idx > 0) {
      var prevEnd = timeToMin(out[idx - 1].end);
      if (!isNaN(prevEnd) && os + delta < prevEnd) delta = prevEnd - os;
    }
    var lastEnd = timeToMin(out[out.length - 1].end);
    if (!isNaN(lastEnd) && delta > DAY_END - lastEnd) delta = DAY_END - lastEnd;
    if (!delta) return out;                          // 被夹到不能动

    for (var i = idx; i < out.length; i++) {
      var s = timeToMin(out[i].start);
      if (isNaN(s)) continue;
      out[i].start = minToTime(s + delta);
      out[i].end = minToTime(s + delta + dur);
    }
    return out;
  }

  /** 只改一节、不联动（「固定上课时长」关闭时用） */
  function setTime(times, idx, key, value) {
    var out = cloneTimes(times);
    if (!out[idx]) return out;
    var v = timeToMin(value);
    if (isNaN(v)) return out;
    out[idx][key === 'end' ? 'end' : 'start'] = minToTime(v);
    return out;
  }

  /**
   * 删掉第 idx 节：**它后面几节整体上移，把空出来的位置补掉**。
   *
   * 位移量取「被删节 → 下一节」的起点差——也就是这一节的占位宽度（时长 + 课间），
   * 于是下一节恰好落到被删节的起点上，整张表的课间间隔**保持不变**。
   * 不能按「被删节的时长」挪：那样会把课间也一起吃掉，越删越挤。
   *
   * 删的是最后一节时后面没人要挪，直接返回；只剩一节时不允许再删（原样返回）。
   * 表本身乱序（下一节起点不晚于本节）或时间残缺时只删不挪，不硬凑。
   * 只吃参数、返回新数组，不改入参。
   */
  function removeSection(times, idx) {
    var out = cloneTimes(times);
    if (out.length <= 1 || idx < 0 || idx >= out.length) return out;
    var gone = out[idx];
    out.splice(idx, 1);
    var next = out[idx];                       // 原 idx + 1，splice 之后已经前移
    if (!next) return out;                     // 删的是最后一节
    var from = timeToMin(gone.start);
    var to = timeToMin(next.start);
    if (isNaN(from) || isNaN(to)) return out;
    var delta = to - from;
    if (!(delta > 0)) return out;
    for (var i = idx; i < out.length; i++) {
      var s = timeToMin(out[i].start);
      var e = timeToMin(out[i].end);
      if (!isNaN(s)) out[i].start = minToTime(s - delta);
      if (!isNaN(e)) out[i].end = minToTime(e - delta);
    }
    return out;
  }

  /**
   * 第 n 节（1 起）的 'HH:MM'。
   *
   * 课程存的是**节次**（c.start / c.end 是 3 / 4 这样的编号），
   * 桌面小组件要显示的是**钟点**，换算必须走时间表——而且要和课表页面
   * 用同一张表、同一种规范化（'8:00' 统一成 '08:00'），否则
   * 「课表上第 3 节 09:55、小组件上第 3 节 09:5」这种差别肉眼看得出来。
   * 表里没有这一节、或时间残缺时返回 ''（宁可这一条不显示，也别猜一个钟点）。
   */
  function sectionTime(times, n, key) {
    var t = (times || [])[(+n || 0) - 1];
    if (!t) return '';
    var v = timeToMin(key === 'end' ? t.end : t.start);
    return isNaN(v) ? '' : minToTime(v);
  }

  var WEEKDAY_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  var WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

  /** 计算某日期属于第几周（1 起）；学期开始前返回 <=0 的数值 */
  function weekOf(date, semesterStartStr) {
    var s = toMonday(parseDate(semesterStartStr) || defaultSemesterStart());
    var d = startOfDay(date);
    var diffMs = d.getTime() - s.getTime();
    var diffDays = Math.round(diffMs / 86400000);
    return Math.floor(diffDays / 7) + 1;
  }

  /** 第 n 周的周一日期 */
  function mondayOfWeek(n, semesterStartStr) {
    var s = toMonday(parseDate(semesterStartStr) || defaultSemesterStart());
    return addDays(s, (n - 1) * 7);
  }

  /** 单双周：奇数周为单周，偶数周为双周 */
  function parityText(week) {
    return week % 2 === 1 ? '单周' : '双周';
  }

  function isOddWeek(week) { return week % 2 === 1; }

  /* ---------- 周次表达式解析 ----------
     支持：1-16 / 1-16(单) / 2-16(双) / 1,3,5 / 1-8,10-16 / 单周 / 双周 / 全周
     返回：{ weeks:number[], parity:'odd'|'even'|null }
  ------------------------------------------------------------ */
  function parseWeeksExpr(text, fallbackTotal) {
    var raw = String(text == null ? '' : text).trim();

    // Excel 常把 "1-16"、"5-8" 这类周次自动转成日期文本（"1月16日"、"5月8日"），
    // 此处按 月-日 还原为周次区间
    raw = raw.replace(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, '$1-$2');

    var result = { weeks: [], parity: null };

    if (!raw) {
      // 未填写 -> 默认全学期
      var all = [];
      for (var i = 1; i <= (fallbackTotal || 18); i++) all.push(i);
      result.weeks = all;
      return result;
    }

    if (/^(单|单周|odd)$/i.test(raw)) { result.parity = 'odd'; raw = '1-' + (fallbackTotal || 18); }
    else if (/^(双|双周|even)$/i.test(raw)) { result.parity = 'even'; raw = '1-' + (fallbackTotal || 18); }
    else if (/^(全|全周|all)$/i.test(raw)) { raw = '1-' + (fallbackTotal || 18); }

    if (/(单|odd)/i.test(raw)) result.parity = 'odd';
    if (/(双|even)/i.test(raw)) result.parity = 'even';

    // 去掉中文说明，仅保留数字、逗号、横杠
    var clean = raw.replace(/[^\d,\-–—~、]/g, function (ch) {
      if ('–—~'.indexOf(ch) >= 0) return '-';
      if (ch === '、') return ',';
      return ' ';
    });

    var set = {};
    var parts = clean.split(/[,\s]+/);
    for (var p = 0; p < parts.length; p++) {
      var seg = parts[p];
      if (!seg) continue;
      var m = /^(\d+)\s*-\s*(\d+)$/.exec(seg);
      if (m) {
        var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (b < a) { var t = a; a = b; b = t; }
        for (var k = a; k <= b; k++) set[k] = 1;
      } else {
        var num = parseInt(seg, 10);
        if (!isNaN(num)) set[num] = 1;
      }
    }

    var weeks = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });

    if (result.parity === 'odd') weeks = weeks.filter(function (w) { return w % 2 === 1; });
    else if (result.parity === 'even') weeks = weeks.filter(function (w) { return w % 2 === 0; });

    result.weeks = weeks;
    return result;
  }

  /** 把周次数组格式化为紧凑文本，如 "1-16"、"1-15 单"、"1-8,10-16" */
  function formatWeeks(weeks) {
    if (!weeks || !weeks.length) return '全周';
    var arr = weeks.slice().sort(function (a, b) { return a - b; });

    var allOdd = arr.every(function (w) { return w % 2 === 1; });
    var allEven = arr.every(function (w) { return w % 2 === 0; });
    var contiguous = function (step) {
      if (arr.length < 2) return false;
      for (var i = 1; i < arr.length; i++) {
        if (arr[i] - arr[i - 1] !== step) return false;
      }
      return true;
    };

    if (contiguous(1)) return arr[0] + '-' + arr[arr.length - 1];
    if (contiguous(2)) {
      return arr[0] + '-' + arr[arr.length - 1] + (allOdd ? ' 单' : ' 双');
    }

    // 分段合并
    var segs = [], s = arr[0], prev = arr[0];
    for (var i = 1; i < arr.length; i++) {
      if (arr[i] - prev === 1) { prev = arr[i]; continue; }
      segs.push(s === prev ? '' + s : s + '-' + prev);
      s = prev = arr[i];
    }
    segs.push(s === prev ? '' + s : s + '-' + prev);
    var txt = segs.join(',');
    if (allOdd) txt += ' 单';
    else if (allEven) txt += ' 双';
    return txt;
  }

  /* ============================================================
     多课表状态
     ============================================================ */
  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function sid() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /**
   * 给缺 id 的课程补一个（v1.9.39）。
   *
   * 课表卡片打开详情靠 `data-id` → `findCourse(id)`：没有 id 的课在课表里
   * **点了没有任何反应** —— 不报错、不卡死、连 console 都是干净的，最容易被
   * 当成「App 卡了 / 触摸失灵」，而毛病其实在数据上。
   *
   * 旧版导入通道（适配脚本 / Excel / PDF / CSV 全都走 commitImport）只落库
   * `id: null` —— adapter-import.js 那句「由 Store 侧补」一直没人实现。
   * 所以载入时统一补一次：老用户不必重新导入，写盘之后就是持久的。
   */
  function ensureCourseIds(list) {
    if (!Array.isArray(list)) return list;
    list.forEach(function (c) {
      if (c && typeof c === 'object' && !c.id) c.id = uid();
    });
    return list;
  }

  var state = {
    version: 2,
    activeId: '',
    schedules: [],
    prefs: { theme: 'auto' },
    viewWeek: 1,
    _orphan: [],              // 极端情况下没有课表时的兜底容器
    _defaults: defaultSettings()
  };

  /** 当前课表对象 */
  function current() {
    for (var i = 0; i < state.schedules.length; i++) {
      if (state.schedules[i].id === state.activeId) return state.schedules[i];
    }
    return state.schedules[0] || null;
  }

  /* 让 app.js 继续用 S.courses / S.settings 读写「当前课表」 */
  Object.defineProperty(state, 'courses', {
    get: function () { var s = current(); return s ? s.courses : state._orphan; },
    set: function (v) {
      var s = current();
      if (s) { s.courses = v; s.updatedAt = Date.now(); }
      else { state._orphan = v; }
    },
    enumerable: false, configurable: true
  });

  Object.defineProperty(state, 'settings', {
    get: function () { var s = current(); return s ? s.settings : state._defaults; },
    set: function (v) { var s = current(); if (s) { s.settings = v; s.updatedAt = Date.now(); } },
    enumerable: false, configurable: true
  });

  /* ---------- 课表对象构造 / 规整 ---------- */
  function newSchedule(name) {
    return {
      id: sid(),
      name: name || '我的课表',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      courses: [],
      settings: defaultSettings()
    };
  }

  /** 把外部数据规整为合法课表对象，避免脏数据导致渲染异常 */
  function normalizeSchedule(raw) {
    var ds = defaultSettings();
    var s = newSchedule();
    if (raw && typeof raw === 'object') {
      s.id = raw.id || sid();
      s.name = String(raw.name || '').trim().slice(0, 24) || '未命名课表';
      s.createdAt = +raw.createdAt || Date.now();
      s.updatedAt = +raw.updatedAt || s.createdAt;
      s.courses = ensureCourseIds(Array.isArray(raw.courses) ? raw.courses.filter(function (c) {
        return c && typeof c === 'object' && c.name;
      }) : []);
      var st = raw.settings || {};
      s.settings = readSettings(st, ds);
    }
    return s;
  }

  /**
   * 规整一份 settings（多课表载入与 v1 迁移共用，免得两处各写一份再各自漂移）。
   *
   * fixedDuration / classDuration 是 v1.9.3 随「编辑时间表」新增的字段。
   * 老数据里没有它们，所以按**现有时间表本身**推断，而不是硬套默认值：
   * 每节都是 45 分钟的老数据 → 开关默认开、时长 45；
   * 长短不一的老数据 → 默认关——否则用户一进编辑页，勾着「固定时长」
   * 去动某一节，后面几节全被改成 45 分钟，等于替他改了数据。
   */
  function readSettings(st, ds) {
    st = st || {};
    var times = (Array.isArray(st.times) && st.times.length)
      ? cloneTimes(st.times)
      : cloneTimes(ds.times);
    var uni = uniformDuration(times);
    return {
      semesterStart: st.semesterStart || ds.semesterStart,
      totalWeeks: +st.totalWeeks || ds.totalWeeks,
      sections: +st.sections || ds.sections,
      times: times,
      fixedDuration: st.fixedDuration === undefined ? uni > 0 : !!st.fixedDuration,
      classDuration: +st.classDuration || uni || ds.classDuration
    };
  }

  /** 让时间表长度与「每天节数」一致（补出来的节接在最后一节后面）
   *
   * 返回值把「这一趟砍掉了多少条」带出去，**不能只做不说**：
   * 调小「每天节数」时 fitTimes 是直接从尾部 `out.length = need` 截掉的，
   * 而那份时间表是用户一行行手填的（最多 16 行）——砍掉既没提示也找不回来。
   * 调用方（设置页的保存）拿到 truncated > 0 要先问一句再动手。 */
  function syncTimesLength() {
    var s = current();
    var st = s ? s.settings : state._defaults;
    if (!st) return { truncated: 0, had: 0, need: 0 };
    var had = (st.times || []).length;
    var need = Math.max(1, st.sections || 1);
    st.times = fitTimes(st.times, st.sections, st.classDuration);
    return { truncated: Math.max(0, had - need), had: had, need: need };
  }

  /* ---------- 载入 / 保存 ---------- */
  function readV2(data) {
    /* 先滤掉非对象。normalizeSchedule 对 `null` / 字符串 / 数字一视同仁地
       `newSchedule()`，于是**数组里混进一个 null 就凭空多出一张空课表** ——
       用户会莫名其妙看到「新课程表」（手改过 localStorage、旧版本残留、
       扩展插件写坏过一次，都会留下这种脏数据）。 */
    state.schedules = data.schedules.filter(function (x) {
      return x && typeof x === 'object';
    }).map(normalizeSchedule);
    if (!state.schedules.length) state.schedules = [newSchedule('我的课表')];
    var has = state.schedules.some(function (s) { return s.id === data.activeId; });
    state.activeId = has ? data.activeId : state.schedules[0].id;
    if (data.prefs) state.prefs = { theme: normalizeTheme(data.prefs.theme) };
  }

  /** v1（单课表）-> v2（多课表）：老数据自动成为一个课表 */
  function readLegacy(data) {
    var s = newSchedule('我的课表');
    if (data && typeof data === 'object') {
      if (Array.isArray(data.courses)) s.courses = ensureCourseIds(data.courses.filter(function (c) {
        return c && typeof c === 'object' && c.name;
      }));
      s.settings = readSettings(data.settings, defaultSettings());
    }
    state.schedules = [s];
    state.activeId = s.id;
    state.prefs = { theme: 'auto' };
  }

  function load() {
    var data = null;
    try {
      var raw = global.localStorage.getItem(KEY);
      if (raw) data = JSON.parse(raw);
    } catch (e) { data = null; }

    if (data && data.version === 2 && Array.isArray(data.schedules) && data.schedules.length) {
      readV2(data);
    } else {
      // 兼容 v1 单课表数据（含更早的版本）
      var legacy = null;
      try {
        var raw1 = global.localStorage.getItem(LEGACY_KEY);
        if (raw1) legacy = JSON.parse(raw1);
      } catch (e2) { legacy = null; }
      readLegacy(legacy);
      save();                        // 迁移结果立刻落盘
    }

    if (!state.schedules.length) {
      state.schedules = [newSchedule('我的课表')];
      state.activeId = state.schedules[0].id;
    }
    syncTimesLength();
    return state;
  }

  /**
   * 落盘与「全量备份」**共用**的一份序列化。
   * 分两处各写一遍必然漂移：将来给课表加一个字段，只改了 save() 那一份，
   * 导出的备份就悄悄少了它 —— 而备份是「换机」唯一的依赖。
   */
  function serializeState() {
    return {
      version: 2,
      activeId: state.activeId,
      prefs: state.prefs,
      schedules: state.schedules.map(function (x) {
        return {
          id: x.id, name: x.name,
          createdAt: x.createdAt, updatedAt: x.updatedAt,
          courses: x.courses, settings: x.settings
        };
      })
    };
  }

  function save() {
    var s = current();
    if (s) s.updatedAt = Date.now();
    var ok = true;
    try {
      global.localStorage.setItem(KEY, JSON.stringify(serializeState()));
    } catch (e) {
      /* 隐私模式 / 存储写满 / 配额超限。**不能装作没事**：
         此刻内存里已经是新数据（页面看着「改好了」），但重启后会全部回到改动前。
         返回 false 并让失败钩子响一次，由页面把「没写进去」说出来。 */
      ok = false;
    }
    // 写盘完成后再通知（失败也通知：桌面至少要和内存里的状态一致）
    _lastSaveOk = ok;
    fireSaved();
    if (!ok) fireSaveError();
    return ok;
  }

  /* ============================================================
     全量备份 / 恢复（v1.9.45）
     ------------------------------------------------------------
     为什么需要它：CSV 只能带走**课程**。「每天节数 / 每节起止时间 / 学期第一周的
     周一 / 总周数」全在 settings 里，换手机后那几项会退回默认值 —— 用户看到的
     是「课都在，但时间全错」。导出 / 导入整份 state 才是真正搬得走的那条路。
     （另一条路是系统的云备份，那条能不能生效见 README 的备份口径说明。）

     为什么恢复要「先校验、再落地」：用户很可能把「课程 CSV」或别的 JSON 选进来。
     形状不对就当场拒绝，比「静默把课表清空」安全得多。
     ============================================================ */

  var BACKUP_KIND = 'youke-backup';

  /** 全量备份的 JSON 文本（给「导出全部数据」用） */
  function exportAll() {
    return JSON.stringify({
      kind: BACKUP_KIND,
      version: 2,
      app: '柚课',
      exportedAt: new Date().toISOString(),
      state: serializeState()
    }, null, 2);
  }

  /**
   * 校验一份备份文本。返回 { error } 或 { data }。
   *
   * **只认自己写的那个 `kind`** —— 这是「选错文件」与「文件被改坏」这两类
   * 事故唯一的拦截点（accept=".json" 拦不住用户在文件管理器里挑错东西）。
   */
  function parseBackup(text) {
    var o = null;
    try { o = JSON.parse(String(text == null ? '' : text)); } catch (e) { o = null; }
    if (!o || typeof o !== 'object') return { error: '这不是一个合法的 JSON 文件' };
    if (o.kind !== BACKUP_KIND) return { error: '这不是柚课的备份文件（缺少标记）' };
    var st = o.state;
    if (!st || typeof st !== 'object') return { error: '备份文件里没有数据' };
    if (!(st.schedules instanceof Array) || !st.schedules.length) {
      return { error: '备份文件里一张课表都没有' };
    }
    var usable = st.schedules.filter(function (s) {
      return s && typeof s === 'object' && (s.courses instanceof Array);
    });
    if (!usable.length) return { error: '备份文件里的课表都不是本应用能认的形状' };
    return { data: st };
  }

  /**
   * 恢复：整份替换当前数据。返回 { error } 或 { count }（恢复出的课表张数）。
   * 复用**载入路径**的规范化（readV2 / normalizeSchedule）—— 备份里那些字段
   * 该补的补、该过滤的过滤，与「正常开机读 localStorage」走的是同一段代码。
   */
  function importAll(text) {
    var p = parseBackup(text);
    if (p.error) return { error: p.error };
    readV2({ schedules: p.data.schedules, activeId: p.data.activeId, prefs: p.data.prefs });
    if (!state.schedules.length) {
      state.schedules = [newSchedule('我的课表')];
      state.activeId = state.schedules[0].id;
    }
    syncTimesLength();
    save();
    return { count: state.schedules.length };
  }

  /* ============================================================
     课表管理操作
     ============================================================ */
  function list() { return state.schedules; }

  function get(id) {
    for (var i = 0; i < state.schedules.length; i++) {
      if (state.schedules[i].id === id) return state.schedules[i];
    }
    return null;
  }

  /** 自动命名：绕过已存在的名字，避免出现两个「课表 2」 */
  function nextName() {
    var used = {};
    state.schedules.forEach(function (s) { used[s.name] = 1; });
    if (!state.schedules.length) return '我的课表';
    for (var i = 2; i < 200; i++) {
      var n = '课表 ' + i;
      if (!used[n]) return n;
    }
    return '新课程表';
  }

  function create(name) {
    var s = newSchedule(name || nextName());
    state.schedules.push(s);
    state.activeId = s.id;
    save();
    return s;
  }

  function setActive(id) {
    if (!get(id)) return false;
    if (state.activeId === id) return true;
    state.activeId = id;
    syncTimesLength();
    save();
    return true;
  }

  function rename(id, name) {
    var s = get(id);
    if (!s) return false;
    var n = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
    if (!n) return false;
    s.name = n.slice(0, 24);
    s.updatedAt = Date.now();
    save();
    return true;
  }

  function duplicate(id) {
    var s = get(id);
    if (!s) return null;
    var copy = normalizeSchedule(JSON.parse(JSON.stringify({
      name: s.name, courses: s.courses, settings: s.settings
    })));
    var used = {};
    state.schedules.forEach(function (x) { used[x.name] = 1; });
    var base = s.name + ' 副本';
    var name = base, k = 2;
    while (used[name]) { name = base + ' ' + k; k++; }
    copy.name = name;
    copy.courses.forEach(function (c) { c.id = uid(); });
    state.schedules.push(copy);
    save();
    return copy;
  }

  function remove(id) {
    if (state.schedules.length <= 1) return false;   // 至少保留一个课表
    var idx = -1;
    for (var i = 0; i < state.schedules.length; i++) {
      if (state.schedules[i].id === id) { idx = i; break; }
    }
    if (idx < 0) return false;
    state.schedules.splice(idx, 1);
    if (state.activeId === id) {
      var next = state.schedules[Math.min(idx, state.schedules.length - 1)];
      state.activeId = next.id;
    }
    state.viewWeek = 1;
    syncTimesLength();
    save();
    return true;
  }

  /* ============================================================
     主题偏好（全局，不随课表切换）
     ============================================================ */
  function normalizeTheme(t) {
    t = String(t == null ? '' : t).toLowerCase();
    return THEMES.indexOf(t) >= 0 ? t : 'auto';
  }

  function theme() { return normalizeTheme(state.prefs && state.prefs.theme); }

  function setTheme(t) {
    state.prefs = state.prefs || {};
    state.prefs.theme = normalizeTheme(t);
    save();
    return state.prefs.theme;
  }

  /** 把 'auto' 解析为实际生效的 'light' / 'dark' */
  function effectiveTheme() {
    var t = theme();
    if (t === 'light' || t === 'dark') return t;
    try {
      if (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (e) { /* 忽略 */ }
    return 'light';
  }

  /* ============================================================
     桌面小组件数据快照
     ------------------------------------------------------------
     小组件不是网页：它读不到 localStorage，也不可能临时跑一遍 store.js。
     所以由页面把「从今天起 ahead 天，每天上什么课」整段算好交给原生。
     周次、单双周、节次→钟点、课程配色这些规则在 store.js 里都已经是纯函数，
     原生重写一遍必然与这里漂移（表现就是「课表上是第 3 节、小组件显示第 2 节」）。
     原生只做一件事：按日期取出那天的数组。

     为什么按「日期」而不是按「星期几」下发：单双周会让同一个星期几
     在不同周上是不同的课，按星期几下发就必然错。
     ============================================================ */

  /** 快照覆盖的天数（8 周）。超出的日子原生提示「打开柚课更新」。 */
  var WIDGET_DAYS = 56;

  /**
   * 某一天的课，按当天第几分钟排好序。
   * 已把节次换算成 'HH:MM'、把课程配色折算成真色值，原生直接用。
   */
  function dayCourses(date, sched) {
    var s = sched || current();
    if (!s) return [];
    var st = s.settings || defaultSettings();
    var dow = startOfDay(date).getDay();          // 0=周日
    var day = dow === 0 ? 7 : dow;                // 课程里 1=周一 … 7=周日
    var wk = weekOf(date, st.semesterStart);
    if (!(wk >= 1) || wk > (+st.totalWeeks || 18)) return [];   // 学期开始前 / 结束后

    var out = [];
    (s.courses || []).forEach(function (c) {
      if (!c || !c.name) return;
      if (+c.day !== day) return;
      if (!c.weeks || c.weeks.indexOf(wk) < 0) return;          // 这周没有它（含单双周）
      var start = sectionTime(st.times, c.start, 'start');
      var end = sectionTime(st.times, c.end, 'end');
      if (!start || !end) return;                               // 时间表里没有这一节
      out.push({
        id: c.id || '',
        name: String(c.name),
        teacher: String(c.teacher || ''),
        loc: String(c.location || ''),
        start: start,
        end: end,
        color: courseHex(c)
      });
    });
    out.sort(function (a, b) { return timeToMin(a.start) - timeToMin(b.start); });
    return out;
  }

  /**
   * 小组件数据快照。**每一天都要有键**（没课就是空数组）：
   * 原生靠「键存在但数组为空」区分「这天没课」和「快照已经过期」，
   * 少了键就只能一律显示「打开柚课更新」，那等于没做。
   */
  function buildWidgetData(ahead) {
    var n = ahead > 0 ? ahead : WIDGET_DAYS;
    var s = current();
    var base = startOfDay(new Date());
    var days = {};
    for (var i = 0; i < n; i++) {
      var d = addDays(base, i);
      days[fmtDate(d)] = dayCourses(d, s);
    }
    return {
      v: 1,
      schedule: s ? s.name : '',
      pushedAt: Date.now(),
      start: fmtDate(base),
      days: days
    };
  }

  /* ---------- 保存钩子 ----------
     桌面小组件的快照必须在**每一次写盘之后**重推：新增 / 编辑 / 删除课程、
     切换课表、改学期设置都会经过 save()。让调用方逐个记得调推送，
     早晚会漏一处（漏了就是「改了课表，桌面还是旧的」且毫无提示）。
     ------------------------------------------------------------------ */
  var savedListeners = [];

  function onSave(fn) {
    if (typeof fn === 'function' && savedListeners.indexOf(fn) < 0) savedListeners.push(fn);
  }

  function fireSaved() {
    for (var i = 0; i < savedListeners.length; i++) {
      try { savedListeners[i](); } catch (e) { /* 钩子出错不能影响保存本身 */ }
    }
  }

  /* 写盘失败的通知。**必须和 onSave 分开**：onSave 是「内存里的状态变了」，
     这个才是「落盘没成功」——两件事，混在一起会让「保存失败」被当成正常通知吞掉。
     页面把提示挂在这里，而不是让 9 处 `Store.save()` 的调用方各写各的
     （那样迟早会出现「保存失败」和「已保存」同时弹出来）。 */
  var saveErrorListeners = [];

  /* 最近一次写盘的结果。save() 的返回值已经够用，但有些路径的写盘发生在
     Store 内部（remove / create / rename / setActive），调用方拿不到那个返回值
     ——「已删除该课表」这种成功文案只能靠它来判断该不该弹。 */
  var _lastSaveOk = true;

  function lastSaveOk() { return _lastSaveOk; }

  function onSaveError(fn) {
    if (typeof fn === 'function' && saveErrorListeners.indexOf(fn) < 0) saveErrorListeners.push(fn);
  }

  function fireSaveError() {
    for (var i = 0; i < saveErrorListeners.length; i++) {
      try { saveErrorListeners[i](); } catch (e) { /* 钩子出错不能影响别的钩子 */ }
    }
  }

  global.Store = {
    KEY: KEY,
    LEGACY_KEY: LEGACY_KEY,
    THEMES: THEMES,
    state: state,
    load: load,
    save: save,
    uid: uid,
    defaultTimes: defaultTimes,
    defaultSettings: defaultSettings,
    syncTimesLength: syncTimesLength,

    // 课程卡配色（纯函数，测试直接调）
    HUES: HUES,
    HUE_CHOICES: HUE_CHOICES,
    CARD_SAT: CARD_SAT,
    CARD_LIGHT: CARD_LIGHT,
    CARD_CONTRAST_MIN: CARD_CONTRAST_MIN,
    cardBg: cardBg,
    cardLight: cardLight,
    hslToRgb: hslToRgb,
    relLum: relLum,
    whiteContrastAt: whiteContrastAt,
    whiteContrast: whiteContrast,

    // 色值换算（取色器 / 自定义颜色，纯函数）
    normalizeHex: normalizeHex,
    rgbHex: rgbHex,
    hexToRgb: hexToRgb,
    hsvHex: hsvHex,
    hexHsv: hexHsv,
    hslHex: hslHex,
    cardHex: cardHex,
    hexContrast: hexContrast,
    storedColor: storedColor,
    hueOf: hueOf,
    storedHue: storedHue,
    hueOfCourse: hueOfCourse,
    courseHex: courseHex,

    // 时间表算术（纯函数，测试直接调）
    timeToMin: timeToMin,
    minToTime: minToTime,
    uniformDuration: uniformDuration,
    withDuration: withDuration,
    fitTimes: fitTimes,
    shiftTimes: shiftTimes,
    setTime: setTime,
    removeSection: removeSection,
    sectionTime: sectionTime,

    // 桌面小组件（纯函数 + 保存钩子）
    WIDGET_DAYS: WIDGET_DAYS,
    dayCourses: dayCourses,
    buildWidgetData: buildWidgetData,
    onSave: onSave,
    onSaveError: onSaveError,
    lastSaveOk: lastSaveOk,

    // 多课表
    current: current,
    list: list,
    get: get,
    create: create,
    setActive: setActive,
    rename: rename,
    duplicate: duplicate,
    remove: remove,
    nextName: nextName,

    // 全量备份 / 恢复（整份 state，含所有课表与设置）
    exportAll: exportAll,
    parseBackup: parseBackup,
    importAll: importAll,

    // 主题
    theme: theme,
    setTheme: setTheme,
    effectiveTheme: effectiveTheme,
    normalizeTheme: normalizeTheme,

    // 日期 / 周次
    pad: pad,
    esc: esc,
    fmtDate: fmtDate,
    parseDate: parseDate,
    startOfDay: startOfDay,
    toMonday: toMonday,
    addDays: addDays,
    weekOf: weekOf,
    mondayOfWeek: mondayOfWeek,
    parityText: parityText,
    isOddWeek: isOddWeek,
    parseWeeksExpr: parseWeeksExpr,
    formatWeeks: formatWeeks,
    WEEKDAY_CN: WEEKDAY_CN,
    WEEKDAY_SHORT: WEEKDAY_SHORT
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.Store;

})(typeof window !== 'undefined' ? window : globalThis);
