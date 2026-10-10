/**
 * 适配库（web/js/warehouse.js）单元测试。
 *
 * 覆盖三件事：
 *   ① protobuf 解码器：合成索引能原样解回来，坏数据要**明确报错**而不是读出空值；
 *   ② 接入策略：通用工具默认不收、例外表生效、被剥空的学校不进列表
 *      （这是「上游一加新工具，我们会不会默认全收」那条线）；
 *   ③ 缓存 / 更新：原生桥与 fetch 两条路、协议不兼容不许覆盖旧缓存。
 *
 * 运行： node tools/test-warehouse.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

/* 剥注释 —— 与 smoke-test.js 的同名函数、以及 verify-apk 里的 strip_comments
   逐字同口径。断言「某个名字不存在」之前必须剥注释：沿革注释里会原样提到
   已经拆掉的名字，不剥的话这类断言要么永远红、要么（注释被删后）永远绿。
   第二条正则要求 `//` 前面不是冒号，免得把 `https://` 砍了。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ---------- 最小环境桩（warehouse.js 用 localStorage 缓存） ---------- */
const memStore = {};
let storageThrows = false;
global.localStorage = {
  getItem: (k) => (memStore[k] === undefined ? null : memStore[k]),
  setItem: (k, v) => {
    if (storageThrows) throw new Error('QuotaExceededError');
    memStore[k] = String(v);
  },
  removeItem: (k) => { delete memStore[k]; }
};
global.window = global;

