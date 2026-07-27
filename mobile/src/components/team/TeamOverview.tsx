import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  statusCounts,
  workerHaltStats,
  type Group,
  type Task,
  type TaskStatus,
} from "@harness/shared";
import type { TeamCuaStatus } from "@/lib/api";
import { STATUS_META } from "@/lib/constants";
import { TaskTimeChip } from "@/lib/time";
import { fonts, radius, useTheme } from "@/lib/theme";
import { StatusDot } from "@/components/ui";

export function TeamOverview({
  task,
  workers,
  pausedGroups,
  settled,
  stopped,
  action,
  cuaStatus,
  cuaChecking,
  onRun,
  onHalt,
  onResume,
  onKillCua,
}: {
  task: Task;
  workers: Task[];
  pausedGroups: Group[];
  settled: boolean;
  stopped: boolean;
  action: "run" | "halt" | "resume" | null;
  cuaStatus: TeamCuaStatus | null;
  cuaChecking: boolean;
  onRun: () => void;
  onHalt: () => void;
  onResume: () => void;
  onKillCua: () => void;
}) {
  const theme = useTheme();
  const hasPausedGroups = pausedGroups.length > 0;
  const counts = statusCounts(workers);
  const value = (status: TaskStatus, awaitingAnswer = false) =>
    counts.find((bucket) => bucket.status === status && !!bucket.awaitingAnswer === awaitingAnswer)?.n ?? 0;
  const summary = [
    { label: "运行", n: value("running"), color: STATUS_META.running.color },
    { label: "排队", n: value("queued"), color: STATUS_META.queued.color },
    { label: "完成", n: value("done"), color: STATUS_META.done.color },
    { label: "失败", n: value("failed"), color: STATUS_META.failed.color },
    { label: "提问", n: value("paused", true), color: "#22D3EE" },
  ];

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <View
          style={{
            marginTop: 2,
            borderRadius: radius.sm,
            backgroundColor: `${theme.accent}1A`,
            paddingHorizontal: 7,
            paddingVertical: 4,
          }}
        >
          <Text style={{ color: theme.accent, fontSize: 10, fontFamily: fonts.bodySemi }}>团队</Text>
        </View>
        <View style={{ flex: 1, gap: 7 }}>
          <Text style={{ color: theme.ink, fontSize: 21, lineHeight: 27, fontFamily: fonts.display }} numberOfLines={2}>
            {task.title || "(无标题)"}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 9 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <StatusDot status={task.status} size={9} />
              <Text style={{ color: STATUS_META[task.status]?.color ?? theme.muted, fontSize: 11, fontFamily: fonts.monoMed }}>
                {leadStatusLabel(task)}
              </Text>
            </View>
            <Text style={{ color: theme.muted, fontSize: 11, fontFamily: fonts.mono }}>
              调度者 {task.team?.leadExecutorLabel || task.executorLabel || task.team?.lead || task.agentType || "—"}
            </Text>
            <TaskTimeChip task={task} />
          </View>
        </View>
      </View>

      <View
        style={{
          flexDirection: "row",
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: theme.line,
          backgroundColor: theme.panel,
          paddingVertical: 9,
        }}
      >
        {summary.map((item, index) => (
          <View
            key={item.label}
            style={{
              flex: 1,
              alignItems: "center",
              gap: 3,
              borderLeftWidth: index === 0 ? 0 : 1,
              borderLeftColor: theme.line,
            }}
          >
            <Text style={{ color: item.color, fontSize: 15, fontFamily: fonts.monoMed }}>{item.n}</Text>
            <Text style={{ color: theme.faint, fontSize: 9, fontFamily: fonts.body }}>{item.label}</Text>
          </View>
        ))}
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginRight: "auto" }}>
          <Ionicons
            name={settled ? "checkmark-circle-outline" : stopped ? "pause-circle-outline" : "pulse-outline"}
            size={16}
            color={settled ? theme.ok : stopped ? theme.muted : theme.accent}
          />
          <Text style={{ color: settled ? theme.ok : theme.muted, fontSize: 12, fontFamily: fonts.bodyMed }}>
            {settled ? "已收工" : stopped ? "全组已停止" : "团队进行中"}
          </Text>
        </View>

        {!task.archived && hasPausedGroups ? (
          <ActionButton label={action === "resume" ? "恢复中…" : "恢复全组"} icon="play" disabled={!!action} onPress={onResume} />
        ) : null}
        {!task.archived && !stopped && !settled ? (
          <ActionButton label={action === "halt" ? "停止中…" : "停止全组"} icon="stop" danger disabled={!!action} onPress={onHalt} />
        ) : null}
        {!task.archived && !task.question && !hasPausedGroups && task.status !== "running" ? (
          <ActionButton label={action === "run" ? "接回中…" : task.status === "idle" ? "接回调度者" : "运行"} icon="play" disabled={!!action} onPress={onRun} />
        ) : null}
      </View>

      {stopped ? <HaltNotice workers={workers} pausedGroups={pausedGroups} /> : null}
      {cuaChecking ? (
        <Text style={{ color: theme.faint, fontSize: 11, fontFamily: fonts.body }}>正在检查 computer-use 残留…</Text>
      ) : null}
      {cuaStatus?.current.detected ? (
        <CuaNotice status={cuaStatus} onKill={onKillCua} />
      ) : null}
    </View>
  );
}

