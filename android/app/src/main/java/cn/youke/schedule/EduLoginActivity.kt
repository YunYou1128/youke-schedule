package cn.youke.schedule

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ConsoleMessage
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.content.res.ResourcesCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder
import java.util.UUID
import kotlin.concurrent.thread

/**
 * 内嵌教务浏览器 —— 用户在应用内自己登录教务系统，翻到课表页，跑适配脚本把课表取回来。
 *
 * 为什么用「真浏览器 + 用户手动登录」而不是模拟登录：
 *  - 现在多数教务（正方 jwglxt 等）登录要验证码 + RSA 加密 + token，
 *    模拟登录既脆弱又要替用户保管密码，安全和维护成本都不划算；
 *  - 用户本来就要用自己的账号登录，页面长什么样他最清楚；
 *  - App 只做两件事：把页面搬进来给他看，让适配脚本在页面上取数。
 *
 * **v1.9.43 起只剩一条导入通道**（适配脚本 §setupAdapter）。
 * 原来的「自研抓页」那条 —— 注入 JS 递归穿透 iframe 取整页 HTML、经
 * `@JavascriptInterface` 回传、交给网页侧 `edugrab.js` 认课表 —— **整条拆掉了**，
 * 连它底栏那颗按钮一起。留档：`留档/课表导入-自研抓页-v1.9.43/`。
 *
 * 还有一条**不是**通道、但一直留着：教务系统自己的「导出 / 下载课表」按钮
 * （见 [startDownload]）。拦截下来、把字节交给网页侧嗅探解析 ——
 * 没有适配脚本的学校走这条，所以它的提示文案里到处都是「导出课表」而不是
 * 已经不存在的那颗按钮。
 *
 * 与主界面之间通过同进程的 [EduBus] 传结果：文件动辄几 MB，
 * 走 Intent extra 会撞上 Binder 事务上限（约 1 MB），同进程直接传引用最省事。
 */
class EduLoginActivity : ComponentActivity() {

    private lateinit var root: LinearLayout
    private lateinit var toolbar: LinearLayout

    /** 底栏容器（v1.9.43 起里面只装「执行导入」那一栏，容器本身常驻，负责让出导航栏） */
    private lateinit var bottomBar: LinearLayout
    private lateinit var urlBar: EditText
    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var tipBar: LinearLayout
    private lateinit var tipText: TextView
    private lateinit var adapterBar: LinearLayout
    private lateinit var adapterText: TextView
    private lateinit var btnAdapterRun: TextView
    private lateinit var btnAdapterStop: TextView

    /* v1.9.43 删掉了 `fitWidth`（「适应屏幕 / 原始大小」那个开关）。
       页面显示方式现在**固定在「适应屏幕」这一档**：整页缩放到屏宽、
       内容不会被横向切掉 —— 这是两档里更保守的一档（另一档会把整页按 PC
       原尺寸铺开，默认状态下用户一进来只看到左上角一块）。
       要放大看细节仍走顶栏的 ＋ / －（`webView.zoomIn/zoomOut`）。
       那个开关顺带还拖着一条常量 `KEY_FIT_WIDTH` 与一份写入偏好，一并删了。 */

    /** 同一时间只允许一个下载任务，避免用户连点触发多次导入 */
    private var downloading = false

    /** onCreateWindow 用的隐藏 WebView（承接 window.open 的页面） */
    private var popup: WebView? = null

    /** 正在询问信任的域名；null = 当前没有待答的询问（见 askSslTrust） */
    private var sslAskHost: String? = null

    /** 排队等同一个答复的 SSL 处理器 —— 一页里多个资源会同时失败 */
    private val sslPending = ArrayList<SslErrorHandler>()

    /** 「证书域名不符」的提示一页只弹一次（多个资源会连着触发） */
    private var sslBlockedNotified = false

    /* ============================================================
       社区适配库：这一趟「跑上游适配脚本」的状态（v1.9.32）
       ------------------------------------------------------------
       v1.9.32~v1.9.42 它与「自研抓页」是**两条互斥的通道**，各自拿一个门闩，
       互相把对方关掉。v1.9.43 自研那条整条拆掉之后，**只剩这一条**，
       [adapterToken] 是页面上唯一的那把门闩。
       ============================================================ */

    /** 选中的学校 / 适配器 / 维护者。界面上要写明「在跑谁的脚本」——这是上游的署名要求 */
    private var adapterSchool = ""
    private var adapterName = ""
    private var adapterMaintainer = ""

    /** 适配脚本的下载地址，**按顺序试**（CDN 与回源互为备份，与索引同一套地址） */
    private val adapterScriptUrls = ArrayList<String>()

    /* v1.9.41 曾在这里放一个 `adapterScriptSource`（本校脚本的正文，随 Intent 递进来）。
       v1.9.42 拆掉了这一路：包内不再有脚本，取脚本**只有联网一条路**。 */

    /** 这一趟取到的脚本文本，换页后要重新注入（见 maybeReinjectAdapter） */
    private var adapterLastScript: String? = null

    /**
     * 适配脚本这一趟的门闩。非空 = 正在跑。
     *
     * 语义是「整趟有效」—— 一趟里要弹好几次窗、存好几次数据，
     * 所以**只比对、不消费**（见 AdapterHost.host）。
     *
     * v1.9.42 及以前这里还要跟自研抓页那个 `armedToken` 讲清楚区别：
     * 那个是「一次性认领」，认领完就关门、同一趟只认第一个回调。
     * v1.9.43 自研那条拆掉，页面上**只剩这一把门闩**，
     * 「一趟一个令牌」这条纪律连同它的理由都挪到 [adapterToken] 一处了。
     *
     * ⚠️ 仍然是**令牌**不是布尔量：`runAdapter` 到注入脚本真正执行，隔着一次
     * `evaluateJavascript` 的 IPC 往返；这段时间里页面脚本与注入脚本共享同一个
     * JS 上下文，布尔量的「先到先得」挡不住页面脚本抢跑（后果：正常一趟静默失败，
     * 或者伪造页抢先往里灌数据）。UUID 页面脚本猜不到，抢先调用只会被拒。
     */
    @Volatile
    private var adapterToken: String? = null

    /** 文档序号：每次 onPageStarted 加一。换页后要重新注入脚本，靠它判断「换页了」 */
    private var eduPageSeq = 1

    /** 本趟最后一次注入发生在哪个文档 —— 同一个文档不重复注入 */
    private var adapterInjectedAt = -1

    /**
     * 适配脚本攒下来的数据。
     *
     * 课程**累加**、作息与学期配置**后到的覆盖** —— 这不是随手定的，是按上游
     * 255 个脚本的真实调用形状定的（见 saveCourses / saveTimes 的注释）。
     */
    private var adapterCourses = ArrayList<String>()   // 每门课一个 JSON 对象串
    private var adapterTimes: String? = null           // 作息表：整份覆盖
    private var adapterConfig: String? = null          // 学期设置：整份覆盖
    private var adapterDropped: String? = null         // 跳过行样本（v1.9.37，诊断用）
    private var adapterSample: String? = null          // 原始记录字段全貌（v1.9.38，诊断用）
    private var adapterSaves = 0

    /** 最近一条页面 console 的 error，失败提示里带一句，省得只能靠猜 */
    private var adapterConsoleError = ""

    /** toast 节流：适配脚本会成串发提示，同一条 600ms 内只弹一次 */
    private var lastToastKey: String? = null
    private var lastToastAt = 0L

