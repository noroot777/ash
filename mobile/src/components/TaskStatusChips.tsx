// 任务状态的展示层：状态/阶段牌 + 「这个任务在等你」的醒目标记。列表行和任务详情
// 共用同一副形状，文案一律走 shared 的 taskDisplayStatus / STAGE_LABELS —— status 与
// stage 怎么合成一句话是 shared 说了算，这里只决定怎么把它画出来。
import type { ComponentProps } from "react";
import { View, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { STAGE_LABELS, taskDisplayStatus, type TaskListItem } from "@ash/shared";
import { fonts, radius, useTheme, type Theme } from "@/lib/theme";

// 「停下来等你」那一档的信号色。与团队执行者行(TeamWorkerBatchCard)同一个青，刻意
// 不用 accent —— accent 是「正在跑」，这一档说的正相反：它不动了，在等人。
export const ATTENTION_COLOR = "#22D3EE";

export type AttentionKind = "question" | "verify_failed";
export type TaskAttention = {
  kind: AttentionKind;
  icon: ComponentProps<typeof Ionicons>["name"];
};

/**
 * 「这个任务在等我指挥吗」——用户打开 app 第一眼要认出来的两档：
 *   1. 有待答问题（agent 调了 ask_question，停在那儿谁也推不动）；
 *   2. 验证没通过（要么改，要么再派一轮审查）。
 * 归档任务不再等任何人，一律不标。
 */
export function taskAttention(task: TaskListItem): TaskAttention | null {
  if (task.archived) return null;
  if (task.question) return { kind: "question", icon: "help-circle" };
  if (task.stage === "verify_failed") return { kind: "verify_failed", icon: "alert-circle" };
  return null;
}

/** 一批任务里各有几个在等人 —— 团队卡片要在折叠状态下替执行者喊话。 */
export function attentionCounts(tasks: TaskListItem[]): { questions: number; verifyFailed: number } {
  const live = tasks.filter((task) => !task.archived);
  return {
    questions: live.filter((task) => !!task.question).length,
    verifyFailed: live.filter((task) => task.stage === "verify_failed").length,
  };
}

export function attentionColor(kind: AttentionKind | null | undefined, theme: Theme): string | null {
  if (kind === "question") return ATTENTION_COLOR;
  if (kind === "verify_failed") return theme.danger;
  return null;
}

/**
 * 等人的卡片整张换个颜色：描边 + 一层极淡的底色。只靠一个小牌子在一屏十几行里是看
 * 不见的，边框才是「一眼扫过去哪几行在等我」的那条线索。
 */
export function attentionSurface(
  kind: AttentionKind | null | undefined,
  theme: Theme,
): { borderColor: string; tint: string | null } {
  const color = attentionColor(kind, theme);
  return color ? { borderColor: `${color}99`, tint: `${color}0D` } : { borderColor: theme.line, tint: null };
}

export function StatusChip({
  label,
  color,
  icon,
  filled = false,
}: {
  label: string;
  /** 省略 = 中性牌（用 muted）。 */
  color?: string | null;
  icon?: ComponentProps<typeof Ionicons>["name"];
  /** 等人那一档铺底色，普通状态只用 raised，免得一行全是彩色牌。 */
  filled?: boolean;
}) {
  const theme = useTheme();
  const tone = color ?? theme.muted;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: radius.sm,
        backgroundColor: filled ? `${tone}1F` : theme.raised,
      }}
    >
      {icon ? <Ionicons name={icon} size={11} color={tone} /> : null}
      <Text style={{ color: tone, fontSize: 10, fontFamily: fonts.monoMed }}>{label}</Text>
    </View>
  );
}

/**
 * 一个任务的状态牌组：主牌是 shared 合成的展示状态（含 stage），等人时换成信号色并
 * 带上图标。「等答复」会盖住 stage —— 同时还没过验证的，补一张副牌说清楚，否则用户
 * 答完问题就以为万事大吉了。
 *
 * 返回的是**裸片段**，容器由调用点给：牌子常和别的牌排在同一行里换行，套一层自己的
 * View 会让它整组变成一个不可拆的 flex item。
 */
export function TaskStatusChips({ task }: { task: TaskListItem }) {
  const theme = useTheme();
  const display = taskDisplayStatus(task.status, task.stage, !!task.question);
  const attention = taskAttention(task);
  const color = attentionColor(attention?.kind, theme);
  return (
    <>
      <StatusChip label={display.label} color={color} icon={attention?.icon} filled={!!attention} />
      {attention?.kind === "question" && task.stage === "verify_failed" ? (
        <StatusChip label={STAGE_LABELS.verify_failed} color={theme.danger} icon="alert-circle" filled />
      ) : null}
    </>
  );
}
