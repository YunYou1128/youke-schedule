import React from "react";
import { BRAND, CARD_COLORS, PHONE } from "./constants";
import { Icon, type IconName } from "./icons";
import type { Theme } from "./utils";
import { SB_H } from "./YoukeUI";

/* ============ 导入面板（严格对照 docs/screenshots/图15） ============ */
export const ImportPanelBody: React.FC<{
  t: Theme;
  activeBtn?: number | null; // 0=绿色主按钮 1=描边按钮
}> = ({ t, activeBtn = null }) => {
  const label: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 800,
    color: t.ink,
    margin: "9px 0 5px",
  };
  const hint: React.CSSProperties = {
    fontSize: 8.2,
    color: t.sub,
    lineHeight: 1.55,
    margin: "3px 0",
  };
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 800, color: t.ink, marginBottom: 8 }}>导入课表</div>
      <div style={{ fontSize: 9.5, color: t.sub, marginBottom: 4 }}>导入到哪个课表</div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          border: `1px solid ${t.line}`,
          borderRadius: 10,
          padding: "8px 12px",
          backgroundColor: t.bg,
        }}
      >
        <span style={{ fontSize: 11.5, fontWeight: 700, color: t.ink }}>我的课表</span>
        <Icon name="chevron-right" size={12} color={t.sub} strokeWidth={2.2} />
      </div>
      <div style={hint}>可先在这里切换目标课表，导入不会影响其他课表。</div>

      <div style={label}>方式一：从教务系统导入（推荐）</div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
          backgroundColor: activeBtn === 0 ? "#35691f" : t.accent,
          color: "#fff",
          borderRadius: 10,
          padding: "10px 0",
          fontSize: 12.5,
          fontWeight: 800,
          transform: `scale(${activeBtn === 0 ? 0.97 : 1})`,
        }}
      >
        <Icon name="globe" size={15} color="#fff" strokeWidth={2} />
        打开我的学校教务系统
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: `1px solid ${activeBtn === 1 ? t.accent : t.line}`,
          borderRadius: 10,
          padding: "8px 0",
          fontSize: 11.5,
          fontWeight: 700,
          color: t.ink,
          marginTop: 7,
          backgroundColor: activeBtn === 1 ? t.accentSoft : "transparent",
        }}
      >
        选择学校（社区适配库 / 我的学校）
      </div>
      <div style={hint}>
        <b style={{ color: t.ink }}>第一次用：</b>
        点上面那颗按钮，在学校列表里搜你学校的名字（本校和带「适配」标记的社区学校按字母混排——每所由社区维护的适配脚本自动把课表取回来），搜不到就用「手动输入」填一次教务地址，填完只存本机。
      </div>
      <div style={hint}>
        由<b style={{ color: t.ink }}>你自己登录</b> → 翻到「学生个人课表」→ 点底栏那条的
        <b style={{ color: t.ink }}>「执行导入」</b>，课表就进来了。不用截图、不上传你的数据。
      </div>

      <div style={label}>方式二：选择文件（自动识别格式）</div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          border: `1px solid ${t.line}`,
          borderRadius: 10,
          padding: "7px 10px",
          backgroundColor: t.bg,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            color: t.ink,
            border: `1px solid ${t.line}`,
            borderRadius: 8,
            padding: "3px 10px",
            backgroundColor: t.surface,
          }}
        >
          选择文件
        </span>
        <span style={{ fontSize: 10, color: t.sub }}>未选择文件</span>
      </div>
      <div style={hint}>
        支持五种文件，直接选原文件即可，不用转换：网页课表 .html、Excel .xls/.xlsx、PDF
        课表、按 A→G 列整理的 CSV。
      </div>

      <div style={label}>方式三：粘贴 CSV 文本</div>
      <div
        style={{
          border: `1px solid ${t.line}`,
          borderRadius: 10,
          padding: "7px 10px",
          backgroundColor: t.bg,
          fontSize: 8.8,
          color: t.sub,
          lineHeight: 1.6,
          fontFamily: "monospace",
        }}
      >
        课程名称,星期,开始节数,结束节数,老师,地点,周数
        <br />
        高等数学,1,1,2,张老师,教三-301,1-16
      </div>
    </div>
  );
};