const W = require(path.join(root, 'web', 'js', 'warehouse.js'));
const F = require(path.join(root, 'tools', 'index-fixture.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { console.log('  ✔ ' + name); pass++; }
  else {
    console.log('  ✘ ' + name + (extra !== undefined ? '  -> ' + extra : ''));
    failures.push(name);
    fail++;
  }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* 「跑完了没有」的哨兵。
   Promise 链一旦断开（比如桩子只应答了第一个地址、后面没人应答），
   node 会在事件循环排空后**静默退出、退出码照样是 0** ——
   看起来全绿，其实后半截根本没跑。本项目踩过一次（smoke-test.js 里
   require 崩溃被读成全绿），所以这里钉死：没走到 summary() 就不算通过。 */
let finished = false;
process.on('exit', function () {
  if (finished) return;
  console.log('\n  ✘ 测试没有跑完就退出了（Promise 链断了，或事件循环提前排空）');
  console.log('    通过 ' + pass + ' 项后中断 —— 后面那些断言一项都没跑');
  process.exit(1);
});


/* ============================================================
   ① protobuf 解码器
   ============================================================ */
section('protobuf 解码器');

const idx = W.decodeIndex(F.buildSampleIndex());
check('协议版本解出来是 2', idx.protocol === 2, idx.protocol);
check('version_id 解对', idx.versionId === F.VERSION_ID, idx.versionId);

check('被剥空的学校不进列表（要么有适配器、要么整条不要）', idx.schools.length === 3,
  idx.schools.map(function (s) { return s.id; }).join(','));
check('接入的适配器条数对得上（2 本科/研究生 + 2 通用 + 1 研究生）', idx.accepted === 5, idx.accepted);
check('挡掉的适配器条数对得上（4 条不该收的通用工具 + 1 条空脚本）',
  idx.dropped === 5, idx.dropped);
check('被整条剥空的学校 id 记得下来（「上游 5 条、接入 3 条」要一眼答得出丢了谁）',
  idx.rawSchools === 5 && idx.droppedSchools.length === 2 &&
  idx.droppedSchools.indexOf('GLOBAL_TOOLS') >= 0 &&
  idx.droppedSchools.indexOf('EMPTYU') >= 0,
  JSON.stringify(idx.droppedSchools));

const testu = idx.schools.filter(function (s) { return s.id === 'TESTU'; })[0];
check('学校字段（id / 中文名 / 首字母 / 文件夹）都解对',
  !!testu && testu.name === '示例大学' && testu.initial === 'S' && testu.folder === 'TESTU',
  testu ? JSON.stringify([testu.id, testu.name, testu.initial, testu.folder]) : 'null');

check('适配器字段（id / 名 / 类别 / 脚本路径 / 导入地址 / 维护者）都解对',
  !!testu && testu.adapters[0].adapterId === 'TESTU_01' &&
  testu.adapters[0].category === 2 &&
  testu.adapters[0].jsPath === 'testu_01.js' &&
  testu.adapters[0].importUrl === 'https://jw.example.edu.cn/xtgl/login_slogin.html' &&
  testu.adapters[0].maintainer === '维护者甲',
  testu ? JSON.stringify(testu.adapters[0]) : 'null');

check('没有写的可选字段解成空串（不是 undefined、也不是 "undefined"）',
  !!testu && testu.adapters[1].description === '' &&
  typeof testu.adapters[1].description === 'string',
  testu ? JSON.stringify(testu.adapters[1].description) : 'null');

/* 坏数据必须明确报错 —— 宁可报错，也不要按旧字段瞎读出一堆空学校 */
let truncErr = '';
try { W.decodeIndex(F.buildTruncatedIndex()); } catch (e) { truncErr = String(e && e.message); }
check('被截断的索引要明确报错（不能静默读出一半就说成功）',
  /不完整|越界|截断/.test(truncErr), truncErr || '(没有报错)');

let emptyErr = '';
try { W.decodeIndex(new Uint8Array(0)); } catch (e) { emptyErr = String(e && e.message); }
check('空索引要报错', /空/.test(emptyErr), emptyErr || '(没有报错)');

let wireErr = '';
try {
  // 字段号 1、wire 类型 3（proto3 已废弃的 group）—— 必须拒绝
  W.decodeIndex(new Uint8Array([0x0b]));
} catch (e) { wireErr = String(e && e.message); }
check('遇到不认识的 wire 类型要报错（不是当没看见）',
  /不认识的字段类型/.test(wireErr), wireErr || '(没有报错)');

/* varint 跨字节：手工造一个 > 127 的长度前缀，确认没被 32 位位移搞坏 */
const big = new Uint8Array(300 + 8);
const bytes = F.varint(300);
for (let i = 0; i < bytes.length; i++) big[i] = bytes[i];
check('varint 能读跨字节的值（300 = 0xAC 0x02）',
  W.readVarint(big, 0).value === 300 && W.readVarint(big, 0).next === 2,
  JSON.stringify(W.readVarint(big, 0)));

/* ============================================================
   ② 接入策略
   ============================================================ */
section('接入策略（只接入教务适配器）');

/* 造条目时默认不带 import_url —— 那正是「通用教务适配」的形状 */
const CAT = function (c, id, url) {
  return { adapterId: id || 'x', category: c, jsPath: 'a.js', importUrl: url == null ? '' : url };
};
check('本/专科教务（category 2）接入', W.acceptAdapter(CAT(2)) === true);
check('研究生教务（category 3）接入', W.acceptAdapter(CAT(3)) === true);
check('通用工具里、让用户自己填教务网址的（import_url 为空）接入',
  W.acceptAdapter(CAT(1, 'zhengfang_01')) === true);
check('通用工具里带预设地址的（面向站外服务）**不**接入',
  W.acceptAdapter(CAT(1, 'SOME_TOOL', 'https://api.example.com/')) === false);
check('上游演示 / 测试脚本（点名表）不接入',
  W.acceptAdapter(CAT(1, 'GENERAL_TOOL_01')) === false &&
  W.acceptAdapter(CAT(1, 'GENERAL_TOOL_02')) === false);
check('类别未知（0）不接入', W.acceptAdapter(CAT(0)) === false);
check('类别越界（99）不接入', W.acceptAdapter(CAT(99)) === false);
check('传 null / undefined 不接入（不炸）',
  W.acceptAdapter(null) === false && W.acceptAdapter(undefined) === false);

/* ⚠️ 这一条是**反面**的：它断言「判据不是名单」。
   一开始这里写的是「通用工具里只有正方 + 超星两个 id 接入」，
   拿真索引一跑就发现上游还有青果和 URP —— 名单当场漏了两所，
   而漏的方式是**静默丢覆盖面**（界面看不出少东西）。
   所以判据改成结构性的：上游再添新的通用教务家族，应当自动进来。 */
check('上游新添一个通用教务家族（import_url 为空、id 从没见过）⇒ **自动接入**',
  W.acceptAdapter(CAT(1, 'brand_new_edu_family_01')) === true);

const ids = idx.schools.map(function (s) { return s.id; });
check('上游演示脚本那条不在结果里（否则会往用户课表里灌假课）',
  !idx.schools.some(function (s) {
    return s.adapters.some(function (a) { return a.adapterId === 'GENERAL_TOOL_01'; });
  }), ids.join(','));
check('上游占位脚本那条不在结果里',
  !idx.schools.some(function (s) {
    return s.adapters.some(function (a) { return a.adapterId === 'GENERAL_TOOL_02'; });
  }));
check('面向站外服务的那条不在结果里（判据自动挡，没在源码里点名）',
  !idx.schools.some(function (s) {
    return s.adapters.some(function (a) { return a.adapterId === 'TOOL_OFFSITE_03'; });
  }));
check('脚本路径为空的那条被挡掉（拿不到脚本 = 没法执行）',
  !idx.schools.some(function (s) {
    return s.adapters.some(function (a) { return a.adapterId === 'TOOL_NOSCRIPT_04'; });
  }));
check('剥空之后整所学校不进列表（用户不该点进去看到空列表）',
  ids.indexOf('GLOBAL_TOOLS') < 0 && ids.indexOf('EMPTYU') < 0, ids.join(','));
check('通用工具里的通用教务适配**在**结果里',
  idx.schools.some(function (s) {
    return s.adapters.some(function (a) { return a.adapterId === 'zhengfang_01'; });
  }));
check('新家族通用教务也在结果里（同上，证明判据不是名单）',
  idx.schools.some(function (s) {
    return s.adapters.some(function (a) { return a.adapterId === 'newfamily_01'; });
  }));

/* ============================================================
   ③ 查询
   ============================================================ */
section('查询');

/* 查询要走缓存，先把这一份存进去 */
memStore[W.KEY] = JSON.stringify({
  versionId: idx.versionId, cachedAt: 12345, schools: idx.schools
});
W.reload();

check('loaded() 在有缓存时为真', W.loaded() === true);
check('schoolById 按 id 找得到', (W.schoolById('TESTU') || {}).name === '示例大学');
check('schoolById 找不到时返回 null（不是 undefined）', W.schoolById('NOPE') === null);
const byAd = W.adapterById('TESTU_02');
check('adapterById 能把所属学校一起带出来（拼脚本地址要用文件夹）',
  !!byAd && byAd.school.id === 'TESTU' && byAd.adapter.name === '示例大学研究生系统',
  byAd ? byAd.school.id : 'null');
check('adapterById 找不到时返回 null', W.adapterById('NOPE_99') === null);

check('搜校名（中文子串）', W.search('示例').length === 2, W.search('示例').length);
check('搜首字母', W.search('Z').some(function (s) { return s.id === 'zhengfang_jiaowu'; }));
check('搜维护者（用户不一定记得校名，但记得是谁维护的）',
  W.search('维护者甲').length === 1, W.search('维护者甲').length);
check('搜导入地址里的主机名', W.search('jw.example.edu.cn').length === 1);
check('搜适配器名字', W.search('研究生教务').length === 1);
check('空关键词返回全部', W.search('').length === 3);
check('搜不到就是空数组（不是 null）', Array.isArray(W.search('不存在的东西')) &&
  W.search('不存在的东西').length === 0);

check('hostOf 取主机名', W.hostOf('https://jw.example.edu.cn/a/b?c=1') === 'jw.example.edu.cn',
  W.hostOf('https://jw.example.edu.cn/a/b?c=1'));
check('hostOf 对空值 / 非地址返回空串',
  W.hostOf('') === '' && W.hostOf(null) === '' && W.hostOf('随便一句话') === '');

const url1 = W.scriptUrl(byAd.school, byAd.adapter);
check('scriptUrl 拼出上游地址（文件夹 + 脚本名），并取主地址',
  url1 === W.SCRIPT_BASES[0] + 'TESTU/testu_02.js', url1);
check('scriptUrls **每条源给一个**地址（互为备份，否则「有学校但点了没反应」）',
  W.scriptUrls(byAd.school, byAd.adapter).length === W.SOURCES.length,
  W.scriptUrls(byAd.school, byAd.adapter).length);
check('scriptUrls 每条都指向同一个脚本文件',
  W.scriptUrls(byAd.school, byAd.adapter).every(function (u) {
    return /resources\/TESTU\/testu_02\.js$/.test(u);
  }), W.scriptUrls(byAd.school, byAd.adapter).join(' , '));
check('scriptUrls 的主机名**两两不同**（同主机等于没备份）',
  (function () {
    var us = W.scriptUrls(byAd.school, byAd.adapter);
    var hosts = us.map(W.hostOf);
    return hosts.length === W.SOURCES.length &&
      new Set(hosts).size === hosts.length;
  })(), W.scriptUrls(byAd.school, byAd.adapter).map(W.hostOf).join(' vs '));
check('scriptUrl 对缺参数的输入返回空串（不拼出半截地址）',
  W.scriptUrl(null, byAd.adapter) === '' && W.scriptUrl(byAd.school, null) === '');
check('scriptUrls 对缺参数的输入返回空数组',
  W.scriptUrls(null, byAd.adapter).length === 0 && W.scriptUrls(byAd.school, null).length === 0);

/* ============================================================
   ④ 分发源（v1.9.40）：四源、顺序、地址形状
   ============================================================
   上游作者自己维护了多份分发入口，国内网络下通不通差别很大。
   这节的断言全是**地址形状**与**顺序**，不是引用计数 —— 形状错了的症状是
   「点了更新没反应」，而它不会报错（v1.9.32 那次就是这么翻的车）。 */
section('分发源：四源、顺序、地址形状');

check('源表是数据驱动的（INDEX_URLS / SCRIPT_BASES 由它派生，不是各写一份）',
  W.SOURCES.length > 0 &&
  W.INDEX_URLS.length === W.SOURCES.length &&
  W.SCRIPT_BASES.length === W.SOURCES.length &&
  W.SOURCES.every(function (s, i) {
    return W.INDEX_URLS[i] === s.indexUrl && W.SCRIPT_BASES[i] === s.scriptBase;
  }),
  W.SOURCES.length + ' 条');
check('每条源的 id / 名字都齐（界面要显示「来源：X」，缺名字就只能显示个 id）',
  W.SOURCES.every(function (s) {
    return typeof s.id === 'string' && s.id && typeof s.name === 'string' && s.name;
  }));
check('id 不重复（重复了界面会显示错源）',
  new Set(W.SOURCES.map(function (s) { return s.id; })).size === W.SOURCES.length);

/* 顺序是**量出来的**，不是抄谁的配置：本机（国内网络）逐条 curl 的结果决定了前后。
   这条钉住「实测通过的排前面、本机连不通的兜底」这个口径 ——
   有人随手把没验证过的源提到第一位就会红，逼他先去量一遍。 */
check('顺序：实测通过的排前面（Gitee 第一）、本机连不通的 itdong 排最后',
  W.SOURCES[0].id === 'gitee' && W.SOURCES[W.SOURCES.length - 1].id === 'itdong',
  W.SOURCES.map(function (s) { return s.id; }).join(' > '));

check('每条源的索引与脚本**同主机**（一条源两边都要能用，否则等于没接）',
  W.SOURCES.every(function (s) {
    return W.hostOf(s.indexUrl) === W.hostOf(s.scriptBase);
  }), W.SOURCES.map(function (s) {
    return s.id + ':' + W.hostOf(s.indexUrl) + '/' + W.hostOf(s.scriptBase);
  }).join(' | '));
check('四源主机两两不同（同主机 = 一个地方挂了就一起挂）',
  new Set(W.SOURCES.map(function (s) { return W.hostOf(s.indexUrl); })).size ===
  W.SOURCES.length);
check('四源都走 https', W.SOURCES.every(function (s) {
  return /^https:\/\//.test(s.indexUrl) && /^https:\/\//.test(s.scriptBase);
}));

/* 上游仓库结构：索引在孤立分支、脚本在 main/resources。四条源都得照这个来 ——
   错一条就是那条源永远 404，而表现会被当成「网络不通」，最难查。
   注意 jsDelivr 用 `@分支` 记法（`…@main/resources/`），别把 `@` 漏掉。 */
check('索引都在 index-pb-release 分支、脚本都在 main/resources 下',
  W.SOURCES.every(function (s) {
    return /index-pb-release\/school_index\.pb$/.test(s.indexUrl) &&
      /[@\/]main\/resources\/$/.test(s.scriptBase);
  }), W.SOURCES.map(function (s) { return s.indexUrl; }).join(' | '));

check('Gitee 源是上游作者自己的 CN 镜像站（不是第三方代理 —— 口径从 v1.9.32 起没变）',
  /^https:\/\/gitee\.com\/XingHeYuZhuan-gh\/shiguang_warehouse\//.test(W.SOURCES[0].indexUrl),
  W.SOURCES[0].indexUrl);
check('itdong 源是 Gogs 的 /raw/<分支>/<路径>（对着上游网页的 Raw 链接核过）',
  (W.sourceById('itdong') || {}).indexUrl ===
  'https://git.itdong.me/XingHeYuZhuan/shiguang_warehouse/raw/index-pb-release/school_index.pb',
  (W.sourceById('itdong') || {}).indexUrl);

check('sourceOfUrl 认得出每条源的索引地址与脚本地址',
  W.SOURCES.every(function (s) {
    return (W.sourceOfUrl(s.indexUrl) || {}).id === s.id &&
      (W.sourceOfUrl(s.scriptBase + 'TESTU/a.js') || {}).id === s.id;
  }));
check('sourceOfUrl 认不出的地址返回 null（不许瞎认成第一条源）',
  W.sourceOfUrl('https://evil.example.com/school_index.pb') === null &&
  W.sourceOfUrl('') === null && W.sourceOfUrl(null) === null);
check('sourceById 按 id 找得到、认不出返回 null',
  (W.sourceById('gitee') || {}).id === 'gitee' &&
  W.sourceById('nope') === null && W.sourceById('') === null);

/* ============================================================
   ⑤ 底层工具
   ============================================================ */
section('utf8 / base64');

check('utf8 解中文', W.utf8(new TextEncoder().encode('示例大学教务系统')) === '示例大学教务系统');
check('utf8 解 ASCII 与 emoji（4 字节）',
  W.utf8(new TextEncoder().encode('A课🙂')) === 'A课🙂');
check('utf8 对空输入返回空串', W.utf8(null) === '' && W.utf8(new Uint8Array(0)) === '');

const b64 = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff, 0x41]).toString('base64');
const back = W.base64ToBytes(b64);
check('base64 还原字节（含 0x00 / 0xff 边界）',
  back.length === 6 && back[0] === 0x00 && back[1] === 0x01 && back[2] === 0x7f &&
  back[3] === 0x80 && back[4] === 0xff && back[5] === 0x41,
  Array.from(back).join(','));
