/* ============================================================
   柚课 - 自绘选择器：单选列表 / 月历 / 滚轮
   ------------------------------------------------------------
   为什么必须自己画（v1.9.15）：
   <select>、<input type="date">、<input type="time"> 这三类控件弹出来的
   层是**浏览器 / 系统**画的，CSS 一点也够不着（连 color-scheme 都只管一部分）。
   它们的外观取自 Activity 的主题，而本应用的主题是页面自己按 localStorage
   决定的 —— 两者可以不一致，于是出现「页面是白天暖色、弹层是系统深灰」
   的割裂（用户报的那四张截图）。自绘之后这四处弹层与应用其余部分共用同一套
   令牌，白天/夜晚自动跟着走。

   ⚠ 本文件只负责「控件本身」：渲染、手势、内部状态、它自己那几个按钮。
     弹层的开与关、以及「关掉后该亮回哪一层」一律留在 app.js
     （BULLET_BACK 是唯一的例外表，见 app.js 顶部那段注释）。
     ⇒ 调用顺序必须是 **先 openMask() 再 Picker.xxx()**：滚轮靠 scrollTop
       定位，元素还在 display:none 里时布局尚未成立，写了也不作数。

   日期与时间的算术一律借 store.js 的纯函数（fmtDate / parseDate /
   timeToMin / minToTime），不在这里再造一份 —— 两份算法迟早会漂移。
   ============================================================ */
