/**
 * warehouse.js —— 社区教务适配库（适配脚本索引）
 * ============================================================
 * 这是「学校 → 教务系统」这张地址簿的**数据源**，也是 v1.9.32 起
 * 教务导入的主通道：每所学校配一段适配脚本，脚本跑在用户的教务页面上，
 * 把课表通过一个约定好的桥交回来。
 *
 * 本模块只管一件事：**把那本索引拉下来、解开、存住、查得到**。
 * 执行适配脚本在原生侧（内嵌教务浏览器），见 EduLoginActivity.kt。
 *
 * ------------------------------------------------------------
 * 一、数据从哪来：**全部运行时下载**，四源按序回退（v1.9.41 定稿）
 * ------------------------------------------------------------
 * 这一层走过三段路，写清楚免得再走回去：
 *
 *   · v1.9.32「纯运行时拉」—— 只认 GitHub 系两条域名，国内网络里经常
 *     两条都不通：用户看得到入口，点下去永远「下载失败」。
 *   · v1.9.33「APK 内置全量快照 + 联网静默刷新」—— 能离线用，代价是把
 *     索引 + 256 只脚本（约 3.5 MB）塞进包里（APK 2.5 MB → 7.1 MB），
 *     而且**上游每更新一次就要重新发版**才拿得到新的。
 *   · v1.9.40 把分发源从两条扩到**四条**（Gitee 镜像 / jsDelivr /
 *     GitHub 回源 / ITDONG 镜像），国内网络下有四条路可试 ——
 *     内置快照当初要解决的那个问题（国内下不动）已经不成立。
 *   · **v1.9.41：拿掉内置快照，回到「全部运行时下载」** —— 与上游那个
 *     同名社区 App 的做法一致（它包里也只留一个几百字节的占位索引）。
 *     代价与对策都在下面写清，一条不藏。
 *
 * 代价（必须说清）：
 *   · **第一次使用需要联网**：本机没有任何清单时，四条源里**任一条通就行**；
 *     四条都不通就只能是空的 —— 界面走空态文案 + 重试，不装死。
 *   · 下载成功后清单落 localStorage，**之后离线可查、可搜、可用**；
 *     脚本是点某一行时才下**那一只**（不是整仓同步，也不预取 256 只）。
 *     换句话说：只有「第一次」需要网络，不是「每次」。
 *
 * 两条路的分工（v1.9.40 起，v1.9.41 不变）：
 *
 *   · **前台 `update()`**（用户点了「载入 / 更新适配库」，他在等）——
 *     按序试、**成功即停**：拿到一份能用的索引就走，不为「可能更新」多等三次；
 *   · **后台 `_silentRefresh()`**（没人等）—— **每个源都问一遍**，谁给出更新的
 *     版本就用谁的。**故意不提前退出**：镜像同步有小时级滞后，只看第一条源
 *     会让用户**永久停在某个镜像的旧版本**上，症状恰好是「我们学校搜不到」
 *     —— 本项目最忌讳的那种静默丢覆盖面。代价是每次多几个后台请求，
 *     索引才 75 KB，可以接受。
 *   · 正因如此，`update()` 成功后**仍然**踢一次静默刷新：前台可能停在一条
 *     滞后的镜像上，后台负责把它补正。
 *
 * **包里一只脚本都没有**（v1.9.42）。唯一「不是上游学校」的那一行
 * （本校，见 schools.js 的 `localLibrary()`）只提供**校名与教务地址**，
 * 脚本用的是上游「正方教务-通用教务」那只 —— 与所有社区学校一样
 * 由 `scriptUrls()` 给出四条下载地址，运行时现取现用。
 * v1.9.35~v1.9.41 曾经随包带一只**自研**脚本（`tools/adapter-local/`
 * → `web/js/adapter-local.js`，经桥的第 6 参把正文递给原生），v1.9.42
 * 整条路拆掉：自研脚本不再维护，正文不再进包，原生也不再需要
 * 「收一段脚本文本」这个入口。
 *
 * 注：「仓库里不能出现校名」的口径（v1.9.31 定的）**在 v1.9.35 就被
 * 用户拍板放宽过**（校名 + 教务地址进包，人名类词条照扫，见
 * 合规清单 §2.6.2）；本模块自己仍然一个校名、一个教务域名都没有 ——
 * 上游学校全在运行时从索引来，本校那一行由 schools.js 经
 * `setLocalSchools()` 注册进来（本模块只见形状、不见内容）。
 *
 * ------------------------------------------------------------
 * 二、索引长什么样（上游协议 v2）
 * ------------------------------------------------------------
 * 上游把索引编译成一份 protobuf（`school_index.pb`，约 75 KB），放在
 * 一个孤立分支上；字段定义见上游 `proto/school_index.proto`：
 *
 *   SchoolIndex { int32 protocol_version = 1; string version_id = 2;
 *                 repeated School schools = 3; }
 *   School      { string id = 1; string name = 2; string initial = 3;
 *                 string resource_folder = 4; repeated Adapter adapters = 5; }
 *   Adapter     { string adapter_id = 1; string adapter_name = 2;
 *                 AdapterCategory category = 3; string asset_js_path = 4;
 *                 optional string import_url = 5; string description = 6;
 *                 string maintainer = 7; }
 *
 * 本模块**自带一个极简 protobuf 读取器**（见下面的 readFields），
 * 只实现 proto3 里真正用到的四种 wire type。不引任何库 ——
 * 一是本工程「web/ 零第三方依赖」这条底线，二是这层格式窄到
 * 自己写一遍反而比引库更好维护（引库就要跟着它升版）。
 *
 * ------------------------------------------------------------
 * 三、接入策略：只接入「教务适配器」
 * ------------------------------------------------------------
 * 上游的 `GENERAL_TOOL`（通用工具）这一类里混着三种东西：
 * 面向教务系统的通用适配（想要）、上游自己的演示 / 测试脚本（不该跑）、
 * 以及「从第三方应用私有接口取数据」的工具脚本（不该跑）。
 *
 * 判据见下面 `acceptAdapter` 上面那段：教务类全收；通用工具里
 * **`import_url` 为空**的才收（那正是「让用户自己填教务网址」的通用教务适配），
 * 再加一张只装演示 / 测试脚本的点名表。
 * 关键的一条是**别把它写成 id 名单** —— 试过，拿真索引一跑就漏了两所。
 *
 * ------------------------------------------------------------
 * 四、本模块不许出现的东西
 * ------------------------------------------------------------
 * 校名与教务地址**在本模块里一个都没有**：上游的全在运行时从索引来，
 * 本校的由 schools.js 经 `setLocalSchools()` 注册进来（本模块只见形状、
 * 不见内容）。仓库里搜不到任何一所学校的名字、
 * 也搜不到任何教务域名 —— 这是 v1.9.31 定下的验收口径，本模块必须守住
 * （smoke-test.js 里有对应的形状断言；上面的夹具用的是 `示例大学` /
 * `example.edu.cn` 这类占位值，正好落在它显式放行的范围内）。
 *
 * 零第三方依赖；可在 Node 下 require 以做离线单测。
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------
     上游地址
     ------------------------------------------------------------
     这里写的是**仓库路径**，不是产品名：适配脚本是上游贡献者的作品，
     按 MIT 与上游社区公约必须保留来源与作者（`maintainer` 字段随索引
     一起来，界面上会显示）。README「第三方资源与致谢」一节有完整声明。
     ------------------------------------------------------------ */
  var OWNER = 'ShiGuangSchedule/shiguang_warehouse';        // GitHub 官方
  var OWNER_GITEE = 'XingHeYuZhuan-gh/shiguang_warehouse';  // 上游作者的 Gitee CN 镜像站
  var OWNER_ITDONG = 'XingHeYuZhuan/shiguang_warehouse';    // 上游作者的 ITDONG 镜像（Gogs）

  /** 索引放在**孤立分支**上；适配脚本在 `main`。两者都由上游 CI 产出，不手改 */
  var BRANCH_INDEX = 'index-pb-release';
  var BRANCH_MAIN = 'main';
  var INDEX_FILE = 'school_index.pb';
  var RES_DIR = 'resources';

  /**
   * 分发源：**一张表，不是散落的常量**（v1.9.40）。
   *
   * ------------------------------------------------------------
   * 为什么要有多份
   * ------------------------------------------------------------
   * v1.9.32 只留 GitHub 系域名，真机上翻车了一半用户：国内网络里
   * `raw.githubusercontent.com` 与 `cdn.jsdelivr.net` **都可能连不上**，
   * 界面表现是「有学校列表、点了永远『下载失败』」。
   * 上游作者为此自己维护了多份分发入口（Gitee 镜像站 + 自建 ITDONG 镜像），
   * 这里把它们一起接上 —— **任一条通就行**。
   *
   * ------------------------------------------------------------
   * 顺序怎么定的：**实测过的排前面，没实测的排最后**
   * ------------------------------------------------------------
   * 下表顺序 = 2026-10 在本机（国内网络）逐条 curl 量出来的结果，
   * 不是照抄谁的配置：
   *
   *   ① `gitee`      —— 302 跳到 `raw.giteeusercontent.com`（原生侧
   *                     `instanceFollowRedirects = true`，跟得上），
   *                     实测 200 / 76908 字节，且 version_id 与上游**逐字相同**；
   *   ② `jsdelivr`   —— 实测 200 / 76908 字节，带 CDN 缓存，1.1 s；
   *   ③ `github-raw` —— 实测 200 / 3.1 s（国内时通时不通，留着兜底）；
   *   ④ `itdong`     —— 上游作者的三网优化镜像（Gogs 自建，全量镜像、
   *                     `index-pb-release` 由 Actions Bot 自动同步）。地址形状
   *                     对着上游网页核过（分支在、Raw 链接就是 `/raw/<分支>/<路径>`），
   *                     但**本机连不通**（TCP 443 能连、TLS 握手被重置，
   *                     属于本机网络层的干扰）⇒ 排最后：真机跑通了才有意义，
   *                     不通也只是多花一次回退，不会拖慢前面的源。
   *
   * 四条都**不是「第三方代理」性质的地址**：①②④ 是上游作者自己的官方镜像，
   * ③ 是上游自身的回源。这条口径与 v1.9.32 时一致。
   *
   * ⚠️ 这张表是**唯一事实源**：`INDEX_URLS` / `SCRIPT_BASES` 由它派生，
   * 原生侧 `MainActivity` 的前缀白名单与它一一对应（改这里必须改那里）。
   * ------------------------------------------------------------ */
  var SOURCES = [
    {
      id: 'gitee',
      name: 'Gitee 镜像',
      indexUrl: 'https://gitee.com/' + OWNER_GITEE + '/raw/' + BRANCH_INDEX + '/' + INDEX_FILE,
      scriptBase: 'https://gitee.com/' + OWNER_GITEE + '/raw/' + BRANCH_MAIN + '/' + RES_DIR + '/'
    },
    {
      id: 'jsdelivr',
      name: 'jsDelivr CDN',
      indexUrl: 'https://cdn.jsdelivr.net/gh/' + OWNER + '@' + BRANCH_INDEX + '/' + INDEX_FILE,
      scriptBase: 'https://cdn.jsdelivr.net/gh/' + OWNER + '@' + BRANCH_MAIN + '/' + RES_DIR + '/'
    },
    {
      id: 'github-raw',
      name: 'GitHub 回源',
      indexUrl: 'https://raw.githubusercontent.com/' + OWNER + '/' + BRANCH_INDEX + '/' + INDEX_FILE,
      scriptBase: 'https://raw.githubusercontent.com/' + OWNER + '/' + BRANCH_MAIN + '/' + RES_DIR + '/'
    },
    {
      id: 'itdong',
      name: 'ITDONG 镜像',
      indexUrl: 'https://git.itdong.me/' + OWNER_ITDONG + '/raw/' + BRANCH_INDEX + '/' + INDEX_FILE,
      scriptBase: 'https://git.itdong.me/' + OWNER_ITDONG + '/raw/' + BRANCH_MAIN + '/' + RES_DIR + '/'
    }
  ];

  /** 索引地址：**按表里的顺序试，前一个失败才试下一个** */
  var INDEX_URLS = SOURCES.map(function (s) { return s.indexUrl; });

  /** 适配脚本的目录前缀，与索引同源同序（一条源两头都要能用，否则等于没接） */
  var SCRIPT_BASES = SOURCES.map(function (s) { return s.scriptBase; });

  /** 兼容旧调用：主地址（排在最前面的那条） */
  var INDEX_URL = INDEX_URLS[0];
  var RAW_BASE = SCRIPT_BASES[0];

  /** 这个地址属于哪条源（给界面显示「这次走的是哪条路」）。认不出返回 null */
  function sourceOfUrl(url) {
    var s = String(url == null ? '' : url);
    for (var i = 0; i < SOURCES.length; i++) {
      if (s.indexOf(SOURCES[i].indexUrl) === 0 || s.indexOf(SOURCES[i].scriptBase) === 0) {
        return SOURCES[i];
      }
    }
    return null;
  }

  /** 按 id 找源。认不出返回 null（不抛） */
  function sourceById(id) {
    var s = String(id == null ? '' : id);
    for (var i = 0; i < SOURCES.length; i++) {
      if (SOURCES[i].id === s) return SOURCES[i];
    }
    return null;
  }

  var KEY = 'schedule_app_warehouse_v1';

  /** 只认这个协议版本。上游升到大版本时宁可明确报错，也不要按旧字段瞎读 */
  var SUPPORTED_PROTOCOL = 2;

  /* ------------------------------------------------------------
     接入策略：只接入「教务适配器」（见文件头 §三）
     ------------------------------------------------------------
     判据分两类，两类都是**结构性的**，不是一张会过期的名单：

       ① 类别本身就是教务（本/专科 = 2、研究生 = 3）—— 直接接入。
       ② 类别是「通用工具」（1）时，多问一句它长什么样：
          通用教务适配（「正方 / 超星 / 青果 / URP 这些家族的通用获取」）
          都要用户**自己填教务网址**，所以索引里它的 `import_url` 是空的；
          而面向某个站外服务的工具一定有预设地址。
          于是判据就是：**`import_url` 为空**。

     ② 为什么写成判据、而不是列一张 id 名单：这里一开始列的正是
     「正方 + 超星」两个 id，**拿真索引一跑就发现上游还有青果和 URP 两个通用教务**
     —— 名单当场就漏了。这类漏是「静默丢覆盖面」：界面看不出少东西，
     用户只会觉得「我们学校没有」。改成判据之后，上游再添新的通用教务家族会自动进来。

     要挡的两类，各用一条对应的规则：
       · 上游自己的**演示 / 测试脚本**（`GENERAL_TOOL_01` / `GENERAL_TOOL_02`）：
         前者会往用户课表里灌一批假课程，后者指向上游并不存在的文件。
         它们的 `import_url` 也是空的（长得跟通用教务一模一样），只能显式点名 ——
         这是本文件里**唯一**一张名单，新增一条必须能说清为什么。
       · **面向站外服务的工具**：`import_url` 非空 ⇒ 被 ② 那条判据自动挡掉，
         **不必在这里点名**。本项目历史上已经因为「从第三方应用私有接口取数据」
         做过一次整改（见 `发布前合规自查清单.md`），不重复踩。

     兜底：没有脚本路径的条目一概不要（拿不到脚本 = 没法执行）。
     ------------------------------------------------------------ */
  var CAT_TOOL = 1;         // 通用工具
  var CAT_BACHELOR = 2;     // 本科 / 专科教务系统
  var CAT_POSTGRAD = 3;     // 研究生教务系统

  /** 唯一一张名单：上游的演示 / 测试脚本（见上） */
  var TOOL_DENY = { 'GENERAL_TOOL_01': 1, 'GENERAL_TOOL_02': 1 };

  /** 这条适配器要不要接入（纯函数，测试直接调）。`jsPath` 的检查在 decodeIndex 里统一做 */
  function acceptAdapter(adapter) {
    if (!adapter) return false;
    if (adapter.category === CAT_BACHELOR || adapter.category === CAT_POSTGRAD) return true;
    if (adapter.category !== CAT_TOOL) return false;
    if (TOOL_DENY[adapter.adapterId]) return false;
    return !adapter.importUrl;      // 空 = 让用户自己填教务网址的通用适配
  }

  /* ------------------------------------------------------------
     极简 protobuf 读取器（proto3 的一个子集）
     ------------------------------------------------------------
     只实现四种 wire type：
       0 varint / 2 长度前缀 / 1 定长 8 字节 / 5 定长 4 字节。
     group（3、4）在 proto3 里已废弃，遇到就报错 —— 报错比静默读歪好。
     ------------------------------------------------------------ */

  /** 读一个 varint。返回值可能超过 2^31，所以用乘法而不是 `<<`（JS 位运算是 32 位） */
  function readVarint(u8, p) {
    var r = 0, s = 0, b;
    for (;;) {
      if (p >= u8.length) throw new Error('索引数据不完整（varint 被截断）');
      b = u8[p++];
      r += (b & 0x7f) * Math.pow(2, s);
      if (!(b & 0x80)) return { value: r, next: p };
      s += 7;
      if (s > 63) throw new Error('索引里有非法的 varint');
    }
  }

  /**
   * 把 [from, to) 之间读成一串字段。
   * 每项是 `[字段号, wire, 值]`：wire 0 的值是数字，2 是 Uint8Array，1/5 是定长切片。
   */
  function readFields(u8, from, to) {
    var out = [], p = from;
    while (p < to) {
      var k = readVarint(u8, p);
      p = k.next;
      var field = Math.floor(k.value / 8);
      var wire = k.value % 8;
      if (wire === 0) {
        var v = readVarint(u8, p);
        p = v.next;
        out.push([field, wire, v.value]);
      } else if (wire === 2) {
        var n = readVarint(u8, p);
        p = n.next;
        var end = p + n.value;
        if (end > to) throw new Error('索引数据不完整（长度前缀越界）');
        out.push([field, wire, u8.subarray(p, end)]);
        p = end;
      } else if (wire === 5) {
        if (p + 4 > to) throw new Error('索引数据不完整（定长 4 字节越界）');
        out.push([field, wire, u8.subarray(p, p + 4)]);
        p += 4;
      } else if (wire === 1) {
        if (p + 8 > to) throw new Error('索引数据不完整（定长 8 字节越界）');
        out.push([field, wire, u8.subarray(p, p + 8)]);
        p += 8;
      } else {
        throw new Error('索引里有不认识的字段类型：' + wire);
      }
    }
    return out;
  }

  /** UTF-8 解码。有 TextDecoder 就用（快、且严格），没有就退回手写 */
  var _dec = null;
  function utf8(u8) {
    if (!u8 || !u8.length) return '';
    if (_dec === null) {
      try { _dec = new global.TextDecoder('utf-8'); } catch (e) { _dec = false; }
    }
    if (_dec) { try { return _dec.decode(u8); } catch (e) { /* 退回手写 */ } }
    var s = '', i = 0;
    while (i < u8.length) {
      var c = u8[i++];
      if (c < 0x80) { s += String.fromCharCode(c); }
      else if (c < 0xe0) { s += String.fromCharCode(((c & 0x1f) << 6) | (u8[i++] & 0x3f)); }
      else if (c < 0xf0) {
        s += String.fromCharCode(((c & 0x0f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f));
      } else {
        var cp = ((c & 0x07) << 18) | ((u8[i++] & 0x3f) << 12) |
                 ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f);
        cp -= 0x10000;
        s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return s;
  }

  /* ------------------------------------------------------------
     解码
     ------------------------------------------------------------ */

  function decodeAdapter(u8) {
    var a = {
      adapterId: '', name: '', category: 0, jsPath: '',
      importUrl: '', description: '', maintainer: ''
    };
    readFields(u8, 0, u8.length).forEach(function (f) {
      var v = f[2];
      if (f[0] === 1) a.adapterId = utf8(v);
      else if (f[0] === 2) a.name = utf8(v);
      else if (f[0] === 3) a.category = v;
      else if (f[0] === 4) a.jsPath = utf8(v);
      else if (f[0] === 5) a.importUrl = utf8(v);
      else if (f[0] === 6) a.description = utf8(v);
      else if (f[0] === 7) a.maintainer = utf8(v);
    });
    return a;
  }

  function decodeSchool(u8) {
    var s = { id: '', name: '', initial: '', folder: '', adapters: [] };
    readFields(u8, 0, u8.length).forEach(function (f) {
      if (f[0] === 1) s.id = utf8(f[2]);
      else if (f[0] === 2) s.name = utf8(f[2]);
      else if (f[0] === 3) s.initial = utf8(f[2]);
      else if (f[0] === 4) s.folder = utf8(f[2]);
      else if (f[0] === 5) s.adapters.push(decodeAdapter(f[2]));
    });
    return s;
  }

  /**
   * 解开整份索引。
   * 返回 `{ protocol, versionId, schools, accepted, dropped }` ——
   * `schools` 是**已经过接入策略过滤**的（只留下有适配器的学校），
   * `dropped` 是被挡掉的适配器条数，留着给测试和界面用
   * （「上游 264 个适配器，本版接入 N 个」这句话得说得出来）。
   */
  function decodeIndex(u8) {
    if (!u8 || !u8.length) throw new Error('索引内容是空的');
    var protocol = 0, versionId = '', raw = [];
    readFields(u8, 0, u8.length).forEach(function (f) {
      if (f[0] === 1) protocol = f[2];
      else if (f[0] === 2) versionId = utf8(f[2]);
      else if (f[0] === 3) raw.push(decodeSchool(f[2]));
    });

    var accepted = 0, dropped = 0;
    var schools = [];
    var droppedSchools = [];
    raw.forEach(function (s) {
      var keep = s.adapters.filter(function (a) {
        // 没有脚本路径的条目等于没法执行，一并挡掉（上游偶尔会留占位）
        if (!a.jsPath) { dropped++; return false; }
        if (acceptAdapter(a)) { accepted++; return true; }
        dropped++;
        return false;
      });
      // 一条适配器都不剩的学校不进列表 —— 免得用户点进去发现是空的。
      // 记下 id：上游 239 条、本版接入 236 条，差的这 3 条是哪 3 条
      // 应该一眼答得出，而不是每次重新推一遍。
      if (!keep.length) { droppedSchools.push(s.id); return; }
      s.adapters = keep;
      schools.push(s);
    });

    return {
      protocol: protocol, versionId: versionId,
      schools: schools, accepted: accepted, dropped: dropped,
      droppedSchools: droppedSchools, rawSchools: raw.length
    };
  }

  /* ------------------------------------------------------------
     本地注册的学校（v1.9.35）
     ------------------------------------------------------------
     内置本校不属于上游索引 —— 由 schools.js 的 localLibrary() 形状
     构造、app.js 启动时经 `setLocalSchools()` 注册进来。本模块**不含
     任何校名与域名**（这条口径不变），只负责把注册条目合并进查询。

     合并只发生在**查询层**（schools / search / schoolById /
     adapterById），不写进 localStorage 缓存：缓存永远只是上游索引，
     「在线拉下来的」与「本机注册的」两路数据语义保持纯粹。
     ------------------------------------------------------------ */
  var LOCAL = [];

  function isValidLocal(s) {
    return !!(s && typeof s.id === 'string' && s.id &&
      typeof s.name === 'string' && s.name &&
      Array.isArray(s.adapters) && s.adapters.length &&
      s.adapters.every(function (a) {
        return a && typeof a.adapterId === 'string' && a.adapterId;
      }));
  }

  /** 注册（整体替换，重复调用不叠加）。形状不合格的条目整条丢弃 */
  function setLocalSchools(list) {
    LOCAL = (Array.isArray(list) ? list : []).filter(isValidLocal);
  }

  function localSchools() { return LOCAL.slice(); }

  /** 上游缓存 + 本地注册（本地在前：同 id 时本校优先，防上游撞车） */
  function allSchools() {
    return LOCAL.concat(read().schools);
  }

  /* ------------------------------------------------------------
     缓存（本机 localStorage）
     ------------------------------------------------------------ */
  var cache = null;

  function read() {
    if (cache) return cache;
    var d = { versionId: '', cachedAt: 0, schools: [], srcId: '' };
    try {
      var raw = global.localStorage && global.localStorage.getItem(KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === 'object' && Array.isArray(p.schools)) {
          d.versionId = String(p.versionId || '');
          d.cachedAt = +p.cachedAt || 0;
          /* 这份数据是从哪条源拿到的（没记录过就是空串）—— 给界面显示用。
             只认源表里还在的 id：源表改名之后，旧缓存不该显示成一个怪名字 */
          d.srcId = sourceById(String(p.srcId || '')) ? String(p.srcId) : '';
          d.schools = p.schools.filter(function (s) {
            return s && typeof s.id === 'string' && s.id && Array.isArray(s.adapters);
          });
        }
      }
    } catch (e) { /* 隐私模式 / 坏 JSON：当作没缓存过 */ }
    cache = d;
    return d;
  }

  var _lastWriteOk = true;
  function lastWriteOk() { return _lastWriteOk; }

  function save(decoded, srcId) {
    cache = {
      versionId: decoded.versionId,
      cachedAt: Date.now(),
      schools: decoded.schools,
      srcId: sourceById(srcId) ? String(srcId) : ''
    };
    try {
      global.localStorage && global.localStorage.setItem(KEY, JSON.stringify(cache));
      _lastWriteOk = true;
    } catch (e) {
      /* 存不下不影响本次使用（内存里还能用），但要在界面上说实话 */
      _lastWriteOk = false;
    }
    return _lastWriteOk;
  }

  function reload() { cache = null; return read(); }

  function clearAll() {
    cache = { versionId: '', cachedAt: 0, schools: [], srcId: '' };
    try { global.localStorage && global.localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------
     取索引：原生桥优先，退到 fetch
     ------------------------------------------------------------
     页面是 file:// 打开的，跨域读网络在 WebView 里会被拦掉，
     而且本工程网页侧本来就**从不发网络请求**（一律走原生）。
     所以在 App 里走 `AndroidWarehouse.getBinary`；在电脑浏览器里
     直接打开网页时没有这个桥，才退回 fetch（上游 raw 域带 CORS 头）。
     ------------------------------------------------------------ */
  var waiting = {};
  var seq = 0;

  function hasNative() {
    var B = global.AndroidWarehouse;
    return !!(B && typeof B.getBinary === 'function');
  }

  /**
   * 原生桥的等待上限。**必须有** —— 桥是「一问一答」式的，
   * 原生侧万一没回调（线程池排满、网络库卡死、Activity 被回收），
   * 没有超时就是一个永不 settle 的 Promise：界面一直转圈、用户以为在下载。
   * 超时之后那条回调变成了「迟到的回调」，`_onBinary` 认不出 id，直接丢掉。
   *
   * 这个数必须**大于原生侧最坏耗时**（连接 5 秒 + 读 15 秒 = 20 秒），
   * 而且要留一点余量。反过来的话，每次慢下载都会先由网页侧报「超时」，
   * 原生那条「HTTP 404 / 连不上」的真实原因反而永远看不到 —— 用户拿到的
   * 是一句没有信息量的错，排查只能靠猜。
   */
  var BRIDGE_TIMEOUT_MS = 28000;

  function fetchBinary(url) {
    if (hasNative()) {
      return new Promise(function (resolve, reject) {
        var id = 'w' + (++seq) + '_' + Date.now();
        var timer = setTimeout(function () {
          if (!waiting[id]) return;
          delete waiting[id];
          reject(new Error('下载超时（' + Math.round(BRIDGE_TIMEOUT_MS / 1000) + ' 秒没有响应）'));
        }, BRIDGE_TIMEOUT_MS);
        waiting[id] = {
          resolve: function (v) { clearTimeout(timer); resolve(v); },
          reject: function (e) { clearTimeout(timer); reject(e); }
        };
        try {
          global.AndroidWarehouse.getBinary(url, id);
        } catch (e) {
          delete waiting[id];
          clearTimeout(timer);
          reject(new Error('下载被拒绝：' + (e && e.message ? e.message : e)));
        }
      });
    }
    if (typeof global.fetch === 'function') {
      return global.fetch(url, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) { return new Uint8Array(buf); });
    }
    return Promise.reject(new Error('这个环境没法联网更新适配库，请在手机 App 里操作'));
  }

  /**
   * 原生侧的回调出口（AndroidWarehouse 拿到字节后调这里）。
   * `payload` 形如 `ok:<base64>` 或 `err:<原因>` —— 与 `AndroidShare` /
   * `AndroidExport` 同一套约定，原生侧不用为了这个接口新造一种返回格式。
   */
  function _onBinary(id, payload) {
    var w = waiting[id];
    if (!w) return;                 // 迟到的回调（已经超时或已取消），丢掉
    delete waiting[id];
    var s = String(payload == null ? '' : payload);
    if (s.indexOf('ok:') !== 0) {
      w.reject(new Error(s.replace(/^err:/, '') || '下载失败'));
      return;
    }
    try {
      w.resolve(base64ToBytes(s.slice(3)));
    } catch (e) {
      w.reject(new Error('下载到的数据解不开：' + (e && e.message ? e.message : e)));
    }
  }

  /** base64 → Uint8Array（自己解，不依赖 atob 的具体可用性） */
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64ToBytes(s) {
    var clean = String(s).replace(/[^A-Za-z0-9+/]/g, '');
    var out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    var acc = 0, bits = 0, n = 0;
    for (var i = 0; i < clean.length; i++) {
      var v = B64.indexOf(clean.charAt(i));
      if (v < 0) continue;
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[n++] = (acc >> bits) & 0xff;
      }
    }
    return out.subarray(0, n);
  }

  /**
   * 拉索引 → 解码 → 落盘。返回解码结果（已过滤）。
   *
   * **v1.9.41：只剩联网这一条路**（内置快照已取消，理由见文件头 §一）。
   * 成功后仍然踢一次后台静默刷新 —— 前台是「成功即停」，可能停在一条
   * 滞后的镜像上，后台四源全问一遍负责把它补正。
   *
   * 逐个源试：**只要有一个源返回可用数据就成**。两类失败都要往下试 ——
   * 拉不到（超时 / 被挡）与拉到了但解不开（CDN 缓存陈旧、内容被截断）
   * 对用户是同一件事：「这个源不能用」。唯一**不**退源的错是协议版本不兼容：
   * 那说明上游升版了，换几个源都是同一份数据，直接报错让用户更新 App。
   */
  function update() {
    return online().then(function (idx) {
      _silentRefresh();
      return idx;
    });
  }

  /** 多源在线下载（v1.9.32 起的主路径，v1.9.41 起是**唯一**路径） */
  function online() {
    if (!hasNative() && typeof global.fetch !== 'function') {
      return Promise.reject(new Error('这个环境没法联网更新适配库，请在手机 App 里操作'));
    }
    var urls = INDEX_URLS.slice();

    function tryNext(lastErr) {
      if (!urls.length) {
        return Promise.reject(new Error('适配库下载失败：' +
          (lastErr && lastErr.message ? lastErr.message : '所有下载地址都不通') +
          '。请检查网络后重试。'));
      }
      var url = urls.shift();
      return fetchBinary(url).then(function (u8) {
        var idx = decodeIndex(u8);
        if (idx.protocol !== SUPPORTED_PROTOCOL) {
          throw new Error('适配库索引版本不兼容（上游 v' + idx.protocol +
            '，本版只认 v' + SUPPORTED_PROTOCOL + '）。请更新柚课后再试。');
        }
        /* 记下这条数据是哪条源给的 —— 界面要显示「来源：Gitee 镜像」，
           用户排查「为什么这台机更新不了」时这是第一句话 */
        var src = sourceOfUrl(url);
        save(idx, src ? src.id : '');
        return idx;
      }).catch(function (err) {
        /* ⚠️ 这里只能有**这一个**回退口。v1.9.33 之前写成
           `.then(ok, onErr)` 再串一个 `.catch`，两层都会调 tryNext ——
           每深一层源就把错误多包一层「适配库下载失败：…请检查网络后重试」，
           真机上用户看到的是同一句话重复三遍。 */
        if (/版本不兼容/.test(String(err && err.message))) throw err;
        return tryNext(err);
      });
    }
    return tryNext(null);
  }

  /**
   * 后台静默刷新：拿到一份清单之后再偷偷对一次上游。
   *
   * 前台是「成功即停」（可能停在一条同步滞后的镜像上），这里是补正它的那道
   * 保险 —— v1.9.41 拿掉内置快照之后，这条保险比之前更要紧：以前至少有
   * 「包内那份」当基准，现在一份清单好不好全靠网络那一下。
   *
   * **每个源都问一遍，谁报出新版本就用谁的** —— 这里**故意不**「成功即停」：
   * 源从两条扩到四条之后，第一条很可能只是同步滞后的镜像，提前退出会让用户
   * 永久停在旧索引上（症状是「我们学校搜不到」，界面还看不出少了东西）。
   * 前台那条路是另一套口径（用户等着，拿到能用的就走），见文件头。
   *
   * **所有错误都吞掉** —— 这是锦上添花的动作，失败不该在任何地方冒头；
   * 成功且版本确实更新了才落盘。
   */
  function _silentRefresh() {
    if (!hasNative() && typeof global.fetch !== 'function') return;
    INDEX_URLS.forEach(function (url) {
      fetchBinary(url).then(function (u8) {
        var idx = decodeIndex(u8);
        if (idx.protocol !== SUPPORTED_PROTOCOL) return;
        if (idx.versionId && idx.versionId === read().versionId) return; // 没更新
        var src = sourceOfUrl(url);
        save(idx, src ? src.id : '');
      }).catch(function () { /* 静默：失败不冒头 */ });
    });
  }

  /* ------------------------------------------------------------
     查询
     ------------------------------------------------------------ */

  function schools() { return allSchools(); }
  function versionId() { return read().versionId; }
  function cachedAt() { return read().cachedAt; }
  function loaded() { return read().schools.length > 0; }

  /**
   * 当前缓存是哪条源给的（没记录过 → 空串）。
   * 界面用它显示「来源：Gitee 镜像」—— 用户报「更新不了」时，
   * 「这次走的是哪条路」是第一句要问的话。
   */
  function lastSourceName() {
    var s = sourceById(read().srcId);
    return s ? s.name : '';
  }

  function schoolById(id) {
    var list = allSchools();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /** 按 adapterId 找，连同它所属的学校一起返回（脚本路径需要 folder）。
      本地注册的条目排在前面，先查它 */
  function adapterById(adapterId) {
    var list = allSchools();
    for (var i = 0; i < list.length; i++) {
      for (var j = 0; j < list[i].adapters.length; j++) {
        if (list[i].adapters[j].adapterId === adapterId) {
          return { school: list[i], adapter: list[i].adapters[j] };
        }
      }
    }
    return null;
  }

  /** 主机名（导入地址里的），给界面显示，也给「同源」判断用 */
  function hostOf(url) {
    var m = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#]+)/i.exec(String(url == null ? '' : url));
    return m ? m[1] : '';
  }

  /**
   * 关键词搜索。匹配：校名、首字母、适配器名、说明、维护者、导入地址主机。
   * 用户可能只记得「那个 jwgl 开头的」或者「福建那所」。
   */
  function search(keyword) {
    var kw = String(keyword == null ? '' : keyword).trim().toLowerCase();
    var list = allSchools();
    if (!kw) return list.slice();
    return list.filter(function (s) {
      var hay = [s.name, s.initial, s.id].join(' ');
      s.adapters.forEach(function (a) {
        hay += ' ' + a.name + ' ' + a.description + ' ' + a.maintainer + ' ' + hostOf(a.importUrl);
      });
      return hay.toLowerCase().indexOf(kw) >= 0;
    });
  }

  /**
   * 适配脚本的下载地址，**按顺序给**（与索引同样的多源回退）。
   * 只给一条是不够的：CDN 与回源要能互为备份，否则「索引拉下来了、
   * 脚本一只都拉不下来」——用户看到的是「有这所学校但点了没反应」。
   *
   * v1.9.42 起**所有条目一视同仁**：`folder` / `jsPath` 是什么就编什么地址。
   * 以前本校那一行 `folder` 是 `local`（自带正文、这里要返回空数组），
   * 那条分支连同 `localSourceOf()` 一起拆掉了 —— 自研脚本不再维护，
   * 本校那一行的 `folder` 现在写的是上游那只脚本的目录。
   */
  function scriptUrls(school, adapter) {
    if (!school || !adapter || !adapter.jsPath) return [];
    var folder = encodeURIComponent(school.folder || school.id);
    var file = encodeURIComponent(adapter.jsPath).replace(/%2F/gi, '/');
    return SCRIPT_BASES.map(function (base) { return base + folder + '/' + file; });
  }

  /** 兼容旧调用：主地址（排在最前面的那条） */
  function scriptUrl(school, adapter) {
    var all = scriptUrls(school, adapter);
    return all.length ? all[0] : '';
  }

  var api = {
    OWNER: OWNER,
    /** 分发源表（唯一事实源；原生侧 MainActivity 的前缀白名单与它逐条对齐） */
    SOURCES: SOURCES.slice(),
    INDEX_URL: INDEX_URL,
    INDEX_URLS: INDEX_URLS.slice(),
    SCRIPT_BASES: SCRIPT_BASES.slice(),
    RAW_BASE: RAW_BASE,
    BRIDGE_TIMEOUT_MS: BRIDGE_TIMEOUT_MS,
    KEY: KEY,
    PROTOCOL: SUPPORTED_PROTOCOL,
    CAT_TOOL: CAT_TOOL,
    CAT_BACHELOR: CAT_BACHELOR,
    CAT_POSTGRAD: CAT_POSTGRAD,
    TOOL_DENY: TOOL_DENY,

    // 纯函数（单测直接调）
    readVarint: readVarint,
    readFields: readFields,
    utf8: utf8,
    base64ToBytes: base64ToBytes,
    decodeIndex: decodeIndex,
    acceptAdapter: acceptAdapter,
    hostOf: hostOf,
    sourceOfUrl: sourceOfUrl,
    sourceById: sourceById,
    scriptUrl: scriptUrl,
    scriptUrls: scriptUrls,

    // 状态
    schools: schools,
    setLocalSchools: setLocalSchools,
    localSchools: localSchools,
    search: search,
    schoolById: schoolById,
    adapterById: adapterById,
    versionId: versionId,
    cachedAt: cachedAt,
    loaded: loaded,
    lastSourceName: lastSourceName,
    lastWriteOk: lastWriteOk,
    update: update,
    reload: reload,
    clearAll: clearAll,

    _onBinary: _onBinary,
    /** 仅供单测：把桥的等待上限调小，好在毫秒级验「超时会换源、会报错」 */
    _setBridgeTimeout: function (ms) { BRIDGE_TIMEOUT_MS = ms; }  };

  global.Warehouse = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  /* ------------------------------------------------------------
     原生侧的**唯一入口**。
     ------------------------------------------------------------
     `AndroidWarehouse.getBinary(url, id)` 是「原生 → 网页」的反向调用，
     原生侧只能通过 `evaluateJavascript` 回来 —— 所以这里必须留一个
     固定在全局的名字给它。名字只写这一处，原生侧引用同一个常量。
     载荷约定与 `AndroidShare` / `AndroidExport` 一致：
       `ok:<base64>` 下载成功 / `err:<原因>` 失败。
     ------------------------------------------------------------ */
  global.WarehouseHost = { onBinary: _onBinary };

})(typeof window !== 'undefined' ? window : globalThis);
