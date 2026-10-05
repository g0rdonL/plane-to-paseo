import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { IssueBrowser } from "./issues/browser";

export function createPlaneSurface(openSettings: () => void) {
  return function PlaneSurface({ theme, layout, navigation }: PluginSurfaceProps) {
    return (
      <IssueBrowser
        theme={theme}
        layout={layout}
        navigation={navigation}
        openSettings={openSettings}
      />
    );
  };
}
