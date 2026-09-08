// 任务详情里的审查/验证区块：看历轮结论与报告、点开截图、再派一轮。
//
// 手机端一律轮询（用户明确要求不引 SSE）：这里只在**这一轮还在跑**或任务本身在跑时
// 开定时器，其余时候安静等下拉刷新（refreshToken）或回前台时补一次 —— 一个已经收尾
// 的任务不该每 8 秒问一次服务端「有变化吗」。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  AgentExecutorProfile,
  AgentType,
  LlmProvider,
  TaskListItem,
  TaskReviewInfo,
  TaskReviewRound,
} from "@ash/shared";
import { api } from "@/lib/api";
import { refreshAll } from "@/lib/data";
import { fonts, radius, useTheme, type Theme } from "@/lib/theme";
import { MarkdownText } from "@/components/MarkdownText";
import { ExecutionConfig, type ExecutorSelection } from "@/components/ExecutionConfig";

const REVIEW_POLL_MS = 8000;
// 一轮审查「还没收尾」的状态集合。就地验证没有独立任务行，服务端把这一格当成
// 「这一轮跑完没有」来填（running / done），与历史的独立审查任务同一套判据。
const REVIEW_IN_FLIGHT = new Set(["backlog", "queued", "running", "paused"]);

type ReviewSelection = ExecutorSelection & {
  model: string;
  reasoningEffort: string;
};

