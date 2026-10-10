/* ============================================================
   importer.js —— 课表导入统一入口
   ------------------------------------------------------------
   支持四种来源，按文件内容自动识别（不依赖扩展名）：
     · 教务系统 PDF 课表      %PDF-            -> PdfUtil
     · 教务处 Excel 课表      OLE2 (D0CF11E0)  -> XlsUtil
     · 教务处 Excel 课表      ZIP  (PK..)      -> XlsUtil
     · CSV / 文本课表         其余             -> CsvUtil
   统一产出 { courses, errors, notes, skipped, format, source, stats }
   ============================================================ */
(function (global) {
  'use strict';

  var Store = global.Store;

  /* ---------------- 格式嗅探（读文件头，不看扩展名） ---------------- */
  function sniff(u8) {
    if (u8.length > 4 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) return 'pdf';
    if (u8.length > 8 && u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) return 'xls';
    if (u8.length > 2 && u8[0] === 0x50 && u8[1] === 0x4B) return 'xlsx';

    /* 教务系统「导出课表」下发的 .xls 常常其实是 HTML 表格（Excel 2003 XML 风格），
       扩展名和 MIME 都在骗人，只能看内容。所以先取出头部字节扫一遍标签。 */
    var head = '', n = Math.min(u8.length, 4096);
    for (var i = 0; i < n; i++) head += String.fromCharCode(u8[i]);
    if (/<!doctype\s+html|<html[\s>]|<head[\s>]|<table[\s>]/i.test(head)) return 'html';

    return 'csv';
  }

  var FORMAT_LABEL = {
    csv: 'CSV 课表',
    xls: '教务处 Excel 课表',
    xlsx: '教务处 Excel 课表',
    pdf: '教务系统 PDF 课表',
    html: '教务系统网页课表'
  };

  /* ---------------- 读取文件 ---------------- */
  function readArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * 文本解码：优先 UTF-8；出现替换字符说明是 GBK/GB18030
   * （Excel 导出的中文 CSV 常见），自动改用 GBK 重解
   */
  function decodeText(buffer) {
    var u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var text;
    try {
      text = new TextDecoder('utf-8').decode(u8);
    } catch (e) {
      text = '';
      for (var i = 0; i < u8.length; i++) text += String.fromCharCode(u8[i]);
    }
    if (/\uFFFD/.test(text)) {
      try {
        var gb = new TextDecoder('gbk').decode(u8);
        if (!/\uFFFD/.test(gb)) return gb;
      } catch (e2) { /* 浏览器不支持 gbk 时保持 UTF-8 结果 */ }
    }
    return text;
  }

  /* ---------------- 后处理 ---------------- */
  function signature(c) {
    return [c.name, c.teacher || '', c.location || '', (c.weeks || []).join(',')].join('|');
  }

  /**
   * 合并「同一门课被表格拆到相邻节次行」的条目。
   * 例：教务处班级课表把「周二 1-4 节」的课分别写在第一二节、第三四节两行里，
   * 这里合成一条 1-4 节，与 PDF 课表的表述保持一致。
   */
  function mergeAdjacent(list) {
    var groups = {};
    list.forEach(function (c) {
      var key = c.day + '|' + signature(c);
      (groups[key] = groups[key] || []).push(c);
    });

    var out = [];
    Object.keys(groups).forEach(function (key) {
      var arr = groups[key].sort(function (a, b) { return a.start - b.start; });
      var cur = null;
      arr.forEach(function (c) {
        if (cur && c.start <= cur.end + 1) {
          if (c.end > cur.end) cur.end = c.end;
        } else {
          if (cur) out.push(cur);
          cur = { id: c.id, name: c.name, day: c.day, start: c.start, end: c.end, teacher: c.teacher, location: c.location, weeks: c.weeks, weeksText: c.weeksText };
        }
      });
      if (cur) out.push(cur);
    });

    return out.sort(function (a, b) { return a.day - b.day || a.start - b.start; });
  }

  function dedupe(list) {
    var seen = {}, out = [];
    list.forEach(function (c) {
      var key = c.day + '|' + c.start + '|' + c.end + '|' + signature(c);
      if (seen[key]) return;
      seen[key] = 1; out.push(c);
    });
    return out;
  }

  /** 统一收尾：合并、去重、推断总周数、补全字段 */
  function finalize(res, settings) {
    var raw = res.courses || [];
    var merged = mergeAdjacent(raw);
    var courses = dedupe(merged);

    var maxWeek = 0;
    courses.forEach(function (c) {
      (c.weeks || []).forEach(function (w) { if (w > maxWeek) maxWeek = w; });
    });

    var maxSection = 0;
    courses.forEach(function (c) { if (c.end > maxSection) maxSection = c.end; });

    return {
      courses: courses,
      errors: res.errors || [],
      notes: res.notes || [],
      skipped: res.skipped || 0,
      format: res.format || 'csv',
      source: res.source || FORMAT_LABEL[res.format] || '课表',
      stats: {
        parsed: raw.length,
        merged: merged.length,
        duplicate: merged.length - courses.length,
        maxWeek: maxWeek,
        maxSection: maxSection
      },
      suggestTotalWeeks: maxWeek > (settings.totalWeeks || 0) ? maxWeek : 0,
      suggestSections: maxSection > (settings.sections || 0) ? maxSection : 0
    };
  }

  /* ---------------- 解析 ---------------- */
  /** 解析教务课表页 HTML（内嵌浏览器抓回来的整页，或下载下来的网页课表） */
  function parseHtml(html, settings) {
    settings = settings || {};
    if (!global.EduGrab || !global.HtmlUtil) {
      return { courses: [], errors: ['网页课表解析模块未加载'], notes: [], skipped: 0, format: 'html' };
    }
    var r = global.EduGrab.extract(String(html || ''), settings);
    r.format = 'html';
    r.source = r.source || FORMAT_LABEL.html;
    return finalize(r, settings);
  }

  function parseBuffer(buffer, fileName, settings) {
    settings = settings || {};
    var u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var kind = sniff(u8);

    var label = FORMAT_LABEL[kind];
    var suffix = fileName ? '：' + fileName : '';

    if (kind === 'pdf') {
      if (!global.PdfUtil) {
        return Promise.resolve({ courses: [], errors: ['PDF 解析模块未加载'], skipped: 0, notes: [], format: 'pdf' });
      }
      return Promise.resolve(global.PdfUtil.parse(buffer, settings)).then(function (r) {
        r.source = (r.source || label) + suffix;
        return finalize(r, settings);
      });
    }

    if (kind === 'xls' || kind === 'xlsx') {
      if (!global.XlsUtil) {
        return Promise.resolve({ courses: [], errors: ['Excel 解析模块未加载'], skipped: 0, notes: [], format: kind });
      }
      return Promise.resolve(global.XlsUtil.parse(u8, settings)).then(function (r) {
        r.source = (r.source || label) + suffix;
        return finalize(r, settings);
      });
    }

    /* 网页课表：教务系统导出的「.xls」多半是 HTML 表格，
       内嵌浏览器抓回来的整页 HTML 也走这里 */
    if (kind === 'html') {
      var hres = parseHtml(decodeText(u8), settings);
      hres.source = (hres.source || label) + suffix;
      return Promise.resolve(hres);
    }

    /* CSV / 纯文本 */
    var text = decodeText(u8);
    var res = global.CsvUtil.parse(text, settings);
    res.format = 'csv';
    res.source = label + suffix;

    /* 整份文件里连一个逗号都没有，多半是选错了格式 */
    if (!res.courses.length && text.indexOf(',') < 0 && text.indexOf('\t') < 0) {
      res.errors = res.errors.concat(['这份文件看起来不是 CSV 课表（内容里没有逗号分隔），' +
        '请确认选的是课表文件；若为 Excel/PDF 请直接选原文件，程序会自动识别。']);
    }
    return Promise.resolve(finalize(res, settings));
  }

  /** 从粘贴的文本导入（只按 CSV 处理） */
  function parseText(text, settings) {
    settings = settings || {};
    var res = global.CsvUtil.parse(text, settings);
    res.format = 'csv';
    res.source = '粘贴的 CSV 文本';
    return finalize(res, settings);
  }

  /** 从 <input type="file"> 选中的文件导入 */
  function parseFile(file, settings) {
    return readArrayBuffer(file).then(function (buf) {
      return parseBuffer(buf, file.name, settings);
    });
  }

  global.ImportUtil = {
    parseFile: parseFile,
    parseBuffer: parseBuffer,
    parseHtml: parseHtml,
    parseText: parseText,
    decodeText: decodeText,
    sniff: sniff,
    mergeAdjacent: mergeAdjacent,
    dedupe: dedupe,
    /* 收尾流水线（合并相邻节次 → 去重 → 统计 → 给出「要不要放宽周数 / 节数」的建议）。
       适配脚本那条路（adapter-import.js）也走同一份 —— 合并与去重的口径
       只该有一处，两个通道各写一遍必然漂移。 */
    finalize: finalize,
    FORMAT_LABEL: FORMAT_LABEL
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.ImportUtil;

})(typeof window !== 'undefined' ? window : globalThis);