/* ============ 学校列表（严格对照 docs/screenshots/图17） ============ */
export const SchoolListBody: React.FC<{
  t: Theme;
  targetHit?: number; // 0~1 选中目标学校
  typedText?: string;
}> = ({ t, targetHit = 0, typedText = "" }) => {
  const schools = [
    { name: "柚子大学", desc: "正方教务html通用获取 · 维护者 拾光", hit: targetHit, letter: "Y" },
    { name: "示例大学", desc: "示例大学教务系统 · 维护者 维护者甲", hit: 0, letter: "S" },
  ];
  return (
    <div style={{ position: "relative" }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: t.ink, marginBottom: 8 }}>打开教务系统</div>
      {/* 搜索框 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          border: `1px solid ${t.line}`,
          borderRadius: 10,
          padding: "8px 12px",
          marginBottom: 6,
          backgroundColor: t.bg,
        }}
      >
        <span style={{ fontSize: 11, color: t.sub }}>
          {typedText ? (
            <>
              <span style={{ color: t.ink, fontWeight: 700 }}>{typedText}</span>
              <span style={{ color: t.accent }}>|</span>
            </>
          ) : (
            "搜学校（校名 / 缩写 / 维护者）"
          )}
        </span>
      </div>
      <div style={{ fontSize: 8.2, color: t.sub, lineHeight: 1.55, margin: "3px 0" }}>
        载入适配库后，社区适配库里 200 多所学校会按字母列在下面：每所由社区维护一段适配脚本，选中后会用它自动把课表取回来；第一次要联网载入这份清单（约
        75 KB，四条镜像任取一条通就行），载入一次就存在本机，之后离线也能用；用过的学校会置顶。「我的学校」是你自己添加的，只存本机。
      </div>

      <div style={{ fontSize: 10, fontWeight: 800, color: t.ink, margin: "8px 0 4px" }}>社区适配库</div>
      <div style={{ fontSize: 8.2, color: t.sub, lineHeight: 1.55, margin: "2px 0 6px" }}>
        已载入 4 所学校（来源 Gitee 镜像，2026-10-10 00:51 更新）。按字母排在下面，点右侧字母可以快跳；用过的学校在最上面。
      </div>
      {/* 载入适配库卡 */}
      <div
        style={{
          border: `1px solid ${t.line}`,
          borderRadius: 10,
          padding: "7px 10px",
          marginBottom: 8,
          backgroundColor: t.bg,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 800, color: t.ink }}>载入适配库</div>
        <div style={{ fontSize: 8.2, color: t.sub, marginTop: 2 }}>
          从社区的四条镜像任取一条下载（约 75 KB），下载一次就存在本机
        </div>
      </div>
      {/* 学校列表 */}
      {schools.map((s) => (
        <React.Fragment key={s.name}>
          <div style={{ fontSize: 9.5, fontWeight: 800, color: t.sub, margin: "2px 0 4px" }}>{s.letter}</div>
          <div
            style={{
              border: `1px solid ${s.hit > 0.01 ? t.accent : t.line}`,
              borderRadius: 10,
              padding: "7px 10px",
              marginBottom: 6,
              backgroundColor: s.hit > 0.01 ? t.accentSoft : t.surface,
              transform: `scale(${1 - s.hit * 0.04})`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11.5, fontWeight: 800, color: t.ink }}>{s.name}</span>
              <span
                style={{
                  fontSize: 8,
                  fontWeight: 800,
                  color: t.accent,
                  border: `1px solid ${t.accent}66`,
                  borderRadius: 999,
                  padding: "0.5px 6px",
                }}
              >
                适配
              </span>
            </div>
            <div style={{ fontSize: 8.2, color: t.sub, marginTop: 2 }}>{s.desc}</div>
          </div>
        </React.Fragment>
      ))}
      {/* 右侧字母快跳条 */}
      <div
        style={{
          position: "absolute",
          right: -8,
          top: 190,
          display: "flex",
          flexDirection: "column",
          gap: 3,
          fontSize: 8,
          color: t.sub,
          fontWeight: 700,
          alignItems: "center",
        }}
      >
        {["S", "Y", "Z"].map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
    </div>
  );
};

