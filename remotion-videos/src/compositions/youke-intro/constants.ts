// ============ EDITABLE CONSTANTS ============
// 柚课介绍视频 · 设计系统与内容常量
// 配色取自 web/css/app.css 的真实主题令牌

export const FPS = 30;
export const VIDEO_W = 1920;
export const VIDEO_H = 1080;

/** 字体栈：本机渲染保证可用，不依赖网络字体 */
export const FONT =
  "'Noto Sans SC','PingFang SC','Microsoft YaHei','Source Han Sans SC',sans-serif";

/** 柚课品牌令牌（取自 app.css 白天/夜晚两套主题块） */
export const BRAND = {
  // 白天主题
  day: {
    bg: "#f5efe3",
    surface: "#fffdf8",
    ink: "#241e16",
    accent: "#3e7c2e",
    accentSoft: "#edf4e4",
    cardEdge: "#a89a86",
    sub: "#8a8070", // 次要文字（暖灰）
    line: "#e7dfcd", // 分隔线
  },
  // 夜晚主题
  night: {
    bg: "#16130d",
    surface: "#1d1913",
    ink: "#f1ebdf",
    accent: "#8fcb6e",
    accentSoft: "#232c19",
    cardEdge: "#ffffff",
    sub: "#a39a89",
    line: "#332e24",
  },
  // 图标专用柚黄
  pomeloYellow: "#F9D06F",
} as const;

/** 课程卡片演示色板（对照真实应用截图的鲜艳配色） */
export const CARD_COLORS = {
  rose: "#d81b60",
  blue: "#0288d1",
  purple: "#8e24aa",
  teal: "#26a69a",
  orange: "#ef6c00",
  indigo: "#5c6bc0",
  red: "#e53935",
  magenta: "#c026a5",
  green: "#43a047",
} as const;

/** 手机框参数 */
export const PHONE = {
  screenW: 380,
  screenH: 780,
  bezel: 12,
  radius: 44,
  frameColor: "#2b2620",
  // 手机在画布上的位置（屏幕中心坐标）
  leftCenterX: 470,
  centerCenterX: 620,
  centerY: 540,
} as const;

/** 每节课时间（一屏 8 节） */
export const PERIODS = [
  { n: 1, start: "08:00", end: "08:45" },
  { n: 2, start: "08:55", end: "09:40" },
  { n: 3, start: "10:00", end: "10:45" },
  { n: 4, start: "10:55", end: "11:40" },
  { n: 5, start: "14:00", end: "14:45" },
  { n: 6, start: "14:55", end: "15:40" },
  { n: 7, start: "16:00", end: "16:45" },
  { n: 8, start: "16:55", end: "17:40" },
] as const;

/** 演示课程表：day 1=周一…7=周日；oddOnly=true 表示单周才有 */
export interface DemoCourse {
  name: string;
  room: string;
  teacher?: string;
  day: number;
  start: number;
  end: number;
  color: string;
  oddOnly?: boolean;
}

export const WEEK8: DemoCourse[] = [
  { name: "高等数学A(2)", room: "教三-301", teacher: "张伟", day: 1, start: 1, end: 2, color: CARD_COLORS.rose },
  { name: "大学英语(4)", room: "外语楼-204", teacher: "李娜", day: 1, start: 3, end: 4, color: CARD_COLORS.blue },
  { name: "数据结构", room: "实验楼-405", teacher: "陈强", day: 1, start: 6, end: 7, color: CARD_COLORS.purple },
  { name: "线性代数", room: "教二-210", teacher: "王芳", day: 2, start: 1, end: 2, color: CARD_COLORS.orange },
  { name: "体育(网球)", room: "东操场", teacher: "刘洋", day: 2, start: 3, end: 4, color: CARD_COLORS.green },
  { name: "数据结构实验", room: "实验楼-405", teacher: "陈强", day: 3, start: 1, end: 2, color: CARD_COLORS.purple },
  { name: "毛概", room: "教四-102", teacher: "赵敏", day: 3, start: 3, end: 4, color: CARD_COLORS.red, oddOnly: true },
  { name: "操作系统", room: "计算机楼-B301", teacher: "孙磊", day: 3, start: 6, end: 8, color: CARD_COLORS.orange },
  { name: "高等数学A(2)", room: "教三-301", teacher: "张伟", day: 4, start: 1, end: 2, color: CARD_COLORS.rose },
  { name: "Java程序设计", room: "计算机楼-A102", teacher: "周涛", day: 4, start: 3, end: 5, color: CARD_COLORS.indigo },
  { name: "数据库原理", room: "教三-209", teacher: "吴静", day: 4, start: 7, end: 8, color: CARD_COLORS.magenta },
  { name: "计算机组成原理", room: "教二-115", teacher: "郑华", day: 5, start: 1, end: 3, color: CARD_COLORS.orange },
  { name: "大学英语(4)", room: "外语楼-204", teacher: "李娜", day: 5, start: 4, end: 5, color: CARD_COLORS.blue },
  { name: "艺术导论", room: "音乐楼-201", day: 5, start: 6, end: 7, color: CARD_COLORS.teal },
];

/** 第 9 周（双周）：毛概消失，周六多一门选修 */
export const WEEK9: DemoCourse[] = [
  ...WEEK8.filter((c) => !c.oddOnly),
  { name: "创新创业基础", room: "教四-308", day: 6, start: 3, end: 4, color: CARD_COLORS.magenta },
];

/** 周起始日（10月第几号），用于表头日期 */
export const WEEK8_START_DAY = 12; // 10/12 周一
export const WEEK9_START_DAY = 19; // 10/19 周一

/** 场景时间表（帧） */
export const SCENE_FRAMES = {
  s1: 120, // 开场 4s
  s2: 300, // 一键导入 10s
  s3: 240, // 周课表 8s
  s4: 270, // 详情与编辑 9s
  s5: 180, // 多课表 6s
  s6: 210, // 日夜主题 7s
  s7: 210, // 桌面小组件 7s
  s8: 270, // 隐私收尾 9s
} as const;

export const SCENE_STARTS = (() => {
  const keys = Object.keys(SCENE_FRAMES) as (keyof typeof SCENE_FRAMES)[];
  const starts: Record<string, number> = {};
  let acc = 0;
  for (const k of keys) {
    starts[k] = acc;
    acc += SCENE_FRAMES[k];
  }
  return starts;
})();

export const TOTAL_FRAMES = Object.values(SCENE_FRAMES).reduce((a, b) => a + b, 0);

/** 右侧面板基准位置 */
export const PANEL = {
  x: 900, // 左边缘
  width: 880,
} as const;
