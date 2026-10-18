/* ============================================================
   app.js —— 界面渲染与交互
   ------------------------------------------------------------
   屏幕适配策略：
   · 安全区（状态栏 / 导航栏 / 刘海）由原生下发像素值，页面自绘留白
   · 行高由 JS 按可视高度动态计算，保证一屏恰好容纳 8 节课
   · 七列等宽、无最小宽度 —— 周一至周日同屏完整展示，不横向滚动
   · 课表区域支持左右滑动切换周次（纵向滚动不受影响）
   ============================================================ */
(function (global) {
  'use strict';

  var Store = global.Store;
  var Import = global.ImportUtil;
  var S = Store.state;

  var HUES = global.Store.HUES;   // 自动配色的色相池，单一来源在 store.js
  var VISIBLE_ROWS = 8;           // 一个屏幕最多同时显示的节数
  var MIN_ROW_H = 44;             // 行高下限（极小屏时允许滚动）
  var MAX_ROW_H = 132;            // 行高上限（平板/横屏避免过于空旷）
  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- 工具 ----------------
     课程取色（hueOf / storedHue / hueOfCourse）已下沉到 store.js：
     桌面小组件同样要给课程上色，两份实现必然漂移
     （表现就是「课表上是薄荷绿、桌面小组件上是深蓝」）。
     这里保留同名转发，调用点一个都不用改。 */
  function hueOf(text) { return Store.hueOf(text); }

  function storedHue(c) { return Store.storedHue(c); }

  function hueOfCourse(c) { return Store.hueOfCourse(c); }

  /**
   * 这门课**手动挑过**的颜色（'#RRGGBB'），没挑过返回 null。
   * 三种来源按优先级：自定义色值 → v1.9.5 存的色相（折算成等价色值，
   * 升级后颜色一个都不变）→ null（自动，按课程名算）。
   * 表单回显、取色器起点都走这一处，避免两处口径不一致。
   */
  function courseColor(c) {
    var col = Store.storedColor(c);
    if (col) return col;
    var h = storedHue(c);
    return h === null ? null : Store.cardHex(h);
  }

  /** 卡片底色（内联成 --bg）：自定义色值原样用，其余按色相算 */
  function courseBg(c) {
    var col = Store.storedColor(c);
    return col ? col : Store.cardBg(hueOfCourse(c));
  }

  /* HTML 转义：唯一实现已下沉到 store.js（v1.9.45 收口）。
     这里保留同名转发，调用点一个都不用改 —— 与 hueOf / storedHue 同一套做法。
     为什么必须收口：picker.js 里原本还存着第二份，而且漏转义了单引号。 */
  function esc(s) { return Store.esc(s); }

  /**
   * 教室名转义 + 断行优化：
   * 「博学（4）-403」这类写法在窄列里会被从括号中间拆成「博学（4」/「）-403」，
   * 这里把括号组包成不可断行单元，只在括号组之间、连字符处换行。
   */
  function escLoc(s) {
    var raw = String(s == null ? '' : s);
    // 括号组（如「（4）」）与门牌数字（如「-403」）各自作为整体，不从中途断开
    var RE = /[（(][^）)]{0,6}[）)]|[-–—]?\d+/g;
    var out = '', last = 0, m;
    RE.lastIndex = 0;
    while ((m = RE.exec(raw)) !== null) {
      out += esc(raw.slice(last, m.index));
      out += '<span class="nb">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    return out + esc(raw.slice(last));
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1900);
  }

  /* 写盘没成功时的唯一提示出口（挂在 Store.onSaveError 上）。
     为什么集中在这里、而不是让 9 处 Store.save() 的调用方各写各的：
     那些调用方的下一句往往就是「设置已保存 / 已添加课程」，
     失败提示必须**盖过**它、而不是和它一起弹（一起弹等于告诉用户存好了）。
     节流 4 秒：连续写盘失败只提示一次，不然会刷屏。 */
  var lastSaveErrAt = 0;
  /* 一句话在两个地方用：课表写盘失败（notifySaveError）、学校地址簿写盘失败。
     措辞刻意点名「没有写入」——比「保存失败」多告诉用户一件事：
     重启之后刚才的改动就没了，别以为已经存好。 */
  var SAVE_FAIL_MSG = '保存失败：存储空间不足或处于隐私模式，刚才的改动没有写入';

  function notifySaveError() {
    var now = Date.now();
    if (now - lastSaveErrAt < 4000) return;
    lastSaveErrAt = now;
    toast(SAVE_FAIL_MSG);
  }

  function openMask(id) { $(id).classList.add('show'); }
  function closeMask(id) { $(id).classList.remove('show'); }

  /**
   * 关掉所有正在显示的弹层（原生返回键、场景切换时的兜底）。
   *
   * 刻意不写死名单：遍历现存的 .mask 才不可能漏。
   * v1.8.3 加「打开教务系统」那层时，就是因为它没被手写进名单，
   * 导致那一层返回键关不掉、点弹层外也关不掉。名单是漏项的温床。
   */
  function closeAllMasks() {
    var open = document.querySelectorAll('.mask.show');
    for (var i = 0; i < open.length; i++) open[i].classList.remove('show');
  }

  /**
   * 「子弹层 → 它该退回去的那一层」。
   * 子弹层是从某个弹层里点开的，关掉它不该把人直接扔回课表，
   * 而是亮回父层——父层 DOM 内容还在，重新 show 即恢复，上下文不丢。
   */
  /* 三件自绘选择器（v1.9.15）的退回目标。pickParent 是变量：同一个单选
     列表层要服务三个入口——设置页的「每节课时长」、添加课程的「星期」、
     导入弹层的「目标课表」。 */
  var pickParent = 'maskSettings';

  /* **取消按钮、系统返回键、点弹层外**三处共用这三个函数。
     同一层三个出口行为一致，最硬的写法就是只有一份实现。 */
  function backFromPick() { closeMask('maskPick'); openMask(pickParent); }
  function backFromDate() { closeMask('maskDate'); openMask('maskSettings'); }
  function backFromTime() { closeMask('maskTime'); openMask('maskTimetable'); }

  /* ============================================================
     自绘确认框（替代 window.confirm）
     ------------------------------------------------------------
     为什么不用 confirm：它的皮肤由 WebView 的 onJsConfirm 决定 ——
     弹出的还是系统 AlertDialog，而应用自己的白天 / 夜晚是页面按
     localStorage 定的（本工程 values-night 里 Activity 是深色 Material），
     两者可以不一致，于是白天暖米色页面上弹出一块冷灰。这跟 v1.9.15
     换掉四处原生控件是**同一个理由**，不是新规矩。
     顺带还解决一件事：confirm 是同步阻塞的，弹着的时候整个页面冻住。
     ============================================================ */
  /* 与 pickParent 同一个写法：父层是变量，因为同一层要服务三个入口
     （课表管理删课表 / 设置清空课表 / 课程详情删课程）。 */
  var confirmParent = null;   // 取消 / 返回键 / 点弹层外之后亮回哪一层
  var confirmOnOk = null;     // 点「确定」时执行的动作（自己决定收尾）

  /**
   * 打开确认框。
   * @param {{parent?:string, title?:string, message?:string,
   *          okText?:string, danger?:boolean, onOk?:function}} opts
   *   parent 传了就先收掉它（弹层不许叠），取消时再原样亮回来。
   */
  function openConfirm(opts) {
    opts = opts || {};
    confirmParent = opts.parent || null;
    confirmOnOk = opts.onOk || null;

    $('confirmTitle').textContent = opts.title || '确认';
    $('confirmMsg').textContent = opts.message || '';
    var ok = $('confirmOk');
    ok.textContent = opts.okText || '确定';
    // 三处都是破坏性动作，默认红字；显式传 danger:false 才用主色实心
    ok.className = 'btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger');

    if (confirmParent) closeMask(confirmParent);
    openMask('maskConfirm');
  }

  /* 「取消按钮 / 系统返回键 / 点弹层外」三个出口共用这一份实现：
     一律是「什么都不做 + 退回调用它的那一层」。 */
  function backFromConfirm() {
    closeMask('maskConfirm');
    confirmOnOk = null;
    if (confirmParent) openMask(confirmParent);
  }

  /* 点「确定」：先收掉确认框再执行动作 —— 动作收尾自己决定亮回哪一层
     （删课表 / 清空课表要退回原弹层，删课程则应一路回到课表）。 */
  function okConfirm() {
    var fn = confirmOnOk;
    closeMask('maskConfirm');
    confirmOnOk = null;
    if (typeof fn === 'function') fn();
  }

  var BULLET_BACK = {
    maskCopy: backToDetail,          // 复制菜单   ← 课程详情
    maskSchool: backToImport,        // 打开教务系统 ← 导入课表
    maskTimetable: backToSettings,   // 编辑时间表  ← 设置
    maskColor: backToAdd,            // 取色器     ← 添加 / 编辑课程
    maskPick: backFromPick,          // 单选列表   ← 时长 / 星期 / 目标课表
    maskDate: backFromDate,          // 月历       ← 设置
    maskTime: backFromTime,          // 滚轮       ← 编辑时间表
    maskConfirm: backFromConfirm,    // 确认框     ← 上面三处任一
    maskSendTo: backToShare          // 发送到聊天 ← 分享课表
  };

  /**
   * 系统返回键的网页侧入口。返回 true = 这次返回已被消费掉。
   *
   * 顺序要紧：先处理子弹层（退回父层），剩下的才整层关闭。
   * 反过来的话，一按返回就把所有弹层一起掀了。
   */
  function handleBack() {
    var open = document.querySelectorAll('.mask.show');
    for (var i = 0; i < open.length; i++) {
      var back = BULLET_BACK[open[i].id];
      if (back) { back(); return true; }
    }
    if (open.length) { closeAllMasks(); return true; }
    return false;
  }

  /** 沿父链查找带指定属性的祖先节点（避免依赖 Element.closest 的可用性） */
  function closestBy(node, attr) {
    while (node && node !== document) {
      if (node.getAttribute && node.getAttribute(attr)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function rowHeight() {
    var v = getComputedStyle(document.documentElement).getPropertyValue('--row-h');
    var n = parseFloat(v);
    return isNaN(n) ? 56 : n;
  }

  /* 卡片与泳道边缘的留白。去线之后卡片之间没有任何分隔线，全靠这个留白
     把相邻两节课分开，所以它的值由 CSS（--card-pad-x / --card-pad-y）统一给出，
     避免两处各写一份。**横纵分开读**（v1.9.11）：横向那道缝还要和列间距
     --col-gap 一起算，纵向只由 pad-y 决定，两者的取值理由不一样。
     读不到就退回与 CSS 默认相同的值。 */
  function cssPx(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    var n = parseFloat(v);
    return isNaN(n) ? fallback : n;
  }
  function cardPadX() { return cssPx('--card-pad-x', 2); }
  function cardPadY() { return cssPx('--card-pad-y', 3); }

  function today() { return new Date(); }
  function currentWeek() { return Store.weekOf(today(), S.settings.semesterStart); }
  function maxWeek() { return Math.max(1, S.settings.totalWeeks || 18); }

  /* ============================================================
     主题：白天模式 / 夜晚模式
     ------------------------------------------------------------
     · <html data-theme="light|dark"> 是唯一的开关，CSS 只认这个属性；
     · 'auto' 由 Store.effectiveTheme() 解析成实际的 light/dark，
       所以样式表里不需要再写一份 @media (prefers-color-scheme)；
     · 同时把结果告诉原生（状态栏图标要跟着反色）与 <meta theme-color>。
     ============================================================ */
  /* 状态栏 / 地址栏底色 = 两个主题各自的 --surface，改 --surface 时要一起改
     （白天 #fffdf8 暖白、夜晚 #1d1913 暖黑，见 web/css/app.css 的品牌色块）。 */
  var THEME_COLOR = { light: '#fffdf8', dark: '#1d1913' };

  function applyTheme() {
    var t = Store.effectiveTheme();

    var root = document.documentElement;
    if (root && root.setAttribute) root.setAttribute('data-theme', t);

    var meta = (document.querySelector)
      ? document.querySelector('meta[name="theme-color"]') : null;
    if (meta && meta.setAttribute) meta.setAttribute('content', THEME_COLOR[t]);

    // 状态栏是透明浮在页面上的，图标颜色必须跟着主题反色
    var bridge = global.AndroidTheme;
    if (bridge && typeof bridge.setDark === 'function') {
      try { bridge.setDark(t === 'dark' ? 1 : 0); } catch (e) { /* 忽略 */ }
    }

    syncSegTheme();
  }

  /** 设置弹层里的三段选择器高亮 */
  function syncSegTheme() {
    var seg = $('segTheme');
    if (!seg || !seg.querySelectorAll) return;
    var cur = Store.theme();
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var on = b.getAttribute && b.getAttribute('data-theme') === cur;
      if (!b.classList) continue;
      if (on) b.classList.add('is-on'); else b.classList.remove('is-on');
    }
  }

  /** 顶栏按钮：在白天 / 夜晚之间直接切换（不受「跟随系统」影响） */
  function toggleTheme() {
    var next = Store.effectiveTheme() === 'dark' ? 'light' : 'dark';
    Store.setTheme(next);
    applyTheme();
    toast(next === 'dark' ? '已切换到夜晚模式' : '已切换到白天模式');
  }

  /* ============================================================
     需求 1：安全区 —— 顶部让开状态栏、底部让开导航栏
     原生侧通过 AndroidSafeArea.insets() 返回 {top,bottom,left,right}（CSS 像素）
     浏览器打开时该方法不存在，自动回退到 CSS env()
     ============================================================ */
  function applySafeArea() {
    var bridge = global.AndroidSafeArea;
    if (!bridge || typeof bridge.insets !== 'function') return false;
    try {
      var v = JSON.parse(bridge.insets());
      var st = document.documentElement.style;
      st.setProperty('--safe-top', (v.top || 0) + 'px');
      st.setProperty('--safe-bottom', (v.bottom || 0) + 'px');
      st.setProperty('--safe-left', (v.left || 0) + 'px');
      st.setProperty('--safe-right', (v.right || 0) + 'px');
      return true;
    } catch (e) { return false; }
  }

  /* ============================================================
     需求 2：一屏恰好 8 节（不足 8 节则铺满），其余纵向滚动
     返回 true 表示行高发生变化，需要重新排版
     ============================================================ */
  function fitRows() {
    var wrap = $('gridWrap');
    if (!wrap) return false;

    var avail = wrap.clientHeight;
    if (!avail || avail < 140) return false;   // 尚未完成布局（或测试环境）时保持 CSS 默认值

    var headEl = document.querySelector('.head-row');
    var headH = (headEl && headEl.offsetHeight) ? headEl.offsetHeight : 42;

    var sections = S.settings.sections || VISIBLE_ROWS;
    var rows = Math.max(1, Math.min(sections, VISIBLE_ROWS));
    var h = Math.floor((avail - headH) / rows);
    h = Math.max(MIN_ROW_H, Math.min(MAX_ROW_H, h));

    var cur = parseFloat(document.documentElement.style.getPropertyValue('--row-h'));
    if (cur === h) return false;

    document.documentElement.style.setProperty('--row-h', h + 'px');
    return true;
  }

  /** 底部渐隐提示：还有更多节次可滚动 */
  function updateFade() {
    var wrap = $('gridWrap'), f = $('scrollFade');
    if (!wrap || !f || !wrap.scrollHeight) return;
    var more = wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop;
    if (more > 4) f.classList.add('show');
    else f.classList.remove('show');
  }

  /* ============================================================
     渲染：顶部信息（年月日 / 第几周 / 单双周）
     ============================================================ */
  function renderTop() {
    var now = today();
    var w = currentWeek();
    var total = S.settings.totalWeeks;
    var parityEl = $('parityText');

    // 窄屏顶栏横向空间紧张，省掉年份（当天的年份信息量最低）
    var narrow = (global.innerWidth || 999) < 390;
    $('dateText').textContent = narrow
      ? (now.getMonth() + 1) + '月' + now.getDate() + '日'
      : now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日';
    $('weekdayText').textContent = Store.WEEKDAY_CN[now.getDay()];
    $('termTip').textContent = '共' + total + '周';

    // 当前课表名（顶栏切换器）
    var cur = Store.current();
    $('curSchedName').textContent = cur ? cur.name : '我的课表';

    // 顶栏横向空间紧张，文案尽量短：需要说明的额外信息放第二行
    if (parityEl.classList) parityEl.classList.remove('is-off');

    if (w < 1) {
      // 开学前没有单/双周可言，把「距离开学还有多久」放到第二行
      $('weekText').textContent = '未开学';
      parityEl.textContent = '';
      if (parityEl.classList) parityEl.classList.add('is-off');
      $('termTip').textContent = '还有 ' + Math.abs((w - 1) * 7) + ' 天';
    } else if (w > total) {
      $('weekText').textContent = '第 ' + w + ' 周';
      parityEl.textContent = '已结束';
      $('termTip').textContent = '共' + total + '周';
    } else {
      $('weekText').textContent = '第 ' + w + ' 周';
      parityEl.textContent = Store.parityText(w);
    }
  }

  /* ============================================================
     渲染：周次切换栏
     ============================================================ */
  function renderWeekBar() {
    var w = S.viewWeek;
    $('curWeekText').textContent = '第 ' + w + ' 周';

    var mon = Store.mondayOfWeek(w, S.settings.semesterStart);
    var sun = Store.addDays(mon, 6);
    $('curRangeText').textContent = (mon.getMonth() + 1) + '/' + mon.getDate() +
      ' - ' + (sun.getMonth() + 1) + '/' + sun.getDate() + ' · ' + Store.parityText(w);

    var cw = currentWeek();
    var btn = $('btnToday');
    btn.textContent = (w === cw) ? '本周' : '回到本周';
    btn.style.color = (w === cw) ? '' : 'var(--accent)';
    btn.style.borderColor = (w === cw) ? '' : 'var(--accent)';
  }

  /* ============================================================
     渲染：课表主体
     ============================================================ */
  function renderGrid() {
    var wrap = $('gridWrap');
    var sch = $('schedule');
    var w = S.viewWeek;
    var mon = Store.mondayOfWeek(w, S.settings.semesterStart);
    var now = today();
    var todayStr = Store.fmtDate(now);
    var sections = S.settings.sections;
    var times = S.settings.times;
    var rh = rowHeight();
    /* 卡片留白横纵分开（v1.9.11）：
       · padX 决定相邻两天的缝 —— 还要加上 CSS 的 --col-gap 才够（见那边注释）；
       · padY 决定同一列里上下相邻两节课的缝。 */
    var padX = cardPadX();
    var padY = cardPadY();

    // 清理滑动过程中的临时内联样式
    sch.style.transition = 'none';
    sch.style.transform = '';
    sch.style.opacity = '';

    var html = '';

    /* --- 表头：七列，周一 ~ 周日 ---
       is-weekend / is-today 只是语义标记：
       去线改版后七个天列的底色已完全统一，周末不再有特殊底色，
       所以 is-weekend 目前没有对应样式；is-today 仅用于把日期标成实心高亮块
       （v1.9.10 起是圆角矩形，早期是圆点）。 */
    html += '<div class="head-row"><div class="corner"></div>';
    for (var d = 1; d <= 7; d++) {
      var dt = Store.addDays(mon, d - 1);
      var cls = 'day-head';
      if (Store.fmtDate(dt) === todayStr) cls += ' is-today';
      if (d >= 6) cls += ' is-weekend';
      html += '<div class="' + cls + '"><span class="dw">' + Store.WEEKDAY_SHORT[d % 7] + '</span>' +
        '<span class="dd">' + (dt.getMonth() + 1) + '/' + dt.getDate() + '</span></div>';
    }
    html += '</div>';

    /* --- 主体 --- */
    html += '<div class="body">';

    html += '<div class="time-col">';
    for (var i = 1; i <= sections; i++) {
      var t = times[i - 1] || { start: '', end: '' };
      html += '<div class="slot-time"><span class="no">' + i + '</span>' +
        '<span class="tm">' + esc(t.start) + '<br>' + esc(t.end) + '</span></div>';
    }
    html += '</div>';

    for (var day = 1; day <= 7; day++) {
      var dcol = Store.addDays(mon, day - 1);
      var dcolStr = Store.fmtDate(dcol);
      var c2 = 'day-col';
      if (dcolStr === todayStr) c2 += ' is-today';
      if (day >= 6) c2 += ' is-weekend';

      var list = S.courses.filter(function (c) {
        /* `+c.day` 而不是 `c.day`：课程里的星期一律当数字看，与 store.js 的
           dayCourses（`+c.day !== day`）口径一致。手改过 localStorage、
           或老版本留下的 `day: "3"` 这类字符串，严格比较会被静默漏掉 ——
           同一门课会在课表页看不见、在桌面小组件里却看得见。 */
        return +c.day === day && c.weeks && c.weeks.indexOf(w) >= 0;
      });

      html += '<div class="' + c2 + '" data-day="' + day + '" style="height:' + (sections * rh) + 'px">';

      if (list.length) {
        layout(list, day);
        list.forEach(function (c) {
          var span = c.end - c.start + 1;
          var top = (c.start - 1) * rh + padY;
          var h = span * rh - padY * 2;
          var hue = hueOfCourse(c);   // 别叫 h：上面那个 h 是卡片高度
          html += '<div class="course" data-id="' + c.id + '" data-span="' + span + '" ' +
            /* 键盘可达（v1.9.45）：卡片本来是纯 div + click，键盘 / 读屏用户
               进不去课程详情。tabindex=0 让它进 Tab 序，role=button 让读屏
               报「按钮」，aria-label 给出「课名 + 教室」的读法（卡片里
               默认只显示这两样，隐藏的教师 / 周次不必念）。
               回车 / 空格的处理在 bindCourseClicks 里。 */
            'tabindex="0" role="button" aria-label="' + esc(c.name + (c.location ? ' ' + c.location : '')) + '" ' +
            'style="--h:' + hue + ';--bg:' + courseBg(c) +
            ';top:' + top + 'px;height:' + h + 'px;' +
            'left:calc(' + c._l + '% + ' + padX + 'px);width:calc(' + c._w + '% - ' + (padX * 2) + 'px);right:auto">' +
            /* 默认只显示：课程名 + 教室 */
            '<div class="c-name">' + esc(c.name) + '</div>' +
            (c.location ? '<div class="c-meta loc">' + escLoc(c.location) + '</div>' : '') +
            /* 以下信息默认隐藏（CSS display:none），点击卡片后在详情中查看 */
            (c.teacher ? '<div class="c-meta teacher">' + esc(c.teacher) + '</div>' : '') +
            '<div class="c-weeks">' + esc(c.weeksText || Store.formatWeeks(c.weeks)) + '</div>' +
            '</div>';
        });
      }
      html += '</div>';
    }

    html += '</div>'; // .body
    sch.innerHTML = html;

    /* --- 空状态 --- */
    var oldEmpty = wrap.querySelector('.empty');
    if (oldEmpty) oldEmpty.remove();
    if (!S.courses.length) {
      var curName = Store.current() ? Store.current().name : '当前课表';
      var e = document.createElement('div');
      e.className = 'empty';
      e.innerHTML = '<span class="big">📚</span>「' + esc(curName) + '」还没有课程<br>' +
        '点右上角「导入课表」选文件，或点「＋」手动添加';
      wrap.appendChild(e);
    }

    bindCourseClicks();
    updateFade();
  }

  /** 同一天内重叠课程并排显示（按周次错开的课程不会同时出现） */
  function layout(list) {
    var items = list.slice().sort(function (a, b) {
      return a.start - b.start || a.end - b.end;
    });
    var cluster = [], clusterEnd = -1;

    function flush() {
      if (!cluster.length) return;
      var k = cluster.length;
      cluster.forEach(function (c, i) {
        c._w = 100 / k;
        c._l = i * (100 / k);
      });
      cluster = []; clusterEnd = -1;
    }

    items.forEach(function (c) {
      if (cluster.length && c.start > clusterEnd) flush();
      cluster.push(c);
      clusterEnd = Math.max(clusterEnd, c.end);
    });
    flush();
  }

  function bindCourseClicks() {
    var nodes = document.querySelectorAll('.course');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].addEventListener('click', function () {
        showDetail(this.getAttribute('data-id'));
      });
      /* 键盘（v1.9.45）：回车 / 空格等同于点一下。
         `preventDefault()` 是必须的 —— 空格在可聚焦元素上的默认行为是
         滚动页面，不拦就会「按空格课表往下跳一屏 + 打开详情」两件事一起发生。 */
      nodes[i].addEventListener('keydown', function (e) {
        var k = e.key;
        if (k === 'Enter' || k === ' ' || k === 'Spacebar' || e.keyCode === 13 || e.keyCode === 32) {
          e.preventDefault();
          showDetail(this.getAttribute('data-id'));
        }
      });
    }
  }

  function render(opts) {
    renderTop();
    renderWeekBar();
    fitRows();                       // 依据可视高度算行高（首次用估值）
    renderGrid();
    if (fitRows()) renderGrid();     // 表头实测高度导致行高变化时再排一次
    if (opts && opts.slide) animateIn(opts.slide);
  }

  /* ============================================================
     需求 4：左右滑动切换周次
     ============================================================ */
  function maxWeekClamp(w) { return Math.max(1, Math.min(maxWeek(), w)); }

  function goWeek(w, slide) {
    w = maxWeekClamp(w);
    if (w === S.viewWeek) return;
    S.viewWeek = w;
    render({ slide: slide });
    scrollToTop();                   // 切周后固定回到第 1 节（一屏 1-8 节）
  }

  function animateIn(dir) {
    var sch = $('schedule');
    if (!sch) return;
    sch.classList.remove('slide-from-right', 'slide-from-left');
    void sch.offsetWidth;            // 强制重排，让动画可重复播放
    sch.classList.add(dir === 'left' ? 'slide-from-right' : 'slide-from-left');
    setTimeout(function () {
      sch.classList.remove('slide-from-right', 'slide-from-left');
    }, 280);
  }

  function bindSwipe() {
    var wrap = $('gridWrap');
    var sch = $('schedule');
    if (!wrap || !sch || !wrap.addEventListener) return;

    var startX = 0, startY = 0, dx = 0, axis = null, dragging = false;

    function clearInline(animate) {
      if (animate) {
        sch.style.transition = 'transform .18s ease, opacity .18s ease';
        sch.style.transform = '';
        sch.style.opacity = '';
        setTimeout(function () { sch.style.transition = ''; }, 220);
      } else {
        sch.style.transition = 'none';
        sch.style.transform = '';
        sch.style.opacity = '';
      }
    }

    function onDown(e) {
      if (e.isPrimary === false) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startX = e.clientX; startY = e.clientY;
      dx = 0; axis = null; dragging = true;
      sch.style.transition = 'none';
    }

    function onMove(e) {
      if (!dragging) return;
      var mx = e.clientX - startX;
      var my = e.clientY - startY;

      if (axis === null) {
        if (Math.abs(mx) < 12 && Math.abs(my) < 12) return;
        // 横向意图明显才算切周手势，否则让浏览器纵向滚动
        axis = Math.abs(mx) > Math.abs(my) * 1.25 ? 'x' : 'y';
        if (axis === 'y') { dragging = false; sch.style.transition = ''; return; }
      }

      dx = mx;
      var atEdge = (dx > 0 && S.viewWeek <= 1) || (dx < 0 && S.viewWeek >= maxWeek());
      var shift = atEdge ? dx * 0.3 : dx;             // 首/末周加阻尼
      sch.style.transform = 'translateX(' + shift + 'px)';
      sch.style.opacity = String(Math.max(0.5, 1 - Math.abs(shift) / 460));
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      if (axis !== 'x') { clearInline(false); return; }

      var need = Math.max(46, (wrap.clientWidth || 360) * 0.16);
      if (dx <= -need && S.viewWeek < maxWeek()) { dx = 0; goWeek(S.viewWeek + 1, 'left'); return; }
      if (dx >= need && S.viewWeek > 1) { dx = 0; goWeek(S.viewWeek - 1, 'right'); return; }
      dx = 0;
      clearInline(true);                               // 未过阈值：回弹
    }

    if (global.PointerEvent) {
      wrap.addEventListener('pointerdown', onDown);
      wrap.addEventListener('pointermove', onMove);
      wrap.addEventListener('pointerup', onUp);
      wrap.addEventListener('pointercancel', function () { dragging = false; axis = null; clearInline(false); });
    } else {
      wrap.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) return;
        onDown({ isPrimary: true, clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
      });
      wrap.addEventListener('touchmove', function (e) {
        if (e.touches.length !== 1) return;
        onMove({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
      });
      wrap.addEventListener('touchend', onUp);
      wrap.addEventListener('touchcancel', function () { dragging = false; axis = null; clearInline(false); });
    }
  }

  /* ============================================================
     需求 5：点击课程 -> 展示全部信息 / 编辑 / 复制
     ------------------------------------------------------------
     详情弹层没有「关闭」按钮：① 向下拖出去 ② 点弹层外的空白处。
     底部三个按钮分别是编辑、复制、删除。
     ============================================================ */
  var detailId = null;          // 当前详情里的课程 id
  var editId = null;            // 非空 = 「添加课程」弹层正处在编辑模式

  function findCourse(id) {
    var hit = S.courses.filter(function (x) { return x.id === id; });
    return hit.length ? hit[0] : null;
  }

  /**
   * 清掉拖拽留下的内联位移 / 透明度 / 过渡。
   * animate=false 用于「打开前」，把上一次被拖走的痕迹直接抹掉，不留过渡。
   */
  function resetSheetInline(sheet, animate) {
    if (!sheet || !sheet.style) return;
    sheet.classList.remove('dragging');
    if (animate) {
      sheet.style.transition = 'transform .22s cubic-bezier(.22,.8,.3,1), opacity .22s ease';
      sheet.style.transform = '';
      sheet.style.opacity = '';
      setTimeout(function () { sheet.style.transition = ''; }, 260);
    } else {
      sheet.style.transition = 'none';
      sheet.style.transform = '';
      sheet.style.opacity = '';
    }
  }

  function showDetail(id) {
    var c = findCourse(id);
    if (!c) return;
    detailId = id;

    // 上一次可能正是被拖走的，先把痕迹清干净再打开
    var maskEl = $('maskDetail');
    resetSheetInline((maskEl && maskEl.querySelector) ? maskEl.querySelector('.sheet') : null, false);

    $('detailTitle').textContent = c.name;

    var t1 = S.settings.times[c.start - 1] || { start: '—', end: '—' };
    var t2 = S.settings.times[c.end - 1] || { start: '—', end: '—' };
    var span = c.end - c.start + 1;
    var odd = c.weeks.some(function (w) { return w % 2 === 1; });
    var even = c.weeks.some(function (w) { return w % 2 === 0; });
    var parity = (odd && even) ? '单双周均有' : (odd ? '仅单周' : (even ? '仅双周' : '—'));
    var inThisWeek = c.weeks.indexOf(S.viewWeek) >= 0;

    var rows = [
      ['星期', '星期' + Store.WEEKDAY_SHORT[c.day % 7]],
      ['节次', '第 ' + c.start + ' - ' + c.end + ' 节（共 ' + span + ' 节）'],
      ['时间', t1.start + ' - ' + t2.end],
      ['地点', c.location || '—'],
      ['教师', c.teacher || '—'],
      ['周次', c.weeksText || Store.formatWeeks(c.weeks)]
    ];

    var tags = '<div class="tags">' +
      '<span class="tag">' + esc(parity) + '</span>' +
      '<span class="tag plain">' + esc(Store.formatWeeks(c.weeks)) + '</span>' +
      '<span class="tag plain">' + (inThisWeek ? '第 ' + S.viewWeek + ' 周上课' : '第 ' + S.viewWeek + ' 周不上课') + '</span>' +
      '</div>';

    $('detailBody').innerHTML = tags + rows.map(function (r) {
      return '<div class="r"><span class="k">' + r[0] + '</span><span class="v">' + esc(r[1]) + '</span></div>';
    }).join('');

    openMask('maskDetail');
  }

  /* ============================================================
     详情弹层：向下拖拽关闭
     ------------------------------------------------------------
     · 只在弹层内容已经滚到顶部时才接管手势，否则优先让内容自己滚，
       避免「想翻内容却把弹层关掉」；
     · 松手时按位移（超过弹层高度的 1/4）或速度（快速甩一下）判定关闭，
       不够就回弹；
     · 拖动过程不加 transition 才跟手，松手后才加；
     · 拖完浏览器还会补一个 click，落点若正好在某张课程卡片上会立刻又弹出
       一份详情，所以必须把这一下吃掉。
     ============================================================ */
  function bindSheetDrag(maskId) {
    var mask = $(maskId);
    if (!mask || !mask.addEventListener || !mask.querySelector) return;
    var sheet = mask.querySelector('.sheet');
    if (!sheet || !sheet.addEventListener) return;

    var dragging = false, closing = false;
    var startY = 0, lastY = 0, lastT = 0, dy = 0, vel = 0;
    var swallowClick = null;

    function begin(y) {
      if (closing) return;
      dragging = false;
      startY = lastY = y;
      lastT = Date.now();
      dy = 0; vel = 0;
    }

    function move(y, ev) {
      if (closing) return;

      if (!dragging) {
        // 还没到「明显向下」的程度、或内容还没滚到顶 -> 这次手势不归我们管
        if (sheet.scrollTop > 0 || y - startY < 8) return;
        // 从接手这一刻重新算原点，位移从 0 开始，避免开头跳一下
        dragging = true;
        startY = lastY = y;
        lastT = Date.now();
        dy = 0;
        sheet.style.transition = 'none';
        sheet.classList.add('dragging');
        return;
      }

      dy = y - startY;
      if (dy < 0) dy = 0;
      // 真机上只有 preventDefault 能拦住原生滚动 / 下拉刷新
      if (ev && ev.cancelable) ev.preventDefault();

      var now = Date.now();
      if (now > lastT) vel = (y - lastY) / (now - lastT);   // px/ms，正 = 向下
      lastY = y; lastT = now;

      sheet.style.transform = 'translateY(' + dy + 'px)';
      sheet.style.opacity = String(Math.max(0.35, 1 - dy / 900));
    }

    function end() {
      if (closing || !dragging) return;
      dragging = false;
      sheet.classList.remove('dragging');
      killClick();                       // 不论关还是弹回，都别让补发的 click 落到卡片上

      var h = sheet.offsetHeight || 320;
      // 位移过了 1/4 弹层高，或者「甩」得够快，都算想关掉
      if (dy > h * 0.25 || (vel > 0.5 && dy > 28)) {
        closing = true;
        sheet.style.transition = 'transform .2s ease, opacity .2s ease';
        sheet.style.transform = 'translateY(' + (h + 40) + 'px)';
        sheet.style.opacity = '0';
        setTimeout(function () {
          closeMask(maskId);
          resetSheetInline(sheet, false);
          closing = false;
        }, 190);
      } else {
        resetSheetInline(sheet, true);   // 没拖够：弹回去
      }
    }

    function cancel() {
      if (closing || !dragging) return;
      dragging = false;
      resetSheetInline(sheet, true);
    }

    function killClick() {
      if (swallowClick) document.removeEventListener('click', swallowClick, true);
      swallowClick = function (e) {
        if (e.stopPropagation) e.stopPropagation();
        if (e.preventDefault) e.preventDefault();
        if (swallowClick) document.removeEventListener('click', swallowClick, true);
        swallowClick = null;
      };
      document.addEventListener('click', swallowClick, true);
      setTimeout(function () {
        if (swallowClick) document.removeEventListener('click', swallowClick, true);
        swallowClick = null;
      }, 400);
    }

    // —— 触摸：真机主路径。touchmove 里 preventDefault 才拦得住原生滚动
    sheet.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      begin(e.touches[0].clientY);
    }, { passive: true });

    sheet.addEventListener('touchmove', function (e) {
      if (e.touches.length !== 1) return;
      move(e.touches[0].clientY, e);
    }, { passive: false });

    sheet.addEventListener('touchend', function () { end(); });
    sheet.addEventListener('touchcancel', function () { cancel(); });

    // —— 鼠标：桌面浏览器 / 调试用；触摸设备不会走到这里
    function onMouseMove(e) { move(e.clientY, null); }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      end();
    }

    sheet.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      begin(e.clientY);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  /* ---------------- 复制到剪贴板 ----------------
     三层兜底，按「本机 WebView 里能不能用」的可靠性排序：
       ① 原生桥 AndroidClipboard —— 页面是 file:// 打开的，
          navigator.clipboard 在不同 WebView 版本上时有时无，原生最稳；
       ② execCommand('copy') —— 同步返回成败，file:// 下依然能用；
       ③ navigator.clipboard.writeText —— 现代浏览器的正路，但成败只能异步知道。
     在电脑浏览器里直接打开网页时，走 ② / ③。 */

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    document.body.appendChild(ta);
    var ok = false;
    try {
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
    } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    text = String(text == null ? '' : text);

    var bridge = global.AndroidClipboard;
    if (bridge && typeof bridge.copy === 'function') {
      try { bridge.copy(text); return true; } catch (e) { /* 落下一层 */ }
    }

    if (legacyCopy(text)) return true;

    if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        navigator.clipboard.writeText(text).catch(function () {});
        return true;
      } catch (e2) { /* 忽略 */ }
    }
    return false;
  }

  /** 「复制完整课程」的文本：够发给同学一眼看明白 */
  function courseFullText(c) {
    var t1 = S.settings.times[c.start - 1] || { start: '', end: '' };
    var t2 = S.settings.times[c.end - 1] || { start: '', end: '' };
    var span = t2.start && t1.end ? '（' + t1.start + '-' + t2.end + '）' : '';
    return [
      c.name,
      '时间：星期' + Store.WEEKDAY_SHORT[c.day % 7] + ' 第 ' + c.start + '-' + c.end + ' 节' + span,
      '地点：' + (c.location || '—'),
      '教师：' + (c.teacher || '—'),
      '周次：' + (c.weeksText || Store.formatWeeks(c.weeks))
    ].join('\n');
  }

  /** 从详情里点「复制」：先收掉详情再开复制菜单（弹层不叠），detailId 留着 */
  function openCopyMenu() {
    if (!detailId) return;
    closeMask('maskDetail');
    openMask('maskCopy');
  }

  /** 复制菜单收起后回到那张课程详情：取消 / 点外部 / 复制完都一样 */
  function backToDetail() {
    closeMask('maskCopy');
    if (detailId && findCourse(detailId)) showDetail(detailId);
  }

  function doCopy(kind) {
    var c = detailId ? findCourse(detailId) : null;
    if (!c) { closeMask('maskCopy'); return; }
    var text = kind === 'name' ? c.name : courseFullText(c);
    toast(copyText(text)
      ? (kind === 'name' ? '已复制课程名称' : '已复制完整课程信息')
      : '复制失败，请长按页面手动选取');
    backToDetail();
  }

  /* ============================================================
     分享课表（顶栏「分享」按钮）
     ------------------------------------------------------------
     两条出口共用同一份数据、同一套取数口径：
       · 复制到剪贴板 —— 给人看的纯文本，粘进聊天窗口就是一张课表；
       · 保存为 CSV   —— A→G 列与「导入课表 → 粘贴 CSV 文本」完全同序，
                         既能用 Excel 打开，也能原样再导回本应用。
     列序必须和导入端一致，否则「分享出去的文件导不回来」——而这一点
     单看哪一端都发现不了（两端各自都自洽），所以测试里有一条跨端哨兵。
     ============================================================ */

  /** 分享弹层上方那句说明：让用户确认「分享的是哪一张」 */
  function openShareSheet() {
    var cur = Store.current();
    if (!cur) { toast('没有可分享的课表'); return; }
    $('shareWhich').textContent = '「' + cur.name + '」';
    $('shareSummary').textContent =
      (S.courses.length ? S.courses.length + ' 门课程' : '还没有课程') +
      ' · 共 ' + (S.settings.totalWeeks || 18) + ' 周 · ' +
      (S.settings.semesterStart || '—') + ' 起';
    openMask('maskShare');
  }

  /** 按星期分组、按节次排序的整表文字；没有课程时也返回一句实话 */
  function scheduleShareText() {
    var cur = Store.current();
    var head = (cur ? cur.name : '我的课表') +
      '（' + (S.settings.semesterStart || '—') + ' 起，共 ' +
      (S.settings.totalWeeks || 18) + ' 周）';
    if (!S.courses.length) return head + '\n\n（还没有课程）';

    var out = [head, ''];
    for (var d = 1; d <= 7; d++) {
      var list = S.courses.filter(function (c) { return +c.day === d; })
        .sort(function (a, b) { return a.start - b.start || a.end - b.end; });
      if (!list.length) continue;

      out.push(Store.WEEKDAY_CN[d % 7]);
      list.forEach(function (c) {
        var t1 = S.settings.times[c.start - 1] || { start: '' };
        var t2 = S.settings.times[c.end - 1] || { end: '' };
        var span = (t1.start && t2.end) ? ' ' + t1.start + '-' + t2.end : '';
        // 全角空格当列分隔（聊天窗口里中英混排时对齐得住）
        var line = '  第 ' + c.start + '-' + c.end + ' 节' + span + '　' + c.name;
        if (c.location) line += '　' + c.location;
        if (c.teacher) line += '　' + c.teacher;
        line += '　[' + (c.weeksText || Store.formatWeeks(c.weeks)) + ']';
        out.push(line);
      });
      out.push('');
    }
    out.push('（由柚课生成）');
    return out.join('\n');
  }

  /** CSV 字段转义：含逗号 / 引号 / 换行的字段要用双引号包起来 */
  function csvField(v) {
    var s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * 整表转成 A→G 列的 CSV，与导入端同口径：
   *   课程名称,星期,开始节数,结束节数,老师,地点,周数
   * 星期写「周一…周日」、周数写 formatWeeks 的结果（「1-16」/「1-16 单」），
   * 两者都在导入端 parseDay / parseWeeksExpr 的识别范围内 —— 存出去的文件
   * 能被自己的导入功能原样吃回来。
   * 开头那个 BOM 是给 Excel 的：不然双击打开 UTF-8 CSV 会把中文显示成乱码；
   * 导入端 parseCsvText 第一步就剥 BOM，所以来回都不受影响。
   */
  function scheduleCsvText() {
    var rows = [['课程名称', '星期', '开始节数', '结束节数', '老师', '地点', '周数']];
    S.courses.slice()
      .sort(function (a, b) { return a.day - b.day || a.start - b.start || a.end - b.end; })
      .forEach(function (c) {
        rows.push([
          c.name,
          '周' + Store.WEEKDAY_SHORT[c.day % 7],
          c.start,
          c.end,
          c.teacher || '',
          c.location || '',
          c.weeksText || Store.formatWeeks(c.weeks)
        ]);
      });
    return '\uFEFF' + rows.map(function (r) {
      return r.map(csvField).join(',');
    }).join('\r\n') + '\r\n';
  }

  /** 文件名：课表名里可能有斜杠 / 冒号这类不能进文件名的字符，先剃掉 */
  function csvFileName() {
    var cur = Store.current();
    var base = String((cur && cur.name) || '我的课表')
      .replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24) || '我的课表';
    return '柚课-' + base + '-' + Store.fmtDate(today()) + '.csv';
  }

  /** 浏览器里的落盘方式：Blob + 一个隐藏的 <a download> */
  function saveViaBlob(fileName, text, mime) {
    try {
      if (!global.Blob || !global.URL || !URL.createObjectURL) return false;
      var url = URL.createObjectURL(new Blob([text], { type: mime || 'text/csv;charset=utf-8' }));
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return true;
    } catch (e) { return false; }
  }

  function shareByCopy() {
    var ok = copyText(scheduleShareText());
    closeMask('maskShare');
    toast(ok ? '整张课表已复制，粘贴即可发送' : '复制失败，请长按页面手动选取');
  }

  /**
   * 保存 CSV。三条路按「本机能不能真落盘」排序：
   *   ① 原生桥 AndroidExport —— 页面是 file:// 的 WebView，`<a download>`
   *      与 Blob 在没有 DownloadListener 的情况下会被**静默丢弃**
   *      （用户以为存好了，其实什么都没有），所以原生才是唯一可靠的一路；
   *   ② Blob + <a download> —— 电脑浏览器里直接打开网页时走这条；
   *   ③ 都不行就说实话，别让用户以为存了。
   */
  function shareByCsv() {
    var fileName = csvFileName();
    var text = scheduleCsvText();

    var bridge = global.AndroidExport;
    if (bridge && typeof bridge.saveFile === 'function') {
      var r = '';
      try { r = String(bridge.saveFile(fileName, 'text/csv', text) || ''); } catch (e) { r = ''; }
      if (r.indexOf('ok:') === 0) {
        /* 存好了顺手问一句「要不要直接发出去」——用户的下一步本来就是发给同学。
           这里刻意**不弹 toast**：路径已经写进弹层那句说明里了，再叠一条
           toast 会正好盖住弹层上的两个按钮（出截图时踩过这个坑）。 */
        openSendTo({ savedPath: r.slice(3) });
        return;
      }
      if (r.indexOf('err:') === 0) {
        toast('保存失败：' + r.slice(4));
        return;
      }
    }

    if (saveViaBlob(fileName, text)) {
      closeMask('maskShare');
      toast('已导出 ' + fileName);
      return;
    }

    toast('这个环境存不了文件，请改用「复制到剪贴板」');
  }

  /* ---------------- 全量备份 / 恢复（v1.9.45） ----------------
     与「保存 CSV」是两条不同的出口：CSV 走的是**课程**，这里走的是**整份数据**
     （所有课表 + 每张课表自己的时间表 / 总周数 / 开学日）。换手机靠的是后者 ——
     只用 CSV 搬完，用户会看到「课都在，但上课时间全错」。               */

  /** 导出全部数据（.json）。落盘三条路与「保存 CSV」完全一致。 */
  function backupAll() {
    var fileName = '柚课备份-' + Store.fmtDate(new Date()) + '.json';
    var text = Store.exportAll();

    var bridge = global.AndroidExport;
    if (bridge && typeof bridge.saveFile === 'function') {
      var r = '';
      try { r = String(bridge.saveFile(fileName, 'application/json', text) || ''); } catch (e) { r = ''; }
      if (r.indexOf('ok:') === 0) { toast('已导出 ' + fileName); return; }
      if (r.indexOf('err:') === 0) { toast('导出失败：' + r.slice(4)); return; }
    }
    if (saveViaBlob(fileName, text, 'application/json;charset=utf-8')) {
      toast('已导出 ' + fileName);
      return;
    }
    toast('这个环境存不了文件');
  }

  /**
   * 从备份文本恢复。**顺序是刻意的**：先解析校验 → 再问一次（会说清覆盖几张课表）
   * → 才落地。校验不过就到此为止，连确认框都不弹 —— 那种情况多半只是用户选错了文件。
   */
  function restoreFromText(text) {
    var check = Store.parseBackup(text);
    if (check.error) { toast('恢复失败：' + check.error); return false; }
    var n = check.data.schedules.length;
    openConfirm({
      parent: 'maskSettings',
      title: '从备份恢复',
      message: '备份里有 ' + n + ' 张课表。\n\n' +
        '恢复会**整份替换**你现在所有课表与设置，当前数据不再保留。',
      okText: '覆盖恢复',
      onOk: function () {
        var res = Store.importAll(text);
        if (res.error) { toast('恢复失败：' + res.error); return; }
        renamingId = null;
        S.viewWeek = maxWeekClamp(currentWeek());
        render();
        scrollToTop();
        syncImportTarget();
        renderSchedList();
        closeMask('maskSettings');
        toast('已恢复 ' + res.count + ' 张课表');
      }
    });
    return true;
  }

  /* ---------------- 发送到聊天（微信 / QQ / 钉钉） ----------------
     用户说的「分享给同学」多半不是「把文件存下来」，而是「现在就发出去」。
     落盘是为了有个实在的产物，真正顺手的是这一步：挑一个应用、由系统把它
     拉起来、对方收到的是一个 .csv 附件（点开就是表格，不是一段被压扁的文字）。

     两条路按「能不能真发出去」排序：
       ① 原生桥 AndroidShare —— 把文本写成 cache 里的真文件、经 FileProvider
          换成 content:// 再走 ACTION_SEND。**这条路不需要任何权限**；
       ② 没有原生桥（在电脑浏览器里直接开这个网页）—— 老实说一句，
          别让用户以为已经发出去了。
     ------------------------------------------------------------ */

  /** 三个定向按钮 + 一份「装没装」的对照表 */
  var SEND_TARGETS = [
    { id: 'btnSendWechat', desc: 'sendWechatD', key: 'wechat', name: '微信' },
    { id: 'btnSendQQ', desc: 'sendQQD', key: 'qq', name: 'QQ' },
    { id: 'btnSendDing', desc: 'sendDingD', key: 'dingtalk', name: '钉钉' }
  ];

  /**
   * 打开「发送到聊天」。
   * opts.savedPath 有值 = 刚从「保存为 CSV」过来，说明里带上文件位置。
   */
  function openSendTo(opts) {
    var cur = Store.current();
    $('sendToWhat').textContent =
      '「' + ((cur && cur.name) || '我的课表') + '」· 以 .csv 文件发送';
    var p = opts && opts.savedPath;
    $('sendToHint').textContent = p
      ? '已保存到 ' + p + '。要顺手发给同学吗？'
      : '会生成一个 .csv 文件，由你选的应用发出去';
    syncSendTargets();
    closeMask('maskShare');
    openMask('maskSendTo');
  }

  /** 子弹层退回分享层；返回键 / 点弹层外 / 取消共用这一份 */
  function backToShare() {
    closeMask('maskSendTo');
    openMask('maskShare');
  }

  /**
   * 没装的应用就地置灰 —— 点了才被告知「未安装」体验差一截。
   * 查不到安装状态时（没有原生桥、或系统不给查）**当作装着**：
   * 宁可让用户点一下失败，也不要把一个本来能用的入口误灰掉。
   */
  function syncSendTargets() {
    var bridge = global.AndroidShare;
    var canAsk = !!(bridge && typeof bridge.hasApp === 'function');
    SEND_TARGETS.forEach(function (t) {
      var btn = $(t.id);
      var desc = $(t.desc);
      if (!btn) return;
      var ok = true;
      if (canAsk) {
        try { ok = Number(bridge.hasApp(t.key)) === 1; } catch (e) { ok = true; }
      }
      btn.disabled = !ok;
      btn.className = 'opt-row' + (ok ? '' : ' is-off');
      if (desc) desc.textContent = ok ? ('发到' + t.name + '聊天') : ('没装' + t.name);
    });
  }

  /**
   * 把这张课表当文件发出去。target ∈ wechat / qq / dingtalk / other。
   * 原生侧同步返回 ok:<应用名> / err:<原因>；发出去之后整个分享流程收干净。
   */
  function sendScheduleTo(target) {
    var bridge = global.AndroidShare;
    if (!bridge || typeof bridge.shareFile !== 'function') {
      toast('先「保存为 CSV 文件」，再到文件管理器里长按分享');
      return;
    }
    var r = '';
    try {
      r = String(bridge.shareFile(csvFileName(), 'text/csv', scheduleCsvText(), target) || '');
    } catch (e) { r = ''; }

    if (r.indexOf('ok:') === 0) {
      closeMask('maskSendTo');
      closeMask('maskShare');
      toast('已打开' + r.slice(3) + '，选个聊天发出去');
      return;
    }
    if (r.indexOf('err:') === 0) { toast(r.slice(4)); return; }
    toast('没能打开分享，请先用「保存为 CSV 文件」');
  }

  /* ---------------- 添加 / 编辑课程（同一个表单） ----------------
     传课程对象 = 编辑模式：标题、按钮文案改掉，字段预填；
     传 null = 添加模式，且**刻意不动各字段**，保留上次填了一半的内容。
     ------------------------------------------------------------ */
  function exitEditMode() {
    editId = null;
    $('addTitle').textContent = '添加课程';
    $('btnAddSave').textContent = '保存';
  }

  /** 保存成功后收尾：退出编辑模式，并把「容易残留」的几个字段清空 */
  function clearCourseForm() {
    exitEditMode();
    $('addName').value = '';
    $('addTeacher').value = '';
    $('addLocation').value = '';
    formColor = null;            // 颜色与课程名同组：属于「上一门课的内容」，保存后回「自动」
    syncColorRow();
  }

  function openCourseForm(c) {
    editId = c ? c.id : null;
    $('addTitle').textContent = c ? '编辑课程' : '添加课程';
    $('btnAddSave').textContent = c ? '保存修改' : '保存';

    formColor = courseColor(c);  // c 为 null（添加）时同样是 null = 自动

    if (!c) { syncColorRow(); openMask('maskAdd'); return; }

    $('addName').value = c.name;
    $('addDay').value = String(c.day);
    syncAddDay();
    $('addStart').value = c.start;
    $('addEnd').value = c.end;
    $('addTeacher').value = c.teacher || '';
    $('addLocation').value = c.location || '';
    $('addWeeks').value = c.weeksText || Store.formatWeeks(c.weeks);
    /* 放在赋完课名之后：调色盘中间那块显示的是**按课名算出来**的自动色，
       早一步刷新就会拿上一门课的名字去算，圆圈里的色是错的。 */
    syncColorRow();
    openMask('maskAdd');
  }

  /* 「星期」那一行。1 = 周一，正好与 store.js 的 WEEKDAY_CN 下标对齐
     （WEEKDAY_CN[0] 是「周日」），所以不用再存一份中文表。
     v1.9.15 起是自绘单选列表，不再是原生 <select>；值仍在 #addDay 的 .value 里，
     所以 openCourseForm 的赋值与保存时的 parseInt 都没改。 */
  function syncAddDay() {
    var el = $('addDayText');
    if (!el) return;
    el.textContent = Store.WEEKDAY_CN[parseInt($('addDay').value, 10)] || '—';
  }

  function openDayPick() {
    openPick({
      parent: 'maskAdd',
      title: '星期',
      value: $('addDay').value,
      items: [1, 2, 3, 4, 5, 6, 7].map(function (d) {
        return { v: String(d), t: Store.WEEKDAY_CN[d] };
      }),
      onPick: function (v) {
        $('addDay').value = v;
        syncAddDay();
      }
    });
  }

  /* ---------------- 卡片颜色：一个调色盘 + 一个「自动」 ----------------
     formColor === null 表示「自动」——不写颜色，渲染时按课程名算色相。
     formColor 是 '#RRGGBB' 表示用户自己挑的，卡片就用这个色（原样用，
     不再按对比度去调它：那是用户明确的选择，改了他会发现「我选的色变了」；
     能不能看清改由取色器里的预览与提示负责，见 openColorPicker）。
     ------------------------------------------------------------ */
  var formColor = null;

  /** 把 formColor 反映到「调色盘 / 自动」这两个按钮上（只切 class 与内联色，不重建 DOM） */
  function syncColorRow() {
    var pick = $('btnPickColor');
    var auto = $('btnAutoColor');
    if (!pick || !auto) return;
    var isAuto = formColor === null;
    /* 调色盘中间那块显示**当前实际会用的颜色**：自动时也显示按课名算出来的那个色，
       这样用户点开之前就知道现在是什么颜色，而不是看到一个空白圆圈 */
    pick.style.setProperty('--bg', isAuto ? autoHex() : formColor);
    pick.className = 'color-pick' + (isAuto ? '' : ' is-on');
    auto.className = 'color-auto' + (isAuto ? ' is-on' : '');
  }

  /** 「自动」时这门课会是什么颜色（跟着输入框里的课程名走，随打随变） */
  function autoHex() {
    var el = $('addName');
    return Store.cardHex(hueOf(el ? el.value.trim() : ''));
  }

  /** 点「自动」：清掉自定义色，回到按课程名配色 */
  function pickAutoColor() {
    formColor = null;
    syncColorRow();
  }

  /* ---------- 取色器（子弹层：进来前先收掉表单，退回去时表单原样还在） ---------- */

  var cpHexValue = '#000000';    // 取色器里当前的颜色
  var cpHue = 0;                 // 色相条的位置（0~360），与 cpHexValue 始终同步

  /** 打开取色器：从一个「用户看得见的颜色」起步（自定义色 / 自动色），不是凭空一个默认值 */
  function openColorPicker() {
    var start = formColor || autoHex();
    var hsv = Store.hexHsv(start) || { h: 0, s: 1, v: 1 };
    cpHexValue = Store.hsvHex(hsv.h, hsv.s, hsv.v);
    cpHue = hsv.h;
    $('cpHex').value = cpHexValue;
    paintPicker();
    closeMask('maskAdd');        // 弹层不许叠：先收表单，取色器退回去时再亮回来
    openMask('maskColor');
  }

  /** 取色器收起后回到添加 / 编辑表单（取消、保存、返回键、点外部都走这里） */
  function backToAdd() {
    closeMask('maskColor');
    openMask('maskAdd');
  }

  /** 按 cpHexValue / cpHue 重画方块、两个指示点、预览块与提示 */
  function paintPicker() {
    var area = $('cpArea');
    var dot = $('cpDot');
    var hueDot = $('cpHueDot');
    var prev = $('cpPreview');
    var tip = $('cpTip');
    var hsv = Store.hexHsv(cpHexValue) || { h: cpHue, s: 1, v: 1 };

    if (area) {
      /* 标准 HSV 方块：底色是纯色相，上面叠「白 → 透明」（横向，控制饱和度）
         与「透明 → 黑」（纵向，控制明度）。顺序要紧：黑色那层压在上面。 */
      area.style.background =
        'linear-gradient(to top, #000, rgba(0,0,0,0)),' +
        'linear-gradient(to right, #fff, rgba(255,255,255,0)),' +
        'hsl(' + cpHue + ' 100% 50%)';
    }
    if (dot) {
      dot.style.left = (hsv.s * 100) + '%';
      dot.style.top = ((1 - hsv.v) * 100) + '%';
    }
    if (hueDot) hueDot.style.top = (cpHue / 360 * 100) + '%';
    // 色值输入框在用户正在敲的时候不要回写，否则光标会被踢到末尾
    var hexEl = $('cpHex');
    if (hexEl && document.activeElement !== hexEl) hexEl.value = cpHexValue;
    if (prev) {
      prev.style.background = cpHexValue;
      prev.style.color = '#fff';
    }
    if (tip) {
      /* 自定义色不再自动调明度，所以这里把「看不看得清」说出来。
         **阈值跟着卡片配色走（v1.9.7）**：自从默认色也改成鲜艳档（白字对比度
         1.33~5.87，兜底线 1.35），再拿旧的 4.5 当分界就会「默认色本身都在报警」。
         现在只在明显读不出来时才提示，其余保持安静。 */
      var c = Store.hexContrast(cpHexValue);
      tip.textContent = c === null ? '' :
        c >= 2 ? '' :
          c >= 1.35 ? '这个颜色偏亮，白字会淡一些' :
            '这么亮白字基本看不清了，可以往下调暗一点';
    }
  }

  /** 从方块上的坐标设置「饱和度 + 明度」（x/y 都是 0~1） */
  function setSv(x, y) {
    cpHexValue = Store.hsvHex(cpHue, x, 1 - y);
    paintPicker();
  }

  /** 从色相条上的位置设置色相（y 是 0~1，从上到下 = 红→红） */
  function setHueAt(y) {
    cpHue = Math.max(0, Math.min(359.9, y * 360));
    var hsv = Store.hexHsv(cpHexValue) || { s: 1, v: 1 };
    cpHexValue = Store.hsvHex(cpHue, hsv.s, hsv.v);
    paintPicker();
  }

  function saveColorPick() {
    formColor = cpHexValue;
    syncColorRow();
    backToAdd();
  }

  /**
   * 在一个元素上按下 + 拖动（触摸与鼠标两条独立分支，都要能跑）。
   * 真机走触摸，桌面上调试走鼠标；只写一条的话另一条环境里完全没法用。
   */
  function bindPick(el, onPick) {
    if (!el) return;
    var dragging = false;

    function at(clientX, clientY) {
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      onPick(Math.max(0, Math.min(1, (clientX - r.left) / r.width)),
        Math.max(0, Math.min(1, (clientY - r.top) / r.height)));
    }

    el.addEventListener('mousedown', function (e) {
      e.preventDefault();          // 别让拖动变成选中文字
      dragging = true;
      at(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      e.preventDefault();
      at(e.clientX, e.clientY);
    });
    document.addEventListener('mouseup', function () { dragging = false; });

    el.addEventListener('touchstart', function (e) {
      var t = e.touches[0];
      if (!t) return;
      dragging = true;
      at(t.clientX, t.clientY);
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    el.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      var t = e.touches[0];
      if (!t) return;
      at(t.clientX, t.clientY);
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    el.addEventListener('touchend', function () { dragging = false; });
    el.addEventListener('touchcancel', function () { dragging = false; });
  }

  /* ============================================================
     导入
     ------------------------------------------------------------
     解析完不直接落库，先给一份预览 + 明确的落库方式：
       · 导入到哪个课表（下拉可选其他课表，或新建一个）
       · 覆盖 / 追加
     这样多课表共存时不会误伤别的课表。
     ============================================================ */
  var pendingImport = null;

  function applyImport(result) {
    var box = $('importResult');
    if (!box) return;

    if (!result.courses.length) {
      /* 适配脚本那条路的「一条课都没有」是自己的原因（没登录 / 翻错页 / 脚本不认识这页），
         拿 Excel / PDF 那套说明去解释只会让人以为选错了文件格式。 */
      var tip = result.format === 'adapter'
        ? '适配脚本这次没有交回课程。'
        : '未识别到课程。\n\n' +
          '支持：教务处 Excel 课表（.xls/.xlsx）、教务系统 PDF 课表（.pdf）、' +
          '以及 A→G 列格式的 CSV（课程名称,星期,开始节数,结束节数,老师,地点,周数）。';
      box.innerHTML = '<div class="result-box">' + esc(tip +
        (result.errors.length ? '\n\n' + result.errors.join('\n') : '') +
        (result.notes.length ? '\n\n' + result.notes.join('\n') : '')) + '</div>';
      return;
    }

    pendingImport = result;
    renderImportPreview(result);
  }

  /** 当前导入目标（下拉里选中的课表） */
  function importTarget() {
    var sel = $('importTarget');
    var id = (sel && sel.value) ? sel.value : S.activeId;
    if (id === '__new__') {
      // 提前算出会用的名字，预览文案与实际创建结果保持一致
      return { isNew: true, sched: null, name: Store.nextName(), count: 0 };
    }
    var s = Store.get(id) || Store.current();
    return {
      isNew: false,
      sched: s,
      name: s ? s.name : '当前课表',
      count: s ? s.courses.length : 0
    };
  }

  function renderImportPreview(res) {
    var box = $('importResult');
    if (!box) return;

    var t = importTarget();
    var lines = [];
    lines.push('✅ 已解析 ' + res.courses.length + ' 门课程');
    lines.push('来源：' + res.source);
    if (res.stats && res.stats.parsed !== res.courses.length) {
      lines.push('识别 ' + res.stats.parsed + ' 条 → 合并相邻节次 ' + res.stats.merged + ' 条' +
        (res.stats.duplicate ? ' → 去重 ' + res.stats.duplicate + ' 条' : ''));
    }
    lines.push('目标课表：「' + t.name + '」' +
      (t.isNew ? '（将新建）' : (t.count ? '（已有 ' + t.count + ' 门课程）' : '（空课表）')));
    /* 适配脚本这条路是新通道，用户对「导进来的到底是什么」最没底 ——
       把每门课的落位直接列出来（封顶 10 门），节次错了当场能看见，
       不用等导入完在课表页里一张张点卡片对。 */
    if (res.format === 'adapter' && res.courses.length) {
      lines.push('', '课程落位：');
      res.courses.slice(0, 10).forEach(function (c) {
        lines.push('　· ' + (c.name || '(无名)') + '（周' +
          ('一二三四五六日'[(+c.day || 1) - 1] || '?') +
          ' 第 ' + c.start + '-' + c.end + ' 节' +
          (c.location ? '，' + c.location : '') + '）');
      });
      if (res.courses.length > 10) lines.push('　…共 ' + res.courses.length + ' 门');
    }
    if (res.notes.length) lines.push('', '提示：', res.notes.join('\n'));
    if (res.errors.length) lines.push('', '警告：', res.errors.join('\n'));
    if (res.skipped) lines.push('', '（跳过 ' + res.skipped + ' 处无法识别的单元格）');

    var actions = (t.isNew || !t.count)
      ? '<button class="btn btn-primary" data-imp="replace">' +
          (t.isNew ? '新建并导入' : '导入到「' + esc(t.name) + '」') + '</button>'
      : '<button class="btn btn-primary" data-imp="replace">覆盖「' + esc(t.name) + '」</button>' +
        '<button class="btn" data-imp="append">追加导入</button>';

    box.innerHTML = '<div class="result-box">' + esc(lines.join('\n')) + '</div>' +
      '<div class="import-actions">' + actions + '</div>';
  }

  /** 把待导入数据真正写入目标课表 */
  function commitImport(mode) {
    var res = pendingImport;
    if (!res) return;

    var t = importTarget();
    var sched;
    var created = false;

    if (t.isNew) {
      sched = Store.create();
      Store.setActive(sched.id);
      created = true;
      mode = 'replace';
    } else {
      sched = t.sched;
      if (!sched) return;
      if (S.activeId !== sched.id) Store.setActive(sched.id);
    }

    /* v1.9.39：导入进来的课程**必须补上 id**。
       解析层（适配脚本 / Excel / PDF / CSV 四条通道）一律给 `id: null`，
       adapter-import.js 那句注释写着「由 Store 侧补」—— 但 Store 侧一直没补。
       后果不是报错：卡片的 data-id 变成空串，`findCourse(data-id)` 永远匹配
       不上，于是**导入的课在课表里点不开**（点下去既不弹详情也不给提示）。
       补在这里，因为这是所有导入通道唯一的共同收口；
       老数据另由 store.js 载入时的 ensureCourseIds 兜底。 */
    var incoming = res.courses.slice();
    incoming.forEach(function (c) { if (c && typeof c === 'object' && !c.id) c.id = Store.uid(); });

    if (mode === 'append') sched.courses = sched.courses.concat(incoming);
    else sched.courses = incoming;

    /* 适配脚本能带回学校自己的作息表 / 学期设置 —— 这是它比 Excel 强的地方
       （课表上的节次时间直接就学校自己的作息）。
       但**只有覆盖式导入才允许动作息表**：追加导入时把作息换掉，
       会把用户原有课程的节次时间一起改掉，而那些课本来是按旧作息排的。

       顺序上必须在下面的「自动放宽」之前：脚本给的作息可能只有 14 节，
       而课表里有课排在第 16 节 —— 那必须由「放宽」把节数顶上去，
       反过来做（先放宽再套用脚本作息）会把课直接盖掉。 */
    var adjusted = [];
    if (mode !== 'append' && res.settings) {
      var st = res.settings;
      if (st.times && st.times.length) {
        sched.settings.times = st.times.slice();
        if (st.sections) sched.settings.sections = st.sections;
        if (st.fixedDuration !== undefined) sched.settings.fixedDuration = !!st.fixedDuration;
        if (st.classDuration) sched.settings.classDuration = st.classDuration;
        adjusted.push('作息表 → 按适配脚本给的 ' + st.times.length + ' 节');
      }
      if (st.semesterStart && st.semesterStart !== sched.settings.semesterStart) {
        sched.settings.semesterStart = st.semesterStart;
        adjusted.push('开学日期 → ' + st.semesterStart);
      }
      if (st.totalWeeks) sched.settings.totalWeeks = st.totalWeeks;
    } else if (mode === 'append' && res.settings && res.settings.times) {
      /* 追加时不动作息，但也不能一声不吭 —— 用户会以为作息也一起导进来了 */
      adjusted.push('作息表未改动（追加导入不影响已有课程的节次时间）');
    }

    /* 表格里出现的最大周数/节次若超出该课表的设置，自动放宽，避免课程被裁掉 */
    if (res.suggestTotalWeeks && res.suggestTotalWeeks > sched.settings.totalWeeks) {
      sched.settings.totalWeeks = res.suggestTotalWeeks;
      adjusted.push('学期总周数 → ' + res.suggestTotalWeeks + ' 周');
    }
    if (res.suggestSections && res.suggestSections > sched.settings.sections) {
      sched.settings.sections = res.suggestSections;
      adjusted.push('每天节数 → ' + res.suggestSections + ' 节');
    }

    Store.syncTimesLength();
    var savedOk = Store.save();
    pendingImport = null;

    // 切到刚导入的课表并定位到当前周，让用户立刻看到结果
    S.viewWeek = maxWeekClamp(currentWeek());
    render();
    scrollToTop();
    syncImportTarget();
    syncSchedName();

    var lines = [];
    lines.push('✅ 已导入 ' + res.courses.length + ' 门课程到「' + sched.name + '」' +
      (created ? '（新建课表）' : (mode === 'append' ? '（追加）' : '')));
    lines.push('该课表现有 ' + sched.courses.length + ' 门课程，共 ' + Store.list().length + ' 个课表。');
    if (created) lines.push('课表名可在顶栏点一下改名（如「大三下」）。');
    if (adjusted.length) lines.push('已按课表自动调整：' + adjusted.join('、'));
    if (res.notes.length) lines.push('', '提示：', res.notes.join('\n'));
    if (res.skipped) lines.push('', '（跳过 ' + res.skipped + ' 处无法识别的单元格）');
    /* 解析出来是一回事，落到本机是另一回事 —— 写盘失败时预览里也得说实话，
       不能上面写「✅ 已导入」、下面弹「保存失败」 */
    if (!savedOk) lines.push('', '⚠️ 课表没能写入本机存储（存储空间不足或处于隐私模式），重启后可能丢失。');

    $('importResult').innerHTML = '<div class="result-box">' + esc(lines.join('\n')) + '</div>';
    if (savedOk) toast('已导入 ' + res.courses.length + ' 门课程');
  }

  /* ============================================================
     从教务系统导入（应用内嵌浏览器）
     ------------------------------------------------------------
     两条路，都由原生侧送进来，走上面同一套导入预览 / 覆盖 / 追加流程：

       · 适配脚本（主通道）：选中一所带适配脚本的学校 → 登录、翻到
         「学生个人课表」→ 点底栏「执行导入」→ 脚本就地取数、经桥交回，
         原生侧发 `onEduAdapter`。
       · 下载文件（兜底 + 无脚本的学校）：点教务系统自己的「导出 / 下载课表」，
         原生侧拦下下载、发 `onEduBuffer`。

     v1.9.43 删掉了第三条：原生抓整页 HTML 回传（`onEduHtml`）。
     那是「自研抓页」通道的入口，与它底栏那颗按钮一起拆了。

     原生侧不模拟登录、不保存账号密码、不抓任何接口——
     既绕开验证码 / RSA 加密 / token 这些麻烦，也避免替用户保管凭据。
     ============================================================ */

  /**
   * 打开内嵌教务浏览器（由 Android 侧实现）。
   * url 为空时原生侧只展示一个空地址栏并提示用户自己填 ——
   * **本工程不内置任何学校**，所以不给「默认入口」。
   * 返回是否真的打开了，方便调用方决定要不要关弹层。
   */
  function openEduBrowser(url) {
    if (!(global.AndroidEdu && global.AndroidEdu.open)) {
      toast('内嵌教务浏览器只在手机 App 里可用');
      return false;
    }
    global.AndroidEdu.open(url || '');
    return true;
  }

  /** 用「当前导入目标课表」的设置来解析，保证总周数 / 节数口径一致 */
  function eduSettings() {
    var t = importTarget();
    return t.sched ? t.sched.settings : S.settings;
  }

  /** 解析大页面会占住主线程，先把提示画出来再动手，避免界面像卡死 */
  function busyThen(box, tip, fn) {
    if (box) box.innerHTML = '<div class="result-box">' + esc(tip) + '</div>';
    global.setTimeout(fn, 30);
  }

  function showParseError(box, err) {
    box.innerHTML = '<div class="result-box">解析失败：' +
      esc(err && err.message ? err.message : String(err)) + '</div>';
  }

  /* v1.9.43 删掉了 onEduHtml(html, url)：原生侧「抓整页 HTML 回传」那条路的入口。
     它做的事和下面的 onEduBuffer 的下游完全一样（都是 applyImport），
     差别只在「上游给的是 DOM 里抠出来的 HTML」还是「一个真实文件」。
     ⚠️ `Import.parseHtml` 本身**没有删、也不该删** ——
        文件导入那条路仍然靠它认「网页课表」（教务导出的 .html，以及
        伪装成 .xls 的网页表格），见 importer.js 的 parseBuffer。
        删掉的只是「原生抓页」这一个调用点。 */

  /** 原生下载完教务系统导出的文件，以 base64 传过来 */
  function onEduBuffer(b64, name) {
    openMask('maskImport');
    var box = $('importResult');
    busyThen(box, '正在解析从教务系统下载的「' + (name || '课表') + '」…', function () {
      var bin;
      try {
        bin = global.atob(String(b64 || ''));
      } catch (e) {
        box.innerHTML = '<div class="result-box">文件读取失败（内容不是有效的下载数据）</div>';
        return;
      }
      var u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      Import.parseBuffer(u8, name || '教务下载', eduSettings())
        .then(applyImport)
        .catch(function (err) { showParseError(box, err); });
    });
  }

  /**
   * 适配脚本交回来的数据（原生侧 `onEduAdapter`，见 EduLoginActivity.finishAdapterImport）。
   *
   * 信封形状：`{schoolName, adapterName, maintainer, courses[], timeSlots, config, saves}`。
   * 翻译成柚课模型的那一步全在 `AdapterImport.toResult` 里 ——
   * 这一层不自己碰字段，免得同一个映射有两份实现。
   */
  function onEduAdapter(json, url) {
    openMask('maskImport');
    var box = $('importResult');
    if (!AD) {
      box.innerHTML = '<div class="result-box">适配结果映射模块没加载出来，请重新打开应用。</div>';
      return;
    }
    busyThen(box, '适配脚本已取到数据，正在整理…', function () {
      var payload;
      try {
        payload = JSON.parse(String(json || '{}'));
      } catch (e) {
        box.innerHTML = '<div class="result-box">适配脚本交回来的数据读不懂' +
          '（不是有效的 JSON）。请回到上一个界面重新点一次「执行导入」；' +
          '也可以改用教务系统的「导出 / 下载课表」，下载完会自动导入。</div>';
        return;
      }
      var res;
      try {
        res = AD.toResult(payload, eduSettings());
      } catch (err) { showParseError(box, err); return; }
      if (url) {
        var host = String(url).replace(/^\w+:\/\//, '').split('/')[0];
        if (host) res.notes.push('取数页面：' + host);
      }
      applyImport(res);
    });
  }

  /** 原生侧的进度 / 失败提示 */
  function onEduStatus(msg) {
    if (msg) toast(msg);
  }

  /* v1.9.43 也删掉了 importHtml(html) —— 它是 onEduHtml 的兜底别名，
     同一条通道，一起退场。 */

  /* ============================================================
     打开教务系统：地址由用户提供，本应用不预置学校
     ------------------------------------------------------------
     这里只负责**把地址填对**，不做任何解析判断——解析器认的是页面
     上怎么写文字（见 edugrab.js），跟学校、跟教务系统厂牌都无关。

     导入面板的主按钮是「一键直达」：用户填过一次学校之后，
     取「最近使用 → 我的学校第一条」直接打开，省掉
     「进列表 → 找学校 → 点一下」三步；一次都没填过时，
     把它送到选择页去填（而不是去打开一个空地址）。

     选择页里的分组顺序：内置（若有）→ 最近使用 → 我的学校。
     ============================================================ */

  var SCH = global.Schools;
  var schPanel = null;              // null | 'manual' | 'import'

  function openSchoolSheet() {
    if (!SCH) { toast('学校列表没加载出来，请重新打开应用'); return; }
    // 「打开教务系统」是从导入弹层里点进来的。两个弹层叠在一起既不好看，
    // 也容易让用户以为下面那层还能点——所以先收起导入弹层。
    // 注意：只收弹层，不动 pendingImport，抓回来后照样能接着导入。
    closeMask('maskImport');
    schPanel = null;
    $('schoolSearch').value = '';
    $('schoolResult').innerHTML = '';
    $('schName').value = '';
    $('schUrl').value = '';
    updateUrlHint();
    applySchoolPanel();
    renderSchoolList();
    openMask('maskSchool');
    maybeAutoLoadWarehouse();
  }

  /**
   * 从「打开教务系统」退回「导入课表」。
   *
   * 三个出口——关闭按钮 / 点弹层外 / 返回键——全部走这里。
   * 行为必须一致，否则同一层弹层「点按钮退到 A、按返回退到 B」，
   * 用户会觉得错乱。而退回导入弹层（而不是直接回课表）才对：
   * 他是「暂且不选学校了」，不是「我不导入了」，多半还要接着点别的入口。
   */
  function backToImport() {
    closeMask('maskSchool');
    openMask('maskImport');
  }

  /**
   * 一键打开「我的学校」教务系统。
   *
   * 学校是用户自己用过的（**按「最近使用 → 我的学校第一条」取**，
   * v1.9.36 起本校不再做特例、和其他学校一起排在适配库列表里）；
   * 一条都没有时，直接把他送到「打开教务系统」页并给一句说明 ——
   * 在里面搜一次学校（本校与社区适配库都在列表里），以后这里就是一键直达。
   * 只在 App 里可用（网页版没有原生桥，openEduBrowser 会提示并返回 false）。
   */
  function openEduEntry() {
    if (!SCH) { toast('学校列表没加载出来，请重新打开应用'); return; }
    var p = SCH.recent()[0] || SCH.customList()[0] || null;
    if (!p) {
      closeMask('maskImport');
      openSchoolSheet();
      showSchoolResult(WH && WH.loaded()
        ? '在上面搜你学校的名字，选中适配库里的那一所就行 —— ' +
          '它会用社区维护的适配脚本自动把课表取回来。'
        : '还没载入适配库。点下面的「载入适配库」，社区里有 200 多所学校；' +
          '也可以直接在「手动输入」里填教务地址。');
      toast('先选一次学校，以后就能一键直达');
      return;
    }
    /* 「上次这个地址用的是哪段适配脚本」还记得的话，直接复用它 ——
       否则第二次点这颗按钮就退回「只搬 HTML 猜」的老路，
       而同一所学校走适配脚本明显更稳。 */
    var picked = pickFor(p.url);
    if (picked) {
      if (openAdapterBrowser(picked)) return;
      // 脚本查不到了（比如索引被清过）就悄悄退回老路，别让用户卡住
    }
    if (!openEduBrowser(p.url)) return;
    SCH.pushRecent(p.name, p.url, p.sys);
    closeMask('maskImport');
    toast('正在打开「' + p.name + '」教务系统');
  }

  /**
   * 把导入面板主按钮的文案跟「这次会打开哪所学校」对齐。
   * 用户用过哪所学校就写校名（「打开 XX 教务系统」），没用过就写成引导语 ——
   * 否则第一次用的人会以为「打开教务系统」会自己知道去哪。
   */
  function syncEduEntry() {
    var label = $('eduEntryLabel');
    if (!label || !SCH) return;
    var p = SCH.recent()[0] || SCH.customList()[0] || null;
    label.textContent = p ? ('打开' + p.name + '教务系统') : '打开我的学校教务系统';
  }

  /* ============================================================
     社区适配库（v1.9.32）
     ------------------------------------------------------------
     上游是个「每所学校一段适配脚本」的社区仓库（见 web/js/warehouse.js）。
     脚本在内嵌浏览器里**就地**取数，比「把整页 HTML 搬回来猜」稳得多：
     学校改版，脚本作者跟着改，不用我们发版。这也是本工程从 v1.8 起
     那套「照同业做法搬页面」的替代路线。

     这一节只做三件事：把索引拉下来、把搜到的学校画出来、把选中的那一所
     连同脚本地址交给原生。**仓库里一个校名都没有**，全从索引来。
     ============================================================ */
  var WH = global.Warehouse;
  var AD = global.AdapterImport;

  /** 正在拉索引（界面要显示「正在更新…」，同时挡住重复点击） */
  var whBusy = false;

  /** 一次最多画几所适配库学校（一所可能带好几个适配器，铺太多会把列表冲垮） */
  var LIB_ROWS_MAX = 12;

  function whSupported() {
    return !!(global.AndroidEdu && global.AndroidEdu.openWithAdapter);
  }

  /**
   * 拉一次索引。成功后索引会落本机，之后离线也能查。
   *
   * `auto` = 这趟是「打开面板顺手拉一把」，不是用户点的按钮。
   * v1.9.41 起包里不再有清单，第一次进来必然要联网，所以这个自动动作要留着；
   * 但**它失败时不许弹红字** —— 用户还没做任何事，劈头一句报错只会让人
   * 以为应用坏了。失败时的说明走面板里的空态文案。
   */
  function refreshWarehouse(auto) {
    if (!WH) return;
    if (whBusy) return;
    whBusy = true;
    renderSchoolList();
    WH.update().then(function (idx) {
      whBusy = false;
      renderSchoolList();
      if (WH.lastWriteOk() === false) {
        /* 拉到了却没能写进本机 —— 不能只说「已更新」 */
        showSchoolResult('适配库拉到了 ' + idx.schools.length + ' 所学校，' +
          '但没能存进本机（存储空间不足或处于隐私模式），重启后要重新更新。');
      } else {
        /* 说清「走的哪条源」：四条入口在各处网络下通不通不一样，
           这一句是用户反馈问题时最有用的那半条信息 */
        var srcName = (WH.lastSourceName && WH.lastSourceName()) || '';
        showSchoolResult('适配库已更新：' + idx.schools.length + ' 所学校' +
          (srcName ? '（来源 ' + srcName + '）' : '') +
          '。在上面搜校名就能用。');
      }
    }, function (err) {
      whBusy = false;
      renderSchoolList();
      if (auto) return;      // 自动那趟不打扰用户，面板里的空态会说明情况
      /* 失败要交代「都试了什么」：四条源按序各试过一遍。
         v1.9.33 真机截图里那种同一句话叠三遍的报错，除了回退逻辑自身的
         嵌套 bug，还有一半原因是文案没说清「都试了什么」。 */
      var detail = (err && err.message ? err.message : err);
      showSchoolResult('适配库载入失败：' + detail + '\n\n' +
        '四条源都按顺序试过了（Gitee 镜像 / jsDelivr / GitHub 回源 / ITDONG 镜像）。' +
        '检查一下网络后再点一次「载入适配库」。', true);
    });
  }

  /**
   * 「这份适配库是什么时候、从哪条路来的」—— 一句话。
   *
   * **带上来源**（v1.9.40）：上游作者维护了四条分发入口（Gitee 镜像 /
   * jsDelivr / GitHub 回源 / ITDONG 镜像），各处网络下通不通不一样。
   * 用户说「更新不了」「我们学校搜不到」时，「这次走的是哪条路」
   * 是第一句要问的话，界面直接把答案写在脸上。
   */
  function whWhen() {
    var t = WH && WH.cachedAt ? WH.cachedAt() : 0;
    var src = (WH && WH.lastSourceName) ? WH.lastSourceName() : '';
    if (!t) return src ? '来源 ' + src : '时间未知';
    var d = new Date(t);
    var when = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return (src ? '来源 ' + src + '，' : '') + when + ' 更新';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* ------------------------------------------------------------
     字母序总览（v1.9.34）
     ------------------------------------------------------------
     v1.9.32/33 的口径是「不铺开，只搜」—— 真机用下来不对：
     搜的前提是**知道校名怎么写**，而「安庆医药高等专科学校」这种名字，
     用户记住的往往只有开头两个字。改成同业那种一屏总览：
     A–Z 分组、右侧字母条、**用过的置顶**。260 行平铺在这里是可接受的 ——
     它在一个限高的内层滚动区里滚，不跟弹层自身抢高度。
     ------------------------------------------------------------ */

  /**
   * 学校挂在哪个字母组下。上游索引自带每所学校的拼音首字母（`initial`，
   * 比如安庆医药是「AQYY…」），取首字符就是分组 —— **不要自己写拼音表**，
   * 那是上游维护好的数据。取不出 A–Z 的进「#」兜底组。
   */
  function libLetter(s) {
    var c = String((s && (s.initial || s.name)) || '').charAt(0).toUpperCase();
    return (c >= 'A' && c <= 'Z') ? c : '#';
  }

  /** 用过的学校（置顶用）：按最后一次使用的时间排，最近的在最前 */
  function libUsed() {
    var p = readPicks();
    var seen = {};
    var out = [];
    Object.keys(p).forEach(function (u) {
      var it = p[u];
      if (!it || !it.s || seen[it.s]) return;
      seen[it.s] = 1;
      var s = WH.schoolById(it.s);
      if (s) out.push({ school: s, t: it.t || 0 });
    });
    out.sort(function (a, b) { return b.t - a.t; });
    return out.map(function (x) { return x.school; });
  }

  /**
   * 整个字母序总览的 HTML。
   * 结构：`.lib-wrap`（定位用）> `.lib-scroll`（**内层滚动区**，限高）+
   * `.lib-index`（右侧字母条，绝对定位在 wrap 上 —— 放在 scroll **外**，
   * 否则它会跟着内容一起滚走，就失去「随时能点」的意义了）。
   * 只渲染**有学校**的字母 —— 26 个全画出来，一半是点了没反应的死字母。
   */
  function libraryAlphabet() {
    var all = WH.schools();
    if (!all.length) return '';
    var groups = {};
    var letters = [];
    all.forEach(function (s) {
      var L = libLetter(s);
      if (!groups[L]) { groups[L] = []; letters.push(L); }
      groups[L].push(s);
    });
    letters.sort();
    var hash = letters.indexOf('#');
    if (hash >= 0) { letters.splice(hash, 1); letters.push('#'); }   // 「#」永远在最后

    var rows = '';
    var used = libUsed();
    if (used.length) {
      rows += '<div class="sch-group lib-star">★ 用过的学校（置顶）</div><div class="sched-list">';
      used.forEach(function (s) {
        s.adapters.forEach(function (a) { rows += libraryRow(s, a); });
      });
      rows += '</div>';
    }
    letters.forEach(function (L) {
      rows += '<div class="sch-group" data-letter-head="' + L + '">' + L + '</div>' +
        '<div class="sched-list">';
      groups[L].forEach(function (s) {
        s.adapters.forEach(function (a) { rows += libraryRow(s, a); });
      });
      rows += '</div>';
    });
    var bar = '';
    letters.forEach(function (L) { bar += '<span data-letter="' + L + '">' + L + '</span>'; });
    return '<div class="lib-wrap"><div class="lib-scroll" id="libScroll">' + rows + '</div>' +
      '<div class="lib-index">' + bar + '</div></div>';
  }

  /** 点右侧字母条：把那一组的标题滚到内层列表顶部 */
  function jumpToLetter(L) {
    var sc = $('libScroll');
    if (!sc) return;
    var h = sc.querySelector('[data-letter-head="' + L + '"]');
    if (!h) return;
    sc.scrollTop = Math.max(0, h.offsetTop - 2);
  }

  var whAutoTried = false;

  /**
   * 打开面板就自动拉一次（v1.9.34 立，v1.9.41 改判据）。
   *
   * v1.9.34~v1.9.40 的判据是「本机有没有内置快照」—— 有快照才自动，
   * 因为那是本地读、零流量、必成。v1.9.41 包里不再有清单，**第一次进来
   * 必须联网**，所以这趟自动更不能取消：用户不该先弄懂「载入适配库」
   * 是什么再点它。
   *
   * 两处约束：
   *   · **每个会话只试一次**（`whAutoTried`）；失败就安静地停在原状态，
   *     面板里的空态写清「需要联网」并给出重试入口，不跟用户纠缠；
   *   · 已经载入过（本机有清单）就**一次都不试** —— 离线用户打开面板
   *     不该看见任何转圈。
   */
  function maybeAutoLoadWarehouse() {
    if (whAutoTried || !WH || WH.loaded() || whBusy) return;
    whAutoTried = true;
    refreshWarehouse(true);
  }

  /** 适配库那块的整体内容（状态条 + 更新入口） */
  function libraryBlock() {
    if (!WH) {
      return '<div class="sch-group">社区适配库</div>' +
        '<div class="school-empty">适配库模块没加载出来，请重新打开应用。</div>';
    }
    if (whBusy) {
      return '<div class="sch-group">社区适配库</div>' +
        '<div class="school-empty">正在载入适配库…</div>';
    }
    var updateRow = '<div class="sched-list"><div class="sched-row" data-wh="update">' +
      '<div class="sr-main">' +
        '<div class="sr-name"><span class="txt">载入适配库</span></div>' +
        '<div class="sr-sub">从社区的四条镜像任取一条下载（约 75 KB），下载一次就存在本机</div>' +
      '</div></div></div>';
    if (!WH.loaded()) {
      return '<div class="sch-group">社区适配库</div>' +
        '<div class="school-empty">还没有载入（打开这一页时会自动试一次）。<br>' +
        '社区里有 200 多所学校各自维护了一段适配脚本，选它就能自动把课表取回来。<br>' +
        '<b>第一次需要联网</b>：清单从 Gitee / jsDelivr / GitHub / ITDONG 四条里任取一条，' +
        '约 75 KB；载入一次就存在本机，之后离线也能用。</div>' + updateRow;
    }
    var n = WH.schools().length;
    return '<div class="sch-group">社区适配库</div>' +
      '<div class="school-empty">已载入 <b>' + n + '</b> 所学校（' + whWhen() + '）。' +
      '按字母排在下面，点右侧字母可以快跳；用过的学校在最上面。' +
      '也可以直接在搜索框搜校名。</div>' + updateRow + libraryAlphabet();
  }

  /**
   * 一行适配库结果。
   *
   * 副标题一定要写「谁维护的」—— 这是上游仓库的署名要求，
   * 也是用户遇到问题时唯一能拿去社区提问的线索。
   */
  function libraryRow(school, adapter) {
    var sub = (adapter.name || '教务适配') +
      (adapter.maintainer ? ' · 维护者 ' + adapter.maintainer : '');
    return '<div class="sched-row" data-lib="' + esc(school.id + '|' + adapter.adapterId) + '">' +
      '<div class="sr-main">' +
        '<div class="sr-name"><span class="txt">' + esc(school.name) + '</span>' +
          '<span class="sch-sys">适配</span></div>' +
        '<div class="sr-sub">' + esc(sub) + '</div>' +
      '</div></div>';
  }

  /** 搜索结果里的适配库那一组（只在有关键词时才铺开，200+ 所平铺没有意义） */
  function libraryHits(kw) {
    if (!WH || !WH.loaded() || whBusy) return '';
    var hits = WH.search(kw);
    if (!hits.length) return '';
    var rows = '';
    var used = 0;
    for (var i = 0; i < hits.length && used < LIB_ROWS_MAX; i++) {
      var s = hits[i];
      for (var j = 0; j < s.adapters.length && used < LIB_ROWS_MAX; j++) {
        rows += libraryRow(s, s.adapters[j]);
        used++;
      }
    }
    if (!rows) return '';
    return '<div class="sch-group">适配库（点一下即打开，用它自己的脚本取课表）</div>' +
      '<div class="sched-list">' + rows + '</div>' +
      (used >= LIB_ROWS_MAX
        ? '<div class="school-empty">只列了前 ' + LIB_ROWS_MAX + ' 条，' +
          '把校名写全一点能搜得更准。</div>'
        : '');
  }

  /* 「教务地址 → 上次用的适配器」小表。
     没有它，「一键直达」在第二次就退回「只搬 HTML 猜」的老路 ——
     同一所学校明显更差的那条路。存在本机，与地址簿互不影响。 */
  var PICK_KEY = 'schedule_app_adapter_pick_v1';

  function readPicks() {
    try { return JSON.parse(global.localStorage.getItem(PICK_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }

  function rememberPick(importUrl, schoolId, adapterId) {
    if (!importUrl) return;
    try {
      var d = readPicks();
      d[String(importUrl)] = { s: schoolId, a: adapterId, t: Date.now() };
      global.localStorage.setItem(PICK_KEY, JSON.stringify(d));
    } catch (e) { /* 存不下不影响这次使用 */ }
  }

  /** 这个地址上次是不是用某段适配脚本打开过？是就返回那段脚本 */
  /**
   * 「这个地址上次是不是用某段适配脚本打开过？」是就返回那段脚本；
   * 没有历史记录时再认一次**本地注册的本校条目**（地址对上就直接用，
   * 不需要用户先成功导入过一次）—— v1.9.42 起这条目只是「校名 + 地址」，
   * 脚本照样联网下载，所以两次走的是完全同一条路。
   */
  function localPickFor(url) {
    if (!WH || typeof WH.localSchools !== 'function') return null;
    var u = SCH && SCH.normalizeUrl ? SCH.normalizeUrl(url) : String(url || '');
    if (!u) return null;
    var locals = WH.localSchools();
    for (var i = 0; i < locals.length; i++) {
      for (var j = 0; j < locals[i].adapters.length; j++) {
        var a = locals[i].adapters[j];
        if (a.importUrl && SCH.normalizeUrl(a.importUrl) === u) {
          return { school: locals[i], adapter: a };
        }
      }
    }
    return null;
  }

  function pickFor(url) {
    var p = readPicks()[String(url || '')];
    if (p && WH && WH.loaded()) {
      var found = WH.adapterById(p.a);
      if (found && found.school && found.school.id === p.s) return found;
    }
    return localPickFor(url);
  }

  /** 点了一行适配库学校 */
  function openLibraryPick(key) {
    var parts = String(key || '').split('|');
    var found = WH ? WH.adapterById(parts[1]) : null;
    if (!found || !found.school || found.school.id !== parts[0]) {
      showSchoolResult('这所学校的适配脚本没找到，请点「载入适配库」后再试。', true);
      return;
    }
    openAdapterBrowser(found);
  }

  /**
   * 带着适配脚本打开内嵌浏览器。
   *
   * 两件必须做的事：
   *  ① **脚本一律按地址联网取**（v1.9.42）：本校那一行与其他学校没有区别 ——
   *     它的 `folder` / `jsPath` 指向上游「正方教务-通用教务」那只脚本，
   *     `WH.scriptUrls()` 给出的就是四条下载地址。包里没有脚本正文，
   *     所以桥也不再需要「递一段脚本文本」那个参数；
   *  ② 有 import_url 就填进地址栏 —— 多数脚本会自己跳到目标页，
   *     但先落在正确站点上能省一次跳转，也避免在别校的页面上跑这段脚本；
   *  ③ 记一笔「这个地址用哪段脚本」，让「一键直达」下次还走这条路。
   */
  function openAdapterBrowser(found) {
    var school = found.school, adapter = found.adapter;
    if (!whSupported()) { toast('这条通道只在手机 App 里可用'); return false; }
    var urls = WH.scriptUrls(school, adapter);
    if (!urls.length) { showSchoolResult('这段适配脚本没有下载地址。', true); return false; }
    try {
      global.AndroidEdu.openWithAdapter(
        String(school.name || ''), String(adapter.name || ''),
        String(adapter.maintainer || ''), JSON.stringify(urls),
        String(adapter.importUrl || '')
      );
    } catch (e) {
      showSchoolResult('打开失败：' + (e && e.message ? e.message : e), true);
      return false;
    }
    if (adapter.importUrl) {
      SCH.pushRecent(school.name, adapter.importUrl, '适配库');
      rememberPick(adapter.importUrl, school.id, adapter.adapterId);
    }
    closeMask('maskSchool');
    toast('正在打开「' + school.name + '」，适配脚本：' + (adapter.name || '未命名'));
    return true;
  }

  function applySchoolPanel() {
    $('schoolManual').hidden = schPanel !== 'manual';
    $('schoolImport').hidden = schPanel !== 'import';
  }

  function toggleSchoolPanel(which) {
    schPanel = (schPanel === which) ? null : which;
    $('schoolResult').innerHTML = '';
    applySchoolPanel();
  }

  function showSchoolResult(msg, isErr) {
    $('schoolResult').innerHTML = '<div class="result-box' +
      (isErr ? ' is-err' : '') + '">' + esc(msg) + '</div>';
  }

  /** 一行学校：副标题直接把完整地址亮出来，用户看得出来会打开哪里 */
  function schoolRow(s, withDel) {
    return '<div class="sched-row" data-url="' + esc(s.url) +
        '" data-name="' + esc(s.name) + '" data-sys="' + esc(s.sys || '') + '">' +
      '<div class="sr-main">' +
        '<div class="sr-name"><span class="txt">' + esc(s.name) + '</span>' +
          (s.sys ? '<span class="sch-sys">' + esc(s.sys) + '</span>' : '') +
        '</div>' +
        '<div class="sr-sub">' + esc(s.url) + '</div>' +
      '</div>' +
      (withDel ? '<div class="sr-ops"><button type="button" class="is-danger" data-del="' +
        esc(s.id) + '">删除</button></div>' : '') +
    '</div>';
  }

  function renderSchoolList() {
    var box = $('schoolList');
    var kw = String($('schoolSearch').value || '').trim();
    /* 载入了适配库且没在搜索时，列表里会有内层滚动区（字母总览），
       外层容器放宽一点，别出现两层滚动条叠着各滚各的 */
    box.className = 'school-list' + (!kw && WH && WH.loaded() ? ' has-lib' : '');

    // 没搜索时按「最近使用 / 我的学校」分组（v1.9.36 起没有「本校」特例组，
    // 本校跟其他学校一起排在适配库字母列表里）
    if (!kw) {
      var html = '';
      var rec = SCH.recent();
      if (rec.length) {
        html += '<div class="sch-group">最近使用</div><div class="sched-list">';
        rec.forEach(function (s) { html += schoolRow(s, false); });
        html += '</div>';
      }
      var mine = SCH.customList();
      if (mine.length) {
        html += '<div class="sch-group">我的学校（自己添加的，可删除）</div><div class="sched-list">';
        mine.forEach(function (s) { html += schoolRow(s, true); });
        html += '</div>';
      } else {
        html += '<div class="school-empty">还没有添加学校。<br>' +
          '在下面「手动输入」填一次你学校教务系统的地址<br>' +
          '（如 jwgl.xxx.edu.cn），或用「批量导入」一次加一批。<br>' +
          '加完只存在你本机。</div>';
      }
      // 适配库不铺开（200+ 所平铺没意义），只给状态 + 更新入口 + 一句怎么用
      html += libraryBlock();
      box.innerHTML = html;
      return;
    }

    var hits = SCH.search(kw);
    var libHtml = libraryHits(kw);
    if (!hits.length && !libHtml) {
      box.innerHTML = '<div class="school-empty">没找到这个学校。<br>' +
        (WH && WH.loaded()
          ? '适配库里也没有匹配的，可以换个写法（试试只填校名里的两个字）。<br>'
          : '也可以点下面的「载入适配库」，社区里有 200 多所学校。<br>') +
        '还是没有的话，用「手动输入」直接填教务系统地址。</div>' + libraryBlock();
      return;
    }
    var out = '';
    if (hits.length) {
      out += '<div class="sch-group">我的学校里找到 ' + hits.length + ' 所</div>' +
        '<div class="sched-list">';
      hits.forEach(function (s) { out += schoolRow(s, s.custom); });
      out += '</div>';
    }
    out += libHtml;
    box.innerHTML = out;
  }

  /** 真正的打开动作：地址能对上本地注册的本校条目就走适配脚本
      （v1.9.42 起那条目只给「校名 + 地址」，脚本同样联网取），
      其余记一笔「最近使用」再把地址交给原生 */
  function launchEdu(url, name, sys) {
    if (!url) { showSchoolResult('地址是空的，请检查一下。', true); return; }
    var picked = localPickFor(url);
    if (picked && openAdapterBrowser(picked)) return;   // 没走成（网页版/异常）就落到老路
    if (!openEduBrowser(url)) return;   // 网页版环境：只提示，不关弹层
    SCH.pushRecent(name || url, url, sys || '');
    closeMask('maskSchool');
    if (name) toast('正在打开「' + name + '」的教务系统');
  }

  function onSchoolClick(e) {
    var t = e.target || e.srcElement;

    // 删除按钮长在行里面，必须先判它，否则点删除会连带打开浏览器
    var del = closestBy(t, 'data-del');
    if (del) {
      if (SCH.removeCustom(del.getAttribute('data-del'))) {
        /* 地址簿有自己的存储，写盘失败时同样不能说「已删除」 */
        toast(SCH.lastWriteOk() ? '已删除' : SAVE_FAIL_MSG);
        renderSchoolList();
      }
      return;
    }

    // 右侧字母条（在行外面，先判它，防止落进 data-url 的兜底）
    var lt = closestBy(t, 'data-letter');
    if (lt) { jumpToLetter(lt.getAttribute('data-letter')); return; }

    // 「更新适配库」也是一个行样式的入口，同样要先于 data-url 判（同一层里三类行并存）
    var wh = closestBy(t, 'data-wh');
    if (wh) { refreshWarehouse(); return; }

    // 适配库里的学校：带着它自己的脚本打开，不走「手动填地址」那条路
    var lib = closestBy(t, 'data-lib');
    if (lib) { openLibraryPick(lib.getAttribute('data-lib')); return; }

    var row = closestBy(t, 'data-url');
    if (!row) return;
    launchEdu(row.getAttribute('data-url'), row.getAttribute('data-name'),
      row.getAttribute('data-sys'));
  }

  function updateUrlHint() {
    var v = $('schUrl').value;
    var h = $('schUrlHint');
    if (!h) return;
    h.innerHTML = (v && SCH.isBareHost(v))
      ? '只填了域名。正方系统的登录页路径是固定的，点下面的按钮可以一步补全。'
      : '只填域名也行，例如 <b>jwglxt.xxx.edu.cn</b>；不确定登录页路径时点「按正方规则补全」。';
  }

  function saveSchoolAndOpen() {
    var item;
    try {
      item = SCH.addCustom($('schName').value, $('schUrl').value, '我的学校');
    } catch (err) {
      showSchoolResult(err && err.message ? err.message : String(err), true);
      return;
    }
    /* 地址簿写盘失败时说清楚「重启就没了」，别报「已保存」 */
    showSchoolResult(SCH.lastWriteOk()
      ? '已保存「' + item.name + '」，下次可在「我的学校」里直接点开。'
      : '「' + item.name + '」没能写入本机存储（存储空间不足或处于隐私模式），重启后会丢失。');
    launchEdu(item.url, item.name, item.sys);
  }

  function doSchoolImport() {
    var text = $('schImportArea').value;
    if (!String(text || '').trim()) { showSchoolResult('请先粘贴学校列表。', true); return; }
    var r = SCH.parseImport(text);
    var msg = [];
    if (r.added) msg.push('新增 ' + r.added + ' 所');
    if (r.updated) msg.push('更新 ' + r.updated + ' 所');
    if (r.skipped) msg.push('跳过 ' + r.skipped + ' 行（已存在或格式不符）');
    if (r.errors && r.errors.length) msg.push('提示：' + r.errors.slice(0, 3).join('；'));
    showSchoolResult(msg.length ? msg.join('，') + '。' : '没有可导入的内容。', !r.added && !r.updated);
    if (r.added || r.updated) {
      $('schImportArea').value = '';
      renderSchoolList();
    }
  }

  /* ============================================================
     多课表：切换 / 新建 / 重命名 / 复制 / 删除
     ============================================================ */
  var renamingId = null;

  /** 导入弹层里的目标课表。v1.9.15 起是自绘单选列表，不再是原生 <select> */
  function importItems() {
    var items = Store.list().map(function (s) {
      return {
        v: s.id,
        t: s.name,
        sub: s.courses.length ? '已有 ' + s.courses.length + ' 门课程' : '空课表'
      };
    });
    // 提前算出会用的名字，预览文案与实际创建结果保持一致
    items.push({
      v: '__new__',
      t: '新建课表并导入',
      tip: '＋',
      sub: '将命名为「' + Store.nextName() + '」'
    });
    return items;
  }

  /** 那一行显示的课表名（值在 #importTarget 的 .value 里） */
  function syncImportTargetText() {
    var el = $('importTargetText');
    if (!el) return;
    var v = $('importTarget').value;
    if (v === '__new__') { el.textContent = '新建课表并导入'; return; }
    var s = Store.get(v) || Store.current();
    el.textContent = s ? s.name : '当前课表';
  }

  function syncImportTarget() {
    var btn = $('importTarget');
    if (!btn) return;
    btn.value = S.activeId;
    syncImportTargetText();
  }

  function openImportTargetPick() {
    openPick({
      parent: 'maskImport',
      title: '导入到哪个课表',
      value: $('importTarget').value,
      items: importItems(),
      onPick: function (v) {
        $('importTarget').value = v;
        syncImportTargetText();
        // 换了目标课表就刷新预览里的「覆盖 / 追加」选项
        if (pendingImport) renderImportPreview(pendingImport);
      }
    });
  }

  /** 顶栏的课表名 */
  function syncSchedName() {
    var cur = Store.current();
    var el = $('curSchedName');
    if (el) el.textContent = cur ? cur.name : '我的课表';
    var chip = $('btnSched');
    if (chip && chip.setAttribute) {
      chip.setAttribute('title', '当前课表：' + (cur ? cur.name : '') + '（点击切换 / 管理）');
    }
  }

  function renderSchedList() {
    var box = $('schedList');
    if (!box) return;

    var list = Store.list();
    var act = S.activeId;
    var html = '';

    list.forEach(function (s) {
      var isActive = s.id === act;

      if (renamingId === s.id) {
        html += '<div class="sched-row is-active" data-id="' + s.id + '">' +
          '<div class="sr-main">' +
          '<input class="sr-input" id="renameInput" maxlength="24" value="' + esc(s.name) + '">' +
          '</div>' +
          '<div class="sr-ops">' +
          '<button data-act="rename-cancel">取消</button>' +
          '<button data-act="rename-save" class="is-danger">保存</button>' +
          '</div></div>';
        return;
      }

      // 副标题要能在窄屏一行内放下（右侧还有三个操作按钮）
      var sub = (s.courses.length ? s.courses.length + ' 门课' : '空课表') +
        ' · ' + s.settings.totalWeeks + ' 周' +
        ' · ' + (s.settings.semesterStart || '—') + ' 起';

      html += '<div class="sched-row' + (isActive ? ' is-active' : '') + '" data-id="' + s.id + '">' +
        '<div class="sr-main" data-act="switch">' +
        '<div class="sr-name"><span class="txt">' + esc(s.name) + '</span>' +
        (isActive ? '<span class="badge-cur">当前</span>' : '') + '</div>' +
        '<div class="sr-sub">' + esc(sub) + '</div>' +
        '</div>' +
        '<div class="sr-ops">' +
        '<button data-act="rename">重命名</button>' +
        '<button data-act="copy">复制</button>' +
        (list.length > 1 ? '<button data-act="del" class="is-danger">删除</button>' : '') +
        '</div></div>';
    });

    box.innerHTML = html;

    if (renamingId) {
      var inp = $('renameInput');
      if (inp && inp.focus) {
        inp.focus();
        if (inp.select) inp.select();
        // 软键盘弹起会压缩可视高度（原生把键盘高度转成了 WebView 的底部 padding），
        // 个别 WebView 版本在这之后不会自动把焦点元素滚回可视区 —— 延迟一次兜底。
        setTimeout(function () {
          if (renamingId && inp.scrollIntoView) inp.scrollIntoView(false);
        }, 350);
      }
    }
  }

  /** 切换当前显示的课表 */
  function switchTo(id) {
    if (id === S.activeId) return;
    if (!Store.setActive(id)) return;

    var s = Store.current();
    Store.syncTimesLength();
    S.viewWeek = maxWeekClamp(currentWeek());
    renamingId = null;

    var savedOk = Store.save();
    render();
    scrollToTop();
    syncImportTarget();
    renderSchedList();
    fillSettings(false);
    /* 写盘失败时由 Store.onSaveError 弹「保存失败」，这里就不要再报「已切换」了
       —— 两句一起弹，用户只会以为成功了。下面每一处 save 后带成功文案的调用点同理。 */
    if (savedOk) toast('已切换到「' + (s ? s.name : '') + '」');
  }

  function onSchedClick(e) {
    var el = closestBy(e.target || e.srcElement, 'data-act');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var row = closestBy(el, 'data-id');
    var id = row ? row.getAttribute('data-id') : null;
    if (!id) return;

    if (act === 'switch') { switchTo(id); return; }
    if (act === 'rename') { renamingId = id; renderSchedList(); return; }
    if (act === 'rename-cancel') { renamingId = null; renderSchedList(); return; }
    if (act === 'rename-save') {
      var inp = $('renameInput');
      var name = inp ? inp.value : '';
      if (!Store.rename(id, name)) { toast('课表名不能为空'); return; }
      renamingId = null;
      renderSchedList();
      syncSchedName();
      syncImportTarget();
      toast('已重命名为「' + Store.get(id).name + '」');
      return;
    }
    if (act === 'copy') {
      var c = Store.duplicate(id);
      if (!c) return;
      renderSchedList();
      syncImportTarget();
      toast('已复制为「' + c.name + '」');
      return;
    }
    if (act === 'del') {
      var s = Store.get(id);
      if (!s) return;
      // 自绘确认框（v1.9.20）：原来这里是 window.confirm，弹的是系统 AlertDialog
      openConfirm({
        parent: 'maskSched',
        title: '删除课表',
        message: '确定删除课表「' + s.name + '」？\n\n' +
          (s.courses.length ? '其中 ' + s.courses.length + ' 门课程会一并删除，' : '') +
          '该操作不可撤销。',
        okText: '删除',
        onOk: function () {
          // 只有一个课表时不能删：退回到课表管理，让用户接着选别的操作
          if (!Store.remove(id)) {
            toast('至少要保留一个课表');
            openMask('maskSched');
            return;
          }
          renamingId = null;
          S.viewWeek = maxWeekClamp(currentWeek());
          render();
          scrollToTop();
          renderSchedList();
          syncImportTarget();
          syncSchedName();
          fillSettings(false);
          openMask('maskSched');   // 确认框把这一层收掉了，重开让用户看到删完的结果
          /* 这条路上的写盘发生在 Store.remove() 内部，拿不到它的返回值 —— 问 lastSaveOk() */
          if (Store.lastSaveOk()) toast('已删除该课表');
        }
      });
    }
  }

  function openSchedSheet() {
    renamingId = null;
    renderSchedList();
    openMask('maskSched');
  }

  /** 新建课表：建好后直接进入改名状态，方便马上命名（如「大三下」） */
  function newSchedule() {
    var s = Store.create();
    Store.setActive(s.id);
    Store.syncTimesLength();
    S.viewWeek = 1;
    renamingId = s.id;
    var savedOk = Store.save();
    render();
    scrollToTop();
    syncImportTarget();
    renderSchedList();
    if (savedOk) toast('已新建课表，输入名字后点「保存」');
  }

  /* ============================================================
     设置
     ============================================================ */
  function fillSettings(includeName) {
    var s = Store.current();
    if (includeName !== false) {
      $('setSchedName').value = s ? s.name : '';
    }
    $('setStart').value = S.settings.semesterStart;
    syncStartDate();
    $('setTotal').value = S.settings.totalWeeks;
    $('setSections').value = S.settings.sections;
    syncTimesSummary();
    syncSegTheme();
  }

  /** 'YYYY-MM-DD' → '2026年8月31日 周一'；认不出返回空串 */
  function fmtDateCn(v) {
    var d = Store.parseDate(v);
    if (!d) return '';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
      Store.WEEKDAY_CN[d.getDay()];
  }

  /**
   * 「学期第一周的周一」那一行的可见文字。
   * 值仍然放在 #setStart 的 .value 里 —— 沿用一个 id 一处值的约定，
   * 所以 fillSettings / saveSettings 对它的读写一个字都没改（原来是 input[type=date]）。
   */
  function syncStartDate() {
    var el = $('startDateText');
    if (!el) return;
    el.textContent = fmtDateCn($('setStart').value) || '未设置';
  }

  /**
   * 打开月历挑开学日。
   * 保存时会自动对齐到所在周的周一（见 saveSettings 里的 Store.toMonday），
   * 所以选中的那一刻就把对齐结果**写在下面那行提示里** ——
   * 不然用户点了周三、存进去变成周一，会以为是 bug。
   */
  function openStartDate() {
    closeMask('maskSettings');
    openMask('maskDate');
    Picker.date({
      value: $('setStart').value,
      note: function (iso) {
        var mon = Store.toMonday(Store.parseDate(iso));
        return '这一周从 ' + (mon.getMonth() + 1) + '月' + mon.getDate() + '日（' +
          Store.WEEKDAY_CN[mon.getDay()] + '）起算第 1 周';
      },
      onConfirm: function (iso) {
        $('setStart').value = iso;
        syncStartDate();
        backFromDate();
      },
      onCancel: backFromDate
    });
  }

  function saveSettings() {
    var nm = $('setSchedName') ? $('setSchedName').value.trim() : '';
    if (nm) Store.rename(S.activeId, nm);

    var sd = $('setStart').value;
    if (sd) {
      var d = Store.parseDate(sd);
      if (d) S.settings.semesterStart = Store.fmtDate(Store.toMonday(d));
    }
    var total = parseInt($('setTotal').value, 10);
    if (!isNaN(total) && total > 0) S.settings.totalWeeks = Math.min(40, total);

    var sec = parseInt($('setSections').value, 10);
    var wantSec = (!isNaN(sec) && sec >= 1)
      ? Math.max(1, Math.min(16, sec))
      : S.settings.sections;

    /* 调小「每天节数」= 从尾部砍掉时间设置，那是用户一行行手填的（最多 16 行），
       砍掉既没提示也找不回来。先问一句；取消就原样退回设置页，什么都不动。 */
    var willDrop = Math.max(0, (S.settings.times || []).length - wantSec);
    if (wantSec < S.settings.sections && willDrop > 0) {
      openConfirm({
        parent: 'maskSettings',
        title: '调小每天节数',
        message: '每天节数从 ' + S.settings.sections + ' 改成 ' + wantSec + '，会丢弃第 ' +
          (wantSec + 1) + ' 节起共 ' + willDrop + ' 条时间设置。\n\n该操作不可撤销。',
        okText: '继续',
        onOk: function () { commitSettings(wantSec); }
      });
      return;
    }
    commitSettings(wantSec);
  }

  /** 设置页真正落库的那一步。单独抽出来，是因为「调小每天节数」要先过一次确认框 */
  function commitSettings(wantSec) {
    S.settings.sections = wantSec;

    // 时间表不在这里解析了：它由「上课时间表」那一整页用草稿 + 自己的「保存」负责，
    // S.settings.times 拿到的已经是最终值。这里只把长度对齐到「每天节数」。
    Store.syncTimesLength();
    var savedOk = Store.save();
    S.viewWeek = maxWeekClamp(currentWeek());
    render();
    syncSchedName();
    syncImportTarget();
    if (savedOk) toast('设置已保存');
    closeMask('maskSettings');
  }

  /* ============================================================
     编辑时间表（设置里「上课时间表」点进来的一整页）
     ------------------------------------------------------------
     整页只操作一份**草稿**（ttTimes / ttFixed / ttDuration / ttSections）：
       · 返回（或按返回键）= 丢掉草稿，什么都没改；
       · 保存 = 才写回当前课表。
     这样不存在「改到一半」的半保存状态，也不需要撤销机制。

     时间表的算术全在 store.js 里（纯函数，能被直接单测）；
     这一层只负责「读输入 → 交给 store → 用返回值刷新显示」。
     ============================================================ */
  var ttTimes = null;      // 草稿：每一节的起止时间
  var ttFixed = true;      // 草稿：「固定上课时长」
  var ttDuration = 45;     // 草稿：每节课时长（分钟）
  var ttSections = 12;     // 草稿：节数（「添加」会 +1）
  var ttRows = [];         // 每一行两个 input 的引用，避免整块重绘把焦点弄丢

  var DUR_CHOICES = [];
  (function () { for (var m = 30; m <= 90; m += 5) DUR_CHOICES.push(m); })();

  /** 'HH:MM' 规整；认不出来就返回空串（input[type=time] 只认严格格式，
      老数据里手打的 '8:00' 直接塞进去会被浏览器清空，等于把时间吃掉了） */
  function safeTime(s) {
    var v = Store.timeToMin(s);
    return isNaN(v) ? '' : Store.minToTime(v);
  }

  function timesSummaryText() {
    var t = S.settings.times;
    if (!t || !t.length) return '未设置';
    return '共 ' + S.settings.sections + ' 节 · 第 1 节 ' + safeTime(t[0].start) + ' 起';
  }

  function syncTimesSummary() {
    var el = $('timesSummary');
    if (el) el.textContent = timesSummaryText();
  }

  /**
   * 打开「单选列表」那层。三处共用（每节课时长 / 星期 / 导入到哪个课表），
   * 差别只在 items 与 onPick。
   * 进去之前先收掉父层（弹层不许叠），退回时由 BULLET_BACK 亮回它。
   * **先 openMask 再 Picker.list**：列表要把当前值滚到中间，那一步要布局。
   */
  function openPick(opts) {
    pickParent = opts.parent;
    closeMask(pickParent);
    openMask('maskPick');
    Picker.list({
      title: opts.title,
      items: opts.items,
      value: opts.value,
      onPick: function (v) {
        opts.onPick(v);
        backFromPick();        // 点一下即生效并退回 —— 少一次「确定」
      },
      onCancel: backFromPick
    });
  }

  /** 把 ttDuration 反映到那一行（值放 .value、可见文字放 #ttDurText） */
  function syncDurRow() {
    var btn = $('ttDur');
    if (btn) btn.value = String(ttDuration);
    var t = $('ttDurText');
    if (t) t.textContent = ttDuration + ' 分钟';
  }

  /**
   * 时长改变：以它为准往下重排（第一节起点不动、**课间间隔从原表量**）。
   * 只改结束时间的话，变长的课会压进下一节里。
   */
  function setDuration(v) {
    if (isNaN(v) || v <= 0) return;
    ttDuration = v;
    syncDurRow();
    if (ttFixed) {
      ttTimes = Store.withDuration(ttTimes, ttDuration);
      setRowValues();
    }
  }

  /** 每节课时长：30–90 每档 5 分钟；老数据里的非整档时长也补进来，别弄丢 */
  function openDurPick() {
    if (!ttFixed) return;                 // 关掉固定时长时这一项不归用户管
    var list = DUR_CHOICES.slice();
    if (list.indexOf(ttDuration) < 0) list.push(ttDuration);
    list.sort(function (a, b) { return a - b; });
    openPick({
      parent: 'maskTimetable',
      title: '每节课时长',
      value: String(ttDuration),
      items: list.map(function (m) { return { v: String(m), t: m + ' 分钟' }; }),
      onPick: function (v) { setDuration(parseInt(v, 10)); }
    });
  }

  /** 把一节的开始 / 结束时间写进那个格子里（值放 .value，文字放 textContent） */
  function setTimeBtn(el, v) {
    if (!el) return;
    el.value = v;
    el.textContent = v;
  }

  /**
   * 一节的开始 / 结束时间格。
   * v1.9.15 起是 **button 而不是 input[type=time]**：原生那种点开弹的是
   * 系统表盘 + 系统键盘，皮肤跟 Activity 主题走，页面主题够不着（用户报的
   * 四张截图里有两张就是它）。换成自绘滚轮后主题一致，
   * 而「值放在 .value 里」这条约定没变 —— app.js 其余地方与两套测试照旧。
   */
  function timeInput(i, key, value) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'tp';
    setTimeBtn(el, safeTime(value));
    el.setAttribute('data-i', String(i));
    el.setAttribute('data-k', key);
    el.setAttribute('aria-label', '第 ' + (i + 1) + ' 节课' + (key === 'start' ? '开始时间' : '结束时间'));
    return el;
  }

  /**
   * 打开滚轮改第 i 节的开始 / 结束时间。
   * 开着固定时长时，选完开始时间结束时间就定了 —— 直接把结果算给用户看，
   * 省得他选完还要退出去对一下下一节。
   */
  function openTimePick(i, key) {
    var cur = ttTimes[i];
    if (!cur) return;
    var isStart = key === 'start';
    var hint = null;
    if (ttFixed && isStart && ttDuration > 0) {
      hint = function (v) {
        var t = Store.timeToMin(v);
        if (isNaN(t)) return '';
        return '→ ' + Store.minToTime(Math.min(t + ttDuration, 23 * 60 + 59));
      };
    }
    closeMask('maskTimetable');
    openMask('maskTime');
    Picker.time({
      value: isStart ? cur.start : cur.end,
      title: '第 ' + (i + 1) + ' 节课' + (isStart ? '开始时间' : '结束时间'),
      endHint: hint,
      onConfirm: function (v) {
        onTimeChange(i, key, v);
        backFromTime();
      },
      onCancel: backFromTime
    });
  }

  /* ---- 行内左滑露出「删除」------------------------------------
     手指向左滑，行整体往左让位，底下红色的「删除」露出来。
     触摸与鼠标是**两条独立分支**（真机走触摸、桌面调试走鼠标），两条都要能跑。
     硬要求与课程详情弹层的拖拽一致：
       · 先判横向意图（|dx| > |dy|）才接管，否则把竖向手势让给页面滚动；
       · 只滑一半不算数，没滑够要回弹；松手按**位移过半 或 速度**判定；
       · **吃掉浏览器补发的 click**（否则滑完手指落点是时间输入框，
         会顺手把系统时间选择器点开，看起来就是「滑一下莫名弹出选时间」）；
       · 同一时刻只允许一行是滑开的。
     ------------------------------------------------------------ */
  var SWIPE_W = 76;       // 删除按钮宽度，必须与 app.css 里的 .tt-del 一致
  var SWIPE_SLOP = 6;     // 判定「这是一次滑动」而非点击的最小位移
  var SWIPE_MIN_DT = 8;   // 速度采样的最小间隔（ms）。低于它的两个点之间算速度会得出
                          // 荒谬的瞬时值（隔 1ms 挪 5px = 5000px/s），一跳就从「回弹」翻成「滑开」
  var openWrap = null;    // 当前滑开的那一行

  function rowOffset(row) {
    var m = /translateX\((-?\d+(?:\.\d+)?)px\)/.exec(row.style.transform || '');
    return m ? parseFloat(m[1]) : 0;
  }

  function closeOpenRow() {
    if (!openWrap) return;
    var row = openWrap.querySelector('.tt-row');
    if (row) { row.style.transition = ''; row.style.transform = ''; }
    openWrap.classList.remove('open');
    openWrap = null;
  }

  /** 事件落点是不是行内那个「删除」按钮（按钮会吞掉自己的文字，target 就是按钮本身） */
  function targetIsDelete(el, stopAt) {
    while (el && el !== stopAt) {
      if (el.getAttribute && el.getAttribute('data-del') !== null) return true;
      el = el.parentNode;
    }
    return false;
  }

  function bindRowSwipe(wrap, row) {
    var startX = 0, startY = 0, base = 0, dx = 0;
    var dragging = false, decided = false, moved = false;
    var lastT = 0, lastX = 0, vx = 0, suppressClick = false, startOnDel = false;

    function begin(x, y, target) {
      if (openWrap && openWrap !== wrap) closeOpenRow();   // 碰别处就收起已滑开的那一行
      startX = x; startY = y; base = rowOffset(row); dx = base;
      dragging = true; decided = false; moved = false; startOnDel = targetIsDelete(target, wrap);
      suppressClick = false;      // 新的一次按下：上一个待吃的 click 作废，免得误伤这一次
      lastT = Date.now(); lastX = x; vx = 0;
      row.style.transition = 'none';
    }

    function move(x, y, e) {
      if (!dragging) return;
      var ax = x - startX, ay = y - startY;
      if (!decided) {
        if (Math.abs(ax) < SWIPE_SLOP && Math.abs(ay) < SWIPE_SLOP) return;
        if (Math.abs(ax) <= Math.abs(ay)) {      // 竖向手势：撒手让页面自己滚
          dragging = false;
          row.style.transition = '';
          return;
        }
        decided = true;
      }
      var t = Date.now();
      if (t - lastT >= SWIPE_MIN_DT) {       // 采样间隔太小的那两点不参与，噪声
        vx = (x - lastX) / (t - lastT);
        lastX = x; lastT = t;
      }
      dx = Math.max(-SWIPE_W, Math.min(0, base + ax));    // 只允许往左拉出 [−W, 0]
      moved = true;
      row.style.transform = dx ? 'translateX(' + dx + 'px)' : '';
      if (e && e.cancelable) e.preventDefault();
    }

    function end() {
      if (!dragging) return;
      dragging = false;
      row.style.transition = '';        // 先恢复过渡，后面哪条分支都要有动画
      if (!decided) {
        /* 单点：点在已经滑开的那一行上 → 收起来。
           点在「删除」按钮上不算，交给按钮自己的 click。 */
        if (openWrap === wrap && !startOnDel) closeOpenRow();
        return;
      }
      var open;
      if (vx < -0.5) open = true;                       // 甩得快按速度判
      else if (vx > 0.5) open = false;
      else open = dx <= -SWIPE_W / 2;                   // 否则按位移过半判
      if (open) {
        row.style.transform = 'translateX(-' + SWIPE_W + 'px)';
        wrap.classList.add('open');
        openWrap = wrap;
      } else {
        row.style.transform = '';
        wrap.classList.remove('open');
        if (openWrap === wrap) openWrap = null;
      }
      if (moved) suppressClick = true;    // 让紧随其后的那一个补发 click 被吃掉
    }

    // 触摸分支（真机）
    wrap.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      begin(e.touches[0].clientX, e.touches[0].clientY, e.target || e.srcElement);
    }, { passive: true });
    wrap.addEventListener('touchmove', function (e) {
      if (!dragging || e.touches.length !== 1) return;
      move(e.touches[0].clientX, e.touches[0].clientY, e);
    }, { passive: false });
    wrap.addEventListener('touchend', end);
    wrap.addEventListener('touchcancel', end);

    // 鼠标分支（网页版 / 桌面调试）。挂在 document 上，拖出行外也跟得住。
    function onMouseMove(e) { move(e.clientX, e.clientY, e); }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      end();
    }
    wrap.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      begin(e.clientX, e.clientY, e.target || e.srcElement);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    /* 捕获阶段就把补发的 click 拦掉，别让它落到里面的 input 上。
       只吃「紧跟着这一次滑动」的那**一个**：用完即清，下一次按下时也会清。
       用时间窗（比如 400ms）会误伤——滑完立刻点「删除」是常态，
       时间窗会把这一下也吞掉，看起来就是「滑开了却删不动」。
       「删除」本身更是要豁免。 */
    wrap.addEventListener('click', function (e) {
      if (!suppressClick) return;
      suppressClick = false;
      var t = e.target || e.srcElement;
      if (targetIsDelete(t, wrap)) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  function renderTimes() {
    var box = $('ttList');
    if (!box) return;
    box.innerHTML = '';
    ttRows = [];
    openWrap = null;        // 行被重建了，之前滑开的那一行已经不存在

    ttTimes.forEach(function (t, i) {
      /* 外层只负责「裁剪」：行往左滑出去的那一块由它挡着，露出来的是底下的删除按钮 */
      var wrap = document.createElement('div');
      wrap.className = 'tt-row-wrap';

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'tt-del';
      del.setAttribute('data-del', String(i));
      del.setAttribute('aria-label', '删除第 ' + (i + 1) + ' 节');
      del.textContent = '删除';
      wrap.appendChild(del);

      var row = document.createElement('div');
      row.className = 'card-row tt-row';

      var label = document.createElement('span');
      label.className = 'cr-label';
      label.textContent = '第 ' + (i + 1) + ' 节课';
      row.appendChild(label);

      var timesBox = document.createElement('span');
      timesBox.className = 'tt-times';
      var si = timeInput(i, 'start', t.start);
      var dash = document.createElement('span');
      dash.className = 'tp-dash';
      dash.textContent = '-';
      var ei = timeInput(i, 'end', t.end);
      timesBox.appendChild(si);
      timesBox.appendChild(dash);
      timesBox.appendChild(ei);
      row.appendChild(timesBox);
      wrap.appendChild(row);

      bindRowSwipe(wrap, row);

      ttRows.push({ start: si, end: ei, del: del, row: row, wrap: wrap });
      box.appendChild(wrap);
    });
    applyFixedState();
  }

  /**
   * 删掉第 i 节。算术在 store.js 的 removeSection 里（纯函数，直接单测）：
   * 后面几节整体上移，把空出来的位置补掉，课间间隔不变。
   * 删完重新渲染——行数变了，只赋值那种「不重画」的做法在这里不适用。
   */
  function deleteSection(i) {
    if (ttSections <= 1) { toast('至少要保留 1 节'); return; }
    ttTimes = Store.removeSection(ttTimes, i);
    ttSections = ttTimes.length;
    renderTimes();
  }

  /**
   * 只改 input 的值，不重画 DOM。
   * 必须回写：整体平移的位移可能被夹取（不能与上一节重叠、不能跨过 23:59），
   * 实际生效的时间与用户敲进去的可能不一样——不回写就等于骗人。
   * 重画 DOM 则会打断正在输入的输入法，所以只赋值。
   */
  function setRowValues() {
    ttRows.forEach(function (r, i) {
      var t = ttTimes[i];
      if (!t) return;
      setTimeBtn(r.start, safeTime(t.start));
      setTimeBtn(r.end, safeTime(t.end));
    });
  }

  /** 开关 / 时长的可用状态：固定时长关掉时，时长这一项不归用户管（灰掉） */
  function applyFixedState() {
    $('ttFixed').checked = ttFixed;
    var durRow = $('rowDur');
    if (durRow) {
      if (ttFixed) durRow.classList.remove('off');
      else durRow.classList.add('off');
    }
    var sel = $('ttDur');
    if (sel) sel.disabled = !ttFixed;
    ttRows.forEach(function (r) {
      r.end.disabled = ttFixed;
      if (r.del) r.del.disabled = ttSections <= 1;    // 只剩一节就不给删了
    });
    var addBtn = $('ttAdd');
    if (addBtn) addBtn.disabled = ttSections >= 16;
    var hint = $('ttFixedHint');
    if (hint) {
      hint.textContent = ttFixed
        ? '已开启：每节都按这个时长排，课间休息保持原样；改某一节的开始时间，后面的课跟着整体挪'
        : '已关闭：每一节的开始与结束时间都可以单独设置';
    }
  }

  function openTimetable() {
    var st = S.settings;
    ttFixed = !!st.fixedDuration;
    ttDuration = st.classDuration || Store.uniformDuration(st.times) || 45;
    ttSections = st.sections;
    ttTimes = Store.fitTimes(st.times.map(function (t) {
      return { start: safeTime(t.start), end: safeTime(t.end) };
    }), ttSections, ttDuration);
    syncDurRow();
    renderTimes();
    closeMask('maskSettings');       // 子弹层不许叠：进去之前先收掉父层
    openMask('maskTimetable');
  }
  /** 返回 / 返回键：丢掉草稿，亮回父层「设置」（草稿是局部变量，不写回就没了） */
  function backToSettings() {
    closeMask('maskTimetable');
    openMask('maskSettings');
  }

  /** 保存后把设置页里受影响的输入框同步一下（节数可能被「添加」改过） */
  function refreshSettingsAfterTimes() {
    var el = $('setSections');
    if (el) el.value = S.settings.sections;
    syncTimesSummary();
  }

  function saveTimetable() {
    S.settings.times = ttTimes.map(function (t) { return { start: t.start, end: t.end }; });
    S.settings.fixedDuration = ttFixed;
    S.settings.classDuration = ttDuration;
    S.settings.sections = ttSections;
    var savedOk = Store.save();
    S.viewWeek = maxWeekClamp(currentWeek());
    render();
    refreshSettingsAfterTimes();
    if (savedOk) toast('时间表已保存');
    closeMask('maskTimetable');
    openMask('maskSettings');
  }

  /**
   * 某节的时间被改动。三条分支：
   *  ① 固定时长 + 改开始时间：这一节改成新起点，**它之后的所有节整体平移相同位移**
   *     （课间间隔保持不变）。位移量由 Store.shiftTimes 夹取后返回，再用返回值刷新全部输入框；
   *  ② 固定时长 + 改结束时间：结束时间是算出来的，输入框本来就 disabled，走不到这；
   *  ③ 不固定时长：改哪一节就只动哪一节。
   */
  function onTimeChange(i, key, value) {
    if (ttFixed && key === 'start') {
      ttTimes = Store.shiftTimes(ttTimes, i, value, ttDuration);
    } else {
      ttTimes = Store.setTime(ttTimes, i, key, value);
    }
    setRowValues();
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  /* 折叠说明段（v1.9.46）：导入面板里那两段「读一次就够」的说明默认收起，
     不然方式二 / 方式三会被挤出屏幕。

     做法刻意通用：文案与目标都从 DOM 上取（`aria-controls` / `data-label-*`），
     这里一个中文字都不写。状态只落在**两个属性**上 —— `aria-expanded`（读屏与
     箭头方向都读它）与 `body.hidden`（参与不参与布局）。不另立一套 class 名，
     否则迟早出现「箭头转了但没收起」这种对不上的状态。
     键盘不用另外接：它是原生 <button>，Enter / 空格本来就能用。 */
  function bindFolds() {
    [].slice.call(document.querySelectorAll('.fold-t')).forEach(function (btn) {
      var body = document.getElementById(btn.getAttribute('aria-controls'));
      if (!body) return;
      var lab = btn.querySelector('span');
      var whenClosed = btn.getAttribute('data-label-collapsed') || '展开';
      var whenOpen = btn.getAttribute('data-label-open') || '收起';
      btn.addEventListener('click', function () {
        var opened = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', opened ? 'false' : 'true');
        body.hidden = opened;
        if (lab) lab.innerText = opened ? whenClosed : whenOpen;
      });
    });
  }

  function bind() {
    // 周切换（按钮）
    $('prevWeek').addEventListener('click', function () { goWeek(S.viewWeek - 1, 'right'); });
    $('nextWeek').addEventListener('click', function () { goWeek(S.viewWeek + 1, 'left'); });
    $('btnToday').addEventListener('click', function () {
      S.viewWeek = maxWeekClamp(currentWeek());
      render();
      scrollToTop();
    });

    // 左右滑动切换周次
    bindSwipe();

    // 导入面板里两段说明的折叠开关（v1.9.46）
    bindFolds();

    // 主题：周次栏最右边那个快捷切换（原来在顶栏）
    $('btnTheme').addEventListener('click', toggleTheme);

    /* 分享课表：顶栏按钮 → 弹层里三选一（复制文字 / 存 CSV / 发到聊天） */
    $('btnShare').addEventListener('click', openShareSheet);
    $('btnShareCancel').addEventListener('click', function () { closeMask('maskShare'); });
    $('btnShareCopy').addEventListener('click', shareByCopy);
    $('btnShareCsv').addEventListener('click', shareByCsv);

    /* 发送到聊天（分享层的子弹层）：三个定向 + 「其他应用」交回系统面板。
       取消 / 返回键 / 点弹层外三个出口共用 BULLET_BACK 里的 backToShare。 */
    $('btnShareSend').addEventListener('click', function () { openSendTo(null); });
    $('btnSendCancel').addEventListener('click', backToShare);
    $('btnSendWechat').addEventListener('click', function () { sendScheduleTo('wechat'); });
    $('btnSendQQ').addEventListener('click', function () { sendScheduleTo('qq'); });
    $('btnSendDing').addEventListener('click', function () { sendScheduleTo('dingtalk'); });
    $('btnSendMore').addEventListener('click', function () { sendScheduleTo('other'); });

    /* 自绘确认框的两个按钮；返回键与「点弹层外」走 BULLET_BACK，
       三个出口共用 backFromConfirm 这一份实现。 */
    $('confirmCancel').addEventListener('click', backFromConfirm);
    $('confirmOk').addEventListener('click', okConfirm);

    // 课表管理
    $('btnSched').addEventListener('click', openSchedSheet);
    $('btnSchedClose').addEventListener('click', function () { closeMask('maskSched'); });
    $('btnSchedNew').addEventListener('click', newSchedule);
    $('schedList').addEventListener('click', onSchedClick);

    // 导入
    $('btnImport').addEventListener('click', function () {
      pendingImport = null;
      $('importResult').innerHTML = '';
      syncImportTarget();
      syncEduEntry();
      openMask('maskImport');
    });
    $('btnImportClose').addEventListener('click', function () { closeMask('maskImport'); });
    $('importTarget').addEventListener('click', openImportTargetPick);
    $('importResult').addEventListener('click', function (e) {
      var el = closestBy(e.target || e.srcElement, 'data-imp');
      if (!el) return;
      commitImport(el.getAttribute('data-imp'));
    });
    // 方式一：主按钮打开「我的学校」教务（没填过学校时先引导去填）；次按钮是选择 / 添加学校
    $('btnEduEntry').addEventListener('click', openEduEntry);
    $('btnEduImport').addEventListener('click', openSchoolSheet);

    // 打开教务系统弹层
    $('schoolSearch').addEventListener('input', renderSchoolList);
    $('schoolList').addEventListener('click', onSchoolClick);
    $('btnSchoolClose').addEventListener('click', backToImport);
    $('btnSchManualToggle').addEventListener('click', function () { toggleSchoolPanel('manual'); });
    $('btnSchImportToggle').addEventListener('click', function () { toggleSchoolPanel('import'); });
    $('schUrl').addEventListener('input', updateUrlHint);
    $('btnSchZf').addEventListener('click', function () {
      var u = SCH.standardZfUrl($('schUrl').value);
      if (!u) { showSchoolResult('请先填一个域名，例如 jwglxt.xxx.edu.cn', true); return; }
      $('schUrl').value = u;
      updateUrlHint();
      showSchoolResult('已按正方新版的标准登录路径补全。若不是正方系统，请手动改回。');
    });
    $('btnSchSave').addEventListener('click', saveSchoolAndOpen);
    $('btnSchImportDo').addEventListener('click', doSchoolImport);
    $('btnSchExport').addEventListener('click', function () {
      var txt = SCH.exportText();
      if (!txt) { showSchoolResult('还没有自己添加的学校，没有可导出的内容。', true); return; }
      $('schImportArea').value = txt;
      showSchoolResult('已把「我的学校」填进上面的框里，长按选中即可复制备份或发给同学。');
    });
    $('fileInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      e.target.value = '';
      var box = $('importResult');
      box.innerHTML = '<div class="result-box">正在解析「' + esc(f.name) + '」…</div>';
      // 用「目标课表」的设置来解析，保证总周数/节数与该课表一致
      var t = importTarget();
      var useSettings = t.sched ? t.sched.settings : S.settings;
      Import.parseFile(f, useSettings).then(function (res) {
        applyImport(res);
      }).catch(function (err) {
        box.innerHTML = '<div class="result-box">导入失败：' +
          esc(err && err.message ? err.message : String(err)) + '</div>';
      });
    });
    $('btnImportPaste').addEventListener('click', function () {
      var text = $('pasteArea').value;
      if (!text.trim()) { toast('请先粘贴 CSV 内容'); return; }
      var t = importTarget();
      applyImport(Import.parseText(text, t.sched ? t.sched.settings : S.settings));
      $('pasteArea').value = '';
    });

    // 设置
    $('btnSettings').addEventListener('click', function () { fillSettings(); openMask('maskSettings'); });
    $('btnSettingsClose').addEventListener('click', function () { closeMask('maskSettings'); });
    $('btnSaveSettings').addEventListener('click', saveSettings);
    $('segTheme').addEventListener('click', function (e) {
      var el = closestBy(e.target || e.srcElement, 'data-theme');
      if (!el) return;
      Store.setTheme(el.getAttribute('data-theme'));
      applyTheme();
    });
    $('btnManageSched').addEventListener('click', function () {
      closeMask('maskSettings');
      openSchedSheet();
    });

    /* 上课时间表：设置里只剩一个入口行，点进独立一页去调 */
    $('btnTimes').addEventListener('click', openTimetable);
    $('btnBackupAll').addEventListener('click', backupAll);
    $('btnRestoreAll').addEventListener('click', function () {
      var el = $('restoreInput');
      if (el) el.click();
    });
    $('restoreInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      /* 先清空 value：同一个文件连选两次，第二次也要能触发 change */
      e.target.value = '';
      if (!f) return;
      global.CsvUtil.readFile(f).then(function (text) {
        restoreFromText(text);
      }).catch(function () {
        toast('读不出这个文件（可能不是文本文件）');
      });
    });
    /* 「学期第一周的周一」：自绘月历（v1.9.15）。绑定与别的行一样，
       只是这里点开的是一层弹层，不是原生 input[type=date] 的系统日历。 */
    $('setStart').addEventListener('click', openStartDate);
    /* 「星期」：自绘单选列表。原来它是个原生 <select>，
       保存时读的仍是 #addDay 的 .value，所以提交逻辑没变。 */
    $('addDay').addEventListener('click', openDayPick);
    $('ttBack').addEventListener('click', backToSettings);
    $('ttSave').addEventListener('click', saveTimetable);
    $('ttFixed').addEventListener('change', function () {
      ttFixed = !!this.checked;
      if (ttFixed) {
        // 打开就把整张表统一到这个时长（课间休息保持原样）。
        // 这是**看得见**的改动：不满意可以直接返回丢弃。
        ttTimes = Store.withDuration(ttTimes, ttDuration);
        setRowValues();
      }
      applyFixedState();
    });
    $('ttDur').addEventListener('click', openDurPick);
    // 每一节的时间改动走事件委托：行是动态生成的，逐个绑会漏
    $('ttList').addEventListener('change', function (e) {
      var el = e.target || e.srcElement;
      if (!el || !el.getAttribute) return;
      var i = parseInt(el.getAttribute('data-i'), 10);
      var k = el.getAttribute('data-k');
      if (isNaN(i) || !k) return;
      onTimeChange(i, k, el.value);
    });
    /* 行内左滑露出来的「删除」也走事件委托（行会重建）。
       同一行里既有可点的输入框、又有删除按钮 ⇒ **先判 data-del**，再谈别的。
       另外只有滑开之后按钮才真的露出来；没滑开时它被行盖着，
       这条判断同时替键盘 / 辅助功能挡掉「看不见却被激活」。
       同一趟遍历里顺手处理时间格：它是 button，点开自绘滚轮（v1.9.15）。 */
    $('ttList').addEventListener('click', function (e) {
      var el = e.target || e.srcElement;
      while (el && el !== this) {
        if (el.getAttribute && el.getAttribute('data-del') !== null) {
          var host = el.parentNode;
          if (!host || !host.classList || !host.classList.contains('open')) return;
          var di = parseInt(el.getAttribute('data-del'), 10);
          if (!isNaN(di)) deleteSection(di);
          return;
        }
        /* 时间格。被固定时长管着的结束时间那个是 disabled 的
           （disabled 的按钮本来就不派发 click，这里是第二道闸） */
        if (el.classList && el.classList.contains('tp') && !el.disabled) {
          var ti = parseInt(el.getAttribute('data-i'), 10);
          var tk = el.getAttribute('data-k');
          if (!isNaN(ti) && tk) { openTimePick(ti, tk); return; }
          return;
        }
        el = el.parentNode;
      }
    });
    $('ttAdd').addEventListener('click', function () {
      if (ttSections >= 16) { toast('最多 16 节'); return; }
      ttSections += 1;
      ttTimes = Store.fitTimes(ttTimes, ttSections, ttDuration);
      renderTimes();
    });
    $('ttReset').addEventListener('click', function () {
      ttTimes = Store.defaultTimes();
      ttSections = ttTimes.length;
      ttDuration = Store.uniformDuration(ttTimes) || 45;
      ttFixed = true;
      syncDurRow();
      renderTimes();
      toast('已恢复默认时间表，别忘了点保存');
    });

    $('btnClear').addEventListener('click', function () {
      if (!S.courses.length) { toast('当前课表没有课程'); return; }
      var cur = Store.current();
      var n = S.courses.length;
      // 自绘确认框（v1.9.20）：原来这里是 window.confirm
      openConfirm({
        parent: 'maskSettings',
        title: '清空课表',
        message: '确定清空课表「' + (cur ? cur.name : '') + '」的全部 ' + n +
          ' 门课程？\n\n其他课表不受影响，该操作不可撤销。',
        okText: '清空',
        onOk: function () {
          S.courses = [];
          var savedOk = Store.save();
          render();
          syncImportTarget();
          renderSchedList();
          openMask('maskSettings');   // 确认框把这一层收掉了，重开让用户看到清空后的结果
          if (savedOk) toast('已清空当前课表');
        }
      });
    });

    /* 卡片配色：一个调色盘 + 一个「自动」。
       两个都是静态节点，直接绑就行（v1.9.5 那排色点是动态生成的，才需要委托）。 */
    syncColorRow();

    $('btnPickColor').addEventListener('click', openColorPicker);
    $('btnAutoColor').addEventListener('click', pickAutoColor);

    /* 「自动」显示的是按课程名算出来的颜色，所以课名一改就得跟着刷新，
       否则用户会看到「改了课名，圆圈里还是原来的色」。 */
    $('addName').addEventListener('input', function () {
      if (formColor === null) syncColorRow();
    });

    /* 取色器：方块上拉「饱和度 + 明度」，色相条上拉「色相」。
       方块只需要 x/y，色相条只需要 y（横向位置不影响结果）。 */
    bindPick($('cpArea'), function (x, y) { setSv(x, y); });
    bindPick($('cpHueBar'), function (x, y) { setHueAt(y); });

    // 色值可以直接敲：敲到合法就立刻生效，敲废了（半截）就当没敲
    $('cpHex').addEventListener('input', function () {
      var ok = Store.normalizeHex(this.value);
      if (!ok) return;
      cpHexValue = ok;
      var hsv = Store.hexHsv(ok);
      if (hsv && hsv.s > 0.001) cpHue = hsv.h;   // 灰阶没有色相，保留色相条当前位置
      paintPicker();
    });
    $('cpHex').addEventListener('blur', function () {
      this.value = cpHexValue;                    // 敲废了就还原成当前生效的色
    });

    $('btnCpCancel').addEventListener('click', backToAdd);
    $('btnCpSave').addEventListener('click', saveColorPick);

    // 手动添加 / 编辑（同一个表单，由 openCourseForm 决定处于哪种模式）
    $('btnAdd').addEventListener('click', function () { openCourseForm(null); });
    $('btnAddClose').addEventListener('click', function () {
      closeMask('maskAdd');
      exitEditMode();                      // 字段刻意留着，下次接着填
    });
    $('btnAddSave').addEventListener('click', function () {
      var name = $('addName').value.trim();
      if (!name) { toast('请填写课程名称'); return; }
      var st = parseInt($('addStart').value, 10);
      var en = parseInt($('addEnd').value, 10);
      if (isNaN(st) || isNaN(en)) { toast('节数填写有误'); return; }
      if (en < st) { var t = st; st = en; en = t; }

      /* 越界要说出来，**不做静默夹取**：夹取是替用户改他的输入，
         存下去之后课在课表里根本不出现（超出的节次画在网格外），
         用户只会以为「保存失败了」，然后一遍遍重填。
         说清楚「现在是几节、要去哪里改」，他一步就能解决。 */
      var maxSec = S.settings.sections;
      if (st < 1 || en > maxSec) {
        toast('节次要在 1 ~ ' + maxSec + ' 之间（当前课表每天 ' + maxSec +
          ' 节，可到「设置」里调整）');
        return;
      }

      var wp = Store.parseWeeksExpr($('addWeeks').value, S.settings.totalWeeks);
      var fields = {
        name: name,
        day: parseInt($('addDay').value, 10),
        start: st,
        end: en,
        teacher: $('addTeacher').value.trim(),
        location: $('addLocation').value.trim(),
        weeks: wp.weeks.length ? wp.weeks : Store.parseWeeksExpr('', S.settings.totalWeeks).weeks,
        weeksText: $('addWeeks').value.trim() || Store.formatWeeks(wp.weeks),
        /* 两个键都**显式写**（而不是省略）：编辑是逐字段覆盖，省略就清不掉旧值。
           color 记自定义色值，hue 一律清成 null —— v1.9.5 那批只存了色相的老数据，
           第一次编辑时会被折算成等价色值写进 color，颜色不会跳。 */
        color: formColor,
        hue: null
      };

      // 编辑模式：就地改在这门课上（改星期 / 节次会让卡片换位置，render 会跟着走）
      if (editId) {
        var target = findCourse(editId);
        if (!target) {
          toast('这门课已经不在了');
          closeMask('maskAdd'); exitEditMode(); render();
          return;
        }
        for (var k in fields) {
          if (Object.prototype.hasOwnProperty.call(fields, k)) target[k] = fields[k];
        }
        var savedOk = Store.save(); render(); closeMask('maskAdd'); clearCourseForm();
        if (savedOk) toast('已保存修改');
        return;
      }

      fields.id = Store.uid();
      S.courses.push(fields);
      var savedOk2 = Store.save(); render(); closeMask('maskAdd'); clearCourseForm();
      if (savedOk2) toast('已添加课程');
    });

    // 详情：编辑 / 复制 / 删除（关闭靠「向下拖拽」或「点弹层外」）
    $('btnDetailEdit').addEventListener('click', function () {
      var c = detailId ? findCourse(detailId) : null;
      if (!c) return;
      closeMask('maskDetail');
      openCourseForm(c);
    });
    $('btnDetailCopy').addEventListener('click', function () { openCopyMenu(); });
    $('btnDetailDelete').addEventListener('click', function () {
      if (!detailId) return;
      var id = detailId;
      // 自绘确认框（v1.9.20）：原来这里是 window.confirm。
      // 删完要一路回到课表，所以 onOk 里**不**重开任何弹层。
      openConfirm({
        parent: 'maskDetail',
        title: '删除课程',
        message: '确定删除该课程？\n\n删除后无法撤销。',
        okText: '删除',
        onOk: function () {
          S.courses = S.courses.filter(function (c) { return c.id !== id; });
          detailId = null;
          var savedOk = Store.save();
          render();
          if (savedOk) toast('已删除');
        }
      });
    });

    // 复制菜单的两个选项
    $('btnCopyFull').addEventListener('click', function () { doCopy('full'); });
    $('btnCopyName').addEventListener('click', function () { doCopy('name'); });
    $('btnCopyCancel').addEventListener('click', backToDetail);

    // 详情弹层：向下拖拽关闭
    bindSheetDrag('maskDetail');

    /* 点弹层外的空白处 = 关闭。
       同样不写死名单：遍历页面上每一个 .mask，谁开着就关谁。
       子弹层（复制菜单 / 选择学校）走 BULLET_BACK 退回父层，其余整层关掉。
       以后再加弹层，这里天然覆盖，不会再出现「漏一个」的事。 */
    [].forEach.call(document.querySelectorAll('.mask'), function (mask) {
      mask.addEventListener('click', function (e) {
        if (e.target !== mask) return;
        var back = BULLET_BACK[mask.id];
        if (back) back(); else closeMask(mask.id);
      });
    });

    // 滚动时更新底部渐隐
    $('gridWrap').addEventListener('scroll', updateFade);

    // 「跟随系统」时，系统切换深浅色要立刻跟上
    if (global.matchMedia) {
      try {
        var mq = global.matchMedia('(prefers-color-scheme: dark)');
        var onMq = function () { if (Store.theme() === 'auto') applyTheme(); };
        if (mq.addEventListener) mq.addEventListener('change', onMq);
        else if (mq.addListener) mq.addListener(onMq);
      } catch (e) { /* 忽略 */ }
    }

    // 屏幕旋转 / 尺寸变化时重排（行高按新的可视高度重算）
    var rt = null;
    global.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { render(); }, 160);
    });
    global.addEventListener('orientationchange', function () {
      setTimeout(function () { render(); scrollToTop(); }, 300);
    });

    // 由原生主动触发的安全区刷新（旋转、导航栏模式变化等）
    global.__applySafeArea = function () {
      applySafeArea();
      render();
    };

    /* 原生返回键的入口。
       handleBack 是首选：它知道子弹层该退回父层、其它层才整体关闭。
       closeAllMasks 保留（仍是「全关」兜底），但正常路径不再直接用它。 */
    global.handleBack = handleBack;
    global.closeAllMasks = closeAllMasks;
  }

  /**
   * 课表纵向视图固定回到顶部（第 1 节）。
   *
   * 历史问题：早期切换周次时还会「自动定位到当前时间所在节次」，
   * 于是下午滑到下一周时视图停在 5-12 节，必须手动上滑才能看到 1-4 节。
   * 现在所有「切换周次 / 打开应用 / 旋转屏幕」都统一回到顶部，
   * 一屏始终完整显示第 1-8 节，只有用户自己滑动才会改变纵向位置。
   */
  function scrollToTop() {
    var wrap = $('gridWrap');
    if (!wrap) return;
    wrap.scrollTop = 0;
    updateFade();
  }

  /* ============================================================
     桌面小组件数据推送
     ------------------------------------------------------------
     页面是数据的唯一主人（课表存在 localStorage 里），小组件只是它的显示器。
     所以每次写盘后把「从今天起 56 天每天上什么课」算好推给原生，
     原生存进 SharedPreferences，小组件再按当前时间从里面取当天的课。
     周次、单双周、节次→钟点、课程配色全在 Store.buildWidgetData 里算完，
     原生不重算任何课表规则 —— 重算必然和页面漂移。

     浏览器里没有 AndroidWidget 桥（网页版没有小组件这回事），静默跳过。
     ============================================================ */
  var widgetTimer = null;
  var widgetLastKey = null;      // 上一次真正推出去的快照内容（不含 pushedAt）

  /* 真正干活的那个：算快照 → 推原生。
     两道省事：
       ① **内容没变就不推**。快照里只有「课表名 + 起止日期 + 56 天课程」是有意义的，
          `pushedAt` 每次都不同（它是时间戳），拿它做比较等于没比较。
          改主题、改「每节课时长」（不落到卡片上的那种）本来就不影响组件显示的内容，
          没必要为它们跨一次进程。
       ② 调用方看到的 pushWidget 是**防抖**过的（见下），
          连续写盘（比如导入时「调周数 → 调节数 → 落库」连着几次）只推最后那一次。 */
  function pushWidgetNow() {
    var bridge = global.AndroidWidget;
    if (!bridge || typeof bridge.sync !== 'function') return;
    var data;
    try { data = Store.buildWidgetData(); } catch (e) { return; }
    var key = data.v + '|' + data.schedule + '|' + data.start + '|' + JSON.stringify(data.days);
    if (key === widgetLastKey) return;
    try {
      bridge.sync(JSON.stringify(data));
      widgetLastKey = key;
    } catch (e) {
      /* 推送失败不能影响页面本身；下次打开或下次写盘会再推一次 */
    }
  }

  /** 写盘钩子挂的是这个（防抖 250ms） */
  function pushWidget() {
    if (widgetTimer) clearTimeout(widgetTimer);
    widgetTimer = setTimeout(function () {
      widgetTimer = null;
      pushWidgetNow();
    }, 250);
  }

  /* ============================================================
     启动
     ============================================================ */
  function init() {
    Store.load();
    // 本校那一行挂进适配库查询层（字母列表 / 搜索 / 一键直达都由此查得到）。
    // schools.js 持有内容（校名 + 地址 + 用哪只上游脚本）、warehouse.js
    // 只认形状——两者在本模块这里会合。
    if (WH && SCH && typeof WH.setLocalSchools === 'function' &&
        typeof SCH.localLibrary === 'function') {
      WH.setLocalSchools(SCH.localLibrary());
    }
    applySafeArea();
    applyTheme();                   // 首帧可能已由 <head> 内联脚本定好，这里再校准一次
    S.viewWeek = maxWeekClamp(currentWeek());
    bind();
    syncSchedName();
    syncImportTarget();
    render();
    renderSchedList();
    scrollToTop();
    // 桌面小组件：先挂上「写盘就重推」的钩子，再补推一次——
    // 上一次运行留下的改动（比如在别处编辑过课表）只有这一次机会补上
    Store.onSave(pushWidget);
    pushWidget();
    // 写盘失败的提示挂在 Store 上：所有落库路径共用这一处，不让调用方各写各的
    Store.onSaveError(notifySaveError);
    // 安全区下发可能晚于首次渲染：下一帧再校正一次
    global.requestAnimationFrame && global.requestAnimationFrame(function () {
      applySafeArea();
      render();
      scrollToTop();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.ScheduleApp = {
    render: render,
    state: S,
    goWeek: goWeek,
    fitRows: fitRows,
    VISIBLE_ROWS: VISIBLE_ROWS,
    /* 小组件推送：pushWidget 是防抖过的（挂在写盘钩子上），
       pushWidgetNow 是真正干活的那个 —— 测试要能直接驱动它，
       才量得到「内容没变就不推」这条短路有没有生效。 */
    pushWidget: pushWidget,
    pushWidgetNow: pushWidgetNow,
    // 课程卡配色（纯函数，测试直接调）
    hueOf: hueOf,
    storedHue: storedHue,
    hueOfCourse: hueOfCourse,
    courseColor: courseColor,
    courseBg: courseBg,
    // 多课表
    switchTo: switchTo,
    newSchedule: newSchedule,
    renderSchedList: renderSchedList,
    syncImportTarget: syncImportTarget,
    applyImport: applyImport,
    commitImport: commitImport,
    /* 分享课表：两种格式是纯函数（只读 state、不改任何东西），测试直接调，
       也方便和「导入端能不能吃回来」做跨端对账。 */
    scheduleShareText: scheduleShareText,
    scheduleCsvText: scheduleCsvText,
    openShareSheet: openShareSheet,
    /* 发送到聊天：暴露出来让测试能真跑「分享层 → 转发层 → 取消退回」这条链，
       以及用假的 AndroidShare 桩量「转发那一刻究竟传了什么参数」。 */
    openSendTo: openSendTo,
    backToShare: backToShare,
    sendScheduleTo: sendScheduleTo,
    /* 自绘确认框的三个出口。暴露出来是为了让冒烟测试能真跑一遍
       「父层 → 确认框 → 取消退回 / 确定执行」这条链，
       而不是只拿正则看源码里有没有那几个字符串。 */
    openConfirm: openConfirm,
    backFromConfirm: backFromConfirm,
    okConfirm: okConfirm,
    /* 教务系统内嵌浏览器（由 Android 侧回传结果）。
       两条入口对应原生侧的两条出口：适配脚本 / 下载下来的文件。
       v1.9.43 去掉了 onEduHtml 与 importHtml（自研抓页那条通道）。 */
    openEduBrowser: openEduBrowser,
    onEduBuffer: onEduBuffer,
    onEduAdapter: onEduAdapter,
    onEduStatus: onEduStatus,
    // 社区适配库（学校列表页用到；暴露出来是为了让冒烟测试能真跑一遍
    // 「拉索引 → 搜索 → 选中 → 交给原生」这条链，而不是只看源码里有没有那几行）
    refreshWarehouse: refreshWarehouse,
    libraryHits: libraryHits,
    libraryBlock: libraryBlock,
    libLetter: libLetter,
    libraryAlphabet: libraryAlphabet,
    openLibraryPick: openLibraryPick,
    openAdapterBrowser: openAdapterBrowser,
    pickFor: pickFor,
    rememberPick: rememberPick,
    // 主题
    applyTheme: applyTheme,
    toggleTheme: toggleTheme,

    /* 全量备份 / 恢复（v1.9.45）。
       `restoreFromText` 暴露出来是为了让测试能真跑「校验 → 确认框 → 覆盖 / 取消」
       这条链，而不是只拿正则看源码里有没有那几个字符串。
       导出 / 解析 / 落地的纯逻辑在 store.js 的 exportAll / parseBackup / importAll。 */
    backupAll: backupAll,
    restoreFromText: restoreFromText,
    // 桌面小组件（页面侧唯一入口：把快照推给原生）
    pushWidget: pushWidget
  };

})(typeof window !== 'undefined' ? window : globalThis);
