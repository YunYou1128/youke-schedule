package cn.youke.schedule

import android.content.Context
import org.json.JSONObject
import java.time.LocalDate

/**
 * 桌面小组件的数据层。
 *
 * ## 数据是谁算的
 *
 * 小组件读不到课表：数据在 WebView 的 localStorage 里，那是一个只有网页
 * 自己能进的世界。所以由页面把「从今天起 56 天每天上什么课」算好，
 * 经 [MainActivity] 的 WidgetBridge 推过来，在这里落盘。
 *
 * **周次、单双周、节次→钟点、课程配色这些规则只在 store.js 里有一份**，
 * 这一层一条都不重算。重算的代价不是「多写点代码」，而是两边慢慢漂移，
 * 最后表现成「课表上是第 3 节、桌面上显示第 2 节」——而且谁都不会报错。
 * 这里只做一件事：**按日期把那天排好的数组取出来**。
 *
 * ## 快照长什么样
 *
 * ```json
 * { "v":1, "schedule":"大三上", "pushedAt":1759488000000, "start":"2026-10-03",
 *   "days": { "2026-10-03": [ {"name":"高等数学","loc":"教三302",
 *                             "start":"08:00","end":"09:35","color":"#C0504D", …} ],
 *             "2026-10-04": [] } }
 * ```
 *
 * `days` 里**每一天都有键**，没课就是空数组。这不是啰嗦：
 * 原生要靠「键在、数组为空」和「键不在」区分两件完全不同的事——
 * 前者是「这天没课」，后者是「快照已经过期，请打开柚课更新」。
 * 少了这个区分，组件在没课的日子只会一律显示「打开柚课」，等于没做。
 */

/** 快照里的一节课。start / end 已经是 'HH:MM' 钟点（不是节次）。 */
data class WidgetCourse(
    val id: String,
    val name: String,
    val teacher: String,
    val loc: String,
    val start: String,
    val end: String,
    val color: String
) {
    val startMin: Int get() = toMinutes(start)
    val endMin: Int get() = toMinutes(end)
}

/** 'HH:MM' -> 当天第几分钟；认不出来返回 -1（宁可判非法，也别猜一个值出来） */
internal fun toMinutes(hhmm: String): Int {
    val p = hhmm.split(':')
    if (p.size != 2) return -1
    val h = p[0].trim().toIntOrNull() ?: return -1
    val m = p[1].trim().toIntOrNull() ?: return -1
    return if (h in 0..23 && m in 0..59) h * 60 + m else -1
}

/** 现在是一天中的第几分钟（和 [toMinutes] 同一把尺子，才能直接比大小） */
internal fun nowMinutes(): Int {
    val t = java.time.LocalTime.now()
    return t.hour * 60 + t.minute
}

object WidgetStore {

    private const val PREFS = "schedule_widget"
    private const val KEY = "snapshot"

    /**
     * 解析结果的进程级缓存。
     *
     * 同一份快照会被读两次：组件刷新（onUpdate，主线程）与列表取数
     * （RemoteViewsFactory.onDataSetChanged，binder 线程）。56 天的 JSON
     * 有几十 KB，每次重新解析不划算。缓存以**原文**为键，页面重推一次
     * 内容就变了，缓存自动失效，不需要谁记得来清。
     */
    @Volatile private var cachedRaw: String? = null

    @Volatile private var cached: JSONObject? = null

    fun save(ctx: Context, json: String) {
        prefs(ctx).edit().putString(KEY, json).apply()
        cachedRaw = null
        cached = null
    }

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    private fun snapshot(ctx: Context): JSONObject? {
        val raw = prefs(ctx).getString(KEY, null)
        if (raw.isNullOrEmpty()) {
            cachedRaw = null
            cached = null
            return null
        }
        if (raw == cachedRaw) return cached
        val parsed = try {
            JSONObject(raw)
        } catch (e: Exception) {
            null            // 半截 JSON：当成「没有数据」，而不是崩在渲染里
        }
        cachedRaw = raw
        cached = parsed
        return parsed
    }

    /** 有没有拿到过数据（从没打开过应用时是 false） */
    fun hasData(ctx: Context): Boolean = snapshot(ctx) != null

    /** 这份快照推自哪张课表（小组件上用来提示「这是哪份数据」） */
    fun scheduleName(ctx: Context): String = snapshot(ctx)?.optString("schedule") ?: ""

    /**
     * 某一天的课。
     *
     * **null 表示快照里没有这一天**（从没打开过应用 / 快照已经过期），
     * 空 list 表示「这天没课」。两者必须让调用方分得清，见文件头注释。
     */
    fun coursesOn(ctx: Context, date: LocalDate): List<WidgetCourse>? {
        val days = snapshot(ctx)?.optJSONObject("days") ?: return null
        val arr = days.optJSONArray(date.toString()) ?: return null
        val out = ArrayList<WidgetCourse>(arr.length())
        for (i in 0 until arr.length()) {
            val c = arr.optJSONObject(i) ?: continue
            val name = c.optString("name")
            val start = c.optString("start")
            val end = c.optString("end")
            /* 这里是「一条课算不算数」的**唯一判据**（口径见 WidgetRender.timeRange
               的那段契约注释）：名字为空、或 start / end 认不出来，整条剔掉。
               网页侧 `store.js → dayCourses()` 已经先拦过一道（那节没有时间就不发），
               这里再拦一道不是不信任它 —— 快照是磁盘上的 JSON，可能来自旧版本。 */
            if (name.isEmpty() || toMinutes(start) < 0 || toMinutes(end) < 0) continue
            out.add(
                WidgetCourse(
                    id = c.optString("id"),
                    name = name,
                    teacher = c.optString("teacher"),
                    loc = c.optString("loc"),
                    start = start,
                    end = end,
                    color = c.optString("color")
                )
            )
        }
        // 页面那边已经排过序了。这里再排一次不是不信任它，而是这一步错了
        // 会「安静地错」：组件上显示的「下一节」变成第 2 节，没有任何提示。
        return out.sortedBy { it.startMin }
    }
}

object WidgetLogic {

    enum class Phase { NOW, NEXT, DONE }

    /** 这一刻该强调的那节课，以及它处于什么状态 */
    data class Focus(val course: WidgetCourse?, val phase: Phase)

    /**
     * 「距离当前时间最近的一节课」到底该是哪一节。
     *
     * 正在上的**最优先**——用户此刻最需要知道的不是「下一节在哪间教室」，
     * 而是「我现在在哪间教室」。同一时刻时间有重叠时取开始最晚的那门
     * （最贴近现在）。都不在上课，就取接下来最近的一节；
     * 今天全上完了返回 DONE，组件显示「今天的课已上完」而不是空白。
     *
     * @param nowMin 当天第几分钟。明天的课要传 -1（都还没上，一律按 NEXT 处理）。
     */
    fun focus(list: List<WidgetCourse>, nowMin: Int): Focus {
        var ongoing: WidgetCourse? = null
        for (c in list) {
            if (c.startMin <= nowMin && nowMin < c.endMin) {
                val cur = ongoing
                if (cur == null || c.startMin > cur.startMin) ongoing = c
            }
        }
        ongoing?.let { return Focus(it, Phase.NOW) }

        val next = list.firstOrNull { it.startMin > nowMin }
        return if (next != null) Focus(next, Phase.NEXT) else Focus(null, Phase.DONE)
    }
}