check('base64 忽略换行与非法字符（base64 常见带换行）',
  W.base64ToBytes(b64.slice(0, 4) + '\n' + b64.slice(4)).length === 6);
check('空 base64 还原成空数组', W.base64ToBytes('').length === 0);

/* ============================================================
   ⑥ 缓存与更新
   ============================================================ */
section('缓存与更新');

W.clearAll();
check('清空之后 loaded() 为假', W.loaded() === false && W.schools().length === 0);
check('清空之后 versionId 为空', W.versionId() === '');
check('清空之后来源也清掉（否则界面会挂着一个早已不存在的来源名）',
  W.lastSourceName() === '', W.lastSourceName() || '(空)');

/* 原生侧只能靠一个固定全局名回调回来（名字写错就是「下载完了一直转圈」） */
check('留了给原生回调的固定出口 WarehouseHost.onBinary',
  typeof global.WarehouseHost === 'object' && typeof global.WarehouseHost.onBinary === 'function');
check('WarehouseHost.onBinary 就是 _onBinary 本身（不是各写一份）',
  global.WarehouseHost.onBinary === W._onBinary);

/* --- 走原生桥 --- */
/* 原生桥桩：**每一个问过来的地址都要应答**。
   多源回退之后，一次 update() 可能连问好几个源；桩子只答第一个，
   整条链子就悬在那儿 —— 正是上面那条哨兵要防的静默假绿。
   responder(url, index) 返回 `ok:<base64>` / `err:<原因>` / null（不应答）。 */
