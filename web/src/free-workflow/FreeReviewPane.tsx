// 右侧「审查」格（自由工作流）：最上面一句结论配一个主动作，其余收进「更多」（只剩一项时
// 直接摆出来）；下面是驳回卡（有待你裁定的驳回时）、各轮一行一条的审查记录、合并结果审查。
// 点一行就在它底下铺开报告。派审、预约、调整预约走的是回复框那颗键同一张对话框
// （FreeReviewDialog），叫法也取自同一份判据（freeReviewCopy 的 freeReviewView）。
import { useEffect, useMemo, useRef, useState } from "react";
import type { FreeReviewRound, FreeReviewRun, Task } from "@ash/shared";
import { InspActions, InspConclusion, InspMainButton, InspMore, type InspMainAction, type InspMoreItem, type InspTone } from "../inspector/InspHead.tsx";
import { useInspectorRequest } from "../inspector/nav.tsx";
import { InspNone, InspRecord, InspSec } from "../inspector/parts.tsx";
import { api } from "../lib/api.ts";
import { ReviewNote } from "../review/ReviewNote.tsx";
import { FreeReviewDialog } from "./FreeReviewDialog.tsx";
import { FreeReviewDisputeCard } from "./FreeReviewDisputeCard.tsx";
import { useFreeReviewRepair } from "./FreeReviewRepairButton.tsx";
import { FreeReviewRoundBody } from "./FreeReviewRoundBody.tsx";
import { FreeReviewRoundsDialog } from "./FreeReviewRoundsDialog.tsx";
import { freeReviewView } from "./freeReviewCopy.ts";
import { deferOnly, durationText, reviewKey, reviewRoundLabel, reviewRoundTone } from "./freeReviewRounds.ts";
import { useFreeWorkflowState } from "./useFreeWorkflowState.ts";

interface Conclusion {
  tone: InspTone;
  text: string;
  main?: InspMainAction;
  more: InspMoreItem[];
}

interface Entry { run: FreeReviewRun; round: FreeReviewRound }

function entries(runs: FreeReviewRun[]): Entry[] {
  return runs
    .flatMap((run) => run.rounds.map((round) => ({ run, round })))
    .sort((a, b) => a.round.startedAt.localeCompare(b.round.startedAt));
}

