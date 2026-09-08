import { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  KeyboardAvoidingView,
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
import { runAction } from "@/lib/taskActions";
import { keyboardAvoidingBehavior, useKeyboardOffset } from "@/lib/keyboard";
import { useStickyBottom } from "@/lib/scroll";
import { useTheme, radius } from "@/lib/theme";
import { Ionicons } from "@expo/vector-icons";
import { Conversation } from "@/components/Conversation";
import { QuestionCard } from "@/components/QuestionCard";
import { DuetTaskDetail } from "@/components/DuetTaskDetail";
import { TeamTaskDetail } from "@/components/team/TeamTaskDetail";
import { TaskDetailHeader } from "@/components/TaskDetailHeader";
import { TaskReviewPanel } from "@/components/TaskReviewPanel";
import { MarkdownText } from "@/components/MarkdownText";
import { ReplyComposer } from "@/components/ReplyComposer";
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
  const keyboardOffset = useKeyboardOffset();
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
  // 下拉刷新的计数器：会话/任务列表由本屏自己重拉，审查区块是独立组件、拉的是另一个
  // 端点，靠这个令牌搭一次顺风车（手机端一律轮询，不引 SSE）。
  const [refreshTick, setRefreshTick] = useState(0);
  // 任务正文：列表不带，按 id 单取（见下面的 hydrate effect）。
  const [body, setBody] = useState<string | undefined>(undefined);
  const scrollRef = useRef<ScrollView>(null);
  // 粘底：轮询来了新内容就跟到底，正在往回翻历史时不打扰。键盘弹出/输入区叠高导致的
  // 可视区变化也算，见 lib/scroll.ts。
  const sticky = useStickyBottom(scrollRef);
  // 待答问题卡夹在会话流中间，点进它的输入框时键盘会盖住下半张卡（发送键正在那儿）。
  // 拿它的节点当场量位置再滚 —— 别缓存坐标，理由见 revealNode 的注释。
  const questionRef = useRef<View>(null);
  const revealQuestion = useCallback(() => sticky.revealNode(questionRef.current), [sticky]);

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
    setRefreshTick((tick) => tick + 1);
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
      sticky.stickNow();
      setLines([]);
      api.runTask(id).then(() => refreshAll()).catch(() => {});
    } else if (action.kind === "retry") {
      sticky.stickNow();
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
      sticky.stickNow();
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
        sticky={sticky}
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
      behavior={keyboardAvoidingBehavior}
      keyboardVerticalOffset={keyboardOffset}
    >
      <Stack.Screen
        options={{
          title: "",
          headerRight: dispatchedWorker
            ? undefined
            : () => (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 18 }}>
                  {task.archived ? (
                    <Pressable accessibilityRole="button" accessibilityLabel="取消归档" onPress={onUnarchive} hitSlop={12}>
                      <Ionicons name="archive" size={20} color={theme.accent} />
                    </Pressable>
                  ) : canArchive(status) ? (
                    <Pressable accessibilityRole="button" accessibilityLabel="归档任务" onPress={onArchive} hitSlop={12}>
                      <Ionicons name="archive-outline" size={20} color={theme.muted} />
                    </Pressable>
                  ) : null}
                  <Pressable accessibilityRole="button" accessibilityLabel="删除任务" onPress={confirmDelete} hitSlop={12}>
                    <Ionicons name="trash-outline" size={20} color={theme.danger} />
                  </Pressable>
                </View>
              ),
        }}
      />

      {/* Frozen header: status + stage + title + metadata (stays put while conversation scrolls) */}
      <TaskDetailHeader
        task={task}
        action={action}
        parentTeamTitle={dispatchedWorker ? parentTeam?.title ?? "" : null}
        onPrimary={onPrimary}
        onStop={onStop}
        onOpenTeam={() => router.push(`/task/${task.parentId}`)}
      />

      {/* 这一层只为量「可视区此刻在屏幕的哪一块」—— ScrollView 自己没公开
          measureInWindow，套一层普通 View 是跨平台最省事的量法（见 lib/scroll.ts）。 */}
      <View ref={sticky.viewportRef} style={{ flex: 1 }}>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 24 }}
        onScroll={sticky.onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={sticky.onContentSizeChange}
        onLayout={sticky.onLayout}
        // 读长会话时往下一拖就把键盘收掉，不用先去点一下别处。
        keyboardDismissMode="interactive"
        // 键盘开着时点问题卡里的建议/发送要一下就中，别把第一下吃成「收键盘」。
        keyboardShouldPersistTaps="handled"
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
        {task.question ? (
          <QuestionCard task={task} cardRef={questionRef} onFocusInput={revealQuestion} />
        ) : null}

        {lines.length === 0 && !task.question ? (
          <Text style={{ color: theme.faint, fontSize: 13, textAlign: "center", paddingTop: 20 }}>
            还没有输出 — 点上方「{action.label}」开始
          </Text>
        ) : null}

        {/* 审查/验证：轮次、结论、报告、截图，以及「再派一轮」。放在最后 —— 页面初次
            打开会自动滚到底，指挥用得最多的那个入口正好落在眼皮底下。 */}
        <TaskReviewPanel task={task} parentTask={parentTeam} refreshToken={refreshTick} />
      </ScrollView>
      </View>

      {/* Reply composer：归档只读→提示条；否则待发列表(定时发送)+技能候选+输入行。
          整块在 components/ReplyComposer.tsx —— 这个文件贴着单文件行数上限。 */}
      <ReplyComposer
        task={task}
        input={input}
        pending={pending}
        queueing={queueing}
        frozen={frozen}
        dispatchedWorker={dispatchedWorker}
        bottomInset={insets.bottom}
        onInputChange={setInput}
        onSend={(sendAt) => void send(sendAt)}
        onPendingRemoved={(messageId) => setPending((ps) => ps.filter((m) => m.id !== messageId))}
        onPendingReload={loadPending}
      />
    </KeyboardAvoidingView>
  );
}
