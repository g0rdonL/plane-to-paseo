import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { IssueBrowser } from "./issues/browser";

export function createPlanePanel(openSettings: () => void) {
  return function PlanePanel({
    theme,
    layout,
    navigation,
    workspaceId,
  }: PluginWorkspacePanelProps) {
    return (
      <IssueBrowser
        theme={theme}
        layout={layout}
        navigation={navigation}
        fixedWorkspaceId={workspaceId}
        openSettings={openSettings}
      />
    );
  };
}
