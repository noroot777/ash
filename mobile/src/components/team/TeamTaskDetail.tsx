import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  canArchive,
  type Group,
  type Session,
  type Task,
} from "@harness/shared";
import {
  batchesOf,
  isTeamSettled,
  teamGroupsOf,
  workersOf,
} from "@harness/shared/team";
import { api, type TeamCuaStatus } from "@/lib/api";
import { refreshAll } from "@/lib/data";
import type { LogLine } from "@/lib/log";
import { useStore } from "@/lib/store";
import { fonts, radius, useTheme } from "@/lib/theme";
import { Conversation, type ConversationInsertion } from "@/components/Conversation";
import { MarkdownText } from "@/components/MarkdownText";
import { QuestionCard } from "@/components/QuestionCard";
import { TeamOverview } from "./TeamOverview";
import { TeamWorkerBatchCard } from "./TeamWorkerBatchCard";

export function TeamTaskDetail({
  task,
  lines,
  sessions,
  input,
  refreshing,
  scrollRef,
  onInputChange,
  onSend,
  onRefresh,
  onArchive,
  onUnarchive,
  onDelete,
  onScroll,
  onContentSizeChange,
}: {
  task: Task;
  lines: LogLine[];
  sessions: Session[];
  input: string;
  refreshing: boolean;
  scrollRef: RefObject<ScrollView | null>;
  onInputChange: (text: string) => void;
  onSend: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onContentSizeChange: () => void;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const allTasks = useStore((state) => state.tasks);
  const allGroups = useStore((state) => state.groups);
  const [internalGroups, setInternalGroups] = useState<Group[]>([]);
  const [action, setAction] = useState<"run" | "halt" | "resume" | null>(null);
  const [cuaStatus, setCuaStatus] = useState<TeamCuaStatus | null>(null);
  const [cuaChecking, setCuaChecking] = useState(false);

  const workers = useMemo(() => workersOf(allTasks, task.id), [allTasks, task.id]);
  const availableGroups = useMemo(() => {
    const byId = new Map(allGroups.map((group) => [group.id, group]));
    internalGroups.forEach((group) => byId.set(group.id, group));
    return [...byId.values()];
  }, [allGroups, internalGroups]);
  const teamGroups = useMemo(
    () => teamGroupsOf(availableGroups, task.id, workers),
    [availableGroups, task.id, workers],
  );
  const pausedGroups = useMemo(() => teamGroups.filter((group) => group.paused), [teamGroups]);
  const batches = useMemo(() => batchesOf(workers, teamGroups), [workers, teamGroups]);
  const workerNumber = useMemo(
    () => new Map(workers.map((worker, index) => [worker.id, index + 1])),
    [workers],
  );
  const openWorker = useCallback((workerId: string) => router.push(`/task/${workerId}`), [router]);
  const batchInsertions = useMemo<ConversationInsertion[]>(
    () => batches.map((batch, index) => ({
      key: batch.key,
      at: batch.at,
      content: (
        <TeamWorkerBatchCard
          batch={batch}
          batchNumber={index + 1}
          workerNumber={workerNumber}
          onOpenWorker={openWorker}
        />
      ),
    })),
    [batches, openWorker, workerNumber],
  );
  const settled = isTeamSettled(task.status === "running", workers);
  const haltedByHistory = useMemo(() => activeTeamHaltMarker(lines), [lines]);
  const stopped = pausedGroups.length > 0 || (teamGroups.length === 0 && haltedByHistory);

  const refreshInternalGroups = useCallback(async (showError = false) => {
    try {
      setInternalGroups(await api.groupsByOwnerTask(task.id));
    } catch (error) {
      if (showError) Alert.alert("刷新内部组失败", error instanceof Error ? error.message : String(error));
    }
  }, [task.id]);

  useEffect(() => setInternalGroups([]), [task.id]);

  // Reuse the app-wide 5s task-list refresh as the cadence signal instead of
  // creating another timer. This keeps group.paused current when a halt/resume
  // was triggered from web or another phone, while conversation polling stays 3s.
  useEffect(() => {
    void refreshInternalGroups();
  }, [allTasks, refreshInternalGroups]);

  const refreshCuaStatus = useCallback(async (showError = false) => {
    setCuaChecking(true);
    try {
      setCuaStatus(await api.teamCuaStatus(task.id));
    } catch (error) {
      if (showError) Alert.alert("检查失败", error instanceof Error ? error.message : String(error));
    } finally {
      setCuaChecking(false);
    }
  }, [task.id]);

  // Only a genuinely paused internal group means the team was halted. A naturally
  // settled team has nothing to recover and does not trigger residual checks.
  useEffect(() => {
    if (stopped && !task.archived) void refreshCuaStatus();
    else setCuaStatus(null);
  }, [refreshCuaStatus, stopped, task.archived]);

  const runLead = async () => {
    setAction("run");
    try {
      await api.runTask(task.id);
      await refreshAll();
    } catch (error) {
      Alert.alert("运行失败", error instanceof Error ? error.message : String(error));
    } finally {
      setAction(null);
    }
  };

  const haltTeam = () =>
    Alert.alert(
      "停止全组？",
      "调度台会被停掉并保留会话；正在运行或排队的执行者会随内部组暂停，之后可以恢复。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "停止全组",
          style: "destructive",
          onPress: async () => {
            setAction("halt");
            try {
              await api.teamHalt(task.id);
              const affected = new Set(teamGroups.map((group) => group.id));
              setInternalGroups((current) =>
                current.map((group) => affected.has(group.id) ? { ...group, paused: true } : group),
              );
              await Promise.all([refreshInternalGroups(true), refreshAll().catch(() => {})]);
              await refreshCuaStatus();
            } catch (error) {
              Alert.alert("停止失败", error instanceof Error ? error.message : String(error));
            } finally {
              setAction(null);
            }
          },
        },
      ],
    );

  const resumeTeam = async () => {
    if (pausedGroups.length === 0) return;
    setAction("resume");
    try {
      await Promise.all(pausedGroups.map((group) => api.runGroup(group.id)));
      const resumed = new Set(pausedGroups.map((group) => group.id));
      setInternalGroups((current) =>
        current.map((group) => resumed.has(group.id) ? { ...group, paused: false } : group),
      );
      if (task.status !== "running") await api.runTask(task.id);
      setCuaStatus(null);
      await Promise.all([refreshInternalGroups(true), refreshAll()]);
    } catch (error) {
      Alert.alert("恢复失败", error instanceof Error ? error.message : String(error));
    } finally {
      setAction(null);
    }
  };

  const confirmKillCua = () => {
    const current = cuaStatus?.current;
    if (!current?.detected) return;
    Alert.alert("强制清理 computer-use？", current.sideEffect, [
      { text: "取消", style: "cancel" },
      {
        text: "强制清理",
        style: "destructive",
        onPress: async () => {
          try {
            const result = await api.killTeamCua(task.id);
            setCuaStatus({ taskId: task.id, current: result.status, last: current });
            Alert.alert("清理结果", [result.status.message, result.warning].filter(Boolean).join("\n\n"));
          } catch (error) {
            Alert.alert("清理失败", error instanceof Error ? error.message : String(error));
          }
        },
      },
    ]);
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
    >
      <Stack.Screen
        options={{
          title: "团队",
          headerRight: () => (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 18 }}>
              {task.archived ? (
                <Pressable accessibilityLabel="取消归档" onPress={onUnarchive} hitSlop={10}>
                  <Ionicons name="archive" size={20} color={theme.accent} />
                </Pressable>
              ) : canArchive(task.status) ? (
                <Pressable accessibilityLabel="归档团队" onPress={onArchive} hitSlop={10}>
                  <Ionicons name="archive-outline" size={20} color={theme.muted} />
                </Pressable>
              ) : null}
              <Pressable accessibilityLabel="删除团队任务" onPress={onDelete} hitSlop={10}>
                <Ionicons name="trash-outline" size={20} color={theme.danger} />
              </Pressable>
            </View>
          ),
        }}
      />

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 28 }}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={onContentSizeChange}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.muted} />}
      >
        <TeamOverview
          task={task}
          workers={workers}
          pausedGroups={pausedGroups}
          settled={settled}
          stopped={stopped}
          action={action}
          cuaStatus={cuaStatus}
          cuaChecking={cuaChecking}
          onRun={() => void runLead()}
          onHalt={haltTeam}
          onResume={() => void resumeTeam()}
          onKillCua={confirmKillCua}
        />

        {task.body ? (
          <View
            style={{
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: theme.line,
              backgroundColor: theme.panel,
              padding: 12,
            }}
          >
            <Text style={{ color: theme.faint, fontSize: 10, fontFamily: fonts.monoMed, marginBottom: 7 }}>原始需求</Text>
            <MarkdownText value={task.body} style={{ color: theme.muted, fontSize: 14, lineHeight: 20 }} />
          </View>
        ) : null}

        {task.question ? <QuestionCard task={task} /> : null}

        <View style={{ gap: 9 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ flex: 1, color: theme.ink, fontSize: 16, fontFamily: fonts.displayMd }}>
              调度者会话
            </Text>
            <Text style={{ color: theme.faint, fontSize: 10, fontFamily: fonts.mono }}>
              3s 轮询
            </Text>
          </View>
          <Conversation
            lines={lines}
            sessions={sessions}
            taskEndedAt={task.endedAt}
            insertions={batchInsertions}
          />
          {lines.length === 0 && batches.length === 0 && !task.question ? (
            <Text style={{ color: theme.faint, fontSize: 13, lineHeight: 19, fontFamily: fonts.body }}>
              还没有调度记录。点“运行”让调度者读需求、拆活并派出执行者。
            </Text>
          ) : null}
        </View>
      </ScrollView>

      <TeamReplyBox
        input={input}
        frozen={!!task.archived}
        bottomInset={insets.bottom}
        onInputChange={onInputChange}
        onSend={onSend}
      />
    </KeyboardAvoidingView>
  );
}

