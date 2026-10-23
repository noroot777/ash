import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowUUpLeft, CheckCircle, FileText, PencilSimple, SpinnerGap, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { AcceptGateView } from "@ash/shared/accept-gate";
import { ACCEPT_GATE_STATUS_LABELS, summarizeAcceptGate } from "@ash/shared/accept-gate";
import type { Task, TaskListItem } from "@ash/shared";
import { isFinalHumanGate } from "@ash/shared/workflow-policy";
import { api, type AcceptGateState } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

// 「验收前置命令」在验收台上的那张卡。它跟 PendingMergeCard 一样住在每个有验收动作的
// 表面上，自己判要不要出现。
//
// 为什么非得有这张卡：这条命令要跑十几分钟（设它的人就是拿它跑全量回归的），而用户点
// 完验收之后页面上只有一个 toast。toast 一刷新就没了，于是「我点过了吗」「它跑到哪了」
// 「红在哪一条」全都没处看——那正是根 AGENTS.md「停止/暂停必须留下持久可见的状态」要
// 挡的那种坑。所以这张卡负责三件事：现在什么状态、日志在哪、红了之后的出路是什么。
//
// 这条命令**在这里也能设**（用户 2026-10-23 要求）：它管的是「这一按会不会先跑点什么」，
// 而人想起这件事的时刻就是站在验收台前的那一刻 —— 为了设它跳去项目设置再找回来，中间
// 隔着三次跳转。所以同一份设置两个入口：项目设置里那份带完整说明，这里是就地改。两边
// 写的是同一个字段，改完都立刻生效（它是**项目级**的，卡里会把这句说破）。
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
  // null = 还没读到这个项目的管理权限。读到之前不摆「改这条命令」——摆一颗必然 403 的
  // 按钮，点的人只会以为是自己点坏了（同 ProjectSettingsPanel 那一屏的两副面孔）。
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
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
  // 能不能在这儿改这条命令 = 这个项目的管理权限。走列表接口而不是 `/projects/:id`
  // （后者不存在，见 AcceptCommitChoice 顶部），列表本身就带着 myRole。
  useEffect(() => {
    let alive = true;
    api.projects().then(
      (list) => { if (alive) setCanManage(list.find((row) => row.id === task.projectId)?.myRole === "admin"); },
      () => { if (alive) setCanManage(false); },
    );
    return () => { alive = false; };
  }, [task.projectId]);
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
  // 停在中途那道「等我点头」上时，那一按是**放行**不是验收：不会碰门禁，所以别在这儿
  // 预告「这一按要先跑十几分钟」—— 那句话在那一站上是假的。跑过的记录仍然照常显示。
  const atFinalGate = isFinalHumanGate(task.workflow, task.workflowAt);
  // 没设、也没跑过：只有能改它的人才看得到这张卡（那时它是一个入口）；改不了的人看到的
  // 是一句跟自己无关的话，纯噪音。
  const idle = !!state && !state.command && !latest;
  if (!state) return null;
  if (idle && (!canManage || !atFinalGate || settled)) return null;
  if (!latest && !atFinalGate) return null;
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
  // 把这条红交回给这个任务的智能体。红了的时候 ash 已经自动交过一次（所以这颗按钮写
  // 的是「再交一次」），这里是两种补救：那次没投递成功，或者它那一轮跑完了还没修好。
  const handOff = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.rehandOffAcceptGate(task.id);
      await reload();
      notify("已把这条红交回给智能体去修；修完再点验收，会自动重跑一遍这条命令");
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
  // 就地改这条命令。它是**项目级**的，所以保存成功那句话必须把这点说破 —— 在一个任务
  // 的验收台上改一个项目设置，不说清就会被当成「只影响这一个任务」。
  const saveCommand = async () => {    if (busy || draft === null) return;
    const next = draft.trim() || null;
    if (next === (state.command ?? null)) { setDraft(null); return; }
    setBusy(true);
    try {
      await api.updateProject(task.projectId, { acceptGateCommand: next });
      setDraft(null);
      await reload();
      notify(next
        ? "已设为这个项目的验收前置命令：以后每次验收都会先跑它，rc=0 才合并"
        : "已撤掉这个项目的验收前置命令，验收恢复为直接合并");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const tone = running
    ? "is-running"
    : latest?.status === "passed" ? (latest.stale ? "" : "is-passed") : latest ? "is-failed" : "";
  return (
    <section className={`accept-gate-card ${idle ? "is-idle" : tone}`} aria-label="验收前置命令">
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
          <b>{idle ? "这个项目没设验收前置命令" : heading(running, latest, tick)}</b>
          <p>{idle
            ? "设一条之后，点「验收通过」会先在任务工作区里跑它，rc=0 才合并 ——「进 main 之前跑一次全量回归」这类事就不用靠人记着哪一轮是最后一轮了。"
            : detail(state, running, latest)}</p>
          {error && <p role="alert">状态读取失败：{error}</p>}
        </div>
        {!idle && (
          <button type="button" className="pending-merge-refresh" disabled={busy} onClick={() => void reload()}>
            <ArrowClockwise size={12} aria-hidden="true" />刷新
          </button>
        )}
      </header>
      {(running ?? latest)?.logTail && (
        <div className="accept-gate-log">
          <span>日志末尾</span>
          <pre>{(running ?? latest)!.logTail}</pre>
        </div>
      )}
      {draft !== null && (
        <div className="accept-gate-edit">
          <input
            className="mono"
            value={draft}
            autoFocus
            placeholder="例如 ./kb.sh test full（留空 = 撤掉这条命令）"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void saveCommand(); }}
          />
          <small>
            这是<b>项目设置</b>：改完对这个项目之后的每一次验收都生效，不只这一个任务
            （和「设置 → 项目设置 → 验收」里那一格是同一个）。命令跑在任务自己的工作区里。
          </small>
        </div>
      )}
      <div className="pending-merge-actions">
        {draft !== null ? (
          <>
            <button type="button" className="is-primary" disabled={busy} onClick={() => void saveCommand()}>
              {busy ? <SpinnerGap size={13} className="is-spinning" /> : <CheckCircle size={13} weight="fill" />}保存
            </button>
            <button type="button" disabled={busy} onClick={() => setDraft(null)}>取消</button>
          </>
        ) : (
          <>
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
            {latest?.status === "failed" && !running && (
              <button type="button" className={latest.handoff?.error ? "is-primary" : ""} disabled={busy} onClick={() => void handOff()}>
                <ArrowUUpLeft size={13} />{latest.handoff && !latest.handoff.error ? "再交给智能体一次" : "交给智能体去修"}
              </button>
            )}
            {(running ?? latest) && (
              <button type="button" disabled={busy} onClick={() => void openLog()}><FileText size={13} />看完整日志</button>
            )}
            {/* 正在跑的时候不给改：这一次用的是开跑时那条命令原文，改了也不作数，
                摆在那儿只会让人以为能中途换一条。 */}
            {canManage && !running && (
              <button type="button" className={idle ? "is-primary" : ""} disabled={busy} onClick={() => setDraft(state.command ?? "")}>
                <PencilSimple size={13} />{idle ? "设一条" : "改这条命令"}
              </button>
            )}
          </>
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
      + "不用再点；红了会把日志交回这个任务的智能体去修，目标分支一个字节都不会动。";
  }
  if (!latest) return `点「验收通过」时会先在任务工作区里跑一遍 \`${state.command}\`，rc=0 才合并。`;
  if (latest.status === "passed") {
    return latest.stale
      ? `那次跑的是 ${latest.sourceCommit?.slice(0, 8) ?? "另一棵树"}，代码之后又改过了——再点验收会重跑一遍。`
      : `${summarizeAcceptGate(latest)}。代码没再改过，所以这次验收不会重跑它。`;
  }
  // 红了之后 ash 会**自动**把日志交回那个任务去修。这件事必须写在卡上：用户只看到三颗
  // 按钮时会以为还得自己去催，而时间线里那句话翻几页才找得到。
  const handoff = latest.status !== "failed"
    ? ""
    : !latest.handoff
      ? "日志还没交给智能体。"
      : latest.handoff.error
        ? `已经试过把日志交回这个任务的智能体，但没叫醒它（${latest.handoff.error}）——那条红现在没人在管。`
        : "日志已经交回这个任务的智能体去修了。";
  return `${summarizeAcceptGate(latest)}。这次没有合并、也没有清理，目标分支一动没动。${handoff}`
    + (latest.status === "failed" ? "改完再点验收会自动重跑；确认这条红跟这次改动无关，也可以明确选择跳过。" : "重新点验收会从头跑一遍。");
}