function nativeStub(responder) {
  const seen = { urls: [], ids: [] };
  global.AndroidWarehouse = {
    getBinary: function (url, id) {
      seen.urls.push(url);
      seen.ids.push(id);
      const payload = responder(url, seen.urls.length - 1);
      if (payload != null) W._onBinary(id, payload);
    }
  };
  return seen;
}

/* 桥的等待上限调小：既让「超时会换源」可测，也顺手验「成功路径要 clearTimeout」
   （漏清定时器的话，整个测试会被吊着不退出） */
W._setBridgeTimeout(60);

const OK = 'ok:' + Buffer.from(F.buildSampleIndex()).toString('base64');
const seen1 = nativeStub(function () { return OK; });
const updatePromise = W.update();
check('原生桥被调到，且第一个问的是索引主地址', seen1.urls[0] === W.INDEX_URLS[0], seen1.urls[0]);
check('原生桥拿到一个回调 id', typeof seen1.ids[0] === 'string' && seen1.ids[0].length > 0, seen1.ids[0]);

updatePromise.then(function (res) {
  check('走原生桥能拿到并解开索引', res.protocol === 2 && res.schools.length === 3,
    res.schools.length);
  check('更新后 loaded() 为真', W.loaded() === true);
  check('version_id 落进了缓存', W.versionId() === F.VERSION_ID, W.versionId());
  check('cachedAt 是一个时间戳', W.cachedAt() > 0);
  /* 走了四条源里的第一条（桩子对每个地址都应答 OK）—— 界面显示「来源：X」靠它 */
  check('记下了这份数据是哪条源给的（界面显示「来源」用）',
    W.lastSourceName() === W.SOURCES[0].name, W.lastSourceName() || '(空)');

  /* 真落盘了没有？换一个新的模块实例（清掉内存缓存）再读一遍 */
  delete require.cache[require.resolve(path.join(root, 'web', 'js', 'warehouse.js'))];
  const W2 = require(path.join(root, 'web', 'js', 'warehouse.js'));
  check('重新载入模块后仍读得到（确认真的写进了 localStorage，不是只在内存里）',
    W2.loaded() === true && W2.versionId() === F.VERSION_ID, W2.versionId());

  return runNoBundled();
}).catch(function (e) {
  check('更新流程不该抛异常', false, e && e.message);
  summary();
});

