/**
 * index-fixture.js —— 造一份**合成**的适配库索引（school_index.pb）
 * ============================================================
 * 用途：给 tools/test-warehouse.js 当输入，让 protobuf 解码器与接入策略
 * 有一套**确定的、可复跑的**数据可咬。
 *
 * 为什么在内存里造、而不是往 tools/fixtures/ 放一份二进制：
 *   · 夹具一旦落成文件就会有「文件没生成 → 测试整段跳过」的形态
 *     （tools/test-eduhtml.js 的最后一段就是这样），而这一层是**纯算术**，
 *     没有任何外部依赖需要占位，没必要给自己留一个能静默跳过的门。
 *   · 这份数据里**必须**出现校名与教务域名（否则测不出「按名字搜」
 *     和「脚本 URL 怎么拼」），所以它写死的是 `示例大学` / `example.edu.cn`
 *     这类**占位值**。工程里那条「仓库中不许出现任何一所真实学校的
 *     教务地址」的形状断言（smoke-test.js）会把真实域名判红，
 *     占位域名则被它显式放行 —— 这正是它该有的效果。
 *
 * 编码器是照着上游 `proto/school_index.proto` 手写的，
 * 与 web/js/warehouse.js 的解码器互为逆运算；两边一起读，
 * 这个协议的形状就完全清楚了（上游升版时先看这里）。
 *
 * 运行： node tools/index-fixture.js          只校验自己 encode→decode 一圈
 *        （测试请直接 require 本模块取 buildSampleIndex）
 */
'use strict';

/* ------------------------------------------------------------
   proto3 编码（本协议用到的子集）
   ------------------------------------------------------------ */

function utf8Bytes(s) {
  return new TextEncoder().encode(String(s));
}

function varint(n) {
  const out = [];
  let v = Number(n);
  if (v < 0) throw new Error('本协议里没有负数：' + n);
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}

function tag(field, wire) { return varint(field * 8 + wire); }

/** 长度前缀字段（wire 2） */
function lenDelim(field, bytes) {
  const b = Array.isArray(bytes) ? bytes : Array.from(bytes);
  return tag(field, 2).concat(varint(b.length), b);
}

/** varint 字段（wire 0） */
function vint(field, n) { return tag(field, 0).concat(varint(n)); }

function str(field, s) { return lenDelim(field, utf8Bytes(s)); }

/* ------------------------------------------------------------
   夹具数据
   ------------------------------------------------------------
   每一条都是为「咬住某一条规则」而存在的，别随手改：
     GLOBAL_TOOLS  —— 通用工具类里三种**都不该收**的：
                      ① 上游演示脚本（点名表里）
                      ② 上游占位脚本（点名表里）
                      ③ 面向站外服务的工具（import_url 非空 ⇒ 判据自动挡）
                      ④ 还没有脚本的（jsPath 为空）
                      ⇒ 四条全挡，整所学校也不该进列表
     正方通用       —— 通用工具类，但 import_url 为空（= 让用户自己填教务网址）
                      ⇒ **应该收**；这里还多挂一条「上游新添的通用教务家族」，
                      用来证伪「把判据写成 id 名单」这种做法
     示例大学       —— 正常本科教务（两条：本科 + 研究生）⇒ 应该全收
     示例理工学院    —— 只有一条「脚本路径为空」的适配器 ⇒ **整所学校都不该进列表**
     示例研究生院    —— 研究生教务（category 3）⇒ 应该收
   ------------------------------------------------------------ */
const VERSION_ID = 'TIME_20260101000000_001';

const SAMPLE = [
  {
    id: 'GLOBAL_TOOLS', name: '通用工具与服务', initial: 'T', folder: 'GLOBAL_TOOLS',
    adapters: [
      {
        adapterId: 'GENERAL_TOOL_01', name: '组件演示', category: 1,
        jsPath: 'demo.js', importUrl: '',
        description: '演示用：会往课表里灌一批假课程', maintainer: '维护者甲'
      },
      {
        adapterId: 'GENERAL_TOOL_02', name: '占位脚本', category: 1,
        jsPath: 'test.js', importUrl: '',
        description: '上游并不存在这个文件', maintainer: '维护者甲'
      },
      {
        adapterId: 'TOOL_OFFSITE_03', name: '站外服务导入', category: 1,
        jsPath: 'offsite.js', importUrl: 'https://api.example.com/',
        description: '从站外服务取数据', maintainer: '维护者甲'
      },
      {
        adapterId: 'TOOL_NOSCRIPT_04', name: '还没有脚本', category: 1,
        jsPath: '', importUrl: '',
        description: '', maintainer: '维护者甲'
      }
    ]
  },
  {
    id: 'zhengfang_jiaowu', name: '正方教务-通用教务', initial: 'Z', folder: 'zhengfang_jiaowu',
    adapters: [
      {
        adapterId: 'zhengfang_01', name: '正方教务通用获取', category: 1,
        jsPath: 'zhengfang_01.js', importUrl: '',
        description: '输入教务网址，登录后切换到个人课表页执行导入',
        maintainer: '维护者乙'
      },
      /* 上游之后新添的通用教务家族。判据若是 id 名单，这条就会**静默丢失** ——
         夹具里留着它，是为了让「名单化」这个错法在测试里被抓住。 */
      {
        adapterId: 'newfamily_01', name: '新家族教务通用获取', category: 1,
        jsPath: 'newfamily_01.js', importUrl: '',
        description: '输入教务网址，登录后执行导入', maintainer: '维护者丙'
      }
    ]
  },
  {
    id: 'TESTU', name: '示例大学', initial: 'S', folder: 'TESTU',
    adapters: [
      {
        adapterId: 'TESTU_01', name: '示例大学教务系统', category: 2,
        jsPath: 'testu_01.js',
        importUrl: 'https://jw.example.edu.cn/xtgl/login_slogin.html',
        description: '适用于示例大学', maintainer: '维护者甲'
      },
      {
        adapterId: 'TESTU_02', name: '示例大学研究生系统', category: 3,
        jsPath: 'testu_02.js',
        importUrl: 'https://yjs.example.edu.cn/login',
        maintainer: '维护者丁'
      }
    ]
  },
  {
    id: 'EMPTYU', name: '示例理工学院', initial: 'S', folder: 'EMPTYU',
    adapters: [
      {
        adapterId: 'EMPTYU_01', name: '还没有脚本', category: 2,
        jsPath: '', importUrl: 'https://jw.example.org/',
        description: '', maintainer: '维护者甲'
      }
    ]
  },
  {
    id: 'GRADU', name: '示例研究生院', initial: 'Y', folder: 'GRADU',
    adapters: [
      {
        adapterId: 'GRADU_01', name: '研究生教务', category: 3,
        jsPath: 'gradu_01.js', importUrl: 'https://yjs.example.net/',
        maintainer: '维护者戊'
      }
    ]
  }
];

