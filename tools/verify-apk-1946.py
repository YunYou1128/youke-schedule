# -*- coding: utf-8 -*-
"""
v1.9.46 出厂包静态核验。

v1.9.46 只有一件事：**导入面板里那两段「读一次就够」的说明改成可折叠**
（默认收起，否则方式二 / 方式三会被挤出屏幕）。它落在包里是**三个文件**，
而且三处任一漏掉都不会有任何界面报错 —— 正好是这一类最容易在打包环节丢的东西：
  · 44  **折叠件的三件套都必须在包内**：
        `assets/web/index.html` —— 两个 `class="fold-t"` 开关、各指向一个真实存在的
        折叠体、折叠体默认带 `hidden`、两套文案（`data-label-open="收起"`）齐全；
        `assets/web/css/app.css` —— `.fold-t[aria-expanded="true"] .chev` 的 `rotate(-45deg)`
        （箭头不跟状态转的话，用户看不出「现在是开着还是收着」）；
        `assets/web/js/app.js` —— `bindFolds` 这个函数名、`bind()` 里那次调用、
        以及 `aria-expanded` 与 `.hidden` 两处写入（少一处就是半截状态）。
        ⚠️ 判据从**包内**文件现场算，不抄写死清单；`fold-t` 数量对不上就直接报错，
           因为下面几条正则失配时会**双双通过**（空字符串上找什么都没有）。
        ⚠️ 同样要剥注释：这三份文件的注释里都原样写着 `.fold-t` / `aria-expanded`。

为什么要有这个脚本：源码改对了 ≠ 打出来的 APK 是对的。
中间隔着「sync-assets 有没有跑」「gradle 有没有重新 pack assets」「压缩方式对不对」
「权限 / queries 有没有被误删」「资源 XML 有没有真的改进去」—— 这些都是**静默**的，
跑一遍整个流程才抓得住。

v1.9.45 与 v1.9.44 相比是一轮「体检修复」（`体检报告-v1.9.44.md` 里除 F1 之外的全部
条目），其中**落在包里**的有四处 —— 四者共同点是「改错了不会有任何界面报错」：
  · 40  **转义函数只剩一份实现**。此前 app.js（5 字符，会转 `'`）与 picker.js
        （4 字符，漏 `'`）各写一份、而且已经漂了 —— 同一个语义两处实现早晚发散。
        现在实现收在 store.js（`index.html` 里的第一只 script，谁都能拿到），
        另两处只留 `return Store.esc(s)` 转发（与 hueOf / storedHue 那批函数的下沉同例）。
        判据两半：store.js 的 esc 实现含全部 5 个实体字面量；app.js / picker.js
        都含转发行、且**都不再出现任何实体字面量** —— 第二份实现长回来就会被抓住。
        ⚠️ 必须先剥注释：沿革注释里正是拿 `&amp;` 这些字样在讲「为什么要收口」。
  · 41  **整页无障碍三件**：viewport 不再 `user-scalable=no`（禁缩放属无障碍缺陷）；
        `#toast` 是**常驻**节点且带 `role="status" aria-live="polite"`
        （每次弹之前新建的节点读屏根本不认）；`label for` 全部指向真实存在的控件 id。
        ⚠️ 那条「悬空 for」是**从包内 index.html 现场算出来的**，不是写死名单 ——
           与冒烟那份同一口径，但这里读的是**打包后的**那一份。
        ⚠️ HTML 注释要单独剥（`<!-- ... -->`）：本仓库的 index.html 里就有一整段
           注释在讲「v1.9.45 起不再禁缩放」，不剥就会被自己写的解释绊红。
  · 42  **解析锚定**：`csv.js` 的 `parseDay` 正则必须是「前缀可省 + 整串锚定」
        （`^…$`）的形状。不锚定的话 `13:00` 会在中间匹配到 `1` 被判成「周一」——
        把「列错位」这种数据问题悄悄变成「导入成周一」，用户看不出来。
        判据比的是**这个正则字面量的首尾**（`^` / `$`），不是抄一遍整条正则。
  · 43  **全量备份 / 恢复这套 API 必须在包里**（v1.9.45 新增能力）。
        少了任何一个名字，「导出全部数据 / 从备份恢复」在真机上就是**按了没反应、
        也不报错**。判据比「三只函数名 + 自家标记」两半：`exportAll` /
        `parseBackup` / `importAll` + `youke-backup`。

v1.9.44 的 39 号（**修红米 / HyperOS 上找不到桌面小组件**）继续保留 ——
撤销过的设计**不许回头**，旧包验红的结论对新包一样成立。它的成因值得再抄一遍：
  两个 appwidget receiver（`WidgetTodayProvider` / `WidgetTwoDayProvider`）的
  `android:exported` 由 `false` 改成 `true`。桌面（`com.miui.home` 等）是**另一个
  应用**，它要按 ComponentName 枚举组件、再发绑定 / 更新广播；部分定制 ROM 在
  「枚举选择列表」这一步会按 exported 过滤 ⇒「长按桌面 → 小部件」里根本看不到柚课。
  AOSP 官方示例写的是 false（系统广播确实有豁免），小米一线有实证踩坑。
  ⚠️ **实测**：`aapt2 dump xmltree` 把布尔属性打印成**裸值**
     （`…android:exported(0x01010010)=false` / `=true`），**没有**
     `(type 0x12)0xffffffff` 那层包装 —— 别凭 AXML 的二进制形态去猜打印格式，
     猜错了这条断言会「读不到属性」而红得莫名其妙（当时真踩了一次）。
     正则里两种形态都收，是为了换 build-tools 也不会假红。
  ⚠️ 必须读**编译产物**：源码改对了，中间还隔着一层 manifest merger。

v1.9.43 的那批（34 / 35 / 36 / 37 / 38，内嵌浏览器只剩一条导入通道）继续保留。

v1.9.42 的那批（19 / 21 / 27 / 28 / 33，随包脚本正文整条拆掉）继续保留 ——
撤销过的设计**不许回头**，旧包验红的结论对新包一样成立。
v1.9.41（25 / 25b / 26 内置快照）、v1.9.40 的 31 号、v1.9.39 的 30 号、
v1.9.38 的 29 号、v1.9.32 的适配库四条（21-24）继续保留；
v1.9.31 安全面 / v1.9.30 包名合规照旧。

⚠️ 16 号（v1.9.29 那批 dex 符号）里**摘掉了四个门闩名字**
（claimArmed / armCapture / disarmCapture / armedToken）—— 它们原本是自研抓页
的一趟一令牌，随抓页一起退场；留在名单里就是一条**恒红**的断言。
「它们真的没了」由 34 号反查。

用法：
    python tools/verify-apk-1945.py [apk 路径]
默认核验 dist/柚课-v1.9.45.apk。

⚠️ 这个脚本是**一版一份**、里面的期望值是钉死的。新版本发版时复制一份改名
   （verify-apk-<ver>.py）再改里面的 EXPECT_*；旧版那份**别动** ——
   它还要能回跑旧包。
   tools/smoke-test.js 的 [D] 段会自动比对「本脚本钉的版本号/包名 == build.gradle」，
   漏同步会被冒烟抓住。
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
APK = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist', '柚课-v1.9.46.apk')
WEB_SRC = os.path.join(ROOT, 'web')
_BUILD_TOOLS = os.path.join(os.environ.get('ANDROID_HOME', ''), 'build-tools', '36.0.0')
if not os.environ.get('ANDROID_HOME'):
    sys.exit('请先设置 ANDROID_HOME 环境变量（指向 Android SDK 根目录）后再运行本脚本。')
AAPT2 = os.path.join(_BUILD_TOOLS, 'aapt2.exe')
DEXDUMP = os.path.join(_BUILD_TOOLS, 'dexdump.exe')

EXPECT_VERSION_CODE = '60'
EXPECT_VERSION_NAME = '1.9.46'
EXPECT_PACKAGE = 'cn.youke.schedule'      # D-2：正式包名（原占位 com.example.schedule）
EXPECT_OLD_PACKAGE = 'com.example'        # 反向断言用：整包里不许再出现它
EXPECT_MINSDK = '26'
EXPECT_TARGETSDK = '36'
EXPECT_PERMISSIONS = {
    'android.permission.INTERNET',
    # androidx 注入的 signature 级权限。名字由 applicationId 推出 ⇒ 包名改了它也跟着改，
    # 这也是「包名有没有换干净」的一个侧面证据。
    'cn.youke.schedule.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
}
EXPECT_QUERIES = {
    'com.tencent.mm',            # 微信
    'com.tencent.mobileqq',      # QQ
    'com.alibaba.android.rimet', # 钉钉
}
# v1.9.42：− 1 —— js/adapter-local.js（本校脚本正文内联）整条拆掉。
EXPECT_WEB_FILES = 19
EXPECT_WEB_CSV = 0
# v1.9.41：内置快照整体取消。这两条是「它真的没了」的判据 ——
#   ①包里不许再有这个资产目录；②dex 里不许再出现这一批符号。
EXPECT_WAREHOUSE_ASSET_PREFIX = 'assets/warehouse/'
EXPECT_BUNDLED_SYMBOLS_ABSENT = [
    'getBundledIndex',        # v1.9.33 读内置快照的桥方法
    'BUNDLED_INDEX_ASSET',    # v1.9.33 资产常量
    'MAX_BUNDLED_BYTES',      # v1.9.33 体积上限
    'BUNDLED_SCRIPT_PREFIX',  # v1.9.35 本地内置脚本的资产前缀
    'sanitizeAssetPath',      # v1.9.33 路径消毒（随「读资产」一起退场）
    'adapterScriptPath',      # v1.9.33 内置脚本的相对路径字段
]

# v1.9.42：随包脚本正文那一整套（文件 / 生成器 / 桥 key / 长度防呆常量 /
# Activity 字段名）都必须**不在包里**。这一批全是「源码删了、编译产物里
# 那份照样带出去」的静默残留 —— JS 文件漏删会进 assets、删了源码忘了删
# assets/web 里的镜像更常见；Kotlin 侧那几个名字会留在 dex 字符串池里。
#
# ⚠️ 「某个东西不存在」是最容易永远绿的一类断言 ⇒ 本脚本交付前必须拿
#    v1.9.41 旧包回跑一次，确认这几条**真的会红**（旧包里这几个词全在）。
EXPECT_ADAPTER_INLINE_ABSENT = [
    # 两端文件名（前者是网页侧的镜像，后者是构建期转写脚本）
    'adapter-local.js',
    'gen-adapter-local.js',
    # 第 6 参（脚本正文）在两头之间传递的 extra key —— v1.9.42 连着机制一起拆
    'adapter_source',
    # Kotlin 侧收一段脚本文本时用的长度防呆常量与字段名
    'MAX_SCRIPT_SOURCE_CHARS',
    'adapterScriptSource',
]
# 这一批要灭在**两个不同的地方**，所以拆成两份名单：
#   文件名腿 —— zip 条目名里不许含（去后缀做子串匹配，`adapter-local.js` → `adapter-local`，
#               这样 `…/adapter-local.js`、`…/gen-adapter-local.js` 都兜得住）；
#   符号腿   —— dex 字符串池里不许有（Kotlin 那侧的常量 / 字段名）。
INLINE_FILE_NAMES = [s for s in EXPECT_ADAPTER_INLINE_ABSENT if s.endswith('.js')]
INLINE_SYMBOLS = [s for s in EXPECT_ADAPTER_INLINE_ABSENT if not s.endswith('.js')]

# v1.9.42：`openWithAdapter` 的**参数个数**。
# Java 桥按「方法名 + 参数个数」反射：网页侧多传一个实参、原生侧少声明一个，
# 结果是**静默失配** —— 点了没反应，日志里一个错都没有。
# 包内网页与原生同一次构建发布，所以同改无失配窗口；但只要有人只改一边，
# 或者哪天两端不同步了，这里就会红。
EXPECT_BRIDGE_ARG_COUNT = 5

# 编译后清单里必须出现的组件全名（源码里写的是相对名，这里核的是**替换后的结果**）
EXPECT_COMPONENTS = [
    'cn.youke.schedule.MainActivity',
    'cn.youke.schedule.EduLoginActivity',
    'cn.youke.schedule.WidgetTodayProvider',
    'cn.youke.schedule.WidgetTwoDayProvider',
    'cn.youke.schedule.WidgetListService',
]
EXPECT_AUTHORITY = 'cn.youke.schedule.fileprovider'

# v1.9.29 那批引入、v1.9.30 继续保留的 dex 符号
EXPECT_DEX_SYMBOLS = [
    'safeFileName',                      # B-6 文件名清洗（两条出口共用）
    'shouldOverrideUrlLoading',          # B-4 主 WebView 导航拦截
    'ASSET_PREFIX',                      # B-4 只放行 assets 前缀
    'setAcceptThirdPartyCookies',        # B-2 关第三方 Cookie
    'setAllowUniversalAccessFromFileURLs',  # B-5 关 file:// 跨源
    'setAllowContentAccess',             # B-5 刻意保持 true 的那一条
]
# v1.9.43：**摘掉四个门闩名字**（claimArmed / armCapture / disarmCapture /
#          armedToken）。它们原本是**自研抓页**的一趟一令牌，随抓页整条退场；
#          留在上面那张「必须查得到」的名单里就是一条**恒红**的断言。
#          ⚠️ 注意别和下面 EXPECT_GRAB_PAGE_ABSENT 里的 `adapterToken` 搞混：
#          `adapterToken` 是**适配脚本**那座桥的门闩，它**还在**（见 EXPECT_ADAPTER_SYMBOLS）。
#          「抓页那四个真的没了」由 34 号反查。

# v1.9.43：自研抓页那一整套，**一个字都不许出现在 dex 里**。
# 它们全是「源码删了、编译产物里那份照样带出去」的静默残留类型：
# Kotlin 侧的名字会留在 dex 字符串池里，注释里的字则**不会**（注释进不了 dex）——
# 所以这一条能真的红，不是被注释喂绿的。
#
# ⚠️ 必须先拿 v1.9.42 旧包回跑：旧包里这些名字全在，这一条**必定红**。
#    没红过＝没有断言。
EXPECT_GRAB_PAGE_ABSENT = [
    # 抓取桥与它的宿主（网页侧 @JavascriptInterface 名 + 原生内部类）
    'AndroidEduCapture', 'CaptureBridge',
    # 一趟一令牌门闩
    'armedToken', 'armCapture', 'disarmCapture', 'claimArmed',
    # 注入 JS（抓整页 HTML 的那几支）
    'grabJs', 'GRAB_DIAG_JS', 'VIEWPORT_FIT_JS', 'VIEWPORT_RAW_JS',
    # 页面预检与可读框架统计
    'looksLikeSchedulePage', 'hasWeekdayHeading', 'frameWarning',
    # 弹窗式长文案底座
    'showTip',
    # 落盘 / 分享排查出口
    'dumpCurrentPage', 'dumpPage', 'offerShare', 'shareDump',
    # 显示模式开关（「适应屏幕 / 原始大小」）
    'fitWidth', 'KEY_FIT_WIDTH',
    # 长度 / 超时防呆（抓页专用）
    'MAX_HTML_CHARS', 'BRIDGE_TIMEOUT_MS',
]

# v1.9.43：`MainActivity.handleEduResult()` 的回传入口名。
# 三分支变两分支 —— `onEduHtml` 是自研抓页那条路的入口，整条拆掉。
# ⚠️ 它不是 `onEduAdapter` / `onEduBuffer` 的子串，可以直接查字符串池。
EXPECT_EDU_CALLBACKS_ABSENT = ['onEduHtml']

# v1.9.43：底栏那栏「适应屏幕 / 怎么用 / 导入课表」整栏删了 ——
# 声明它们的三处 `@+id` 与引用它们的三处接线都该消失，资源表里也不许再留。
EXPECT_EDU_BOTTOM_IDS_ABSENT = ['btnEduGrab', 'btnEduFit', 'btnEduHelp']

# v1.9.32 起：适配脚本宿主与适配库下载通道。
# 适配脚本在**另一个 Activity**（EduLoginActivity）里、跑在**别人家的页面**上，
# 它到底有没有被编进包、桥名有没有拼错、上游八个方法名有没有写全 ——
# 读源码看不出来，只有对成品包做静态核验、查一遍符号池才作数。
# v1.9.41：去掉随内置快照退场的四个符号（getBundledIndex / adapterScriptPath /
#          sanitizeAssetPath / warehouse/resources/）。
# v1.9.42：去掉 `adapter_source` —— 它曾经是第 6 参（脚本正文）在两头之间
#          传递的那把钥匙；整条机制拆掉后它**不该**再出现在 dex 里
#          （改由 EXPECT_ADAPTER_INLINE_ABSENT 反查）。
EXPECT_ADAPTER_SYMBOLS = [
    'AndroidAdapterHost',                # 页面注入的宿主桥名（网页侧按常量引）
    'AdapterHost',                       # 原生侧的宿主内部类
    'adapterToken',                      # 一趟一令牌：不是这一趟就哑掉
    'adapterScriptUrls',                 # 脚本地址按顺序给（CDN → 回源）
    'maybeReinjectAdapter',              # 脚本跳转后在新页重新注入
    'stopAdapter',                       # 收尾：连页面宿主一起摘
    'shiguangBridge',                    # 上游脚本认的第一个桥名
    'shiguangBridgePromise',             # 上游脚本认的 Promise 桥
    'AndroidBridgePromise',              # 老脚本用的别名（6 个脚本只认这个）
    'showSingleSelection',               # 上游桥方法（单选）
    'saveImportedCourses',               # 上游桥方法（交课程）
    'savePresetTimeSlots',               # 上游桥方法（交作息）
    'saveCourseConfig',                  # 上游桥方法（交学期配置）
    'notifyTaskCompletion',              # 上游桥方法（「我干完了」）
    'AndroidWarehouse',                  # 适配库下载桥（网页侧 @JavascriptInterface 名）
    'WarehouseHost',                     # 下载回包入口（原生 evaluateJavascript 的目标）
    'openWithAdapter',                   # 网页 → 原生：带脚本打开内嵌浏览器
    'onEduAdapter',                      # 原生 → 网页：适配结果回传
]

# 下载口只放行这四个前缀（v1.9.40：两条 → 四条）。它是网页能直接调到的原生入口，
# 不设限就等于给「让原生去下载任意地址」开了口子。
# ⚠️ 钉的是**完整前缀**、不是裸域名：主机遇上但路径前缀不对，原生一样拒收，
#    而网页侧只会看到「下载失败」——两边都不说是白名单的问题。
EXPECT_WAREHOUSE_HOSTS = [
    'https://gitee.com/XingHeYuZhuan-gh/',            # 上游作者的 Gitee CN 镜像站（实测最快）
    'https://cdn.jsdelivr.net/gh/ShiGuangSchedule/',  # jsDelivr CDN
    'https://raw.githubusercontent.com/ShiGuangSchedule/',  # GitHub 回源
    'https://git.itdong.me/XingHeYuZhuan/',           # 上游作者的 ITDONG 镜像（Gogs）
]

# 包内适配库模块里不许出现的**真实**教务域名。
# 占位值（xxx. / example. / demo. 等）显式放行 —— 它们是界面上教用户怎么填的示例。
PLACEHOLDER_HOST = re.compile(r'(^|\.)(example|xxx|yyy|demo|sample|test)\.', re.I)
SCHOOL_HOST = re.compile(r'[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:edu\.cn|ac\.cn|edu)\b')

# v1.9.42：随包走的社区适配库模块**收回两个** ——
# adapter-local.js（本校脚本正文）整条拆掉，包里一只脚本都没有。
ADAPTER_MODULES = ('js/warehouse.js', 'js/adapter-import.js')

# 真实隐私残留词：教师姓名 / 楼栋 / 校区 / 校名。注释也是文本，一样进包。
#
# 【v1.9.31 改】词表**不再写在这里**（原先等于把判据本身公开了）。
# 从 tools/privacy-words.local.txt 读；没配时相关检查「跳过」而非失败。
sys.path.insert(0, HERE)
from privacy_words import load_words, hits_in, skip_note   # noqa: E402

SENSITIVE = load_words()

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('  [OK]   ' if ok else '  [FAIL] ') + name + (('  -> ' + detail) if detail else ''))


def aapt(*args):
    if not os.path.isfile(AAPT2):
        return ''
    return subprocess.run([AAPT2] + list(args), capture_output=True, text=True,
                          encoding='utf-8', errors='replace').stdout


def res_path_of(resdump, res_name):
    """从 `aapt2 dump resources` 的文本里找某个 xml 资源在包内的实际路径。

    release 开了资源收缩，`res/xml/file_paths.xml` 这种路径在包里**不存在** ——
    会被改名成 `res/8K.xml` 之类，而且每次构建都可能变。所以必须按资源名反查，
    不能写死路径（写死的话这个脚本下一版就失效）。 """
    m = re.search(r'resource 0x[0-9a-f]+ xml/%s\b[^\n]*\n\s*\(\) \(file\) (\S+)' % re.escape(res_name),
                  resdump)
    return m.group(1) if m else None


def strip_comments(src):
    """把 JS 里的注释剥掉（与 tools/smoke-test.js 的 stripComments 逐字同口径）。

    历史沿革的注释里会原样提到已经拆掉的名字 —— 断言「某个名字不存在」之前
    必须先剥注释，否则要么永远绿（名字只在注释里）、要么永远红（注释喂红）。
    两条正则照抄冒烟那份：/* ... */ 与「非冒号开头的 //」，后者是为了不误砍
    字符串里的 `https://`。"""
    src = re.sub(r'/\*[\s\S]*?\*/', '', src)
    return re.sub(r'(^|[^:])//[^\n]*', r'\1', src)


def dex_method_type(zf, dexs, method_name):
    """借 build-tools 的 dexdump 取某方法在**编译后** dex 里的类型签名。

    返回形如 `(Ljava/lang/String;Ljava/lang/String;)V` 的原型串；找不到返回 None。

    为什么要绕这一道：dex 的 proto 里存着**真实的参数表**，是「反射式桥到底
    几个参数」唯一可靠的判据。在 Kotlin 源码上数逗号只是代理指标 ——
    一旦哪天有人改成默认参数、可变参数、或把参数收进 data class，
    源码看着还是 5 个、proto 已经变了。
    ⚠️ dexdump 要读实实在在的文件，所以先把 dex 落到临时目录、用完即删
      （不要让这些中间产物留进工程）。
    """
    if not os.path.isfile(DEXDUMP):
        return None
    tmp = tempfile.mkdtemp(prefix='youke-verify-dex-')
    try:
        for n in sorted(dexs):
            p = os.path.join(tmp, os.path.basename(n))
            with open(p, 'wb') as f:
                f.write(zf.read(n))
            out = subprocess.run([DEXDUMP, p], capture_output=True, text=True,
                                 encoding='utf-8', errors='replace').stdout
            m = re.search(r"name\s+:\s*'%s'\s*\n\s*type\s+:\s*'([^']*)'"
                          % re.escape(method_name), out)
            if m:
                return m.group(1)
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def dex_arg_count(sig):
    """从 dex 方法原型里数参数个数（只认 `(...)` 里那一段）。

    逐字符走一遍而不是「数分号」：`[I`（int 数组）、`J`、`Z` 这些基本类型
    没有分号，数分号会把它们漏掉。数组前缀 `[` 不单独算一个参数。
    """
    body = sig[1:sig.rindex(')')]
    n, i = 0, 0
    while i < len(body):
        c = body[i]
        if c == '[':
            i += 1
            continue
        if c == 'L':
            i = body.index(';', i) + 1
        else:
            i += 1
        n += 1
    return n


def main():
    # 抬头从 EXPECT_VERSION_NAME 推 —— 原来这行是写死的字符串，一路从 v1.9.42
    # 抄到 v1.9.44 都没人发现（每一版都复制上一版的文件，谁也不会去看这行）。
    # 改成推导之后，**下一版不会再抄错**，也不需要谁记得改它。
    print('== v%s 出厂包静态核验 ==' % EXPECT_VERSION_NAME)
    print('APK: ' + APK)

    if not os.path.isfile(APK):
        check('1. APK 文件存在', False, APK)
        return finish()
    size = os.path.getsize(APK)
    check('1. APK 文件存在', size > 512 * 1024, '%.2f MB' % (size / 1048576.0))

    # --- aapt2 badging：包名 / 版本 / SDK ---
    badging = aapt('dump', 'badging', APK)
    pkg = re.search(r"package: name='([^']*)' versionCode='([^']*)' versionName='([^']*)'", badging)
    if pkg:
        check('3. 包名 / versionCode / versionName',
              pkg.group(2) == EXPECT_VERSION_CODE and pkg.group(3) == EXPECT_VERSION_NAME,
              "name=%s vc=%s vn=%s" % (pkg.group(1), pkg.group(2), pkg.group(3)))
        check('3b. 包名已是正式包名 %s（D-2）' % EXPECT_PACKAGE,
              pkg.group(1) == EXPECT_PACKAGE, pkg.group(1))
    else:
        check('3. 包名 / versionCode / versionName', False, 'aapt2 badging 未解析出 package 行')

    minsdk = re.search(r"minSdkVersion:'([^']*)'", badging)
    targetsdk = re.search(r"targetSdkVersion:'([^']*)'", badging)
    check('4. minSdk 26 / targetSdk 36',
          minsdk and minsdk.group(1) == EXPECT_MINSDK and targetsdk and targetsdk.group(1) == EXPECT_TARGETSDK,
          'min=%s target=%s' % (minsdk.group(1) if minsdk else '?', targetsdk.group(1) if targetsdk else '?'))

    perms = set(re.findall(r"uses-permission: name='([^']*)'", badging))
    check('5. 权限恰好 2 条（D 批一条都没加；第二条的名字由 applicationId 推出）', perms == EXPECT_PERMISSIONS,
          '实际 %d 条: %s' % (len(perms), sorted(perms)))

    # --- queries（Android 11+ 不声明就查不到微信/QQ/钉钉，且不报错）---
    xtree = aapt('dump', 'xmltree', '--file', 'AndroidManifest.xml', APK)
    qpkgs = set()
    idx = xtree.find('E: queries')
    if idx >= 0:
        end = xtree.find('\n      E: ', idx)
        qpkgs = set(re.findall(r'name\(0x01010003\)="([^"]*)"', xtree[idx:end if end > 0 else len(xtree)]))
    check('6. <queries> 三个包名齐全', qpkgs == EXPECT_QUERIES, '实际: %s' % sorted(qpkgs))

    # --- D-2：编译后清单里的组件名 / authority 必须已经是新包名 ---
    #     源码里写的是相对名（.MainActivity）与 ${applicationId}，替换发生在打包期。
    #     这一条是「包名有没有换干净」最直接的证据 —— 光读源码看不出来。
    #     ⚠️ `aapt2 dump xmltree` 的属性名**带命名空间 URI 前缀**，形如
    #        `A: http://schemas.android.com/apk/res/android:name(0x01010003)="…"`，
    #        所以匹配串里**不要**写 `A: android:name(…)` —— 上一版就是这么写错的，
    #        跑出两条假的 FAIL（包明明是好的）。
    missing_comp = [c for c in EXPECT_COMPONENTS
                    if ('name(0x01010003)="%s"' % c) not in xtree]
    check('6b. D-2 编译后清单里五个组件全在新包名之下（%d 个）' % len(EXPECT_COMPONENTS),
          not missing_comp, ('缺失: %s' % missing_comp) if missing_comp else '全部命中')
    # ⚠️ detail 是**必打印**的（check 只要拿到非空 detail 就显示），所以不能写成
    #    「失败时的说明」—— 上一版就把它写成了「清单里没找到该 authority」，
    #    于是**通过时也在报没找到**，读起来像假绿。这里改成条件表达式。
    _has_authority = bool(re.search(r'authorities\(0x[0-9a-f]+\)="%s"' % re.escape(EXPECT_AUTHORITY), xtree))
    check('6c. D-2 FileProvider 的 authority 已展开为 %s（证明 ${applicationId} 真的被替换了）'
          % EXPECT_AUTHORITY,
          _has_authority,
          ('已命中 ' + EXPECT_AUTHORITY) if _has_authority else '清单里没找到该 authority')

    # --- zip 结构 ---
    zf = zipfile.ZipFile(APK)
    infos = zf.infolist()
    web = [i for i in infos if i.filename.startswith('assets/web/') and not i.filename.endswith('/')]
    check('2. zip 可解析 / 条目总数合理', len(infos) > 10, '条目 %d 个' % len(infos))
    check('7. assets/web 文件数 = %d' % EXPECT_WEB_FILES, len(web) == EXPECT_WEB_FILES,
          '实际 %d 个' % len(web))

    csvs = [i.filename for i in web if i.filename.lower().endswith('.csv')]
    check('8. assets/web 里 CSV = %d（不能夹带真实课表）' % EXPECT_WEB_CSV, len(csvs) == 0,
          '发现: %s' % csvs if csvs else '0 个')

    notstored = [i.filename for i in web if i.compress_type != zipfile.ZIP_STORED]
    check('9. assets/web 全部 STORED（未被压缩）', len(notstored) == 0,
          '被压缩: %s' % notstored if notstored else '全部 STORED')

    # --- 与 web/ 逐字节一致 ---
    mismatches, missing, extra = [], [], []
    names_in_zip = {i.filename for i in web}
    for i in web:
        rel = i.filename[len('assets/web/'):]
        src = os.path.join(WEB_SRC, rel.replace('/', os.sep))
        if not os.path.isfile(src):
            missing.append(rel)
            continue
        with open(src, 'rb') as f:
            if zf.read(i.filename) != f.read():
                mismatches.append(rel)
    for dirpath, _dirs, files in os.walk(WEB_SRC):
        for fn in files:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, WEB_SRC).replace(os.sep, '/')
            if 'assets/web/' + rel not in names_in_zip:
                extra.append(rel)
    check('10. assets/web 与 web/ 逐字节一致',
          not mismatches and not missing and not extra,
          ('内容不符: %s ' % mismatches if mismatches else '') +
          ('源码有包里无: %s ' % extra if extra else '') +
          ('源文件缺失: %s' % missing if missing else '') or
          '%d 个文件逐字节一致' % len(web))

    # --- 关键文件 ---
    names = {i.filename for i in infos}
    dexs = [n for n in names if re.match(r'^classes\d*\.dex$', n)]
    has_core = 'AndroidManifest.xml' in names and 'resources.arsc' in names
    check('11. AndroidManifest.xml / resources.arsc / classes*.dex 齐备',
          has_core and len(dexs) >= 1, 'dex %d 个' % len(dexs))

    mw = next((i for i in infos if i.filename == 'assets/web/manifest.webmanifest'), None)
    check('11b. manifest.webmanifest 存在且 STORED（主屏幕名字/图标来源）',
          mw is not None and mw.compress_type == zipfile.ZIP_STORED,
          '缺失' if mw is None else 'STORED' if mw.compress_type == zipfile.ZIP_STORED else '被压缩了')

    # --- E-1：敏感词扫描 ---
    #     v1.9.31 起从「只扫 assets/web 的文本文件」扩到**整包**（含 dex、
    #     resources.arsc、编译后清单）。理由：校名/域名会出现在 dex 的字符串池里，
    #     只扫 assets 会漏掉一半；而 `.xls` 之类万一被塞进包，字符串是 UTF-16，
    #     只按 UTF-8 查得到的是**假绿**。所以一律走三种编码。
    #     词表来自 tools/privacy-words.local.txt；没配就跳过（不算失败）。
    #     ⚠️ v1.9.41：内置快照取消后，原先「跳过 assets/warehouse/」那条豁免**删掉**
    #        —— 整包每一个条目都必须过词表（本校脚本正文内联在 web/ 里，走的就是
    #        与 schools.js 同一条豁免口径：校名三词早在 v1.9.35 就从词表移除了）。
    if not SENSITIVE:
        check('12. 整包内无真实教师/楼栋/校区/校名残留', True, skip_note())
        check('12b. dex / resources.arsc 也在扫描范围内（哨兵）', True, '随 12 一起跳过')
    else:
        hits = []
        for n in sorted(names):
            if n.endswith('/'):
                continue
            try:
                buf = zf.read(n)
            except Exception:
                continue
            text = None
            if n.lower().endswith(('.js', '.html', '.css', '.csv', '.json', '.webmanifest', '.txt')):
                try:
                    text = buf.decode('utf-8')
                except Exception:
                    text = None
            for w in hits_in(buf, SENSITIVE, text):
                hits.append('%s: %s' % (n, w))
        check('12. 整包内无真实教师/楼栋/校区/校名残留', len(hits) == 0,
              ('命中: %s' % hits[:8]) if hits else '干净（词表 %d 条 / 扫了 %d 个条目）'
              % (len(SENSITIVE), len([n for n in names if not n.endswith('/')])))
        # 哨兵：上面那条如果是「空扫描」也会绿。这里钉住 dex 与 resources.arsc
        # 真的被读进来了 —— 它们才是校名/域名最可能出现的地方。
        scanned = [n for n in names if n.endswith('.dex') or n == 'resources.arsc']
        check('12b. dex / resources.arsc 也在扫描范围内（哨兵，防「空扫描也是绿」）',
              len(scanned) >= 2 and all(len(zf.read(n)) > 1000 for n in scanned),
              '%d 个：%s' % (len(scanned), ', '.join(scanned[:4])))

    # --- B-3 / B-7：读**编译后的**资源 XML（不是读源码）---
    resdump = aapt('dump', 'resources', APK)
    fp_path = res_path_of(resdump, 'file_paths')
    check('13. 包内能定位到 xml/file_paths（资源收缩后靠资源名反查，不写死路径）',
          fp_path is not None, fp_path or '未找到')
    if fp_path:
        fp_xml = aapt('dump', 'xmltree', '--file', fp_path, APK)
        check('13b. B-3 FileProvider 白名单已收窄：cache-path = share/，且没有 path="."',
              re.search(r'E: cache-path', fp_xml) is not None and
              re.search(r'A: name="share" \(Raw: "share"\)', fp_xml) is not None and
              re.search(r'A: path="share/" \(Raw: "share/"\)', fp_xml) is not None and
              re.search(r'A: path="\." \(Raw: "\."\)', fp_xml) is None,
              'cache-path 段: ' + (re.search(r'E: cache-path[\s\S]{0,200}', fp_xml).group(0).replace('\n', ' | ')
                                   if re.search(r'E: cache-path', fp_xml) else '无'))

    for res_name, label in (('backup_rules', 'backup_rules'),
                            ('data_extraction_rules', 'data_extraction_rules')):
        p = res_path_of(resdump, res_name)
        if not p:
            check('14. B-7 %s 排掉 edu_browser.xml' % label, False, '包内未找到该资源')
            continue
        x = aapt('dump', 'xmltree', '--file', p, APK)
        n_excl = len(re.findall(r'A: path="edu_browser\.xml" \(Raw: "edu_browser\.xml"\)', x))
        n_excl_el = len(re.findall(r'E: exclude', x))
        need = 2 if res_name == 'data_extraction_rules' else 1
        check('14. B-7 %s 排掉教务浏览器痕迹（需要 %d 处 exclude）' % (label, need),
              n_excl == need and n_excl_el == need,
              'exclude 节点 %d 个 / edu_browser.xml %d 处' % (n_excl_el, n_excl))

    check('15. B-7/B-8 两条「已知情取舍」进包了：allowBackup=true、usesCleartextTraffic=true',
          bool(re.search(r'allowBackup\(0x[0-9a-f]+\)=true', xtree)) and
          bool(re.search(r'usesCleartextTraffic\(0x[0-9a-f]+\)=true', xtree)) and
          bool(re.search(r'dataExtractionRules\(0x[0-9a-f]+\)=@0x', xtree)) and
          bool(re.search(r'fullBackupContent\(0x[0-9a-f]+\)=@0x', xtree)))

    # --- B-1 / B-4 / B-6：dex 里的新符号 ---
    blob = b''.join(zf.read(n) for n in dexs)
    absent = [s for s in EXPECT_DEX_SYMBOLS if s.encode('ascii') not in blob]
    check('16. dex 里能查到 %d 个 v1.9.29 的符号（导航拦截 / 文件名清洗 / 两个 WebView 开关）'
          % len(EXPECT_DEX_SYMBOLS),
          len(absent) == 0, ('缺失: %s' % absent) if absent else '全部命中')

    # --- D-2：整包里旧包名 0 残留 ---
    #     这是本版最值钱的一条。字符串可能藏在 dex 的类名描述符、resources.arsc 的
    #     字符串池、编译后清单、甚至某个 .kotlin_module 里 —— 逐个可能的位置都扫。
    #     （清单里不许有旧包名，这是「组件名换干净了」的另一面证据。）---
    old_hits = []
    for n in sorted(names):
        if n.endswith('/'):
            continue
        try:
            data = zf.read(n)
        except Exception:
            continue
        if n.endswith('.dex'):
            probe = b'Lcom/example/schedule'
        elif n == 'AndroidManifest.xml' or n == 'resources.arsc' or n.endswith('.xml'):
            probe = b'com.example'
        else:
            probe = b'com/example/schedule'
        if probe in data:
            old_hits.append('%s (%s)' % (n, probe.decode('ascii')))
    check('17. D-2 整包里旧包名 0 残留（dex / 资源 / 清单 / 一切条目）',
          not old_hits, ('命中: %s' % old_hits) if old_hits else '干净')

    # --- D-1：研究产物不在项目根 ---
    #     出包时顺手复核一遍。合规清单里那条「打包前必删」靠人记，
    #     这里靠脚本 —— 两条一起才算封住。
    stray = [f for f in os.listdir(ROOT) if f.startswith('_analysis')]
    check('18. D-1 研究产物不在项目根（_analysis* 已移出）',
          not stray, ('仍在: %s' % stray) if stray else '干净')

    # --- E-2（v1.9.36 口径 / v1.9.42 改写）：本校不做特例，且**不再自带脚本** ---
    #     v1.9.35 曾把本校做成 primary（置顶组 + 一键直达写死校名）；
    #     v1.9.36 用户拍板拆除：内置数据只喂 localLibrary()（适配库字母列表），
    #     地址簿回归纯用户数据。
    #     v1.9.42 用户拍板：本校那一行**改指库里那只「正方教务-通用教务」**，
    #     只给地址、不给脚本。核四件事：
    #       ①包内 schools.js 里 BUILTIN 恰好一条、带教务地址；
    #       ②**没有** primary 标记；
    #       ③它给的是一组**上游坐标**（folder/jsPath/adapterId），不是脚本正文；
    #       ④包内 app.js 没有「本校（点一下即打开）」分组、没有 SCH.primary() 调用。
    #     ⚠️ 本地条目自己的 `adapterId` 必须与上游那只（zhengfang_01）**不同** ——
    #        `adapterById()` 只返回第一个命中，同名会让点「正方教务-通用教务」那行
    #        被本地条目**截胡**，界面显示「这所学校的适配脚本没找到」，
    #        完全看不出是撞 id。注意**坐标字段 `upstreamAdapterId` 本来就该等于
    #        `zhengfang_01`**（那正是「用哪只上游脚本」的答案），要防的是
    #        「本地条目的 adapterId 直接抄了它」。
    js_path = 'assets/web/js/schools.js'
    if js_path in names:
        sjs = zf.read(js_path).decode('utf-8', 'replace')
        n_primary = len(re.findall(r'primary:\s*true', sjs))
        has_url = re.search(r'https://[a-z0-9.-]+\.edu\.cn/jwglxt/xtgl/login_slogin\.html', sjs)
        up_folder = re.search(r'upstreamFolder:\s*[\'"]([^\'"]+)[\'"]', sjs)
        up_id = re.search(r'upstreamAdapterId:\s*[\'"]([^\'"]+)[\'"]', sjs)
        up_js = re.search(r'upstreamJsPath:\s*[\'"]([^\'"]+)[\'"]', sjs)
        _ok19, _why19 = True, []
        if n_primary != 0:
            _ok19 = False
            _why19.append('primary %d 处' % n_primary)
        if has_url is None:
            _ok19 = False
            _why19.append('没有教务地址')
        if up_id is None or up_id.group(1) != 'zhengfang_01':
            _ok19 = False
            _why19.append('上游适配器 id 坐标不是 zhengfang_01')
        if (up_folder is None or up_folder.group(1) != 'zhengfang_jiaowu' or
                up_js is None or up_js.group(1) != 'zhengfang_01.js'):
            _ok19 = False
            _why19.append('上游脚本坐标不是 zhengfang_jiaowu / zhengfang_01.js')
        if re.search(r"adapterId:\s*['\"]zhengfang_01['\"]", sjs):
            _ok19 = False
            _why19.append('本地条目的 adapterId 直接抄了上游那只（会被 adapterById 截胡）')
        if not re.search(r"adapterId:\s*'youke_", sjs):
            _ok19 = False
            _why19.append('本地条目的 adapterId 不是 youke_ 前缀')
        ajs = zf.read('assets/web/js/app.js').decode('utf-8', 'replace') \
            if 'assets/web/js/app.js' in names else ''
        for tok in ('本校（点一下即打开）', 'SCH.primary()'):
            if tok in ajs:
                _ok19 = False
                _why19.append('app.js 里仍有 ' + tok)
        check('19. E-2(v1.9.36/v1.9.42) 内置恰好本校一条（地址 + 上游坐标）、无 primary 特例',
              _ok19,
              '；'.join(_why19) or '地址 %s / 上游 %s / 坐标 id %s（本地用 youke_ 前缀）' %
              (has_url.group(0), up_folder.group(1) + '/' + up_js.group(1), up_id.group(1)))
    else:
        check('19. E-2(v1.9.36/v1.9.42) 内置恰好本校一条、无 primary 特例', False,
              '包内找不到 %s' % js_path)

    # ⚠️ 这条只证明「代码在包里」。`loadDataWithBaseURL` 与 `loadUrl("")` 是两条完全不同的路，
    #    而「空地址时到底白不白屏」**无头环境验不到**，必须真机看一眼（README 里已写明）。
    tip = '在地址栏填你学校教务系统的网址'
    check('20. E-2 dex 里有起步页那条提示语（空地址分支真的编进包了；不白屏须真机验）',
          tip.encode('utf-8') in blob,
          '已命中' if tip.encode('utf-8') in blob else '未命中（提示语被改过？）')

    # --- v1.9.32：社区适配库 ---
    #     21. 两个模块真的进了包、且 STORED（第 7 条只数总数，这里点名；
    #         第 10 条只管 assets/web 与 web/ 一致，但「web/ 里有没有这些文件」
    #         它反过来查得到，所以几条合起来才算封住）。
    #         v1.9.42：− js/adapter-local.js —— 包里一只脚本都没有了，
    #         这里回到 v1.9.32 的两个模块；「它真的没了」由 28 号反查。
    mod_bytes = {}
    for rel in ADAPTER_MODULES:
        p = 'assets/web/' + rel
        if p in names:
            mod_bytes[rel] = zf.read(p)
    _stored_ok = True
    for rel in ADAPTER_MODULES:
        i = next((x for x in web if x.filename == 'assets/web/' + rel), None)
        if i is None or i.compress_type != zipfile.ZIP_STORED:
            _stored_ok = False
    check('21. 适配库两个模块都在包内、且 STORED（未压缩；内嵌页面直接 file:// 读它）',
          len(mod_bytes) == len(ADAPTER_MODULES) and _stored_ok,
          '齐备 %d / %d，STORED %s' % (len(mod_bytes), len(ADAPTER_MODULES),
                                      '全对' if _stored_ok else '有被压缩的'))

    #     22. 「名单只在运行时来」这条口径落到包里的证据：
    #         包内适配库模块里搜不到任何**真实**教务域名（占位域名放行）。
    #         一旦有人往模块里塞了一所学校，这里就红。
    #         v1.9.42：名单收回两个模块（脚本正文那条已拆），扫描面跟着收窄 ——
    #         本校那一行现在只写上游坐标（目录名 / 文件名），依然不含域名。
    if mod_bytes:
        bad_hosts = []
        for rel, box in sorted(mod_bytes.items()):
            txt = box.decode('utf-8', 'replace')
            for h in SCHOOL_HOST.findall(txt):
                if not PLACEHOLDER_HOST.search(h):
                    bad_hosts.append('%s: %s' % (rel, h))
        check('22. 包内适配库模块里没有任何真实教务域名（名单只在运行时来）',
              not bad_hosts, ('命中: %s' % bad_hosts[:6]) if bad_hosts else '干净（占位域名已放行）')

    #     23. dex 符号：适配宿主 / 上游八个桥方法 / 适配库下载通道。
    #         'host' 这类太短的词不查（任何类里都有），只查有辨识度的整词。
    absent2 = [s for s in EXPECT_ADAPTER_SYMBOLS if s.encode('ascii') not in blob]
    check('23. dex 里能查到 %d 个适配宿主 / 适配库符号（脚本在别的 Activity 里跑，读源码看不出来）'
          % len(EXPECT_ADAPTER_SYMBOLS),
          len(absent2) == 0, ('缺失: %s' % absent2) if absent2 else '全部命中')

    #     24. 下载口白名单的**四个前缀**编进了 dex。这四个常量是从
    #         web/js/warehouse.js 的 SOURCES 派生出来的（INDEX_URLS / SCRIPT_BASES），
    #         漂了会出现「网页给了地址、原生一律拒收」——而两边都不报错。
    #         23/24 号是 dex 侧，31 号是「与包内网页侧对齐」，两边合起来才算封住。
    absent3 = [h for h in EXPECT_WAREHOUSE_HOSTS if h.encode('ascii') not in blob]
    check('24. dex 里有适配库的四个分发前缀（网页侧给地址、原生侧按这四个前缀放行）',
          len(absent3) == 0, ('缺失: %s' % absent3) if absent3 else '四个前缀都在')

    # --- v1.9.41：内置全量快照整体取消（反向断言）---
    #     25. 包里**不许再有** assets/warehouse/ 这一个目录。
    #         内置快照从 v1.9.33 存在到 v1.9.40；取消它同样是「静默」的 ——
    #         源码删了、编译产物里那份照样可能被带出去（assets 是整目录打包）。
    wh_left = [i.filename for i in infos if i.filename.startswith(EXPECT_WAREHOUSE_ASSET_PREFIX)]
    check('25. 包里没有 assets/warehouse/（内置快照已整体取消，一个字都不许留）',
          len(wh_left) == 0,
          ('仍有 %d 个: %s' % (len(wh_left), wh_left[:4])) if wh_left else '干净')

    #     25b. 第二份内置快照：`assets/library.pack`（v1.9.33 之前那套「整包 zip 塞
    #          assets」的废弃设计，全仓零引用，却随 v1.9.33~v1.9.40 每个包出厂了
    #          1.14 MB）。连同 assets/ 下除 web/ 与 AGP 自产的 dexopt/ 之外的一切。
    stray_assets = [i.filename for i in infos
                    if i.filename.startswith('assets/')
                    and not i.filename.startswith('assets/web/')
                    and not i.filename.startswith('assets/dexopt/')]
    check('25b. assets/ 下只有 web/ 与 dexopt/（第二份快照 library.pack 已清掉）',
          len(stray_assets) == 0,
          ('仍有: %s' % stray_assets[:4]) if stray_assets else '干净')

    #     26. dex 里**不许再出现**内置快照那一批符号。
    #         ⚠️ 「某个方法没了」是最容易永远绿的一类断言 ⇒ 本脚本交付前必须
    #            拿 v1.9.40 旧包回跑一次，确认这几条**真的会红**。
    still = [s for s in EXPECT_BUNDLED_SYMBOLS_ABSENT if s.encode('ascii') in blob]
    check('26. dex 里不再有内置快照的 %d 个符号（读资产那一整套随快照退场）'
          % len(EXPECT_BUNDLED_SYMBOLS_ABSENT),
          len(still) == 0, ('仍在: %s' % still) if still else '全部清干净')

    #     27. **反向断言**：随包脚本正文那一整套都不在包里。
    #         v1.9.41 时这条是正查（`adapter_source` 在 dex 里）。v1.9.42 把
    #         第 6 参连着机制一起拆了 ⇒ 同一个 key 变成「不许出现」。
    #         两条腿都要查，因为它们灭在**不同的地方**：
    #           ①文件腿 —— zip 里任何条目名都不许含 adapter-local（漏删源码 /
    #             漏删 assets 镜像，都会让这个文件重新进包）；
    #           ②符号腿 —— dex 里不许再出现 Kotlin 那一侧的名字
    #             （`adapter_source` / `MAX_SCRIPT_SOURCE_CHARS` /
    #              `adapterScriptSource`）。注意它们现在**只活在注释里**，
    #             注释进不了 dex —— 所以这一条能真的红，不是被注释喂绿的。
    #         ⚠️ 一定要拿 v1.9.41 的包回跑：旧包里这三个词全在，这里必须红。
    v42_detail = []
    inline_left = [i.filename for i in infos
                   if any(k[:-3] in i.filename for k in INLINE_FILE_NAMES)]
    if inline_left:
        v42_detail.append('包里仍有随包脚本文件: %s' % inline_left[:3])
    dex_left = [s for s in INLINE_SYMBOLS if s.encode('ascii') in blob]
    if dex_left:
        v42_detail.append('dex 里仍有: %s' % dex_left)
    check('27. v1.9.42 随包脚本正文整条拆掉（zip 里没有 %s / dex 里没有那三个名字）'
          % '、'.join(INLINE_FILE_NAMES),
          not v42_detail, '；'.join(v42_detail) or '文件腿与符号腿都干净')

    #     28. 同一条纪律再往下挖一层：**包内网页文本**里也不许有活的引用。
    #         27 号只看文件名与 dex 字符串，抓不到「文件删了、但某个模块还在
    #         调 Warehouse.isLocalScript(...)」这种 —— 那会直接在运行时报
    #         TypeError，而它死在别的 Activity 的页面里，日志里翻不到。
    #         ⚠️ 必须**先剥注释**：warehouse.js / schools.js 里都留着「v1.9.35~41
    #            曾随包带自研脚本」的历史注释，不剥的话这条永远绿（或永远红）。
    _v42b, _detail42b = True, []
    _ref_names = tuple(EXPECT_ADAPTER_INLINE_ABSENT) + ('localSourceOf', 'isLocalScript',
                                                         'LocalAdapters')
    _checked = 0
    for i in infos:
        if not (i.filename.startswith('assets/web/') and i.filename.endswith(('.js', '.html'))):
            continue
        _checked += 1
        _txt = strip_comments(zf.read(i.filename).decode('utf-8', 'replace'))
        _hit = [n for n in _ref_names if n in _txt]
        if _hit:
            _v42b = False
            _detail42b.append('%s: %s' % (i.filename, _hit))
    if _checked < 10:
        _v42b = False
        _detail42b.append('只扫到 %d 个网页文件（包结构不对？）' % _checked)
    check('28. 包内网页脚本（剥注释后）不再引用随包脚本那一套（文件删了、调用点也要删）',
          _v42b, '；'.join(_detail42b) or '扫了 %d 个文件、零引用' % _checked)

    # --- v1.9.38：节次字段兜底 + 原始记录字段快照 ---
    #     29. 用户补报「课表是 1-2 节的，导入只有第 2 节」。链路每环单测都验过是
    #         对的 ⇒ 教务给的**不是** "1-2" 这种标准写法。于是两头补：①脚本侧节次
    #         按 jcs→jcor→jc **保守**兜底（只在 jcs 只给单节、同一条记录的另一
    #         字段给出**包含**它的更大范围时才采用，不包含绝不动）；②第一条原始
    #         记录的**全部字段**回传，预览里亮出来。
    #         这两条都属于「源码改对了、资产没同步或没编进包也照样不报错」的那类，
    #         所以必须在**编译后**的包里点名，而不是在源码里查。
    #         v1.9.42：①那一半随本校自研脚本一起退场（脚本换成上游那只通用脚本，
    #         节次兜底由它自己负责）；这一条只点名**宿主侧**还能收到诊断字段。
    _v38, _detail38 = True, []
    _ad_txt = mod_bytes.get('js/adapter-import.js', b'').decode('utf-8', 'replace')
    for token in ('教务原始记录样本', '不在标准的 jcs 字段里'):
        if token not in _ad_txt:
            _v38 = False
            _detail38.append('adapter-import 缺 %s' % token)
    if b'adapterSample' not in blob:
        _v38 = False
        _detail38.append('dex 里没有 adapterSample 字段（原生侧透传没编进去）')
    check('29. v1.9.38 原始记录字段快照的**宿主侧**仍在包里（网页文案 + dex 透传字段）',
          _v38, '；'.join(_detail38) or '网页 + dex 两处齐全')

    # ------------------------------------------------------------
    # 30. v1.9.39：导入课程的 id 收口在 Store
    #     「点卡片没反应」的根因是导入的课**没有 id** —— 解析层一律给
    #     `id: null`（adapter-import.js 的注释早就写着「由 Store 侧补」），
    #     而 Store 侧一直没人补，于是卡片 data-id 为空、findCourse 永远
    #     匹配不上：不报错、不卡死，就是点了没反应。
    #     两处入口各补一次：commitImport（新导入当场补）+
    #     normalizeSchedule / readLegacy（载入兜底，老数据自愈）。
    #     同 29 号的理由 —— 必须在**编译后**的包里点名。
    _v39, _detail39 = True, []
    _app39 = zf.read('assets/web/js/app.js').decode('utf-8', 'replace') \
        if 'assets/web/js/app.js' in names else ''
    if 'c.id = Store.uid()' not in _app39:
        _v39 = False
        _detail39.append('包内 app.js 没有 commitImport 的补 id')
    _sto39 = zf.read('assets/web/js/store.js').decode('utf-8', 'replace') \
        if 'assets/web/js/store.js' in names else ''
    if 'function ensureCourseIds' not in _sto39 or _sto39.count('ensureCourseIds(') < 3:
        _v39 = False
        _detail39.append('包内 store.js 缺 ensureCourseIds，或兜底入口不足 3 处')
    if 'id: null' not in _ad_txt:
        _v39 = False
        _detail39.append('adapter-import 不再给 id: null（解析层口径变了？）')
    check('30. v1.9.39 导入课程 id 的收口在 Store（commitImport 补 + 载入兜底真的进了包）',
          _v39, '；'.join(_detail39) or '网页三处齐全')

    # ------------------------------------------------------------
    # 31. v1.9.40：适配库分发源从两条扩到四条
    #     白名单只有一份事实源（web/js/warehouse.js 的 SOURCES），Kotlin 侧那张
    #     WAREHOUSE_PREFIXES 是它的镜像。24 号只证明「四个前缀在 dex 里」，
    #     这一条把**包内网页侧**也拉进来对：源码改了一边、assets 忘了同步、
    #     或者只改了源码没重新打包 —— 三种都会让两侧的域名集合对不上。
    #     ⚠️ 顺序（Gitee 第一）故意不在本脚本钉：dex 字符串池的排列顺序不是
    #        编译期的列表顺序，拿字节偏移当顺序断言等于拿启发式当断言。
    #         顺序由 tools/smoke-test.js 在源码层逐条比对（那边能真的 require 到
    #         WH.SOURCES），两边各管一段。
    _v40, _detail40 = True, []
    _whjs_rel = 'assets/web/js/warehouse.js'
    _whjs = mod_bytes.get('js/warehouse.js', b'').decode('utf-8', 'replace')
    if not _whjs:
        _v40 = False
        _detail40.append('包内没有 %s' % _whjs_rel)
    else:
        n_idx = len(re.findall(r'indexUrl:', _whjs))
        n_scr = len(re.findall(r'scriptBase:', _whjs))
        if n_idx != 4 or n_scr != 4:
            _v40 = False
            _detail40.append('包内 warehouse.js 的源表是 %d 条索引 / %d 条脚本（应 4 / 4）' % (n_idx, n_scr))
        for pfx in EXPECT_WAREHOUSE_HOSTS:
            if pfx.encode('ascii') not in blob:
                _v40 = False
                _detail40.append('dex 缺 %s' % pfx)
            host = pfx.split('/')[2]
            if host not in _whjs:
                _v40 = False
                _detail40.append('包内 warehouse.js 缺主机 %s（源码与资产不同步？）' % host)
        # v1.9.42：本地脚本的取用面（folder==='local' 那条支路）整条拆掉 ——
        # 同一个文件在 v1.9.41 这一条是**正**查，现在翻成**反**查。
        # ⚠️ 必须先剥注释：文件头那段沿革注释里还写着这两个名字。
        for token in ('localSourceOf', 'isLocalScript'):
            if token in strip_comments(_whjs):
                _v40 = False
                _detail40.append('包内 warehouse.js 仍有 %s（本地脚本取用口没拆干净）' % token)
    check('31. v1.9.40/v1.9.42 四个分发前缀两侧对齐、源表 4 条、本地脚本取用口已拆',
          _v40, '；'.join(_detail40) or '四个前缀两侧齐全、源表 4 条、取用口已拆')

    # ------------------------------------------------------------
    # 33. v1.9.42：`openWithAdapter` 在编译后的 dex 里必须是 EXPECT_BRIDGE_ARG_COUNT
    #     个参数。
    #     Java 桥按「方法名 + 参数个数」反射：网页侧多传一个实参、原生侧少声明
    #     一个参数，结果是**静默失配** —— 点了没反应，连日志里一个错都没有
    #     （正因为如此，它不可能被任何一层单测抓到：两端各自都是合法的）。
    #     分工：网页侧那句调用由 tools/smoke-test.js 在**源码层**数实参；
    #     包内 app.js 与 web/js/app.js 的**逐字节一致**由 10 号保证 ⇒ 源码层的
    #     结论原样搬进包。原生侧这一半只能在**编译后**的 dex 里看 —— 所以这里
    #     借 build-tools 的 dexdump 把方法原型取出来数参数（dex 的 proto 里存着
    #     真实参数表，比在 Kotlin 源码上数逗号硬得多）。
    #     ⚠️ 旧包（v1.9.41）里这个方法**是 6 个参数**，所以这一条退回旧包必红。
    _v42c, _detail42c = True, []
    _sig42 = dex_method_type(zf, dexs, 'openWithAdapter')
    if _sig42 is None:
        _v42c = False
        _detail42c.append('dexdump 里找不到 openWithAdapter 的方法原型（符号没了？）')
    else:
        _n_arg42 = dex_arg_count(_sig42)
        if _n_arg42 != EXPECT_BRIDGE_ARG_COUNT:
            _v42c = False
            _detail42c.append('原生侧声明 %d 个参数（应 %d）：%s'
                              % (_n_arg42, EXPECT_BRIDGE_ARG_COUNT, _sig42))
    check('33. v1.9.42 桥方法 openWithAdapter 在 dex 里是 %d 个参数（两端不同步＝静默失配）'
          % EXPECT_BRIDGE_ARG_COUNT,
          _v42c, '；'.join(_detail42c) or '原型 %s ⇒ %d 个参数' % (_sig42, dex_arg_count(_sig42)))

    # ============================================================
    # v1.9.43：内嵌教务浏览器里只剩一条导入通道（适配脚本）。
    #
    # ⚠️⚠️ 下面 34~38 号**全是反向断言**（「某个东西不再存在」），
    #      这是最容易永远绿的一类。交付前**必须**拿 v1.9.42 的旧包回跑：
    #        python tools/verify-apk-1943.py dist/柚课-v1.9.42.apk
    #      旧包里这几条要条条见红。没红过＝没有断言。
    #      另外 3 号（版本号）本来就会红，那是预期，不算数。
    # ============================================================

    #     34. dex 里不许再有自研抓页那一整套。
    #         Kotlin 侧的桥名 / 内部类 / 常量名会进字符串池。注释进不了 dex，
    #         所以墓碑注释里出现的那些名字**不会**把这一条喂红。
    _v43, _detail43 = True, []
    _grab_left = [s for s in EXPECT_GRAB_PAGE_ABSENT if s.encode('ascii') in blob]
    if _grab_left:
        _v43 = False
        _detail43.append('dex 里仍有: %s' % _grab_left)
    _cb_left = [s for s in EXPECT_EDU_CALLBACKS_ABSENT if s.encode('ascii') in blob]
    if _cb_left:
        _v43 = False
        _detail43.append('dex 里仍有回传入口名: %s' % _cb_left)
    check('34. v1.9.43 自研抓页那一整套全不在 dex 里（桥 / 门闩 / 注入 JS / 预检 / 落盘 / 显示开关）',
          _v43, '；'.join(_detail43) or '共查 %d 个名字，一个都不剩'
          % (len(EXPECT_GRAB_PAGE_ABSENT) + len(EXPECT_EDU_CALLBACKS_ABSENT)))

    #     35. 兜底哨兵：23 号那条「适配脚本宿主还在」必须仍然绿 ——
    #         拆掉的是**另一条通道**，不是把两条都拆了。
    #         （反向断言扎堆的地方，最怕的就是「全拆了也算过」。）
    _still_ad = [s for s in EXPECT_ADAPTER_SYMBOLS if s.encode('ascii') not in blob]
    check('35. 适配脚本那条通道没被误伤（%d 个宿主 / 桥方法符号仍在 dex 里）'
          % len(EXPECT_ADAPTER_SYMBOLS),
          len(_still_ad) == 0, ('缺失: %s' % _still_ad) if _still_ad else '全部命中')

    #     36. 包内 app.js（剥注释后）不再导出 `onEduHtml` / `importHtml`。
    #         与 28 号同一个理由：文件里留着「v1.9.43 删掉了 onEduHtml」这种
    #         沿革注释，不剥注释就会永远绿（名字只在注释里）。
    #         ⚠️ `Import.parseHtml` **没删也不该删** —— 它服务的是「教务导出的
    #            .html 文件」那条路；这里只查那两个**抓页回灌**侧的入口名。
    _v43b, _detail43b = True, []
    _app43 = zf.read('assets/web/js/app.js').decode('utf-8', 'replace') \
        if 'assets/web/js/app.js' in names else ''
    if not _app43:
        _v43b = False
        _detail43b.append('包里找不到 assets/web/js/app.js')
    else:
        _app43nc = strip_comments(_app43)
        for tok in ('onEduHtml', 'importHtml'):
            if tok in _app43nc:
                _v43b = False
                _detail43b.append('剥注释后 app.js 仍引用 %s' % tok)
        # 正面那一半：剩下两条路的入口**必须还在**（别把三条一起删了）
        for tok in ('onEduBuffer', 'onEduAdapter'):
            if tok not in _app43nc:
                _v43b = False
                _detail43b.append('app.js 缺回传入口 %s（拆过头了？）' % tok)
    check('36. v1.9.43 包内 app.js 只剩两条回传入口（onEduBuffer / onEduAdapter）',
          _v43b, '；'.join(_detail43b) or '两个旧入口已拆、两条正路都在')

    #     37. file_paths.xml 只剩 cacheDir/share/ 一条。
    #         release 开了资源收缩 ⇒ 路径会被改名（res/8K.xml），必须按**资源名**
    #         反查（与 13 号同一套），拿到的是**编译后的**那份内容。
    #         判据两条：①`share/` 那条在；②`dumps` / `external-files-path` 都不在。
    #         ⚠️ 读的是**编译产物**、不是源码文件 ⇒ 源码里注释写成什么样都不影响。
    _v43c, _detail43c = True, []
    if fp_path and fp_path in names:
        _fp_txt = zf.read(fp_path).decode('utf-8', 'replace')
        if 'cache-path' not in _fp_txt or 'share/' not in _fp_txt:
            _v43c = False
            _detail43c.append('编译后的 file_paths 里没有 cache-path share/ 那条')
        for tok in ('dumps', 'external-files-path', 'external-path', 'root-path'):
            if tok in _fp_txt:
                _v43c = False
                _detail43c.append('编译后的 file_paths 里仍有 %s' % tok)
    else:
        _v43c = False
        _detail43c.append('定位不到编译后的 file_paths（13 号已红时这里必红）')
    check('37. v1.9.43 FileProvider 白名单只剩 cacheDir/share/（dumps 那条随抓页一起删）',
          _v43c, '；'.join(_detail43c) or '只剩 share/ 一条，且未放开整个存储')

    #     38. 资源表里不许再有底栏那三个按钮的 id。
    #         底栏整栏删了，「适应屏幕 / 怎么用 / 导入课表」三个按钮的 `@+id`
    #         与三处接线都该消失 —— 只删 layout 里的节点、忘了删 Kotlin 里的
    #         `findViewById(R.id.btnEduGrab)`，编译**照样过**（R.id 还在），
    #         只有对成品包做静态核验、数一遍资源表才看得见。
    _v43d, _detail43d = True, []
    _ids_left = [i for i in EXPECT_EDU_BOTTOM_IDS_ABSENT if i in resdump]
    if _ids_left:
        _v43d = False
        _detail43d.append('资源表里仍有 id: %s' % _ids_left)
    check('38. v1.9.43 底栏「适应屏幕 / 怎么用 / 导入课表」三个 id 已从资源表消失',
          _v43d, '；'.join(_detail43d) or '三个 id 都不在')

    #     39. 【v1.9.44 唯一改动】两个小组件 receiver 的 exported 必须是 true。
    #         成因：桌面（com.miui.home 等）是**另一个应用**，它按 ComponentName
    #         枚举组件、再发绑定 / 更新广播；部分定制 ROM 在「枚举选择列表」这一步
    #         会按 exported 过滤 ⇒「长按桌面 → 小部件」里根本看不到柚课。
    #         判据两半：①两个 appwidget receiver 的 exported 都是 true；
    #                   ②编译后的清单里**不许再有** exported=false 的 receiver。
    #         ⚠️ 布尔属性在 xmltree 里是**裸值** `=true` / `=false`（实测），
    #            不是 `(type 0x12)0xffffffff`。两种都收，换 build-tools 不假红。
    #         ⚠️ receiver 的**自身属性**要按元素切段取（子元素从 `E:` 开始），
    #            否则往下搜 900 个字会串到相邻 receiver 的属性上 ⇒ 假绿。
    #         ⚠️ 必须读**编译产物**：源码改对了，中间还夹着 manifest merger。
    #         ⚠️ 退回 v1.9.43 旧包必须见红（旧包里两个都是 false）——没红过＝没有断言。
    _TRUE_RE = r'exported\(0x[0-9a-f]+\)=(?:true|\(type 0x12\)0xffffffff)(?:\n|$)'
    _FALSE_RE = r'exported\(0x[0-9a-f]+\)=(?:false|\(type 0x12\)0x0)(?:\n|$)'
    _recv_blocks = re.findall(r'E: receiver[^\n]*\n((?:[ \t]+A:[^\n]*\n)*)', xtree)
    _w_recv = [b for b in _recv_blocks
               if 'WidgetTodayProvider' in b or 'WidgetTwoDayProvider' in b]
    _v44, _detail44 = True, []
    if len(_w_recv) != 2:
        _v44 = False
        _detail44.append('小组件 receiver 只找到 %d 个（应为 2）' % len(_w_recv))
    for _b in _w_recv:
        _nm = re.search(r'name\(0x[0-9a-f]+\)="([^"]*)"', _b)
        _short = _nm.group(1).rsplit('.', 1)[-1] if _nm else '(读不到类名)'
        if re.search(_TRUE_RE, _b):
            continue
        _v44 = False
        if re.search(_FALSE_RE, _b):
            _detail44.append('%s 的 exported 仍是 false' % _short)
        else:
            _detail44.append('%s 上读不到 exported 属性（格式变了？）' % _short)
    _false_recv = []
    for _b in _recv_blocks:
        if re.search(_FALSE_RE, _b):
            _nm = re.search(r'name\(0x[0-9a-f]+\)="([^"]*)"', _b)
            _false_recv.append(_nm.group(1) if _nm else '(读不到类名)')
    if _false_recv:
        _v44 = False
        _detail44.append('清单里仍有 exported=false 的 receiver：%s' % _false_recv)
    check('39. v1.9.44 两个小组件 receiver 的 exported 都是 true（且清单里没有 false 的 receiver）',
          _v44, '；'.join(_detail44) or '两个都是 true，无 false')

    #     40. 【v1.9.45】转义函数只剩一份实现（在 store.js），app.js / picker.js 只转发。
    #         判据两半：①store.js 的 esc 实现含全部 5 个实体字面量；
    #                   ②另两个文件都含转发行、且都不再出现任何实体字面量。
    #         为什么要在**包里**再查一遍（冒烟已经查过源码）：这一条最典型的失效方式
    #         不是「有人写错」，而是「**sync-assets 没跑**」—— 源码改对了，
    #         装进 APK 的 assets/web 还是旧页面，而课表页看起来一切正常。
    #         ⚠️ 必须先剥注释：沿革注释里就是拿 `&amp;` 这些字样在讲「为什么收口」，
    #            不剥就会被自己写的解释绊红（同一个坑本仓库踩过两次）。
    _v45a, _detail45a = True, []
    _v45_files = {}
    for _p in ('assets/web/js/store.js', 'assets/web/js/app.js', 'assets/web/js/picker.js'):
        if _p not in names:
            _v45a = False
            _detail45a.append('包里缺 %s' % _p)
            continue
        _v45_files[_p] = strip_comments(zf.read(_p).decode('utf-8', 'replace'))
    _store45 = _v45_files.get('assets/web/js/store.js', '')
    _m_esc = re.search(r'function esc\s*\(\s*s\s*\)\s*\{([\s\S]*?)\n\s*\}', _store45)
    _esc_body = _m_esc.group(1) if _m_esc else ''
    if not _esc_body:
        _v45a = False
        _detail45a.append('store.js 里切不出 esc 的实现体（哨兵：切不出来下面这条会假绿）')
    for _e in ('&amp;', '&lt;', '&gt;', '&quot;', '&#39;'):
        if _e not in _esc_body:
            _v45a = False
            _detail45a.append('store.js 的 esc 实现里没有 %s' % _e)
    _fwd45 = r'function esc\s*\(\s*s\s*\)\s*\{\s*return Store\.esc\(s\);\s*\}'
    for _p in ('assets/web/js/app.js', 'assets/web/js/picker.js'):
        _nc = _v45_files.get(_p, '')
        if not re.search(_fwd45, _nc):
            _v45a = False
            _detail45a.append('%s 里没有「转发给 Store.esc」那一行' % _p)
        if '&amp;' in _nc:
            _v45a = False
            _detail45a.append('%s 里又出现实体字面量（第二份实现长回来了）' % _p)
    check('40. v1.9.45 包内转义函数只有一份实现（store.js），app.js / picker.js 只转发',
          _v45a, '；'.join(_detail45a) or '一份实现、两处转发、无第二份')

    #     41. 【v1.9.45】整页无障碍三件（读的是**打包后**的 index.html）：
    #         ① viewport 不许再有 user-scalable=no / maximum-scale（禁缩放）；
    #         ② #toast 是常驻节点且带 role="status" + aria-live="polite"；
    #         ③ label 的 for 都指向真实存在的 id。
    #         ⚠️ HTML 注释要**单独剥**（`<!-- ... -->`）：本仓库 index.html 里就有一整段
    #            注释在讲「v1.9.45 起不再禁缩放」，不剥会被自己写的解释绊红。
    #            （strip_comments 是 JS 口径，剥不掉 HTML 注释 —— 别指望它。）
    #         ⚠️ ③ 是从包内 HTML **现场算**出来的，不写死名单：写死名单一定会漏。
    #         ⚠️ 那条 `for= 少于 10 处` 是**假绿守门员** —— 切错段时 ①③ 会双双通过。
    _v45b, _detail45b = True, []
    _for45 = []
    _idx45 = zf.read('assets/web/index.html').decode('utf-8', 'replace') \
        if 'assets/web/index.html' in names else ''
    if not _idx45:
        _v45b = False
        _detail45b.append('包里找不到 assets/web/index.html')
    else:
        _idx45nc = re.sub(r'<!--[\s\S]*?-->', '', _idx45)
        if re.search(r'user-scalable\s*=\s*no', _idx45nc) or 'maximum-scale' in _idx45nc:
            _v45b = False
            _detail45b.append('viewport 又把缩放禁回去了')
        if not re.search(r'<div[^>]*id="toast"[^>]*role="status"[^>]*aria-live="polite"[^>]*>',
                         _idx45nc):
            _v45b = False
            _detail45b.append('toast 缺 role="status" / aria-live="polite"（或不再是常驻节点）')
        _ids45 = set(re.findall(r'\bid="([^"]+)"', _idx45nc))
        _for45 = re.findall(r'\bfor="([^"]+)"', _idx45nc)
        if len(_for45) < 10:
            _v45b = False
            _detail45b.append('只找到 %d 处 for=（切错段了？这一段不查会假绿）' % len(_for45))
        _dangling45 = sorted(set(x for x in _for45 if x not in _ids45))
        if _dangling45:
            _v45b = False
            _detail45b.append('悬空的 for（指向不存在的 id）：%s' % _dangling45)
    check('41. v1.9.45 包内 index.html：放开缩放 / toast 是常驻 live region / 无悬空 for',
          _v45b, '；'.join(_detail45b) or ('三项都对，for= %d 处、无一悬空' % len(_for45)))

    #     42. 【v1.9.45】csv.js 的 parseDay 必须是「前缀可省 + 整串锚定」的形状。
    #         不锚定的话 `13:00` 会在中间匹配到 `1` 被判成「周一」—— 把「列错位」
    #         这种数据问题悄悄变成「导入成周一」，用户看不出来。
    #         判据比的是**这条正则字面量的首尾**（^ / $），不是抄一遍整条正则：
    #         抄一遍的话，将来只想改星期映射表也会假红。
    #         ⚠️ 切不出正则字面量要单独报错 —— 切出来是空串时下面两条会双双「通过」。
    _v45c, _detail45c = True, []
    _csv45 = strip_comments(zf.read('assets/web/js/csv.js').decode('utf-8', 'replace')) \
        if 'assets/web/js/csv.js' in names else ''
    if not _csv45:
        _v45c = False
        _detail45c.append('包里找不到 assets/web/js/csv.js')
    else:
        _m_pd = re.search(r'var m = /([^/\n]+)/\.exec\(s\)', _csv45)
        _pd_re = _m_pd.group(1) if _m_pd else ''
        if not _pd_re:
            _v45c = False
            _detail45c.append('切不出 parseDay 的正则字面量（哨兵：下面两条会假绿）')
        elif not (_pd_re.startswith('^') and _pd_re.endswith('$')):
            _v45c = False
            _detail45c.append('parseDay 的正则没锚死两头：/%s/' % _pd_re)
        elif '星期' not in _pd_re:
            _v45c = False
            _detail45c.append('parseDay 的正则不认识「星期」前缀了：/%s/' % _pd_re)
    check('42. v1.9.45 包内 csv.js 的 parseDay 整串锚定（13:00 不会再被当成周一）',
          _v45c, '；'.join(_detail45c) or '前缀可省、两头锚死')

    #     43. 【v1.9.45】全量备份 / 恢复这套 API 必须在包里（v1.9.45 新增的能力）。
    #         少了任何一个名字，「导出全部数据 / 从备份恢复」在真机上就是
    #         **按了没反应、也不报错**（网页侧调用不存在的函数会当场抛，
    #         但被 toast 兜住看起来「就是没成功」）。
    #         判据比「三只函数名 + 自家标记」两半；`youke-backup` 是恢复端
    #         唯一敢落地的依据，缺了它备份就是一堆不敢认的 JSON。
    _v45d, _detail45d = True, []
    for _tok in ('exportAll', 'parseBackup', 'importAll', 'youke-backup'):
        if _tok not in _store45:
            _v45d = False
            _detail45d.append('store.js 缺 %s' % _tok)
    check('43. v1.9.45 全量备份 / 恢复的 API 与自家标记都在包里',
          _v45d, '；'.join(_detail45d) or 'exportAll / parseBackup / importAll / youke-backup 都在')

    #     44. 【v1.9.46】导入面板折叠件的**三件套**（HTML / CSS / JS 各占一半）。
    #         这一版只动了界面，但三处任一漏进包都**不会报错**：
    #           少了 HTML 的 hidden       ⇒ 一打开就是展开的（等于这一版没做）；
    #           少了 CSS 的旋转           ⇒ 箭头永远朝下，看不出开着还是收着；
    #           少了 JS 那次 bindFolds()  ⇒ 按钮长得对、点着没反应。
    #         ⚠️ 三条都从**包内**文件现场算。先验 `fold-t` 的条数：
    #            数量为 0 时下面几条正则会**在空串上通过**（同一个坑踩过多次）。
    _v46, _detail46 = True, []
    _idx46 = zf.read('assets/web/index.html').decode('utf-8', 'replace') \
        if 'assets/web/index.html' in names else ''
    _css46 = strip_comments(zf.read('assets/web/css/app.css').decode('utf-8', 'replace')) \
        if 'assets/web/css/app.css' in names else ''
    _js46 = strip_comments(zf.read('assets/web/js/app.js').decode('utf-8', 'replace')) \
        if 'assets/web/js/app.js' in names else ''
    if not (_idx46 and _css46 and _js46):
        _v46 = False
        _detail46.append('包里缺 index.html / css/app.css / js/app.js 之一')
    else:
        _idx46nc = re.sub(r'<!--[\s\S]*?-->', '', _idx46)
        _n46 = len(re.findall(r'class="fold-t"', _idx46nc))
        if _n46 != 2:
            _v46 = False
            _detail46.append('折叠开关 %d 个（应为 2；为 0 时下面几条会假绿）' % _n46)
        _ids46 = set(re.findall(r'\bid="([^"]+)"', _idx46nc))
        for _b in ('foldEduBody', 'foldFileBody'):
            if ('aria-controls="%s"' % _b) not in _idx46nc:
                _v46 = False
                _detail46.append('没有指向 %s 的开关' % _b)
            if _b not in _ids46:
                _v46 = False
                _detail46.append('折叠体 %s 不存在（开关悬空 ⇒ 点了没反应）' % _b)
            elif not re.search(r'class="hint fold-b" id="%s" hidden\s*>' % _b, _idx46nc):
                _v46 = False
                _detail46.append('%s 不是默认收起（缺 hidden）' % _b)
        if len(re.findall(r'data-label-open="收起"', _idx46nc)) != 2:
            _v46 = False
            _detail46.append('两套文案没跟上（data-label-open="收起" 不是 2 处）')
        if not (re.search(r'\.fold-t\[aria-expanded="true"\]\s+\.chev\s*\{[^}]*rotate\(-45deg\)', _css46)
                and re.search(r'\.fold-t\s+\.chev\s*\{[^}]*rotate\(135deg\)', _css46)):
            _v46 = False
            _detail46.append('app.css 里箭头不跟 aria-expanded 转')
        if 'bindFolds' not in _js46:
            _v46 = False
            _detail46.append('app.js 里没有 bindFolds')
        elif not re.search(r'\n\s+bindFolds\(\);', _js46):
            _v46 = False
            _detail46.append('bindFolds 有定义但没被 bind() 调用（点了没反应）')
        elif not (re.search(r"setAttribute\('aria-expanded'", _js46) and re.search(r'\.hidden\s*=', _js46)):
            _v46 = False
            _detail46.append('折叠没同时写 aria-expanded 与 .hidden（半截状态）')
    check('44. v1.9.46 包内折叠件三件套齐（开关 / 默认收起 / 箭头跟状态 / 点击已接线）',
          _v46, '；'.join(_detail46) or 'HTML 两个开关且默认收起；CSS 箭头跟状态；JS 已接线')

    return finish()


def finish():
    print('\n== 汇总 ==')
    ok = sum(1 for _n, o, _d in results if o)
    bad = [n for n, o, _d in results if not o]
    print('通过 %d / %d' % (ok, len(results)))
    if bad:
        print('未通过:')
        for n in bad:
            print('  - ' + n)
        sys.exit(1)
    print('全部通过 ✔')


if __name__ == '__main__':
    main()