function ActionButton({
  label,
  icon,
  danger,
  disabled,
  onPress,
}: {
  label: string;
  icon: "play" | "stop";
  danger?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const color = danger ? theme.danger : theme.accent;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        minHeight: 38,
        paddingHorizontal: 11,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: color,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Ionicons name={icon} size={13} color={color} />
      <Text style={{ color, fontSize: 12, fontFamily: fonts.bodySemi }}>{label}</Text>
    </Pressable>
  );
}

function HaltNotice({ workers, pausedGroups }: { workers: Task[]; pausedGroups: Group[] }) {
  const theme = useTheme();
  const stats = workerHaltStats(workers);
  const workerText =
    stats.interrupted > 0
      ? `${stats.interrupted} 个执行者被暂停打断`
      : stats.completed > 0
        ? `${stats.completed} 个执行者已完成，没有被打断`
        : workers.length > 0
          ? "没有执行者被暂停打断"
          : "还没有执行者";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: theme.line,
        backgroundColor: theme.raised,
        padding: 10,
      }}
    >
      <Ionicons name="pause-circle" size={16} color={theme.muted} />
      <Text style={{ flex: 1, color: theme.muted, fontSize: 12, lineHeight: 18, fontFamily: fonts.body }}>
        {pausedGroups.length > 0
          ? `${pausedGroups.length} 个内部组已停止 · ${workerText}`
          : `会话记录显示已停止；当前没有 paused 内部组可恢复 · ${workerText}`}
      </Text>
    </View>
  );
}

function CuaNotice({ status, onKill }: { status: TeamCuaStatus; onKill: () => void }) {
  const theme = useTheme();
  const current = status.current;
  return (
    <View
      style={{
        gap: 8,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: "#F59E0B66",
        backgroundColor: "#F59E0B12",
        padding: 11,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <Ionicons name="warning" size={17} color="#F59E0B" />
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: theme.ink, fontSize: 12, fontFamily: fonts.bodySemi }}>
            检测到 computer-use 服务仍在运行
          </Text>
          <Text style={{ color: theme.muted, fontSize: 11, lineHeight: 17, fontFamily: fonts.body }}>
            {current.sideEffect}
          </Text>
          {current.processes.length > 0 ? (
            <Text style={{ color: theme.faint, fontSize: 10, fontFamily: fonts.mono }}>
              pid {current.processes.map((process) => process.pid).join(", ")}
            </Text>
          ) : null}
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={onKill}
        style={{
          alignSelf: "flex-end",
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          minHeight: 36,
          paddingHorizontal: 11,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: "#F59E0B88",
        }}
      >
        <Ionicons name="trash-bin-outline" size={13} color="#F59E0B" />
        <Text style={{ color: "#F59E0B", fontSize: 12, fontFamily: fonts.bodySemi }}>强制清理</Text>
      </Pressable>
    </View>
  );
}

function leadStatusLabel(task: Task): string {
  if (task.question) return "等待答复";
  if (task.status === "running") return "调度中";
  if (task.status === "idle") return "待命";
  return STATUS_META[task.status]?.label ?? task.status;
}
