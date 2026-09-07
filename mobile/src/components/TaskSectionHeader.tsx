// 任务列表的分节头与「显示另外 N 条」。抽出来有两个原因：一是 index.tsx 里那串分节
// 三元表达式已经长到读不动，二是年龄闸的展开/收起在每一种分节上都长一个样，共用一个
// 组件才不会改好一处漏一处。
import type { ComponentProps } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { fonts, radius, useTheme } from "@/lib/theme";

/**
 * 一行分节头：图标 + 标题 + 计数 + 右侧插槽。标题一律小号等宽大写字母，和列表原本的
 * 状态分区头保持同一副长相。
 */
export function SectionHeader({
  icon,
  iconColor,
  label,
  labelColor,
  count,
  dotColor,
  right,
  onPress,
}: {
  icon?: ComponentProps<typeof Ionicons>["name"];
  iconColor?: string;
  label: string;
  labelColor?: string;
  count?: number;
  /** 状态分区那种纯色小圆点（与 icon 二选一）。 */
  dotColor?: string;
  right?: React.ReactNode;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const body = (pressed: boolean) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 18,
        paddingBottom: 8,
        backgroundColor: pressed ? theme.raised : theme.bg,
      }}
    >
      {dotColor ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dotColor }} /> : null}
      {icon ? <Ionicons name={icon} size={13} color={iconColor ?? theme.faint} /> : null}
      <Text
        style={{ color: labelColor ?? theme.muted, fontSize: 11, fontFamily: fonts.monoMed, letterSpacing: 1, flexShrink: 1 }}
        numberOfLines={1}
      >
        {label}
      </Text>
      {count === undefined ? null : (
        <Text style={{ color: theme.faint, fontSize: 11, fontFamily: fonts.mono }}>· {count}</Text>
      )}
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {({ pressed }) => body(pressed)}
    </Pressable>
  ) : body(false);
}

/**
 * 年龄闸的尾行。24 小时没动静的任务被收在这后面 —— 数字要说清「藏了几条」，否则用户
 * 只会觉得任务丢了。
 */
export function PreviewMoreRow({
  hiddenCount,
  expanded,
  onToggle,
}: {
  hiddenCount: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const theme = useTheme();
  if (hiddenCount <= 0) return null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onToggle}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        marginHorizontal: 16,
        marginTop: 8,
        paddingVertical: 10,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: theme.line,
        backgroundColor: pressed ? theme.raised : "transparent",
      })}
    >
      <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={13} color={theme.faint} />
      <Text style={{ color: theme.muted, fontSize: 12, fontFamily: fonts.body }}>
        {expanded ? "收起超过一天没动的" : `显示另外 ${hiddenCount} 条（超过一天没动）`}
      </Text>
    </Pressable>
  );
}
