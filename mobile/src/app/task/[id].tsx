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
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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
import { QuestionCard } from "@/components/QuestionCard";
import { DuetTaskDetail } from "@/components/DuetTaskDetail";
import { TeamTaskDetail } from "@/components/team/TeamTaskDetail";
import { WorkerTeamLink } from "@/components/WorkerTeamLink";
import { MarkdownText } from "@/components/MarkdownText";
import { SignalBar } from "@/components/SignalBar";
import { SkillSuggestions } from "@/components/SkillSuggestions";
import { DateTimeButton } from "@/components/DateTimeField";
import { TaskTimeChip, formatInstant } from "@/lib/time";
import { canArchive } from "@ash/shared";
import type { Session, ScheduledMessage } from "@ash/shared";
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

  const tasks = useStore((s) => s.tasks);
  const task = tasks.find((item) => item.id === id);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);

  // Conversation lives locally and is polled from the session .md — no global
  // store, no live stream. `lines` is the parsed, displayable transcript.
  const [lines, setLines] = useState<LogLine[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<ScheduledMessage[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  // 任务正文：列表不带，按 id 单取（见下面的 hydrate effect）。
  const [body, setBody] = useState<string | undefined>(undefined);
  const scrollRef = useRef<ScrollView>(null);
  // 是否「粘」在底部。轮询拉到新内容时,只有粘底状态才自动滚到底,
  // 否则别打扰正在往回翻历史的用户。初始 true,所以首次内容到达会滚到底。
  const stickToBottomRef = useRef(true);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - (layoutMeasurement.height + contentOffset.y);
    stickToBottomRef.current = distanceFromBottom < 80;
  }, []);

  const handleContentSizeChange = useCallback(() => {
    if (stickToBottomRef.current) scrollRef.current?.scrollToEnd({ animated: true });
  }, []);

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
  //
  // 顺带把**正文**取回来：列表接口不再带正文（shared 的 TaskListItem），而正文只有
  // 这一屏用得上。`undefined` = 还没读到，空串 = 这个任务确实没写需求 —— 界面上前者
  // 什么都不显示，后者本来就不显示，两者都不会编出一段假需求。
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setBody(undefined);
    api.task(id)
      .then((full) => { if (alive) { setBody(full.body); upsertTask(full); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [id, upsertTask]);

  // Conversation polling — no live stream. Pull once on open; while the task is
  // running keep pulling every few seconds; when it settles the dependency change
  // pulls the final tail once and then stops (the .md no longer grows). Returning
  // to the foreground forces an immediate catch-up pull.
  useEffect(() => {
    if (!task || task.mode === "duet") return;
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
  }, [id, task?.mode, task?.status, loadConv]);

  // 待发送消息轮询：与任务是否 running 无关（idle 任务也可有待发消息），节奏比会话慢。
  // 回前台立即补拉一次；状态一变也立刻补拉——排队消息正是在任务转空闲那一刻被投递出去的，
  // 靠慢轮询会让它在列表里多挂十几秒。
  useEffect(() => {
    if (!task || task.mode === "duet") return;
    loadPending();
    const timer = setInterval(loadPending, PENDING_POLL_MS);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") loadPending();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [loadPending, task?.mode, task?.status]);

  if (!task) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={theme.muted} />
      </View>
    );
  }

  const status = task.status;
  const dispatchedWorker = task.parentId !== null;
  const parentTeam = dispatchedWorker ? tasks.find((item) => item.id === task.parentId) : null;
  const action = runAction(status, { mode: task.mode, awaitingAnswer: !!task.question });
  // 团队调度台是常驻会话，运行中直接收消息。单飞任务是一次性运行，收不了实时输入，
  // 所以运行中发出的回复由后端落成「排队消息」，这一轮跑完自动送进同一个会话
  // （见 server/src/pending-messages.ts）——能发，只是晚一步，不再是拒收。
  const queueing = task.mode !== "team" && (status === "running" || status === "queued");

  const onPrimary = () => {
    if (action.kind === "run") {
      stickToBottomRef.current = true;
      setLines([]);
      api.runTask(id).then(() => refreshAll()).catch(() => {});
    } else if (action.kind === "retry") {
      stickToBottomRef.current = true;
      api.retryTask(id).then(() => refreshAll()).catch(() => {});
    }
  };
  const onStop = () => api.stopTask(id).then(() => refreshAll()).catch(() => {});

  // 归档态只读(server 拒编辑/运行/回复):归档后退回列表落入「已归档」区;取消归档留在详情并解冻。
  const frozen = !!task.archived;
  const onArchive = () =>
    api
      .archiveTask(id)
      .then(() => {
        refreshAll().catch(() => {});
        if (router.canGoBack()) router.back();
        else router.replace("/");
      })
      .catch((e) => Alert.alert("归档失败", e instanceof Error ? e.message : String(e)));
  const onUnarchive = () =>
    api
      .unarchiveTask(id)
      .then((t) => {
        upsertTask(t);
        refreshAll().catch(() => {});
      })
      .catch((e) => Alert.alert("取消归档失败", e instanceof Error ? e.message : String(e)));

  // 删除任务:worktree 目录和 ash/<id8> 分支不会跟着任务行一起没,所以先问
  // 一次服务端还留着什么 —— 留着就多给一个「连它们一起删」的选项。任务一删,这两
  // 样在界面上就再没有入口了,这一问是唯一的机会。
  const confirmDelete = async () => {
    const leftover = await api.taskWorkspace(id).catch(() => null);
    const hasLeftover = !!(leftover?.path || leftover?.branch);
    const detail = hasLeftover
      ? `\n\n它还留着：${leftover!.path ? `\nworktree ${leftover!.path}` : ""}${leftover!.branch ? `\n分支 ${leftover!.branch}` : ""}`
      : "";
    const doDelete = async (discard: boolean) => {
      const projectId = task.projectId;
      const res = await api
        .deleteTask(id, discard ? { worktree: !!leftover?.path, branch: !!leftover?.branch } : undefined)
        .catch((e) => {
          Alert.alert("删除失败", e instanceof Error ? e.message : String(e));
          return null;
        });
      removeTask(id);
      const rest = res?.leftover?.path || res?.leftover?.branch ? res!.leftover! : null;
      const failed = !!(res?.cleanup?.worktreeError || res?.cleanup?.branchError);
      if (!failed || !rest) {
        navigateBack();
        return;
      }
      // git 拒绝了(有未提交改动 / 未合并提交)。原话摆出来,强制删除由用户再点一次。
      const why = [res?.cleanup?.worktreeError, res?.cleanup?.branchError].filter(Boolean).join("\n\n");
      Alert.alert("任务已删除，但 worktree/分支没删掉", `${why}\n\n强制删除会把里面的改动直接丢掉。`, [
        { text: "先留着", style: "cancel", onPress: () => navigateBack() },
        {
          text: "强制删除",
          style: "destructive",
          onPress: async () => {
            const forced = await api
              .discardTaskWorkspace(projectId, {
                taskId: id,
                worktree: !!rest.path,
                branch: !!rest.branch,
                force: true,
              })
              .catch((e) => {
                Alert.alert("强制删除失败", e instanceof Error ? e.message : String(e));
                return null;
              });
            const stillFailed = forced?.worktreeError || forced?.branchError;
            if (stillFailed) Alert.alert("强制删除失败", stillFailed);
            navigateBack();
          },
        },
      ]);
    };
    Alert.alert(
      "删除任务",
      `确定删除「${task.title}」？此操作不可撤销。${detail}`,
      hasLeftover
        ? [
            { text: "取消", style: "cancel" },
            { text: "只删任务", onPress: () => void doDelete(false) },
            { text: "连 worktree 和分支一起删", style: "destructive", onPress: () => void doDelete(true) },
          ]
        : [
            { text: "取消", style: "cancel" },
            { text: "删除", style: "destructive", onPress: () => void doDelete(false) },
          ],
    );
  };
  const navigateBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

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
    // 任务在跑时后端会把这条落成排队消息，没真发出去就不能先贴进时间线。
    if (!queueing) {
      // Optimistic local bubble; the poll replaces it with the .md's own record of
      // the same turn once the reply lands.
      stickToBottomRef.current = true;
      setLines((ls) => [...ls, { kind: "user", text, at: new Date().toISOString() }]);
    }
    try {
      const r = await api.replyTask(id, text);
      // 按结果分支:任务刚好在这一刻起跑时,前端判断会落后于后端。
      if (r?.scheduled) {
        if (r.message) setPending((ps) => [...ps, r.message!].sort((a, b) => a.sendAt.localeCompare(b.sendAt)));
        else loadPending();
        loadConv().catch(() => {}); // 抹掉抢跑时可能贴出的那个气泡
        return;
      }
      refreshAll().catch(() => {}); // pick up the running status → conversation poll kicks in
    } catch (e) {
      Alert.alert("回复失败", e instanceof Error ? e.message : String(e));
    }
  };

  // 真正调用取消端点：把这条消息从队列上取下来。成功返回 true，失败照实说并重拉列表
  // （消息还挂在队列上，界面不能自己少一行）。撤回和丢弃都经它，区别只在取下来之后
  // 做什么。
  const cancelPending = async (message: ScheduledMessage): Promise<boolean> => {
    try {
      await api.cancelScheduledMessage(message.id);
    } catch (e) {
      Alert.alert("操作失败", e instanceof Error ? e.message : String(e));
      loadPending();
      return false;
    }
    setPending((ps) => ps.filter((m) => m.id !== message.id));
    return true;
  };

  // 撤回一条待发送消息：把它从队列上取下来，正文放回输入框继续编辑（跟 web 托盘同一
  // 套语义，见 web/src/task-detail/withdrawDraft.ts）。取消成功才回填——失败了消息还在
  // 队列上，再往输入框塞一份就成了两条。
  //
  // 手机端这一屏**没有附件通道**（输入框只发正文），带附件的消息撤回下来附件没有落点。
  // 撤回这个词承诺的是「内容原样回到输入框」，做不到就一次都不做：只提示去网页端撤回，
  // **不发 DELETE**——按下去消息一个字都没少，用户随时还能在网页端把它整条捞回来。真想
  // 直接扔掉的，走旁边那颗语义明确的丢弃按钮。
  const withdrawScheduled = async (message: ScheduledMessage) => {
    if (message.attachments.length) {
      Alert.alert(
        "这条得去网页端撤回",
        `共 ${message.attachments.length} 个附件。手机端的输入框只放得下正文，附件没有落点，所以这里不做撤回——消息仍在队列上。到网页端撤回，正文和附件会一起回到对话框；只想扔掉它就点旁边的丢弃。`,
        [{ text: "知道了" }],
      );
      return;
    }
    if (!await cancelPending(message)) return;
    const restored = message.text.trim();
    if (restored) setInput((current) => (current.trim() ? `${restored}\n\n${current}` : restored));
  };

  // 丢弃：明说了不留内容的那条路。它跟撤回是两回事，所以是两颗按钮、两套措辞——把
  // 「什么都不留」藏在承诺「放回输入框」的入口下面，等于骗用户按下删除键。
  const discardScheduled = (message: ScheduledMessage) => {
    Alert.alert(
      "丢弃这条待发送消息？",
      message.attachments.length
        ? `正文和 ${message.attachments.length} 个附件都不保留，也不会放回输入框。`
        : "正文不保留，也不会放回输入框。",
      [
        { text: "取消", style: "cancel" },
        { text: "丢弃", style: "destructive", onPress: () => void cancelPending(message) },
      ],
    );
  };

  const meta = STATUS_META[status];

  if (task.mode === "team") {
    return (
      <TeamTaskDetail
        task={task}
        body={body}
        lines={lines}
        sessions={sessions}
        input={input}
        refreshing={refreshing}
        scrollRef={scrollRef}
        onInputChange={setInput}
        onSend={() => send()}
        onRefresh={onRefresh}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
        onDelete={confirmDelete}
        onScroll={handleScroll}
        onContentSizeChange={handleContentSizeChange}
      />
    );
  }

  if (task.mode === "duet") {
    return (
      <DuetTaskDetail
        task={task}
        body={body}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
        onDelete={confirmDelete}
      />
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
    >
      <Stack.Screen
        options={{
          title: "",
          headerRight: dispatchedWorker
            ? undefined
            : () => (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 18 }}>
                  {task.archived ? (
                    <Pressable onPress={onUnarchive} hitSlop={10}>
                      <Ionicons name="archive" size={20} color={theme.accent} />
                    </Pressable>
                  ) : canArchive(status) ? (
                    <Pressable onPress={onArchive} hitSlop={10}>
                      <Ionicons name="archive-outline" size={20} color={theme.muted} />
                    </Pressable>
                  ) : null}
                  <Pressable onPress={confirmDelete} hitSlop={10}>
                    <Text style={{ color: theme.danger, fontSize: 17 }}>🗑</Text>
                  </Pressable>
                </View>
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
            {frozen ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Ionicons name="archive" size={13} color={theme.faint} />
                <Text style={{ color: theme.faint, fontSize: 12, fontFamily: fonts.mono }}>已归档</Text>
              </View>
            ) : canStopTask(status) ? (
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

          {dispatchedWorker ? (
            <WorkerTeamLink
              title={parentTeam?.title || "返回团队调度台"}
              onPress={() => router.push(`/task/${task.parentId}`)}
            />
          ) : null}

          {/* Metadata: agent + labels */}
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            {task.agentType ? (
              <Text style={{ color: theme.muted, fontSize: 12, fontFamily: fonts.mono }}>@{task.agentType}</Text>
            ) : null}
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
        onScroll={handleScroll}
        scrollEventThrottle={64}
        onContentSizeChange={handleContentSizeChange}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.muted} />}
      >
        {/* Objective */}
        {body ? (
          <View
            style={{
              backgroundColor: theme.panel,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: theme.line,
              padding: 12,
            }}
          >
            <MarkdownText value={body} style={{ color: theme.muted, fontSize: 14, lineHeight: 20 }} />
          </View>
        ) : null}

        {/* Conversation (polled from the session .md) */}
        <Conversation lines={lines} sessions={sessions} taskEndedAt={task.endedAt} />

        {/* ask_question answer flow stays separate from ordinary conversation replies. */}
        {task.question ? <QuestionCard task={task} /> : null}

        {lines.length === 0 && !task.question ? (
          <Text style={{ color: theme.faint, fontSize: 13, textAlign: "center", paddingTop: 20 }}>
            还没有输出 — 点上方「{action.label}」开始
          </Text>
        ) : null}
      </ScrollView>

      {/* Reply composer：归档只读→提示条;否则待发列表(定时发送)+输入行 [输入][🕐][发送] */}
      {frozen ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            paddingTop: 12,
            paddingBottom: insets.bottom + 12,
            borderTopWidth: 1,
            borderTopColor: theme.line,
            backgroundColor: theme.panel,
          }}
        >
          <Ionicons name="archive" size={14} color={theme.faint} />
          <Text style={{ color: theme.faint, fontSize: 13 }}>
            {dispatchedWorker ? "已由所属团队归档" : "已归档——取消归档后可继续对话"}
          </Text>
        </View>
      ) : (
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
            {/* 排队消息不看时间（跑完就发），所以那一列写「排队中」而不是一个骗人的时刻。 */}
            <Ionicons name={m.mode === "queued" ? "layers-outline" : "time-outline"} size={13} color={theme.faint} />
            <Text style={{ color: theme.muted, fontSize: 12, fontFamily: fonts.mono }}>
              {m.mode === "queued" ? "排队中" : formatInstant(m.sendAt)}
            </Text>
            <Text numberOfLines={1} style={{ flex: 1, color: theme.ink, fontSize: 13 }}>
              {m.text || "[附件]"}
            </Text>
            {/* 手机端撤不回附件（见 withdrawScheduled），所以按之前先让人看见这条带了几个。 */}
            {m.attachments.length > 0 && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                <Ionicons name="attach-outline" size={12} color={theme.faint} />
                <Text style={{ color: theme.faint, fontSize: 11, fontFamily: fonts.mono }}>{m.attachments.length}</Text>
              </View>
            )}
            <Pressable
              onPress={() => void withdrawScheduled(m)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={m.attachments.length
                ? `撤回这条待发送消息；它带了 ${m.attachments.length} 个附件，需要到网页端撤回`
                : "撤回这条待发送消息，内容放回输入框"}
            >
              <Ionicons name="arrow-undo-outline" size={15} color={theme.faint} />
            </Pressable>
            {/* 丢弃跟撤回分成两颗:一颗承诺内容回到输入框,一颗明说什么都不留。 */}
            <Pressable
              onPress={() => discardScheduled(m)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="丢弃这条待发送消息，内容不保留"
            >
              <Ionicons name="trash-outline" size={15} color={theme.faint} />
            </Pressable>
          </View>
        ))}

        <SkillSuggestions
          agentType={task.agentType}
          projectId={task.projectId}
          value={input}
          onPick={(command) => setInput(`${command} `)}
        />

        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
          <TextInput
            value={input}
            onChangeText={setInput}
            editable
            placeholder={queueing ? "任务进行中，发送即排队，跑完自动发出…" : "回复（续接会话）…"}
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
            disabled={!input.trim()}
            style={{
              paddingHorizontal: 16,
              paddingVertical: 11,
              borderRadius: radius.lg,
              backgroundColor: theme.accent,
              opacity: !input.trim() ? 0.4 : 1,
            }}
          >
            <Text style={{ color: theme.accentFg, fontSize: 14, fontWeight: "600" }}>
              {queueing ? "排队" : "发送"}
            </Text>
          </Pressable>
        </View>
      </View>
      )}
    </KeyboardAvoidingView>
  );
}