/* ============ 课程详情弹层（严格对照 docs/screenshots/图20） ============ */
export const CourseDetailBody: React.FC<{
  t: Theme;
  course: {
    name: string;
    teacher: string;
    room: string;
    day: string;
    period: string;
    time: string;
    weeks: string;
    parityLabel: string;
  };
}> = ({ t, course }) => {
  const fields = [
    ["星期", course.day],
    ["节次", course.period],
    ["时间", course.time],
    ["地点", course.room],
    ["教师", course.teacher],
    ["周次", course.weeks],
  ];
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 800, color: t.ink, marginBottom: 8 }}>{course.name}</div>
      {/* pill 行 */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <span
          style={{
            fontSize: 9,
            fontWeight: 800,
            color: t.accent,
            backgroundColor: t.accentSoft,
            borderRadius: 999,
            padding: "3px 9px",
          }}
        >
          {course.parityLabel}
        </span>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            color: t.sub,
            backgroundColor: t.bg,
            borderRadius: 999,
            padding: "3px 9px",
          }}
        >
          {course.weeks}
        </span>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            color: t.sub,
            backgroundColor: t.bg,
            borderRadius: 999,
            padding: "3px 9px",
          }}
        >
          第 1 周上课
        </span>
      </div>
      {fields.map(([k, v]) => (
        <div
          key={k}
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "6px 2px",
            borderBottom: `1px solid ${t.line}`,
          }}
        >
          <span style={{ fontSize: 10.5, color: t.sub }}>{k}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: t.ink }}>{v}</span>
        </div>
      ))}
      {/* 按钮行：全部描边，删除红字 */}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        {[
          { label: "编辑", danger: false },
          { label: "复制", danger: false },
          { label: "删除", danger: true },
        ].map((b) => (
          <div
            key={b.label}
            style={{
              flex: 1,
              textAlign: "center",
              padding: "9px 0",
              borderRadius: 10,
              fontSize: 12,
              fontWeight: 700,
              color: b.danger ? "#d33a2c" : t.ink,
              border: `1px solid ${b.danger ? "#d33a2c55" : t.line}`,
              backgroundColor: t.surface,
            }}
          >
            {b.label}
          </div>
        ))}
      </div>
    </div>
  );
};

