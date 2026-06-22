import { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  RefreshControl,
  AppState,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { refreshAll } from "@/lib/data";
import { runAction, canStopTask } from "@/lib/taskActions";
import { STATUS_META } from "@/lib/constants";
import { useTheme, radius, fonts } from "@/lib/theme";
import { Ionicons } from "@expo/vector-icons";
import { Conversation } from "@/components/Conversation";
import { Markdown } from "@/components/Markdown";
import { PriorityBars } from "@/components/ui";
import { SignalBar } from "@/components/SignalBar";
import { DateTimeButton } from "@/components/DateTimeField";
import { TaskTimeChip, formatInstant } from "@/lib/time";
import type { Session, ScheduledMessage } from "@harness/shared";
import type { LogLine } from "@/lib/log";
import { snapshotToLogLines } from "@/lib/log";

// How often a running task's conversation is re-pulled from its .md.
const CONV_POLL_MS = 3000;
// 待发送消息（定时发送）刷新节奏 —— 比会话慢，且与任务是否运行无关。
const PENDING_POLL_MS = 8000;

export default function TaskDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  const task = useStore((s) => s.tasks.find((t) => t.id === id));
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);

  // Conversation lives locally and is polled from the session .md — no global
  // store, no live stream. `lines` is the parsed, displayable transcript.
  const [lines, setLines] = useState<LogLine[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<ScheduledMessage[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // Pull every session's .md and rebuild the transcript. One call = one full
  // snapshot; we replace rather than append, so the same call also fills any gap.
  const loadConv = useCallback(async () => {
    const ss = await api.sessions(id);
    const withOut = await Promise.all(
      ss.map(async (s) => ({ s, out: await api.sessionOutput(s.id).catch(() => "") })),
    );
    const all: LogLine[] = [];
    for (const { s, out } of withOut.filter(({ out }) => out.trim())) {
      all.push(...snapshotToLogLines(out, s.id, s.agentType));
    }
    setLines(all);
    setSessions(ss);
  }, [id]);

  // 待发送消息（定时发送）：独立加载，供下面的轮询 effect 与发送/取消复用。
  const loadPending = useCallback(async () => {
    setPending(await api.scheduledMessages(id).catch(() => []));
  }, [id]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadConv().catch(() => {}), refreshAll().catch(() => {})]);
    setRefreshing(false);
  }, [loadConv]);

  // Hydrate the task if we navigated straight here (e.g. deep link) without it
  // already being in the store.
  useEffect(() => {
    if (!task && id) api.task(id).then(upsertTask).catch(() => {});
  }, [id, task, upsertTask]);

  // Conversation polling — no live stream. Pull once on open; while the task is
  // running keep pulling every few seconds; when it settles the dependency change
  // pulls the final tail once and then stops (the .md no longer grows). Returning
  // to the foreground forces an immediate catch-up pull.
  useEffect(() => {
    const running = task?.status === "running" || task?.status === "queued";
    let timer: ReturnType<typeof setInterval> | null = null;
    const pull = () => loadConv().catch(() => {});
    pull();
    if (running) timer = setInterval(pull, CONV_POLL_MS);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") pull();
    });
    return () => {
      if (timer) clearInterval(timer);
      sub.remove();
    };
  }, [id, task?.status, loadConv]);

  // 待发送消息轮询：与任务是否 running 无关（idle 任务也可有待发消息），节奏比会话慢。
  // 回前台立即补拉一次。
  useEffect(() => {
    loadPending();
    const timer = setInterval(loadPending, PENDING_POLL_MS);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") loadPending();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [loadPending]);

  if (!task) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={theme.muted} />
      </View>
    );
  }

  const status = task.status;
  const action = runAction(status);
  const replyBlocked = status === "running" || status === "queued";

  const onPrimary = () => {
    if (action.kind === "run") {
      setLines([]);
      api.runTask(id).then(() => refreshAll()).catch(() => {});
    } else if (action.kind === "retry") {
      api.retryTask(id).then(() => refreshAll()).catch(() => {});
    }
  };
  const onStop = () => api.stopTask(id).then(() => refreshAll()).catch(() => {});

  const confirmDelete = () =>
    Alert.alert("删除任务", `确定删除「${task.title}」？此操作不可撤销。`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: async () => {
          await api.deleteTask(id).catch(() => {});
          removeTask(id);
          if (router.canGoBack()) router.back();
          else router.replace("/");
        },
      },
    ]);

  const send = async (sendAt?: Date) => {
    const text = input.trim();
    if (!text) return;
    // 定时发送：排到待发列表，到点由调度器投递。对 running 任务也允许（后端明确允许）。
    if (sendAt) {
      if (sendAt.getTime() <= Date.now()) {
        Alert.alert("定时发送", "时间必须在将来");
        return;
      }
      try {
        const r = await api.replyTask(id, text, { sendAt: sendAt.toISOString() });
        setInput("");
        if (r?.message) {
          setPending((ps) => [...ps, r.message!].sort((a, b) => a.sendAt.localeCompare(b.sendAt)));
        } else {
          loadPending();
        }
      } catch (e) {
        Alert.alert("定时失败", e instanceof Error ? e.message : String(e));
      }
      return;
    }
    setInput("");
    // Optimistic local bubble; the poll replaces it with the .md's own record of
    // the same turn once the reply lands.
    setLines((ls) => [...ls, { kind: "user", text, at: new Date().toISOString() }]);
    try {
      await api.replyTask(id, text);
      refreshAll().catch(() => {}); // pick up the running status → conversation poll kicks in
    } catch (e) {
      Alert.alert("回复失败", e instanceof Error ? e.message : String(e));
    }
  };

  // 取消一条待发送消息：乐观移除，失败再拉回。
  const cancelScheduled = async (mid: string) => {
    setPending((ps) => ps.filter((m) => m.id !== mid));
    await api.cancelScheduledMessage(mid).catch(() => loadPending());
  };

  const meta = STATUS_META[status];

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
    >
      <Stack.Screen
        options={{
          title: "",
          headerRight: () => (
            <Pressable onPress={confirmDelete} hitSlop={10}>
              <Text style={{ color: theme.danger, fontSize: 17 }}>🗑</Text>
            </Pressable>
          ),
        }}
      />

      {/* Frozen header: status + title + metadata (stays put while conversation scrolls) */}
      <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: theme.line, gap: 13 }}>
        <SignalBar status={status} height={52} />
        <View style={{ flex: 1, gap: 10 }}>
          {/* Status label + run/stop action */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: meta?.color, fontSize: 11, fontFamily: fonts.monoMed, letterSpacing: 1 }}>
              {status.toUpperCase().replace(/_/g, " ")}
            </Text>
            <View style={{ flex: 1 }} />
            {canStopTask(status) ? (
              <Pressable
                onPress={onStop}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: theme.danger,
                }}
              >
                <Text style={{ color: theme.danger, fontSize: 13, fontFamily: fonts.bodySemi }}>停止</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={action.canClick ? onPrimary : undefined}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 7,
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

          {/* Title */}
          <Text style={{ color: theme.ink, fontSize: 21, fontFamily: fonts.display, lineHeight: 27 }} numberOfLines={2}>
            {task.title || "(无标题)"}
          </Text>

          {/* Metadata: agent + priority + labels */}
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            {task.agentType ? (
              <Text style={{ color: theme.muted, fontSize: 12, fontFamily: fonts.mono }}>@{task.agentType}</Text>
            ) : null}
            <PriorityBars priority={task.priority} />
            {task.labels.map((l) => (
              <Text key={l} style={{ color: theme.faint, fontSize: 12, fontFamily: fonts.mono }}>
                #{l}
              </Text>
            ))}
            <TaskTimeChip task={task} />
          </View>
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 24 }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.muted} />}
      >
        {/* Objective */}
        {task.body ? (
          <View
            style={{
              backgroundColor: theme.panel,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: theme.line,
              padding: 12,
            }}
          >
            <Text style={{ color: theme.muted, fontSize: 14, lineHeight: 20 }}>{task.body}</Text>
          </View>
        ) : null}

        {/* Conversation (polled from the session .md) */}
        <Conversation lines={lines} sessions={sessions} taskEndedAt={task.endedAt} />

        {lines.length === 0 ? (
          <Text style={{ color: theme.faint, fontSize: 13, textAlign: "center", paddingTop: 20 }}>
            还没有输出 — 点上方「{action.label}」开始
          </Text>
        ) : null}
      </ScrollView>

      {/* Reply composer：上方待发列表（定时发送），下方输入行 [输入][🕐][发送] */}
      <View
        style={{
          paddingHorizontal: 12,
          paddingTop: 8,
          paddingBottom: insets.bottom + 8,
          borderTopWidth: 1,
          borderTopColor: theme.line,
          backgroundColor: theme.panel,
          gap: 8,
        }}
      >
        {pending.map((m) => (
          <View
            key={m.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              backgroundColor: theme.overlay,
              borderRadius: radius.sm,
              paddingHorizontal: 10,
              paddingVertical: 6,
            }}
          >
            <Ionicons name="time-outline" size={13} color={theme.faint} />
            <Text style={{ color: theme.muted, fontSize: 12, fontFamily: fonts.mono }}>{formatInstant(m.sendAt)}</Text>
            <Text numberOfLines={1} style={{ flex: 1, color: theme.ink, fontSize: 13 }}>
              {m.text || "[附件]"}
            </Text>
            <Pressable onPress={() => cancelScheduled(m.id)} hitSlop={8}>
              <Ionicons name="close" size={15} color={theme.faint} />
            </Pressable>
          </View>
        ))}

        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
          <TextInput
            value={input}
            onChangeText={setInput}
            editable={!replyBlocked}
            placeholder={replyBlocked ? "运行中，暂不能回复…" : "回复（续接会话）…"}
            placeholderTextColor={theme.faint}
            multiline
            style={{
              flex: 1,
              color: theme.ink,
              backgroundColor: theme.bg,
              borderWidth: 1,
              borderColor: theme.line,
              borderRadius: radius.lg,
              paddingHorizontal: 12,
              paddingVertical: 9,
              fontSize: 15,
              maxHeight: 120,
              opacity: replyBlocked ? 0.5 : 1,
            }}
          />
          {/* 🕐 定时发送：对 running 任务也允许排定时（后端允许），故只看是否有文字 */}
          <DateTimeButton
            defaultValue={() => new Date(Date.now() + 3600_000)}
            minimumDate={new Date()}
            disabled={!input.trim()}
            onPick={(d) => send(d)}
          >
            <View
              style={{
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderRadius: radius.lg,
                borderWidth: 1,
                borderColor: theme.line,
                opacity: input.trim() ? 1 : 0.4,
              }}
            >
              <Ionicons name="time-outline" size={18} color={theme.muted} />
            </View>
          </DateTimeButton>
          <Pressable
            onPress={() => send()}
            disabled={replyBlocked || !input.trim()}
            style={{
              paddingHorizontal: 16,
              paddingVertical: 11,
              borderRadius: radius.lg,
              backgroundColor: theme.accent,
              opacity: replyBlocked || !input.trim() ? 0.4 : 1,
            }}
          >
            <Text style={{ color: theme.accentFg, fontSize: 14, fontWeight: "600" }}>发送</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
