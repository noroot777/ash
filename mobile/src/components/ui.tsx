import { View, Text, Pressable, type ViewStyle, type StyleProp } from "react-native";
import type { TaskStatus, Priority } from "@harness/shared";
import { STATUS_META, PRIORITY_META } from "@/lib/constants";
import { useTheme, radius } from "@/lib/theme";

// Solid colored dot for a task status.
export function StatusDot({ status, size = 9 }: { status: TaskStatus; size?: number }) {
  const theme = useTheme();
  const c = STATUS_META[status]?.color ?? theme.faint;
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c }} />;
}

// Connection indicator (green when SSE is live).
export function ConnDot({ connected, size = 8 }: { connected: boolean; size?: number }) {
  const theme = useTheme();
  return (
    <View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: connected ? theme.ok : theme.faint }}
    />
  );
}

// The little 1–4 bar priority glyph (matches the web's bar count).
export function PriorityBars({ priority }: { priority: Priority }) {
  const theme = useTheme();
  const meta = PRIORITY_META[priority];
  if (!meta || meta.bars === 0) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 1.5, height: 11 }}>
      {[1, 2, 3, 4].map((n) => (
        <View
          key={n}
          style={{
            width: 2.5,
            height: 3 + n * 2,
            borderRadius: 1,
            backgroundColor: n <= meta.bars ? meta.color : theme.line2,
          }}
        />
      ))}
    </View>
  );
}

// Rounded chip used for status / labels / pickers.
export function Pill({
  label,
  color,
  active,
  onPress,
  style,
}: {
  label: string;
  color?: string;
  active?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const body = (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 11,
          paddingVertical: 6,
          borderRadius: radius.pill,
          backgroundColor: active ? theme.accent : theme.overlay,
          borderWidth: 1,
          borderColor: active ? theme.accent : theme.line,
        },
        style,
      ]}
    >
      {color ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} /> : null}
      <Text style={{ color: active ? theme.accentFg : theme.ink, fontSize: 13, fontWeight: "500" }}>{label}</Text>
    </View>
  );
  return onPress ? <Pressable onPress={onPress}>{body}</Pressable> : body;
}

// Primary / secondary / danger button.
export function Button({
  label,
  onPress,
  variant = "primary",
  disabled,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const bg =
    variant === "primary" ? theme.accent : variant === "danger" ? "transparent" : theme.raised;
  const fg = variant === "primary" ? theme.accentFg : variant === "danger" ? theme.danger : theme.ink;
  const border = variant === "danger" ? theme.danger : variant === "secondary" ? theme.line : "transparent";
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={[
        {
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderRadius: radius.md,
          backgroundColor: bg,
          borderWidth: 1,
          borderColor: border,
          opacity: disabled ? 0.4 : 1,
          alignItems: "center",
          justifyContent: "center",
        },
        style,
      ]}
    >
      <Text style={{ color: fg, fontSize: 14, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}
