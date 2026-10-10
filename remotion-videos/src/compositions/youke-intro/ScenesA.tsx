import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate, Easing, Img, staticFile } from "remotion";
import { BRAND, FONT, WEEK8, WEEK8_START_DAY, type DemoCourse } from "./constants";
import { mixTheme } from "./utils";
import {
  StatusBar,
  TopBar,
  WeekBar,
  ScheduleGrid,
  SheetMask,
  CenterCard,
  PageMask,
  Toast,
  Finger,
} from "./YoukeUI";
import {
  ImportPanelBody,
  SchoolListBody,
  CourseDetailBody,
  ColorPickerBody,
  EditCourseFormBody,
} from "./YoukeSheets";
import { SidePanel, SceneFooter } from "./SidePanel";

const DATE_TEXT = "2026年10月12日 · 星期一 · 共18周";

/* ================================================================
   场景 1 · 开场（120f）
================================================================ */
export const Scene1Screen: React.FC = () => {
  const t = mixTheme(0);
  return (
    <div style={{ position: "absolute", inset: 0, backgroundColor: t.bg, fontFamily: FONT }}>
      <StatusBar t={t} />
      <TopBar t={t} name="我的课表" week={8} parity="单周" dateText={DATE_TEXT} />
      <WeekBar t={t} week={8} range="10/12 - 10/18" parity="单周" />
      <ScheduleGrid t={t} courses={WEEK8} todayDay={1} startDay={WEEK8_START_DAY} appearFrom={26} />
    </div>
  );
};

export const Scene1Panel: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = BRAND.day;
  const logoSpring = spring({
    frame: Math.max(0, frame - 4),
    fps,
    config: { damping: 12, stiffness: 110, mass: 0.9 },
  });
  const nameSpring = spring({
    frame: Math.max(0, frame - 14),
    fps,
    config: { damping: 20, stiffness: 120 },
  });
  const pills = ["完全离线", "不碰账号", "干净简洁"];
  return (
    <div style={{ position: "absolute", left: 900, top: 170, width: 880, fontFamily: FONT }}>
      <div
        style={{
          transform: `scale(${logoSpring}) rotate(${interpolate(logoSpring, [0, 1], [-8, 0])}deg)`,
          width: 132,
        }}
      >
        <Img
          src={staticFile("assets/youke-icon.png")}
          style={{
            width: 132,
            height: 132,
            borderRadius: 30,
            boxShadow: "0 10px 28px rgba(90,70,40,0.18)",
            display: "block",
          }}
        />
      </div>
      <div
        style={{
          opacity: nameSpring,
          transform: `translateY(${interpolate(nameSpring, [0, 1], [26, 0])}px)`,
          fontSize: 118,
          fontWeight: 900,
          color: t.ink,
          letterSpacing: 6,
          lineHeight: 1.1,
          marginTop: 18,
        }}
      >
        柚课
      </div>
      <div
        style={{
          opacity: interpolate(frame, [26, 44], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          fontSize: 34,
          fontWeight: 600,
          color: t.sub,
          marginTop: 10,
          letterSpacing: 2,
        }}
      >
        干净整洁的手机课程表
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 44 }}>
        {pills.map((p, i) => (
          <div
            key={p}
            style={{
              opacity: interpolate(frame, [46 + i * 8, 60 + i * 8], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
              transform: `translateY(${interpolate(frame, [46 + i * 8, 62 + i * 8], [16, 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              })}px)`,
              display: "flex",
              alignItems: "center",
              gap: 9,
              backgroundColor: t.accentSoft,
              borderRadius: 999,
              padding: "12px 24px",
              fontSize: 24,
              fontWeight: 700,
              color: t.accent,
            }}
          >
            <span style={{ width: 9, height: 9, borderRadius: 999, backgroundColor: t.accent }} />
            {p}
          </div>
        ))}
      </div>
      <SceneFooter index={0} total={8} />
    </div>
  );
};

