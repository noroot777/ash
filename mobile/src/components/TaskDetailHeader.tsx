// 单飞/团队执行者任务详情的**固定头**：状态与验收阶段、标题、主操作、元信息。
// 会话正文在下面滚动，这一块钉在顶上不动 —— 用户往回翻历史时也一直看得见「这个任务
// 现在是什么状态、要不要我做点什么」。从 app/task/[id].tsx 里拆出来（那个文件已经接近
// 单文件行数上限，且这块与会话/输入框没有耦合，只吃 props）。
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { TaskListItem } from "@ash/shared";
import { STATUS_META } from "@/lib/constants";
import { canStopTask, type RunAction } from "@/lib/taskActions";
import { TaskTimeChip } from "@/lib/time";
import { fonts, radius, useTheme } from "@/lib/theme";
import { SignalBar } from "@/components/SignalBar";
import { TaskStatusChips } from "@/components/TaskStatusChips";
import { WorkerTeamLink } from "@/components/WorkerTeamLink";

export function TaskDetailHeader({
  task,
  action,
  parentTeamTitle,
  onPrimary,
  onStop,
  onOpenTeam,
}: {
  task: TaskListItem;
  action: RunAction;
  /** 非空 = 这是某个团队派出的执行者，头里给一条回调度台的链接。 */
  parentTeamTitle: string | null;
  onPrimary: () => void;
  onStop: () => void;
  onOpenTeam: () => void;
}) {
  const theme = useTheme();
  const status = task.status;
  const meta = STATUS_META[status];
  const frozen = !!task.archived;

  return (
    <View
      style={{
        flexDirection: "row",
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 14,
        borderBottomWidth: 1,
        borderBottomColor: theme.line,
        gap: 13,
      }}
    >
      <SignalBar status={status} height={52} />
      <View style={{ flex: 1, gap: 10 }}>
        {/* 状态行：底层调度状态(mono) + 运行/停止 */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: meta?.color, fontSize: 11, fontFamily: fonts.monoMed, letterSpacing: 1 }}>
            {status.toUpperCase().replace(/_/g, " ")}
          </Text>
          <View style={{ flex: 1 }} />
          {frozen ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Ionicons name="archive" size={13} color={theme.faint} />
              <Text style={{ color: theme.faint, fontSize: 12, fontFamily: fonts.mono }}>已归档</Text>
            </View>
          ) : canStopTask(status) ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="停止这个任务"
              onPress={onStop}
              style={{
                minWidth: 72,
                minHeight: 40,
                alignItems: "center",
                justifyContent: "center",
                paddingHorizontal: 14,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: theme.danger,
              }}
            >
              <Text style={{ color: theme.danger, fontSize: 13, fontFamily: fonts.bodySemi }}>停止</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={action.label}
              accessibilityState={{ disabled: !action.canClick }}
              onPress={action.canClick ? onPrimary : undefined}
              style={{
                minWidth: 72,
                minHeight: 40,
                alignItems: "center",
                justifyContent: "center",
                paddingHorizontal: 14,
                borderRadius: radius.md,
                backgroundColor: action.canClick ? theme.accent : theme.raised,
                opacity: action.canClick ? 1 : 0.6,
              }}
            >
              <Text style={{ color: action.canClick ? theme.accentFg : theme.muted, fontSize: 13, fontFamily: fonts.bodySemi }}>
                {action.label}
              </Text>
            </Pressable>
          )}
        </View>

        <Text style={{ color: theme.ink, fontSize: 21, fontFamily: fonts.display, lineHeight: 27 }} numberOfLines={2}>
          {task.title || "(无标题)"}
        </Text>

        {/* 验收阶段（已实现/验证中/未通过验证/待验收…）与「在等你答复」。上面那行
            status 只管调度、这里只管这一版走到哪了，两者正交。没有 stage 也没在等人
            时那行只会把 status 用中文再说一遍，就不占这一格了。 */}
        {task.stage || task.question ? (
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            <TaskStatusChips task={task} />
          </View>
        ) : null}

        {parentTeamTitle !== null ? (
          <WorkerTeamLink title={parentTeamTitle || "返回团队调度台"} onPress={onOpenTeam} />
        ) : null}

        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          {task.agentType ? (
            <Text style={{ color: theme.muted, fontSize: 12, fontFamily: fonts.mono }}>@{task.agentType}</Text>
          ) : null}
          {task.labels.map((label) => (
            <Text key={label} style={{ color: theme.faint, fontSize: 12, fontFamily: fonts.mono }}>
              #{label}
            </Text>
          ))}
          <TaskTimeChip task={task} />
        </View>
      </View>
    </View>
  );
}
