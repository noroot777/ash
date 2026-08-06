// 停在「自动验证」这一站上的两个按钮：**再验一轮** 和 **人工强制通过**。
//
// 为什么长在这儿：验证站是会停下来等的锚点，它停下来的三种方式（验证器判了不过、
// 自动复审轮数用尽、那一轮跑完谁也没给结论）在界面上是同一副样子——线路图上标着
// 「停在这儿」，底下一句「等你处理后再手动派一轮」，然后没有任何一个按钮能处理。
// 用户能做的只有换到审查页去找「验一轮」，而验证器不认账的东西多验几轮它还是不认，
// 于是这条线就真的走不动了。人工关口那两个真按钮早就长在它自己那一站底下，验证站
// 没道理是个只能看的站。
//
// 两条口径跟人工关口那边一模一样，别在这儿另开一份：
// ① **判据是游标**（isCursorStop），不是 stage —— 调用方保证「线确实停在这一站」；
// ② **确认框照实说按完会发生什么**。强制通过不只是把 stage 改成 verified：后端会接着
//    把这一站之后那一段跑掉，线上画着「合并并清理」时这一按就是不可逆的合并（图一那条
//    线正是这个形状：干活 → 预览 → 等我点头 → 自动验证 → 合并并清理）。措辞含糊等于
//    把最后一道说明拆了。
//
// 「人工强制通过」拆成独立导出（`ForcePassVerifyButton`），因为它有**两个表面**：线路图
// 上那一站底下，和验证页顶上那排动作。同一件不可逆的事在两处必须是同一个确认框、同一
// 条判据；两处各写一份，迟早只有一处会跟着后端改。「再验一轮」不必拆——验证页本来就有
// 一颗更全的「验一轮」（能挑执行器），这里那颗是给「不想挑、就照原样再来一次」的人。
import { useState } from "react";
import type { Task } from "@harness/shared";
import type { WorkflowDef, WorkflowStep } from "@harness/shared/workflow";
import { STEP_LABELS } from "@harness/shared/workflow";
import { nextAnchor, segmentAfter } from "@harness/shared/workflow-policy";
import { MagnifyingGlass, SealCheck, SpinnerGap } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

/** 签完字之后这条线会做的事，按顺序念一遍。 */
function forcePassMessage(def: WorkflowDef, stationId: string, task: Task): string {
  const segment = segmentAfter(def, stationId);
  const accept = segment.find((step): step is Extract<WorkflowStep, { kind: "accept" }> => step.kind === "accept");
  const next = nextAnchor(def, stationId);
  const head = "这一按是由你替验证器签字：这一轮的报告和证据原样留着，不会被改动。";

  const parts: string[] = [];
  // 段内站按线上的顺序念。「合并并清理」单独展开——它是唯一不可逆的那一站。
  const plain = segment.filter((step) => step.kind !== "accept").map((step) => `「${STEP_LABELS[step.kind]}」`);
  if (plain.length) parts.push(`接着会跑${plain.join("、")}`);
  if (accept) {
    const target = task.worktreeBase || "项目当前分支";
    const branch = task.useWorktree ? "任务分支" : "当前工作区的改动";
    const merge = accept.p.strategy === "tag"
      ? `不合并，只在${branch}头上打一个 harness-accepted 标签（${target} 一动不动）`
      : accept.p.strategy === "squash"
        ? `把${branch} squash 成一个提交合并回 ${target}`
        : `把${branch}合并回 ${target}`;
    const clean = !task.useWorktree || accept.p.clean === "none"
      ? ""
      : accept.p.clean === "worktree"
        ? "，随后清理 worktree（分支保留）"
        : accept.p.clean === "all" && accept.p.strategy !== "safe"
          ? "，随后清理 worktree，分支保留（这一档 git 不认为它已合并，不强删）"
          : "，随后清理 worktree 与分支";
    parts.push(`然后走到「${STEP_LABELS.accept}」：${merge}${clean}。这一步不可逆`);
  }
  if (next) {
    parts.push(next.kind === "human"
      ? `再停在「${STEP_LABELS.human}」等你点头`
      : `再走到「${STEP_LABELS[next.kind]}」`);
  } else if (!accept) {
    parts.push("这条线就走到头了");
  }
  return `${head}${parts.length ? `签完之后：${parts.join("；")}。` : "签完之后这条线就走到头了。"}`;
}

