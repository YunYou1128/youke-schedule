import React from "react";
import { Composition } from "remotion";
import { YoukeIntroComposition } from "./compositions/youke-intro/VideoComposition";
import { FPS, TOTAL_FRAMES, VIDEO_W, VIDEO_H } from "./compositions/youke-intro/constants";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="youke-intro"
      component={YoukeIntroComposition}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={VIDEO_W}
      height={VIDEO_H}
      defaultProps={{}}
    />
  );
};