export function FreeReviewPane({ task, onOpenReview, onOpenTask, notify }: {
  task: Task;
  onOpenReview?: () => void;
  onOpenTask?: (taskId: string) => void;
  notify?: (message: string) => void;
}) {
  const free = useFreeWorkflowState(task.id);
  const state = free.state;
  const rootRef = useRef<HTMLDivElement>(null);
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  // 打开时定下是哪一扇（同回复框那颗键）：审查在跑 = 调轮数，否则 = 派审/预约。
  const [dialog, setDialog] = useState<"rounds" | "review" | "post" | null>(null);
  const [postRepairBusy, setPostRepairBusy] = useState(false);

  const all = useMemo(() => entries(state?.reviews ?? []), [state]);
  const workspace = all.filter((entry) => entry.run.target?.kind !== "accepted_merge");
  const postMerge = all.filter((entry) => entry.run.target?.kind === "accepted_merge");
  const postRuns = state?.reviews.filter((run) => run.target?.kind === "accepted_merge") ?? [];
  const latestPost = postRuns[0];
  const latestPostRound = latestPost?.rounds.at(-1);
  const postRepairTaskId = latestPost?.target?.kind === "accepted_merge" ? latestPost.target.repairTaskId : null;
  const acceptedTarget = task.stage === "accepted" && task.acceptedTargetBranch && task.acceptedBaseCommit && task.acceptedMergeCommit
    ? { branch: task.acceptedTargetBranch, baseCommit: task.acceptedBaseCommit, mergeCommit: task.acceptedMergeCommit }
    : null;
  const view = freeReviewView(state, task);
  const { latestRun, reviewing, stoppedRun, taskBusy, waiting, reservationArmed, reservationMode, repairing, stale, disputedRound, disputedRun, waivedRound, debateRunning } = view;
  const taskReady = task.status !== "backlog";
  // 接力出去的任务在本机是历史存档，后端一律 409 —— 判据必须与回复框那颗键完全一样，
  // 否则同一个派审动作会出现「那边灰、这里能点（点了吃 409）」。
  const locked = task.stage === "accepted" || task.stage === "merged" || !!task.archived
    || task.handoff?.direction === "out";
  const repair = useFreeReviewRepair({
    taskId: task.id,
    run: stoppedRun,
    disabled: !stoppedRun || !taskReady || locked || waiting,
    onChanged: free.setState,
    notify: notify ?? (() => undefined),
  });

  // 审查结束时调轮数那扇随之作废（同回复框那颗键）。
  useEffect(() => {
    if (!reviewing) setDialog((open) => open === "rounds" ? null : open);
  }, [!!reviewing]);

  useEffect(() => {
    if (!scrollTo) return;
    rootRef.current?.querySelector(`[data-record="${CSS.escape(scrollTo)}"]`)?.scrollIntoView({ block: "nearest" });
    setScrollTo(null);
  }, [scrollTo, openKeys]);

  const reveal = (key: string) => {
    setOpenKeys((current) => new Set(current).add(key));
    setScrollTo(key);
  };
  const toggle = (key: string) => setOpenKeys((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  // 别处（会话流里那一行审查、工作流格里那一轮）点过来：展开那一轮。没指明哪条链时认最近那条。
  useInspectorRequest("review", (params) => {
    const round = typeof params.round === "number" ? params.round : null;
    const runId = typeof params.runId === "string" ? params.runId : null;
    const hit = [...all].reverse().find((entry) => (runId ? entry.run.id === runId : true) && (round == null || entry.round.round === round));
    if (hit) reveal(reviewKey(hit.run.id, hit.round.round));
  });

  if (free.loading && !state) return <div className="insp-pane"><InspConclusion tone="busy">正在读取审查记录…</InspConclusion></div>;
  if (free.error && !state) return <div className="insp-pane"><InspNone>{free.error}</InspNone></div>;

  const openWorkspace: InspMoreItem[] = onOpenReview ? [{ key: "workspace", label: "打开改动工作区", onSelect: onOpenReview }] : [];
  const canDispatch = !locked && !!notify;
  const dispatchDisabled = !taskReady || !notify || (!reviewing && waiting && !reservationMode);
  const dispatchLabel = reservationMode
    ? (reservationArmed ? "调整预约复审" : "预约复审")
    : stale ? "审查新改动" : workspace.length ? "再审一轮" : "派审查";
  const dispatch = (pri = false): InspMainAction => ({
    label: dispatchLabel,
    onClick: () => setDialog("review"),
    disabled: dispatchDisabled,
    pressed: reservationMode ? reservationArmed : undefined,
    pri,
    dialog: true,
  });
  const dispatchItem = (): InspMoreItem[] => canDispatch
    ? [{ key: "dispatch", label: dispatchLabel, onSelect: () => setDialog("review"), disabled: dispatchDisabled }]
    : [];

  const createPostRepair = async () => {
    if (!latestPost || postRepairBusy || !notify || !onOpenTask) return;
    setPostRepairBusy(true);
    try {
      const created = await api.createPostMergeRepairTask(task.id, latestPost.id);
      await free.reload(true);
      notify(`已创建独立修复任务「${created.title}」`);
      onOpenTask(created.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "修复任务创建失败");
    } finally {
      setPostRepairBusy(false);
    }
  };

  const conclude = (): Conclusion => {
    if (acceptedTarget) {
      const again = (): InspMainAction => ({ label: latestPost ? "再审一次" : "开始审查", onClick: () => setDialog("post"), disabled: !notify, dialog: true });
      const see: InspMoreItem[] = latestPost && latestPostRound
        ? [{ key: "see", label: latestPost.status === "reviewing" ? "查看审查进度" : "查看审查结果", onSelect: () => reveal(reviewKey(latestPost.id, latestPostRound.round)) }]
        : [];
      if (!latestPost) return { tone: "ok", text: "已合并，合并结果还没审过", main: again(), more: openWorkspace };
      if (latestPost.status === "reviewing") return { tone: "busy", text: "合并结果审查中", more: [...see, ...openWorkspace] };
      if (latestPost.status === "passed") return { tone: "ok", text: "合并结果已通过", main: again(), more: [...see, ...openWorkspace] };
      if (latestPost.status === "failed") return { tone: "bad", text: "合并结果审查异常停止", main: again(), more: [...see, ...openWorkspace] };
      const fix: InspMainAction | undefined = postRepairTaskId && onOpenTask
        ? { label: "打开修复任务", onClick: () => onOpenTask(postRepairTaskId) }
        : onOpenTask ? { label: postRepairBusy ? "创建中…" : "创建修复任务", onClick: () => void createPostRepair(), pri: true, disabled: postRepairBusy } : undefined;
      return {
        tone: "bad",
        text: "合并结果未通过",
        main: fix ?? again(),
        more: [...see, ...(fix ? [{ key: "again", label: "再审一次", onSelect: () => setDialog("post"), disabled: !notify }] : []), ...openWorkspace],
      };
    }
    if (reviewing) {
      return {
        tone: "busy",
        text: `第 ${reviewing.currentRound} 轮审查中`,
        main: !locked && notify ? { label: "调整审查轮数", onClick: () => setDialog("rounds"), disabled: !taskReady, dialog: true } : undefined,
        more: openWorkspace,
      };
    }
    if (disputedRound) {
      // 裁定的几个动作都在下面那张卡上；顶上不再摆一颗，免得同一件事两处各说一半。
      return {
        tone: "hold",
        text: `第 ${disputedRound.round} 轮未通过 · ${deferOnly(disputedRound) ? "执行者说有几条越界" : "执行者不认"}，${debateRunning ? "双方辩论中" : "等你裁定"}`,
        more: [...dispatchItem(), ...openWorkspace],
      };
    }
    if (waivedRound) {
      // 裁定完不是终点：执行者在提出驳回/转出之前，多半已经把「认可且在本任务边界内」的那几
      // 条改掉了，那部分代码一轮都没审过。所以代码确实变过（stale）时把下一步摆成主动作。
      // freshness 为 unknown 时无从判断执行者改没改，凭空劝人再审一轮可能是白烧一轮。
      const settled = waivedRound.dispute?.resolution === "deferred" ? "越界的几条已转为独立任务" : "这条意见作废";
      return {
        tone: stale ? "stale" : "ok",
        text: `第 ${waivedRound.round} 轮${settled}${stale ? "，之后改的代码还没审过" : ""}`,
        main: canDispatch ? dispatch(stale) : undefined,
        more: openWorkspace,
      };
    }
    if (repairing) {
      return {
        tone: "bad",
        text: `第 ${latestRun?.currentRound ?? 1} 轮未通过 · 任务修改中${view.autoRereview ? "，改完自动复审" : ""}`,
        main: canDispatch ? dispatch() : undefined,
        more: openWorkspace,
      };
    }
    if (stoppedRun) {
      const exhausted = stoppedRun.currentRound > stoppedRun.retryLimit;
      const text = `第 ${stoppedRun.currentRound} 轮未通过${stale ? "，之后代码有变化" : exhausted ? " · 自动复审已停止" : ""}`;
      if (stale) return { tone: "bad", text, main: canDispatch ? dispatch(true) : undefined, more: openWorkspace };
      // 「按意见修复」只在结论确定对得上当前代码、任务也闲着时出：后端 manualRepairBlocker 同样挡着。
      if (!taskBusy && view.freshness === "fresh" && canDispatch && !reservationMode) {
        return {
          tone: "bad",
          text,
          main: { label: repair.busy ? "正在发起修复" : "按意见修复", onClick: () => void repair.repair(), pri: true, disabled: repair.busy || !taskReady || waiting },
          more: [...dispatchItem(), ...openWorkspace],
        };
      }
      return { tone: "bad", text, main: canDispatch ? dispatch() : undefined, more: openWorkspace };
    }
    const last = workspace.at(-1);
    if (stale) return { tone: "stale", text: `第 ${last?.round.round ?? 1} 轮已通过，之后代码有变化`, main: canDispatch ? dispatch(true) : undefined, more: openWorkspace };
    if (last) {
      const label = reviewRoundLabel(last.round);
      const unsure = view.freshness === "unknown" && latestRun?.status === "passed";
      return {
        tone: last.round.conclusion === "verified" ? "ok" : "bad",
        text: `第 ${last.round.round} 轮${label}${unsure ? " · 不确定是否还对应当前代码" : ""}`,
        main: canDispatch ? dispatch() : undefined,
        more: openWorkspace,
      };
    }
    return {
      tone: "none",
      text: locked ? "验收前没有做过审查" : reservationMode ? "还没审过 · 任务还在动" : "还没审过",
      main: canDispatch ? dispatch() : undefined,
      more: openWorkspace,
    };
  };

  const now = conclude();
  const record = ({ run, round }: Entry, post = false) => {
    const key = reviewKey(run.id, round.round);
    const took = durationText(round.startedAt, round.endedAt);
    const title = post && run.target?.kind === "accepted_merge"
      ? `${run.target.branch}@${run.target.mergeCommit.slice(0, 8)}`
      : `第 ${round.round} 轮`;
    return (
      <InspRecord
        key={key}
        data-record={key}
        title={title}
        sub={[run.reviewerName, took].filter(Boolean).join(" · ")}
        status={reviewRoundLabel(round)}
        tone={reviewRoundTone(round)}
        open={openKeys.has(key)}
        onToggle={() => toggle(key)}
      >
        <FreeReviewRoundBody taskId={task.id} run={run} round={round} anchorRef={rootRef} />
      </InspRecord>
    );
  };

  return (
    <div className="insp-pane review-pane" aria-label="自由任务审查" ref={rootRef}>
      <section className="insp-head" aria-label={acceptedTarget ? "合并结果审查" : "审查结论"}>
        <InspConclusion tone={now.tone}>{now.text}</InspConclusion>
        <InspActions>
          {now.main && <InspMainButton action={now.main} />}
          <InspMore items={now.more} />
        </InspActions>
        {/* 预约还没变成 run，附言只躺在预约槽里；不摆出来的话，用户只能靠重新打开
            派审对话框才知道自己预约时写了什么。 */}
        {reservationArmed && state?.reviewReservation.note && (
          <ReviewNote text={state.reviewReservation.note} label="预约附言" />
        )}
      </section>

      {disputedRound && disputedRun && notify && (
        <FreeReviewDisputeCard
          // 一张卡 = 一条驳回：换成另一条（轮询、另一个窗口裁掉了这条）就整张重建，
          // 开着的确认框、写了一半的要点都跟着旧那条走掉，不留给新那条。
          key={`${task.id}:${disputedRun.id}:${disputedRound.round}`}
          taskId={task.id}
          run={disputedRun}
          round={disputedRound}
          disabled={locked || taskBusy || !!reviewing}
          onChanged={free.setState}
          notify={notify}
          // 卡上只有执行者的说法；审查者那一半在报告里，就地展开那一轮。
          onOpenReport={() => reveal(reviewKey(disputedRun.id, disputedRound.round))}
        />
      )}

      <section aria-label="审查记录">
        <InspSec count={workspace.length || undefined}>审查记录</InspSec>
        {workspace.length
          ? <div className="insp-recs">{workspace.map((entry) => record(entry))}</div>
          : <InspNone>{locked ? "验收前没有审查记录。" : "还没有审查记录。"}</InspNone>}
      </section>

      {postMerge.length > 0 && (
        <section aria-label="合并结果审查记录">
          <InspSec count={postMerge.length}>合并结果审查</InspSec>
          <div className="insp-recs">{postMerge.map((entry) => record(entry, true))}</div>
        </section>
      )}

      {dialog === "rounds" && notify && reviewing && (
        <FreeReviewRoundsDialog taskId={task.id} run={reviewing} onChanged={free.setState} onClose={() => setDialog(null)} notify={notify} />
      )}
      {dialog === "review" && notify && (
        <FreeReviewDialog
          taskId={task.id}
          state={state}
          reservationMode={reservationMode}
          onChanged={free.setState}
          onClose={() => setDialog(null)}
          notify={notify}
        />
      )}
      {dialog === "post" && notify && acceptedTarget && (
        <FreeReviewDialog taskId={task.id} state={state} reservationMode={false} postMergeTarget={acceptedTarget} onChanged={free.setState} onClose={() => setDialog(null)} notify={notify} />
      )}
    </div>
  );
}
