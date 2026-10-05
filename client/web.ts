import { Linking, Platform } from "react-native";

// The plugin typechecks without the DOM library; declare only what this module uses.
declare const window: { open(url: string, target: string, features: string): unknown };

/** Opens a URL in the system browser (new tab on web). */
export async function openExternal(url: string): Promise<void> {
  if (Platform.OS === "web") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await Linking.openURL(url);
}