/* ============================================================
   内置快照已经取消（v1.9.41）：只剩联网这一条路
   ------------------------------------------------------------
   v1.9.33~v1.9.40 这一节测的是「先内置、后联网」。v1.9.41 把内置快照整个
   拿掉了（理由见 web/js/warehouse.js 文件头 §一），于是这里换成**反向断言**：
   那几个 API 必须不存在、update() 必须直接联网。

   反向断言最容易「永远绿」（它断言的东西本来就不存在，怎么写都过），
   所以这一组每一条都退回 v1.9.40 的源码验过红 —— 见当日日志。
   ============================================================ */

function runNoBundled() {
  section('内置快照已取消（v1.9.41）：包内不再有清单，update() 直接联网');

  check('内置快照那条路的 API 一个都不剩（isBundled / canLoadBundled / scriptPath / BUNDLED_TIMEOUT_MS）',
    typeof W.isBundled === 'undefined' && typeof W.canLoadBundled === 'undefined' &&
    typeof W.scriptPath === 'undefined' && typeof W.BUNDLED_TIMEOUT_MS === 'undefined',
    [typeof W.isBundled, typeof W.canLoadBundled, typeof W.scriptPath,
      typeof W.BUNDLED_TIMEOUT_MS].join(','));

  W.clearAll();
  const seenN = nativeStub(function () { return OK; });
  return W.update().then(function (res) {
    check('update() 只能走网络（没有任何本地兜底了）',
      res.protocol === 2 && res.schools.length === 3 && seenN.urls.length >= 1,
      seenN.urls.length + ' 次请求');
    check('拿到的就是入库数据（loaded 为真、查得到）',
      W.loaded() === true && W.schools().length === 3);
    check('来源照常记下来（界面显示「来源 Gitee 镜像」用）',
      W.lastSourceName() === W.SOURCES[0].name, W.lastSourceName() || '(空)');
    return runSilentRefresh();
  }, function (e) {
    check('联网这条唯一的路不该失败（桩子对每条源都应答 OK）', false, e && e.message);
    return runSilentRefresh();
  });
}

