package cn.youke.schedule

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import androidx.core.content.ContextCompat
import java.time.LocalDate

/**
 * 桌面小组件里那个「可以上下滑动」的列表。
 *
 * ## 为什么必须走 RemoteViewsService
 *
 * AppWidget 里**没有**可以滚动的普通视图：ScrollView 能用，但内容必须一次
 * 全部渲染好，滚动条也拿不到；真正能让用户上下滑动、并且由系统负责回收的，
 * 只有 collection widget（`setRemoteAdapter` + RemoteViewsService），
 * 底层是系统在宿主进程里绑的一个 ListView —— 滑动、回收都是它做的，
 * 我们只负责提供每一项（getViewAt）。
 *
 * ## 今天和明天共用这一个 Service
 *
 * 靠 intent 里的 [EXTRA_DAY_OFFSET] 区分（0 = 今天，1 = 明天）。
 * 抄第二份 Service 没有意义：两边逻辑一模一样，将来只会各自被改一半，
 * 变成「今天的列表修好了、明天的还是旧行为」。
 */
class WidgetListService : RemoteViewsService() {

    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        WidgetListFactory(applicationContext, dayOffsetOf(intent))

    companion object {
        const val EXTRA_DAY_OFFSET = "day_offset"

        /**
         * 造给 `setRemoteAdapter` 的 Intent。
         *
         * **必须 setData 让它唯一**：宿主是拿这个 Intent 去 bindService 的，
         * 而 `Intent.filterEquals` **不比较 extras** —— 两栏只差一个
         * `EXTRA_DAY_OFFSET` 时，在系统眼里是两个完全相同的 Intent，
         * 可能被当成同一个连接复用，于是「明天」那栏拿到的是今天那份工厂
         * （表现成两栏内容一模一样）。data 参与 filterEquals，用它把两栏分开。
         */
        fun intentFor(ctx: Context, offset: Int): Intent {
            val o = if (offset == 1) 1 else 0
            return Intent(ctx, WidgetListService::class.java)
                .setData(Uri.parse("youke://widget/$o"))
                .putExtra(EXTRA_DAY_OFFSET, o)
        }

        /** 只认 0 / 1，别的一律当今天（多传一位就整栏跑偏，不值得赌） */
        fun dayOffsetOf(intent: Intent): Int =
            if (intent.getIntExtra(EXTRA_DAY_OFFSET, 0) == 1) 1 else 0
    }
}

class WidgetListFactory(
    private val ctx: Context,
    private val dayOffset: Int
) : RemoteViewsService.RemoteViewsFactory {

    private var courses: List<WidgetCourse>? = null

    /** 这一栏该高亮的那节课的 id（正在上课 / 下一节；明天栏就是第一节） */
    private var focusId: String? = null

    override fun onCreate() {
        // 取数统一放在 onDataSetChanged：它在 binder 线程被调，
        // 读 SharedPreferences、解析 JSON 都不会卡主线程。
    }

    override fun onDataSetChanged() {
        val date = LocalDate.now().plusDays(dayOffset.toLong())
        val list = WidgetStore.coursesOn(ctx, date)
        courses = list
        focusId = if (list.isNullOrEmpty()) {
            null
        } else {
            // 明天那一栏还没到，不判断「正在上课」，一律取第一节
            WidgetLogic.focus(list, if (dayOffset == 0) nowMinutes() else -1).course?.id
        }
    }

    override fun getViewAt(position: Int): RemoteViews {
        val rv = RemoteViews(ctx.packageName, R.layout.widget_row)
        val list = courses ?: return rv
        if (position < 0 || position >= list.size) return rv
        val c = list[position]
        WidgetRender.bindRow(
            ctx, rv, c,
            highlighted = focusId != null && c.id == focusId,
            textColor = ContextCompat.getColor(ctx, R.color.widget_ink),
            subColor = ContextCompat.getColor(ctx, R.color.widget_ink2)
        )
        // 点某一节课 -> 打开应用（具体干什么由 Provider 的 PendingIntent 模板决定）
        rv.setOnClickFillInIntent(R.id.w_row, Intent())
        return rv
    }

    override fun getCount(): Int = courses?.size ?: 0

    /** 不提供「加载中」占位：数据就在本地，给了反而闪一下 */
    override fun getLoadingView(): RemoteViews? = null

    override fun getViewTypeCount(): Int = 1

    override fun getItemId(position: Int): Long = position.toLong()

    /** 数据会随推送变化，位置不稳定 —— 声明 false，让系统别复用错项 */
    override fun hasStableIds(): Boolean = false

    override fun onDestroy() {
        courses = null
        focusId = null
    }
}
