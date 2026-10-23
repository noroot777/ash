import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, CheckCircle, FileText, SpinnerGap, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { AcceptGateView } from "@ash/shared/accept-gate";
import { ACCEPT_GATE_STATUS_LABELS, summarizeAcceptGate } from "@ash/shared/accept-gate";
import type { Task, TaskListItem } from "@ash/shared";
import { isFinalHumanGate } from "@ash/shared/workflow-policy";
import { api, type AcceptGateState } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

// 「验收前置命令」在验收台上的那张卡。它跟 PendingMergeCard 一样住在每个有验收动作的
// 表面上，自己判要不要出现（项目没设这条命令、也从没跑过 → 渲染 null）。
//
// 为什么非得有这张卡：这条命令要跑十几分钟（设它的人就是拿它跑全量回归的），而用户点
// 完验收之后页面上只有一个 toast。toast 一刷新就没了，于是「我点过了吗」「它跑到哪了」
// 「红在哪一条」全都没处看——那正是根 AGENTS.md「停止/暂停必须留下持久可见的状态」要
// 挡的那种坑。所以这张卡负责三件事：现在什么状态、日志在哪、红了之后的出路是什么。
export function AcceptGateCard({ task, notify, onIntent, disabled = false }: {
  task: TaskListItem | Task;
  notify: (message: string) => void;
  /** 红了之后的两条出路：重跑一次 / 这一次跳过。点下去走的仍是正常那道验收确认框。 */
  onIntent: (intent: "rerun" | "skip") => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<AcceptGateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const settled = task.stage === "accepted" || task.stage === "merged";

  const reload = useCallback(async () => {
    try {
      setState(await api.acceptGate(task.id));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [task.id]);

  useEffect(() => { void reload(); }, [reload]);
  // 服务端的权威信号只有这一条：起了、结束了、被取消了，都发 task.acceptGate。
  const connected = useServerEvents((event) => {
    if (event.type !== "task.acceptGate" || event.taskId !== task.id) return;
    void reload();
  });
  // 每次（重新）连上都对一次账：事件流没有历史回放，断线那几十秒里「跑完了」这条事件
  // 就没人接——这张卡会永远停在「正在跑」，而那正是它要消灭的那种幽灵状态。
  const linked = useRef(connected);
  useEffect(() => {
    const was = linked.current;
    linked.current = connected;
    if (connected && !was) void reload();
  }, [connected, reload]);
  // 「已经跑了 N 分 N 秒」要自己走：这中间服务端一个事件都不会发（命令还在跑），
  // 不走就会定在点下去那一刻的 0 秒上，看着像卡死了。
  const running = state?.running ?? null;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const latest = state?.latest ?? null;
  if (!state || (!state.command && !latest)) return null;
  // 停在中途那道「等我点头」上时，那一按是**放行**不是验收：不会碰门禁，所以别在这儿
  // 预告「这一按要先跑十几分钟」—— 那句话在那一站上是假的。跑过的记录仍然照常显示。
  if (!latest && !isFinalHumanGate(task.workflow, task.workflowAt)) return null;
  // 验收已经做完了就别再占一行：那时这张卡只会重复一句「上次通过了」。
  if (settled && !running) return null;

  const cancel = async () => {
    if (busy || !running) return;
    setBusy(true);
    try {
      await api.cancelAcceptGate(task.id);
      notify("已收掉验收前置命令；这次没有合并，重新点验收会从头跑一遍");
      await reload();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const openLog = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setLog(await api.acceptGateLog(task.id));
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const tone = running ? "is-running" : latest?.status === "passed" ? (latest.stale ? "" : "is-passed") : latest ? "is-failed" : "";
  return (
    <section className={`accept-gate-card ${tone}`} aria-label="验收前置命令">
      <header>
        <span>{running
          ? <SpinnerGap size={14} className="is-spinning" />
          : latest?.status === "passed"
            ? <CheckCircle size={14} weight="fill" />
            : latest
              ? <WarningCircle size={14} weight="fill" />
              : <FileText size={14} />}
        </span>
        <div>
          <b>{heading(running, latest, tick)}</b>
          <p>{detail(state, running, latest)}</p>
          {error && <p role="alert">状态读取失败：{error}</p>}
        </div>
        <button type="button" className="pending-merge-refresh" disabled={busy} onClick={() => void reload()}>
          <ArrowClockwise size={12} aria-hidden="true" />刷新
        </button>
      </header>
      {(running ?? latest)?.logTail && (
        <div className="accept-gate-log">
          <span>日志末尾</span>
          <pre>{(running ?? latest)!.logTail}</pre>
        </div>
      )}
      <div className="pending-merge-actions">
        {running ? (
          <button type="button" disabled={busy} onClick={() => void cancel()}>
            <XCircle size={13} />不等了，收掉它
          </button>
        ) : latest && latest.status !== "passed" && !settled ? (
          <>
            <button type="button" disabled={busy || disabled} onClick={() => onIntent("rerun")}>
              <ArrowClockwise size={13} />重跑一次
            </button>
            <button type="button" disabled={busy || disabled} onClick={() => onIntent("skip")}>
              这次跳过它，直接合并
            </button>
          </>
        ) : null}
        {(running ?? latest) && (
          <button type="button" disabled={busy} onClick={() => void openLog()}><FileText size={13} />看完整日志</button>
        )}
      </div>
      {log !== null && (
        <div className="accept-gate-log is-full">
          <span>完整日志（{(running ?? latest)?.logPath}）<button type="button" onClick={() => setLog(null)}>收起</button></span>
          <pre>{log || "（日志为空）"}</pre>
        </div>
      )}
    </section>
  );
}

function elapsed(from: string): string {
  const ms = Math.max(0, Date.now() - new Date(from).getTime());
  const total = Math.floor(ms / 1000);
  const min = Math.floor(total / 60);
  return min > 0 ? `${min} 分 ${total % 60} 秒` : `${total} 秒`;
}

function heading(running: AcceptGateView | null, latest: AcceptGateView | null, _tick: number): string {
  if (running) return `验收前置命令正在跑（已经 ${elapsed(running.startedAt)}）`;
  if (!latest) return "这个项目设了验收前置命令";
  if (latest.status === "passed") return latest.stale ? "上次通过的不是现在这棵树" : "验收前置命令已通过";
  return `验收前置命令${ACCEPT_GATE_STATUS_LABELS[latest.status]}`;
}

function detail(state: AcceptGateState, running: AcceptGateView | null, latest: AcceptGateView | null): string {
  if (running) {
    return `\`${running.command}\`（在 ${running.cwd}）。rc=0 才会继续合并：绿了这次验收会自动做完，`
      + "不用再点；红了会把日志交回这个任务去修，目标分支一个字节都不会动。";
  }
  if (!latest) return `点「验收通过」时会先在任务工作区里跑一遍 \`${state.command}\`，rc=0 才合并。`;
  if (latest.status === "passed") {
    return latest.stale
      ? `那次跑的是 ${latest.sourceCommit?.slice(0, 8) ?? "另一棵树"}，代码之后又改过了——再点验收会重跑一遍。`
      : `${summarizeAcceptGate(latest)}。代码没再改过，所以这次验收不会重跑它。`;
  }
  return `${summarizeAcceptGate(latest)}。这次没有合并、也没有清理，目标分支一动没动。`
    + (latest.status === "failed" ? "改完再点验收会自动重跑；确认这条红跟这次改动无关，也可以明确选择跳过。" : "重新点验收会从头跑一遍。");
}
