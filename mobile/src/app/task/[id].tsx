import { useEffect, useRef, useState } from "react";
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
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Session } from "@harness/shared";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { runAction, canStopTask } from "@/lib/taskActions";
import { STATUS_META } from "@/lib/constants";
import { useTheme, radius } from "@/lib/theme";
import { Conversation } from "@/components/Conversation";
import { Markdown } from "@/components/Markdown";
import { PriorityBars } from "@/components/ui";
import type { LogLine } from "@/lib/log";
import { snapshotToLogLines } from "@/lib/log";

// Stable empty array so the `logs` selector never returns a fresh `[]` (which
// would make useSyncExternalStore see a new snapshot every render → infinite loop).
const EMPTY_LOGS: LogLine[] = [];

export default function TaskDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  const task = useStore((s) => s.tasks.find((t) => t.id === id));
  const logs = useStore((s) => s.logs[id]) ?? EMPTY_LOGS;
  const sessionsBump = useStore((s) => s.sessionsBump);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);
  const clearLogs = useStore((s) => s.clearLogs);
  const appendUser = useStore((s) => s.appendUser);

  const [input, setInput] = useState("");
  const scrollRef = useRef<ScrollView>(null);

  // Hydrate the task if we navigated straight here (e.g. deep link) without it
  // already being in the store.
  useEffect(() => {
    if (!task && id) api.task(id).then(upsertTask).catch(() => {});
  }, [id, task, upsertTask]);

  // Snapshot prior runs' output (per session → its own bubble) on a fresh open or
  // when a run settles. Skipped while we already have live logs in memory, so a
  // reply doesn't wipe the streamed conversation. Ported from web TaskDetail.
  useEffect(() => {
    let alive = true;
    if (logs.length > 0) {
      return;
    }
    api.sessions(id).then(async (ss) => {
      const withOut = await Promise.all(
        ss.map(async (s) => ({ s, out: await api.sessionOutput(s.id).catch(() => "") })),
      );
      if (alive) {
        const snapshotWithData = withOut.filter(({ out }) => out.trim());
        // Parse all sessions and merge into a single logs array
        const allLines: LogLine[] = [];
        for (const { s, out } of snapshotWithData) {
          allLines.push(...snapshotToLogLines(out, s.id, s.agentType));
        }
        if (allLines.length > 0) {
          useStore.setState((state) => ({
            logs: { ...state.logs, [id]: allLines },
          }));
        }
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sessionsBump]);

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
      clearLogs(id);
      api.runTask(id).catch(() => {});
    } else if (action.kind === "retry") {
      api.retryTask(id).catch(() => {});
    }
  };
  const onStop = () => api.stopTask(id).catch(() => {});

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

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    appendUser(id, text);
    try {
      await api.replyTask(id, text);
    } catch (e) {
      Alert.alert("回复失败", e instanceof Error ? e.message : String(e));
    }
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
          title: task.title || "任务",
          headerRight: () => (
            <Pressable onPress={confirmDelete} hitSlop={10}>
              <Text style={{ color: theme.danger, fontSize: 17 }}>🗑</Text>
            </Pressable>
          ),
        }}
      />

      {/* Status + actions bar */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: theme.line,
        }}
      >
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: meta?.color }} />
        <Text style={{ color: theme.muted, fontSize: 13 }}>{meta?.label}</Text>
        {task.agentType ? <Text style={{ color: theme.faint, fontSize: 13 }}>@{task.agentType}</Text> : null}
        <PriorityBars priority={task.priority} />
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
            <Text style={{ color: theme.danger, fontSize: 13, fontWeight: "600" }}>停止</Text>
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
            <Text
              style={{ color: action.canClick ? theme.accentFg : theme.muted, fontSize: 13, fontWeight: "600" }}
            >
              {action.label}
            </Text>
          </Pressable>
        )}
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 24 }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
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

        {/* Conversation (both historical and live) */}
        <Conversation lines={logs} />

        {logs.length === 0 ? (
          <Text style={{ color: theme.faint, fontSize: 13, textAlign: "center", paddingTop: 20 }}>
            还没有输出 — 点上方「{action.label}」开始
          </Text>
        ) : null}
      </ScrollView>

      {/* Reply composer */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 8,
          paddingHorizontal: 12,
          paddingTop: 8,
          paddingBottom: insets.bottom + 8,
          borderTopWidth: 1,
          borderTopColor: theme.line,
          backgroundColor: theme.panel,
        }}
      >
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
        <Pressable
          onPress={send}
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
    </KeyboardAvoidingView>
  );
}