(function (global) {
  'use strict';

  /* 滚轮每项的高度（px）。**必须与 app.css 里的 .whl-i 高度一致**：
     选中第几项是拿 scrollTop / WHEEL_H 反算的，对不上就整体错一格。
     smoke-test 有一条哨兵同时盯着这两个数字。 */
  var WHEEL_H = 40;
  var WHEEL_VIS = 5;       // 可见行数（奇数），正中那行就是当前值
  var WHEEL_SNAP_MS = 120; // 滚动停下多久之后把格子吸正

  function $(id) { return document.getElementById(id); }

  /* HTML 转义：唯一实现在 store.js（v1.9.45 收口）。
     本文件以前自带一份，只转义 & < > " —— 漏了单引号，与 app.js 那份已经漂移。
     收口到 store.js 之后，这里的名字保持不变，调用点无需改动。 */
  function esc(s) { return Store.esc(s); }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** 周一开头的星期名。store.js 的 WEEKDAY_CN 是周日开头的，只做一次轮转，
      不再另存一份中文表（两份表迟早会有一处被改）。 */
  function wdCnMon(dowMon) { return Store.WEEKDAY_CN[(dowMon + 1) % 7]; }

  /** 拆 'HH:MM' 为分钟数；认不出就返回 -1（不是 0 —— 00:00 是合法时间） */
  function toMin(s) {
    var v = Store.timeToMin(s);
    return isNaN(v) ? -1 : v;
  }

  /* ============================================================
     一、单选列表
     ============================================================ */
  var listOpts = null;     // 当前这层的回调（onPick / onCancel）

  function pickList(opts) {
    listOpts = opts;
    $('pickTitle').textContent = opts.title || '请选择';

    var items = opts.items || [];
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      html += '<button type="button" class="pick-row' +
        (String(it.v) === String(opts.value) ? ' is-on' : '') +
        '" data-v="' + esc(it.v) + '">' +
        '<span class="pk-main">' +
        /* tip 是标题前面的一个小标记（如「＋」），跟标题同一行 ——
           单独占一行会看起来像个没写完的标题。它是纯装饰，对读屏隐藏。 */
        '<span class="pk-t">' +
        (it.tip ? '<i class="pk-plus" aria-hidden="true">' + esc(it.tip) + '</i>' : '') +
        esc(it.t) + '</span>' +
        (it.sub ? '<span class="pk-sub">' + esc(it.sub) + '</span>' : '') +
        '</span><i class="pk-tick"></i></button>';
    }
    $('pickList').innerHTML = html;

    /* 列表最长的那次是「导入到哪个课表」，课表可以有十几个；
       开完之后把当前值滚到中间，省得用户以为没选中。 */
    centerOn($('pickList'), $('pickList').querySelector('.pick-row.is-on'));
  }

  /** 把 row 滚到 box 的中间（用 scrollTop 而不是 scrollIntoView：
      scrollIntoView 会连带把外层 .sheet 一起滚，标题就跑掉了） */
  function centerOn(box, row) {
    if (!box || !row || !box.clientHeight) return;
    var top = row.offsetTop - (box.clientHeight - row.offsetHeight) / 2;
    box.scrollTop = top < 0 ? 0 : top;
  }

  /* ============================================================
     二、月历
     ============================================================ */
  var calCb = null;
  var calValue = '';       // 待确认的那一天 'YYYY-MM-DD'
  var calView = null;      // 正在显示的月份（该月 1 号）
  var calNoteFn = null;    // (iso) -> 下面那行说明；业务含义由调用方给，这里不猜

  function pickDate(opts) {
    calCb = opts;
    calNoteFn = opts.note || null;
    calValue = Store.parseDate(opts.value) ? opts.value : Store.fmtDate(new Date());
    var d = Store.parseDate(calValue);
    calView = new Date(d.getFullYear(), d.getMonth(), 1);
    renderCal();
  }

  function renderCal() {
    var y = calView.getFullYear(), m = calView.getMonth();
    $('calTitle').textContent = y + ' 年 ' + (m + 1) + ' 月';

    var today = Store.fmtDate(new Date());
    /* 周一为一周之首：本月 1 号是周几，前面就要空几格 */
    var lead = (new Date(y, m, 1).getDay() + 6) % 7;
    var html = '';
    /* 固定 6 行 42 格：翻月时高度不跳，弹层不会跟着抖一下 */
    for (var i = 0; i < 42; i++) {
      var d = new Date(y, m, 1 - lead + i);
      var iso = Store.fmtDate(d);
      var cls = 'cal-d';
      if (d.getMonth() !== m) cls += ' is-out';
      if (iso === today) cls += ' is-today';
      if (iso === calValue) cls += ' is-on';
      html += '<button type="button" class="' + cls + '" data-d="' + iso + '">' +
        d.getDate() + '</button>';
    }
    $('calGrid').innerHTML = html;
    paintCalPicked();
  }

  function paintCalPicked() {
    var d = Store.parseDate(calValue);
    $('calPicked').textContent = d ? (d.getMonth() + 1) + '月' + d.getDate() + '日' : '未选择';
    $('calPickedWd').textContent = d ? wdCnMon((d.getDay() + 6) % 7) : '';
    var note = $('calNote');
    if (note) note.textContent = (d && calNoteFn) ? calNoteFn(calValue) : '';
  }

  function calShiftMonth(n) {
    calView = new Date(calView.getFullYear(), calView.getMonth() + n, 1);
    renderCal();
  }

  function calPick(iso) {
    calValue = iso;
    var d = Store.parseDate(iso);
    /* 点到上/下月的补位格就顺势翻到那个月，不然点完看不出发生了什么 */
    if (d && (d.getMonth() !== calView.getMonth() || d.getFullYear() !== calView.getFullYear())) {
      calView = new Date(d.getFullYear(), d.getMonth(), 1);
    }
    renderCal();
  }

  /* ============================================================
     三、滚轮
     ============================================================ */
  var whlCb = null;
  var whlEnd = null;       // (hhmm) -> 结束时间提示，没有就留空

  function pickTime(opts) {
    whlCb = opts;
    whlEnd = opts.endHint || null;
    $('timeTitle').textContent = opts.title || '设置时间';

    var t = toMin(opts.value);
    if (t < 0) t = 8 * 60;                 // 认不出就给个常见的上课时间，不猜 00:00

    buildWheel($('whlHour'), 24);
    buildWheel($('whlMin'), 60);
    setWheel($('whlHour'), Math.floor(t / 60));
    setWheel($('whlMin'), t % 60);
    syncTimeReadout();
  }

  function buildWheel(box, count) {
    var html = '<i class="whl-pad"></i>';
    for (var i = 0; i < count; i++) {
      html += '<div class="whl-i" data-i="' + i + '">' + pad2(i) + '</div>';
    }
    html += '<i class="whl-pad"></i>';
    box.innerHTML = html;
    box._n = count;
    box._on = -1;
  }

  function setWheel(box, i) {
    box.scrollTop = i * WHEEL_H;
    markWheel(box, i);
  }

  /** 只改「上一项 / 这一项」两个 class，不整块重画（60 项 × 每一帧重画会卡） */
  function markWheel(box, i) {
    var prev = box.querySelector('.whl-i.is-on');
    if (prev && prev.classList) prev.classList.remove('is-on');
    var next = box.querySelector('.whl-i[data-i="' + i + '"]');
    if (next && next.classList) next.classList.add('is-on');
    box._on = i;
  }

  function wheelIdx(box) {
    var n = Math.round((box.scrollTop || 0) / WHEEL_H);
    var max = (box._n || 1) - 1;
    if (isNaN(n) || n < 0) n = 0;
    if (n > max) n = max;
    return n;
  }

  function onWheelScroll(box) {
    var n = wheelIdx(box);
    if (box._on !== n) { markWheel(box, n); syncTimeReadout(); }

    /* 不指望 CSS 的 scroll-snap（老 WebView 认不得）：滚完停一下自己吸正。
       必须判「差得多不多」再写 scrollTop —— 无条件回写会和 scroll 事件
       互相触发成死循环。 */
    clearTimeout(box._t);
    box._t = setTimeout(function () {
      var want = n * WHEEL_H;
      if (Math.abs((box.scrollTop || 0) - want) > 1) box.scrollTop = want;
    }, WHEEL_SNAP_MS);
  }

  function wheelValue() {
    var h = $('whlHour')._on, m = $('whlMin')._on;
    if (!(h >= 0)) h = 0;
    if (!(m >= 0)) m = 0;
    return pad2(h) + ':' + pad2(m);
  }

  function syncTimeReadout() {
    var v = wheelValue();
    $('timeBig').textContent = v;
    var end = $('timeEnd');
    if (end) end.textContent = whlEnd ? whlEnd(v) : '';
  }

  /* ============================================================
     绑定：三层的按钮与手势只绑一次（DOM 是静态的，值每次开的时候再填）
     ============================================================ */
  function closestAttr(el, attr, root) {
    while (el && el !== root) {
      if (el.getAttribute && el.getAttribute(attr) !== null) return el;
      el = el.parentNode;
    }
    return null;
  }

  function bind() {
    // —— 单选列表
    $('pickList').addEventListener('click', function (e) {
      var el = closestAttr(e.target || e.srcElement, 'data-v', this);
      if (!el || !listOpts || !listOpts.onPick) return;
      listOpts.onPick(el.getAttribute('data-v'));
    });
    $('pickCancel').addEventListener('click', function () {
      if (listOpts && listOpts.onCancel) listOpts.onCancel();
    });

    // —— 月历
    $('calPrev').addEventListener('click', function () { calShiftMonth(-1); });
    $('calNext').addEventListener('click', function () { calShiftMonth(1); });
    $('calGrid').addEventListener('click', function (e) {
      var el = closestAttr(e.target || e.srcElement, 'data-d', this);
      if (el) calPick(el.getAttribute('data-d'));
    });
    $('calSave').addEventListener('click', function () {
      if (calCb && calCb.onConfirm && Store.parseDate(calValue)) calCb.onConfirm(calValue);
    });
    $('calCancel').addEventListener('click', function () {
      if (calCb && calCb.onCancel) calCb.onCancel();
    });

    // —— 滚轮
    ['whlHour', 'whlMin'].forEach(function (id) {
      var box = $(id);
      box.addEventListener('scroll', function () { onWheelScroll(box); }, { passive: true });
    });
    $('timeSave').addEventListener('click', function () {
      if (whlCb && whlCb.onConfirm) whlCb.onConfirm(wheelValue());
    });
    $('timeCancel').addEventListener('click', function () {
      if (whlCb && whlCb.onCancel) whlCb.onCancel();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  global.Picker = {
    list: pickList,
    date: pickDate,
    time: pickTime,
    WHEEL_H: WHEEL_H     // 测试拿它对 CSS，别在别处写死 40
  };
})(typeof window !== 'undefined' ? window : this);
