/* ============================================================
   xls.js —— 教务处下发课表（Excel / .xls）解析
   ------------------------------------------------------------
   支持两种版面（自动判别）：
     · 行=节次、列=星期（多数教务处导出）
     · 行=星期、列=节次（转置版面）
   单元格内容形如：
     Linux系统管理/(1-2节)2-16周(双)/ 明理（5）-401/李明/2025级计科1班/52
   同一格里多门课用换行分隔，会逐条拆开。

   文件格式：OLE2 复合文档 + BIFF8（BIFF5 亦可，退化为 LABEL 记录）
   ============================================================ */
(function (global) {
  'use strict';

  var _buf = null, _dv = null;

  function u16(o) { return _dv.getUint16(o, true); }
  function u32(o) { return _dv.getUint32(o, true); }
  function f64(o) { return _dv.getFloat64(o, true); }

  function concatBytes(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total), off = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], off); off += list[i].length; }
    return out;
  }

  /* 单字节（Latin-1）→ 字符串；BIFF8 的「压缩字符串」即此编码 */
  function latin1(bytes, from, to) {
    var s = '', CH = 4096;
    for (var i = from; i < to; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, to)));
    }
    return s;
  }

  function utf16le(bytes, from, to) {
    var s = '', CH = 4096;
    for (var i = from; i < to; i += CH * 2) {
      var end = Math.min(i + CH * 2, to), arr = [];
      for (var k = i; k + 1 < end; k += 2) arr.push(bytes[k] | (bytes[k + 1] << 8));
      s += String.fromCharCode.apply(null, arr);
    }
    return s;
  }

  /* ============================================================
     OLE2 复合文档（CFB）
     ============================================================ */
  function openCFB(bytes) {
    _buf = bytes;
    _dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (u32(0) !== 0xE011CFD0) throw new Error('不是有效的 Excel(.xls) 文件');

    var SS = 1 << u16(0x1E);
    var MS = 1 << u16(0x20);
    var nFat = u32(0x2C), dirStart = u32(0x30);
    var miniCutoff = u32(0x38), miniFatStart = u32(0x3C), nMiniFat = u32(0x40);
    var difatStart = u32(0x44), nDifat = u32(0x48);
    var secOff = function (s) { return (s + 1) * SS; };
    var i, k;

    /* DIFAT → FAT 扇区号 */
    var fatSectors = [];
    for (i = 0; i < 109; i++) {
      var v = u32(0x4C + i * 4);
      if (v === 0xFFFFFFFF) break;
      fatSectors.push(v);
    }
    var ds = difatStart, guard = 0;
    while (ds !== 0xFFFFFFFE && ds !== 0xFFFFFFFF && guard++ < nDifat + 4) {
      var base = secOff(ds), cnt = SS / 4 - 1;
      for (i = 0; i < cnt; i++) {
        var val = u32(base + i * 4);
        if (val !== 0xFFFFFFFF) fatSectors.push(val);
      }
      ds = u32(base + cnt * 4);
    }

    /* FAT */
    var FAT = [];
    for (i = 0; i < Math.min(fatSectors.length, nFat); i++) {
      var fb = secOff(fatSectors[i]);
      for (k = 0; k < SS / 4; k++) FAT.push(u32(fb + k * 4));
    }

    function readChain(start, table, unit, offFn) {
      var chunks = [], s = start, n = 0;
      while (s !== 0xFFFFFFFE && s !== 0xFFFFFFFF && s < table.length && n++ < 200000) {
        var off = offFn(s);
        chunks.push(bytes.subarray(off, off + unit));
        s = table[s];
      }
      return concatBytes(chunks);
    }

    /* 目录项 */
    var dirBytes = readChain(dirStart, FAT, SS, secOff);
    var entries = [];
    for (var o = 0; o + 128 <= dirBytes.length; o += 128) {
      var nameLen = dirBytes[o + 64] | (dirBytes[o + 65] << 8);
      if (!nameLen) continue;
      var e = { name: utf16le(dirBytes, o, o + nameLen - 2), type: dirBytes[o + 66], start: 0, size: 0 };
      var dvo = o + 116;
      e.start = dirBytes[dvo] | (dirBytes[dvo + 1] << 8) | (dirBytes[dvo + 2] << 16) | (dirBytes[dvo + 3] << 24);
      e.size = dirBytes[dvo + 4] | (dirBytes[dvo + 5] << 8) | (dirBytes[dvo + 6] << 16) | (dirBytes[dvo + 7] << 24);
      entries.push(e);
    }

    /* 迷你 FAT + 迷你流 */
    var MINIFAT = [];
    if (nMiniFat) {
      var ms = miniFatStart, c2 = 0;
      while (ms !== 0xFFFFFFFE && ms !== 0xFFFFFFFF && c2++ < 100000) {
        var mb = secOff(ms);
        for (i = 0; i < SS / 4; i++) MINIFAT.push(u32(mb + i * 4));
        ms = FAT[ms];
      }
    }
    var root = null;
    for (i = 0; i < entries.length; i++) if (entries[i].type === 5) root = entries[i];
    var miniBase = root ? secOff(root.start) : 0;

    return {
      entries: entries,
      read: function (ent) {
        var out;
        if (ent.size < miniCutoff && ent.type === 2) {
          out = readChain(ent.start, MINIFAT, MS, function (s) { return miniBase + s * MS; });
        } else {
          out = readChain(ent.start, FAT, SS, secOff);
        }
        return out.subarray(0, Math.min(ent.size, out.length));
      }
    };
  }

  /* ============================================================
     BIFF 记录
     ============================================================ */
  /** RK 编码：低 2 位为标志，其余 30 位或是整数，或是双精度浮点的高 30 位 */
  function readRK(v) {
    var mult = v & 1, isInt = v & 2, d;
    if (isInt) {
      d = v >> 2;                                      // 有符号 30 位整数
    } else {
      var tmp = new Uint8Array(8);
      tmp[4] = v & 0xFC;                               // 低 2 位是标志，须清零
      tmp[5] = (v >>> 8) & 0xFF;
      tmp[6] = (v >>> 16) & 0xFF;
      tmp[7] = (v >>> 24) & 0xFF;
      d = new DataView(tmp.buffer).getFloat64(0, true);
    }
    return mult ? d / 100 : d;
  }

  /** SST：合并 SST 及后续 CONTINUE；跨记录边界时要重读选项字节 */
  function parseSST(stream, recs, idx) {
    var parts = [recs[idx]];
    for (var i = idx + 1; i < recs.length && recs[i].id === 0x003C; i++) parts.push(recs[i]);
    var segs = parts.map(function (r) { return { b: stream.subarray(r.off, r.off + r.len), p: 0 }; });
    segs[0].p = 8;                                     // 跳过 total / unique
    var si = 0;

    function byte() {
      while (segs[si].p >= segs[si].b.length) {
        if (si + 1 >= segs.length) throw new Error('SST 数据截断');
        si++;
      }
      return segs[si].b[segs[si].p++];
    }
    function w16() { var a = byte(), b = byte(); return a | (b << 8); }
    function d32() { var a = w16(), b = w16(); return (a | (b << 16)) >>> 0; }

    var unique = segs[0].b[4] | (segs[0].b[5] << 8) | (segs[0].b[6] << 16) | (segs[0].b[7] << 24);
    var out = [];

    for (var s = 0; s < unique; s++) {
      var cch = w16();
      var grbit = byte(), high = grbit & 1;
      var cRun = 0, cbExt = 0;
      if (grbit & 8) cRun = w16();
      if (grbit & 4) cbExt = d32();

      var str = '', read = 0;
      while (read < cch) {
        if (segs[si].p >= segs[si].b.length) {
          if (si + 1 >= segs.length) break;
          si++;
          high = byte() & 1;                           // 续段开头的选项字节
        }
        var avail = high ? ((segs[si].b.length - segs[si].p) >> 1) : (segs[si].b.length - segs[si].p);
        if (avail <= 0) continue;
        var take = Math.min(cch - read, avail);
        var from = segs[si].p;
        str += high ? utf16le(segs[si].b, from, from + take * 2) : latin1(segs[si].b, from, from + take);
        segs[si].p += take * (high ? 2 : 1);
        read += take;
      }
      out.push(str);
      for (var r = 0; r < cRun; r++) d32();
      for (var x = 0; x < cbExt; x++) byte();
    }
    return out;
  }

  function readWorkbook(stream) {
    // BIFF 记录位于 workbook 流内，数值读取必须以该流为基准（而非整个文件）
    _dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);

    var recs = [], p = 0;
    while (p + 4 <= stream.length) {
      var id = stream[p] | (stream[p + 1] << 8);
      var len = stream[p + 2] | (stream[p + 3] << 8);
      if (id === 0 && len === 0) break;
      recs.push({ id: id, off: p + 4, len: len });
      p += 4 + len;
    }

    var sst = [];
    for (var i = 0; i < recs.length; i++) {
      if (recs[i].id === 0x00FC) { sst = parseSST(stream, recs, i); break; }
    }

    var sheetNames = [];
    recs.forEach(function (r) {
      if (r.id !== 0x0085) return;
      var cch = stream[r.off + 6], grbit = stream[r.off + 7], from = r.off + 8;
      sheetNames.push((grbit & 1) ? utf16le(stream, from, from + cch * 2) : latin1(stream, from, from + cch));
    });

    var cells = {}, merges = [];
    var sub = 0;
    var pendingStr = null;

    for (var k = 0; k < recs.length; k++) {
      var rec = recs[k], o = rec.off;
      if (rec.id === 0x0809) { sub++; continue; }      // BOF：进入下一子流
      if (sub !== 2) continue;                         // 2 = 第一张工作表

      if (rec.id === 0x00FD) {                          // LABELSST
        cells[u16(o) + ',' + u16(o + 2)] = sst[u32(o + 6)] !== undefined ? sst[u32(o + 6)] : '';
      } else if (rec.id === 0x0204) {                   // LABEL
        var cch2 = u16(o + 6), g2 = stream[o + 8];
        cells[u16(o) + ',' + u16(o + 2)] = (g2 & 1)
          ? utf16le(stream, o + 9, o + 9 + cch2 * 2)
          : latin1(stream, o + 9, o + 9 + cch2);
      } else if (rec.id === 0x027E) {                   // RK
        cells[u16(o) + ',' + u16(o + 2)] = readRK(u32(o + 6));
      } else if (rec.id === 0x00BD) {                   // MULRK
        var mr = u16(o), mc = u16(o + 2), n = Math.floor((rec.len - 6) / 6);
        for (var q = 0; q < n; q++) cells[mr + ',' + (mc + q)] = readRK(u32(o + 4 + q * 6 + 2));
      } else if (rec.id === 0x0203) {                   // NUMBER
        cells[u16(o) + ',' + u16(o + 2)] = f64(o + 6);
      } else if (rec.id === 0x0006) {                   // FORMULA（取缓存结果）
        var fr = u16(o), fc = u16(o + 2);
        if (stream[o + 12] === 0xFF) { pendingStr = fr + ',' + fc; cells[pendingStr] = ''; }
        else cells[fr + ',' + fc] = f64(o + 6);
      } else if (rec.id === 0x0207 && pendingStr) {     // STRING
        var sl = rec.len >= 3 ? u16(o) : 0, sg = rec.len >= 3 ? stream[o + 2] : 0;
        cells[pendingStr] = rec.len < 3 ? '' : ((sg & 1)
          ? utf16le(stream, o + 3, o + 3 + sl * 2)
          : latin1(stream, o + 3, o + 3 + sl));
        pendingStr = null;
      } else if (rec.id === 0x00E5) {                   // MERGEDCELLS
        var cnt = u16(o);
        for (var z = 0; z < cnt; z++) {
          var b0 = o + 2 + z * 8;
          merges.push({ r1: u16(b0), r2: u16(b0 + 2), c1: u16(b0 + 4), c2: u16(b0 + 6) });
        }
      }
    }

    return { cells: cells, merges: merges, sheetName: sheetNames[0] || '', sheetCount: sheetNames.length };
  }

  /* ============================================================
     表格 → 课程
     ============================================================ */
  var DAY_CN = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
  var CN_ORDER = ['十一', '十二', '十', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  var CN_VAL = { '十一': 11, '十二': 12, '十': 10, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

  /**
   * 节次标签 → [起始节, 结束节]
   * 「第一二节」→[1,2]｜「第十一十二节」→[11,12]｜「1-2」→[1,2]｜「5」→[5,5]
   * 非节次文本（上午 / 实践课程…）返回 null
   */
  function parseSectionLabel(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s || s.length > 12) return null;

    var body = s.replace(/^第/, '').replace(/节/g, '').replace(/\s/g, '');
    if (!/^[\d一二三四五六七八九十\-–—~至到]+$/.test(body)) return null;

    var rng = /^(\d+)\s*[-–—~至到]\s*(\d+)$/.exec(body);
    if (rng) return [parseInt(rng[1], 10), parseInt(rng[2], 10)];
    if (/^\d+$/.test(body)) return [parseInt(body, 10), parseInt(body, 10)];

    var nums = [], i = 0;
    while (i < body.length) {
      var hit = null;
      for (var k = 0; k < CN_ORDER.length; k++) {
        if (body.substr(i, CN_ORDER[k].length) === CN_ORDER[k]) { hit = CN_ORDER[k]; break; }
      }
      if (hit) { nums.push(CN_VAL[hit]); i += hit.length; }
      else i++;
    }
    if (!nums.length) return null;
    return [Math.min.apply(null, nums), Math.max.apply(null, nums)];
  }

  /** 合并区展开后的读取器 */
  function buildGrid(cells, merges) {
    var cont = {};                                     // 合并区非左上格 -> 左上格坐标
    merges.forEach(function (m) {
      for (var r = m.r1; r <= m.r2; r++) {
        for (var c = m.c1; c <= m.c2; c++) {
          if (r !== m.r1 || c !== m.c1) cont[r + ',' + c] = m.r1 + ',' + m.c1;
        }
      }
    });
    return {
      isAnchor: function (r, c) { return !cont[r + ',' + c]; },
      mergeOf: function (r, c) {
        for (var i = 0; i < merges.length; i++) {
          var m = merges[i];
          if (m.r1 === r && m.c1 === c) return m;
        }
        return null;
      },
      get: function (r, c) {
        var key = r + ',' + c;
        var src = cont[key] ? cont[key] : key;
        var v = cells[src];
        return v === undefined || v === null ? '' : (typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v));
      }
    };
  }

  /**
   * 实践课程行整理成可读文本
   * 「劳动教育◆王芳(共4周)/9-12周; 教育见习/专业见习◆陈静(共16周)/1-16周」
   * → 「劳动教育（王芳）9-12周；教育见习/专业见习（陈静）1-16周」
   */
  function practiceSummary(text) {
    var body = String(text).replace(/^\s*实践课程[:：]?/, '').replace(/[\r\n]+/g, ';').trim();
    return body.split(/[;；]/).map(function (seg) {
      var s = seg.replace(/\s+/g, '').trim();
      if (!s) return '';
      var m = /^(.*?)◆([^(（]*)[（(]共\d+周[)）]\/?(.*)$/.exec(s);
      if (m) return m[1] + '（' + m[2] + '）' + (m[3] || '').trim();
      return s;
    }).filter(Boolean).join('；');
  }

  /** 一个课程单元格文本 → 课程条目（同一格多门课按换行拆开） */
  function parseCourseCell(text, fallbackSec) {
    var out = [];
    String(text).split(/\r\n|\n|\r/).forEach(function (raw) {
      var line = raw.replace(/\u00a0/g, ' ').trim();
      if (!line) return;
      if (/^(打印时间|制表|说明)/.test(line)) return;

      var parts = line.split('/').map(function (x) { return x.trim(); });
      if (parts.length < 2) return;

      var name = parts[0].replace(/[★☆◆◇●○]$/, '').trim();
      if (!name) return;

      var head = parts[1] || '';
      var sec = null;
      var m2 = /[（(]\s*(\d+)\s*[-–—~]\s*(\d+)\s*节\s*[)）]/.exec(head);
      if (m2) sec = [parseInt(m2[1], 10), parseInt(m2[2], 10)];
      else {
        var m1 = /[（(]\s*(\d+)\s*节\s*[)）]/.exec(head);
        if (m1) sec = [parseInt(m1[1], 10), parseInt(m1[1], 10)];
      }
      if (!sec && fallbackSec) sec = fallbackSec.slice();
      if (!sec) return;

      var weeksRaw = m2 ? head.slice(head.indexOf(m2[0]) + m2[0].length) : head.replace(/^[^）)]*[）)]/, '');
      weeksRaw = weeksRaw.replace(/^[\s,，、;；:：]+/, '').replace(/\s+/g, '').trim();

      out.push({
        name: name,
        start: Math.min(sec[0], sec[1]),
        end: Math.max(sec[0], sec[1]),
        location: (parts[2] || '').trim(),
        teacher: (parts[3] || '').trim(),
        weeksRaw: weeksRaw
      });
    });
    return out;
  }

  function gridToCourses(wb, settings) {
    var cells = wb.cells, merges = wb.merges;
    var grid = buildGrid(cells, merges);
    var courses = [], errors = [], skipped = 0, notes = [];
    var r, c;

    /* 1) 有效区域 */
    var rMin = 1e9, rMax = -1, cMin = 1e9, cMax = -1;
    Object.keys(cells).forEach(function (key) {
      var rc = key.split(','), rr = +rc[0], cc = +rc[1];
      if (rr < rMin) rMin = rr; if (rr > rMax) rMax = rr;
      if (cc < cMin) cMin = cc; if (cc > cMax) cMax = cc;
    });
    merges.forEach(function (m) {
      rMin = Math.min(rMin, m.r1); rMax = Math.max(rMax, m.r2);
      cMin = Math.min(cMin, m.c1); cMax = Math.max(cMax, m.c2);
    });
    if (rMax < 0) return { courses: [], errors: ['表格是空的，没有读到任何内容。'], skipped: 0, notes: [] };

    /* 2) 定位「星期」表头 */
    var dayCells = [];
    for (r = rMin; r <= rMax; r++) {
      for (c = cMin; c <= cMax; c++) {
        var v = cells[r + ',' + c];
        if (typeof v !== 'string') continue;
        var dm = /^(?:星期|周|礼拜)\s*([一二三四五六日天])$/.exec(v.trim());
        if (dm) dayCells.push({ r: r, c: c, day: DAY_CN[dm[1]] });
      }
    }
    if (dayCells.length < 3) {
      return { courses: [], errors: ['未找到「星期一 ~ 星期日」表头，无法识别课表结构。'], skipped: 0, notes: [] };
    }

    var rowSet = {}, colSet = {};
    dayCells.forEach(function (d) { rowSet[d.r] = 1; colSet[d.c] = 1; });
    var dayAlongCol = Object.keys(rowSet).length <= Object.keys(colSet).length;   // 星期沿列排列（常见）
    var headerLine = dayAlongCol ? dayCells[0].r : dayCells[0].c;
    var dayLines = {}, dayOf = {};
    dayCells.forEach(function (d) {
      var pos = dayAlongCol ? d.c : d.r;
      dayOf[pos] = d.day;
      dayLines[pos] = 1;
    });

    /* 3) 节次标签列/行：在星期轴之前的位置中，取「最像节次」的那一条 */
    var secLabelPos = null, bestCnt = 0;
    var firstDayPos = Math.min.apply(null, Object.keys(dayLines).map(Number));
    for (var cand = cMin; cand < firstDayPos; cand++) {
      var cnt = 0;
      for (var line = rMin; line <= rMax; line++) {
        if (line === headerLine) continue;
        if (parseSectionLabel(grid.get(dayAlongCol ? line : cand, dayAlongCol ? cand : line))) cnt++;
      }
      if (cnt > bestCnt) { bestCnt = cnt; secLabelPos = cand; }
    }
    if (!dayAlongCol) {                                // 转置版面同理，只是沿列扫
      bestCnt = 0;
      for (var cand2 = rMin; cand2 < firstDayPos; cand2++) {
        var cnt2 = 0;
        for (var line2 = cMin; line2 <= cMax; line2++) {
          if (line2 === headerLine) continue;
          if (parseSectionLabel(grid.get(cand2, line2))) cnt2++;
        }
        if (cnt2 > bestCnt) { bestCnt = cnt2; secLabelPos = cand2; }
      }
    }

    /* 4) 每一节次行的节次区间 */
    var secOfLine = {};
    if (secLabelPos !== null) {
      var limit = dayAlongCol ? rMax : cMax;
      for (var line3 = (dayAlongCol ? rMin : cMin); line3 <= limit; line3++) {
        if (line3 === headerLine) continue;
        var txt = dayAlongCol ? grid.get(line3, secLabelPos) : grid.get(secLabelPos, line3);
        var sec = parseSectionLabel(txt);
        if (sec) secOfLine[line3] = sec;
      }
    }
    if (!Object.keys(secOfLine).length) {              // 兜底：按顺序每两节一排
      var idx = 0;
      for (var line4 = (dayAlongCol ? rMin : cMin); line4 <= (dayAlongCol ? rMax : cMax); line4++) {
        if (line4 === headerLine) continue;
        idx++;
        secOfLine[line4] = [idx * 2 - 1, idx * 2];
      }
      notes.push('表格中没有「节次」标签，已按行序每两节一排推断上课节次');
    }

    /* 5) 逐格取课 */
    for (r = rMin; r <= rMax; r++) {
      for (c = cMin; c <= cMax; c++) {
        if (!grid.isAnchor(r, c)) continue;
        var val = cells[r + ',' + c];
        if (typeof val !== 'string' || !val.trim()) continue;
        if (dayAlongCol && r === headerLine) continue;
        if (!dayAlongCol && c === headerLine) continue;
        /* 表头之前是标题/学期行，直接跳过 */
        if (dayAlongCol && r < headerLine) continue;
        if (!dayAlongCol && c < headerLine) continue;

        /* 跨整表合并的说明行（如「实践课程」），没有固定上课时间 */
        var mg = grid.mergeOf(r, c);
        var spansAll = mg && (dayAlongCol ? (mg.c2 - mg.c1 >= 4) : (mg.r2 - mg.r1 >= 4));
        if (spansAll) {
          var tail = val.replace(/\s+/g, ' ').trim();
          if (/^(打印时间|制表|说明)/.test(tail)) continue;
          if (!/\d+\s*[-–—~]\s*\d+\s*节/.test(val)) {
            notes.push('未导入（表中未给出固定上课时间）：' + practiceSummary(val));
            skipped++;
            continue;
          }
        }

        var pos = dayAlongCol ? c : r;
        var lineNo = dayAlongCol ? r : c;
        var day = dayOf[pos];
        if (!day) continue;

        var entries = parseCourseCell(val, secOfLine[lineNo]);
        if (!entries.length) { skipped++; continue; }

        entries.forEach(function (e) {
          var wp = global.Store.parseWeeksExpr(e.weeksRaw, settings.totalWeeks);
          courses.push({
            id: global.Store.uid(),
            name: e.name,
            day: day,
            start: e.start,
            end: e.end,
            teacher: e.teacher,
            location: e.location,
            weeks: wp.weeks,
            weeksText: e.weeksRaw || global.Store.formatWeeks(wp.weeks)
          });
        });
      }
    }

    if (!courses.length) errors.push('没有从表格里解析出课程，请确认这是教务处下发的「班级课表」。');
    return { courses: courses, errors: errors, skipped: skipped, notes: notes, sheetName: wb.sheetName };
  }

  /* ============================================================
     ZIP（.xlsx 是 zip 包）
     ============================================================ */
  function readZip(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var len = u8.length;

    /* 从尾部找 EOCD */
    var eocd = -1;
    for (var i = len - 22; i >= Math.max(0, len - 65558); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 .xlsx 文件（缺少 zip 结尾记录）');

    var count = dv.getUint16(eocd + 10, true);
    var cdOff = dv.getUint32(eocd + 16, true);

    var entries = [], p = cdOff;
    for (var k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var usize = dv.getUint32(p + 24, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var cmtLen = dv.getUint16(p + 32, true);
      var lho = dv.getUint32(p + 42, true);
      var name = latin1(u8, p + 46, p + 46 + nameLen);
      /* ZIP64：大小溢出时从 extra 字段取 */
      if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || lho === 0xFFFFFFFF) {
        var ep = p + 46 + nameLen, eEnd = ep + extraLen;
        while (ep + 4 <= eEnd) {
          var hid = dv.getUint16(ep, true), hsz = dv.getUint16(ep + 2, true), q = ep + 4;
          if (hid === 0x0001) {
            if (usize === 0xFFFFFFFF && q + 8 <= ep + 4 + hsz) { usize = dv.getUint32(q, true); q += 8; }
            if (csize === 0xFFFFFFFF && q + 8 <= ep + 4 + hsz) { csize = dv.getUint32(q, true); q += 8; }
            if (lho === 0xFFFFFFFF && q + 8 <= ep + 4 + hsz) { lho = dv.getUint32(q, true); }
            break;
          }
          ep += 4 + hsz;
        }
      }
      var lnLen = dv.getUint16(lho + 26, true);
      var leLen = dv.getUint16(lho + 28, true);
      var dataStart = lho + 30 + lnLen + leLen;
      entries.push({
        name: name,
        method: method,
        dataStart: dataStart,
        csize: csize,
        usize: usize
      });
      p += 46 + nameLen + extraLen + cmtLen;
    }

    function inflateRaw(slice) {
      var ds = new DecompressionStream('deflate-raw');
      var src = new Blob([slice]).stream().pipeThrough(ds);
      return new Response(src).arrayBuffer().then(function (b) { return new Uint8Array(b); });
    }

    return {
      entries: entries,
      /** 取某个条目的文本内容（异步，deflate 需解压） */
      text: function (entry) {
        var raw = u8.subarray(entry.dataStart, entry.dataStart + entry.csize);
        if (entry.method === 0) return Promise.resolve(bytesToUtf8(raw));
        if (entry.method === 8) {
          if (typeof DecompressionStream === 'undefined') {
            return Promise.reject(new Error('当前环境不支持解压 .xlsx'));
          }
          return inflateRaw(raw).then(function (b) { return bytesToUtf8(b); });
        }
        return Promise.reject(new Error('不支持的压缩方式：' + entry.method));
      }
    };
  }

  /** UTF-8 解码（优先用浏览器原生实现） */
  function bytesToUtf8(u8) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }

  function unescapeXml(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (_m, d) { return String.fromCharCode(+d); })
      .replace(/&#x([0-9a-fA-F]+);/g, function (_m, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&amp;/g, '&');
  }

  function colIndexFromRef(ref) {
    var m = /^([A-Za-z]+)/.exec(ref);
    if (!m) return -1;
    var n = 0;
    for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].toUpperCase().charCodeAt(i) - 64);
    return n - 1;
  }

  /** 读取 .xlsx（zip + XML），产出与 BIFF 路径一致的 {cells, merges, sheetName} */
  function readXlsx(u8) {
    var zip = readZip(u8);
    var sheetEntry = null, sharedEntry = null, wbEntry = null;
    zip.entries.forEach(function (e) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name)) {
        if (!sheetEntry || e.name < sheetEntry.name) sheetEntry = e;
      }
      if (/^xl\/sharedStrings\.xml$/i.test(e.name)) sharedEntry = e;
      if (/^xl\/workbook\.xml$/i.test(e.name)) wbEntry = e;
    });
    if (!sheetEntry) {
      return Promise.reject(new Error('这个 .xlsx 里没有工作表数据'));
    }

    var jobs = [zip.text(sheetEntry), sharedEntry ? zip.text(sharedEntry) : Promise.resolve(''), wbEntry ? zip.text(wbEntry) : Promise.resolve('')];
    return Promise.all(jobs).then(function (out) {
      var sheetXml = out[0], sstXml = out[1], wbXml = out[2];

      /* 共享字符串 */
      var sst = [];
      if (sstXml) {
        var reSi = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g, m;
        while ((m = reSi.exec(sstXml)) !== null) {
          var inner = m[1] || '', txt = '', reT = /<t\b[^>]*>([\s\S]*?)<\/t>/g, t;
          while ((t = reT.exec(inner)) !== null) txt += t[1];
          sst.push(unescapeXml(txt));
        }
      }

      /* 单元格 */
      var cells = {}, merges = [];
      var rowRe = /<row\b([^>]*?)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g, rm;
      while ((rm = rowRe.exec(sheetXml)) !== null) {
        var body = rm[3] || '';
        var cellRe = /<c\b([^>]*?)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g, cm;
        while ((cm = cellRe.exec(body)) !== null) {
          var attrs = cm[1] || cm[2] || '';
          var inner2 = cm[3] || '';
          var refM = /\br="([A-Za-z]+\d+)"/.exec(attrs);
          if (!refM) continue;
          var col = colIndexFromRef(refM[1]);
          var rowNum = parseInt(/(\d+)$/.exec(refM[1])[1], 10);
          if (col < 0 || !rowNum) continue;

          var tAttr = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || 'n';
          var v = '', vm = /<v>([\s\S]*?)<\/v>/.exec(inner2);
          if (tAttr === 'inlineStr') {
            var reT2 = /<t\b[^>]*>([\s\S]*?)<\/t>/g, t2;
            while ((t2 = reT2.exec(inner2)) !== null) v += t2[1];
          } else if (vm) {
            v = vm[1];
          }
          if (v === '') continue;
          if (tAttr === 's') {
            var idx = parseInt(v, 10);
            cells[(rowNum - 1) + ',' + col] = sst[idx] !== undefined ? sst[idx] : '';
          } else if (tAttr === 'str' || tAttr === 'inlineStr') {
            cells[(rowNum - 1) + ',' + col] = unescapeXml(v);
          } else {
            var num = parseFloat(v);
            cells[(rowNum - 1) + ',' + col] = isNaN(num) ? unescapeXml(v) : num;
          }
        }
      }

      /* 合并单元格 */
      var reMc = /<mergeCell\b[^>]*ref="([A-Za-z]+\d+):([A-Za-z]+\d+)"[^>]*\/?>/g, mc;
      while ((mc = reMc.exec(sheetXml)) !== null) {
        var a = /^([A-Za-z]+)(\d+)$/.exec(mc[1]), b = /^([A-Za-z]+)(\d+)$/.exec(mc[2]);
        if (!a || !b) continue;
        merges.push({
          r1: parseInt(a[2], 10) - 1, c1: colIndexFromRef(a[1]),
          r2: parseInt(b[2], 10) - 1, c2: colIndexFromRef(b[1])
        });
      }

      var name = '';
      var nm = /<sheet\b[^>]*name="([^"]*)"/.exec(wbXml || '');
      if (nm) name = unescapeXml(nm[1]);
      return { cells: cells, merges: merges, sheetName: name, sheetCount: 1 };
    });
  }

  /* ============================================================
     主入口
     ============================================================ */
  function finishGrid(wb, settings, format, label) {
    var res = gridToCourses(wb, settings);
    res.format = format;
    res.source = label + (wb.sheetName ? '（' + wb.sheetName + '）' : '');
    return res;
  }

  /** 统一入口：自动区分 .xls（OLE2）与 .xlsx（zip） */
  function parse(buffer, settings) {
    settings = settings || {};
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4B;

    if (isZip) {
      return readXlsx(bytes).then(function (wb) {
        return finishGrid(wb, settings, 'xlsx', '教务处 Excel 课表');
      }).catch(function (err) {
        return {
          courses: [], errors: ['解析 .xlsx 失败：' + (err && err.message ? err.message : err)],
          skipped: 0, notes: [], format: 'xlsx'
        };
      });
    }

    try {
      var cfb = openCFB(bytes);
      var wbEntry = null;
      for (var i = 0; i < cfb.entries.length; i++) {
        var e = cfb.entries[i];
        if (e.type === 2 && /^(Workbook|Book)$/i.test(e.name)) { wbEntry = e; break; }
      }
      if (!wbEntry) throw new Error('文件里没有找到 Excel 工作簿数据');

      var wb = readWorkbook(cfb.read(wbEntry));
      return finishGrid(wb, settings, 'xls', '教务处 Excel 课表');
    } catch (err) {
      return {
        courses: [], errors: ['解析 Excel 失败：' + (err && err.message ? err.message : err)],
        skipped: 0, notes: [], format: 'xls'
      };
    }
  }

  global.XlsUtil = {
    /**
     * 解析 Excel 课表。
     * 注意：.xls 走同步路径返回结果对象；.xlsx 需要异步解压，返回 Promise。
     * 调用方请统一用 Promise.resolve(XlsUtil.parse(...)) 包一层。
     */
    parse: parse,
    parseSectionLabel: parseSectionLabel,
    parseCourseCell: parseCourseCell,
    practiceSummary: practiceSummary,
    gridToCourses: gridToCourses,
    readWorkbook: readWorkbook,
    readXlsx: readXlsx,
    readZip: readZip,
    openCFB: openCFB
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.XlsUtil;

})(typeof window !== 'undefined' ? window : globalThis);
