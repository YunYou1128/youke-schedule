import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate, Img, staticFile } from "remotion";
import { BRAND, FONT, WEEK8, WEEK9, CARD_COLORS } from "./constants";
import { mixTheme } from "./utils";
import { StatusBar, TopBar, WeekBar, ScheduleGrid, PageMask, SheetMask, Finger } from "./YoukeUI";
import { ScheduleManagerBody, HomeScreen } from "./YoukeSheets";
import { SidePanel, SceneFooter } from "./SidePanel";
import { Icon } from "./icons";

/* ================================================================
   场景 5 · 多课表（180f）
   点顶栏课表名 → 管理页 → 切换到「大三上」
================================================================ */
export const Scene5Screen: React.FC = () => {
  const frame = useCurrentFrame();
  const t = mixTheme(0);

  const switched = frame >= 126;
  const current = switched ? "课表 2" : "我的课表";

  // 手指路径：顶栏课表名 (60,46) → 弹层内「课表 2」卡 (190,504)
  const seg = (a: number, b: number, from: [number, number], to: [number, number]) => {
    const p = interpolate(frame, [a, b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return [from[0] + (to[0] - from[0]) * p, from[1] + (to[1] - from[1]) * p] as [number, number];
  };
  let pos: [number, number] = [60, 46];
  if (frame < 26) pos = seg(6, 24, [160, 620], [60, 46]);
  else if (frame < 76) pos = [60, 46];
  else if (frame < 104) pos = seg(76, 102, [60, 46], [190, 504]);
  else pos = [190, 504];

  const pressAt = (at: number) => {
    const d = frame - at;
    if (d < 0 || d > 14) return 0;
    return Math.sin((d / 14) * Math.PI);
  };
  const press = Math.max(pressAt(28), pressAt(108));
  const fingerOpacity =
    interpolate(frame, [4, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) *
    interpolate(frame, [114, 126], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <div style={{ position: "absolute", inset: 0, backgroundColor: t.bg, fontFamily: FONT }}>
      <StatusBar t={t} />
      <TopBar
        t={t}
        name={switched ? "课表 2" : "我的课表"}
        week={switched ? 9 : 8}
        parity={switched ? "双周" : "单周"}
        dateText={switched ? "2026年10月19日 · 星期一 · 共18周" : "2026年10月12日 · 星期一 · 共18周"}
      />
      <WeekBar
        t={t}
        week={switched ? 9 : 8}
        range={switched ? "10/19 - 10/25" : "10/12 - 10/18"}
        parity={switched ? "双周" : "单周"}
      />
      <ScheduleGrid
        t={t}
        courses={switched ? WEEK9 : WEEK8}
        todayDay={1}
        startDay={switched ? 19 : 12}
        appearFrom={switched && frame < 165 ? 130 : null}
      />

      {/* 多课表管理弹层（真实结构：底部弹层） */}
      <SheetMask t={t} openAt={40} closeAt={124} height={430}>
        <ScheduleManagerBody t={t} current={current} />
      </SheetMask>

      <Finger x={pos[0]} y={pos[1]} opacity={fingerOpacity} press={press} />
    </div>
  );
};

export const Scene5Panel: React.FC = () => (
  <>
    <SidePanel
      kicker="多课表"
      title="多份课表，互不干扰"
      titleAccent="互不干扰"
      description="大三上、大三下，自己的、室友的——每份课表独立保存课程和学期设置。"
      features={[
        { icon: "layers", text: "点课表名一键切换当前课表" },
        { icon: "calendar", text: "每份课表独立保存学期设置" },
        { icon: "check", text: "复制课表做备份 · 导出 CSV 换机不丢" },
      ]}
      start={6}
    />
    <SceneFooter index={4} total={8} />
  </>
);

/* ================================================================
   场景 6 · 日夜主题（210f）
   点月亮 → 整屏平滑过渡到夜晚主题
================================================================ */
export const Scene6Screen: React.FC = () => {
  const frame = useCurrentFrame();
  // 主题过渡：70~115 帧
  const mixP = interpolate(frame, [70, 115], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const t = mixTheme(mixP);

  // 手指路径：月亮按钮(352,118)
  const seg = (a: number, b: number, from: [number, number], to: [number, number]) => {
    const p = interpolate(frame, [a, b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return [from[0] + (to[0] - from[0]) * p, from[1] + (to[1] - from[1]) * p] as [number, number];
  };
  const pos = frame < 60 ? seg(6, 56, [150, 620], [355, 131]) : [355, 131];
  const d = frame - 64;
  const press = d >= 0 && d <= 14 ? Math.sin((d / 14) * Math.PI) : 0;
  const fingerOpacity =
    interpolate(frame, [2, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) *
    interpolate(frame, [86, 98], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <div style={{ position: "absolute", inset: 0, backgroundColor: t.bg, fontFamily: FONT }}>
      <StatusBar t={t} />
      <TopBar t={t} name="大三上" week={9} parity="双周" dateText="2026年10月19日 · 星期一 · 共18周" />
      <WeekBar t={t} week={9} range="10/19 - 10/25" parity="双周" isNight={mixP > 0.5} moonGlow={press} />
      <ScheduleGrid t={t} courses={WEEK9} todayDay={1} startDay={19} />
      <Finger x={pos[0]} y={pos[1]} opacity={fingerOpacity} press={press} />
    </div>
  );
};

export const Scene6Panel: React.FC = () => {
  const frame = useCurrentFrame();
  const d = BRAND.day;
  const n = BRAND.night;
  const palatesIn = interpolate(frame, [40, 60], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const ColorDots: React.FC<{ colors: string[]; label: string; icon: "sun" | "moon" }> = ({
    colors,
    label,
    icon,
  }) => (
    <div
      style={{
        opacity: palatesIn,
        transform: `translateY(${(1 - palatesIn) * 18}px)`,
        backgroundColor: "#fffdf8",
        borderRadius: 20,
        padding: "18px 24px",
        boxShadow: "0 6px 24px rgba(36,30,22,0.10)",
        display: "flex",
        alignItems: "center",
        gap: 18,
        flex: 1,
      }}
    >
      <Icon name={icon} size={30} color={icon === "sun" ? "#b35a1f" : n.accent} strokeWidth={2} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: d.ink, marginBottom: 10 }}>{label}</div>
        <div style={{ display: "flex", gap: 10 }}>
          {colors.map((c) => (
            <div
              key={c}
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                backgroundColor: c,
                boxShadow: "0 0 0 1px rgba(36,30,22,0.14)",
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <SidePanel
        kicker="主题"
        title="白天清爽，夜晚护眼"
        titleAccent="护眼"
        description="柚子绿主色配一整套暖调中性色：白天是暖米色底，夜晚是暖黑底、亮绿字，怎么看着都舒服。"
        features={[{ icon: "check", text: "跟随系统自动切换 · 月亮图标一键切换" }]}
        start={6}
      />
      <div
        style={{
          position: "absolute",
          left: 900,
          top: 520,
          width: 880,
          display: "flex",
          gap: 22,
          fontFamily: FONT,
        }}
      >
        <ColorDots colors={[d.bg, d.surface, d.accent]} label="白天 · 暖米色" icon="sun" />
        <ColorDots colors={[n.bg, n.surface, n.accent]} label="夜晚 · 暖黑底" icon="moon" />
      </div>
      <SceneFooter index={5} total={8} />
    </>
  );
};

/* ================================================================
   场景 7 · 桌面小组件（210f）
   回到手机桌面 → 2x2 今日课程小组件 → 上滑看全天
================================================================ */
export const Scene7Screen: React.FC = () => {
  const frame = useCurrentFrame();
  const t = mixTheme(0);

  // 课表屏幕缩出 → 桌面缩入
  const appOut = interpolate(frame, [0, 14], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const homeIn = interpolate(frame, [10, 24], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // 小组件入场
  const widgetSpring = spring({
    frame: Math.max(0, frame - 26),
    fps: 30,
    config: { damping: 13, stiffness: 120, mass: 0.8 },
  });

  // 上滑查看其余课程，之后回弹
  const scrollUp = interpolate(frame, [88, 116], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scrollBack = interpolate(frame, [148, 172], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scrollP = frame < 148 ? scrollUp : scrollBack;

  // 手指：从下方移到小组件区域 → 上滑 → 离场
  const seg = (a: number, b: number, from: [number, number], to: [number, number]) => {
    const p = interpolate(frame, [a, b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return [from[0] + (to[0] - from[0]) * p, from[1] + (to[1] - from[1]) * p] as [number, number];
  };
  let pos: [number, number] = [105, 180];
  if (frame < 60) pos = seg(40, 58, [190, 700], [105, 190]);
  else if (frame < 116) pos = [105, 190 - scrollUp * 70]; // 跟手上滑
  else if (frame < 140) pos = [105, 120];
  else pos = [105, 120];
  const fingerOpacity =
    interpolate(frame, [36, 46], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) *
    interpolate(frame, [138, 150], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: FONT }}>
      {/* 课表屏幕（淡出） */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: appOut,
          transform: `scale(${1 - (1 - appOut) * 0.12})`,
          backgroundColor: t.bg,
        }}
      >
        <StatusBar t={t} />
        <TopBar t={t} name="大三上" week={9} parity="双周" dateText="2026年10月19日 · 星期一 · 共18周" />
        <WeekBar t={t} week={9} range="10/19 - 10/25" parity="双周" isNight />
        <ScheduleGrid t={t} courses={WEEK9} todayDay={1} startDay={19} />
      </div>

      {/* 桌面（淡入） */}
      <div style={{ position: "absolute", inset: 0, opacity: homeIn }}>
        <HomeScreen widgetAppear={widgetSpring} widgetScroll={scrollP} />
      </div>

      <Finger x={pos[0]} y={pos[1]} opacity={fingerOpacity} press={frame > 60 && frame < 116 ? 0.3 : 0} />
    </div>
  );
};

export const Scene7Panel: React.FC = () => (
  <>
    <SidePanel
      kicker="小组件"
      title="不开 App，也能看今天的课"
      titleAccent="不开 App"
      description="桌面上一块小卡片：今天几节课、下一节在哪上，抬眼就有。"
      features={[
        { icon: "widget", text: "2×2 今日课程 · 上下滑动看全天" },
        { icon: "layers", text: "4×2 今明两天各一栏" },
        { icon: "check", text: "30 分钟自动刷新 · 没课就显示「今天没课」" },
      ]}
      start={6}
    />
    <SceneFooter index={6} total={8} />
  </>
);

/* ================================================================
   场景 8 · 隐私与收尾（270f）
   三大特性卡片 + slogan
================================================================ */
export const Scene8Screen: React.FC = () => {
  const t = mixTheme(1); // 夜晚主题定格
  return (
    <div style={{ position: "absolute", inset: 0, backgroundColor: t.bg, fontFamily: FONT }}>
      <StatusBar t={t} />
      <TopBar t={t} name="大三上" week={9} parity="双周" dateText="2026年10月19日 · 星期一 · 共18周" />
      <WeekBar t={t} week={9} range="10/19 - 10/25" parity="双周" isNight />
      <ScheduleGrid t={t} courses={WEEK9} todayDay={1} startDay={19} />
    </div>
  );
};

export const Scene8Panel: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = BRAND.day;

  const cards = [
    {
      icon: "wifi-off" as const,
      title: "完全离线",
      desc: "装好之后看课表根本不需要联网，所有数据只存在你自己手机上。",
    },
    {
      icon: "lock" as const,
      title: "不碰你的账号",
      desc: "教务导入由你自己登录，不模拟登录、不保存账号密码、不上传数据。",
    },
    {
      icon: "shield" as const,
      title: "只申请一个权限",
      desc: "安装只要「联网」，不要定位、通讯录、相册、存储等任何敏感权限。",
    },
  ];

  const sloganIn = interpolate(frame, [196, 220], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const logoFloat = Math.sin(frame / 34) * 5;

  return (
    <div style={{ position: "absolute", left: 900, top: 130, width: 880, fontFamily: FONT }}>
      {/* 三大特性卡片 */}
      {cards.map((c, i) => {
        const s = 10 + i * 16;
        const sp = spring({
          frame: Math.max(0, frame - s),
          fps,
          config: { damping: 20, stiffness: 120, mass: 0.9 },
        });
        return (
          <div
            key={c.title}
            style={{
              opacity: sp,
              transform: `translateX(${interpolate(sp, [0, 1], [-44, 0])}px)`,
              display: "flex",
              alignItems: "center",
              gap: 22,
              backgroundColor: "#fffdf8",
              borderRadius: 22,
              padding: "24px 28px",
              marginBottom: 20,
              boxShadow: "0 8px 28px rgba(36,30,22,0.10)",
              borderLeft: `5px solid ${t.accent}`,
            }}
          >
            <div
              style={{
                width: 62,
                height: 62,
                borderRadius: 18,
                backgroundColor: t.accentSoft,
                color: t.accent,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Icon name={c.icon} size={32} strokeWidth={2} />
            </div>
            <div>
              <div style={{ fontSize: 32, fontWeight: 900, color: t.ink, marginBottom: 6 }}>{c.title}</div>
              <div style={{ fontSize: 22, color: t.sub, lineHeight: 1.5 }}>{c.desc}</div>
            </div>
          </div>
        );
      })}

      {/* slogan */}
      <div
        style={{
          opacity: sloganIn,
          transform: `translateY(${(1 - sloganIn) * 24}px)`,
          display: "flex",
          alignItems: "center",
          gap: 20,
          marginTop: 26,
        }}
      >
        <div style={{ transform: `translateY(${logoFloat * sloganIn}px)` }}>
          <Img
            src={staticFile("assets/youke-icon.png")}
            style={{
              width: 84,
              height: 84,
              borderRadius: 19,
              boxShadow: "0 8px 24px rgba(143,203,110,0.35)",
              display: "block",
            }}
          />
        </div>
        <div>
          <div style={{ fontSize: 44, fontWeight: 900, color: t.ink, letterSpacing: 2 }}>
            把课表<span style={{ color: t.accent }}>装进口袋</span>
          </div>
          <div style={{ fontSize: 22, color: t.sub, marginTop: 6, letterSpacing: 1 }}>
            柚课 · 干净整洁的手机课程表
          </div>
        </div>
      </div>

      <SceneFooter index={7} total={8} />
    </div>
  );
};
