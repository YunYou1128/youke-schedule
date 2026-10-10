import React from "react";
import { PHONE } from "./constants";

/** 手机外壳：深色边框 + 灵动岛 + 屏幕内容插槽 */
export const PhoneFrame: React.FC<{
  children: React.ReactNode;
  glow?: number;
}> = ({ children, glow = 0 }) => {
  const outerW = PHONE.screenW + PHONE.bezel * 2;
  const outerH = PHONE.screenH + PHONE.bezel * 2;
  return (
    <div
      style={{
        width: outerW,
        height: outerH,
        backgroundColor: PHONE.frameColor,
        borderRadius: PHONE.radius + PHONE.bezel,
        padding: PHONE.bezel,
        boxShadow:
          glow > 0
            ? `0 30px 70px rgba(30,40,20,0.35), 0 0 ${40 * glow}px rgba(143,203,110,${0.28 * glow})`
            : "0 30px 70px rgba(30,40,20,0.35)",
        position: "relative",
      }}
    >
      {/* 灵动岛 */}
      <div
        style={{
          position: "absolute",
          top: PHONE.bezel + 8,
          left: "50%",
          transform: "translateX(-50%)",
          width: 110,
          height: 22,
          backgroundColor: PHONE.frameColor,
          borderRadius: 999,
          zIndex: 30,
        }}
      />
      {/* 侧面按键 */}
      <div
        style={{
          position: "absolute",
          right: -3,
          top: 170,
          width: 3,
          height: 64,
          backgroundColor: PHONE.frameColor,
          borderRadius: 2,
        }}
      />
      {/* 屏幕 */}
      <div
        style={{
          width: PHONE.screenW,
          height: PHONE.screenH,
          borderRadius: PHONE.radius,
          overflow: "hidden",
          position: "relative",
          backgroundColor: "#f5efe3",
        }}
      >
        {children}
      </div>
    </div>
  );
};
