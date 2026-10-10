import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { PHONE, PERIODS, type DemoCourse } from "./constants";
import { Icon, type IconName } from "./icons";
import type { Theme } from "./utils";

/* ============ 手机内布局常量（屏幕 380x780） ============ */
export const SB_H = 26; // 状态栏
export const TB_H = 84; // 顶栏
export const WB_H = 42; // 周次栏
export const GRID_H = PHONE.screenH - SB_H - TB_H - WB_H;
export const TIME_COL_W = 40;
export const DAY_W = (PHONE.screenW - TIME_COL_W) / 7;
export const CELL_H = GRID_H / 8;
export const HEAD_H = 30; // 表头（周几 + 日期）

/* ============ 手机状态栏 ============ */
export const StatusBar: React.FC<{ t: Theme }> = ({ t }) => (
  <div
    style={{
      height: SB_H,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 18px",
      color: t.ink,
      fontFamily: "sans-serif",
    }}
  >
    <span style={{ fontSize: 11, fontWeight: 700 }}>8:00</span>
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <svg width="14" height="10" viewBox="0 0 14 10">
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={i * 3.5} y={7 - i * 2.2} width="2.2" height={3 + i * 2.2} rx="0.6" fill={t.ink} />
        ))}
      </svg>
      <svg width="13" height="10" viewBox="0 0 13 10" fill="none" stroke={t.ink} strokeWidth="1.4" strokeLinecap="round">
        <path d="M1.5 3.5a8 8 0 0 1 10 0" />
        <path d="M3.8 6a5 5 0 0 1 5.4 0" />
        <circle cx="6.5" cy="8.2" r="0.8" fill={t.ink} stroke="none" />
      </svg>
      <svg width="20" height="10" viewBox="0 0 20 10">
        <rect x="0.5" y="1" width="16" height="8" rx="2" fill="none" stroke={t.ink} strokeWidth="1" opacity="0.5" />
        <rect x="2" y="2.5" width="10" height="5" rx="1" fill={t.ink} />
        <rect x="17.5" y="3.5" width="1.5" height="3" rx="0.5" fill={t.ink} opacity="0.5" />
      </svg>
    </div>
  </div>
);