export function TaskReviewPanel({
  task,
  parentTask,
  refreshToken = 0,
}: {
  task: TaskListItem;
  /** 团队执行者的调度台任务：审查执行器默认跟团队配的 reviewer 走。 */
  parentTask?: TaskListItem | null;
  /** 变一次 = 外面下拉刷新了一次，这里跟着补拉。 */
  refreshToken?: number;
}) {
  const theme = useTheme();
  const [info, setInfo] = useState<TaskReviewInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  // 「我刚点过派发」记的是轮次号：等这一轮出现在 rounds 里才解锁。轮询有间隔，只靠
  // rounds 判断会在这中间露出一个可再点一次的按钮。
  const [dispatchedRound, setDispatchedRound] = useState<number | null>(null);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [profilesReady, setProfilesReady] = useState(false);
  const [selection, setSelection] = useState<ReviewSelection>(() => reviewDefaults(task, parentTask ?? null));

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setInfo(await api.taskReview(task.id));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [task.id]);

  // 只认 id 换没换。任务对象每 5 秒轮询回来都是新引用，把它挂进依赖会让用户刚挑好的
  // 审查执行器、刚展开的配置面板每隔几秒被抹一次。parentTask 也只看 id —— 深链直接
  // 进来时它可能晚一步才从 store 里出现，那一次要把默认值换成团队配的 reviewer。
  const parentId = parentTask?.id ?? null;
  useEffect(() => {
    setInfo(null);
    setError(null);
    setConfigOpen(false);
    setDispatchedRound(null);
    setSelection(reviewDefaults(task, parentTask ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上：只在换任务时重置
  }, [task.id, parentId]);

  // 首次进入/换任务：带加载态整取一次（load 的身份跟着 task.id 变）。
  useEffect(() => {
    void load();
  }, [load]);

  const rounds = info?.rounds ?? [];
  const latest = rounds.at(-1);
  const activeRound = rounds.find((round) => REVIEW_IN_FLIGHT.has(round.reviewTaskStatus));
  // 有一轮在跑、任务本身在跑，或刚派完还没看见新轮次 —— 这三种情况下界面会变，才轮询。
  const live = !!activeRound
    || !!task.verifyRound
    || dispatchedRound !== null
    || task.status === "running"
    || task.status === "queued";

  // 外面下拉刷新了一次，跟着静默补一次。0 是初始值，不算一次刷新。
  useEffect(() => {
    if (!refreshToken) return;
    void load(true);
  }, [refreshToken, load]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void load(true);
    });
    if (!live) return () => sub.remove();
    const timer = setInterval(() => void load(true), REVIEW_POLL_MS);
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [live, load]);

  useEffect(() => {
    if (dispatchedRound !== null && rounds.some((round) => round.round === dispatchedRound)) {
      setDispatchedRound(null);
    }
  }, [dispatchedRound, info]);

  // 执行器清单只在真要挑的时候才拉：手机上大多数人点的是「按默认再派一轮」。
  useEffect(() => {
    if (!configOpen || profilesReady) return;
    let alive = true;
    Promise.all([api.agents().catch(() => []), api.llmProviders().catch(() => [])])
      .then(([nextProfiles, nextProviders]) => {
        if (!alive) return;
        setProfiles(nextProfiles);
        setProviders(nextProviders);
      })
      .finally(() => {
        if (alive) setProfilesReady(true);
      });
    return () => {
      alive = false;
    };
  }, [configOpen, profilesReady]);

  // 已注册 profile 的类型即候选类型（与 web 的审查派发同一条口径）。当前选中的类型没
  // 有 profile 时，ExecutionConfig 自己会补一条标注状态的条目，不会选不着。
  const typeOptions = useMemo(
    () => [...new Set(profiles.map((profile) => profile.type))] as AgentType[],
    [profiles],
  );

  // 结构性不可审（不是 single / 自己就是审查任务 / 已归档）：不给派发入口，历轮记录
  // 仍然照看 —— 归档任务的审查报告是它这辈子最有价值的那一部分。一轮都没有就整块不
  // 出现（读完再判，免得先闪一下再消失）。
  const structural = structuralBlockReason(task);
  const busy = transientBlockReason(task, !!activeRound || dispatchedRound !== null);
  const nextRound = rounds.reduce((highest, round) => Math.max(highest, round.round), 0) + 1;
  const canSend = !structural && !busy && !dispatching;
  // 「未通过」是唯一需要用户立刻做点什么的结论，只有它把整块染成警示色。没审查过只是
  // 还没开始，不是出事了。
  const prominent = latest?.conclusion === "verify_failed" && !activeRound;

  if (structural && rounds.length === 0) return null;

  const dispatch = async () => {
    if (!canSend) return;
    setDispatching(true);
    try {
      const { round } = await api.dispatchTaskReview(task.id, {
        agentType: selection.agentType,
        executorId: selection.executorId,
        model: selection.model.trim() || null,
        reasoningEffort: selection.reasoningEffort || null,
      });
      setDispatchedRound(round);
      setConfigOpen(false);
      // 任务本身也会变（stage → 验证中），顺手刷全局，头部和列表跟着走。
      await Promise.all([load(true), refreshAll().catch(() => {})]);
      Alert.alert("验证已开始", `第 ${round} 轮就在这个任务的工作目录里跑。`);
    } catch (reason) {
      Alert.alert("派发失败", reason instanceof Error ? reason.message : String(reason));
      await load(true);
    } finally {
      setDispatching(false);
    }
  };

  return (
    <View
      style={{
        gap: 11,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: prominent ? `${theme.danger}88` : theme.line,
        backgroundColor: prominent ? `${theme.danger}10` : theme.panel,
        padding: 12,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <Ionicons
          name={latest?.conclusion === "verified" ? "shield-checkmark" : "shield-outline"}
          size={18}
          color={reviewColor(latest, theme)}
        />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: theme.ink, fontSize: 16, fontFamily: fonts.displayMd }}>
            {rounds.length ? `验证记录 · ${rounds.length} 轮` : "验证记录"}
          </Text>
          <Text style={{ color: theme.muted, fontSize: 12, lineHeight: 17, fontFamily: fonts.body }}>
            {reviewSummary(info, loading, error, activeRound)}
          </Text>
        </View>
      </View>

      {error ? <Notice text={`读取失败：${error}`} tone="danger" /> : null}

      {structural ? null : (
        <View style={{ gap: 9 }}>
          {busy ? <Notice text={busy} tone="muted" /> : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={rounds.length ? "再派一轮验证" : "派一轮验证"}
              disabled={!canSend}
              onPress={() => void dispatch()}
              style={{
                flex: 1,
                minHeight: 42,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
                borderRadius: radius.md,
                backgroundColor: canSend ? theme.accent : theme.raised,
                opacity: canSend ? 1 : 0.6,
              }}
            >
              {dispatching ? (
                <ActivityIndicator size="small" color={canSend ? theme.accentFg : theme.faint} />
              ) : (
                <Ionicons name="shield-checkmark-outline" size={15} color={canSend ? theme.accentFg : theme.faint} />
              )}
              <Text style={{ color: canSend ? theme.accentFg : theme.faint, fontSize: 13, fontFamily: fonts.bodySemi }}>
                {dispatching
                  ? "派发中…"
                  : busy
                    ? "暂不能验证"
                    : rounds.length
                      ? `再验一轮（第 ${nextRound} 轮）`
                      : "开始验证"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="选择验证执行器"
              disabled={!canSend}
              onPress={() => setConfigOpen((open) => !open)}
              style={{
                width: 44,
                height: 42,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: theme.line,
                opacity: canSend ? 1 : 0.45,
              }}
            >
              <Ionicons name={configOpen ? "chevron-up" : "options-outline"} size={17} color={theme.muted} />
            </Pressable>
          </View>

          {configOpen ? (
            <View style={{ gap: 7 }}>
              <ExecutionConfig
                role="验证执行器"
                icon="shield-checkmark-outline"
                selection={{ agentType: selection.agentType, executorId: selection.executorId }}
                types={typeOptions}
                profiles={profiles}
                providers={providers}
                model={selection.model}
                reasoningEffort={selection.reasoningEffort}
                onSelectionChange={(next) => setSelection((current) => ({ ...current, ...next }))}
                onModelChange={(model) => setSelection((current) => ({ ...current, model }))}
                onReasoningEffortChange={(reasoningEffort) =>
                  setSelection((current) => ({ ...current, reasoningEffort }))
                }
              />
              <Text style={{ color: theme.faint, fontSize: 10.5, lineHeight: 15, fontFamily: fonts.body }}>
                {profilesReady
                  ? "留空则跟随执行器自己的默认；换执行器就是换一双眼睛来验同一份产物。"
                  : "正在读取已注册执行器…"}
              </Text>
            </View>
          ) : null}
        </View>
      )}

      {loading ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ActivityIndicator size="small" color={theme.faint} />
          <Text style={{ color: theme.faint, fontSize: 12, fontFamily: fonts.body }}>正在读取验证记录…</Text>
        </View>
      ) : null}

      {rounds.map((round) => (
        <ReviewRoundCard key={`${round.round}-${round.where}`} taskId={task.id} round={round} />
      ))}
    </View>
  );
}