/* ============ 取色器（严格对照 docs/screenshots/图29：渐变面板 + 彩虹条 + 色值 + 取消/保存） ============ */
export const ColorPickerBody: React.FC<{
  t: Theme;
  hue: number; // 270 紫 → 25 橙
  cursor: { x: number; y: number; bar: number }; // 0~1
  colorHex: string;
  previewName?: string;
}> = ({ t, hue, cursor, colorHex, previewName = "课程名" }) => (
  <div>
    <div style={{ fontSize: 14, fontWeight: 800, color: t.ink, marginBottom: 10 }}>选择颜色</div>
    <div style={{ display: "flex", gap: 9 }}>
      {/* 饱和度/明度渐变面板 */}
      <div
        style={{
          flex: 1,
          height: 150,
          borderRadius: 10,
          position: "relative",
          backgroundColor: `hsl(${hue}, 72%, 45%)`,
          backgroundImage: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0))`,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: `${cursor.x * 100}%`,
            top: `${cursor.y * 100}%`,
            width: 15,
            height: 15,
            borderRadius: 999,
            border: "2.5px solid #fff",
            boxShadow: "0 1px 5px rgba(0,0,0,0.4)",
            transform: "translate(-50%,-50%)",
          }}
        />
      </div>
      {/* 彩虹色条 */}
      <div
        style={{
          width: 20,
          height: 150,
          borderRadius: 999,
          position: "relative",
          background:
            "linear-gradient(to bottom, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: -3,
            top: `${cursor.bar * 100}%`,
            width: 26,
            height: 8,
            borderRadius: 999,
            border: "2px solid #fff",
            boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
            transform: "translateY(-50%)",
          }}
        />
      </div>
    </div>
    {/* 预览行 */}
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
      <span
        style={{
          backgroundColor: colorHex,
          color: "#fff",
          fontSize: 11,
          fontWeight: 700,
          borderRadius: 8,
          padding: "7px 14px",
        }}
      >
        {previewName}
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, color: t.ink, letterSpacing: 0.5 }}>{colorHex}</span>
    </div>
    {/* 取消 / 保存 */}
    <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
      <div
        style={{
          flex: 1,
          textAlign: "center",
          padding: "9px 0",
          borderRadius: 10,
          fontSize: 12.5,
          fontWeight: 700,
          color: t.ink,
          border: `1px solid ${t.line}`,
        }}
      >
        取消
      </div>
      <div
        style={{
          flex: 1,
          textAlign: "center",
          padding: "9px 0",
          borderRadius: 10,
          fontSize: 12.5,
          fontWeight: 800,
          color: "#fff",
          backgroundColor: t.accent,
        }}
      >
        保存
      </div>
    </div>
  </div>
);

/* ============ 编辑课程表单页（严格对照应用真实界面） ============ */
export const EditCourseFormBody: React.FC<{
  t: Theme;
  name: string;
  teacher: string;
  room: string;
  weeks: string;
}> = ({ t, name, teacher, room, weeks }) => {
  const label: React.CSSProperties = {
    fontSize: 9.5,
    color: t.sub,
    margin: "9px 0 4px",
  };
  const input: React.CSSProperties = {
    border: `1px solid ${t.line}`,
    borderRadius: 10,
    padding: "8px 12px",
    backgroundColor: t.bg,
    fontSize: 11.5,
    fontWeight: 600,
    color: t.ink,
  };
  return (
    <div>
      <div style={label}>课程名称</div>
      <div style={input}>{name}</div>

      {/* 卡片颜色行：label 左，彩虹圆 + 自动 右 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "9px 0 4px" }}>
        <span style={{ fontSize: 9.5, color: t.sub }}>卡片颜色</span>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          {/* 彩虹渐变圆 */}
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: 999,
              background: "conic-gradient(#ff3b30, #ffcc00, #34c759, #00c7be, #007aff, #af52de, #ff2d55, #ff3b30)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ width: 13, height: 13, borderRadius: 999, backgroundColor: t.surface }} />
          </div>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 800,
              color: t.ink,
              border: `1.5px solid ${t.ink}`,
              borderRadius: 999,
              padding: "3px 13px",
            }}
          >
            自动
          </span>
        </div>
      </div>

      {/* 三列：星期 / 开始节数 / 结束节数 */}
      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
        {[
          { l: "星期", v: "星期一", arrow: true },
          { l: "开始节数", v: "1" },
          { l: "结束节数", v: "2" },
        ].map((f) => (
          <div key={f.l} style={{ flex: 1 }}>
            <div style={label}>{f.l}</div>
            <div style={{ ...input, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>{f.v}</span>
              {f.arrow && <Icon name="chevron-right" size={11} color={t.sub} strokeWidth={2.2} />}
            </div>
          </div>
        ))}
      </div>

      {/* 两列：老师 / 地点 */}
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={label}>老师</div>
          <div style={input}>{teacher}</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={label}>地点</div>
          <div style={input}>{room}</div>
        </div>
      </div>

      <div style={label}>上课周数</div>
      <div style={input}>{weeks}</div>

      {/* 取消 / 保存修改 */}
      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <div
          style={{
            flex: 1,
            textAlign: "center",
            padding: "9px 0",
            borderRadius: 10,
            fontSize: 12.5,
            fontWeight: 700,
            color: t.ink,
            border: `1px solid ${t.line}`,
          }}
        >
          取消
        </div>
        <div
          style={{
            flex: 1,
            textAlign: "center",
            padding: "9px 0",
            borderRadius: 10,
            fontSize: 12.5,
            fontWeight: 800,
            color: "#fff",
            backgroundColor: t.accent,
          }}
        >
          保存修改
        </div>
      </div>
    </div>
  );
};

/* ============ 多课表管理弹层（严格对照真实截图） ============ */
export const ScheduleManagerBody: React.FC<{
  t: Theme;
  current: string;
}> = ({ t, current }) => {
  const list = [
    { name: "我的课表", count: 14 },
    { name: "课表 2", count: 12 },
    { name: "课表 3", count: 17 },
  ];
  const miniBtn = (label: string, danger?: boolean) => (
    <span
      style={{
        fontSize: 8.5,
        fontWeight: 700,
        color: danger ? "#d33a2c" : t.ink,
        border: `1px solid ${danger ? "#d33a2c55" : t.line}`,
        borderRadius: 7,
        padding: "2.5px 7px",
        backgroundColor: t.surface,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 800, color: t.ink, marginBottom: 10 }}>我的课表</div>
      {list.map((s) => {
        const isCur = s.name === current;
        return (
          <div
            key={s.name}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "9px 11px",
              borderRadius: 12,
              marginBottom: 8,
              backgroundColor: isCur ? t.accentSoft : t.surface,
              border: isCur ? `1px solid ${t.accent}55` : `1px solid ${t.line}`,
              borderLeft: isCur ? `3px solid ${t.accent}` : `3px solid ${t.line}`,
              transform: `scale(${isCur ? 1 : 0.99})`,
            }}
          >
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 800, color: t.ink }}>{s.name}</span>
                {isCur && (
                  <span
                    style={{
                      fontSize: 8,
                      fontWeight: 800,
                      color: "#fff",
                      backgroundColor: t.accent,
                      borderRadius: 999,
                      padding: "1.5px 7px",
                    }}
                  >
                    当前
                  </span>
                )}
              </div>
              <div style={{ fontSize: 9, color: t.sub, marginTop: 3 }}>
                {s.count} 门课 · 18 周 · 2026-08-31 起
              </div>
            </div>
            <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
              {miniBtn("重命名")}
              {miniBtn("复制")}
              {miniBtn("删除", true)}
            </div>
          </div>
        );
      })}
      {/* 说明 */}
      <div style={{ fontSize: 8.8, color: t.sub, lineHeight: 1.65, margin: "8px 2px" }}>
        每个课表各自独立保存课程与学期设置（开学日期、总周数、节数、作息时间），相互之间不会影响。点击课表名即可切换当前显示的课表。
      </div>
      {/* 关闭 / 新建课表 */}
      <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
        <div
          style={{
            flex: 1,
            textAlign: "center",
            padding: "9px 0",
            borderRadius: 10,
            fontSize: 12,
            fontWeight: 700,
            color: t.ink,
            border: `1px solid ${t.line}`,
          }}
        >
          关闭
        </div>
        <div
          style={{
            flex: 1,
            textAlign: "center",
            padding: "9px 0",
            borderRadius: 10,
            fontSize: 12,
            fontWeight: 800,
            color: "#fff",
            backgroundColor: t.accent,
          }}
        >
          新建课表
        </div>
      </div>
    </div>
  );
};

/* ============ 柚课 Logo（柚子轮廓 + 课表格子） ============ */
export const YoukeLogo: React.FC<{ size: number; glow?: number }> = ({ size, glow = 0 }) => {
  const s = size;
  return (
    <div
      style={{
        width: s,
        height: s,
        position: "relative",
        filter: glow > 0 ? `drop-shadow(0 0 ${18 * glow}px rgba(143,203,110,${0.45 * glow}))` : undefined,
      }}
    >
      <svg width={s} height={s} viewBox="0 0 100 100">
        <circle cx="50" cy="55" r="38" fill={BRAND.day.accent} />
        <ellipse cx="38" cy="42" rx="13" ry="8" fill="#ffffff" opacity="0.14" transform="rotate(-25 38 42)" />
        <path d="M50 18 C 44 8, 58 4, 62 12 C 64 16, 58 20, 50 18 Z" fill={BRAND.pomeloYellow} />
        <path d="M50 18 C 46 14, 46 12, 49 9" stroke="#c99f3a" strokeWidth="1.2" fill="none" />
        <g stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" opacity="0.9">
          <line x1="35" y1="45" x2="65" y2="45" />
          <line x1="35" y1="57" x2="65" y2="57" />
          <line x1="35" y1="69" x2="65" y2="69" />
          <line x1="43" y1="37" x2="43" y2="77" />
          <line x1="57" y1="37" x2="57" y2="77" />
        </g>
      </svg>
    </div>
  );
};

/* ============ 柚课 2×2 今日课程小组件（严格对照 docs/screenshots/图44） ============ */
export const WidgetCard: React.FC<{ appear: number; scroll: number }> = ({ appear, scroll }) => {
  const current = { name: "数据结构", room: "教三-208", time: "10:00-11:40" };
  const rest = [
    { name: "操作系统", room: "计算机楼-B301", time: "14:55-15:40", color: CARD_COLORS.orange },
    { name: "高等数学A", room: "教三-301", time: "08:00-09:40", color: CARD_COLORS.rose },
  ];
  const listShift = -Math.min(1, Math.max(0, scroll)) * 30;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        borderRadius: 18,
        backgroundColor: BRAND.day.surface,
        boxShadow: "0 6px 18px rgba(0,0,0,0.28)",
        padding: "10px 11px",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        opacity: appear,
      }}
    >
      {/* 头：日期 + 几门 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: BRAND.day.ink }}>10月12日 周一</span>
        <span style={{ fontSize: 9, fontWeight: 600, color: BRAND.day.sub }}>3 门</span>
      </div>
      {/* 正在上课：浅绿高亮块 */}
      <div
        style={{
          marginTop: 7,
          backgroundColor: BRAND.day.accentSoft,
          borderRadius: 9,
          padding: "6px 9px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: BRAND.day.accent }}>{current.name}</span>
          <span style={{ fontSize: 7.5, fontWeight: 700, color: BRAND.day.accent, opacity: 0.85 }}>正在上课</span>
        </div>
        <div style={{ fontSize: 8.2, color: BRAND.day.accent, opacity: 0.9, marginTop: 1.5 }}>
          教三-208 · {current.time}
        </div>
      </div>
      {/* 其余课程：左色条 + 课名 + 教室时间 */}
      <div style={{ marginTop: 5, transform: `translateY(${listShift}px)` }}>
        {rest.map((c) => (
          <div key={c.name} style={{ display: "flex", gap: 7, padding: "4px 0" }}>
            <div style={{ width: 3, borderRadius: 2, backgroundColor: c.color }} />
            <div>
              <div style={{ fontSize: 9.5, fontWeight: 700, color: BRAND.day.ink, lineHeight: 1.25 }}>{c.name}</div>
              <div style={{ fontSize: 7.8, color: BRAND.day.sub, lineHeight: 1.25 }}>
                {c.room} · {c.time}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

/* ============ 手机桌面（小组件场景背景） ============ */
export const HomeScreen: React.FC<{
  widgetAppear: number;
  widgetScroll: number;
}> = ({ widgetAppear, widgetScroll }) => {
  const apps: { icon: IconName; color: string }[] = [
    { icon: "phone", color: "#4caf50" },
    { icon: "message", color: "#42a5f5" },
    { icon: "camera", color: "#78909c" },
    { icon: "compass", color: "#26a69a" },
  ];
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "linear-gradient(160deg, #2d5422 0%, #1d3a16 55%, #14290e 100%)",
        overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", width: 300, height: 300, borderRadius: 999, left: -80, top: 120, background: "radial-gradient(circle, rgba(143,203,110,0.18), transparent 70%)" }} />
      <div style={{ position: "absolute", width: 260, height: 260, borderRadius: 999, right: -70, top: 330, background: "radial-gradient(circle, rgba(249,208,111,0.10), transparent 70%)" }} />
      <div
        style={{
          height: SB_H,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 18px",
          color: "#fff",
          fontFamily: "sans-serif",
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700 }}>16:42</span>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <svg width="14" height="10" viewBox="0 0 14 10">
            {[0, 1, 2, 3].map((i) => (
              <rect key={i} x={i * 3.5} y={7 - i * 2.2} width="2.2" height={3 + i * 2.2} rx="0.6" fill="#fff" />
            ))}
          </svg>
          <svg width="20" height="10" viewBox="0 0 20 10">
            <rect x="0.5" y="1" width="16" height="8" rx="2" fill="none" stroke="#fff" strokeWidth="1" opacity="0.6" />
            <rect x="2" y="2.5" width="9" height="5" rx="1" fill="#fff" />
          </svg>
        </div>
      </div>
      <div style={{ position: "absolute", left: 22, top: 44, color: "#fff" }}>
        <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.9 }}>10月12日 星期一</div>
      </div>
      {/* 柚课小组件 */}
      <div
        style={{
          position: "absolute",
          left: 18,
          top: 70,
          width: (PHONE.screenW - 18 * 2 - 12) / 2,
          height: 150,
          opacity: widgetAppear,
          transform: `scale(${0.9 + 0.1 * widgetAppear})`,
        }}
      >
        <WidgetCard appear={widgetAppear} scroll={widgetScroll} />
      </div>
      {/* 其他 app 图标 */}
      <div
        style={{
          position: "absolute",
          right: 18,
          top: 70,
          width: (PHONE.screenW - 18 * 2 - 12) / 2,
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 14,
        }}
      >
        {apps.slice(0, 2).map((a) => (
          <div
            key={a.icon}
            style={{
              width: 46,
              height: 46,
              borderRadius: 13,
              backgroundColor: a.color,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              boxShadow: "0 4px 10px rgba(0,0,0,0.25)",
            }}
          >
            <Icon name={a.icon} size={22} strokeWidth={2} />
          </div>
        ))}
      </div>
      {[240, 306, 372].map((top, rowIdx) => (
        <div
          key={top}
          style={{
            position: "absolute",
            left: 18,
            top,
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 14,
            width: PHONE.screenW - 36,
          }}
        >
          {(rowIdx === 0
            ? apps
            : rowIdx === 1
              ? [
                  { icon: "calendar" as IconName, color: "#ef6c00" },
                  { icon: "palette" as IconName, color: "#8e24aa" },
                  { icon: "settings" as IconName, color: "#546e7a" },
                  { icon: "file" as IconName, color: "#00897b" },
                ]
              : [
                  { icon: "share" as IconName, color: "#c62828" },
                  { icon: "search" as IconName, color: "#7cb342" },
                  { icon: "layers" as IconName, color: "#3949ab" },
                  { icon: "download" as IconName, color: "#6d4c41" },
                ]
          ).map((a) => (
            <div
              key={`${top}-${a.icon}`}
              style={{
                width: 46,
                height: 46,
                borderRadius: 13,
                backgroundColor: a.color,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                boxShadow: "0 4px 10px rgba(0,0,0,0.25)",
              }}
            >
              <Icon name={a.icon} size={22} strokeWidth={2} />
            </div>
          ))}
        </div>
      ))}
      {/* 底部 dock */}
      <div
        style={{
          position: "absolute",
          bottom: 14,
          left: 18,
          right: 18,
          height: 58,
          borderRadius: 20,
          backgroundColor: "rgba(255,255,255,0.12)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-evenly",
        }}
      >
        {apps.map((a) => (
          <div
            key={`d${a.icon}`}
            style={{
              width: 42,
              height: 42,
              borderRadius: 12,
              backgroundColor: a.color,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
            }}
          >
            <Icon name={a.icon} size={20} strokeWidth={2} />
          </div>
        ))}
      </div>
    </div>
  );
};