/* ============ 顶栏（对照真实应用：课表名▾ + 4 个圆角按钮；第二行周次大字 + 单双周 pill + 日期） ============ */
export const TopBar: React.FC<{
  t: Theme;
  name: string;
  week: number;
  parity: string;
  dateText: string; // 例：2026年10月12日 · 星期一 · 共18周
  highlightIcon?: number | null;
}> = ({ t, name, week, parity, dateText, highlightIcon }) => {
  const icons: IconName[] = ["download", "plus", "share", "tune"];
  return (
    <div style={{ height: TB_H, padding: "8px 12px 6px", display: "flex", justifyContent: "space-between" }}>
      {/* 左：三行文字 */}
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: t.ink, letterSpacing: 0.5 }}>{name}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke={t.sub} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2 3.8 5 6.5 8 3.8" />
          </svg>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ fontSize: 13.5, fontWeight: 800, color: t.ink }}>第 {week} 周</span>
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 700,
              color: t.accent,
              backgroundColor: t.accentSoft,
              borderRadius: 999,
              padding: "1.5px 7px",
            }}
          >
            {parity}
          </span>
        </div>
        <div style={{ fontSize: 9.5, color: t.sub }}>{dateText}</div>
      </div>
      {/* 右：4 个圆角方形按钮 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {icons.map((ic, i) => (
          <div
            key={ic}
            style={{
              width: 36,
              height: 44,
              borderRadius: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: highlightIcon === i ? t.accent : t.surface,
              border: highlightIcon === i ? "none" : `1px solid ${t.line}`,
              color: highlightIcon === i ? "#fff" : t.ink,
            }}
          >
            <Icon name={ic} size={17} strokeWidth={2.2} />
          </div>
        ))}
      </div>
    </div>
  );
};

/* ============ 周次栏（对照真实：圆形‹›按钮 + 周次日期 + 本周/回到本周 + 月亮） ============ */
export const WeekBar: React.FC<{
  t: Theme;
  week: number;
  range: string;
  parity: string;
  awayFromToday?: boolean; // true 时显示「回到本周」
  isNight?: boolean;
  moonGlow?: number;
}> = ({ t, week, range, parity, awayFromToday = false, isNight = false, moonGlow = 0 }) => {
  const roundBtn = (child: React.ReactNode, key?: string) => (
    <div
      key={key}
      style={{
        width: 26,
        height: 26,
        borderRadius: 9,
        border: `1px solid ${t.line}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: t.sub,
        backgroundColor: t.surface,
      }}
    >
      {child}
    </div>
  );
  return (
    <div
      style={{
        height: WB_H,
        display: "flex",
        alignItems: "center",
        padding: "0 10px",
        gap: 7,
        borderTop: `1px solid ${t.line}`,
        borderBottom: `1px solid ${t.line}`,
        backgroundColor: t.surface,
      }}
    >
      {roundBtn(
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={t.sub} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="10 3.5 5.5 8 10 12.5" />
        </svg>,
        "prev"
      )}
      <span style={{ fontSize: 11.5, fontWeight: 800, color: t.ink, whiteSpace: "nowrap" }}>第 {week} 周</span>
      <span style={{ fontSize: 9.5, color: t.sub, whiteSpace: "nowrap" }}>
        {range} · {parity}
      </span>
      {roundBtn(
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={t.sub} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 3.5 10.5 8 6 12.5" />
        </svg>,
        "next"
      )}
      <span
        style={{
          fontSize: 9.5,
          fontWeight: 700,
          color: awayFromToday ? t.accent : t.sub,
          backgroundColor: awayFromToday ? t.accentSoft : "transparent",
          border: awayFromToday ? "none" : `1px solid ${t.line}`,
          borderRadius: 999,
          padding: "3px 9px",
          whiteSpace: "nowrap",
        }}
      >
        {awayFromToday ? "回到本周" : "本周"}
      </span>
      <div style={{ flex: 1 }} />
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: 999,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: t.surface,
          border: `1px solid ${t.line}`,
          color: t.ink,
          boxShadow: moonGlow > 0 ? `0 0 0 ${2 * moonGlow}px ${t.accent}40` : undefined,
        }}
      >
        <Icon name={isNight ? "sun" : "moon"} size={13} strokeWidth={2.2} />
      </div>
    </div>
  );
};

/* ============ 课程卡片（对照真实：圆角大、文字水平居中、教室贴底） ============ */
export const CourseCard: React.FC<{
  course: DemoCourse;
  t: Theme;
  appear?: number;
  colorOverride?: string;
}> = ({ course, t, appear = 1, colorOverride }) => {
  const top = (course.start - 1) * CELL_H;
  const height = (course.end - course.start + 1) * CELL_H - 3;
  const bg = colorOverride ?? course.color;
  return (
    <div
      style={{
        position: "absolute",
        left: (course.day - 1) * DAY_W + 1.5,
        width: DAY_W - 4,
        top,
        height,
        borderRadius: 9,
        backgroundColor: bg,
        boxShadow: `0 0 0 1.2px ${t.cardEdge}`,
        padding: "4px 3px",
        opacity: appear,
        transform: `scale(${0.86 + 0.14 * appear}) translateY(${(1 - appear) * -8}px)`,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          fontSize: 8.8,
          fontWeight: 700,
          color: "#fff",
          lineHeight: 1.3,
          wordBreak: "break-all",
          textAlign: "center",
        }}
      >
        {course.name}
      </div>
      <div
        style={{
          marginTop: 2,
          fontSize: 7.4,
          color: "rgba(255,255,255,0.88)",
          lineHeight: 1.2,
          wordBreak: "break-all",
          textAlign: "center",
          paddingBottom: 1,
        }}
      >
        {course.room}
      </div>
    </div>
  );
};

/* ============ 课表网格（表头带日期；今天 = 绿色圆角块盖住日期） ============ */
export const ScheduleGrid: React.FC<{
  t: Theme;
  courses: DemoCourse[];
  todayDay?: number;
  startDay?: number; // 周一的日期（几号），用于表头日期
  appearFrom?: number | null;
  slideX?: number;
}> = ({ t, courses, todayDay = 1, startDay = 12, appearFrom = null, slideX = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const days = ["一", "二", "三", "四", "五", "六", "日"];
  return (
    <div style={{ height: GRID_H, display: "flex", position: "relative", overflow: "hidden", backgroundColor: t.surface }}>
      {/* 底部渐隐提示 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 46,
          background: `linear-gradient(to bottom, ${t.surface}00, ${t.surface}E6)`,
          zIndex: 5,
          pointerEvents: "none",
        }}
      />
      {/* 时间列 */}
      <div style={{ width: TIME_COL_W, paddingTop: HEAD_H }}>
        {PERIODS.map((p) => (
          <div
            key={p.n}
            style={{
              height: CELL_H,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 1,
            }}
          >
            <span style={{ fontSize: 9.5, fontWeight: 800, color: t.ink }}>{p.n}</span>
            <span style={{ fontSize: 6.3, color: t.sub, lineHeight: 1.1, textAlign: "center" }}>
              {p.start}
              <br />
              {p.end}
            </span>
          </div>
        ))}
      </div>
      {/* 7 天列 */}
      <div style={{ flex: 1, position: "relative" }}>
        {/* 表头：周几 + 日期 */}
        <div style={{ display: "flex", height: HEAD_H }}>
          {days.map((d, i) => {
            const isToday = i + 1 === todayDay;
            const dateNum = startDay + i;
            return (
              <div
                key={d}
                style={{
                  width: DAY_W,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 1,
                }}
              >
                <span style={{ fontSize: 9.5, fontWeight: isToday ? 800 : 600, color: isToday ? t.accent : t.sub }}>
                  {d}
                </span>
                {isToday ? (
                  <span
                    style={{
                      fontSize: 7.5,
                      fontWeight: 800,
                      color: "#fff",
                      backgroundColor: t.accent,
                      borderRadius: 6,
                      padding: "0.5px 4px",
                      lineHeight: 1.4,
                    }}
                  >
                    {dateNum}
                  </span>
                ) : (
                  <span style={{ fontSize: 7.5, color: t.sub }}>{dateNum}</span>
                )}
              </div>
            );
          })}
        </div>
        {/* 竖分隔线 */}
        {days.map((d, i) => (
          <div
            key={`l${d}`}
            style={{
              position: "absolute",
              left: (i + 1) * DAY_W,
              top: HEAD_H,
              bottom: 0,
              width: 1,
              backgroundColor: t.line,
              opacity: 0.7,
            }}
          />
        ))}
        {/* 横线 */}
        {PERIODS.map((p) => (
          <div
            key={`h${p.n}`}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: HEAD_H + p.n * CELL_H,
              height: 1,
              backgroundColor: t.line,
              opacity: 0.45,
            }}
          />
        ))}
        {/* 课程卡片 */}
        <div
          style={{
            position: "absolute",
            top: HEAD_H + 2,
            left: 0,
            right: 0,
            bottom: 0,
            transform: `translateX(${slideX}px)`,
          }}
        >
          {courses.map((c, i) => {
            let appear = 1;
            if (appearFrom !== null && appearFrom !== undefined) {
              const target = appearFrom + i * 2.5;
              appear = spring({
                frame: Math.max(0, frame - target),
                fps,
                config: { damping: 14, stiffness: 160, mass: 0.6 },
              });
            }
            return (
              <CourseCard
                key={`${c.name}-${c.day}-${c.start}-${i}`}
                course={c}
                t={t}
                appear={appear}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};

/* ============ 底部弹层容器（.mask + .sheet：浅遮罩 + 大圆角面板） ============ */
export const SheetMask: React.FC<{
  t: Theme;
  openAt: number | null;
  closeAt?: number | null;
  height?: number;
  children: React.ReactNode;
}> = ({ t, openAt, closeAt = null, height = 400, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const openP =
    openAt === null
      ? 0
      : spring({
          frame: Math.max(0, frame - openAt),
          fps,
          config: { damping: 28, stiffness: 300, mass: 0.8 },
        });
  const closeP =
    closeAt === null || frame < closeAt
      ? 0
      : spring({
          frame: Math.max(0, frame - closeAt),
          fps,
          config: { damping: 30, stiffness: 320 },
        });
  const p = openP * (1 - closeP);
  if (p <= 0.001) return null;
  const sheetH = Math.min(height, 660);
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 20 }}>
      <div style={{ position: "absolute", inset: 0, backgroundColor: `rgba(20,16,10,${0.28 * p})` }} />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: sheetH,
          backgroundColor: t.surface,
          borderRadius: "22px 22px 0 0",
          transform: `translateY(${(1 - p) * sheetH}px)`,
          padding: "12px 16px 16px",
          boxShadow: "0 -8px 30px rgba(0,0,0,0.15)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: 38,
            height: 4,
            borderRadius: 999,
            backgroundColor: t.line,
            margin: "0 auto 10px",
          }}
        />
        {children}
      </div>
    </div>
  );
};

/* ============ 居中弹窗卡（取色器用，对照真实：上下留空的居中卡） ============ */
export const CenterCard: React.FC<{
  t: Theme;
  openAt: number | null;
  closeAt?: number | null;
  children: React.ReactNode;
}> = ({ t, openAt, closeAt = null, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const openP =
    openAt === null
      ? 0
      : spring({
          frame: Math.max(0, frame - openAt),
          fps,
          config: { damping: 20, stiffness: 280, mass: 0.7 },
        });
  const closeP =
    closeAt === null || frame < closeAt
      ? 0
      : spring({
          frame: Math.max(0, frame - closeAt),
          fps,
          config: { damping: 30, stiffness: 320 },
        });
  const p = openP * (1 - closeP);
  if (p <= 0.001) return null;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 20 }}>
      <div style={{ position: "absolute", inset: 0, backgroundColor: `rgba(20,16,10,${0.3 * p})` }} />
      <div
        style={{
          position: "absolute",
          left: 14,
          right: 14,
          top: 216,
          backgroundColor: t.surface,
          borderRadius: 18,
          padding: "14px 16px 14px",
          boxShadow: "0 14px 40px rgba(0,0,0,0.22)",
          transform: `scale(${0.94 + 0.06 * p}) translateY(${(1 - p) * 14}px)`,
        }}
      >
        {children}
      </div>
    </div>
  );
};

/* ============ 整页弹层（mask-page，课表管理页） ============ */
export const PageMask: React.FC<{
  t: Theme;
  openAt: number | null;
  closeAt?: number | null;
  title: string;
  rightNode?: React.ReactNode; // 右上角内容，默认「＋ 新建」
  children: React.ReactNode;
}> = ({ t, openAt, closeAt = null, title, rightNode, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const openP =
    openAt === null
      ? 0
      : spring({
          frame: Math.max(0, frame - openAt),
          fps,
          config: { damping: 26, stiffness: 260 },
        });
  const closeP =
    closeAt === null || frame < closeAt
      ? 0
      : spring({
          frame: Math.max(0, frame - closeAt),
          fps,
          config: { damping: 30, stiffness: 300 },
        });
  const p = openP * (1 - closeP);
  if (p <= 0.001) return null;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 20 }}>
      <div style={{ position: "absolute", inset: 0, backgroundColor: `rgba(20,16,10,${0.4 * p})` }} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: t.bg,
          transform: `translateX(${(1 - p) * PHONE.screenW * 0.4}px)`,
          opacity: p,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ height: SB_H }} />
        <div
          style={{
            padding: "10px 16px 12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: `1px solid ${t.line}`,
            backgroundColor: t.surface,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={t.sub} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="10 3.5 5.5 8 10 12.5" />
            </svg>
            <span style={{ fontSize: 15, fontWeight: 800, color: t.ink }}>{title}</span>
          </div>
          {rightNode !== undefined ? rightNode : (
            <span style={{ fontSize: 11, fontWeight: 700, color: t.accent }}>＋ 新建</span>
          )}
        </div>
        <div style={{ flex: 1, padding: "12px 16px", overflow: "hidden" }}>{children}</div>
      </div>
    </div>
  );
};

/* ============ 黑色 toast（对照真实：「已导入 15 门课程」） ============ */
export const Toast: React.FC<{
  text: string;
  showAt: number;
  hideAt?: number | null;
}> = ({ text, showAt, hideAt = null }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const inP = spring({
    frame: Math.max(0, frame - showAt),
    fps,
    config: { damping: 22, stiffness: 260, mass: 0.7 },
  });
  const outP =
    hideAt === null || frame < hideAt
      ? 0
      : interpolate(frame, [hideAt, hideAt + 10], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
  const opacity = inP * (1 - outP);
  if (opacity <= 0.01) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 46,
        display: "flex",
        justifyContent: "center",
        zIndex: 60,
        opacity,
        transform: `translateY(${(1 - inP) * 12}px)`,
      }}
    >
      <span
        style={{
          backgroundColor: "rgba(28,24,17,0.92)",
          color: "#f5efe3",
          fontSize: 12,
          fontWeight: 700,
          borderRadius: 999,
          padding: "8px 20px",
          boxShadow: "0 6px 18px rgba(0,0,0,0.3)",
        }}
      >
        {text}
      </span>
    </div>
  );
};

/* ============ 模拟手指 ============ */
export const Finger: React.FC<{
  x: number;
  y: number;
  opacity?: number;
  press?: number; // 0~1 按压动画进度：涟漪快速扩散并淡出，本体轻微收缩
}> = ({ x, y, opacity = 1, press = 0 }) => (
  <div style={{ position: "absolute", left: x, top: y, zIndex: 50, pointerEvents: "none", opacity }}>
    {/* 涟漪：一次性扩散淡出，不停留在按钮上 */}
    {press > 0.03 && press < 0.97 && (
      <div
        style={{
          position: "absolute",
          left: -24,
          top: -24,
          width: 48,
          height: 48,
          borderRadius: 999,
          border: "2px solid rgba(255,255,255,0.9)",
          transform: `scale(${0.55 + press * 1.35})`,
          opacity: 1 - press,
        }}
      />
    )}
    <div
      style={{
        width: 22,
        height: 22,
        borderRadius: 999,
        backgroundColor: "rgba(255,255,255,0.94)",
        border: "2px solid rgba(60,90,40,0.55)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
        transform: `translate(-50%,-50%) scale(${1 - press * 0.16})`,
        opacity: 1 - press * 0.3,
      }}
    />
  </div>
);

/* ============ 点击高亮描边框 ============ */
export const HighlightRing: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  startFrame: number;
  color: string;
  radius?: number;
}> = ({ x, y, w, h, startFrame, color, radius = 10 }) => {
  const frame = useCurrentFrame();
  const draw = interpolate(frame, [startFrame, startFrame + 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (draw <= 0) return null;
  const perimeter = 2 * (w + h);
  return (
    <svg
      style={{
        position: "absolute",
        left: x - 5,
        top: y - 5,
        pointerEvents: "none",
        zIndex: 40,
        overflow: "visible",
      }}
      width={w + 10}
      height={h + 10}
    >
      <rect
        x="5"
        y="5"
        width={w}
        height={h}
        rx={radius}
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={perimeter}
        strokeDashoffset={perimeter * (1 - draw)}
      />
      <rect
        x="2"
        y="2"
        width={w + 6}
        height={h + 6}
        rx={radius + 3}
        fill="none"
        stroke={color}
        strokeWidth="8"
        opacity={draw * 0.28}
      />
    </svg>
  );
};
