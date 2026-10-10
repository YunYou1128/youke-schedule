package cn.youke.schedule

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import kotlin.math.roundToInt

/**
 * 课程表应用主界面。
 *
 * 采用 WebView 承载 web/ 目录下的课表页面：
 *  - 页面全部逻辑（渲染、CSV 导入、本地存储）在 assets 中，离线可用；
 *  - 原生侧只负责：安全区适配、文件选择器（CSV 导入）、返回键处理。
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView

    /** Web 端 <input type="file"> 的回调 */
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    /* 安全区尺寸（CSS 像素），供网页读取后自行留白 */
    @Volatile private var safeTop = 0
    @Volatile private var safeBottom = 0
    @Volatile private var safeLeft = 0
    @Volatile private var safeRight = 0

    /** 上次下发给页面的 safe-bottom，避免键盘动画期间连发的 insets 帧重复调 JS */
    private var lastReportedBottom = -1

    /**
     * 暴露给网页的安全区接口。
     * 页面在初始化、原生通知、加载完成三个时机调用 insets()，
     * 拿到状态栏 / 导航栏 / 刘海的实际高度（CSS 像素）。
     */
    private inner class SafeAreaBridge {
        @JavascriptInterface
        fun insets(): String =
            """{"top":$safeTop,"bottom":$safeBottom,"left":$safeLeft,"right":$safeRight}"""
    }

    /**
     * 暴露给网页的主题接口。
     *
     * 状态栏是透明浮在页面上的，图标（时间、电量）必须与页面底色反差，
     * 否则夜晚模式下会出现「浅色图标压在浅色顶栏上」看不清的情况。
     * 页面切换白天 / 夜晚模式时调用 setDark(1|0) 通知原生调整。
     */
    private inner class ThemeBridge {
        @JavascriptInterface
        fun setDark(dark: Int) {
            runOnUiThread { applyStatusBarAppearance(dark == 1) }
        }
    }

    private fun applyStatusBarAppearance(dark: Boolean) {
        // isAppearanceLightStatusBars = true  -> 深色图标（适合浅色背景）
        WindowInsetsControllerCompat(window, webView).isAppearanceLightStatusBars = !dark
    }

    /**
     * 暴露给网页的剪贴板接口（课程详情里的「复制」用）。
     *
     * 页面是 file:// 打开的，navigator.clipboard 在不同 WebView 版本上时有时无，
     * 走原生最稳。写系统剪贴板**不需要任何权限**，所以不涉及权限清单的变化。
     * 网页侧仍保留 execCommand / navigator.clipboard 两层兜底，
     * 在浏览器里直接打开网页时不会用到这个桥。
     */
    private inner class ClipboardBridge {
        @JavascriptInterface
        fun copy(text: String?) {
            if (text.isNullOrEmpty()) return
            runOnUiThread {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("柚课", text))
            }
        }
    }

    /**
     * 暴露给网页的桌面小组件接口。
     *
     * 页面每次写盘后（新增 / 编辑 / 删除课程、切换课表、改学期设置）
     * 都把「从今天起 56 天每天上什么课」的快照推过来。这里只做两件事：
     * 存下来、让桌面上的组件重画。快照**为什么**这么算、为什么不由原生算，
     * 见 web/js/store.js 的 buildWidgetData（一句话：周次与单双周的规则
     * 只该有一份，重写一遍必然和课表页漂移）。
     *
     * 存盘用 apply()（异步刷盘）没有时序问题：SharedPreferences 的**内存值**
     * 是同步更新的，紧接着 refreshAllWidgets 就能读到新快照。
     */
    private inner class WidgetBridge {
        @JavascriptInterface
        fun sync(json: String?) {
            if (json.isNullOrEmpty()) return
            val ctx = applicationContext
            WidgetStore.save(ctx, json)
            runOnUiThread { refreshAllWidgets(ctx) }
        }
    }

    /**
     * 暴露给网页的「保存文件」接口（分享课表里的「保存为 CSV」用）。
     *
     * 为什么非得走原生：页面是 file:// 打开的 WebView，`<a download>` 与
     * Blob URL 在没有 DownloadListener 的情况下会被**静默丢弃** ——
     * 用户以为存好了，翻遍手机也没有。网页侧仍保留 Blob 一路，
     * 那是在电脑浏览器里直接打开网页时用的。
     *
     * 写盘**不需要任何权限**，这是刻意的：
     *   · Android 10（API 29）及以上：走 MediaStore 放进系统的「下载」目录；
     *   · Android 9 及以下：退回应用自己的外部目录
     *     （`Android/data/<包名>/files/Download`）。
     * 低版本本来可以用 `Environment.getExternalStoragePublicDirectory` 直接写公共
     * 「下载」，但那要 `WRITE_EXTERNAL_STORAGE` —— 一旦申请，权限清单就不再是
     * 干净的「只有 INTERNET」，这个代价比「路径不那么好找」大得多。
     *
     * 同步返回：
     *   `ok:<人可读路径>` 成功　`err:<原因>` 失败
     */
    /**
     * 文件名清洗：剃掉不能进文件名、或者会让路径跑飞的字符，空则给个默认名。
     *
     * **两条落盘出口都走这一份**（「保存为 CSV」的 [ExportBridge] 与「发送到聊天」的
     * [writeShareCache]）。原先只有 writeShareCache 洗了、saveFile 没洗 ——
     * 当前因为网页侧（唯一的调用方）已经洗过而不可达，但「同一件事一处洗一处不洗」
     * 就是下一个「安静地错」：哪天页面不再是唯一调用方，一个斜杠进文件名要么直接写失败、
     * 要么把文件写到别的目录去，而且报错很难懂。
     */
    private fun safeFileName(name: String?, fallback: String): String =
        (name ?: "").replace(Regex("[\\\\/:*?\"<>|\\s]+"), "_").take(120).ifBlank { fallback }

    private inner class ExportBridge {
        @JavascriptInterface
        fun saveFile(name: String?, mime: String?, text: String?): String {
            if (name.isNullOrBlank() || text == null) return "err:参数为空"
            val type = if (mime.isNullOrBlank()) "text/csv" else mime
            val safe = safeFileName(name, "课表.csv")   // 名单侧无脑清洗一次，见 safeFileName
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    saveToDownloads(safe, type, text)
                } else {
                    saveToAppDir(safe, text)
                }
            } catch (e: Exception) {
                "err:" + (e.message ?: "写入失败")
            }
        }
    }

    /**
     * Android 10+：交给 MediaStore 写进公共「下载」目录。
     * 先以 IS_PENDING=1 插入（写入期间对其他应用不可见），写完再置 0 发布，
     * 这样别的应用不会读到一份还没写完的文件。
     */
    @RequiresApi(Build.VERSION_CODES.Q)
    private fun saveToDownloads(name: String, mime: String, text: String): String {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: return "err:无法创建文件"
        try {
            val out = contentResolver.openOutputStream(uri)
                ?: return "err:无法写入文件"
            out.use { it.write(text.toByteArray(Charsets.UTF_8)) }
        } finally {
            // 无论成败都要把 PENDING 落回去，否则会留下一个永远不可见的空文件
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            contentResolver.update(uri, values, null, null)
        }
        return "ok:" + Environment.DIRECTORY_DOWNLOADS + "/" + name
    }

    /** Android 9 及以下：写进应用自己的外部目录（无需权限，卸载时一并删除） */
    private fun saveToAppDir(name: String, text: String): String {
        val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir
        if (!dir.exists() && !dir.mkdirs()) return "err:无法创建目录"
        val f = File(dir, name)
        f.writeBytes(text.toByteArray(Charsets.UTF_8))
        return "ok:" + f.absolutePath
    }

    /* ==================================================================
       把课表当文件发给同学（分享弹层里的「发送到聊天」）

       走系统分享（ACTION_SEND + EXTRA_STREAM），微信 / QQ / 钉钉只要自己
       登记了接收这类文件就会出现。**这条路不需要任何权限**：
       Uri 由自家的 FileProvider 给出 content://，读取权随这一次 Intent
       单独授予（FLAG_GRANT_READ_URI_PERMISSION）——既不碰公共存储，
       也不把应用目录对外暴露，权限清单因此仍然是干净的一项 INTERNET。

       ⚠️ Android 11（API 30）起**必须声明 <queries>**，否则
       packageManager 查不到微信 / QQ / 钉钉，返回空列表且**不报错**，
       症状是「明明装了却说没装」。Manifest 已按包名声明这三个。
       ================================================================== */

    /** 目标应用包名；认不出来的（other）返回 null = 交给系统面板 */
    private fun packageOf(target: String?): String? = when (target) {
        "wechat" -> "com.tencent.mm"
        "qq" -> "com.tencent.mobileqq"
        "dingtalk" -> "com.alibaba.android.rimet"
        else -> null
    }

    private fun labelOf(target: String?): String = when (target) {
        "wechat" -> "微信"
        "qq" -> "QQ"
        "dingtalk" -> "钉钉"
        else -> "系统分享"
    }

    /**
     * 每次分享前把 share/ 清空重写 —— 缓存里只留当下这一份，不越攒越多。
     * 目录本身在 file_paths.xml 的白名单里（只放开了 cacheDir 下的 share/ 子目录）。
     */
    private fun writeShareCache(name: String, text: String): File {
        val dir = File(cacheDir, "share")
        dir.listFiles()?.forEach { it.delete() }
        if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("建不了临时目录")
        val safe = safeFileName(name, "课表.csv")
        return File(dir, safe).apply { writeBytes(text.toByteArray(Charsets.UTF_8)) }
    }

    private fun sendIntent(mime: String, uri: Uri, name: String?): Intent =
        Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, name)
            putExtra(Intent.EXTRA_TITLE, name)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }

    /**
     * 挑一个「那个应用真的会接」的类型。
     * 微信登记接收的范围历来比 QQ / 钉钉窄，`text/csv` 不一定在其中，
     * 所以不通就退一步用「任意类型」（代码里写作星号斜杠星号）再探一次 ——
     * 总要给对方一个点得开的入口；两次都不通才如实告诉用户。
     * 探的是**这个包**，所以定向发不会误伤。
     */
    private fun resolveFor(pkg: String, uri: Uri, name: String?, primary: String): Intent? {
        for (m in listOf(primary, "*/*")) {
            val i = sendIntent(m, uri, name).setPackage(pkg)
            if (packageManager.queryIntentActivities(i, 0).isNotEmpty()) return i
        }
        return null
    }

    private inner class ShareBridge {
        /**
         * target ∈ wechat / qq / dingtalk / other。
         * 同步返回：`ok:<应用名>` 已受理　`err:<原因>` 发不出去。
         */
        @JavascriptInterface
        fun shareFile(name: String?, mime: String?, text: String?, target: String?): String {
            if (text == null) return "err:没有内容可发送"
            val type = if (mime.isNullOrBlank()) "text/csv" else mime
            val f = try {
                writeShareCache(name ?: "课表.csv", text)
            } catch (e: Exception) {
                return "err:" + (e.message ?: "写不了临时文件")
            }
            val uri = try {
                FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", f)
            } catch (e: Exception) {
                return "err:换不出可分享的地址"
            }

            val pkg = packageOf(target)
            val label = labelOf(target)
            if (pkg == null) {
                // 「其他应用」：交回系统面板，装了什么人自己挑
                runOnUiThread {
                    try {
                        startActivity(Intent.createChooser(sendIntent(type, uri, name), "把课表发给同学"))
                    } catch (e: Exception) {
                        Toast.makeText(this@MainActivity, "没有可用的分享应用", Toast.LENGTH_SHORT).show()
                    }
                }
                return "ok:系统分享"
            }

            // 定向：先看这个包到底接不接，接就直接拉起来（不再多弹一层面板）
            val hit = resolveFor(pkg, uri, name, type) ?: return "err:$label 收不了这种文件"
            runOnUiThread {
                try {
                    startActivity(hit)
                } catch (e: Exception) {
                    Toast.makeText(this@MainActivity, "没能打开$label", Toast.LENGTH_SHORT).show()
                }
            }
            return "ok:$label"
        }

        /** 装了没有？给页面把没装的那个按钮就地置灰用（1 = 有，0 = 没有） */
        @Suppress("DEPRECATION")
        @JavascriptInterface
        fun hasApp(target: String?): Int {
            val pkg = packageOf(target) ?: return 0
            return try {
                packageManager.getPackageInfo(pkg, 0)
                1
            } catch (e: Exception) {
                0
            }
        }
    }

    /** 内嵌教务浏览器的启动 / 结果回传 */
    private val eduLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode == Activity.RESULT_OK) handleEduResult()
        }

    /**
     * 暴露给网页的教务导入接口。
     *
     * 网页（导入弹层里的「打开教务系统并导入课表」）调用 open()，
     * 原生打开内嵌浏览器；用户在那边登录、翻到课表页并点导入后，
     * 结果通过 [EduBus] 回到这里，再回灌给网页解析。
     */
    private inner class EduBridge {
        @JavascriptInterface
        fun open(url: String?) {
            runOnUiThread {
                val i = Intent(this@MainActivity, EduLoginActivity::class.java)
                if (!url.isNullOrBlank()) i.putExtra(EduLoginActivity.EXTRA_URL, url)
                eduLauncher.launch(i)
            }
        }

        /**
         * 带着「一所学校的适配脚本」打开内嵌浏览器（v1.9.32 的主通道）。
         *
         * 与 [open] 分开写、而不是给 open 加参数：Java 桥是按「方法名 + 参数个数」
         * 反射找方法的，改 open 的参数个数会让网页侧那句旧调用**静默失配**
         * （找不到方法就什么都不发生，连报错都没有）。
         *
         * ⚠️ 这个方法在 v1.9.41 有过一次**只改含义、不改个数**的改动
         * （第 6 参从「内置路径」变成「脚本正文」），v1.9.42 起那个参数
         * **连着它整套机制一起拆掉了**（参数 6 → 5）：
         * 自研脚本不再维护，本校那一行改为引用上游「正方教务-通用教务」，
         * 与所有社区学校一样按地址下载 —— 网页侧不再有任何正文要递过来。
         * 因为**包里的网页与这里的原生是同一次构建一起发的**，
         * 个数同改不会有失配窗口；反过来，谁要是只改一边，
         * 症状就是「点了那一行什么也没发生」。
         *
         * @param scriptsJson 适配脚本的**下载地址数组**（JSON 字符串，按顺序试）。
         *                    校验放在这里做，不信任网页侧递过来的东西。
         *                    一个地址都给不出来就**不打开**，
         *                    否则用户看到的是一个空壳页面。
         */
        @JavascriptInterface
        fun openWithAdapter(
            school: String?,
            adapterName: String?,
            maintainer: String?,
            scriptsJson: String?,
            importUrl: String?
        ) {
            val urls = parseScriptUrls(scriptsJson)
            if (urls.isEmpty()) return
            runOnUiThread {
                val i = Intent(this@MainActivity, EduLoginActivity::class.java)
                i.putExtra(EduLoginActivity.EXTRA_ADAPTER_SCHOOL, school ?: "")
                i.putExtra(EduLoginActivity.EXTRA_ADAPTER_NAME, adapterName ?: "")
                i.putExtra(EduLoginActivity.EXTRA_ADAPTER_MAINTAINER, maintainer ?: "")
                i.putStringArrayListExtra(EduLoginActivity.EXTRA_ADAPTER_SCRIPTS, ArrayList(urls))
                if (!importUrl.isNullOrBlank()) i.putExtra(EduLoginActivity.EXTRA_URL, importUrl)
                eduLauncher.launch(i)
            }
        }
    }

    /**
     * 解析网页侧递过来的脚本地址数组。
     *
     * **只收属于适配库官方分发前缀的 https 地址** —— 这个入口是网页侧能直接调到的，
     * 不加限制就等于给「让原生去下载任意地址」开了个口子。地址来自上游索引，
     * 与 web/js/warehouse.js 的 `SCRIPT_BASES` 是同一组（见 WAREHOUSE_PREFIXES）。
     */
    private fun parseScriptUrls(json: String?): List<String> {
        if (json.isNullOrBlank()) return emptyList()
        return try {
            val arr = org.json.JSONArray(json)
            val out = ArrayList<String>()
            for (i in 0 until arr.length()) {
                val u = arr.optString(i)
                if (isWarehouseUrl(u)) out.add(u)
            }
            out
        } catch (e: Exception) {
            emptyList()
        }
    }

    /**
     * 适配库索引的下载通道（网页侧叫 `AndroidWarehouse.getBinary`）。
     *
     * **为什么必须走原生**：主界面是 `file://` 页面，网页侧直接读网络会被跨域拦掉，
     * 而本工程的底线是「web/ 里从不发网络请求」（见 web/js/warehouse.js 的注释）。
     *
     * 回包约定与 `AndroidShare` / `AndroidExport` 保持一致：
     * 调 `WarehouseHost.onBinary(id, 'ok:<base64>')` 或 `'err:<原因>'`。
     * 时间上限：网页侧等 28 秒，这里连接 5 秒 + 读 15 秒 —— 必须留出余量，
     * 否则每次慢下载都会先由网页侧报「超时」，真实的失败原因（404 / 连不上）反而永远看不到。
     */
    private inner class WarehouseBridge {
        /**
         * 适配库的下载通道（网页侧叫 `AndroidWarehouse.getBinary`）。
         *
         * **为什么必须走原生**：主界面是 `file://` 页面，网页侧直接读网络会被跨域拦掉，
         * 而本工程的底线是「web/ 里从不发网络请求」（见 web/js/warehouse.js 的注释）。
         *
         * v1.9.33~v1.9.40 这里还有一个 `getBundledIndex`（读包内快照）。
         * **v1.9.41 起取消**：适配库的清单与脚本全部改成运行时下载，
         * assets 里不再有 `warehouse/` —— 少一个「读资产」的入口，
         * 也就少一个「让原生去读任意资产」的形状。留一条路，够用。
         *
         * 回包约定与 `AndroidShare` / `AndroidExport` 保持一致：
         * 调 `WarehouseHost.onBinary(id, 'ok:<base64>')` 或 `'err:<原因>'`。
         * 时间上限：网页侧等 28 秒，这里连接 5 秒 + 读 15 秒 —— 必须留出余量，
         * 否则每次慢下载都会先由网页侧报「超时」，真实的失败原因（404 / 连不上）反而永远看不到。
         */
        @JavascriptInterface
        fun getBinary(url: String?, callbackId: String?) {
            val u = url ?: return
            val id = callbackId ?: return
            /* 只允许从适配库的官方分发前缀下载（v1.9.40：两条 → 四条）。
               这是个网页侧能直接调到的入口，不设限就等于给「让原生去下载任意地址」
               开了口子 —— 地址本身来自上游索引，与 web/js/warehouse.js 的
               SOURCES 是同一组（见 WAREHOUSE_PREFIXES）。 */
            if (!isWarehouseUrl(u)) {
                replyWarehouse(id, "err:只允许从适配库的官方地址下载")
                return
            }
            thread {
                var conn: HttpURLConnection? = null
                try {
                    conn = (URL(u).openConnection() as HttpURLConnection).apply {
                        connectTimeout = 5000
                        readTimeout = 15000
                        instanceFollowRedirects = true
                        setRequestProperty("User-Agent", UA_DESKTOP_FETCH)
                        setRequestProperty("Accept", "*/*")
                    }
                    val code = conn.responseCode
                    if (code !in 200..299) {
                        replyWarehouse(id, "err:HTTP $code")
                        return@thread
                    }
                    val out = ByteArrayOutputStream()
                    var tooBig = false
                    conn.inputStream.use { input ->
                        val buf = ByteArray(32 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n <= 0) break
                            out.write(buf, 0, n)
                            if (out.size() > MAX_WAREHOUSE_BYTES) { tooBig = true; break }
                        }
                    }
                    if (tooBig) { replyWarehouse(id, "err:数据过大"); return@thread }
                    val bytes = out.toByteArray()
                    if (bytes.isEmpty()) { replyWarehouse(id, "err:拿到的是空数据"); return@thread }
                    replyWarehouse(id, "ok:" + Base64.encodeToString(bytes, Base64.NO_WRAP))
                } catch (e: Exception) {
                    replyWarehouse(id, "err:" + (e.message ?: "网络错误"))
                } finally {
                    conn?.disconnect()
                }
            }
        }
    }

    /**
     * 把下载结果回给网页。
     *
     * 两件事要注意：
     * ① **必须在 UI 线程**调 `evaluateJavascript`（这里是后台线程，所以切回去）；
     * ② 载荷可能很长（索引 base64 约 100 KB），走与 `callJs` 同一套分块机制 ——
     *    不共用的话将来内容变大就会出现「网页侧一直转圈、日志里什么都没有」。
     */
    private fun replyWarehouse(id: String, payload: String) {
        runOnUiThread {
            /* ⚠️ 这里吃过一跤（v1.9.33 真机翻车的根因）：head 里只有
               「if (window.WarehouseHost && window.WarehouseHost.onBinary)」这个**判断**，
               后面拼上 id / payload 后**没有调用** —— 注入的是一个逗号表达式（还带个
               悬空逗号，直接语法错误），被 try/catch 静默吞掉。于是原生侧下载/读快照
               全都成功了，回调却**永远到不了网页**，网页侧等满 28 秒报「下载超时」。
               v1.9.32 的「联网更新不了」和 v1.9.33 的「断网也载入不了」是同一个 bug，
               一直被「网络不通」掩盖着。教训：注入串必须断言「真的在调用」，不能只
               断言「判断还在」（smoke-test.js 里有对这一行的钉子）。 */
            val head = "(function(){try{if(window.WarehouseHost&&window.WarehouseHost.onBinary)" +
                "window.WarehouseHost.onBinary("
            val tail = ");}catch(e){}})()"
            try {
                if (payload.length <= JS_CHUNK) {
                    webView.evaluateJavascript(
                        head + jsQuote(id) + ", " + jsQuote(payload) + tail, null
                    )
                    return@runOnUiThread
                }
                webView.evaluateJavascript("window.__whChunks = [];", null)
                pushChunks(payload, 0, "__whChunks") {
                    webView.evaluateJavascript(
                        head + jsQuote(id) + ", window.__whChunks.join('')" + tail +
                            "window.__whChunks = null;", null
                    )
                }
            } catch (e: Exception) { /* 页面已经没了，忽略 */ }
        }
    }

    /**
     * 把内嵌浏览器带回的结果交给网页。
     *
     * v1.9.43 起只有两条：**适配脚本**和**下载下来的文件**。
     * 原来还有第三条「抓回来的整页 HTML」——它随自研抓页那条通道一起拆了，
     * 于是网页侧也不再有 `onEduHtml` 这个入口。
     *
     * 两条都可能有几 MB（一学期课表的 xls / pdf）；
     * 走 evaluateJavascript 的**入参**是没有大小限制的（有限制的是它的返回值），
     * 但单次脚本过长仍然不保险，所以超过阈值就分块注入。
     */
    private fun handleEduResult() {
        val b64 = EduBus.fileBase64
        val name = EduBus.fileName
        val url = EduBus.url
        val adapter = EduBus.adapterJson
        EduBus.clear()

        when {
            !adapter.isNullOrEmpty() -> callJs("onEduAdapter", adapter, url ?: "")
            !b64.isNullOrEmpty() -> callJs("onEduBuffer", b64, name ?: "")
            else -> Unit
        }
    }

    private fun callJs(fnName: String, payload: String, extra: String) {
        // expr 是「第一个实参」的 JS 表达式：小内容直接是字符串字面量，
        // 大内容则是分块拼好的数组 join
        val apply = { expr: String ->
            "(window.ScheduleApp && window.ScheduleApp.$fnName) ? " +
                "window.ScheduleApp.$fnName($expr, ${jsQuote(extra)}) : 0;"
        }
        if (payload.length <= JS_CHUNK) {
            webView.evaluateJavascript(apply(jsQuote(payload)), null)
            return
        }
        webView.evaluateJavascript("window.__eduChunks = [];", null)
        pushChunks(payload, 0, "__eduChunks") {
            webView.evaluateJavascript(
                apply("window.__eduChunks.join('')") + "window.__eduChunks = null;", null
            )
        }
    }

    private fun pushChunks(payload: String, index: Int, arrayName: String, onDone: () -> Unit) {
        if (index >= payload.length) { onDone(); return }
        val end = minOf(index + JS_CHUNK, payload.length)
        val part = payload.substring(index, end)
        webView.evaluateJavascript("window.$arrayName.push(${jsQuote(part)});") { _ ->
            pushChunks(payload, end, arrayName, onDone)
        }
    }

    /**
     * 把任意字符串安全地变成 JS 字符串字面量（含 U+2028 / U+2029 这类隐性换行）。
     *
     * 实现放在 EduLoginActivity.kt 的顶层（`jsQuoteString`）—— 那边往学校页面上
     * 回包时要用同一份转义，两处各写一遍必然会漂移。
     */
    private fun jsQuote(s: String): String = jsQuoteString(s)

    private val filePickerLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callback = filePathCallback ?: return@registerForActivityResult
            val uris = if (result.resultCode == Activity.RESULT_OK) {
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            } else {
                null
            }
            callback.onReceiveValue(uris)
            filePathCallback = null
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Android 15/16 起 targetSdk 35+ 强制 edge-to-edge，这里主动适配
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
        }

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        // WebView 自身的 padding 不可靠（部分版本内容不随 padding 缩放），
        // 套一层 FrameLayout 当根布局，软键盘让位改成调它的 padding
        val root = android.widget.FrameLayout(this)
        root.addView(
            webView,
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        setContentView(root)

        // 状态栏 / 导航栏 / 刘海 / 软键盘让位：
        // 状态栏不在原生侧给 WebView 加 padding，而是把实际像素值下发给页面，
        // 由页面统一绘制留白 —— 既避免遮挡系统栏，也避免原生与网页双重留白。
        // 软键盘不同：edge-to-edge 之后 Manifest 里的 adjustResize 已经不起作用
        // （与 EduLoginActivity 同一个坑），不自己消费 IME insets 的话，键盘会
        // 直接盖住 WebView —— 弹层（重命名课表、导入、表单）里的输入框全被挡住，
        // 用户看不到自己输入的内容。这里把键盘高度转成根布局的底部 padding，
        // WebView 随之变矮，底部弹层贴着的新视口上移，焦点输入框自动滚进可视区。
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            root.setPadding(0, 0, 0, ime)
            val d = resources.displayMetrics.density
            safeTop = (bars.top / d).roundToInt()
            // 键盘弹起时导航栏本来就被键盘盖住，底部安全区归零 ——
            // 否则弹层贴着键盘的那条边会再空出一截导航栏高度的空白
            safeBottom = if (ime > 0) 0 else (bars.bottom / d).roundToInt()
            safeLeft = (bars.left / d).roundToInt()
            safeRight = (bars.right / d).roundToInt()
            // 键盘弹出 / 收起动画期间 insets 会连发很多帧，JS 调用只在
            // safeBottom 真正变化时执行一次（padding 每帧都调，跟着键盘平滑移动）
            if (safeBottom != lastReportedBottom) {
                lastReportedBottom = safeBottom
                webView.evaluateJavascript(
                    "window.__applySafeArea && window.__applySafeArea()", null
                )
            }
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(root)

        configureWebView()

        // 初始状态先跟随系统；页面加载后会按用户选择的主题调用 setDark() 覆盖
        applyStatusBarAppearance(isNightMode())

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            webView.loadUrl(ASSET_URL)
        }

        setupBackPressed()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // localStorage：保存课表数据
            databaseEnabled = true
            allowFileAccess = true            // 加载 assets 里的本地页面必须有它
            /**
             * `allowContentAccess` **刻意保持 true**（方案里原本要关成 false，这里没关，
             * 理由如下 —— 关之前先想到「谁会用到 content://」）：
             *
             * 页面导入课表时走 `<input type=file>` → 原生 `onShowFileChooser` 拉起系统选择器
             * → 选中的文件是**一个 `content://` Uri**（SAF / MediaStore 给的），页面再
             * 用 `FileReader` 把它读出来（`csv.js` / `importer.js` 都这么读）。WebView 打开
             * 这个 `content://` 正好走的就是 `allowContentAccess` 这条门。
             * 方案里写的「本地页面用不到 content://」只看到了**怎么拉起选择器**（自实现，
             * 确实不依赖它），漏了**选完之后怎么读**（这一步依赖它）。
             *
             * 关掉它的收益很小：主页面是自家的 `file://` 页面、B-4 又把导航锁死在 assets 内，
             * 外部页面根本进不来，content:// 这条门没有外部入口。风险却是「导入课表整个失效」
             * 这种核心功能级的回归，而且**无头测试测不到、只能真机**。
             * ⇒ 维持 true，并把它列进真机回归清单：想关的话须先真机跑通一次「选择文件导入」。
             */
            allowContentAccess = true
            /**
             * 下面这两条是「file:// 页面的跨源访问能力」，**关掉**（v1.9.29）。
             * 判据不是「方案里写了」，而是**全量排查过 `web/`**：页面里
             * `fetch(` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `Worker` **一处都没有**
             * （`new Response(blob).arrayBuffer()` 那种是读内存里的 Blob，不走网络也不走 file://）。
             * 所以关掉它们不会影响任何现有功能，却砍掉了「万一将来有人往页面里加一句外链 /
             * 一次 fetch，本地上下文的能力就被递出去」这条隐患 —— 这是「主 WebView 对外开放面」
             * 那一族里最实在的一条，也正是复检报告里一直挂着的
             * 「主界面 `allowUniversalAccessFromFileURLs`」。
             */
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            useWideViewPort = true
            loadWithOverviewMode = true
            /**
             * 缩放**放开**（v1.9.45；此前一直是 setSupportZoom(false)）：
             * 课表七列在 360dp 屏上字号很小（课程名 11.5px），视力不佳的用户
             * 需要双指放大；禁缩放同时也关掉了系统辅助功能的一部分能力，
             * 属无障碍问题，与此前改掉的 `user-scalable=no`（index.html）是一对。
             *
             * 放开的代价是可控的：布局不靠禁缩放维持 —— 「一屏 8 节」是
             * JS 按**可视高度**算行高实现的（见 fitRows），捏合放大不改行高、
             * 也不会横向溢出（七列等宽、页面本身没有最小宽度约束）。
             *
             * `displayZoomControls = false` **保留**：那对 ± 悬浮按钮会挡住
             * 课表的卡片，系统自带的双指捏合已经够了。
             */
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = false
            /* v1.9.45：从 LOAD_NO_CACHE 改成默认。
               页面是 `file:///android_asset/` 的本地文件，本来就不走网络，
               LOAD_NO_CACHE 对它的唯一效果是**每次启动都重新读一遍磁盘**，
               换不来任何新鲜度（本地文件不会变）。改回默认后，WebView 可以
               用系统的资源缓存，冷启动略快一点。 */
            cacheMode = WebSettings.LOAD_DEFAULT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // 页面自带深色主题，禁止 WebView 强制反色
                forceDark = WebSettings.FORCE_DARK_OFF
            }
        }

        // 安全区接口：供网页读取状态栏 / 导航栏尺寸
        webView.addJavascriptInterface(SafeAreaBridge(), "AndroidSafeArea")

        // 主题接口：供网页在切换白天 / 夜晚模式时同步状态栏图标颜色
        webView.addJavascriptInterface(ThemeBridge(), "AndroidTheme")

        // 教务导入接口：网页点「打开教务系统并导入课表」时启动内嵌浏览器
        webView.addJavascriptInterface(EduBridge(), "AndroidEdu")

        // 剪贴板接口：课程详情里「复制」与分享课表里的「复制到剪贴板」用
        webView.addJavascriptInterface(ClipboardBridge(), "AndroidClipboard")

        // 保存文件接口：分享课表里的「保存为 CSV 文件」用（见 ExportBridge）
        webView.addJavascriptInterface(ExportBridge(), "AndroidExport")

        // 发送文件接口：分享课表里的「发送到聊天」用（见 ShareBridge）
        webView.addJavascriptInterface(ShareBridge(), "AndroidShare")

        // 桌面小组件接口：页面每次写盘后把课表快照推过来
        webView.addJavascriptInterface(WidgetBridge(), "AndroidWidget")

        // 适配库下载接口：页面拉「学校 → 教务」那张索引时用（见 WarehouseBridge）。
        // 网页侧是 file://，自己 fetch 会被跨域拦掉，只能走原生。
        webView.addJavascriptInterface(WarehouseBridge(), "AndroidWarehouse")

        webView.webViewClient = object : WebViewClient() {
            /**
             * 只放行本地 assets 页面，其余一律**吃掉**。
             *
             * 主界面是本地 `file://` 页面，正常不会发生导航 —— 但这个 WebView 上挂着
             * **一堆原生桥**（剪贴板 / 保存文件 / 分享 / 小组件 / 教务导入），一旦因任何原因
             * 跳到外部地址，就等于让外部页面站在这一排桥面前。此前这里**只重写了
             * onPageFinished**、没有任何拦截点（`loadUrl()` 是应用自己发起的、不经过这里，
             * 所以初始加载不受影响；被拦的是**页面发起的**导航）。
             */
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val u = request?.url?.toString() ?: return true
                return !u.startsWith(ASSET_PREFIX)
            }

            // 页面加载完成后补发一次安全区尺寸，避免首帧时机错位
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                view?.evaluateJavascript(
                    "window.__applySafeArea && window.__applySafeArea();" +
                        "window.ScheduleApp && window.ScheduleApp.applyTheme && window.ScheduleApp.applyTheme()",
                    null
                )
            }
        }

        webView.webChromeClient = object : WebChromeClient() {

            // Web 端 <input type="file"> -> 系统文件选择器
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback

                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "*/*"
                    // 支持四种课表来源：CSV / Excel(.xls,.xlsx) / PDF
                    // 另附 application/octet-stream —— 部分文件管理器不识别 Office MIME，
                    // 不加这一项会导致文件在选择器里变灰无法选中。
                    putExtra(
                        Intent.EXTRA_MIME_TYPES,
                        arrayOf(
                            "text/csv",
                            "text/comma-separated-values",
                            "text/plain",
                            "application/csv",
                            "application/vnd.ms-excel",
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                            "application/pdf",
                            "application/octet-stream"
                        )
                    )
                    addCategory(Intent.CATEGORY_OPENABLE)
                }

                return try {
                    filePickerLauncher.launch(Intent.createChooser(intent, "选择课表文件"))
                    true
                } catch (e: Exception) {
                    filePathCallback = null
                    Toast.makeText(this@MainActivity, "无法打开文件管理器", Toast.LENGTH_SHORT).show()
                    false
                }
            }

            // WebView 默认不弹出 alert / confirm，需自行实现。
            // 页面上所有确认都改成了自绘弹层（见 web/js/app.js 的 openConfirm），
            // 这里保留只是为了兜底：万一哪次改动又漏下一个 window.confirm，
            // 至少还能正常弹出来，而不是点了没反应。
            override fun onJsAlert(
                view: WebView?,
                url: String?,
                message: String?,
                result: JsResult?
            ): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }

            override fun onJsConfirm(
                view: WebView?,
                url: String?,
                message: String?,
                result: JsResult?
            ): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> result?.cancel() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }
        }

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
    }

    /** 返回键：先让网页处理弹层 -> 再网页返回 -> 最后退出 */
    private fun setupBackPressed() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // 网页侧自己决定这次返回干什么（子弹层退回它的父层 / 关闭整层弹层），
                // 原生只问一句「消费掉了吗」。
                // 页面没有 window.handleBack（加载失败 / 脚本报错）时返回 false，
                // 让系统返回照常生效——返回键失灵比退出应用糟糕得多。
                webView.evaluateJavascript(
                    "(function(){return !!(window.handleBack&&window.handleBack()===true);})()"
                ) { value ->
                    if (value == "true") return@evaluateJavascript
                    if (webView.canGoBack()) webView.goBack() else finish()
                }
            }
        })
    }

    private fun isNightMode(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private companion object {
        /** 本地页面目录前缀：`shouldOverrideUrlLoading` 只放行这个前缀的导航 */
        const val ASSET_PREFIX = "file:///android_asset/"

        const val ASSET_URL = ASSET_PREFIX + "web/index.html"

        /** 单次 evaluateJavascript 注入的字符上限，超过就分块（见 callJs） */
        const val JS_CHUNK = 400_000

        /**
         * 适配库分发的**官方前缀白名单**（v1.9.40：从两条扩到四条）。
         *
         * 上游作者自己维护了多份分发入口，国内网络下通不通差别很大
         * （v1.9.32 只认 GitHub 系域名，相当一部分用户真机「点了更新没反应」）。
         * 这四条与 `web/js/warehouse.js` 的 `SOURCES` **一一对应、同序** ——
         * 那边是唯一事实源，这里只是把同一组前缀再钉一遍。
         *
         * ⚠️ **改一处必须改两处**：网页侧拼出地址、原生侧据此放行，
         * 对不上就是「点了更新没反应」，而且是**静默失败**（界面上看不到任何报错）。
         * `smoke-test.js` 里有咬这两处的形状断言。
         *
         * 安全姿态不变：仍是**固定的 https 前缀白名单**，网页侧依旧调不到任意地址。
         */
        val WAREHOUSE_PREFIXES = listOf(
            "https://gitee.com/XingHeYuZhuan-gh/",
            "https://cdn.jsdelivr.net/gh/ShiGuangSchedule/",
            "https://raw.githubusercontent.com/ShiGuangSchedule/",
            "https://git.itdong.me/XingHeYuZhuan/"
        )

        /** 这个地址是不是适配库的官方分发地址（唯一判定入口，两处调用共用） */
        fun isWarehouseUrl(u: String?): Boolean {
            val s = u ?: return false
            return WAREHOUSE_PREFIXES.any { s.startsWith(it) }
        }

        /** 索引现在 75 KB，给 4 MB 已经很宽了（防止某个地址返回一大坨东西） */
        const val MAX_WAREHOUSE_BYTES = 4 * 1024 * 1024

        /* v1.9.41 曾在这里放一个 `MAX_SCRIPT_SOURCE_CHARS`（内置脚本正文的长度
           上限）。v1.9.42 拆掉了「脚本正文」这一路 —— 包里不再有任何脚本，
           桥的 `openWithAdapter` 也不再收文本，这个上限没有存在意义了。 */

        /** 下载索引 / 脚本时用的 UA。大部分 CDN 对空 UA 会直接拒绝 */
        const val UA_DESKTOP_FETCH =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    }
}
