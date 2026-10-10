/**
 * adapter-import.js —— 适配脚本回传的数据 → 柚课的导入结果
 * ============================================================
 * 适配脚本跑在教务页面上，通过桥（见 EduLoginActivity.kt）把三类东西交回来：
 *
 *   ① `saveImportedCourses`  课程数组
 *        { name, teacher, position, day, startSection, endSection, weeks[] }
 *        可选：isCustomTime + customStartTime/customEndTime
 *   ② `savePresetTimeSlots`  作息表
 *        [{ number, startTime, endTime }]
 *   ③ `saveCourseConfig`     学期设置
 *        { semesterStartDate, semesterTotalWeeks,
 *          defaultClassDuration, defaultBreakDuration, firstDayOfWeek }
 *
 * 本模块把它们翻译成**柚课既有的导入结果**（与 xls / pdf / csv / 抓网页
 * 四条路同一个形状），于是预览、覆盖 / 追加、落库、提示全都不用改。
 *
 * ------------------------------------------------------------
 * 三处「两边不一样」，这里必须做决定（而不是假装没看见）
 * ------------------------------------------------------------
 * 1) **自定义时间**（`isCustomTime`）。柚课的课表按「第 N 节的钟点」渲染，
 *    而适配脚本可以给某门课一个自带的起止时刻（上游主要用它表达「早读」这类
 *    不在节次表里的活动）。做法：
 *      · 有合法节次 ⇒ 照常导入（按节次显示），并在提示里说一句「带自定义时间」；
 *      · 没有节次  ⇒ **跳过并列出课名** —— 硬塞进某一节等于替用户编了个时间。
 *    统计过：上游 56 个脚本用到它，其中只有 1 个不带节次。
 *
 * 2) **作息表**。柚课的 `settings.times` 是按节次索引的 `{start,end}` 数组，
 *    页面上限 16 节。上游给的是 `{number,startTime,endTime}` 列表，可能不连续。
 *    做法：按 `number` 落位，缺的位用「上一节结束 + 同样的间隔」补；
 *    超过 16 节只取前 16 节并**明说**。
 *    `fixedDuration` 由**这批时间表自己**推（每节一样长才为真）——
 *    否则用户一进「编辑时间表」，不同长度的作息会被统一成 45 分钟。
 *
 * 3) **`firstDayOfWeek` / `defaultBreakDuration`**：柚课的星期固定 1=周一…7=周日、
 *    也没有独立的课间字段。这两个字段**读但不使用**，写进提示里让用户知道
 *    它们没生效，而不是默默丢掉。
 *
 * 零第三方依赖；可在 Node 下 require 以做离线单测。
 */
