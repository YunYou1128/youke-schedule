import { interpolate } from "remotion";
import { BRAND } from "./constants";

/** hex → [r,g,b] */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

export const rgbToHex = (r: number, g: number, b: number): string =>
  "#" +
  [r, g, b]
    .map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0"))
    .join("");

/** 两个 hex 之间插值，t∈[0,1] */
export function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const clamped = Math.min(1, Math.max(0, t));
  return rgbToHex(
    r1 + (r2 - r1) * clamped,
    g1 + (g2 - g1) * clamped,
    b1 + (b2 - b1) * clamped
  );
}

/** 主题令牌集合 */
export interface Theme {
  bg: string;
  surface: string;
  ink: string;
  accent: string;
  accentSoft: string;
  cardEdge: string;
  sub: string;
  line: string;
}

/** 白天/夜晚主题按进度混合（场景 6 平滑切换用） */
export function mixTheme(progress: number): Theme {
  const d = BRAND.day;
  const n = BRAND.night;
  const t = Math.min(1, Math.max(0, progress));
  return {
    bg: mixHex(d.bg, n.bg, t),
    surface: mixHex(d.surface, n.surface, t),
    ink: mixHex(d.ink, n.ink, t),
    accent: mixHex(d.accent, n.accent, t),
    accentSoft: mixHex(d.accentSoft, n.accentSoft, t),
    cardEdge: mixHex(d.cardEdge, n.cardEdge, t),
    sub: mixHex(d.sub, n.sub, t),
    line: mixHex(d.line, n.line, t),
  };
}

/** 淡入 + 上滑入场（最常用） */
export const fadeSlideUp = (frame: number, start: number, duration = 18, dist = 26) => ({
  opacity: interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }),
  transform: `translateY(${interpolate(frame, [start, start + duration + 6], [dist, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })}px)`,
});

/** 淡入 + 右滑入场 */
export const fadeSlideLeft = (frame: number, start: number, duration = 18, dist = 40) => ({
  opacity: interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }),
  transform: `translateX(${interpolate(frame, [start, start + duration + 6], [dist, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })}px)`,
});

/** 列表项 stagger 入场 */
export const staggerItem = (frame: number, index: number, gap = 8, start = 0) =>
  fadeSlideUp(frame, start + index * gap, 16, 24);
