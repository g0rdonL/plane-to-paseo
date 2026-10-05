import { defineAttachmentSource } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createPlanePanel } from "./client/panel";
import { PlaneSettings } from "./client/settings/plane-settings";
import { createPlaneSurface } from "./client/surface";
import { attachmentsSearch } from "./shared/contracts";

const SURFACE_ID = "issues";
const PANEL_ID = "issues";
const SETTINGS_ID = "plane";

export default function contribute(client: PluginClientContext) {
  const openSettings = () => client.openSettings(SETTINGS_ID);

  client.addSurface(SURFACE_ID, createPlaneSurface(openSettings));
  client.addSidebarItem({
    id: "plane",
    title: "Plane",
    icon: "CircleDot",
    surface: SURFACE_ID,
  });

  client.addWorkspacePanel({
    id: PANEL_ID,
    title: "Plane",
    icon: "CircleDot",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: createPlanePanel(openSettings),
  });

  client.addSettingsScreen({
    id: SETTINGS_ID,
    title: "Plane",
    icon: "KeyRound",
    Component: PlaneSettings,
  });

  client.addCommandCenterItem({
    id: "open-plane-work-items",
    title: "Open Plane work items",
    icon: "CircleDot",
    keywords: ["plane", "work items", "issues", "tickets", "todo"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface(SURFACE_ID);
    },
  });

  client.addCommandCenterItem({
    id: "start-plane-work-item-here",
    title: "Start a Plane work item in this workspace",
    icon: "CircleDot",
    keywords: ["plane", "work item", "issue", "ticket", "start"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel(PANEL_ID);
    },
  });

  client.addCommandCenterItem({
    id: "open-plane-right",
    title: "Open Plane in right panel",
    icon: "CircleDot",
    keywords: ["plane", "work item", "explorer", "side"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel(PANEL_ID, { location: "explorer" });
    },
  });

  client.addCommandCenterItem({
    id: "plane-settings",
    title: "Configure Plane",
    icon: "KeyRound",
    keywords: ["plane", "api key", "token", "settings"],
    context: "global",
    onSelect({ openSettings: open }) {
      open(SETTINGS_ID);
    },
  });

  client.addAttachmentSource(
    defineAttachmentSource({
      id: "plane-work-item",
      title: "Plane work item",
      icon: "CircleDot",
      pickerTitle: "Attach a Plane work item",
      searchPlaceholder: "Search by identifier or title",
      search: attachmentsSearch,
    }),
  );

  return () => {};
}