function ReviewRoundCard({ taskId, round }: { taskId: string; round: TaskReviewRound }) {
  const theme = useTheme();
  // 出了结论的轮次一律默认折叠（与 web 同一条规则，用户 2026-09-02 拍板）：结论在卡头
  // 上就看得见，正文按需展开。还在跑的保持展开，让人跟着看进度。
  const [open, setOpen] = useState(round.conclusion === null);
  useEffect(() => setOpen(round.conclusion === null), [round.conclusion, round.round]);
  const state = roundState(round, theme);
  return (
    <View
      style={{
        overflow: "hidden",
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: theme.line,
        backgroundColor: theme.bg,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`第 ${round.round} 轮 ${state.label}`}
        onPress={() => setOpen((value) => !value)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 44,
          paddingHorizontal: 11,
        }}
      >
        <Text style={{ flex: 1, color: theme.ink, fontSize: 13, fontFamily: fonts.bodySemi }}>
          第 {round.round} 轮
        </Text>
        {round.screenshots.length ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
            <Ionicons name="image-outline" size={12} color={theme.faint} />
            <Text style={{ color: theme.faint, fontSize: 10, fontFamily: fonts.mono }}>{round.screenshots.length}</Text>
          </View>
        ) : null}
        <Text style={{ color: state.color, fontSize: 11, fontFamily: fonts.monoMed }}>{state.label}</Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={14} color={theme.faint} />
      </Pressable>
      {open ? (
        <View style={{ gap: 10, padding: 11, borderTopWidth: 1, borderTopColor: theme.line }}>
          <Text style={{ color: theme.faint, fontSize: 10, fontFamily: fonts.mono }}>
            {round.where === "inline" ? "就地验证 · 跑在任务自己的工作目录" : `独立审查任务 ${round.reviewTaskId ?? "—"}`}
          </Text>
          {round.reportMarkdown.trim() ? (
            <MarkdownText value={round.reportMarkdown} style={{ color: theme.muted, fontSize: 13, lineHeight: 19 }} />
          ) : (
            <Text style={{ color: theme.faint, fontSize: 12, fontFamily: fonts.body }}>
              {round.conclusion === null ? "报告要等这一轮收尾才写。" : "这一轮没有留下报告正文。"}
            </Text>
          )}
          {round.screenshots.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {round.screenshots.map((name) => (
                <ReviewScreenshot key={name} taskId={taskId} round={round.round} name={name} />
              ))}
            </ScrollView>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ReviewScreenshot({ taskId, round, name }: { taskId: string; round: number; name: string }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const source = api.taskReviewFileSource(taskId, round, name);
  return (
    <>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`查看截图 ${name}`}
        onPress={() => setOpen(true)}
        style={{ width: 124, gap: 5 }}
      >
        <Image
          source={source}
          resizeMode="cover"
          style={{
            width: 124,
            height: 78,
            borderRadius: radius.sm,
            borderWidth: 1,
            borderColor: theme.line,
            backgroundColor: theme.raised,
          }}
        />
        <Text style={{ color: theme.faint, fontSize: 10, fontFamily: fonts.mono }} numberOfLines={1}>
          {name}
        </Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View
          style={{
            flex: 1,
            backgroundColor: "#000000DD",
            paddingHorizontal: 14,
            paddingTop: insets.top,
            paddingBottom: insets.bottom + 14,
            justifyContent: "center",
          }}
        >
          {/* 关闭键原来钉在 top:48：灵动岛机型（状态栏 59）会被岛压住一角，SE（20）
              又飘在半空。跟着 insets 走。 */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭截图"
            onPress={() => setOpen(false)}
            hitSlop={8}
            style={{ position: "absolute", top: insets.top + 8, right: 14, zIndex: 1, padding: 10 }}
          >
            <Ionicons name="close" size={28} color="#FFFFFF" />
          </Pressable>
          <Image source={source} resizeMode="contain" style={{ width: "100%", height: "82%" }} />
          <Text style={{ color: "#FFFFFFAA", fontSize: 12, fontFamily: fonts.mono, textAlign: "center" }} numberOfLines={2}>
            {name}
          </Text>
        </View>
      </Modal>
    </>
  );
}

function Notice({ text, tone }: { text: string; tone: "muted" | "danger" }) {
  const theme = useTheme();
  const danger = tone === "danger";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 7,
        borderRadius: radius.sm,
        backgroundColor: danger ? `${theme.danger}12` : theme.raised,
        padding: 9,
      }}
    >
      <Ionicons name={danger ? "warning" : "information-circle-outline"} size={14} color={danger ? theme.danger : theme.faint} />
      <Text style={{ flex: 1, color: danger ? theme.danger : theme.muted, fontSize: 11, lineHeight: 16, fontFamily: fonts.body }}>
        {text}
      </Text>
    </View>
  );
}

function reviewDefaults(task: TaskListItem, parent: TaskListItem | null): ReviewSelection {
  if (parent?.mode === "team" && parent.team) {
    return {
      agentType: parent.team.reviewerAgentType ?? parent.team.worker,
      executorId: parent.team.reviewerExecutorId ?? null,
      model: parent.team.reviewerModel ?? "",
      reasoningEffort: parent.team.reviewerReasoningEffort ?? "",
    };
  }
  return {
    agentType: task.agentType ?? "claude",
    executorId: task.executorId ?? null,
    model: task.model ?? "",
    reasoningEffort: task.reasoningEffort ?? "",
  };
}

/** 这个任务这辈子都验不了的理由。有理由 = 连派发入口都不出现。 */
function structuralBlockReason(task: TaskListItem): string | null {
  if (task.mode !== "single") return "只有单飞任务与团队执行者能验证。";
  if (task.reviewOf) return "审查任务自身不能再验。";
  if (task.archived) return "任务已归档（只读）。";
  return null;
}

/**
 * 此刻派不动、但等一等就能派的理由。判据与 server/src/review.ts 的 startVerifyRound
 * 同源 —— 前端不同步这道门禁，暂停待答的任务上就会出现一个可点但必失败的按钮。
 */
function transientBlockReason(task: TaskListItem, active: boolean): string | null {
  if (task.status === "running" || task.status === "queued") return "任务仍在运行或排队，结束后才能验证。";
  if (task.question) return "任务正等着你答复，处理完才能验证。";
  if (task.resumePrompt) return "任务停在检查点等续跑，继续完才能验证。";
  if (active || task.verifyRound) return "已经有一轮验证在跑，等它出结论再派下一轮。";
  return null;
}

function reviewSummary(
  info: TaskReviewInfo | null,
  loading: boolean,
  error: string | null,
  activeRound?: TaskReviewRound,
): string {
  if (loading) return "正在读取";
  if (error) return "读取验证记录失败";
  if (activeRound) return `第 ${activeRound.round} 轮正在跑`;
  const rounds = info?.rounds ?? [];
  const latest = rounds.at(-1);
  if (!latest) return info?.reviewRequested ? "已请求自动验证，等首轮结果" : "还没验过";
  if (latest.conclusion === "verified") return "最近一轮已通过";
  if (latest.conclusion === "verify_failed") return "最近一轮没通过 —— 改完再验，或换个执行器重验一遍";
  return "最近一轮没给出结论";
}

function roundState(round: TaskReviewRound, theme: Theme): { label: string; color: string } {
  if (round.conclusion === "verified") return { label: "已通过", color: theme.ok };
  if (round.conclusion === "verify_failed") return { label: "未通过", color: theme.danger };
  if (REVIEW_IN_FLIGHT.has(round.reviewTaskStatus)) return { label: "进行中", color: theme.accent };
  return { label: "无结论", color: theme.faint };
}

function reviewColor(latest: TaskReviewRound | undefined, theme: Theme): string {
  if (latest?.conclusion === "verified") return theme.ok;
  if (latest?.conclusion === "verify_failed") return theme.danger;
  return theme.muted;
}
