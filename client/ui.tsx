import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import type { Issue } from "../shared/contracts";
import { assigneeNames } from "../shared/prompt";

/** Small, theme-aware building blocks shared by every screen of the plugin. */

export const PRIORITY_COLORS = (theme: PluginTheme): Record<number, string> => ({
  0: theme.colors.foregroundMuted,
  1: theme.colors.statusDanger,
  2: theme.colors.statusWarning,
  3: theme.colors.accent,
  4: theme.colors.foregroundMuted,
});

export const PRIORITY_SHORT: Record<number, string> = {
  0: "—",
  1: "!!!",
  2: "!!",
  3: "!",
  4: "·",
};

export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function displayName(
  user: { name: string; displayName?: string | null } | null | undefined,
): string {
  if (!user) return "Unassigned";
  return user.displayName?.trim() || user.name;
}

/** All assignees comma-joined, or "Unassigned". */
/** "2 pt" for point estimates, the raw value ("XS") otherwise. */
export function estimateLabel(estimate: string): string {
  return /^\d+(\.\d+)?$/.test(estimate) ? `${estimate} pt` : estimate;
}

export function assigneesLabel(issue: Issue): string {
  return assigneeNames(issue) || "Unassigned";
}

interface ChipProps {
  theme: PluginTheme;
  label: string;
  selected?: boolean;
  icon?: string;
  trailingIcon?: string;
  color?: string;
  onPress?: () => void;
  disabled?: boolean;
  compact?: boolean;
  accessibilityLabel?: string;
}

export function Chip({
  theme,
  label,
  selected = false,
  icon,
  trailingIcon,
  color,
  onPress,
  disabled,
  compact,
  accessibilityLabel,
}: ChipProps) {
  const foreground = selected ? theme.colors.accentForeground : (color ?? theme.colors.foreground);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected, disabled }}
      onPress={onPress}
      disabled={disabled || !onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingVertical: compact ? 4 : 6,
        paddingHorizontal: compact ? 8 : 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.accent : theme.colors.surface1,
        opacity: pressed ? 0.7 : disabled ? 0.5 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={13} color={foreground} /> : null}
      <Text
        style={{
          color: foreground,
          fontSize: compact ? 12 : 13,
          fontWeight: selected ? "600" : "500",
        }}
      >
        {label}
      </Text>
      {trailingIcon ? <Icon name={trailingIcon} size={13} color={foreground} /> : null}
    </Pressable>
  );
}

interface ButtonProps {
  theme: PluginTheme;
  label: string;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "danger";
  icon?: string;
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  theme,
  label,
  onPress,
  variant = "primary",
  icon,
  busy,
  disabled,
  style,
}: ButtonProps) {
  const background =
    variant === "primary"
      ? theme.colors.accent
      : variant === "danger"
        ? theme.colors.statusDanger
        : theme.colors.surface1;
  const foreground =
    variant === "secondary" ? theme.colors.foreground : theme.colors.accentForeground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          paddingVertical: 10,
          paddingHorizontal: 14,
          borderRadius: 8,
          borderWidth: variant === "secondary" ? 1 : 0,
          borderColor: theme.colors.border,
          backgroundColor: background,
          opacity: pressed ? 0.75 : disabled || busy ? 0.5 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : icon ? (
        <Icon name={icon} size={15} color={foreground} />
      ) : null}
      <Text style={{ color: foreground, fontSize: 14, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({
  theme,
  icon,
  onPress,
  accessibilityLabel,
  busy,
  disabled,
  color,
}: {
  theme: PluginTheme;
  icon: string;
  onPress?: () => void;
  accessibilityLabel: string;
  busy?: boolean;
  disabled?: boolean;
  color?: string;
}) {
  const tint = color ?? theme.colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      disabled={disabled || busy}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 32,
        height: 32,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? theme.colors.surface2 : "transparent",
        opacity: disabled ? 0.4 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={tint} />
      ) : (
        <Icon name={icon} size={17} color={tint} />
      )}
    </Pressable>
  );
}

export function SectionTitle({
  theme,
  children,
  trailing,
}: {
  theme: PluginTheme;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: 12,
        marginBottom: 6,
      }}
    >
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          fontWeight: "700",
          textTransform: "uppercase",
          letterSpacing: 0.6,
        }}
      >
        {children}
      </Text>
      {trailing}
    </View>
  );
}

export function Muted({
  theme,
  children,
  style,
}: {
  theme: PluginTheme;
  children: ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text style={[{ color: theme.colors.foregroundMuted, fontSize: 12 }, style]}>{children}</Text>
  );
}

export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
  );
}

export function StateDot({
  theme,
  state,
}: {
  theme: PluginTheme;
  state: { type: string; color?: string | null };
}) {
  const fallback: Record<string, string> = {
    triage: theme.colors.statusWarning,
    backlog: theme.colors.foregroundMuted,
    unstarted: theme.colors.foregroundMuted,
    started: theme.colors.statusWarning,
    completed: theme.colors.statusSuccess,
    cancelled: theme.colors.foregroundMuted,
  };
  return <Dot color={state.color ?? fallback[state.type] ?? theme.colors.foregroundMuted} />;
}

export function PriorityMark({ theme, priority }: { theme: PluginTheme; priority: number }) {
  const color = PRIORITY_COLORS(theme)[priority] ?? theme.colors.foregroundMuted;
  return (
    <Text style={{ color, fontSize: 11, fontWeight: "800", minWidth: 20, textAlign: "center" }}>
      {PRIORITY_SHORT[priority] ?? "—"}
    </Text>
  );
}

export function Centered({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        gap: 12,
        backgroundColor: theme.colors.surface0,
      }}
    >
      {children}
    </View>
  );
}

export function Spinner({ theme }: { theme: PluginTheme }) {
  return <ActivityIndicator color={theme.colors.accent} />;
}

export function ErrorText({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return (
    <Text style={{ color: theme.colors.statusDanger, fontSize: 13, textAlign: "center" }}>
      {children}
    </Text>
  );
}

export function KeyValue({
  theme,
  label,
  value,
}: {
  theme: PluginTheme;
  label: string;
  value: ReactNode;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 8, paddingVertical: 3 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, width: 84 }}>{label}</Text>
      {typeof value === "string" ? (
        <Text selectable style={{ color: theme.colors.foreground, fontSize: 13, flex: 1 }}>
          {value}
        </Text>
      ) : (
        <View style={{ flex: 1 }}>{value}</View>
      )}
    </View>
  );
}

export function Toggle({
  theme,
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  theme: PluginTheme;
  label: string;
  hint?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      onPress={() => onChange(!value)}
      disabled={disabled}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 8,
        opacity: pressed ? 0.7 : disabled ? 0.5 : 1,
      })}
    >
      <Icon
        name={value ? "SquareCheck" : "Square"}
        size={20}
        color={value ? theme.colors.accent : theme.colors.foregroundMuted}
      />
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{label}</Text>
        {hint ? <Muted theme={theme}>{hint}</Muted> : null}
      </View>
    </Pressable>
  );
}