function runSilentRefresh() {
  section('静默刷新：拿到清单后再对一次上游，谁新用谁');

  /* 第一趟（update → 第一条源）给「本版」，之后四条静默查询里第一条报出
     「新版」的就落盘 —— 这条钉的是「刷到新版要真的换掉缓存」。 */
  const NEW_OK = 'ok:' + Buffer.from(F.buildUpdatedIndex()).toString('base64');
  const seenS = nativeStub(function (url, i) { return i === 0 ? OK : NEW_OK; });
  const p = W.update();
  return new Promise(function (done) { setTimeout(done, 80); }).then(function () {
    return p;
  }).then(function () {
    check('静默刷新刷到新版本后缓存真的换成了新版',
      W.versionId() === F.VERSION_ID_UPDATED, W.versionId());
    check('刷新后数据仍然可用', W.loaded() === true && W.schools().length === 3);
    /* **故意不提前退出**：镜像同步有小时级滞后，只认第一条源会让用户永久停在
       某个镜像的旧索引上（症状是「我们学校搜不到」，界面看不出少了东西）。
       前台那条路相反 —— 用户等着，成功即停。两条口径的差别值得钉住。 */
    check('静默刷新把**四条源都问一遍**（只看第一条会被滞后的镜像永久骗住）',
      seenS.urls.length === 1 + W.INDEX_URLS.length, seenS.urls.length + ' 条');
    /* 四条源在静默刷新里**都**会问到，而且第一个报出新版本的先落盘 ——
       后面几条比对后发现自己版本相同就不再覆盖。所以来源记的是**第一个**
       报出更新的源，不是「最后一个应答的」：顺序不定的话界面会挂一个随机的源名。 */
    check('静默刷新记下的来源是「第一个报出新版本的源」（不是最后一个应答的）',
      W.lastSourceName() === W.SOURCES[0].name, W.lastSourceName() || '(空)');
    return runNoLocalScript();
  });
}

