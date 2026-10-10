package cn.youke.schedule

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.RemoteViews
import java.time.LocalDate

/**
 * 桌面小组件的渲染入口。
 *
 * 两个组件：
 *  · **2×2 今日课程**   —— 日期星期 / 今天共几门 / 最近一节课（课名 + 地点）/ 上下滑动看其余
 *  · **4×2 今明日课程** —— 左右两栏，每栏与 2×2 同构（左今天、右明天）
 *
 * ## 为什么是两个类
 *
 * 一个 `<receiver>` 只能挂**一份** `android.appwidget.provider` 元数据，
 * 而组件的尺寸、名称、初始布局都写在那里。想提供两个组件，就必须有两个
 * receiver；又因为「广播发给谁」是按 ComponentName（包名 + 类名）算的，
 * 两个 receiver 若指向同一个类，ComponentName 会撞在一起，
 * refreshAll 就只能刷到其中一半。所以这里两个空子类，逻辑全在基类。
 *
 * ## 刷新时机
 *
 * 1. 页面推来新数据（[WidgetBridge] -> [refreshAll]）；
 * 2. 系统按 `updatePeriodMillis` 定时调 onUpdate（30 分钟一次）——
 *    它同时负责**跨天**：过了午夜组件会自己换成新的一天；
 * 3. 用户重新添加 / 改变组件尺寸。
 *
 * 这里刻意**不用精确闹钟**去卡每节课的上下课瞬间：那要 SCHEDULE_EXACT_ALARM
 * 权限，而本应用对权限是极简的（只有 INTERNET 一条）。30 分钟的粒度，
 * 加上「点一下进应用就刷新」，对看课表这件事够用。
 */
abstract class BaseWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        for (id in ids) render(ctx, mgr, id)
    }

    override fun onAppWidgetOptionsChanged(
        ctx: Context, mgr: AppWidgetManager, id: Int, newOptions: Bundle?
    ) {
        // 用户拖动改变了尺寸：列表能露出几行变了，重画一次
        render(ctx, mgr, id)
    }
}

/** 2×2「今日课程」 */
class WidgetTodayProvider : BaseWidgetProvider()

/** 4×2「今明日课程」 */
class WidgetTwoDayProvider : BaseWidgetProvider()

/** 桌面上所有小组件重画一遍（数据变了之后调用） */
fun refreshAllWidgets(ctx: Context) {
    val app = ctx.applicationContext
    val mgr = AppWidgetManager.getInstance(app) ?: return
    val comps = arrayOf(
        ComponentName(app, WidgetTodayProvider::class.java),
        ComponentName(app, WidgetTwoDayProvider::class.java)
    )
    for (comp in comps) {
        for (id in mgr.getAppWidgetIds(comp)) render(app, mgr, id)
    }
}

/** 按组件**实际使用的布局**决定画哪一个 —— 不靠「谁注册在前」这种巧合 */
private fun render(ctx: Context, mgr: AppWidgetManager, id: Int) {
    val info = mgr.getAppWidgetInfo(id)
    if (info != null && info.initialLayout == R.layout.widget_twoday) renderTwo(ctx, mgr, id)
    else renderToday(ctx, mgr, id)
}

/* notifyAppWidgetViewDataChanged 的两个重载（单 id 与数组）在 API 36 里
   都被标了 deprecated，但**没有可用的替代**：官方新的路子是
   RemoteCollectionItems / partiallyUpdate，前提都是「所有项由我们一次构造好」，
   而这里的数据要按日期从 Service 里取（见 WidgetListFactory）。
   继续用，抑制警告，并把它写在这里，免得下次有人以为是漏改。 */
@Suppress("DEPRECATION")
private fun renderToday(ctx: Context, mgr: AppWidgetManager, id: Int) {
    val rv = RemoteViews(ctx.packageName, R.layout.widget_today)
    val today = LocalDate.now()
    WidgetRender.bindPanel(
        ctx, rv,
        WidgetRender.PanelIds(
            root = R.id.w_today_root,
            head = R.id.w_today_head,
            date = R.id.w_today_date,
            count = R.id.w_today_count,
            focus = R.id.w_today_focus,
            focusName = R.id.w_today_focus_name,
            focusState = R.id.w_today_focus_state,
            focusPlace = R.id.w_today_focus_place,
            focusTime = R.id.w_today_focus_time,
            done = R.id.w_today_done,
            list = R.id.w_today_list,
            hint = R.id.w_today_hint
        ),
        date = today,
        label = "",
        compact = false,
        courses = WidgetStore.coursesOn(ctx, today),
        nowMin = nowMinutes(),
        clickPi = openApp(ctx),
        templatePi = openAppTemplate(ctx)
    )
    bindList(rv, R.id.w_today_list, WidgetListService.intentFor(ctx, 0), id)
    mgr.updateAppWidget(id, rv)
    // 列表的内容是 RemoteViewsService 那边取的，必须单独通知它重取一次；
    // 少了这一句，面板上的字都变了、列表却还停在上一版（看着就像「组件没刷新」）
    mgr.notifyAppWidgetViewDataChanged(intArrayOf(id), R.id.w_today_list)
}

