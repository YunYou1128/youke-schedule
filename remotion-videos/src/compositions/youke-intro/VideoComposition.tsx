import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import {
  BRAND,
  FONT,
  PHONE,
  SCENE_FRAMES,
  SCENE_STARTS,
  TOTAL_FRAMES,
  VIDEO_W,
  VIDEO_H,
} from "./constants";
import { PhoneFrame } from "./PhoneFrame";
import { Scene1Screen, Scene1Panel, Scene2Screen, Scene2Panel, Scene3Screen, Scene3Panel, Scene4Screen, Scene4Panel } from "./ScenesA";
import { Scene5Screen, Scene5Panel, Scene6Screen, Scene6Panel, Scene7Screen, Scene7Panel, Scene8Screen, Scene8Panel } from "./ScenesB";

/* ============ 背景装饰 ============ */
const Backdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const t = BRAND.day;
  const breathe = Math.sin(frame / 90) * 0.5 + 0.5;
  return (
    <>
      {/* 右下大圆弧 */}
      <div
        style={{
          position: "absolute",
          right: -420,
          bottom: -520,
          width: 1100,
          height: 1100,
          borderRadius: 999,
          background: `radial-gradient(circle, ${t.accent}14, transparent 65%)`,
        }}
      />
      {/* 左上淡圆 */}
      <div
        style={{
          position: "absolute",
          left: -260,
          top: -300,
          width: 720,
          height: 720,
          borderRadius: 999,
          background: `radial-gradient(circle, ${t.accentSoft}B0, transparent 70%)`,
          opacity: 0.55,
        }}
      />
      {/* 右上角淡格纹（呼应课表格子） */}
      <svg
        width="420"
        height="300"
        style={{ position: "absolute", right: 60, top: 52, opacity: 0.10 }}
      >
        {[0, 1, 2, 3, 4].map((r) =>
          [0, 1, 2, 3, 4, 5].map((c) => (
            <rect
              key={`${r}-${c}`}
              x={c * 68 + 8}
              y={r * 56 + 8}
              width="54"
              height="42"
              rx="9"
              fill={r === 1 && c === 2 ? t.accent : "none"}
              stroke={t.accent}
              strokeWidth="2"
            />
          ))
        )}
      </svg>
      {/* 背景呼吸光点 */}
      <div
        style={{
          position: "absolute",
          left: 760,
          top: 140,
          width: 14,
          height: 14,
          borderRadius: 999,
          backgroundColor: t.accent,
          opacity: 0.14 + 0.1 * breathe,
        }}
      />
    </>
  );
};

/* ============ 顶部总进度条 ============ */
const TopProgress: React.FC = () => {
  const frame = useCurrentFrame();
  const p = frame / TOTAL_FRAMES;
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 5, backgroundColor: "#e7dfcd" }}>
      <div
        style={{
          width: `${p * 100}%`,
          height: "100%",
          background: `linear-gradient(to right, ${BRAND.day.accent}, #8fcb6e)`,
        }}
      />
    </div>
  );
};

/* ============ 主合成 ============ */
export const YoukeIntroComposition: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 手机入场：从左侧滑入（easeOutExpo，26 帧完成）
  const enterP = interpolate(frame, [0, 26], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  // 场景 8：手机向中间平移
  const s8Shift = interpolate(
    frame,
    [SCENE_STARTS.s8 + 4, SCENE_STARTS.s8 + 34],
    [0, PHONE.centerCenterX - PHONE.leftCenterX],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  // 轻微浮动
  const float = Math.sin(frame / 85) * 5;

  const phoneX = -320 + enterP * (PHONE.leftCenterX + 320) + s8Shift;
  const phoneY = PHONE.centerY + float;

  const outerW = PHONE.screenW + PHONE.bezel * 2;
  const outerH = PHONE.screenH + PHONE.bezel * 2;

  return (
    <AbsoluteFill style={{ backgroundColor: BRAND.day.bg, fontFamily: FONT, overflow: "hidden" }}>
      <Backdrop />
      <TopProgress />

      {/* 手机（跨场景常驻） */}
      <div
        style={{
          position: "absolute",
          left: phoneX - outerW / 2,
          top: phoneY - outerH / 2,
        }}
      >
        <PhoneFrame>
          {/* 屏幕内容按场景切换 */}
          <Sequence from={0} durationInFrames={SCENE_FRAMES.s1}>
            <Scene1Screen />
          </Sequence>
          <Sequence from={SCENE_STARTS.s2} durationInFrames={SCENE_FRAMES.s2}>
            <Scene2Screen />
          </Sequence>
          <Sequence from={SCENE_STARTS.s3} durationInFrames={SCENE_FRAMES.s3}>
            <Scene3Screen />
          </Sequence>
          <Sequence from={SCENE_STARTS.s4} durationInFrames={SCENE_FRAMES.s4}>
            <Scene4Screen />
          </Sequence>
          <Sequence from={SCENE_STARTS.s5} durationInFrames={SCENE_FRAMES.s5}>
            <Scene5Screen />
          </Sequence>
          <Sequence from={SCENE_STARTS.s6} durationInFrames={SCENE_FRAMES.s6}>
            <Scene6Screen />
          </Sequence>
          <Sequence from={SCENE_STARTS.s7} durationInFrames={SCENE_FRAMES.s7}>
            <Scene7Screen />
          </Sequence>
          <Sequence from={SCENE_STARTS.s8} durationInFrames={SCENE_FRAMES.s8}>
            <Scene8Screen />
          </Sequence>
        </PhoneFrame>
      </div>

      {/* 右侧面板按场景切换 */}
      <Sequence from={0} durationInFrames={SCENE_FRAMES.s1}>
        <Scene1Panel />
      </Sequence>
      <Sequence from={SCENE_STARTS.s2} durationInFrames={SCENE_FRAMES.s2}>
        <Scene2Panel />
      </Sequence>
      <Sequence from={SCENE_STARTS.s3} durationInFrames={SCENE_FRAMES.s3}>
        <Scene3Panel />
      </Sequence>
      <Sequence from={SCENE_STARTS.s4} durationInFrames={SCENE_FRAMES.s4}>
        <Scene4Panel />
      </Sequence>
      <Sequence from={SCENE_STARTS.s5} durationInFrames={SCENE_FRAMES.s5}>
        <Scene5Panel />
      </Sequence>
      <Sequence from={SCENE_STARTS.s6} durationInFrames={SCENE_FRAMES.s6}>
        <Scene6Panel />
      </Sequence>
      <Sequence from={SCENE_STARTS.s7} durationInFrames={SCENE_FRAMES.s7}>
        <Scene7Panel />
      </Sequence>
      <Sequence from={SCENE_STARTS.s8} durationInFrames={SCENE_FRAMES.s8}>
        <Scene8Panel />
      </Sequence>
    </AbsoluteFill>
  );
};