/* ------------------------------------------------------------
   编码
   ------------------------------------------------------------ */

function encodeAdapter(a) {
  let out = [];
  out = out.concat(str(1, a.adapterId));
  out = out.concat(str(2, a.name));
  out = out.concat(vint(3, a.category));
  out = out.concat(str(4, a.jsPath));
  // import_url 是 optional：只有给了才写，用来覆盖「字段不在」的读法
  if (a.importUrl != null) out = out.concat(str(5, a.importUrl));
  if (a.description) out = out.concat(str(6, a.description));
  if (a.maintainer) out = out.concat(str(7, a.maintainer));
  return out;
}

function encodeSchool(s) {
  let out = [];
  out = out.concat(str(1, s.id));
  out = out.concat(str(2, s.name));
  out = out.concat(str(3, s.initial));
  out = out.concat(str(4, s.folder));
  s.adapters.forEach(function (a) {
    out = out.concat(lenDelim(5, encodeAdapter(a)));
  });
  return out;
}

/** 造一份完整索引。返回 Uint8Array */
function buildSampleIndex() {
  let out = [];
  out = out.concat(vint(1, 2));            // protocol_version
  out = out.concat(str(2, VERSION_ID));    // version_id
  SAMPLE.forEach(function (s) {
    out = out.concat(lenDelim(3, encodeSchool(s)));
  });
  return new Uint8Array(out);
}

/** 造一份「协议版本不兼容」的索引，用来验「宁可报错不要瞎读」 */
function buildFutureIndex() {
  let out = [];
  out = out.concat(vint(1, 99));
  out = out.concat(str(2, 'TIME_FUTURE'));
  out = out.concat(lenDelim(3, encodeSchool(SAMPLE[2])));
  return new Uint8Array(out);
}

/** 更新后的版本号（同协议），给「内置快照 + 静默刷新要落盘」当输入 */
const VERSION_ID_UPDATED = 'TIME_20260202000000_002';

/** 造一份「协议不变、版本更新」的索引，用来验静默刷新会真的覆盖缓存 */
function buildUpdatedIndex() {
  let out = [];
  out = out.concat(vint(1, 2));                        // protocol_version 不变
  out = out.concat(str(2, VERSION_ID_UPDATED));        // 版本往前走了
  SAMPLE.forEach(function (s) {
    out = out.concat(lenDelim(3, encodeSchool(s)));
  });
  return new Uint8Array(out);
}

/** 造一份被截断的索引，用来验解码器会明确报错而不是读出一堆空值 */
function buildTruncatedIndex() {
  const full = buildSampleIndex();
  return full.subarray(0, Math.floor(full.length * 0.6));
}

module.exports = {
  VERSION_ID: VERSION_ID,
  VERSION_ID_UPDATED: VERSION_ID_UPDATED,
  SAMPLE: SAMPLE,
  buildSampleIndex: buildSampleIndex,
  buildFutureIndex: buildFutureIndex,
  buildUpdatedIndex: buildUpdatedIndex,
  buildTruncatedIndex: buildTruncatedIndex,
  encodeSchool: encodeSchool,
  encodeAdapter: encodeAdapter,
  varint: varint
};

/* 直接运行时，自己 encode→decode 一圈，确认与解码器对得上 */
if (require.main === module) {
  const path = require('path');
  const W = require(path.join(__dirname, '..', 'web', 'js', 'warehouse.js'));
  const idx = W.decodeIndex(buildSampleIndex());
  console.log('protocol =', idx.protocol, ' version_id =', idx.versionId);
  console.log('接入学校 =', idx.schools.length, ' 接入适配器 =', idx.accepted,
    ' 挡掉 =', idx.dropped);
  idx.schools.forEach(function (s) {
    console.log('  ·', s.id, s.name, s.initial, s.folder,
      '->', s.adapters.map(function (a) { return a.adapterId; }).join(','));
  });
}
