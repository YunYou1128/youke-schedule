import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { BRAND, FONT, PANEL } from "./constants";
import { Icon, type IconName } from "./icons";
import { fadeSlideUp } from "./utils";

export interface FeatureItem {
  icon: IconName;
  text: string;
}

export interface SidePanelProps {
  kicker: string; // 顶部小标签
  title: string;
  titleAccent?: string; // 标题里的强调词（柚绿色）
  description?: string;
  features?: FeatureItem[];
  bigStat?: { num: string; label: string };
  footnote?: string; // 大数字下方的小字说明
  start?: number; // 入场起始帧（场景相对帧）
  children?: React.ReactNode;
}

/** 右侧功能介绍面板：标签 → 大标题 → 描述 → 特性列表 → 大数字 */
export const SidePanel: React.FC<SidePanelProps> = ({
  kicker,
  title,
  titleAccent,
  description,
  features = [],
  bigStat,
  footnote,
  start = 6,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = BRAND.day;

  // 标题整体弹入
  const titleSpring = spring({
    frame: Math.max(0, frame - start),
    fps,
    config: { damping: 20, stiffness: 120, mass: 0.9 },
  });

  // 标题按 accent 词拆分渲染
  let titleParts: React.ReactNode[] = [title];
  if (titleAccent && title.includes(titleAccent)) {
    const idx = title.indexOf(titleAccent);
    titleParts = [
      <span key="a">{title.slice(0, idx)}</span>,
      <span key="b" style={{ color: t.accent }}>{titleAccent}</span>,
      <span key="c">{title.slice(idx + titleAccent.length)}</span>,
    ];
  }

  return (
    <div
      style={{
        position: "absolute",
        left: PANEL.x,
        top: 150,
        width: PANEL.width,
        fontFamily: FONT,
      }}
    >
      {/* kicker 标签 */}
      <div
        style={{
          ...fadeSlideUp(frame, start, 12, 14),
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          backgroundColor: t.accentSoft,
          color: t.accent,
          borderRadius: 999,
          padding: "7px 18px",
          fontSize: 21,
          fontWeight: 800,
          letterSpacing: 2,
          marginBottom: 22,
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: t.accent }} />
        {kicker}
      </div>

      {/* 大标题 */}
      <div
        style={{
          opacity: titleSpring,
          transform: `translateY(${interpolate(titleSpring, [0, 1], [22, 0])}px)`,
          fontSize: 62,
          fontWeight: 900,
          color: t.ink,
          lineHeight: 1.18,
          letterSpacing: 1,
          marginBottom: description ? 18 : 26,
        }}
      >
        {titleParts}
      </div>

      {/* 描述 */}
      {description && (
        <div
          style={{
            ...fadeSlideUp(frame, start + 10, 16),
            fontSize: 27,
            color: t.sub,
            lineHeight: 1.65,
            marginBottom: 34,
            maxWidth: 820,
          }}
        >
          {description}
        </div>
      )}

      {/* 特性列表 */}
      {features.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {features.map((f, i) => {
            const s = start + 18 + i * 7;
            const sp = spring({
              frame: Math.max(0, frame - s),
              fps,
              config: { damping: 20, stiffness: 150, mass: 0.7 },
            });
            return (
              <div
                key={f.text}
                style={{
                  opacity: sp,
                  transform: `translateX(${interpolate(sp, [0, 1], [-34, 0])}px)`,
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                }}
              >
                <div
                  style={{
                    width: 46,
                    height: 46,
                    borderRadius: 14,
                    backgroundColor: t.accentSoft,
                    color: t.accent,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <Icon name={f.icon} size={24} strokeWidth={2.1} />
                </div>
                <span style={{ fontSize: 27, fontWeight: 600, color: t.ink }}>{f.text}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* 大数字统计 */}
      {bigStat && (
        <>
          <div
            style={{
              ...fadeSlideUp(frame, start + 22 + features.length * 7, 18, 20),
              display: "flex",
              alignItems: "baseline",
              gap: 14,
              marginTop: 38,
            }}
          >
            <span style={{ fontSize: 76, fontWeight: 900, color: t.accent, lineHeight: 1, letterSpacing: 1 }}>
              {bigStat.num}
            </span>
            <span style={{ fontSize: 26, fontWeight: 600, color: t.sub }}>{bigStat.label}</span>
          </div>
          {footnote && (
            <div
              style={{
                ...fadeSlideUp(frame, start + 34 + features.length * 7, 14, 12),
                marginTop: 16,
                fontSize: 17,
                color: t.sub,
                lineHeight: 1.5,
              }}
            >
              {footnote}
            </div>
          )}
        </>
      )}

      {children}
    </div>
  );
};

/** 页脚：场景进度指示（固定在视口底部） */
export const SceneFooter: React.FC<{ index: number; total: number }> = ({ index, total }) => (
  <div
    style={{
      position: "fixed",
      bottom: 34,
      left: PANEL.x,
      display: "flex",
      alignItems: "center",
      gap: 10,
    }}
  >
    {Array.from({ length: total }).map((_, i) => (
      <div
        key={i}
        style={{
          width: i === index ? 26 : 9,
          height: 9,
          borderRadius: 999,
          backgroundColor: i === index ? BRAND.day.accent : "#d5cbb6",
        }}
      />
    ))}
    <span
      style={{
        marginLeft: 14,
        fontSize: 18,
        fontWeight: 800,
        color: "#b3a98f",
        letterSpacing: 3,
      }}
    >
      柚课 YOUKE
    </span>
  </div>
);