    /* v1.9.43 删掉了自研抓页的门闩 `armedToken`、它的兜底复位 [bridgeTimeout]
       与超时探针 probeGrabDiag()。那一套（v1.9.24「桥常驻 + 一次性令牌」、
       v1.9.29「布尔量换令牌」）解决的是「常驻桥怎么才不算被滥用」——
       现在页面上只剩适配宿主一把门闩（[adapterToken]），这套机制跟着那条通道
       一起退场了。它踩过的坑留在注释里（见 [adapterToken] 与 setupWebView）。 */

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
        }

        setContentView(R.layout.activity_edu)
        root = findViewById(R.id.eduRoot)
        toolbar = findViewById(R.id.eduToolbar)
        bottomBar = findViewById(R.id.eduBottom)
        urlBar = findViewById(R.id.eduUrl)
        webView = findViewById(R.id.eduWebView)
        progress = findViewById(R.id.eduProgress)
        tipBar = findViewById(R.id.eduTip)
        tipText = findViewById(R.id.eduTipText)
        adapterBar = findViewById(R.id.eduAdapterBar)
        adapterText = findViewById(R.id.eduAdapterText)
        btnAdapterRun = findViewById(R.id.btnEduAdapterRun)
        btnAdapterStop = findViewById(R.id.btnEduAdapterStop)

        applyInsets()
        applyStatusBarIcons()
        setupWebView()
        setupActions()
        setupAdapter()

        tipText.text = stepText()

        val given = intent?.getStringExtra(EXTRA_URL)?.takeIf { it.isNotBlank() }
        /* 适配模式下**不许**回退到「上次打开过的地址」。
           上次那个地址很可能是**另一所学校**的 —— 在别人的页面上跑这所学校的
           适配脚本，脚本自己会报「请先登录」之类看不懂的错，用户只会以为坏了。
           这种情况宁可停在起步页让他自己填，也不要替他猜。 */
        val start = given
            ?: (if (adapterScriptUrls.isEmpty()) {
                prefs().getString(KEY_LAST_URL, null)?.takeIf { it.isNotBlank() }
            } else null)
            ?: DEFAULT_URL
        urlBar.setText(start)
        if (start.isNotBlank()) {
            webView.loadUrl(start)
        } else {
            /* **本工程不内置任何学校** ⇒ 没有默认入口。
               不 loadUrl（空地址会白屏），改用起步页把「下一步做什么」讲清楚，
               并把顶栏指导语换成「先填地址」那一套。 */
            tipText.text = stepText(fillUrlFirst = true)
            webView.loadDataWithBaseURL(null, START_PAGE_HTML, "text/html", "utf-8", null)
        }
    }

    /**
     * 顶部那条三步走的文案（v1.9.43 起分两种口径）。
     *
     * 判据是**这所学校有没有适配脚本**，因为「第三步」在两边的做法完全不同，
     * 而这一步恰恰是用户唯一会做错的地方：
     *  · 有脚本 -> 点底下那条的「执行导入」；
     *  · 没有脚本 -> 只能走教务系统自己的「导出 / 下载课表」，下载被拦下来自动导入。
     *    （原来这里写的是「点右下角『导入课表』」——那颗按钮 v1.9.43 已经不存在了。
     *      留着这句话的症状最难查：用户会在页面上找一颗永远不会有的按钮。）
     */
    private fun stepText(fillUrlFirst: Boolean = false): String {
        val head = if (fillUrlFirst) {
            "① 在地址栏填你学校教务系统的网址并回车    ② 自己用学号密码登录    "
        } else {
            "① 用学号密码登录    ② 到「信息查询 → 学生个人课表」并选好学期    "
        }
        return head + if (adapterScriptUrls.isEmpty()) {
            "③ 这所学校没有适配脚本，请点课表页的「导出 / 下载课表」，下载完会自动导入"
        } else {
            "③ 点下面那条的「执行导入」"
        }
    }

    /* ============================================================
       系统栏让位（Android 15+ 强制 edge-to-edge，必须自己加 padding）
       ============================================================ */
    private fun applyInsets() {
        val tl = toolbar.paddingLeft; val tt = toolbar.paddingTop
        val tr = toolbar.paddingRight; val tb = toolbar.paddingBottom
        val bl = bottomBar.paddingLeft; val bt = bottomBar.paddingTop
        val br = bottomBar.paddingRight; val bb = bottomBar.paddingBottom
        val rl = root.paddingLeft; val rt = root.paddingTop
        val rr = root.paddingRight; val rb = root.paddingBottom

        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            // 软键盘：edge-to-edge 之后 Manifest 里的 adjustResize 已经不起作用，
            // 不自己消费 IME insets 的话，键盘会直接盖住教务的账号 / 密码输入框
            // 和底栏那颗「执行导入」——用户根本填不完登录表单。
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            root.setPadding(rl, rt, rr, rb + ime)

            // 顶部 / 底部栏各自的背景色延伸进状态栏、导航栏，视觉连成一体
            toolbar.setPadding(tl, tt + bars.top, tr, tb)
            // 键盘弹起时导航栏本来就被键盘盖住，不用再留一份白。
            //
            // ⚠️ 让位的必须是**容器** bottomBar，不是里面那条 eduAdapterBar：
            // 没有适配脚本时那一栏是 GONE，让它负责的话就没人让位了，
            // 网页内容会钻到系统手势条底下（而且只在「无脚本」的学校出问题，
            // 最容易漏测）。
            bottomBar.setPadding(bl, bt, br, if (ime > 0) bb else bb + bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(root)
    }

    private fun applyStatusBarIcons() {
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        WindowInsetsControllerCompat(window, root).isAppearanceLightStatusBars = !night
    }

    /* ============================================================
       WebView
       ============================================================ */
    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // 教务的学期选择等记在 localStorage
            databaseEnabled = true
            loadsImagesAutomatically = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false       // 自带那对悬浮按钮会挡住页面，用顶栏的
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(true)
            // 教务页面常混用 http/https 资源，不允许混合内容会白屏
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // 教务页面没有深色适配，强制反色会变成一团糟
                forceDark = WebSettings.FORCE_DARK_OFF
            }
        }

        /* 页面显示方式：**恒定一档**（v1.9.43）。
           v1.9.42 及以前这里是 applyPageMode()，跟着底栏那个
           「适应屏幕 / 原始大小」开关走。开关删掉之后，这一档直接写死：
           整页缩放到屏宽（= 原来「适应屏幕」那一档），内容不会被横向切掉；
           顶栏 ＋ / － 负责放大看细节。

           `loadWithOverviewMode = fitWidth` 原来是这么绑的：
             true  -> 整页按内容宽度缩放，保证「看得全」（**现在的固定值**）
             false -> 按页面原尺寸 1:1 渲染，字大、PC 菜单好点，宽了左右滑动
           顺带删掉的还有 applyViewportFix()：它每页加载完注入一次 JS 去改正
           页面自带的 viewport meta（`width=1100` 那种会盖掉 WebView 的设置）。
           那是**给开关用的**——不校正的话「切了档位页面纹丝不动」；
           只有一档就不需要校正了。 */
        webView.settings.apply {
            useWideViewPort = true
            loadWithOverviewMode = true
            userAgentString = UA_DESKTOP
        }

        /* 登录态靠 Cookie 维持，跨站（教务常在子域之间跳）也要带上 ——
           但**只接受同站 Cookie**（v1.9.29 起把第三方 Cookie 关掉）。
           正方自己的 xjxt → jw 跳转是同站（同一注册域下的子域），走的是 first-party Cookie，
           不需要第三方 Cookie；而第三方 Cookie 会把「本站会话」暴露给页面里嵌进来的
           任意第三方资源，和「这台 WebView 能打开任意网址、且允许混合内容 / 明文」叠在一起
           就是一条不必要的组合风险。去掉它不损失任何本次要用的能力。 */
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        /* 页面上唯一的一把桥：社区适配脚本的宿主（v1.9.32）。
           **常驻**挂上，只有 `host(method, token, reqId, args)` **一个**方法，
           方法名用字符串分派 —— Java 桥是按「方法名 + 参数个数」反射找方法的，
           每加一个 @JavascriptInterface 方法就多一个可被任意网页直接调用的入口；
           收成一个之后，要审的只有一处。不是这一趟的 token 一律直接返回
           （见 AdapterHost.host）。

           ⚠️ **常驻的理由是实测出来的，别退回「随用随挂」**（v1.9.22 → v1.9.24 的教训，
           原来写在抓页那座桥的注释里，v1.9.43 那座桥拆了、这条纪律留着）：

             v1.9.22 试过「只在要用的一瞬间挂桥、用完立刻摘」，想拿挂摘时序当安全边界。
             真机上不成立，两条独立的 IPC 都不保序：
             ① `addJavascriptInterface` 与 `evaluateJavascript` 走不同通道 —— 脚本常常
                抢在桥之前执行，`window.<桥名>` 就是 undefined，**静默失败**（用户只看到
                「点了没反应」）；更麻烦的是**页面已经加载完之后再挂桥，未必能补进**
                那个已经跑起来的 JS 上下文 —— 加多久的重试循环都等不到它出现。
             ② `removeJavascriptInterface` 与下一次 `add` 也会乱序 —— 先发的 remove 后到，
                把刚挂上的桥摘掉。
             结论：**挂摘时序本身不可靠，不能拿它当安全边界。**
             正确的做法是桥常驻、但**默认是哑的**：绑一个「一趟一个」的令牌门闩
             （[adapterToken]），进来先比对、不是这一趟的直接返回。效果与「随用随挂」
             相同（只有用户按下「执行导入」那一瞬间桥才是活的），但不依赖任何 IPC 先后。

           ⚠️ 随之而来的两条纪律，改这里之前务必先看：
           ① 桥会一直躺在页面上，所以 AdapterHost 里**不许再加「顺手做点什么」的方法** ——
              每加一个方法就多一个可被任意网页直接调用的原生入口；
              真要多一个能力，加进 `host()` 的字符串分派里（那一处要审的只有一张 when 表）；
           ② **永远不要调 `removeJavascriptInterface`**。一旦调了，一次迟到的 remove
              可能把常驻桥**永久**摘掉，而且不会有任何报错，导入从此彻底失灵。 */
        try {
            webView.addJavascriptInterface(AdapterHost(), ADAPTER_BRIDGE_NAME)
        } catch (e: Exception) { /* 忽略 */ }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val u = request?.url?.toString() ?: return false
                if (u.startsWith("http://") || u.startsWith("https://")) return false
                // 非网页协议（tel: / mailto: 等）交给系统处理，别让 WebView 卡死
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u))); true
                } catch (e: Exception) {
                    true
                }
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                sslBlockedNotified = false   // 换页后「证书域名不符」要重新提示
                // 换页 = 换了一个 JS 上下文。适配脚本那趟**不会**因为跳转作废
                // （它本来就是靠跳转走到目标页的），只记下「换文档了」，
                // 好让 onPageFinished 把脚本重新注入进来（见 maybeReinjectAdapter）。
                eduPageSeq++
                progress.visibility = View.VISIBLE
                if (!url.isNullOrBlank()) urlBar.setText(url)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                progress.visibility = View.INVISIBLE
                if (!url.isNullOrBlank()) {
                    urlBar.setText(url)
                    prefs().edit().putString(KEY_LAST_URL, url).apply()
                }
                // 适配脚本：换页后重新注入（脚本靠跳转走到目标页，见 maybeReinjectAdapter）
                maybeReinjectAdapter()
            }

            /**
             * SSL 错误：**按类型分流，不再一律 proceed()**。
             *
             * 原来那句「课表导入是低敏感场景、页面内不输入支付类信息」说不通：
             * 用户在这一页输入的正是**教务账号和密码**，Cookie 还会长期留着。
             * 更要紧的是 proceed() 放行的不只是「自签 / 过期」，还包括
             * SSL_IDMISMATCH —— 证书里写的域名和实际访问的域名对不上，
             * 那正是**中间人攻击的典型特征**，而不是校园网的常见毛病。
             *
             * 分流原则（见下面的 askSslTrust / warnSslMismatch）：
             *  · 域名不匹配 -> 一律 cancel，连「继续」都不给（这是真正的红线）；
             *  · 自签 / 过期 / 链不完整 -> 弹窗把风险说明白，用户明确点「继续访问」
             *    才放行，并**按域名记住**，同一个域名不再反复问
             *    （教务常在子域之间跳，每次都问会把用户逼疯）。
             */
            override fun onReceivedSslError(
                view: WebView?,
                handler: SslErrorHandler?,
                error: SslError?
            ) {
                val h = handler ?: return
                val host = errorHost(error)
                if (error != null && error.primaryError == SslError.SSL_IDMISMATCH) {
                    h.cancel()
                    warnSslMismatch(host)
                    return
                }
                if (host.isNotBlank() && trustedSslHosts().contains(host)) {
                    h.proceed()          // 这个域名的证书问题，用户已经确认过了
                    return
                }
                askSslTrust(host, h)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility =
                    if (newProgress in 1..99) View.VISIBLE else View.INVISIBLE
            }

            /**
             * 记下页面里最后一条 console error。
             *
             * 适配脚本失败时**最有用的一句话就在这里** —— 脚本常把异常 catch 掉之后
             * 只丢一句 `console.error`，页面上什么都不显示。不记的话，用户看到的就是
             * 「点了执行导入，没反应」，我们手上一条线索都没有。
             * 返回值给 false（继续按系统默认打 logcat），排查时还能在日志里看到全文。
             */
            override fun onConsoleMessage(m: ConsoleMessage?): Boolean {
                if (m != null && adapterToken != null &&
                    m.messageLevel() == ConsoleMessage.MessageLevel.ERROR
                ) {
                    adapterConsoleError = m.message() ?: ""
                }
                return false
            }

            /** 教务的「下载 / 新窗口打开」：不另开 Activity，交给隐藏 WebView 再转回主 WebView */
            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message?
            ): Boolean {
                val msg = resultMsg ?: return false
                return try {
                    val transport = msg.obj as WebView.WebViewTransport
                    transport.webView = popupWebView()
                    msg.sendToTarget()
                    true
                } catch (e: Exception) {
                    false
                }
            }

        override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
            val dlg = showEduDialog(
                "", message ?: "",
                actions = listOf(EduAction("确定") { result?.confirm() }),
                onCancel = { result?.cancel() }
            )
            if (dlg == null) result?.cancel()   // 弹不出来也不能让页面的 alert 悬着
            return true
        }

        override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
            val dlg = showEduDialog(
                "", message ?: "",
                actions = listOf(
                    EduAction("取消") { result?.cancel() },
                    EduAction("确定") { result?.confirm() }
                ),
                onCancel = { result?.cancel() }
            )
            if (dlg == null) result?.cancel()
            return true
        }
        }

        /* 教务系统「导出 / 下载课表」的按钮走这里 */
        webView.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            startDownload(url, userAgent, contentDisposition, mimeType)
        })
    }

    private fun popupWebView(): WebView {
        popup?.let { return it }
        val w = WebView(this)
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        w.settings.userAgentString = webView.settings.userAgentString
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val u = request?.url?.toString() ?: return true
                if (u.startsWith("http")) webView.loadUrl(u) else startDownload(u, null, null, null)
                return true
            }
        }
        w.setDownloadListener(DownloadListener { url, ua, cd, mt, _ ->
            startDownload(url, ua, cd, mt)
        })
        // 只是用来承接 window.open 的目标，给个 1x1 的尺寸即可
        root.addView(w, ViewGroup.LayoutParams(1, 1))
        popup = w
        return w
    }

    /* ============================================================
       交互
       ============================================================ */
    private fun setupActions() {
        findViewById<TextView>(R.id.btnEduBack).setOnClickListener {
            if (webView.canGoBack()) webView.goBack()
            else { setResult(Activity.RESULT_CANCELED); finish() }
        }
        findViewById<TextView>(R.id.btnEduReload).setOnClickListener { webView.reload() }
        findViewById<TextView>(R.id.btnEduTipClose).setOnClickListener {
            tipBar.visibility = View.GONE
        }

        /* v1.9.43 从这里删掉了三处接线：
             · btnEduHelp —— 「怎么用」弹窗 + 长按「把当前页面存下来分享」
             · btnEduGrab —— 「导入课表」（短按预检 / 长按强制）自研抓页入口
             · btnFit      —— 「适应屏幕 / 原始大小」开关
           三个按钮连同底栏一起没了。页面显示方式固定一档（见 setupWebView），
           缩放仍走下面这两个 ＋ / －。 */

        // 缩放：教务是 PC 版页面，缩到整屏后字很小，靠这两个按钮放大去点菜单
        findViewById<TextView>(R.id.btnEduZoomOut).setOnClickListener { webView.zoomOut() }
        findViewById<TextView>(R.id.btnEduZoomIn).setOnClickListener { webView.zoomIn() }

        urlBar.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_GO) {
                openUrl(urlBar.text.toString())
                true
            } else false
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack()
                else { setResult(Activity.RESULT_CANCELED); finish() }
            }
        })
    }

    /* v1.9.43 从这里删掉了整节「页面显示方式：适应屏幕 / 原始大小」——
       applyPageMode() / applyViewportFix() / togglePageMode() 三只。
       页面显示方式现在固定一档，设置在 setupWebView 里一次写完；
       原来那个开关的坑（页面自带的 viewport meta 会盖掉 WebView 设置、
       `loadWithOverviewMode` 只在页面没声明 viewport 时才说了算）
       留档在 留档/课表导入-自研抓页-v1.9.43/ 的原文里。 */

    private fun openUrl(raw: String) {
        var u = raw.trim()
        if (u.isEmpty()) return
        /* 缺协议时补 **https**（v1.9.45 从 http 改回来）。
           补 http 等于「用户少打几个字符，我们就替他把这一趟降级成明文」——
           而这一页接下来要输入的是教务账号密码。补 https 打不开时，证书 /
           跳转错误会当场暴露、用户改两下地址就好；补 http 打不开时，
           往往表现为「登录按钮点了没反应」，很难联想到协议这一层。
           （只有 http 的教务站仍打得开：它自己的 302 会把 http 暴露出来。） */
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://$u"
        urlBar.setText(u)
        webView.loadUrl(u)
    }

    /* v1.9.43 从这里往下删掉了整条「自研抓页」通道，共约 380 行：
         showHelp() / grabPage() / dumpCurrentPage() / armCapture() / disarmCapture()
         / claimArmed() / CaptureBridge / onCaptured() / hasWeekdayHeading()
         / looksLikeSchedulePage() / frameWarning() / showTip() / Dumped / dumpPage()
         / offerShare() / shareDump() / openDump()
       连同它的桥名、超时、JS 与那几张长文案。原码留档在
       留档/课表导入-自研抓页-v1.9.43/原文/EduLoginActivity.kt.txt。
       现在这里只剩下一条导入通道：适配脚本（见 setupAdapter）。 */

    /* ============================================================
       SSL 错误：分类型处理
       ------------------------------------------------------------
       这一层是**真浏览器**，会加载任意外部站点，所以不能像主界面那样
       假定「对面一定是自己人」。两条线：
         · 证书域名与实际域名不符 -> 直接拦掉，不给绕过的口子；
         · 自签 / 过期 / 链不完整 -> 用户确认一次，按域名记住。
       ============================================================ */
    private fun errorHost(error: SslError?): String =
        try {
            Uri.parse(error?.url ?: "").host ?: ""
        } catch (e: Exception) {
            ""
        }

    /** 用户确认过「这台教务的证书就这样」的域名。存 Set，满了整体清掉重来。 */
    private fun trustedSslHosts(): Set<String> =
        prefs().getStringSet(KEY_SSL_HOSTS, emptySet<String>()) ?: emptySet()

    private fun rememberSslHost(host: String) {
        val cur = trustedSslHosts().toMutableSet()
        if (cur.size >= MAX_SSL_TRUSTED) cur.clear()   // 兜底，不至于永远只认第一台
        cur.add(host)
        prefs().edit().putStringSet(KEY_SSL_HOSTS, cur).apply()
    }

    /**
     * 自签 / 过期证书的确认框。
     *
     * 一个页面里多个资源（主文档 + 脚本 + 图片）会**同时**触发这个回调，
     * 所以正在问同一个域名时，后面的先排队 —— 否则会叠出一摞一模一样的弹窗
     * （用户点完一个还有一个，看起来像卡死）。用户答一次，排队的按同一个答案处理。
     */
    private fun askSslTrust(host: String, handler: SslErrorHandler) {
        if (host == sslAskHost) {          // 同一个域名正在问，排队等答复
            sslPending.add(handler)
            return
        }
        if (sslAskHost != null) {          // 上一轮还没答完又问别的域名，别叠弹窗
            handler.cancel()
            return
        }
        sslAskHost = host
        sslPending.add(handler)
        val who = if (host.isBlank()) "这个网站" else host
        val dlg = showEduDialog(
            "这个网站的证书有问题",
            "「$who」的证书没通过校验（自签、过期或证书链不完整），" +
                "浏览器无法确认它真的是学校那台服务器。\n\n" +
                "继续访问的话，你在这一页输入的学号密码有可能被人看到。\n\n" +
                "如果这台教务一直是这样、而且网络是你自己在用（比如校园网），" +
                "可以继续。点「继续访问」之后，这个域名不再询问。",
            actions = listOf(
                EduAction("取消") { resolveSslTrust(false) },
                EduAction("继续访问") { resolveSslTrust(true) }
            ),
            onCancel = { resolveSslTrust(false) }
        )
        if (dlg == null) {
            resolveSslTrust(false)
            toast("证书校验没通过，已阻止加载。")
        }
    }

    private fun resolveSslTrust(allow: Boolean) {
        val host = sslAskHost
        val waiting = ArrayList(sslPending)
        sslPending.clear()
        sslAskHost = null
        if (allow && !host.isNullOrBlank()) rememberSslHost(host)
        for (h in waiting) {
            try {
                if (allow) h.proceed() else h.cancel()
            } catch (e: Exception) { /* 忽略 */ }
        }
        if (!allow) {
            toast("已阻止加载。页面可能显示不全；也可以改用教务系统的「导出课表」下载文件后导入。")
        }
    }

    /**
     * 证书上的域名和实际访问的域名对不上：**不给「继续」的选项**。
     * 只说清为什么拦、以及还有哪条路可走 —— 把用户扔在空白页上不解释，
     * 比放行还糟。
     */
    private fun warnSslMismatch(host: String) {
        if (sslBlockedNotified) return       // 同一页多个资源同时失败，只弹一次
        sslBlockedNotified = true
        val who = if (host.isBlank()) "这个网站" else host
        val dlg = showEduDialog(
            "已阻止：证书上的域名对不上",
            "「$who」出示的证书里写的不是这个域名。\n\n" +
                "正常网站不会这样 —— 这通常是「有人在中间替你和学校服务器对话」的特征，" +
                "最坏的情况是账号密码被人看走。\n\n" +
                "已经帮你拦下了。如果学校教务用的确实是旧证书，\n" +
                "可以改用教务系统的「导出课表」把文件下载下来，再用「选择文件」导入 ——" +
                "这条路上不用在这一页登录。",
            actions = listOf(EduAction("知道了") { })
        )
        if (dlg == null) toast("已阻止加载：网站证书与域名不符。")
    }

    /* ============================================================
       社区适配库：在当前页面上跑上游的适配脚本（v1.9.32）
       ------------------------------------------------------------
       与上面那条「自研抓页」是**两条独立通道**，互补得很清楚：

         · 自研抓页（edugrab）：把整页 HTML 搬回本地，靠网页侧的提取器认课表。
           覆盖面靠提取器的多变体级联，学校页面一改就可能认不出。
         · 适配脚本（本节）：上游社区**每所学校一段脚本**，脚本就地在页面上取数，
           再通过桥把结构化结果交回来。页面变了由脚本作者修，不用我们发版。

       自研那条留作**兜底**：适配库里没有的学校、或脚本跑砸了，还能用。

       ---- 桥的契约（扫完上游 255 个脚本得出的完整调用面）----
         window.shiguangBridge.showToast(msg)              // 2003 次
         window.shiguangBridge.notifyTaskCompletion()       //  275 次
         window.shiguangBridgePromise.showAlert(title, message, confirmText) -> Promise<Boolean>
         window.shiguangBridgePromise.showPrompt(title, message, def, validatorName) -> Promise<String|null>
         window.shiguangBridgePromise.showSingleSelection(title, itemsJson, defaultIndex) -> Promise<Number|null>
         window.shiguangBridgePromise.saveImportedCourses(json)      -> Promise<Boolean>
         window.shiguangBridgePromise.savePresetTimeSlots(json)      -> Promise<Boolean>
         window.shiguangBridgePromise.saveCourseConfig(json)         -> Promise<Boolean>
         别名：window.AndroidBridge / window.AndroidBridgePromise（6 个老脚本在用）

       两条只有实测才能知道的约定，都别凭直觉改：
       ① `showPrompt` 的第 4 个参数是**页面上那个校验函数的名字**，不是校验规则 ——
          脚本自己挂 `window.validateYearInput = function(input){...}`，宿主按名字回查。
          返回值约定是**倒的**：`false` = 通过，**返回字符串 = 错误文案**（要显示给用户）。
          见 BTBU / CCIT / GDKM 的定义，三处口径一致。
       ② 脚本顶层先看 `location.href` 是不是目标页，不是就 `location.replace(url)` 然后
          **就地结束** —— 所以宿主必须在每个新文档上重新注入一次
          （见 maybeReinjectAdapter），否则表现是「跳过去之后就没动静了」。
       ============================================================ */
    private fun setupAdapter() {
        adapterSchool = intent?.getStringExtra(EXTRA_ADAPTER_SCHOOL) ?: ""
        adapterName = intent?.getStringExtra(EXTRA_ADAPTER_NAME) ?: ""
        adapterMaintainer = intent?.getStringExtra(EXTRA_ADAPTER_MAINTAINER) ?: ""
        adapterScriptUrls.clear()
        intent?.getStringArrayListExtra(EXTRA_ADAPTER_SCRIPTS)?.let { adapterScriptUrls.addAll(it) }

        // 取脚本**只有联网一条路**（v1.9.42）。没有地址就不开适配条 ——
        // 否则用户看到的是一条点了没反应的横条。
        if (adapterScriptUrls.isEmpty()) {
            adapterBar.visibility = View.GONE
            return
        }
        adapterBar.visibility = View.VISIBLE
        btnAdapterRun.setOnClickListener { runAdapter() }
        btnAdapterStop.setOnClickListener { stopAdapter("已停止本次适配导入。") }
        showAdapterIdle()
    }

    /** 「适配脚本「重庆交通大学教务」（重庆交通大学）· 维护者 烛谛」——上游要求署名 */
    private fun adapterLabel(): String {
        val who = buildString {
            append("适配脚本「").append(adapterName.ifBlank { "未命名" }).append('」')
            if (adapterSchool.isNotBlank()) append("（").append(adapterSchool).append('）')
            if (adapterMaintainer.isNotBlank()) append(" · 维护者 ").append(adapterMaintainer)
        }
        return who
    }

    private fun showAdapterIdle() {
        adapterText.text = adapterLabel() + "\n先在这里登录、翻到课表页，再点右边「执行导入」"
        btnAdapterRun.text = "执行导入"
        btnAdapterStop.visibility = View.GONE
    }

    /**
     * 按下「执行导入」。
     *
     * 每次按下都是**新的一趟**：清空上一趟攒的数据、换一个门闩令牌。
     * 这一点很重要 —— 上一趟可能已经攒了半份数据，重新跑一趟不清掉的话，
     * 两次的数据会混在一起灌给用户。
     */
    private fun runAdapter() {
        if (adapterScriptUrls.isEmpty()) return
        // v1.9.42 及以前这里要 disarmCapture()「两条通道互斥」，
        // v1.9.43 只剩这一条通道，没得互斥了。

        val t = UUID.randomUUID().toString()
        adapterToken = t
        adapterLastScript = null
        adapterCourses = ArrayList()
        adapterTimes = null
        adapterConfig = null
        adapterDropped = null
        adapterSample = null
        adapterSaves = 0
        adapterConsoleError = ""
        adapterInjectedAt = -1

        adapterText.text = "正在载入适配脚本…\n" + adapterLabel()
        btnAdapterRun.text = "重新执行"
        btnAdapterStop.visibility = View.VISIBLE
        webView.removeCallbacks(adapterWatchdog)
        webView.postDelayed(adapterWatchdog, ADAPTER_TIMEOUT_MS)

        thread {
            val fetched = fetchScript(adapterScriptUrls)
            runOnUiThread {
                if (adapterToken != t) return@runOnUiThread   // 这趟已被停掉 / 已被新的一趟替掉
                val text = fetched.first
                if (text == null) {
                    stopAdapter(
                        "适配脚本下载失败：" + (fetched.second ?: "网络错误") +
                            "。脚本是联网取的（包里不带），请检查网络后重试；" +
                            "也可以点课表页的「导出 / 下载课表」，下载完会自动导入。"
                    )
                    return@runOnUiThread
                }
                adapterLastScript = text
                adapterText.text = "正在执行：\n" + adapterLabel()
                injectAdapter(t, text)
            }
        }
    }

    /**
     * 把宿主 + 脚本注入当前文档。
     *
     * 顺序不能反：宿主必须先在，脚本一进来就可能调 `window.shiguangBridge`。
     * （上游脚本对「桥不在」的处理是直接抛异常，所以顺序错了看到的是
     * 「适配脚本执行出错：xxx is not defined」这种看不出原因的话。）
     */
    private fun injectAdapter(t: String, scriptText: String) {
        if (adapterToken != t) return
        adapterInjectedAt = eduPageSeq
        webView.evaluateJavascript(adapterShimJs(t), null)
        // 脚本整段包在 IIFE 里。上游脚本顶层大量用 const / function 声明，
        // 同一个文档里重复注入会直接 `SyntaxError: Identifier 'x' has already been declared`
        // —— 用户第二次点「重新执行」就会踩到。包一层之后重复注入无害，
        // 最外层再兜一层 try/catch，把脚本自己没接住的异常记下来给提示用。
        webView.evaluateJavascript(
            "(function(){try{\n" + scriptText + "\n}catch(e){" +
                "try{window.$ADAPTER_ERR_VAR=String((e&&e.message)||e);}catch(_){}}})();"
        ) {
            webView.evaluateJavascript(
                "(function(){try{return String(window.$ADAPTER_ERR_VAR||'');}catch(e){return '';}})()"
            ) { raw ->
                val msg = unquoteJs(raw)
                // 页面已经跳走时读到的会是新文档的（空串），所以这里只在真有错时说话
                if (adapterToken == t && !msg.isNullOrBlank()) {
                    stopAdapter(
                        "适配脚本执行出错：$msg" +
                            "\n\n可能是这一页还不是课表页。先确认已登录、并且停在" +
                            "「学生个人课表」上，再点一次「执行导入」；" +
                            "也可以回到上一页换一所学校的适配脚本。"
                    )
                }
            }
        }
    }

    /**
     * 换页后重新注入。
     *
     * 用**文档序号**去重而不是 URL：A → B → A 这种来回跳时，按 URL 去重会把
     * 第二个 A 当成「已经注过」而跳过，脚本就再也跑不起来了。
     */
    private fun maybeReinjectAdapter() {
        val t = adapterToken ?: return
        if (adapterInjectedAt == eduPageSeq) return
        val script = adapterLastScript ?: return
        adapterText.text = "已在当前页面重新执行：\n" + adapterLabel()
        injectAdapter(t, script)
    }

    /**
     * 停止这一趟：摘掉页面上的宿主、收掉还挂着的 Promise，门闩归 null。
     *
     * **必须把页面上那套 `window.shiguang*` 删掉** —— 门闩只挡住了「原生的那一侧」，
     * 留在页面上的宿主对象本身仍然可以被页面脚本调用；不删的话，等这一趟结束、
     * 用户以为已经过去了，页面脚本还能接着往里灌数据（下一趟会被当成正常数据收下）。
     * 删掉之后，页面手上那份宿主就没有落脚点了。
     *
     * 顺手把还挂着的 Promise 用 null 收掉：脚本可能正 `await` 在某个弹窗上，
     * 不收掉它就永远等下去（表现是页面看着好好的、脚本再也不往下走）。
     */
    private fun stopAdapter(msg: String? = null) {
        adapterToken = null
        webView.removeCallbacks(adapterWatchdog)
        webView.evaluateJavascript(ADAPTER_TEARDOWN_JS, null)
        if (::adapterBar.isInitialized && adapterBar.visibility == View.VISIBLE) showAdapterIdle()
        if (!msg.isNullOrBlank()) toast(msg)
    }

    /**
     * 兜底提示。**只提示，不改变状态**。
     *
     * 适配脚本要自己发网络请求（拿课表接口），慢是正常的，不能到点就判它失败。
     * 但也不能让用户对着「正在执行」无限等 —— 所以给一句话，并告诉他还有哪条路。
     */
    private val adapterWatchdog = Runnable {
        if (adapterToken == null) return@Runnable
        val extra = if (adapterConsoleError.isNotBlank())
            "\n（页面里的报错：${adapterConsoleError.take(120)}）" else ""
        toast(
            "适配脚本已经跑了 ${ADAPTER_TIMEOUT_MS / 1000} 秒还没结束。" +
                "如果页面一直没反应，可以点「停止」，" +
                "再点课表页的「导出 / 下载课表」把文件下载下来导入。$extra"
        )
    }

    /**
     * 取适配脚本：**只有联网这一条路**。
     *
     * v1.9.33~v1.9.40 是「先读 assets 里的内置快照、读不到再联网」，
     * v1.9.41 变成「先用网页递过来的本校正文、没有才联网」。
     * **v1.9.42 起本校那一行也改用上游「正方教务-通用教务」** ——
     * 于是两条近路都不需要了：**原生不再有任何「读本地脚本」的入口**，
     * 只剩「按地址下载」，与索引完全同一套（多源、按顺序试）。
     *
     * 联网那段保留多源：`raw.githubusercontent.com` 在国内时通时不通，
     * 只有一条路的话会出现「有这所学校，点了没反应」。
     */
    private fun fetchScript(urls: List<String>): Pair<String?, String?> {
        var lastErr = "没有可用的下载地址"
        for (raw in urls) {
            if (!raw.startsWith("https://")) continue
            var conn: HttpURLConnection? = null
            try {
                conn = (URL(raw).openConnection() as HttpURLConnection).apply {
                    // 这两个数要**与网页侧的桥超时对得上**：网页那边等 28 秒，
                    // 这里最坏 5 + 15 = 20 秒，留了余量 —— 反过来的话，
                    // 每一次慢下载都会先由网页侧报「超时」，真正的失败原因反而看不到。
                    connectTimeout = 5000
                    readTimeout = 15000
                    instanceFollowRedirects = true
                    setRequestProperty("User-Agent", UA_DESKTOP)
                    setRequestProperty("Accept", "*/*")
                }
                val code = conn.responseCode
                if (code !in 200..299) { lastErr = "HTTP $code"; continue }

                val out = ByteArrayOutputStream()
                var tooBig = false
                conn.inputStream.use { input ->
                    val buf = ByteArray(32 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        if (out.size() > MAX_SCRIPT_BYTES) { tooBig = true; break }
                    }
                }
                if (tooBig) { lastErr = "脚本文件过大（超过 2 MB）"; continue }

                val text = String(out.toByteArray(), Charsets.UTF_8)
                if (text.isBlank()) { lastErr = "拿到的是空文件"; continue }
                return Pair(text, null)
            } catch (e: Exception) {
                lastErr = e.message ?: "网络错误"
            } finally {
                conn?.disconnect()
            }
        }
        return Pair(null, lastErr)
    }

    /* ------------------------------------------------------------
       原生侧的调用出口（AdapterHost.host 分派到这里）
       ------------------------------------------------------------ */

    /**
     * 上游脚本要的宿主。**只有一个方法** `host(...)`，用字符串分派 ——
     * 见 setupWebView 里挂桥那句的注释。
     *
     * 两条纪律：
     *  ① token 必须是这一趟的。不是就**静默返回**（不回错误、不弹提示）——
     *     页面脚本抢跑时不值得给它任何反馈，而且回错误反而等于告诉它「猜对了」；
     *  ② 所有 UI 动作切回 UI 线程（桥回调在 WebView 的线程上）。
     */
    private inner class AdapterHost {
        @JavascriptInterface
        fun host(method: String?, token: String?, reqId: String?, args: String?) {
            val m = method ?: return
            val t = token ?: return
            if (t != adapterToken) return          // 不是这一趟：哑掉
            val id = reqId ?: ""
            val payload = args ?: "{}"
            runOnUiThread { dispatchAdapter(m, id, payload) }
        }
    }

    private fun dispatchAdapter(method: String, reqId: String, payload: String) {
        if (adapterToken == null) return          // 排队期间被停掉了
        try {
            val o = org.json.JSONObject(payload)
            when (method) {
                "showToast" -> toast(o.optString("msg"))

                // 收尾的**唯一**判据。不能改成「攒到数据就算成功」——脚本在失败路径上
                // 常常已经先存了作息 / 存了一半课程，那样等于把半份数据灌给用户。
                "notifyTaskCompletion" -> finishAdapterImport()

                "showAlert" -> showAlertDialog(
                    o.optString("title"), o.optString("message"), o.optString("confirm")
                ) { ok -> replyAdapter(reqId, if (ok) "true" else "false") }

                "showPrompt" -> showPromptDialog(
                    o.optString("title"), o.optString("message"),
                    o.optString("def"), o.optString("validator")
                ) { v -> replyAdapter(reqId, if (v == null) "null" else jsQuoteString(v)) }

                "showSingleSelection" -> {
                    val arr = o.optJSONArray("items")
                    val items = ArrayList<String>()
                    if (arr != null) for (i in 0 until arr.length()) items.add(arr.optString(i))
                    showSelectionDialog(o.optString("title"), items, o.optInt("def", 0)) { idx ->
                        replyAdapter(reqId, if (idx == null) "null" else idx.toString())
                    }
                }

                "saveImportedCourses" -> replyAdapter(reqId, boolReply(saveCourses(o.optString("json"))))
                "savePresetTimeSlots" -> replyAdapter(reqId, boolReply(saveTimes(o.optString("json"))))
                "saveCourseConfig" -> replyAdapter(reqId, boolReply(saveConfig(o.optString("json"))))

                // 不认识的：回 null。**不要**静默丢弃 —— 脚本 await 的那个 Promise
                // 会永远挂着，页面看着正常、流程再也不往下走，这种故障最难查。
                else -> replyAdapter(reqId, "null")
            }
        } catch (e: Exception) {
            replyAdapter(reqId, "null")
        }
    }

    private fun boolReply(ok: Boolean) = if (ok) "true" else "false"

    /**
     * 课程：**累加**。
     *
     * 上游 242 个会调这个方法的脚本，**每个都只调一次**，所以「累加」与「覆盖」
     * 今天看不出差别。选累加是因为它在两种将来都安全：
     *  · 将来某脚本改成**分批**提交（先 20 门、再 20 门）⇒ 累加才对，覆盖会丢前一批；
     *  · 若它重复提交**同一份**（比如出错重试）⇒ 重复项会在网页侧
     *    `ImportUtil.finalize()` 里按「星期 | 节次 | 课程签名」折叠掉。
     * 反过来，「覆盖」在上面第一种情况下会**静默少课** —— 这种错没人会发现。
     * 去重口径只有网页侧那一处（工程约定），这里不自己判重。
     */
    private fun saveCourses(json: String): Boolean {
        /* v1.9.37 起也接受对象包装 `{courses:[…], dropped:[…]}`：内置的本校适配脚本
           会把「没认出来被跳过的原始行样本」一并交回来（dropped），导入预览据此
           告诉用户课表少了哪半截、为什么 —— 排障不再靠猜。上游脚本仍传纯数组，
           两条形状都认，互不影响。 */
        val obj = try { org.json.JSONObject(json) } catch (e: Exception) { null }
        val arr = when {
            obj != null -> obj.optJSONArray("courses")
            else -> try { org.json.JSONArray(json) } catch (e: Exception) { null }
        } ?: return false
        if (obj != null && obj.has("dropped")) {
            adapterDropped = obj.optJSONArray("dropped")?.toString()
        }
        /* v1.9.38：第一条原始记录的字段全貌（脚本 summarizeItem 产出的一行文本）。
           节次落位不对时，它是唯一能说清「教务到底给了哪些字段」的东西。 */
        if (obj != null && obj.has("sample")) {
            adapterSample = obj.optString("sample", "").takeIf { it.isNotEmpty() }
        }
        for (i in 0 until arr.length()) {
            val o = arr.opt(i)
            if (o is org.json.JSONObject) adapterCourses.add(o.toString())
        }
        adapterSaves++
        return true
    }

    /**
     * 作息表 / 学期设置：**整份覆盖、后到的为准**。
     *
     * 依据是实测的调用形状：`savePresetTimeSlots` 只有 1 个脚本调两次，那两次是
     * if/else 的互斥分支（拿到学校作息 / 拿不到就用备用）；`saveCourseConfig` 只有
     * 1 个脚本调 3 次，是三个独立的「备选策略」，每次都是一份**完整**配置。
     * 两处都不是「分批累加」，所以覆盖是对的，累加反而会把几份配置拼成一份四不像。
     */
    private fun saveTimes(json: String): Boolean {
        try { org.json.JSONArray(json) } catch (e: Exception) { return false }
        adapterTimes = json
        return true
    }

    private fun saveConfig(json: String): Boolean {
        try { org.json.JSONObject(json) } catch (e: Exception) { return false }
        adapterConfig = json
        return true
    }

    /**
     * 脚本说「这一趟完成了」：把三类数据打成一封信交给主界面。
     *
     * 界面上的名字（校名 / 适配脚本名 / 维护者）一起带上 —— 预览页要显示
     * 「这份课表是哪段脚本取回来的」，这是上游的署名要求，也是用户遇到问题
     * 时唯一能拿去社区提问的线索。
     */
    private fun finishAdapterImport() {
        if (adapterToken == null) return
        val sb = StringBuilder(1024)
        sb.append('{')
            .append("\"schoolName\":").append(jsQuoteString(adapterSchool))
            .append(",\"adapterName\":").append(jsQuoteString(adapterName))
            .append(",\"maintainer\":").append(jsQuoteString(adapterMaintainer))
            .append(",\"courses\":[").append(adapterCourses.joinToString(",")).append(']')
            .append(",\"timeSlots\":").append(adapterTimes ?: "null")
            .append(",\"config\":").append(adapterConfig ?: "null")
            .append(",\"dropped\":").append(adapterDropped ?: "null")
            .append(",\"sample\":").append(jsQuoteString(adapterSample ?: ""))
            .append(",\"saves\":").append(adapterSaves)
            .append('}')

        val url = webView.url ?: urlBar.text.toString()
        stopAdapter(null)          // 先把宿主从页面上摘干净，再交结果
        EduBus.clear()
        EduBus.adapterJson = sb.toString()
        EduBus.url = url
        toast("适配脚本已取到数据，正在整理…")
        setResult(Activity.RESULT_OK)
        finish()
    }

    /** 把结果回给页面上的 Promise（走 shim 的 `__shiguangReply`） */
    private fun replyAdapter(reqId: String, jsonLiteral: String) {
        if (reqId.isBlank()) return
        try {
            webView.evaluateJavascript(
                "(function(){try{if(window.__shiguangReply)" +
                    "window.__shiguangReply(${jsQuoteString(reqId)}, $jsonLiteral);}catch(e){}})()",
                null
            )
        } catch (e: Exception) { /* 页面已经没了就没事 */ }
    }

    /* ============================================================
       弹窗底座（v1.9.37）：柚课样式的自绘对话框
       ------------------------------------------------------------
       这个 Activity 里的**所有**弹窗都走这里，不再用 AlertDialog 自带的
       标题 / 按钮 —— 系统主题画出来的弹窗（灰底青字的 Material 默认脸）
       跟柚课的视觉是两种画风，用户一眼就看出「不像同一个应用」。

       颜色全部取自 edu_* 镜像令牌（res/values[-night]/colors.xml，
       跟随系统日夜切换，与顶栏 / 底栏 / 状态栏同一套）；几何沿用应用
       弹层的圆角面板。自绘判据见 `.workbuddy/memory/弹层与自绘约定.md`
       —— 那条纪律管的是**网页侧**（.mask/.sheet）；这里是原生 Activity，
       CSS 一律够不着，「自绘」在这里就是把同一套令牌画进自定义 View。

       调用方约定：助手**内部就 .show()**；造不出来（极小概率的
       BadTokenException 之类）返回 null，调用方按各自行数的兜底走
       （回默认值 / toast / 直接 resolve），绝不能让桥的 Promise 悬着。
       ------------------------------------------------------------ */

    /** 镜像令牌取色（随系统日夜切换，与 activity_edu.xml 同源） */
    private fun eduColor(id: Int): Int = ResourcesCompat.getColor(resources, id, theme)

    private fun eduDp(v: Int): Int = (resources.displayMetrics.density * v + 0.5f).toInt()

    /** 圆角纯色填充（弹层面板 / 输入框底） */
    private fun roundedFill(color: Int, radiusDp: Int): GradientDrawable =
        GradientDrawable().apply { setColor(color); cornerRadius = eduDp(radiusDp).toFloat() }

    /** 触摸涟漪（选项行 / 按钮的按压反馈，取系统 ripple 属性，不引新资源） */
    private fun touchRipple(): android.graphics.drawable.Drawable? {
        val tv = TypedValue()
        theme.resolveAttribute(android.R.attr.selectableItemBackground, tv, true)
        return ResourcesCompat.getDrawable(resources, tv.resourceId, theme)
    }

    /** 弹窗按钮：label + 点击回调（回调前助手会先关弹窗）；最后一个按钮 = 主操作，主色加粗 */
    private class EduAction(val label: String, val onClick: () -> Unit)

    /**
     * 造并显示一块柚课样式的对话框。
     * `inputDefault` 非空 = 带输入框（prompt），引用经 [configureInput] 交给调用方；
     * `options` 非空 = 单选列表，选中行主色加粗，点了直接关弹窗回选项下标。
     */
    private fun showEduDialog(
        title: String,
        message: String?,
        actions: List<EduAction> = emptyList(),
        inputDefault: String? = null,
        configureInput: ((EditText) -> Unit)? = null,
        options: List<String>? = null,
        defaultOption: Int = -1,
        onOptionPick: ((Int) -> Unit)? = null,
        onCancel: (() -> Unit)? = null
    ): AlertDialog? = try {
        var dlgRef: AlertDialog? = null
        val pad = eduDp(22)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedFill(eduColor(R.color.edu_surface), 22)
            setPadding(pad, eduDp(20), pad, eduDp(10))
            minimumWidth = eduDp(296)
        }

        if (title.isNotBlank()) {
            root.addView(TextView(this).apply {
                text = title
                setTextColor(eduColor(R.color.edu_ink))
                textSize = 17f
                typeface = Typeface.DEFAULT_BOLD
            })
        }

        if (!message.isNullOrBlank()) {
            val body = TextView(this).apply {
                text = message
                setTextColor(eduColor(R.color.edu_ink2))
                textSize = 15f
                setLineSpacing(eduDp(3).toFloat(), 1f)
            }
            /* 长文（「怎么用」/ 证书警告）要能滚：包一层限高 ScrollView，
               高度上限 60% 屏高 —— 不限的话「怎么用」那种十几行的会顶出屏幕 */
            val sc = object : ScrollView(this) {
                override fun onMeasure(w: Int, h: Int) {
                    super.onMeasure(w, MeasureSpec.makeMeasureSpec(
                        (resources.displayMetrics.heightPixels * 0.6f).toInt(),
                        MeasureSpec.AT_MOST))
                }
            }
            sc.addView(body)
            sc.isVerticalScrollBarEnabled = false
            root.addView(sc, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = eduDp(12) })
        }

        if (inputDefault != null) {
            val input = EditText(this).apply {
                setText(inputDefault)
                setSingleLine()
                setTextColor(eduColor(R.color.edu_ink))
                setHintTextColor(eduColor(R.color.edu_ink2))
                background = roundedFill(eduColor(R.color.edu_surface2), 10)
                setPadding(eduDp(12), eduDp(11), eduDp(12), eduDp(11))
                setSelection(text.length)
            }
            configureInput?.invoke(input)
            root.addView(input, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = eduDp(16) })
        }

        options?.forEachIndexed { idx, label ->
            val isDefault = idx == defaultOption
            val row = TextView(this).apply {
                text = label
                textSize = 15f
                setTextColor(if (isDefault) eduColor(R.color.edu_accent) else eduColor(R.color.edu_ink))
                typeface = if (isDefault) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                setPadding(eduDp(6), eduDp(13), eduDp(6), eduDp(13))
                foreground = touchRipple()
            }
            row.setOnClickListener { dlgRef?.dismiss(); onOptionPick?.invoke(idx) }
            root.addView(row)
        }

        if (actions.isNotEmpty()) {
            val bar = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.END
            }
            actions.forEachIndexed { i, a ->
                val isPrimary = i == actions.size - 1
                val btn = TextView(this).apply {
                    text = a.label
                    textSize = 15f
                    typeface = if (isPrimary) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                    setTextColor(
                        if (isPrimary) eduColor(R.color.edu_accent)
                        else eduColor(R.color.edu_ink2)
                    )
                    setPadding(eduDp(14), eduDp(12), eduDp(14), eduDp(12))
                    foreground = touchRipple()
                }
                btn.setOnClickListener { dlgRef?.dismiss(); a.onClick() }
                bar.addView(btn)
            }
            root.addView(bar, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = eduDp(12) })
        }

        val dlg = AlertDialog.Builder(this).setView(root).create()
        dlgRef = dlg
        if (onCancel != null) dlg.setOnCancelListener { onCancel() }
        dlg.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        dlg.show()
        dlg
    } catch (e: Exception) {
        null
    }

    /**
     * showAlert：三个参数 —— 标题 / 正文 / 确认按钮文案。确认 true、取消 false。
     */
    private fun showAlertDialog(title: String, message: String, confirm: String, cb: (Boolean) -> Unit) {
        var answered = false
        fun answer(v: Boolean) { if (!answered) { answered = true; cb(v) } }
        val dlg = showEduDialog(
            title.ifBlank { "提示" }, message,
            actions = listOf(
                EduAction("取消") { answer(false) },
                EduAction(confirm.ifBlank { "确定" }) { answer(true) }
            ),
            onCancel = { answer(false) }
        )
        if (dlg == null) answer(false)   // 弹不出来时按「取消」走，别让桥的 Promise 悬着
    }

    /** showSingleSelection：标题 + 选项（脚本给的是 JSON 数组）+ 默认选中项 */
    private fun showSelectionDialog(
        title: String,
        items: List<String>,
        defaultIndex: Int,
        cb: (Int?) -> Unit
    ) {
        if (items.isEmpty()) { cb(null); return }
        var answered = false
        fun answer(v: Int?) { if (!answered) { answered = true; cb(v) } }
        val dlg = showEduDialog(
            title.ifBlank { "请选择" }, null,
            options = items, defaultOption = defaultIndex,
            onOptionPick = { idx -> answer(idx) },
            actions = listOf(EduAction("取消") { answer(null) }),
            onCancel = { answer(null) }
        )
        if (dlg == null) {
            // 弹不出来时回默认项，而不是 null（null 会被脚本当成「用户取消」而整个中止，
            // 那比用一个大概率正确的默认值糟得多）
            answer(if (defaultIndex in items.indices) defaultIndex else null)
        }
    }

    /**
     * showPrompt：标题 / 说明 / 默认值 / **页面上那个校验函数的名字**。
     *
     * 校验约定（实测 BTBU / CCIT / GDKM 三处一致，别凭直觉反着写）：
     *   脚本自己挂 `window.<名字> = function(input){...}`，
     *   **返回 `false` 表示通过，返回字符串表示错误文案**。
     * 所以输入框不能用 `setPositiveButton` 直接关 —— 校验没过要**留在原地**重问，
     * 把脚本给的那句错误文案挂在输入框上（`EditText.error`）让用户改。
     * 这就是「先用 null 监听器建、再在 onShow 里接管按钮」那套写法的原因。
     */
    private fun showPromptDialog(
        title: String,
        message: String,
        defaultValue: String,
        validator: String,
        cb: (String?) -> Unit
    ) {
        var answered = false
        fun answer(v: String?) { if (!answered) { answered = true; cb(v) } }
        var inputRef: EditText? = null
        val dlg = showEduDialog(
            title.ifBlank { "请输入" }, message,
            inputDefault = defaultValue,
            configureInput = { inputRef = it },
            actions = listOf(
                EduAction("取消") { answer(null) },
                EduAction("确定") {
                    val input = inputRef ?: return@EduAction
                    val v = input.text.toString().trim()
                    if (validator.isBlank()) { answer(v); return@EduAction }
                    runPageValidator(validator, v) { ok, errText ->
                        if (adapterToken == null) return@runPageValidator
                        if (ok) answer(v)
                        else input.error = errText ?: "输入不正确，请重新输入"
                    }
                }
            ),
            onCancel = { answer(null) }
        )
        if (dlg == null) answer(null)
    }

    /**
     * 回页面调脚本自己挂的那个校验函数。
     *
     * 三种情况都**放行**（ok = true）：函数不存在、调用抛异常、拿到不认识的结果 ——
     * 校验是脚本的便利功能，不能因为它坏了就把用户卡在这一步出不去。
     * 唯一拦下来的是「返回了非 false 的东西」，那按约定就是错误文案。
     */
    private fun runPageValidator(name: String, value: String, cb: (Boolean, String?) -> Unit) {
        val js = "(function(){try{var f=window[${jsQuoteString(name)}];" +
            "if(typeof f!=='function')return 'ok';" +
            "var r=f(${jsQuoteString(value)});" +
            "if(r===false||r===undefined||r===null||r===true)return 'ok';" +
            "return 'err:'+String(r);}catch(e){return 'ok';}})()"
        try {
            webView.evaluateJavascript(js) { raw ->
                val s = unquoteJs(raw)
                if (s != null && s.startsWith("err:")) cb(false, s.substring(4)) else cb(true, null)
            }
        } catch (e: Exception) {
            cb(true, null)
        }
    }

    /* ============================================================
       下载教务系统导出的课表文件
       ============================================================ */
    private fun startDownload(
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?
    ) {
        if (downloading) return
        if (!url.startsWith("http")) {
            toast("这个下载链接不支持（$url），请改用课表页的「导出 / 下载课表」")
            return
        }
        downloading = true
        val name = guessFileName(url, contentDisposition)
        toast("正在下载「$name」…")

        val referer = webView.url
        val ua = userAgent ?: webView.settings.userAgentString

        thread {
            var conn: HttpURLConnection? = null
            try {
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15000
                    readTimeout = 40000
                    instanceFollowRedirects = true
                    setRequestProperty("User-Agent", ua)
                    // 教务下载接口基本都校验登录态，必须把浏览器会话的 Cookie 带过去
                    CookieManager.getInstance().getCookie(url)
                        ?.let { setRequestProperty("Cookie", it) }
                    if (!referer.isNullOrBlank()) setRequestProperty("Referer", referer)
                    setRequestProperty("Accept", "*/*")
                }

                val code = conn.responseCode
                if (code !in 200..299) {
                    failDownload("下载失败（HTTP $code）。可能是登录状态已过期，" +
                        "重新登录后再点一次课表页的「导出 / 下载课表」。")
                    return@thread
                }

                val declared = conn.contentLength
                if (declared > MAX_DOWNLOAD) {
                    failDownload("课表文件超过 8 MB，请下载后用「选择文件」导入。")
                    return@thread
                }

                val out = ByteArrayOutputStream()
                conn.inputStream.use { input ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        if (out.size() > MAX_DOWNLOAD) {
                            failDownload("课表文件超过 8 MB，请下载后用「选择文件」导入。")
                            return@thread
                        }
                    }
                }
                val bytes = out.toByteArray()
                if (bytes.isEmpty()) {
                    failDownload("下载到的文件是空的，请稍后重试。")
                    return@thread
                }

                // 文件格式交给网页侧嗅探（教务导出的「.xls」经常其实是 HTML 表格）
                EduBus.clear()
                EduBus.fileBase64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                EduBus.fileName = name
                EduBus.url = referer
                runOnUiThread {
                    downloading = false
                    setResult(Activity.RESULT_OK)
                    finish()
                }
            } catch (e: Exception) {
                failDownload("下载失败：" + (e.message ?: "网络错误") +
                    "。请检查网络后重新登录，再点一次课表页的「导出 / 下载课表」。")
            } finally {
                conn?.disconnect()
            }
        }
    }

    private fun failDownload(msg: String) {
        runOnUiThread {
            downloading = false
            toast(msg)
        }
    }

    private fun guessFileName(url: String, disposition: String?): String {
        var name = ""
        if (!disposition.isNullOrBlank()) {
            val m = Regex("""filename\*?=(?:UTF-8'')?"?([^";]+)""", RegexOption.IGNORE_CASE)
                .find(disposition)
            if (m != null) {
                name = m.groupValues[1]
                try { name = URLDecoder.decode(name, "UTF-8") } catch (e: Exception) { /* 保持原样 */ }
            }
        }
        if (name.isBlank()) {
            name = Uri.parse(url).lastPathSegment ?: ""
        }
        name = name.replace(Regex("""[\\/:*?"<>|]"""), "_").trim()
        if (name.isBlank()) name = "教务课表"
        if (name.length > 60) name = name.take(60)
        return name
    }

    /* ============================================================ */
    private fun prefs() = getSharedPreferences("edu_browser", Context.MODE_PRIVATE)

    /**
     * 反解 `evaluateJavascript` 的返回值。
     *
     * 它的回调给的是**结果值的 JSON 表示**：脚本 `return 'ok'` 拿到的字面量是
     * `"\"ok\""`，`return null` 拿到的是字符串 `"null"`。不反解就会把引号当成正文
     * —— 每个错误文案外面都多一层引号，看起来像文案没写好，很难定位。
     */
    private fun unquoteJs(raw: String?): String? {
        val s = raw ?: return null
        if (s.isEmpty() || s == "null") return null
        return try {
            val v = org.json.JSONTokener(s).nextValue()
            if (v == null || v == org.json.JSONObject.NULL) null else v.toString()
        } catch (e: Exception) {
            s
        }
    }

    /**
     * 提示。**同一条文案 600ms 内只弹一次**。
     *
     * 适配脚本走的是「桥」这一侧，而桥是常驻在页面上的 —— 成串的提示
     * （脚本自己的 showToast 循环、或页面脚本硬调）会垒成一摞，
     * 用户看到的就是卡住。只压**完全相同**的连续文案：
     * 不同内容照常弹，不会吞掉关键信息。
     */
    private fun toast(msg: String) {
        val now = System.currentTimeMillis()
        if (msg == lastToastKey && now - lastToastAt < TIP_THROTTLE_MS) return
        lastToastKey = msg
        lastToastAt = now
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
    }

    override fun onDestroy() {
        try {
            // 先摘适配宿主再销毁 WebView：留着的话，页面脚本还能在
            // Activity 已经走到生命周期尾巴时继续往里灌数据。
            stopAdapter(null)
            webView.stopLoading()
            webView.destroy()
            popup?.destroy()
        } catch (e: Exception) { /* 忽略 */ }
        super.onDestroy()
    }

    companion object {
        const val EXTRA_URL = "edu_url"

        /** 适配模式：选中哪所学校 / 哪段脚本 / 谁维护的（界面上要署名） */
        const val EXTRA_ADAPTER_SCHOOL = "adapter_school"
        const val EXTRA_ADAPTER_NAME = "adapter_name"
        const val EXTRA_ADAPTER_MAINTAINER = "adapter_maintainer"

        /** 适配脚本的下载地址，**按顺序试**（同 Web/js/warehouse.js 的 SCRIPT_BASES） */
        const val EXTRA_ADAPTER_SCRIPTS = "adapter_scripts"

        /* v1.9.41 曾在这里放 `EXTRA_ADAPTER_SOURCE`（脚本正文）与
           `MAX_SCRIPT_SOURCE_CHARS`（它的长度上限）。v1.9.42 拆掉了这一路 ——
           包内不再有任何脚本，脚本一律按 [EXTRA_ADAPTER_SCRIPTS] 联网取。 */

        /** 默认入口：**空**。本工程不内置任何学校（v1.9.31 起），
         *  地址一律由用户提供 —— 没有地址时显示起步页而不是白屏。 */
        const val DEFAULT_URL = ""

        /**
         * 没有默认入口时显示的起步页。
         * **本工程不内置任何学校**，所以第一次打开教务浏览器时无地址可去；
         * 与其白屏，不如把「下一步做什么」写清楚。纯静态、无外链、不请求网络。
         */
        private const val START_PAGE_HTML = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:28px 22px;font:15px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#3a342b;background:#faf7f2}
h1{font-size:17px;margin:0 0 14px}ol{margin:0;padding-left:20px}li{margin:6px 0}
code{background:#eceae4;padding:1px 5px;border-radius:4px;font-size:13px}
p.tip{margin:18px 0 0;color:#7a7266;font-size:13px}</style></head><body>
<h1>先填一次你学校的教务地址</h1>
<ol>
<li>回到上一页，点「选择 / 添加我的学校」</li>
<li>输入学校名 + 教务系统网址（只填域名也行，如 <code>jwgl.xxx.edu.cn</code>）</li>
<li>保存后会自动回到这里并打开它；以后每次都是一键直达</li>
</ol>
<p class="tip">地址只保存在你的手机上，不会上传。本应用不预置任何学校。</p>
</body></html>"""

        private const val KEY_LAST_URL = "last_url"

        /* v1.9.43 删掉了 `KEY_FIT_WIDTH`（「适应屏幕 / 原始大小」的偏好键）。
           留着它反而有害：老用户的 SharedPreferences 里那条记录再没人读，
           将来谁看见会以为还有个开关在起作用。 */

        /**
         * 页面上的桥名。**全文件只定义一次**（挂桥处 + 注入的 shim 里都引用它）。
         *
         * v1.9.43 起这是页面上**唯一**的一座桥（自研抓页那座 `AndroidEduCapture`
         * 连同它的常量一起删了）。
         *
         * ⚠️ **常驻**，且不许 `removeJavascriptInterface`。
         * 表达「这一趟有效」的是 [adapterToken]，不是桥在不在。
         */
        private const val ADAPTER_BRIDGE_NAME = "AndroidAdapterHost"

        /** 脚本顶层异常落在页面上的变量名（见 injectAdapter） */
        private const val ADAPTER_ERR_VAR = "__youkeAdapterError"

        /**
         * 适配脚本这一趟的兜底时长。
         *
         * 给得比已删掉的自研抓页（8 秒）宽得多，因为脚本要**自己发教务接口请求**
         * （一个学期的课表、作息、学期配置，可能是三五次往返）。到点只提示、
         * 不判失败 —— 判失败会把一个只是慢的脚本掐死。
         */
        private const val ADAPTER_TIMEOUT_MS = 120_000L

        /** 脚本文件上限（实测最大 54 KB，给 2 MB 已经很宽了） */
        private const val MAX_SCRIPT_BYTES = 2 * 1024 * 1024

        /**
         * 装在页面上的宿主（shim）。
         *
         * 为什么宿主是**注入的 JS**、而不是直接给原生桥套个名字：
         * 上游要求的是「`showAlert` 返回一个 Promise」这类**异步**语义，
         * 而 `@JavascriptInterface` 的方法只能同步返回（同步返回就得阻塞
         * WebView 的 JS 线程等用户点弹窗 —— 那会直接把页面冻住）。
         * 所以中间必须有一层 JS：它挂 `window.shiguang*`，用一张 pending 表
         * 把原生回来的值转成 Promise 的 resolve。
         *
         * @param token 这一趟的令牌。它嵌在闭包里，**页面脚本猜不到**，
         *              也只能由它带到原生侧 —— 原生按它对门闩。
         *              UUID 只含十六进制与连字符，作为 JS 字面量无需转义。
         */
        private fun adapterShimJs(token: String) = """
(function () {
  var H = window.$ADAPTER_BRIDGE_NAME;
  if (!H || typeof H.host !== 'function') return;
  var TOKEN = "$token";
  var seq = 0, pending = {};

  /* 重装时先把上一趟还挂着的 Promise 收掉。
     用户在同一次会话里按第二次「重新执行」时，上一趟可能有脚本正 await 在弹窗上；
     不收掉它就永远等下去（页面看着好好的，流程再也不往下走）。 */
  var old = window.__shiguangPending;
  if (old) { for (var k in old) { try { old[k].resolve(null); } catch (e) { } } }

  window.__shiguangPending = pending;
  window.__shiguangReply = function (id, json) {
    var p = pending[id];
    if (!p) return;                     /* 迟到的回包（这一趟早结束了），丢掉 */
    delete pending[id];
    var v = null;
    try { v = JSON.parse(json); } catch (e) { v = null; }
    try { p.resolve(v); } catch (e2) { }
  };
  function ask(method, args) {
    return new Promise(function (resolve) {
      var id = 'a' + (++seq) + '_' + Date.now();
      pending[id] = { resolve: resolve };
      try { H.host(method, TOKEN, id, JSON.stringify(args || {})); }
      catch (e) { delete pending[id]; resolve(null); }
    });
  }
  /* 不需要回值的那两个（showToast / notifyTaskCompletion）不发 Promise */
  function fire(method, args) {
    try { H.host(method, TOKEN, '', JSON.stringify(args || {})); } catch (e) { }
  }
  function s(v) { return v == null ? '' : String(v); }

  window.shiguangBridge = {
    showToast: function (msg) { fire('showToast', { msg: s(msg) }); },
    notifyTaskCompletion: function () { fire('notifyTaskCompletion', {}); }
  };
  window.shiguangBridgePromise = {
    showAlert: function (title, message, confirm) {
      return ask('showAlert', { title: s(title), message: s(message), confirm: s(confirm) })
        .then(function (v) { return v === true; });
    },
    showPrompt: function (title, message, def, validator) {
      return ask('showPrompt', {
        title: s(title), message: s(message), def: s(def), validator: s(validator)
      }).then(function (v) { return (v === null || v === undefined) ? null : String(v); });
    },
    showSingleSelection: function (title, itemsJson, def) {
      var items = [];
      try { items = JSON.parse(itemsJson) || []; } catch (e) { items = []; }
      if (!(items instanceof Array)) items = [];
      var d = Number(def);
      return ask('showSingleSelection', { title: s(title), items: items, def: isNaN(d) ? 0 : d })
        .then(function (v) { return (v === null || v === undefined) ? null : Number(v); });
    },
    saveImportedCourses: function (json) {
      return ask('saveImportedCourses', { json: s(json) }).then(function (v) { return v === true; });
    },
    savePresetTimeSlots: function (json) {
      return ask('savePresetTimeSlots', { json: s(json) }).then(function (v) { return v === true; });
    },
    saveCourseConfig: function (json) {
      return ask('saveCourseConfig', { json: s(json) }).then(function (v) { return v === true; });
    }
  };
  /* 6 个老脚本写的是 AndroidBridge / AndroidBridgePromise（见文件头契约） */
  window.AndroidBridge = window.shiguangBridge;
  window.AndroidBridgePromise = window.shiguangBridgePromise;
})();
""".trimIndent()

        /**
         * 摘宿主。停止 / 交完结果 / 销毁都要跑。
         * 三个动作缺一不可：收掉挂着的 Promise、删掉两套别名、删掉回包入口。
         */
        private const val ADAPTER_TEARDOWN_JS = """
(function () {
  try {
    var p = window.__shiguangPending;
    window.__shiguangPending = {};
    if (p) { for (var k in p) { try { p[k].resolve(null); } catch (e) { } } }
    try { delete window.shiguangBridge; } catch (e) { window.shiguangBridge = undefined; }
    try { delete window.shiguangBridgePromise; } catch (e) { }
    try { delete window.AndroidBridge; } catch (e) { }
    try { delete window.AndroidBridgePromise; } catch (e) { }
    try { delete window.__shiguangReply; } catch (e) { }
  } catch (e) { }
})();
"""

        /* v1.9.43 起 `TIP_THROTTLE_MS` 只服务 [toast] 一处。
           它原来还兼着 showTip（弹窗节流），那条随自研抓页一起删了；
           常数留着是因为 toast 这条需求没变：适配脚本会成串发提示。 */
        private const val TIP_THROTTLE_MS = 600L

        /** 用户确认过证书问题的域名存这儿（见 rememberSslHost） */
        private const val KEY_SSL_HOSTS = "ssl_trusted_hosts"

        /** 记住的域名上限，超了整体清掉重来 */
        private const val MAX_SSL_TRUSTED = 5

        /**
         * 恒定使用桌面 UA。
         * 教务系统（正方等）基本只有 PC 版页面，课表表格也是 PC 布局，
         * 网页侧提取器同样按 PC 表格来定位 —— 换手机 UA 反而更容易拿到
         * 一个解析不了的精简页，所以这里不再提供 UA 切换。
         */
        private const val UA_DESKTOP =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

        private const val MAX_DOWNLOAD = 8 * 1024 * 1024
        /* v1.9.43 删掉了 `MAX_HTML_CHARS`（抓回来的整页 HTML 的长度上限）。
           它是自研抓页那条路的判据；现在网页侧只收「下载下来的文件」，
           大小上限是上面那个 MAX_DOWNLOAD。 */

    }
}

/**
 * 内嵌教务浏览器 -> 主界面 的结果通道。
 * 同进程直接传引用：下载下来的文件常有几 MB，塞进 Intent extra 会超过 Binder 上限。
 *
 * v1.9.43 去掉了一个字段：`html`（自研抓页抓回来的整页 HTML）。
 * 现在**只有两条出口**，都在这上面：
 *  · 下载文件（[fileBase64] + [fileName]）—— 教务系统自己的「导出课表」；
 *  · 适配脚本（[adapterJson]）。
 * 两条**共用 [url] 这一个来源字段**，所以网页侧不用为它们各开一套参数。
 */
object EduBus {
    @Volatile var fileBase64: String? = null
    @Volatile var fileName: String? = null
    @Volatile var url: String? = null

    /**
     * 适配脚本交回来的那一封信（v1.9.32）。
     * 形如 `{schoolName, adapterName, maintainer, courses[], timeSlots, config, saves}`。
     */
    @Volatile var adapterJson: String? = null

    fun clear() {
        fileBase64 = null
        fileName = null
        url = null
        adapterJson = null
    }
}

/**
 * 把任意字符串变成合法的 JS 字符串字面量，**同时也是合法的 JSON 字符串**。
 *
 * 顶层函数而不是某个 Activity 的私有方法：两个 Activity 都要用
 * （内嵌浏览器是「原生 → 学校页面」的回包，主界面是「原生 → 主页面」的回灌），
 * 各写一份迟早会漂移 —— 而这类转义漂移的症状是「某些校名带引号就炸」，
 * 平时根本测不出来。
 *
 * U+2028 / U+2029 要单独处理：它们是合法 JSON、但在 JS 里是**换行**，
 * 直接嵌进脚本会让注入的那行代码断成两半。
 */
internal fun jsQuoteString(s: String): String {
    val sb = StringBuilder(s.length + 16)
    sb.append('"')
    for (c in s) {
        when {
            c == '"' -> sb.append("\\\"")
            c == '\\' -> sb.append("\\\\")
            c == '\n' -> sb.append("\\n")
            c == '\r' -> sb.append("\\r")
            c == '\t' -> sb.append("\\t")
            c == '\u2028' -> sb.append("\\u2028")
            c == '\u2029' -> sb.append("\\u2029")
            c < ' ' -> sb.append(String.format("\\u%04x", c.code))
            else -> sb.append(c)
        }
    }
    sb.append('"')
    return sb.toString()
}