/* ================================================================
   场景 2 · 一键导入（300f）
   空态（真实文案）→ 导入面板（真实结构）→ 学校列表（真实结构）
   → 关闭 → 黑色 toast「已导入 14 门课程」→ 卡片落位
================================================================ */
export const Scene2Screen: React.FC = () => {
  const frame = useCurrentFrame();
  const t = mixTheme(0);

  const fingerOpacity =
    interpolate(frame, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) *
    interpolate(frame, [196, 208], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const seg = (a: number, b: number, from: [number, number], to: [number, number]) => {
    const p = interpolate(frame, [a, b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return [from[0] + (to[0] - from[0]) * p, from[1] + (to[1] - from[1]) * p] as [number, number];
  };
  const pressAt = (at: number) => {
    const d = frame - at;
    if (d < 0 || d > 14) return 0;
    return Math.sin((d / 14) * Math.PI);
  };

  let pos: [number, number] = [225, 52];
  if (frame < 40) pos = seg(8, 38, [320, 700], [218, 56]); // 移向「导入」按钮
  else if (frame < 96) pos = [218, 56];
  else if (frame < 130) pos = seg(96, 128, [218, 56], [190, 342]); // 移向绿色主按钮
  else if (frame < 168) pos = [190, 342];
  else if (frame < 200) pos = seg(168, 198, [190, 342], [190, 451]); // 移向学校卡
  else pos = [190, 451];

  const press = Math.max(pressAt(44), pressAt(104), pressAt(174));

  const schoolHit = interpolate(frame, [174, 184], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const courses: DemoCourse[] | null = frame >= 204 ? WEEK8 : null;

  return (
    <div style={{ position: "absolute", inset: 0, backgroundColor: t.bg, fontFamily: FONT }}>
      <StatusBar t={t} />
      <TopBar
        t={t}
        name="我的课表"
        week={8}
        parity="单周"
        dateText={DATE_TEXT}
        highlightIcon={frame > 36 && frame < 60 ? 0 : null}
      />
      <WeekBar t={t} week={8} range="10/12 - 10/18" parity="单周" />
      {courses ? (
        <ScheduleGrid t={t} courses={courses} todayDay={1} startDay={WEEK8_START_DAY} appearFrom={206} />
      ) : (
        <div
          style={{
            position: "absolute",
            top: 330,
            left: 0,
            right: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            textAlign: "center",
            opacity:
              interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) *
              interpolate(frame, [200, 214], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}
        >
          <span style={{ fontSize: 30 }}>📚</span>
          <div style={{ fontSize: 12.5, color: t.ink, fontWeight: 700, lineHeight: 1.6 }}>
            「我的课表」还没有课程
          </div>
          <div style={{ fontSize: 10, color: t.sub, lineHeight: 1.6 }}>
            点右上角「导入课表」选文件，或点「＋」手动添加
          </div>
        </div>
      )}

      {/* 导入面板（真实结构） */}
      <SheetMask t={t} openAt={56} closeAt={110} height={600}>
        <ImportPanelBody t={t} activeBtn={frame >= 104 && frame < 110 ? 0 : null} />
      </SheetMask>

      {/* 学校列表（真实结构） */}
      <SheetMask t={t} openAt={120} closeAt={190} height={640}>
        <SchoolListBody t={t} targetHit={schoolHit} typedText="柚子大学" />
      </SheetMask>

      {/* 导入完成 toast（真实交互） */}
      <Toast text="已导入 14 门课程" showAt={200} hideAt={256} />

      {frame < 208 && <Finger x={pos[0]} y={pos[1]} opacity={fingerOpacity} press={press} />}
    </div>
  );
};

export const Scene2Panel: React.FC = () => (
  <>
    <SidePanel
      kicker="导入"
      title="一键导入课表"
      titleAccent="一键导入"
      description="打开你学校的教务系统，自己登录，点一下「执行导入」——课表自己回来，不用截图、不用手打。"
      features={[
        { icon: "school", text: "教务系统自动适配，脚本社区维护" },
        { icon: "file", text: "Excel / PDF / 网页课表，选中就吃" },
        { icon: "check", text: "自动合并拆行、去重、放宽周数" },
      ]}
      bigStat={{ num: "200+", label: "所学校开箱即用" }}
      footnote="感谢「拾光教务导入」开发者的贡献"
      start={8}
    />
    <SceneFooter index={1} total={8} />
  </>
);

/* ================================================================
   场景 3 · 周课表（240f）
   手指拖动 → 网格平滑跟手 → 松手后平滑切周并回弹
================================================================ */
export const Scene3Screen: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = mixTheme(0);

  // 手指拖动手势：48~64 向左滑（第8→第9周），104~122 向右滑回
  const dragP = interpolate(frame, [48, 64], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const dragP2 = interpolate(frame, [104, 122], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });

  // 跟手位移（平滑）
  const followX = -130 * dragP + 130 * dragP2;

  // 松手后回弹（spring）：64 后从 -130 弹回 0（已切到第9周），122 后从 130 弹回 0
  const settle1 = spring({
    frame: Math.max(0, frame - 64),
    fps,
    config: { damping: 20, stiffness: 180, mass: 0.7 },
  });
  const settle2 = spring({
    frame: Math.max(0, frame - 122),
    fps,
    config: { damping: 20, stiffness: 180, mass: 0.7 },
  });

  // 分段：拖动段用 followX，回弹段用 settle
  let slideX: number;
  if (frame < 64) {
    slideX = -130 * dragP;
  } else if (frame < 104) {
    slideX = -130 * (1 - settle1);
  } else if (frame < 122) {
    slideX = 130 * dragP2;
  } else {
    slideX = 130 * (1 - settle2);
  }

  // 周次切换判断：拖过中线即切换
  const atWeek9 = frame >= 64 && frame < 104;
  const week = atWeek9 ? 9 : 8;
  const range = atWeek9 ? "10/19 - 10/25" : "10/12 - 10/18";
  const parity = atWeek9 ? "双周" : "单周";
  const courses = atWeek9
    ? WEEK8.filter((c) => !c.oddOnly).concat([
        { name: "创新创业基础", room: "教四-308", day: 6, start: 3, end: 4, color: "#c026a5" },
      ])
    : WEEK8;

  // 手指位置：跟手
  const fingerOpacity =
    interpolate(frame, [8, 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) *
    interpolate(frame, [130, 140], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fx = interpolate(frame, [48, 64], [300, 70], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fx2 = interpolate(frame, [104, 122], [70, 300], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fingerX = frame < 104 ? fx : fx2;
  const fy = 400;

  return (
    <div style={{ position: "absolute", inset: 0, backgroundColor: t.bg, fontFamily: FONT }}>
      <StatusBar t={t} />
      <TopBar
        t={t}
        name="我的课表"
        week={week}
        parity={parity}
        dateText={atWeek9 ? "2026年10月19日 · 星期一 · 共18周" : DATE_TEXT}
      />
      <WeekBar t={t} week={week} range={range} parity={parity} awayFromToday={atWeek9} />
      <ScheduleGrid
        t={t}
        courses={courses}
        todayDay={1}
        startDay={atWeek9 ? 19 : WEEK8_START_DAY}
        slideX={slideX}
      />
      <Finger x={fingerX} y={fy} opacity={fingerOpacity} press={frame > 48 && frame < 122 ? 0.35 : 0} />
    </div>
  );
};

export const Scene3Panel: React.FC = () => (
  <>
    <SidePanel
      kicker="周课表"
      title="一眼看清这一周"
      titleAccent="一眼"
      description="七天七列、一屏八节，干净得像一张手绘课表。左右滑动切周，单双周的课自动区分。"
      features={[
        { icon: "swipe", text: "左右滑动切换周次 · 没滑够会回弹" },
        { icon: "calendar", text: "单双周自动区分，第几周一目了然" },
        { icon: "layers", text: "同一时段两门课？自动并排不遮挡" },
      ]}
      bigStat={{ num: "8", label: "节课一屏放下，不用缩放拖拽" }}
      start={6}
    />
    <SceneFooter index={2} total={8} />
  </>
);

/* ================================================================
   场景 4 · 课程详情与编辑（240f）
   点高数卡 → 真实详情弹层 → 点「编辑」→ 真实取色器（居中卡）
   → 保存 → 卡片变橙色
================================================================ */
const HIGHLIGHT_COURSE: DemoCourse = {
  name: "高等数学A(2)",
  room: "教三-301",
  teacher: "张伟",
  day: 1,
  start: 1,
  end: 2,
  color: "#d81b60",
};

export const Scene4Screen: React.FC = () => {
  const frame = useCurrentFrame();
  const t = mixTheme(0);

  const fingerOpacity =
    interpolate(frame, [4, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) *
    interpolate(frame, [252, 262], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const seg = (a: number, b: number, from: [number, number], to: [number, number]) => {
    const p = interpolate(frame, [a, b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return [from[0] + (to[0] - from[0]) * p, from[1] + (to[1] - from[1]) * p] as [number, number];
  };
  // 高数卡中心 (64, 266)；详情编辑按钮 (71, 640)；
  // 编辑表单彩虹圆 (299, 157)；取色器面板 (150, 330)；保存 (265, 500)
  let pos: [number, number] = [64, 266];
  if (frame < 30) pos = seg(6, 28, [180, 620], [64, 266]); // 移向高数卡
  else if (frame < 118) pos = [64, 266];
  else if (frame < 148) pos = seg(118, 146, [64, 266], [71, 640]); // 移向「编辑」
  else if (frame < 170) pos = [71, 640]; // 按下编辑，表单滑入
  else if (frame < 198) pos = seg(170, 196, [71, 640], [299, 157]); // 表单内移向彩虹圆
  else if (frame < 216) pos = [299, 157]; // 按彩虹圆，进取色器
  else if (frame < 234) pos = seg(216, 232, [299, 157], [150, 330]); // 移向渐变面板
  else if (frame < 238) pos = [150, 330]; // 按面板选色
  else pos = seg(238, 252, [150, 330], [265, 500]); // 移向「保存」

  const pressAt = (at: number) => {
    const d = frame - at;
    if (d < 0 || d > 14) return 0;
    return Math.sin((d / 14) * Math.PI);
  };
  const press = Math.max(pressAt(32), pressAt(152), pressAt(204), pressAt(232), pressAt(254));

  // 取色：232 按下面板后 hue 330 → 25 过渡
  const hueP = interpolate(frame, [232, 244], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const hue = 330 + (25 - 330) * hueP;
  const colorHex = hueP < 0.5 ? "#D81B60" : "#EF6C00";

  // 高数卡颜色：保存（254）后 玫红 → 橙
  const colorP = interpolate(frame, [256, 266], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const courses = WEEK8.map((c) =>
    c === HIGHLIGHT_COURSE
      ? {
          ...c,
          color: mixColorTo("#d81b60", "#ef6c00", colorP),
        }
      : c
  );

  return (
    <div style={{ position: "absolute", inset: 0, backgroundColor: t.bg, fontFamily: FONT }}>
      <StatusBar t={t} />
      <TopBar t={t} name="我的课表" week={8} parity="单周" dateText={DATE_TEXT} />
      <WeekBar t={t} week={8} range="10/12 - 10/18" parity="单周" />
      <ScheduleGrid t={t} courses={courses} todayDay={1} startDay={WEEK8_START_DAY} />

      {/* 课程详情（真实结构） */}
      <SheetMask t={t} openAt={44} closeAt={158} height={430}>
        <CourseDetailBody
          t={t}
          course={{
            name: "高等数学A(2)",
            teacher: "张伟",
            room: "教三-301",
            day: "星期一",
            period: "第 1 - 2 节（共 2 节）",
            time: "08:00 - 09:40",
            weeks: "1-16",
            parityLabel: "单双周均有",
          }}
        />
      </SheetMask>

      {/* 编辑课程表单页（真实结构过渡页） */}
      <PageMask t={t} openAt={164} closeAt={214} title="编辑课程" rightNode={<span style={{ width: 30 }} />}>
        <EditCourseFormBody t={t} name="高等数学A(2)" teacher="张伟" room="教三-301" weeks="1-16" />
      </PageMask>

      {/* 取色器（真实结构：居中卡 + 渐变面板 + 彩虹条） */}
      <CenterCard t={t} openAt={220} closeAt={256}>
        <ColorPickerBody
          t={t}
          hue={hue}
          cursor={{ x: 0.8 - hueP * 0.12, y: 0.42 + hueP * 0.16, bar: 0.88 - hueP * 0.06 }}
          colorHex={colorHex}
          previewName="高等数学"
        />
      </CenterCard>

      <Finger x={pos[0]} y={pos[1]} opacity={fingerOpacity} press={press} />
    </div>
  );
};

/** 双色插值（场景内局部用） */
function mixColorTo(a: string, b: string, p: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) + (((pb >> 16) & 255) - ((pa >> 16) & 255)) * p);
  const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * p);
  const bl = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * p);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0")}`;
}

export const Scene4Panel: React.FC = () => (
  <>
    <SidePanel
      kicker="编辑"
      title="点一下，改哪里都方便"
      titleAccent="点一下"
      description="每张卡片点开就是完整信息：时间、地点、老师、周次。改颜色、复制、删除都在手边。"
      features={[
        { icon: "palette", text: "取色器自定义卡片颜色 · 直接输色值" },
        { icon: "clipboard", text: "复制完整课程，或只复制课程名" },
        { icon: "calendar", text: "上课时间表整页可调 · 滚轮拨时间" },
      ]}
      start={6}
    />
    <SceneFooter index={3} total={8} />
  </>
);
