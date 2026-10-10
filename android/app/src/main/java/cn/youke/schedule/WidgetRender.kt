package cn.youke.schedule

import android.app.PendingIntent
import android.content.Context
import android.graphics.Color
import android.view.View
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import java.time.LocalDate

/**
 * 把数据画成 RemoteViews。
 *
 * 单独抽一层是为了让「组件面板」和「列表项」共用同一套格式化：
 * 两处各写一份，时间早晚会不一致（一处 09:55、一处 9:55），
 * 而这种不一致在桌面上看着「也还行」，没人会去查。
 */
object WidgetRender {

    private val WEEK = arrayOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")

    /** 一块面板（今天 / 明天）用到的 viewId */
    data class PanelIds(
        val root: Int,
        val head: Int,
        val date: Int,
        val count: Int,
        val focus: Int,
        val focusName: Int,
        val focusState: Int,
        val focusPlace: Int,
        val focusTime: Int,
        /**
         * 「今天的课已上完」那一块（`match_parent` 宽 + 一行高 + 字居中）。
         * 它和 [focus] 互斥：有「最近一节课」用面板，课都上完了用这块。
         * 之所以不是复用面板，是因为面板里两行是给「课名 / 教室 + 时间」排的，
         * 装一句状态词会撑成两行高、字还贴左上角。
         * 宽度走 `match_parent` 是为了与课程行**同宽**（同一个宽度上下文），
         * 所以布局里**不许**给它加左右 margin。
         */
        val done: Int,
        val list: Int,
        val hint: Int
    )

    /** '10月3日 周六'；compact = '10/3 周六'（4×2 每栏只有 118dp 宽，用紧凑版） */
    fun dateLabel(date: LocalDate, compact: Boolean): String {
        val w = WEEK[date.dayOfWeek.value - 1]
        return if (compact) "${date.monthValue}/${date.dayOfMonth} $w"
        else "${date.monthValue}月${date.dayOfMonth}日 $w"
    }

    /** '#RRGGBB' -> 颜色；认不出来用兜底色（绝不把一个坏色值塞进 RemoteViews） */
    fun colorOf(hex: String, fallback: Int): Int =
        try {
            if (hex.isNullOrEmpty()) fallback else Color.parseColor(hex)
        } catch (e: Exception) {
            fallback
        }

    /**
     * 上课时间：`'09:55-11:30'`。
     *
     * 面板和列表行都走这一个函数 —— 两处各写一遍的话，早晚会变成
     * 一处 `09:55-11:30`、一处 `9:55`，桌面上一眼看不出问题，却已经不一致了。
     *
     * **契约（v1.9.45 写明）**：`start` 与 `end` 都一定是**合法钟点**。
     * 这条由**入口**保证，一共三道、口径一致：
     *   ① 网页侧 `store.js` 的 `dayCourses()` —— `if (!start || !end) return`，
     *      那一节在 `settings.times` 里没有时间就**整条不发**；
     *   ② 原生侧 [WidgetStore.coursesOn] —— `start` / `end` 认不出的整条剔掉；
     *   ③ 端到端断言快照里每条的 `start` / `end` 都匹配 `^\d{2}:\d{2}$`。
     * ⇒ 下面那个 `if` **不是**「end 可能缺失」的常态分支（按上面三条它永远为真），
     * 而是一层**兜底**：万一将来多一条数据来源没走① ②，宁可只显示开始时间，
     * 也别拼出「09:55-」让用户以为这课只上一瞬间。
     *
     * （旧注释写的是「结束时间缺失或算不出来时只给开始时间」，读起来像一条
     *  常态分支，与 ①② 的判据看着像两套口径 —— 其实是一套，**以入口为准**。）
     */
    fun timeRange(c: WidgetCourse): String =
        if (c.endMin > c.startMin) c.start + "-" + c.end else c.start

