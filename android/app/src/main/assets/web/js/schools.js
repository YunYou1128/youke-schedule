/**
 * 学校教务系统入口列表（地址簿）
 * ------------------------------------------------------------
 * 只做一件事：把「学校名 -> 教务系统入口地址」这张表管起来，供导入面板
 * 的「选择学校」用。选中即把地址交给原生内嵌浏览器，用户不用再手敲或手改
 * 地址栏。
 *
 * 四条设计约定：
 *
 * 1) **内置数据只喂适配库，不做地址簿特例（v1.9.36，用户拍板）**。
 *    v1.9.35 曾把本校做成「primary：置顶分组 + 一键直达写死校名」，
 *    用户要求跟其他学校排一块、不要特例 —— 现在内置数据只经
 *    `localLibrary()` 以「仓库同形」条目挂进社区适配库列表
 *    （字母分组 + 搜索都查得到，和 200 多所学校一个待遇），
 *    地址簿（all / search / primary 一键直达）回归**纯用户数据**：
 *    最近使用、我的学校，都来自本机 localStorage。
 *    **适配脚本不随包（v1.9.42，用户拍板）**：这一行只提供
 *    「校名 + 教务地址」，脚本用社区适配库里那只「**正方教务-通用教务**」
 *    （上游 `zhengfang_jiaowu/zhengfang_01.js`），与本仓其他学校一样
 *    **运行时按四条源下载** —— 仓库里既没有自研脚本、也没有上游脚本的副本。
 *    本行的 `folder` 因此写的是**上游那只脚本所在的目录**（不是 `local`），
 *    `scriptUrls()` 直接据此拼出下载地址。
 *    地址一律由开发者提供，不是从任何第三方 App 的数据里搬来的。
 *
 * 2) `sys` 只是给用户看的「这个页面大概长什么样」的提示（正方新版 /
 *    正方老版 / 统一认证 …），**不参与解析**。解析器认的是页面上怎么写
 *    字（见 edugrab.js），跟学校、跟系统厂牌都无关。
 *
 * 3) `province` 字段仍保留，只为兼容批量导入 / 导出的既有格式
 *    （「校名,省份,地址」三列写法）。**界面上已不再按省份筛选**。
 *
 * 4) 所有数据只存在本机 localStorage，不上传。用户自己添加的学校
 *    （custom）与最近使用（recent）都是本机记录。
 *
 * 零第三方依赖；同时可在 Node 下 require 以做离线单测。
 */
