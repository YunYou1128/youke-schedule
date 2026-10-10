import React from "react";

/** 简约描边图标集（24x24 viewBox，stroke 跟随 currentColor） */
export type IconName =
  | "check"
  | "lock"
  | "shield"
  | "calendar"
  | "file"
  | "clipboard"
  | "moon"
  | "sun"
  | "widget"
  | "share"
  | "swipe"
  | "palette"
  | "layers"
  | "download"
  | "school"
  | "plus"
  | "wifi-off"
  | "sparkle"
  | "settings"
  | "search"
  | "chevron-right"
  | "phone"
  | "message"
  | "camera"
  | "compass"
  | "tune"
  | "globe";

const paths: Record<IconName, React.ReactNode> = {
  check: <polyline points="20 6 9 17 4 12" />,
  lock: (
    <>
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z" />
      <polyline points="9 12 11 14 15 10" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="8" y1="3" x2="8" y2="6" />
      <line x1="16" y1="3" x2="16" y2="6" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z" />
      <polyline points="14 3 14 9 20 9" />
    </>
  ),
  clipboard: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2" />
      <line x1="9" y1="10" x2="15" y2="10" />
      <line x1="9" y1="14" x2="13" y2="14" />
    </>
  ),
  moon: <path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="22" />
      <line x1="4.9" y1="4.9" x2="6.3" y2="6.3" />
      <line x1="17.7" y1="17.7" x2="19.1" y2="19.1" />
      <line x1="2" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="22" y2="12" />
      <line x1="4.9" y1="19.1" x2="6.3" y2="17.7" />
      <line x1="17.7" y1="6.3" x2="19.1" y2="4.9" />
    </>
  ),
  widget: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  share: (
    <>
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <line x1="8.2" y1="10.8" x2="15.8" y2="7.2" />
      <line x1="8.2" y1="13.2" x2="15.8" y2="16.8" />
    </>
  ),
  swipe: (
    <>
      <path d="M3 12h16" />
      <polyline points="15 8 19 12 15 16" />
      <circle cx="7" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 0-4H12a1.5 1.5 0 0 1 0-3h6.5A2.5 2.5 0 0 0 21 11.5 9 9 0 0 0 12 3z" />
      <circle cx="7.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  layers: (
    <>
      <polygon points="12 3 21 8 12 13 3 8" />
      <polyline points="3 13 12 18 21 13" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <polyline points="7 11 12 16 17 11" />
      <path d="M4 19h16" />
    </>
  ),
  school: (
    <>
      <path d="M3 9l9-5 9 5-9 5-9-5z" />
      <path d="M7 11.5V16c0 1.5 2.2 3 5 3s5-1.5 5-3v-4.5" />
    </>
  ),
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  "wifi-off": (
    <>
      <line x1="3" y1="3" x2="21" y2="21" />
      <path d="M9 9a5 5 0 0 0-2 4" opacity="0.7" />
      <path d="M5 10a9 9 0 0 0-1.5 4" opacity="0.5" />
      <circle cx="12" cy="16" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 4l1.8 4.5L18 10l-4.2 1.5L12 16l-1.8-4.5L6 10l4.2-1.5L12 4z" />
      <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M18.7 5.3l-1.5 1.5M6.8 17.2l-1.5 1.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <line x1="16" y1="16" x2="21" y2="21" />
    </>
  ),
  "chevron-right": <polyline points="9 5 16 12 9 19" />,
  phone: (
    <path d="M6.5 3.5a2 2 0 0 1 2.9-.4c.8.7 1.6 2.7 1.3 3.6-.2.7-1.1 1-1.5 1.6-.3.5.3 1.8 1.2 2.8 1 1 2.3 1.6 2.8 1.3.6-.3.9-1.2 1.6-1.5.9-.3 2.9.5 3.6 1.3a2 2 0 0 1-.4 2.9c-1.7 1.4-4.5.8-7.1-1.4-2.6-2.2-4.4-4.9-4.4-7.1 0-.9.4-2.5 1-3.1z" />
  ),
  message: (
    <>
      <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
      <line x1="7" y1="9.5" x2="17" y2="9.5" />
      <line x1="7" y1="13" x2="13" y2="13" />
    </>
  ),
  camera: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2.5" />
      <circle cx="12" cy="13.5" r="3.8" />
      <path d="M8.5 7l1.2-2h4.6L15.5 7" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polygon points="15.5 8.5 13.8 13.8 8.5 15.5 10.2 10.2" />
    </>
  ),
  tune: (
    <>
      <line x1="4" y1="7" x2="20" y2="7" />
      <circle cx="9" cy="7" r="2.2" fill="currentColor" stroke="none" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="15" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <line x1="4" y1="17" x2="20" y2="17" />
      <circle cx="7" cy="17" r="2.2" fill="currentColor" stroke="none" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </>
  ),
};

export const Icon: React.FC<{
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
}> = ({ name, size = 24, color = "currentColor", strokeWidth = 2, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
  >
    {paths[name]}
  </svg>
);