    /**
     * 渲染一块面板。
     *
     * @param courses null = 快照里没有这一天（从没推过 / 已过期），空 list = 这天没课
     * @param nowMin  当天第几分钟；-1 表示「这天还没到」（明天那一栏）
     * @param clickPi    点在面板本体上的动作（IMMUTABLE）
     * @param templatePi 列表项的点击**模板**（**必须 MUTABLE**，否则系统没法把
     *                   每一项的 fillInIntent 填进去）
     */
    fun bindPanel(
        ctx: Context,
        rv: RemoteViews,
        ids: PanelIds,
        date: LocalDate,
        label: String,
        compact: Boolean,
        courses: List<WidgetCourse>?,
        nowMin: Int,
        clickPi: PendingIntent,
        templatePi: PendingIntent
    ) {
        rv.setTextViewText(ids.date, label + dateLabel(date, compact))
        rv.setOnClickPendingIntent(ids.root, clickPi)
        rv.setOnClickPendingIntent(ids.head, clickPi)
        // 列表项自己的点击：交给模板，项里再用 fillInIntent 覆盖
        rv.setPendingIntentTemplate(ids.list, templatePi)

        if (courses == null) {
            showHint(ctx, rv, ids, if (WidgetStore.hasData(ctx)) "打开柚课更新" else "打开柚课导入课表")
            return
        }

        rv.setViewVisibility(ids.count, View.VISIBLE)
        rv.setTextViewText(ids.count, courses.size.toString() + "门")

        if (courses.isEmpty()) {
            showHint(ctx, rv, ids, if (nowMin < 0) "这天没有课" else "今天没有课")
            return
        }

        rv.setViewVisibility(ids.list, View.VISIBLE)
        rv.setViewVisibility(ids.hint, View.GONE)

        val focus = WidgetLogic.focus(courses, nowMin)
        val c = focus.course
        if (c == null) {
            // 今天的课都上完了：不留一块空白，明说。
            //
            // ⚠️ 这里**换用专门的那块**（布局里的 `*_done`），而不是把这句话塞进
            // [focus] 面板 —— 面板里两行是按「课名 / 教室 + 时间」排的，塞一句状态词
            // 的结果是**一个两行高的空框、字贴在左上角**（用户反馈过两次：
            // 先嫌框太大、字没居中；改成小胶囊之后又要「通栏、与课程同宽、压成一行高」）。
            // *_done 的形状：layout_width=match_parent（**通栏 ⇒ 与课程行同宽**，
            // 加左右 margin 就不对齐了）+ wrap_content 高 + maxLines=1（⇒ 一行高）
            // + gravity=center（⇒ 字居中）。
            rv.setViewVisibility(ids.focus, View.GONE)
            rv.setViewVisibility(ids.done, View.VISIBLE)
            rv.setTextViewText(ids.done, "今天的课已上完")
        } else {
            rv.setViewVisibility(ids.done, View.GONE)
            rv.setViewVisibility(ids.focus, View.VISIBLE)
            rv.setInt(
                ids.focus, "setBackgroundColor",
                ContextCompat.getColor(
                    ctx,
                    if (focus.phase == WidgetLogic.Phase.NOW) R.color.widget_accent_soft
                    else R.color.widget_focus_bg
                )
            )
            // 状态词已挪到课名那一行的右侧（原来是拼在下面那行的开头）——
            // 原来那行要塞「正在上课 · 教室」，教室只剩不到一半宽度；
            // 拆开后课名、教室、时间三个都不再被状态词挤。
            // 「明天第一节」在 4×2 每栏只有 110dp 宽时太长，缩短成「第一节」
            // （那一栏的表头已经写着「明天」了，不会歧义）。
            val state = when {
                focus.phase == WidgetLogic.Phase.NOW -> "正在上课"
                nowMin < 0 -> "第一节"
                else -> "下一节"
            }
            rv.setTextViewText(ids.focusName, c.name)
            rv.setTextViewText(ids.focusState, state)
            rv.setTextViewText(ids.focusPlace, if (c.loc.isNotEmpty()) c.loc else "—")
            rv.setTextViewText(ids.focusTime, timeRange(c))
        }
    }

    private fun showHint(ctx: Context, rv: RemoteViews, ids: PanelIds, text: String) {
        rv.setViewVisibility(ids.list, View.GONE)
        rv.setViewVisibility(ids.focus, View.GONE)
        rv.setViewVisibility(ids.done, View.GONE)
        rv.setViewVisibility(ids.count, View.GONE)
        rv.setViewVisibility(ids.hint, View.VISIBLE)
        rv.setTextViewText(ids.hint, text)
    }

    /**
     * 列表项。
     *
     * 左侧那根色条用课程自己的颜色 —— 和课表里的卡片同色，用户扫一眼
     * 就能把桌面和 App 里那张卡对上。当前/下一节整行底色高亮。
     *
     * 第二行是「教室 + 上课时间」：教室靠左（可缩）、时间靠右（不可缩）。
     */
    fun bindRow(
        ctx: Context,
        item: RemoteViews,
        course: WidgetCourse,
        highlighted: Boolean,
        textColor: Int,
        subColor: Int
    ) {
        item.setTextViewText(R.id.w_row_name, course.name)
        item.setTextViewText(
            R.id.w_row_loc,
            if (course.loc.isNotEmpty()) course.loc else course.teacher
        )
        // 时间固定用主色 —— 「时间 == accent」是整个组件的一条规则，
        // 面板上那处时间也是这个颜色，于是用户在哪儿都不用重新找。
        item.setTextViewText(R.id.w_row_time, timeRange(course))
        item.setInt(
            R.id.w_row_bar, "setBackgroundColor",
            colorOf(course.color, ContextCompat.getColor(ctx, R.color.widget_accent))
        )
        item.setTextColor(R.id.w_row_name, textColor)
        item.setTextColor(R.id.w_row_loc, subColor)
        item.setTextColor(
            R.id.w_row_time,
            ContextCompat.getColor(ctx, R.color.widget_accent)
        )
        item.setInt(
            R.id.w_row, "setBackgroundColor",
            if (highlighted) ContextCompat.getColor(ctx, R.color.widget_row_hl) else Color.TRANSPARENT
        )
    }
}