(function (global) {
  'use strict';

  /** 柚课页面上限（app.js 的「最多 16 节」）；作息表超过就取前 16 节 */
  var MAX_SECTIONS = 16;
  /** 周次上限。上游有 25 位的位图（含开学前一周），正常学期不会超过这个数 */
  var MAX_WEEKS = 60;
  /** 节次上限：上游偶尔有位图式的节次（如 1..25 对应一天 25 个小节），夹到 16 */
  var MAX_SECTION_NO = 16;

  var HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  var ISO_DATE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;

  function intOf(v) {
    var n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }

  function strOf(v) {
    return String(v == null ? '' : v).trim();
  }

  /** 解析 JSON。桥两边传的都是字符串，但也接受已经是对象的情况（测试直接传对象） */
  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (typeof v !== 'string' || !v.trim()) return [];
    try {
      var p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch (e) { return []; }
  }

  function asObject(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v !== 'string' || !v.trim()) return null;
    try {
      var p = JSON.parse(v);
      return (p && typeof p === 'object' && !Array.isArray(p)) ? p : null;
    } catch (e) { return null; }
  }

  /* ============================================================
     课程
     ============================================================ */

  /**
   * 一条上游课程 → 一条柚课课程。
   * 返回 `{ ok:true, course }` 或 `{ ok:false, reason, customTime, name }`。
   *
   * 判据一律「有没有、合不合法」，不合法的**不猜**：宁可跳过并说明，
   * 也不要把一条 day=0 的课塞进周一（越界值一旦放进去，渲染层是按
   * `+c.day === 1..7` 取用的，它会**静默消失**，用户在课表上找不到、
   * 也不知道为什么少了一门）。
   */
  function mapCourse(raw) {
    var name = strOf(raw && raw.name);
    if (!name) return { ok: false, reason: '没有课程名' };

    var day = intOf(raw && raw.day);
    if (day === null || day < 1 || day > 7) {
      return { ok: false, reason: '星期不在 1–7 之内（' + strOf(raw && raw.day) + '）', name: name };
    }

    var weeks = normalizeWeeks(raw && raw.weeks);
    if (!weeks.length) {
      return { ok: false, reason: '没有可用的周次', name: name };
    }

    var custom = !!(raw && raw.isCustomTime);
    var start = intOf(raw && raw.startSection);
    var end = intOf(raw && raw.endSection);
    if (start !== null && end === null) end = start;
    if (end !== null && start === null) start = end;

    if (start === null || start < 1 || start > MAX_SECTION_NO ||
        end < 1 || end > MAX_SECTION_NO) {
      // 没有合法节次：自定义时间的（早读那类）单独归一类，提示语不一样
      return {
        ok: false, name: name, customTime: custom,
        reason: custom ? '只有自定义时间、没有节次' : '节次不在 1–16 之内'
      };
    }
    if (end < start) { var t = start; start = end; end = t; }

    return {
      ok: true,
      customTime: custom,
      course: {
        /* 解析层**不生成 id**，一律由 Store 侧收口补：
           commitImport（新导入当场补）+ normalizeSchedule（载入兜底）。
           这两处缺一个，导入的课在课表里就会点不开 —— 别在这行改成自己生成，
           两条入口各生成一次反而会把 id 的口径拆散。 */
        id: null,
        name: name,
        teacher: strOf(raw && raw.teacher),
        location: strOf(raw && raw.position),
        day: day,
        start: start,
        end: end,
        weeks: weeks
      }
    };
  }

  /** 周次：只留 1..MAX_WEEKS 的整数，去重升序。空 / 非数组一律当「没有」 */
  function normalizeWeeks(v) {
    if (!Array.isArray(v)) return [];
    var seen = {}, out = [];
    v.forEach(function (x) {
      var n = intOf(x);
      if (n === null || n < 1 || n > MAX_WEEKS) return;
      if (seen[n]) return;
      seen[n] = 1;
      out.push(n);
    });
    return out.sort(function (a, b) { return a - b; });
  }

  /* ============================================================
     作息表
     ============================================================ */

  /**
   * `[{number,startTime,endTime}]` → `{ times:[{start,end}…], sections, uniform, note }`
   * 没有一条合法时返回 null（调用方据此决定「不要动用户的作息表」）。
   */
  function mapTimeSlots(raw) {
    var list = asArray(raw);
    if (!list.length) return null;

    var slots = {};
    var maxNo = 0;
    list.forEach(function (s) {
      var n = intOf(s && s.number);
      var a = strOf(s && s.startTime);
      var b = strOf(s && s.endTime);
      if (n === null || n < 1 || !HHMM.test(a) || !HHMM.test(b)) return;
      if (!slots[n]) { slots[n] = { start: a, end: b }; maxNo = Math.max(maxNo, n); }
    });
    if (!maxNo) return null;

    var note = '';
    var count = Math.min(maxNo, MAX_SECTIONS);
    if (maxNo > MAX_SECTIONS) {
      note = '作息表有 ' + maxNo + ' 节，超过课表上限 ' + MAX_SECTIONS + ' 节，只取了前 ' +
        MAX_SECTIONS + ' 节。';
    }

    var times = [];
    for (var i = 1; i <= count; i++) {
      var s = slots[i];
      if (s) { times.push({ start: s.start, end: s.end }); continue; }
      // 缺位：拿上一节的结束时间往后接一段（补出来的节不该长得像「08:00–08:45」）
      var prev = times[times.length - 1];
      var startMin = prev ? toMin(prev.end) + 10 : 8 * 60;
      times.push({ start: fromMin(startMin), end: fromMin(startMin + 45) });
    }

    return {
      times: times,
      sections: times.length,
      uniform: uniformOf(times),
      note: note
    };
  }

  function toMin(hhmm) {
    var p = String(hhmm).split(':');
    return (+p[0]) * 60 + (+p[1]);
  }

  function fromMin(v) {
    var n = Math.max(0, Math.min(23 * 60 + 59, Math.round(v)));
    var h = Math.floor(n / 60), m = n % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  /** 每节时长一致时返回那个时长，否则返回 0（= 不能用「固定上课时长」） */
  function uniformOf(times) {
    var d = null;
    for (var i = 0; i < times.length; i++) {
      var v = toMin(times[i].end) - toMin(times[i].start);
      if (v <= 0) return 0;
      if (d === null) d = v;
      else if (d !== v) return 0;
    }
    return d === null ? 0 : d;
  }

  /* ============================================================
     学期设置
     ============================================================ */

  /**
   * `{semesterStartDate, semesterTotalWeeks, defaultClassDuration,
   *   defaultBreakDuration, firstDayOfWeek}` → 柚课设置片段。
   * 读但不使用的字段一并返回，交给提示语去说明。
   */
  function mapConfig(raw) {
    var c = asObject(raw);
    var out = { ignored: [] };
    if (!c) return out;

    /* `semesterStartDate` 为 null / 空串是上游的「没拿到」—— 不是错，不记；
       给了内容却读不懂（「明年九月」这种）才算「给了但没生效」，必须记下来。 */
    var d = strOf(c.semesterStartDate);
    var gotDate = false;
    if (d) {
      var m = ISO_DATE.exec(d);
      if (m) {
        var mm = +m[2], dd = +m[3];
        if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
          out.semesterStart = m[1] + '-' + (mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd;
          gotDate = true;
        }
      }
    }
    if (d && !gotDate) out.ignored.push('开学日期');

    var tw = intOf(c.semesterTotalWeeks);
    if (tw !== null && tw >= 1 && tw <= MAX_WEEKS) out.totalWeeks = tw;

    var cd = intOf(c.defaultClassDuration);
    if (cd !== null && cd >= 5 && cd <= 300) out.classDuration = cd;

    if (c.defaultBreakDuration != null) out.ignored.push('课间时长');
    if (c.firstDayOfWeek != null) out.ignored.push('每周起始日');

    return out;
  }

  /* ============================================================
     汇总
     ============================================================ */

  function importUtil() {
    var u = global.ImportUtil;
    if (!u || typeof u.finalize !== 'function') {
      throw new Error('导入后处理模块（importer.js）没加载');
    }
    return u;
  }

  /** 来源描述：上游要求保留贡献者署名，所以适配器名 + 校名 + 维护者都要写上 */
  function sourceOf(p) {
    var who = strOf(p && p.adapterName) || '教务适配';
    var school = strOf(p && p.schoolName);
    var line = '适配脚本「' + who + '」' + (school ? '（' + school + '）' : '');
    var m = strOf(p && p.maintainer);
    if (m) line += ' · 维护者 ' + m;
    return line;
  }

  /**
   * 主入口。`payload` 是原生侧攒好的一个对象（三类数据都可能是字符串或对象）：
   *   { adapterId, adapterName, schoolName, maintainer, courses, timeSlots, config }
   * `settings` 是目标课表现有的设置（用来算 suggestTotalWeeks / suggestSections）。
   *
   * 返回与其它导入通道**同形状**的结果，外加一个 `settings` 片段
   * （由调用方在落库前合并 —— 顺序要紧，见 commitImport）。
   */
  function toResult(payload, settings) {
    var p = payload || {};
    var notes = [], errors = [];
    var mapped = [];
    var noSection = [];   // 只有自定义时间、没节次的（早读那类）
    var bad = 0;          // 数据不合法（缺名 / 星期或节次越界 / 没有周次）
    var customOk = 0;     // 带自定义时间、但有节次（按节次导入）
    var rawJcs = [];      // 原始节次串样本（v1.9.37 诊断：节次落位不对时对照看）
    var fixedSec = [];    // 节次靠 jcor/jc 兜底修正过的课程名（v1.9.38 诊断）

    asArray(p.courses).forEach(function (raw) {
      var r = mapCourse(raw);
      if (r.ok) {
        if (rawJcs.length < 6 && raw && strOf(raw.rawJcs)) {
          rawJcs.push(strOf(raw.name) + ' jcs=「' + strOf(raw.rawJcs) + '」');
        }
        /* 节次不是从标准的 jcs 读出来的（教务把它放在 jcor/jc 里）：
           一并告诉用户，别让人以为没动过 */
        var sf = strOf(raw && raw.secFrom);
        if (sf && sf !== 'jcs' && fixedSec.length < 6) fixedSec.push(strOf(raw.name) + '（' + sf + '）');
        mapped.push(r.course);
        if (r.customTime) customOk++;
        return;
      }
      if (r.customTime && !r.reason.match(/节次不在/)) { noSection.push(r.name || '(无名)'); return; }
      bad++;
    });

    /* 脚本侧就没认出来的行（脚本自己在回包里带的 dropped）：原样亮出来 ——
       课表少了半截时，这里是唯一的线索，绝不能静默吞掉。
       上游的通用脚本目前不带这个字段（那是柚课自研脚本的口径，
       v1.9.42 已停用），所以这一段只在脚本愿意给诊断时才亮。 */
    var dropped = asArray(p.dropped);
    if (dropped.length) {
      var samples = dropped.slice(0, 4).map(function (d) {
        var line = strOf(d && d.name) + '（' + strOf(d && d.reason);
        var j = strOf(d && d.jcs), z = strOf(d && d.zcd);
        if (j) line += '，jcs=「' + j + '」';
        if (z) line += '，zcd=「' + z + '」';
        return line + '）';
      });
      notes.push('教务回包里有 ' + dropped.length + ' 行没认出来，已跳过：' +
        samples.join('；') + (dropped.length > 4 ? ' 等。' : '。'));
    }
    if (rawJcs.length) {
      notes.push('节次原始写法样本（解析若有出入，拿它对照教务系统）：' + rawJcs.join('；') + '。');
    }
    if (fixedSec.length) {
      notes.push('有 ' + fixedSec.length + ' 门课的节次不在标准的 jcs 字段里（教务用了别的字段），' +
        '已按同一条记录里的范围修正：' + fixedSec.join('、') + '。');
    }
    /* v1.9.38：第一条原始记录的字段全貌 —— 节次落位不对时，这里能直接看出
       教务把「1-2」放在了哪个键里（也可能压根没给范围） */
    var sample = strOf(p && p.sample);
    if (sample) {
      notes.push('教务原始记录样本（第一条的全部字段）：' + sample + '。');
    }

    var slot = mapTimeSlots(p.timeSlots);
    var cfg = mapConfig(p.config);
    var patch = {};
    if (slot) {
      patch.times = slot.times;
      patch.sections = slot.sections;
      patch.fixedDuration = slot.uniform > 0;
      patch.classDuration = slot.uniform || (cfg.classDuration || 45);
      if (slot.note) notes.push(slot.note);
      notes.push('已按该校的作息表设置 ' + slot.sections + ' 节的上下课时间。');
    }
    if (cfg.semesterStart) patch.semesterStart = cfg.semesterStart;
    if (cfg.totalWeeks) patch.totalWeeks = cfg.totalWeeks;
    if (cfg.classDuration && !patch.classDuration) patch.classDuration = cfg.classDuration;
    if (cfg.semesterStart) notes.push('开学日期按教务系统回传的设为 ' + cfg.semesterStart + '。');
    if (cfg.ignored.length) {
      notes.push('这些设置本课表用不上、没有生效：' + cfg.ignored.join('、') + '。');
    }

    if (customOk) {
      notes.push('有 ' + customOk + ' 门课在教务里带自定义时间（如早读），课表按节次显示它们。');
    }
    if (noSection.length) {
      notes.push('有 ' + noSection.length + ' 门课在教务里只给了自定义时间、没有节次，' +
        '课表按节次显示，这几门没有导入：' + noSection.slice(0, 5).join('、') +
        (noSection.length > 5 ? ' 等' : '') + '。');
    }
    if (bad) {
      errors.push('有 ' + bad + ' 条课程数据不完整（缺课程名 / 星期或节次越界 / 没有周次），已跳过。');
    }
    if (!asArray(p.courses).length) {
      errors.push('这个适配脚本没有交回任何课程。可能是登录状态已失效、' +
        '或者当前页面不是它认识的课表页。');
    }

    var out = importUtil().finalize({
      courses: mapped,
      errors: errors,
      notes: notes,
      skipped: noSection.length + bad,
      format: 'adapter',
      source: sourceOf(p)
    }, settings || {});

    out.settings = patch;
    out.source = sourceOf(p);      // finalize 会用 format 兜底来源，这里必须以适配信息为准
    return out;
  }

  var api = {
    MAX_SECTIONS: MAX_SECTIONS,
    MAX_WEEKS: MAX_WEEKS,
    MAX_SECTION_NO: MAX_SECTION_NO,
    mapCourse: mapCourse,
    normalizeWeeks: normalizeWeeks,
    mapTimeSlots: mapTimeSlots,
    mapConfig: mapConfig,
    uniformOf: uniformOf,
    sourceOf: sourceOf,
    toMin: toMin,
    fromMin: fromMin,
    toResult: toResult
  };

  global.AdapterImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