function activeTeamHaltMarker(lines: LogLine[]): boolean {
  let lastHalt = -1;
  lines.forEach((line, index) => {
    if (line.kind === "system" && line.text.includes("你按了「停止全组」")) lastHalt = index;
  });
  if (lastHalt < 0) return false;
  return !lines.slice(lastHalt + 1).some((line) => line.kind === "user" || line.kind === "text");
}

function TeamReplyBox({
  input,
  frozen,
  bottomInset,
  onInputChange,
  onSend,
}: {
  input: string;
  frozen: boolean;
  bottomInset: number;
  onInputChange: (text: string) => void;
  onSend: () => void | Promise<void>;
}) {
  const theme = useTheme();
  if (frozen) {
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          paddingTop: 12,
          paddingBottom: bottomInset + 12,
          borderTopWidth: 1,
          borderTopColor: theme.line,
          backgroundColor: theme.panel,
        }}
      >
        <Ionicons name="archive" size={14} color={theme.faint} />
        <Text style={{ color: theme.faint, fontSize: 13, fontFamily: fonts.body }}>团队已归档——取消归档后可继续对话</Text>
      </View>
    );
  }
  const enabled = !!input.trim();
  return (
    <View
      style={{
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: bottomInset + 8,
        borderTopWidth: 1,
        borderTopColor: theme.line,
        backgroundColor: theme.panel,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        <TextInput
          value={input}
          onChangeText={onInputChange}
          accessibilityLabel="回复调度者"
          placeholder="插一句话：改方向、加要求、直接拍板…"
          placeholderTextColor={theme.faint}
          multiline
          style={{
            flex: 1,
            maxHeight: 120,
            color: theme.ink,
            backgroundColor: theme.bg,
            borderWidth: 1,
            borderColor: theme.line,
            borderRadius: radius.lg,
            paddingHorizontal: 12,
            paddingVertical: 9,
            fontSize: 15,
            fontFamily: fonts.body,
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="发送给调度者"
          disabled={!enabled}
          onPress={() => void onSend()}
          style={{
            minWidth: 58,
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 14,
            paddingVertical: 11,
            borderRadius: radius.lg,
            backgroundColor: theme.accent,
            opacity: enabled ? 1 : 0.4,
          }}
        >
          <Text style={{ color: theme.accentFg, fontSize: 14, fontFamily: fonts.bodySemi }}>发送</Text>
        </Pressable>
      </View>
    </View>
  );
}
