import { View, Text, TextInput, Pressable, type ViewStyle, type StyleProp, type TextInputProps } from "react-native";
import type { TaskStatus, Priority } from "@harness/shared";
import { STATUS_META, PRIORITY_META } from "@/lib/constants";
import { useTheme, radius, fonts } from "@/lib/theme";

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

// Rounded chip used for labels / pickers. Filled style: active = accent fill,
// inactive = subtle raised fill (no border) — matches the design system.
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
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderRadius: radius.pill,
          backgroundColor: active ? theme.accent : theme.raised,
        },
        style,
      ]}
    >
      {color ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} /> : null}
      <Text style={{ color: active ? theme.accentFg : theme.muted, fontSize: 14, fontFamily: active ? fonts.bodySemi : fonts.bodyMed }}>
        {label}
      </Text>
    </View>
  );
  return onPress ? <Pressable onPress={onPress}>{body}</Pressable> : body;
}

// Unified text input — filled, borderless, generous padding. Used across new /
// project-new / settings so every form looks the same.
export function Input(props: TextInputProps) {
  const theme = useTheme();
  return (
    <TextInput
      placeholderTextColor={theme.faint}
      {...props}
      style={[
        {
          color: theme.ink,
          backgroundColor: theme.raised,
          borderRadius: radius.lg,
          paddingHorizontal: 14,
          paddingVertical: 12,
          fontSize: 16,
          fontFamily: fonts.body,
        },
        props.style,
      ]}
    />
  );
}

// Primary / secondary / danger button. Solid, thick, rounded — design-system feel.
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
  const border = variant === "danger" ? theme.danger : "transparent";
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={[
        {
          paddingHorizontal: 18,
          paddingVertical: 13,
          borderRadius: radius.lg,
          backgroundColor: bg,
          borderWidth: variant === "danger" ? 1 : 0,
          borderColor: border,
          opacity: disabled ? 0.4 : 1,
          alignItems: "center",
          justifyContent: "center",
        },
        style,
      ]}
    >
      <Text style={{ color: fg, fontSize: 15, fontFamily: fonts.bodySemi }}>{label}</Text>
    </Pressable>
  );
}