function runNoLocalScript() {
  section('随包脚本整条拆掉（v1.9.42）：仓库层只剩「拿地址」，正文一律运行时下载');

  /* 用户拍板：本校那一行改指库里那只「正方教务-通用教务」，脚本不再随包。
     于是 v1.9.41 的 localSourceOf / isLocalScript 那一整套（判据是
     folder === 'local'）连同它的取用口一起退场。

     ⚠️ 这一组大半是**反向断言**（断言某个东西不存在），最容易「永远绿」——
        它断言的东西本来就不在，怎么写都过。所以每一条都退回 v1.9.41 的
        warehouse.js 验过红（旧文件从 dist/柚课-v1.9.41.apk 里取回原位跑的）；
        验红时**真的红**的才有价值，红了 2 条、另外 3 条被判为无效写法
        （见下面「为什么这么写」的注释）后改成了文件 / 源码级判据。 */
  check('本地脚本的取用面一个都不剩（localSourceOf / isLocalScript）',
    typeof W.localSourceOf === 'undefined' && typeof W.isLocalScript === 'undefined',
    [typeof W.localSourceOf, typeof W.isLocalScript].join(','));
  check('导出面里也没有它俩（api 表逐项过）',
    !Object.prototype.hasOwnProperty.call(W, 'localSourceOf') &&
    !Object.prototype.hasOwnProperty.call(W, 'isLocalScript'));

  /* ⚠️ 为什么不用 `typeof global.LocalAdapters === 'undefined'`：
     那个断言在本测试里**永远绿** —— 表是 adapter-local.js 在加载时挂上去的，
     而这个文件已经不存在、测试也不再 require 它，所以它「不存在」跟被测代码
     一点关系都没有。要抓「随包正文的存放处没了」，判据必须落在**文件**上。 */
  check('随包脚本正文那个文件真的不在仓里（web/js/adapter-local.js）',
    !fs.existsSync(path.join(root, 'web', 'js', 'adapter-local.js')));

  /* 同一条纪律落到源码层：旧版 warehouse.js 里 `folder === 'local'` 那条分支
     是「本地条目提前 return []」的判据；它若被重新加回来，本校那一行会变成
     「点了没反应」（urls 为空、原生直接 return），而且不报错。
     ⚠️ 先剥注释 —— 文件头那段沿革注释里还写着 localSourceOf()。 */
  const whSrc = stripComments(
    fs.readFileSync(path.join(root, 'web', 'js', 'warehouse.js'), 'utf8'));
  const leftovers = ['localSourceOf', 'isLocalScript', 'LocalAdapters', "'local'", '"local"']
    .filter(function (t) { return whSrc.indexOf(t) >= 0; });
  check('剥注释后的 warehouse.js 里没有本地脚本的影子（函数 / 判据 / 字面量）',
    leftovers.length === 0, leftovers.join(' , ') || '干净');

  /* 保留一条真跑一遍的：不管 folder 写什么，都得照常给出四条下载地址。
     （单看这一条在旧版也会绿 —— 旧版那条提前返回还要 LocalAdapters 表命中，
      表没加载时它也照给地址。所以它不是验红判据，只是**行为**的正面确认。） */
  const anySchool = { folder: 'zhengfang_jiaowu', name: '测试学校' };
  const anyAdapter = { jsPath: 'zhengfang_01.js', name: '正方教务html通用获取' };
  check('scriptUrls 对上游坐标照给四条地址（本校那一行与社区学校走同一条路）',
    W.scriptUrls(anySchool, anyAdapter).length === W.SOURCES.length,
    W.scriptUrls(anySchool, anyAdapter).length + ' 条');

  return runRest();
}

function runRest() {
  section('多源回退（raw 在国内时通时不通）');

  /* 第一个源挂了、第二个源能出数据 —— 必须成功 */
  const seenMulti = nativeStub(function (url, i) {
    return i === 0 ? 'err:连接被重置' : OK;
  });
  return W.update().then(function (res) {
    /* ⚠️ update() 成功之后还会踢一轮静默刷新（四条源各问一次），所以这里
       **不能拿「总请求数」当判据** —— 断的是「前两个问的是谁」。 */
    check('第一个源失败时自动换下一个源',
      seenMulti.urls[0] === W.INDEX_URLS[0] && seenMulti.urls[1] === W.INDEX_URLS[1],
      seenMulti.urls.join(' , '));
    check('后一个源不是同一个地址（否则等于没换源）',
      seenMulti.urls[1] !== seenMulti.urls[0], seenMulti.urls[1]);
    check('换源之后仍然拿到了索引', res.schools.length === 3, res.schools.length);
    return runRest2();
  }, function (e) {
    check('换源之后不该失败', false, e && e.message);
    return runRest2();
  });
}

