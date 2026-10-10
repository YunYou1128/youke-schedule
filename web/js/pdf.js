/* ============================================================
   pdf.js —— 教务系统下载的 PDF 课表解析
   ------------------------------------------------------------
   这类 PDF 是「画出来的表格」（iText 等生成）：文字用 Tm/Tj 按坐标绘制，
   单元格里的说明文字会按像素宽度折行。解析思路：
     1. 取出所有内容流（FlateDecode 用浏览器原生 DecompressionStream 解压）
     2. 提取文字片段 (x, y, 字号, 文本)，以及单元格矩形
     3. 用表头「星期一 ~ 星期日」的坐标确定星期所在轴与各列范围
     4. 同一列内按坐标排序，字号较大的一行是课程名、其后的小字是详情
     5. 详情里读出「(1-2节)2-16周(双)/场地:…/教师:…」

   课本格子里的详情形如：
     (1-2节)2-16周(双)/校区:示例校区（北区）/场地:明理（5）-401/教师:李明/…
   折行后拼接即可还原（折行按字符切分，不丢字符）。
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- 字节 → 单字节字符串（索引与字节一一对应） ---------------- */
  function bytesToLatin1(u8) {
    var s = '', CH = 8192;
    for (var i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
    }
    return s;
  }

  /**
   * zlib / raw deflate 解压。
   * PDF 里 stream 与 endstream 之间常带一个换行，解压器可能因此报
   * “Trailing junk found after the end of the compressed stream”，
   * 故依次尝试「原样 / 去掉尾部 1~3 字节」×「zlib / raw」。
   */
  function inflate(u8) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('当前环境不支持解压 PDF 内容流'));
    }
    function once(data, fmt) {
      var ds = new DecompressionStream(fmt);
      var src = new Blob([data]).stream().pipeThrough(ds);
      return new Response(src).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
    }
    var attempts = [];
    [0, 1, 2, 3].forEach(function (trim) {
      ['deflate', 'deflate-raw'].forEach(function (fmt) { attempts.push([trim, fmt]); });
    });

    var i = 0;
    function next() {
      if (i >= attempts.length) return Promise.reject(new Error('内容流解压失败'));
      var a = attempts[i++];
      var data = a[0] ? u8.subarray(0, u8.length - a[0]) : u8;
      if (!data.length) return next();
      return once(data, a[1]).catch(next);
    }
    return next();
  }

  /* ---------------- PDF 字面量 / 十六进制字符串 ---------------- */
  function decodeLiteral(raw) {
    var bytes = [];
    for (var i = 0; i < raw.length; i++) {
      var ch = raw[i];
      if (ch !== '\\') { bytes.push(raw.charCodeAt(i) & 0xFF); continue; }
      var n = raw[++i];
      if (n === 'n') bytes.push(10);
      else if (n === 'r') bytes.push(13);
      else if (n === 't') bytes.push(9);
      else if (n === 'b') bytes.push(8);
      else if (n === 'f') bytes.push(12);
      else if (n === '(') bytes.push(40);
      else if (n === ')') bytes.push(41);
      else if (n === '\\') bytes.push(92);
      else if (n >= '0' && n <= '7') {
        var oct = n, k = 0;
        while (k < 2 && raw[i + 1] >= '0' && raw[i + 1] <= '7') { oct += raw[++i]; k++; }
        bytes.push(parseInt(oct, 8) & 0xFF);
      } else if (n === '\n') { /* 行继续 */ }
      else bytes.push(n.charCodeAt(0) & 0xFF);
    }
    return bytesToString(bytes);
  }

  function decodeHex(raw) {
    var hex = raw.replace(/[^0-9a-fA-F]/g, '');
    if (hex.length % 2) hex += '0';
    var bytes = [];
    for (var i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
    return bytesToString(bytes);
  }

  /**
   * 字节 → 文本。
   * 中文 PDF 基本都用 UniGB-UCS2-H / Identity-H：每个字 2 字节、大端。
   * 奇数长度则按单字节（WinAnsi）解。
   */
  function bytesToString(bytes) {
    if (!bytes.length) return '';
    if (bytes.length % 2 === 0) {
      var s = '';
      for (var i = 0; i < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return s;
    }
    var t = '';
    for (var j = 0; j < bytes.length; j++) t += String.fromCharCode(bytes[j]);
    return t;
  }

  /* ---------------- 内容流 → 文字片段 / 矩形 ---------------- */
  function scanContentStream(txt) {
    var runs = [], rects = [];
    var lines = txt.split('\n');
    var x = 0, y = 0, size = 10, leading = 0;

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim();
      if (!line) continue;
      var m;

      if ((m = /^(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm$/.exec(line))) {
        x = +m[5]; y = +m[6];
      } else if ((m = /^(-?[\d.]+) (-?[\d.]+) (Td|TD)$/.exec(line))) {
        x += +m[1]; y += +m[2];
        if (m[3] === 'TD') leading = -(+m[2]);
      } else if (/^T\*$/.test(line)) {
        y -= leading;
      } else if ((m = /^(-?[\d.]+) TL$/.exec(line))) {
        leading = +m[1];
      } else if ((m = /^\/([A-Za-z0-9]+) ([\d.]+) Tf$/.exec(line))) {
        size = +m[2];
      } else if ((m = /^\(((?:[^()\\]|\\.)*)\)\s*Tj$/.exec(line))) {
        var t = decodeLiteral(m[1]);
        if (t) runs.push({ x: x, y: y, size: size, text: t });
      } else if ((m = /^<([0-9a-fA-F\s]*)>\s*Tj$/.exec(line))) {
        var th = decodeHex(m[1]);
        if (th) runs.push({ x: x, y: y, size: size, text: th });
      } else if (/\]\s*TJ$/.test(line)) {
        // [(...) n (...) ] TJ —— 取出其中的字符串并拼接
        var s2 = '', re2 = /\(((?:[^()\\]|\\.)*)\)|<([0-9a-fA-F\s]*)>/g, mm;
        while ((mm = re2.exec(line)) !== null) {
          s2 += mm[1] !== undefined ? decodeLiteral(mm[1]) : decodeHex(mm[2]);
        }
        if (s2) runs.push({ x: x, y: y, size: size, text: s2 });
      } else if ((m = /^(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re$/.exec(line))) {
        rects.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] });
      }
    }
    return { runs: runs, rects: rects };
  }

  /* ---------------- 页 → 页面对象 ---------------- */
  function collectPages(u8) {
    var s = bytesToLatin1(u8);
    var jobs = [], re = /stream\r?\n?/g, m;
    while ((m = re.exec(s))) {
      if (s.charAt(m.index - 1) === 'd') continue;      // 命中 "endstream" 里的 stream，跳过
      var start = m.index + m[0].length;
      var end = s.indexOf('endstream', start);
      if (end < 0) break;
      var head = s.slice(Math.max(0, m.index - 300), m.index);
      var cut = head.lastIndexOf('<<');               // 只保留最近的一个字典
      if (cut >= 0) head = head.slice(cut);
      var isFlate = /FlateDecode/.test(head);
      var raw = u8.subarray(start, end);
      jobs.push(isFlate ? inflate(raw).catch(function () { return null; }) : Promise.resolve(raw));
    }
    return Promise.all(jobs).then(function (list) {
      var pages = [];
      list.forEach(function (data) {
        if (!data || !data.length) return;
        var txt = bytesToLatin1(data);
        if (!/\bBT\b/.test(txt)) return;                           // 非内容流（字体、图像等）
        if (!/(\bTj\b|\bTJ\b)/.test(txt)) return;                  // 没有文字，跳过
        pages.push(scanContentStream(txt));
      });
      return pages;
    });
  }

  /* ============================================================
     版面 → 课程
     ============================================================ */
  var DAY_CN = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };

  function buildColumns(pages) {
    /* 1) 表头：星期一 ~ 星期日 */
    var heads = [];
    pages.forEach(function (pg) {
      pg.runs.forEach(function (r) {
        var m = /^(星期|周|礼拜)\s*([一二三四五六日天])$/.exec(r.text.trim());
        if (m) heads.push({ x: r.x, y: r.y, day: DAY_CN[m[2]] });
      });
    });
    /* 去重（同一表头可能出现在多页） */
    var uniq = {}, h2 = [];
    heads.forEach(function (h) {
      var key = h.day + '@' + Math.round(h.x) + ',' + Math.round(h.y);
      if (uniq[key]) return;
      uniq[key] = 1; h2.push(h);
    });
    heads = h2;
    if (heads.length < 3) return null;

    var xs = heads.map(function (h) { return h.x; });
    var ys = heads.map(function (h) { return h.y; });
    var spreadX = Math.max.apply(null, xs) - Math.min.apply(null, xs);
    var spreadY = Math.max.apply(null, ys) - Math.min.apply(null, ys);
    var dayAxis = spreadX >= spreadY ? 'x' : 'y';

    /* 2) 优先用单元格矩形确定列的边界（更精确） */
    var cols = null;
    var allRects = [];
    pages.forEach(function (pg) { pg.rects.forEach(function (r) { allRects.push(r); }); });
    var wide = allRects.filter(function (r) { return r.w > 30; });
    if (wide.length) {
      var hist = {};
      wide.forEach(function (r) { var k = Math.round(r.w); hist[k] = (hist[k] || 0) + 1; });
      var modal = 0, best = 0;
      Object.keys(hist).forEach(function (k) { if (hist[k] > best) { best = hist[k]; modal = +k; } });
      var cand = [];
      wide.forEach(function (r) {
        if (Math.abs(r.w - modal) <= modal * 0.25) {
          var key = dayAxis === 'x' ? Math.round(r.x * 10) / 10 : Math.round(r.y * 10) / 10;
          if (cand.indexOf(key) < 0) cand.push(key);
        }
      });
      cand.sort(function (a, b) { return a - b; });
      if (cand.length >= 5) cols = cand;
    }

    /* 3) 列 → 星期 */
    var dayOfCol = {};
    if (cols) {
      heads.forEach(function (h) {
        var at = dayAxis === 'x' ? h.x : h.y;
        for (var i = cols.length - 1; i >= 0; i--) {
          if (at >= cols[i] - 1) { dayOfCol[i] = h.day; break; }
        }
      });
    }

    /* 4) 表头所在的行/列坐标（用于剔除标题区、页眉页脚） */
    var headerCross = dayAxis === 'x' ? Math.max.apply(null, ys) : Math.max.apply(null, xs);

    /* 4) 各页表头所在坐标（宽表被拆到多页时，只有首页有表头） */
    var pageHeaderCross = pages.map(function (pg) {
      var cross = null;
      pg.runs.forEach(function (r) {
        var t = r.text.trim();
        if (!/^(星期|周|礼拜)\s*[一二三四五六日天]$/.test(t)) return;
        var c = dayAxis === 'x' ? r.y : r.x;
        if (cross === null || c > cross) cross = c;
      });
      return cross;
    });

    return {
      dayAxis: dayAxis,
      cols: cols,
      dayOfCol: dayOfCol,
      heads: heads,
      headerCross: headerCross,
      pageHeaderCross: pageHeaderCross
    };
  }

  /** 把片段按列分组，并还原成「课程名 + 详情」的块 */
  function buildBlocks(pages, layout) {
    var dayAxis = layout.dayAxis;

    function colIndexAt(v) {
      if (!layout.cols) return -1;
      for (var i = layout.cols.length - 1; i >= 0; i--) {
        if (v >= layout.cols[i] - 6) return i;
      }
      return -1;
    }
    function nearestHead(v) {
      var bestI = -1, bestD = Infinity;
      for (var i = 0; i < layout.heads.length; i++) {
        var h = layout.heads[i];
        var d = Math.abs((dayAxis === 'x' ? h.x : h.y) - v);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      return bestI;
    }

    /* 1) 先筛掉页眉/表头/标题区，把片段归到具体星期 */
    var byDay = {};
    pages.forEach(function (pg, pi) {
      pg.runs.forEach(function (r) {
        var t = r.text.trim();
        if (!t) return;
        if (/^(打印时间|制表|制表人|说明)/.test(t)) return;
        if (/^(星期|周|礼拜)\s*[一二三四五六日天]$/.test(t)) return;   // 表头自身

        var at = dayAxis === 'x' ? r.x : r.y;
        var cross = dayAxis === 'x' ? r.y : r.x;
        var hc = layout.pageHeaderCross ? layout.pageHeaderCross[pi] : layout.headerCross;
        if (hc !== null && hc !== undefined && cross >= hc - 1) return;   // 表头之上：学期/姓名/学号

        var day = null;
        if (layout.cols) {
          var ci = colIndexAt(at);
          if (ci < 0) return;                                         // 落在星期列之外（节次/时间段标签）
          day = layout.dayOfCol[ci];
        } else {
          var hi = nearestHead(at);
          if (hi >= 0) day = layout.heads[hi].day;
        }
        if (!day) return;

        (byDay[day] = byDay[day] || []).push({ run: r, page: pi });
      });
    });

    /* 2) 标题字号 = 正文中出现过的最大字号 */
    var sizes = {};
    Object.keys(byDay).forEach(function (d) {
      byDay[d].forEach(function (it) { sizes[it.run.size] = 1; });
    });
    var titleSize = Math.max.apply(null, Object.keys(sizes).map(Number));
    if (!isFinite(titleSize)) return [];

    /* 3) 同一列内按坐标分组：大字号=课程名，其后小字号=详情 */
    var blocks = [];
    Object.keys(byDay).forEach(function (dayKey) {
      var list = byDay[dayKey].slice().sort(function (a, b) {
        if (a.page !== b.page) return a.page - b.page;
        var ca = dayAxis === 'x' ? a.run.y : a.run.x;
        var cb = dayAxis === 'x' ? b.run.y : b.run.x;
        return cb - ca;                                // 从上到下
      });

      var cur = null, dayBlocks = [];
      list.forEach(function (item) {
        var r = item.run;
        if (r.size >= titleSize - 0.01) {              // 课程名
          if (cur && cur.details.length) {
            dayBlocks.push(cur);
            cur = { title: [r.text], details: [] };
          } else if (cur) {
            cur.title.push(r.text);                    // 课程名折行，继续拼接
          } else {
            cur = { title: [r.text], details: [] };
          }
        } else if (cur) {
          cur.details.push(r.text);
        } else if (dayBlocks.length) {
          dayBlocks[dayBlocks.length - 1].details.push(r.text);   // 上一页续下来的说明文字
        }
      });
      if (cur) dayBlocks.push(cur);

      dayBlocks.forEach(function (b) {
        b.day = +dayKey;
        b.name = b.title.join('').replace(/[★☆◆◇●○]+$/, '').trim();
        b.detail = b.details.join('');
        blocks.push(b);
      });
    });
    return blocks;
  }

  /** 从块详情里读节次 / 周次 / 地点 / 教师 */
  function parseBlock(b) {
    var d = b.detail || '';
    var sm = /[（(]\s*(\d+)\s*[-–—~]\s*(\d+)\s*节\s*[)）]/.exec(d);
    if (!sm) {
      var s1 = /[（(]\s*(\d+)\s*节\s*[)）]/.exec(d);
      if (!s1) return null;
      sm = [s1[0], s1[1], s1[1]];
    }
    var start = parseInt(sm[1], 10), end = parseInt(sm[2], 10);
    var rest = d.slice(d.indexOf(sm[0]) + sm[0].length);
    var weeksRaw = rest.split('/')[0].replace(/^[\s,，、;；:：]+/, '').replace(/\s+/g, '').trim();

    var loc = /场地[:：]\s*([^\/]{0,40})/.exec(d);
    var tea = /教师[:：]\s*([^\/]{0,20})/.exec(d);

    if (!b.name) return null;
    return {
      name: b.name,
      day: b.day,
      start: Math.min(start, end),
      end: Math.max(start, end),
      location: loc ? loc[1].trim() : '',
      teacher: tea ? tea[1].trim() : '',
      weeksRaw: weeksRaw
    };
  }

  /* ============================================================
     对外接口
     ============================================================ */
  /**
   * @param {ArrayBuffer|Uint8Array} buffer  PDF 字节
   * @param {object} settings                当前设置
   * @returns {Promise<{courses,errors,skipped,notes,format,source}>}
   */
  function parse(buffer, settings) {
    settings = settings || {};
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

    /* 必须是 PDF */
    if (bytesToLatin1(bytes.subarray(0, 5)) !== '%PDF-') {
      return Promise.resolve({
        courses: [], errors: ['这不是 PDF 文件。'], skipped: 0, notes: [], format: 'pdf'
      });
    }

    return collectPages(bytes).then(function (pages) {
      if (!pages.length) throw new Error('没有在 PDF 里找到可读取的文字内容（可能是扫描件/图片版课表）');

      var layout = buildColumns(pages);
      if (!layout) {
        throw new Error('没有识别到「星期一 ~ 星期日」表头，无法确定课表结构');
      }

      var blocks = buildBlocks(pages, layout);
      var courses = [], notes = [], skipped = 0;

      blocks.forEach(function (b) {
        var e = parseBlock(b);
        if (!e) {
          if (b.detail && b.detail.length > 12) skipped++;
          return;
        }
        var wp = global.Store.parseWeeksExpr(e.weeksRaw, settings.totalWeeks);
        courses.push({
          id: global.Store.uid(),
          name: e.name,
          day: e.day,
          start: e.start,
          end: e.end,
          teacher: e.teacher,
          location: e.location,
          weeks: wp.weeks,
          weeksText: e.weeksRaw || global.Store.formatWeeks(wp.weeks)
        });
      });

      /* 页眉里的姓名（「林晓东课表」） */
      var person = '';
      pages.forEach(function (pg) {
        pg.runs.forEach(function (r) {
          var m = /^(.{2,4})课表$/.exec(r.text.trim());
          if (m && !person) person = m[1];
        });
      });

      var errors = [];
      if (!courses.length) errors.push('没有从 PDF 里解析出课程，可能不是教务系统导出的课表。');

      return {
        courses: courses,
        errors: errors,
        skipped: skipped,
        notes: notes,
        format: 'pdf',
        source: '教务系统 PDF 课表' + (person ? '（' + person + '）' : '')
      };
    }).catch(function (err) {
      return {
        courses: [], errors: ['解析 PDF 失败：' + (err && err.message ? err.message : err)],
        skipped: 0, notes: [], format: 'pdf'
      };
    });
  }

  global.PdfUtil = {
    parse: parse,
    scanContentStream: scanContentStream,
    buildColumns: buildColumns,
    buildBlocks: buildBlocks,
    parseBlock: parseBlock,
    decodeLiteral: decodeLiteral,
    decodeHex: decodeHex
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.PdfUtil;

})(typeof window !== 'undefined' ? window : globalThis);