(function (global) {
  'use strict';

  var KEY = 'schedule_app_schools_v1';
  var RECENT_MAX = 6;
  var CUSTOM_MAX = 200;

  /* ------------------------------------------------------------
     内置适配数据：**只有本校**，且只喂 localLibrary()（v1.9.36 起
     不进地址簿查询、没有 primary 特例 —— 本校和其他学校一样从
     适配库字母列表里点进去）。

     这一条**只提供校名与教务地址**，不提供脚本（v1.9.42）：
     脚本用社区适配库里的「正方教务-通用教务」那只，运行时下载。
     下面那组 `upstream*` 字段就是「用哪只脚本」的坐标 ——
     它们必须与上游索引里那条**逐字对齐**，否则编出来的下载地址会 404，
     而 404 的表现是「点了只转圈」，没有任何报错（真机上极难自查）。
     ------------------------------------------------------------ */
  var BUILTIN = [
    {
      name: '福建技术师范学院',
      province: '福建',
      sys: '正方新教务',
      url: 'https://xjxt-ls.fpnu.edu.cn/jwglxt/xtgl/login_slogin.html',
      abbr: 'FPNU',
      /* ── 用哪只上游脚本（坐标，不是副本） ─────────────────────
         上游索引里的条目：学校 `zhengfang_jiaowu` /「正方教务-通用教务」，
         适配器 `zhengfang_01` /「正方教务html通用获取」，维护者 星河欲转。
         `folder` 必须是**上游那份目录名**，`scriptUrls()` 会拼成
         `resources/zhengfang_jiaowu/zhengfang_01.js`，四源各一条。 */
      upstreamFolder: 'zhengfang_jiaowu',
      upstreamAdapterId: 'zhengfang_01',
      upstreamJsPath: 'zhengfang_01.js',
      upstreamAdapterName: '正方教务html通用获取',
      upstreamMaintainer: '星河欲转'
    }
  ];

  /* ------------------------------------------------------------
     工具
     ------------------------------------------------------------ */

  /** 补全协议头并去掉首尾空白；用户常直接粘 `jwglxt.xxx.edu.cn` */
  function normalizeUrl(input) {
    var u = String(input == null ? '' : input).replace(/\s+/g, '');
    if (!u) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
    return u;
  }

  /** 从输入里取出主机名（不含协议与路径），取不到返回 '' */
  function hostOf(input) {
    var u = normalizeUrl(input);
    var m = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#]+)/i.exec(u);
    return m ? m[1] : '';
  }

  /**
   * 主机名是不是一个「像样的域名 / IP」。
   * 只要求 ASCII 域名或 IPv4（可带端口）——教务系统的地址都是这类；
   * 这条校验的意义是拦住「把学校名当地址填了」这种错误，
   * 而不是穷举所有合法主机名写法（所以 intranet IP 如 10.1.1.197 也放行）。
   */
  function validHost(host) {
    var h = String(host == null ? '' : host).trim();
    if (!h) return false;
    var m = /^([^:\/]+)(?::(\d{1,5}))?$/.exec(h);
    if (!m) return false;
    if (m[2] && (+m[2] > 65535)) return false;
    var name = m[1];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) {
      return name.split('.').every(function (n) { return +n <= 255; });
    }
    // 至少一个点、每段以字母数字开头结尾、允许中间带横杠
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(name);
  }

  /**
   * 这一小段文本像不像一个地址？
   * 用于批量导入时「从一行里挑出地址那一列」——带协议头的、
   * 或长得像域名的（jwgl.example.edu.cn、jwxt.example.edu.cn:81）都算。
   */
  function looksLikeUrl(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true;
    // 不带协议头时按主机名判断，忽略后面可能跟的路径
    return validHost(t.split(/[\/?#]/)[0]);
  }

  /**
   * 按正方新版的标准登录路径补全。
   * 正方（jwglxt）的登录页路径是固定约定：/jwglxt/xtgl/login_slogin.html。
   * 用户只给了域名时，用这条规则能一步到位——所以做成**显式按钮**，
   * 不静默改用户的输入（非正方的学校补了就错）。
   */
  function standardZfUrl(input) {
    var host = hostOf(input);
    if (!host) return '';
    return 'https://' + host + '/jwglxt/xtgl/login_slogin.html';
  }

  /** 只给了域名、没有路径 —— 用来决定要不要提示「补全为正方标准入口」 */
  function isBareHost(input) {
    var u = normalizeUrl(input);
    if (!u) return false;
    return /^[a-z][a-z0-9+.-]*:\/\/[^\/]+\/?$/i.test(u);
  }

  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ------------------------------------------------------------
     持久化（本机 localStorage；坏数据一律当空，不让它把功能带崩）
     ------------------------------------------------------------ */
  var cache = null;

  function read() {
    if (cache) return cache;
    var d = { custom: [], recent: [] };
    try {
      var raw = global.localStorage && global.localStorage.getItem(KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.custom)) {
            d.custom = parsed.custom.filter(function (x) {
              return x && typeof x.name === 'string' && x.name && normalizeUrl(x.url);
            }).map(function (x) {
              return {
                id: x.id || uid(),
                name: String(x.name),
                province: String(x.province || '我的学校'),
                sys: String(x.sys || '自定义'),
                url: normalizeUrl(x.url),
                custom: true
              };
            });
          }
          if (Array.isArray(parsed.recent)) {
            d.recent = parsed.recent.filter(function (x) {
              return x && typeof x.name === 'string' && normalizeUrl(x.url);
            }).slice(0, RECENT_MAX).map(function (x) {
              return { name: String(x.name), url: normalizeUrl(x.url), sys: String(x.sys || '') };
            });
          }
        }
      }
    } catch (e) { /* 隐私模式 / 坏 JSON：当作没有 */ }
    cache = d;
    return d;
  }

  /* 最近一次写盘是否成功。和 Store.lastSaveOk() 是同一个道理：
     写盘发生在模块内部，调用方拿不到返回值，但「已保存 / 已删除」这类话
     必须说实话 —— 隐私模式 / 存储写满时，用户自建的学校重启后就没了。 */
  var _lastWriteOk = true;

  function lastWriteOk() { return _lastWriteOk; }

  function write() {
    var d = read();
    try {
      global.localStorage && global.localStorage.setItem(KEY, JSON.stringify({
        custom: d.custom, recent: d.recent
      }));
      _lastWriteOk = true;
    } catch (e) {
      /* 存不下不影响本次使用，**但不能让用户以为存好了** */
      _lastWriteOk = false;
    }
    return _lastWriteOk;
  }

  /** 测试与「清空我的学校」共用 */
  function reload() { cache = null; return read(); }

  /* ------------------------------------------------------------
     查询
     ------------------------------------------------------------ */

  /**
   * 地址簿 = 纯用户数据（v1.9.36 起**不含内置**：本校只走适配库通道，
   * 跟其他学校排一块，不做特例）。自定义排前面没有意义了，直接给。
   */
  function all() {
    return read().custom.slice();
  }

  /** 内置条目统一在这里成形（只喂 localLibrary / builtin 出口） */
  function builtinItem(i) {
    var b = BUILTIN[i];
    return {
      id: 'b' + i, name: b.name, province: b.province,
      sys: b.sys, url: b.url, abbr: b.abbr || '',
      custom: false
    };
  }

  /**
   * 本校的「社区适配库同形」条目，交给 Warehouse.setLocalSchools() 挂进
   * 学校列表（字母 F 组 + 搜索都能查到，与其他学校同一待遇）。
   *
   * **这一条与社区学校的差别只有两处**（v1.9.42）：
   *   ① 校名与教务地址是 `BUILTIN` 里写死的（用户点一下就落在正确站点上，
   *      不用自己敲地址）；
   *   ② `adapterId` 是 `youke_*` 前缀。
   * 脚本本体**不在这里** —— `folder` / `jsPath` 指向上游那只
   * 「正方教务-通用教务」，`scriptUrls()` 据此给出四条下载地址，
   * 与任何一所社区学校走的是同一条路。
   *
   * ⚠️ `adapterId` **必须与上游那只区分开**（这里用 `youke_b0_01`，
   * 上游是 `zhengfang_01`）：`adapterById()` 只返回第一个命中，
   * 两处同名的话，点「正方教务-通用教务」那一行会被本行截胡，
   * 而界面上的表现是「这所学校的适配脚本没找到」——查起来完全看不出是撞了 id。
   */
  function localLibrary() {
    var out = [];
    for (var i = 0; i < BUILTIN.length; i++) {
      var b = BUILTIN[i];
      if (!b.upstreamJsPath) continue;      // 没配脚本坐标的条目不进列表（免得点了没反应）
      out.push({
        id: 'youke_b' + i,
        name: b.name,
        initial: (b.abbr || b.name).charAt(0).toUpperCase(),
        /* 上游那只脚本所在的**目录名**（不是 `local`）——
           这是 scriptUrls() 唯一认的字段 */
        folder: b.upstreamFolder,
        adapters: [{
          adapterId: 'youke_b' + i + '_01',
          name: b.upstreamAdapterName,
          category: 1,
          jsPath: b.upstreamJsPath,
          importUrl: b.url,
          description: '登录教务后点「执行导入」，脚本读当前课表页面取回课程。'
            + '（本行用的是社区适配库里的正方通用脚本，学校地址由柚课预填。）',
          maintainer: b.upstreamMaintainer
        }]
      });
    }
    return out;
  }

  /**
   * 按关键词筛选**用户自己的**地址簿（内置不进来，见 all()）。
   * 关键词同时匹配：校名、省份、系统类型、URL 主机名——
   * 用户可能只记得「那个 jwglxt 开头的」。不按省份过滤。
   */
  function search(keyword) {
    var kw = String(keyword == null ? '' : keyword).trim().toLowerCase();
    return all().filter(function (s) {
      if (!kw) return true;
      var hay = [s.name, s.abbr || '', s.province || '', s.sys || '', hostOf(s.url)]
        .join(' ').toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
  }

  /** 按 URL 找（recent 里存的是快照，用来回填 sys / 标记是否已收藏） */
  function byUrl(url) {
    var u = normalizeUrl(url);
    var list = all();
    for (var i = 0; i < list.length; i++) {
      if (list[i].url === u) return list[i];
    }
    return null;
  }

  /* ------------------------------------------------------------
     自定义学校
     ------------------------------------------------------------ */

  function addCustom(name, url, province, sys) {
    var n = String(name == null ? '' : name).trim();
    var u = normalizeUrl(url);
    if (!n) throw new Error('请填写学校名称');
    if (!u) throw new Error('请填写教务系统地址');
    if (!validHost(hostOf(u))) throw new Error('地址里没有识别到有效的域名，请检查');

    var d = read();
    // 同地址只留一条：再添加视为更新名称
    for (var i = 0; i < d.custom.length; i++) {
      if (d.custom[i].url === u) {
        d.custom[i].name = n;
        if (province) d.custom[i].province = String(province);
        write();
        return d.custom[i];
      }
    }
    if (d.custom.length >= CUSTOM_MAX) throw new Error('自定义学校已达上限（' + CUSTOM_MAX + ' 条）');

    var item = {
      id: uid(), name: n,
      province: String(province || '我的学校'),
      sys: String(sys || '自定义'),
      url: u, custom: true
    };
    d.custom.unshift(item);
    write();
    return item;
  }

  function removeCustom(id) {
    var d = read();
    var n = d.custom.length;
    d.custom = d.custom.filter(function (x) { return x.id !== id; });
    if (d.custom.length !== n) { write(); return true; }
    return false;
  }

  function customList() { return read().custom.slice(); }

  /* ------------------------------------------------------------
     最近使用
     ------------------------------------------------------------ */

  function recent() { return read().recent.slice(); }

  /** 记一次「打开」；按 URL 去重并置顶 */
  function pushRecent(name, url, sys) {
    var u = normalizeUrl(url);
    if (!u) return;
    var d = read();
    d.recent = d.recent.filter(function (x) { return x.url !== u; });
    d.recent.unshift({ name: String(name || u), url: u, sys: String(sys || '') });
    if (d.recent.length > RECENT_MAX) d.recent.length = RECENT_MAX;
    write();
  }

  function clearRecent() {
    var d = read();
    d.recent = [];
    write();
  }

  /* ------------------------------------------------------------
     批量导入（给用户扩充列表的正式入口）
     ------------------------------------------------------------
     一行一条，支持三种分隔与「名字 地址」的空格写法：
       示例大学,https://jw.example.edu.cn/jwglxt/xtgl/login_slogin.html
       示例大学   https://...
       示例学院	http://jwgl.example.edu.cn/
     也接受 JSON： [{"name":"…","url":"…","province":"…","sys":"…"}, …]
     返回 { added, updated, skipped, errors }，调用方据此给用户交代。
     ------------------------------------------------------------ */
  function parseImport(text) {
    var raw = String(text == null ? '' : text).trim();
    var res = { added: 0, updated: 0, skipped: 0, errors: [] };
    if (!raw) return res;

    var rows = [];
    if (raw.charAt(0) === '[') {
      var arr;
      try { arr = JSON.parse(raw); } catch (e) {
        res.errors.push('JSON 解析失败：' + (e && e.message ? e.message : e));
        return res;
      }
      if (!Array.isArray(arr)) { res.errors.push('JSON 顶层不是数组'); return res; }
      rows = arr.map(function (x) {
        return {
          name: x && x.name, url: x && x.url,
          province: x && x.province, sys: x && x.sys
        };
      });
    } else {
      rows = raw.split(/\r?\n/).map(function (line) {
        var s = line.trim();
        if (!s || s.charAt(0) === '#') return null;

        var parts = null;
        if (s.indexOf(',') >= 0) parts = s.split(',');
        else if (s.indexOf('\t') >= 0) parts = s.split('\t');
        else {
          // 「名字 地址」：从末尾那段地址处切开
          var m = /\s+(\S+)\s*$/.exec(s);
          if (m) parts = [s.slice(0, m.index), m[1]];
        }
        if (!parts || parts.length < 2) return { bad: s };

        var name = String(parts[0] || '').trim();
        var rest = parts.slice(1).map(function (p) { return p.trim(); })
          .filter(function (p) { return p; });

        // 地址取「最后一个像地址的段」，前面的段当作省份 / 系统类型；
        // 这样「名字,地址」与「名字,省份,地址」两种写法都能吃。
        var url = '';
        for (var k = rest.length - 1; k >= 0; k--) {
          if (looksLikeUrl(rest[k])) { url = rest[k]; rest.splice(k, 1); break; }
        }
        return { name: name, url: url, province: rest[0], sys: rest[1] };
      }).filter(Boolean);
    }

    rows.forEach(function (r) {
      if (r && r.bad) { res.skipped++; res.errors.push('看不懂这一行：' + r.bad); return; }
      var name = String((r && r.name) || '').trim();
      var url = normalizeUrl((r && r.url) || '');
      if (!name || !url || !validHost(hostOf(url))) { res.skipped++; return; }
      if (byUrl(url)) {
        // 已在内置列表里 —— 跳过但不算错，免得用户以为没生效
        res.skipped++;
        return;
      }
      var before = customList().length;
      try {
        addCustom(name, url, r.province, r.sys);
        if (customList().length > before) res.added++; else res.updated++;
      } catch (e) {
        res.skipped++;
        res.errors.push(name + '：' + (e && e.message ? e.message : e));
      }
    });

    return res;
  }

  /* ------------------------------------------------------------
     导出（把「我的学校」和最近使用交出去，方便换机 / 备份）
     ------------------------------------------------------------ */
  function exportText() {
    var d = read();
    var lines = d.custom.map(function (x) {
      return [x.name, x.province, x.url].join(',');
    });
    return lines.join('\n');
  }

  function clearAll() {
    cache = { custom: [], recent: [] };
    try { global.localStorage && global.localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }

  var api = {
    KEY: KEY,
    RECENT_MAX: RECENT_MAX,
    builtin: function () { return BUILTIN.map(function (b, i) { return builtinItem(i); }); },
    localLibrary: localLibrary,
    all: all,
    search: search,
    byUrl: byUrl,
    hostOf: hostOf,
    validHost: validHost,
    normalizeUrl: normalizeUrl,
    standardZfUrl: standardZfUrl,
    isBareHost: isBareHost,
    addCustom: addCustom,
    removeCustom: removeCustom,
    lastWriteOk: lastWriteOk,
    customList: customList,
    recent: recent,
    pushRecent: pushRecent,
    clearRecent: clearRecent,
    parseImport: parseImport,
    exportText: exportText,
    clearAll: clearAll,
    reload: reload
  };

  global.Schools = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
