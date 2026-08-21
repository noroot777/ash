import { View, Text, Pressable } from "react-native";
import type { Task } from "@ash/shared";
import { statusCounts } from "@ash/shared/team";
import { Ionicons } from "@expo/vector-icons";
import { SignalBar } from "@/components/SignalBar";
import { TaskTimeChip } from "@/lib/time";
import { useTheme, radius, fonts } from "@/lib/theme";

const DUET_COLOR = "#8B5CF6";

export function TaskListRow({
  task,
  workers,
  expanded,
  onToggle,
  onPress,
  onWorkerPress,
}: {
  task: Task;
  workers: Task[];
  expanded: boolean;
  onToggle: () => void;
  onPress: () => void;
  onWorkerPress: (worker: Task) => void;
}) {
  if (task.mode !== "team") return <TaskCard task={task} onPress={onPress} />;
  return (
    <View style={{ gap: 7 }}>
      <TeamCard task={task} workers={workers} expanded={expanded} onToggle={onToggle} onPress={onPress} />
      {expanded
        ? workers.map((worker) => (
            <TaskCard
              key={worker.id}
              task={worker}
              parentTitle={task.title || "团队调度台"}
              onPress={() => onWorkerPress(worker)}
            />
          ))
        : null}
    </View>
  );
}

function TeamCard({
  task,
  workers,
  expanded,
  onToggle,
  onPress,
}: {
  task: Task;
  workers: Task[];
  expanded: boolean;
  onToggle: () => void;
  onPress: () => void;
}) {
  const theme = useTheme();
  const summary = statusCounts(workers)
    .map((bucket) => `${bucket.n} ${bucket.label}`)
    .join(" · ");

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        marginHorizontal: 16,
        paddingHorizontal: 12,
        paddingVertical: 13,
        borderRadius: radius.lg,
        backgroundColor: pressed ? theme.raised : theme.panel,
        borderWidth: 1,
        borderColor: theme.line,
      })}
    >
      <Pressable
        onPress={workers.length ? onToggle : undefined}
        hitSlop={8}
        style={{
          width: 22,
          height: 38,
          alignItems: "center",
          justifyContent: "center",
          opacity: workers.length ? 1 : 0.25,
        }}
      >
        <Ionicons name={expanded ? "chevron-down" : "chevron-forward"} size={16} color={theme.faint} />
      </Pressable>
      <SignalBar status={task.status} height={42} />
      <View style={{ flex: 1, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <CollaborationBadge mode="team" />
          <Text style={{ flex: 1, color: theme.ink, fontSize: 15, fontFamily: fonts.bodySemi }} numberOfLines={2}>
            {task.title || "(无标题)"}
          </Text>
        </View>
        <Text style={{ color: summary ? theme.muted : theme.faint, fontSize: 12, fontFamily: fonts.mono }} numberOfLines={1}>
          {summary || "暂无执行者"}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 9 }}>
          <Text style={{ color: theme.faint, fontSize: 11, fontFamily: fonts.mono }}>
            调度者 {task.team?.leadExecutorLabel || task.executorLabel || task.team?.lead || task.agentType || "—"}
          </Text>
          <TaskTimeChip task={task} />
        </View>
      </View>
    </Pressable>
  );
}

function TaskCard({ task, parentTitle, onPress }: { task: Task; parentTitle?: string; onPress: () => void }) {
  const theme = useTheme();
  const nested = !!parentTitle;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 13,
        marginLeft: nested ? 48 : 16,
        marginRight: 16,
        paddingHorizontal: 14,
        paddingVertical: nested ? 11 : 14,
        borderRadius: radius.lg,
        backgroundColor: pressed ? theme.raised : nested ? theme.bg : theme.panel,
        borderWidth: 1,
        borderColor: theme.line,
      })}
    >
      <SignalBar status={task.status} height={nested ? 34 : 38} />
      <View style={{ flex: 1, gap: 5 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 7 }}>
          {task.mode === "duet" ? <CollaborationBadge mode="duet" /> : null}
          <Text
            style={{ flex: 1, color: theme.ink, fontSize: nested ? 14 : 15, fontFamily: fonts.bodySemi }}
            numberOfLines={2}
          >
            {task.title || "(无标题)"}
          </Text>
        </View>
        {parentTitle ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Ionicons name="home-outline" size={11} color={theme.accent} />
            <Text style={{ flex: 1, color: theme.faint, fontSize: 11, fontFamily: fonts.mono }} numberOfLines={1}>
              所属团队 {parentTitle}
            </Text>
          </View>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          {task.agentType ? (
            <Text style={{ color: theme.muted, fontSize: 12, fontFamily: fonts.mono }}>@{task.agentType}</Text>
          ) : null}
          {!nested
            ? task.labels.slice(0, 2).map((label) => (
                <Text key={label} style={{ color: theme.faint, fontSize: 12, fontFamily: fonts.mono }}>
                  #{label}
                </Text>
              ))
            : null}
          <TaskTimeChip task={task} />
        </View>
      </View>
    </Pressable>
  );
}

function CollaborationBadge({ mode }: { mode: "team" | "duet" }) {
  const theme = useTheme();
  const duet = mode === "duet";
  const color = duet ? DUET_COLOR : theme.accent;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: radius.pill,
        backgroundColor: duet ? `${DUET_COLOR}20` : theme.raised,
      }}
    >
      <Ionicons name={duet ? "chatbubbles-outline" : "people"} size={12} color={color} />
      <Text style={{ color, fontSize: 10, fontFamily: fonts.monoMed }}>{duet ? "讨论" : "团队"}</Text>
    </View>
  );
}