@Suppress("DEPRECATION")   // 同上：两个重载都 deprecated，但没有替代
private fun renderTwo(ctx: Context, mgr: AppWidgetManager, id: Int) {
    val rv = RemoteViews(ctx.packageName, R.layout.widget_twoday)
    val today = LocalDate.now()
    val tomorrow = today.plusDays(1)
    val pi = openApp(ctx)
    val piTpl = openAppTemplate(ctx)
    // 两栏之间那点缝隙也得能点，否则用户正好戳在中间会「没反应」
    rv.setOnClickPendingIntent(R.id.w_twoday_root, pi)

    WidgetRender.bindPanel(
        ctx, rv,
        WidgetRender.PanelIds(
            root = R.id.w_t1_root,
            head = R.id.w_t1_head,
            date = R.id.w_t1_date,
            count = R.id.w_t1_count,
            focus = R.id.w_t1_focus,
            focusName = R.id.w_t1_focus_name,
            focusState = R.id.w_t1_focus_state,
            focusPlace = R.id.w_t1_focus_place,
            focusTime = R.id.w_t1_focus_time,
            done = R.id.w_t1_done,
            list = R.id.w_t1_list,
            hint = R.id.w_t1_hint
        ),
        date = today,
        label = "今天 ",
        compact = true,
        courses = WidgetStore.coursesOn(ctx, today),
        nowMin = nowMinutes(),
        clickPi = pi,
        templatePi = piTpl
    )

    WidgetRender.bindPanel(
        ctx, rv,
        WidgetRender.PanelIds(
            root = R.id.w_t2_root,
            head = R.id.w_t2_head,
            date = R.id.w_t2_date,
            count = R.id.w_t2_count,
            focus = R.id.w_t2_focus,
            focusName = R.id.w_t2_focus_name,
            focusState = R.id.w_t2_focus_state,
            focusPlace = R.id.w_t2_focus_place,
            focusTime = R.id.w_t2_focus_time,
            done = R.id.w_t2_done,
            list = R.id.w_t2_list,
            hint = R.id.w_t2_hint
        ),
        date = tomorrow,
        label = "明天 ",
        compact = true,
        courses = WidgetStore.coursesOn(ctx, tomorrow),
        // 明天还没到：不判断「正在上课」，一律按「下一节」显示第一节
        nowMin = -1,
        clickPi = pi,
        templatePi = piTpl
    )

    bindList(rv, R.id.w_t1_list, WidgetListService.intentFor(ctx, 0), id)
    bindList(rv, R.id.w_t2_list, WidgetListService.intentFor(ctx, 1), id)

    mgr.updateAppWidget(id, rv)
    mgr.notifyAppWidgetViewDataChanged(intArrayOf(id), R.id.w_t1_list)
    mgr.notifyAppWidgetViewDataChanged(intArrayOf(id), R.id.w_t2_list)
}

/**
 * 绑定可滑动列表。
 *
 * 两个重载，分别对应两个时代：
 *  · `setRemoteAdapter(viewId, intent)` —— API 31 起，最省事；
 *  · `setRemoteAdapter(appWidgetId, viewId, intent)` —— API 31 以前，**逐个组件**指定。
 *    （老 API 收的是**单个 id**，没有什么 int[] 版本；把它写成 intArrayOf(...)
 *    会编译不过，而报错是「expected Int」，看着和这里毫无关系。）
 *
 * 两个都被标了 deprecated：官方现在推荐 `RemoteCollectionItems`（把所有项
 * 一次性构造好交出去）。但那条路要求我们把几十条课程项**在组件进程里**全部
 * 建好，既丢掉系统的回收，也不能按日期取数据 —— 对本场景是倒退。
 * 这里继续走 Service + Intent 这条被广泛使用、且功能完好的路。
 */
@Suppress("DEPRECATION")
private fun bindList(rv: RemoteViews, listId: Int, intent: Intent, widgetId: Int) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        rv.setRemoteAdapter(listId, intent)
    } else {
        rv.setRemoteAdapter(widgetId, listId, intent)
    }
}

/** 点组件面板本体：打开应用。不带填充数据，用 IMMUTABLE */
private fun openApp(ctx: Context): PendingIntent {
    val i = Intent(ctx, MainActivity::class.java).apply {
        action = Intent.ACTION_MAIN
        addCategory(Intent.CATEGORY_LAUNCHER)
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    return PendingIntent.getActivity(
        ctx, 0, i,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
}

/**
 * 列表项的点击**模板**（`setPendingIntentTemplate`）。
 *
 * 跟 [openApp] 是同一个「打开应用」，但**必须单独建一个 FLAG_MUTABLE 的**：
 * collection 里每一项的点击，是系统把该项的 fillInIntent **填进这个模板**再发出去的，
 * 而 IMMUTABLE 的 PendingIntent 不允许被填充。官方文档对这一条写得很明确。
 *
 * requestCode 也要与 [openApp] 错开（0 / 1）：两个 Intent 一模一样时，
 * `FLAG_UPDATE_CURRENT` 会把它们认成同一个，后建的那个会改掉先建的 flags ——
 * 于是面板点击莫名其妙地也变成 mutable，或者模板变成 immutable。
 */
private fun openAppTemplate(ctx: Context): PendingIntent {
    val i = Intent(ctx, MainActivity::class.java).apply {
        action = Intent.ACTION_MAIN
        addCategory(Intent.CATEGORY_LAUNCHER)
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    return PendingIntent.getActivity(
        ctx, 1, i,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
    )
}