/** 这一按会不会连带做掉不可逆的事（决定确认框是不是红的）。 */
function forcePassIsDestructive(def: WorkflowDef, stationId: string): boolean {
  return segmentAfter(def, stationId).some((step) => step.kind === "accept");
}

export function ForcePassVerifyButton({
  task,
  def,
  stationId,
  className,
  disabled,
  onBusy,
  onTaskUpdated,
  notify,
}: {
  task: Task;
  def: WorkflowDef;
  stationId: string;
  /** 宿主表面自己那套按钮长相；红/主色那一档由这里按「会不会真合并」决定。 */
  className?: string;
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  // 还在跑的时候后端会 409（那一轮可能下一秒就有结论）。按钮先灰掉，别让人按下去
  // 换一句红字回来。
  const inFlight = task.status === "running" || task.status === "queued";
  const destructive = forcePassIsDestructive(def, stationId);

  const forcePass = async () => {
    setAsking(false);
    setBusy(true);
    onBusy?.(true);
    try {
      const result = await api.forcePassVerify(task.id);
      onTaskUpdated(await api.task(task.id));
      // 签字落下了但那一段没跑完，是两件事，分开说——只报一句「已放行」，用户下次
      // 知道合并没做成就是在别处出事的时候了。
      notify(result.advanceError
        ? `已签字放行，但往下走时出错了：${result.advanceError}`
        : result.stage === "accepted" || result.stage === "merged"
          ? "已强制通过并走完这条线"
          : "已强制通过，这条线继续往下走");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={[className, destructive ? "is-danger" : "is-primary"].filter(Boolean).join(" ")}
        disabled={inFlight || busy || disabled}
        onClick={() => setAsking(true)}
      >
        {busy ? <SpinnerGap size={13} className="is-spinning" /> : <SealCheck size={13} weight="fill" />}
        <span>{busy ? "放行中" : "人工强制通过"}</span>
      </button>
      {asking && (
        <ConfirmDialog
          title="人工强制通过这一站验证？"
          message={forcePassMessage(def, stationId, task)}
          confirmLabel="强制通过"
          danger={destructive}
          busy={busy}
          onConfirm={() => void forcePass()}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  );
}

export function VerifyGateControls({
  task,
  def,
  stationId,
  onTaskUpdated,
  notify,
}: {
  task: Task;
  def: WorkflowDef;
  stationId: string;
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const [busy, setBusy] = useState<"force" | "redo" | null>(null);
  const inFlight = task.status === "running" || task.status === "queued";

  const redo = async () => {
    setBusy("redo");
    try {
      // 不带任何 override：后端按**这一站**写的执行器与模型去验，跟自动那轮一模一样。
      // 要换一双眼睛看同一份产物，去验证页那格挑执行器。
      const { round } = await api.dispatchTaskReview(task.id, {});
      onTaskUpdated(await api.task(task.id));
      notify(`已开始第 ${round} 轮验证`);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="wf-verify-actions">
        <button type="button" disabled={inFlight || !!busy} onClick={() => void redo()}>
          {busy === "redo" ? <SpinnerGap size={13} className="is-spinning" /> : <MagnifyingGlass size={13} />}
          <span>{busy === "redo" ? "启动中" : inFlight ? "执行中" : "再验一轮"}</span>
        </button>
        <ForcePassVerifyButton
          task={task}
          def={def}
          stationId={stationId}
          disabled={busy === "redo"}
          onBusy={(on) => setBusy(on ? "force" : null)}
          onTaskUpdated={onTaskUpdated}
          notify={notify}
        />
      </div>
      <p className="wf-vnote">
        {inFlight
          ? "这一轮验证还在跑，跑完才能再验或强制通过。"
          : "验证器不认账时，可以由你签字放行；这一轮的报告与证据会原样保留。"}
      </p>
    </>
  );
}