function runRest2() {
  section('协议不兼容是终点，不换源');

  const seenProto = nativeStub(function () {
    return 'ok:' + Buffer.from(F.buildFutureIndex()).toString('base64');
  });
  return W.update().then(function () { return null; }, function (e) { return e; })
    .then(function (e) {
      const msg = String(e && e.message);
      check('上游协议升版时明确报错（并按旧字段硬读）',
        /版本不兼容/.test(msg), msg || '(没有报错)');
      check('协议不兼容时**不许**覆盖掉原有的缓存',
        W.versionId() === F.VERSION_ID && W.schools().length === 3, W.versionId());
      check('协议不兼容是终点：只问了一个源（换源也是同一份数据，白等一轮）',
        seenProto.urls.length === 1, seenProto.urls.length);

      section('网络错误 / 超时：要试遍每个源，再报可读的错');

      const seenAll = nativeStub(function () { return 'err:网络不给力'; });
      return W.update().then(function () { return null; }, function (e2) { return e2; })
        .then(function (e2) {
          const m = String(e2 && e2.message);
          check('原生侧回 err: 时给出可读的原因', /网络不给力/.test(m), m);
          check('一个源失败不算数，所有源都试过才报错',
            seenAll.urls.length === W.INDEX_URLS.length, seenAll.urls.length);
          /* v1.9.33 真机截图实录：报错被包装逻辑逐层套壳，同一句话出现三遍。
             包装只许发生一次 —— 出错信息是给用户看的，不是给日志拼接玩的。 */
          check('报错只包一层（嵌套包装会把同一句话叠三遍）',
            (m.match(/适配库下载失败：/g) || []).length === 1 &&
            (m.match(/请检查网络后重试/g) || []).length === 1, m);
          check('失败之后缓存还是好的（不能因为一次失败把用户的库清空）',
            W.loaded() === true);

          /* 超时：桩子一个都不应答 */
          const seenHang = nativeStub(function () { return null; });
          return W.update().then(function () { return null; }, function (e3) { return e3; })
            .then(function (e3) {
              const m3 = String(e3 && e3.message);
              check('原生侧不回调时会超时报错（否则界面一直转圈，用户以为在下载）',
                /超时/.test(m3), m3);
              check('超时也照样换源（不是卡在第一个源上）',
                seenHang.urls.length === W.INDEX_URLS.length, seenHang.urls.length);

              /* 迟到的 / 不认识的回调 id：不能炸 */
              let threw = '';
              try { W._onBinary('w999_nobody', 'ok:AAAA'); } catch (e4) {
                threw = String(e4 && e4.message);
              }
              check('不认识的回调 id 直接丢掉，不抛异常（超时后迟到的回调走这条）',
                threw === '', threw);

              section('写盘失败：内存里能用，但要老实说没存住');

              storageThrows = true;
              nativeStub(function () { return OK; });
              return W.update().then(function () {
                storageThrows = false;
                check('写盘失败时 lastWriteOk() 为假（不能让用户以为存好了）',
                  W.lastWriteOk() === false);
                check('但内存里仍然可用（本次不影响使用）',
                  W.schools().length === 3, W.schools().length);
                return runFetch();
              });
            });
        });
    });
}

/* 电脑浏览器里没有原生桥（网页是 file:// 打开的），这条路要能自己走通 */
function runFetch() {
  section('没有原生桥时退回 fetch');

  delete global.AndroidWarehouse;
  const realFetch = global.fetch;
  const touched = [];
  global.fetch = function (url) {
    touched.push(url);
    /* 第一个源返回 404，第二个源给真数据 —— fetch 这条也要能换源 */
    if (touched.length === 1) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({
      ok: true,
      arrayBuffer: function () {
        const b = F.buildSampleIndex();
        return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      }
    });
  };
  return W.update().then(function (res) {
    global.fetch = realFetch;
    check('没有原生桥时走 fetch', touched[0] === W.INDEX_URLS[0], touched[0]);
    /* 同 runRest：成功之后还有一轮静默刷新，所以只断「头两个问的是谁」 */
    check('fetch 一路 HTTP 不通时也会换源',
      touched[0] === W.INDEX_URLS[0] && touched[1] === W.INDEX_URLS[1],
      touched.join(' , '));
    check('fetch 一路也能解开索引', res.schools.length === 3, res.schools.length);
    summary();
  }, function (e) {
    global.fetch = realFetch;
    check('fetch 一路不该失败', false, e && e.message);
    summary();
  });
}

function summary() {
  finished = true;
  console.log('\n============================================');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) {
    console.log('  失败项：' + failures.join('、'));
    process.exit(1);
  }
  console.log('  适配库全部通过 ✔');
}
