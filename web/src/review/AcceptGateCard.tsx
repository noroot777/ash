import { useEffect, useState } from "react";
import { ArrowClockwise, ArrowUUpLeft, CheckCircle, FileText, PencilSimple, SpinnerGap, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { AcceptGateBasis, AcceptGateState, AcceptGateView } from "@ash/shared/accept-gate";
import { ACCEPT_GATE_STATUS_LABELS, acceptGateCancelMessage, summarizeAcceptGate } from "@ash/shared/accept-gate";
import type { Task, TaskListItem } from "@ash/shared";
import { isFinalHumanGate } from "@ash/shared/workflow-policy";
import { api } from "../lib/api.ts";
import { useAcceptGate } from "./useAcceptGate.ts";
import { AcceptGateForceRelease } from "./AcceptGateForceRelease.tsx";

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
type AcceptGateCardProps = {
  task: TaskListItem | Task;
  notify: (message: string) => void;
  /**
   * 红了之后的两条出路：重跑一次 / 这一次跳过。点下去走的仍是正常那道验收确认框。
   *
   * 把**上一次跑成什么样**一起带出去：确认框要据它说话。「跳过」在红了之后和在被取消
   * 之后是两句不同的话（一个是明知红着仍然合，另一个是上一次根本没有结论）。
   */
  onIntent: (intent: "rerun" | "skip", latest: AcceptGateView | null) => void;
  disabled?: boolean;
};

export function AcceptGateCard(props: AcceptGateCardProps) {
  const gate = useAcceptGate(props.task.id);
  return <AcceptGateCardView {...props} gate={gate} />;
}

export function AcceptGateCardView({ task, notify, onIntent, disabled = false, gate }: AcceptGateCardProps & {
  gate: ReturnType<typeof useAcceptGate>;
}) {
  const { state, error, stale, running, latest, basis, runningFor, reload } = gate;
  const [busy, setBusy] = useState(false);
  // 全文按**哪一次**缓着：切任务、或者同一个任务又跑了一次之后，上一次的全文不能接着
  // 摆在那儿（标题写的是新的那条路径，正文却是旧的 —— 第 1 轮审查不拦项 2）。
  const [log, setLog] = useState<{ runId: string; text: string } | null>(null);
  // null = 还没读到这个项目的管理权限。读到之前不摆「改这条命令」——摆一颗必然 403 的
  // 按钮，点的人只会以为是自己点坏了（同 ProjectSettingsPanel 那一屏的两副面孔）。
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const settled = task.stage === "accepted" || task.stage === "merged";

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
  // 停在中途那道「等我点头」上时，那一按是**放行**不是验收：不会碰门禁，所以别在这儿
  // 预告「这一按要先跑十几分钟」—— 那句话在那一站上是假的。跑过的记录仍然照常显示。
  const atFinalGate = isFinalHumanGate(task.workflow, task.workflowAt);
  const idle = !!state && !state.command && !running && !settled;
  // 验收做完之后这张卡**留着**（用户 2026-10-23 指定）：它换成一张只读回执 —— 跑过没有、
  // 什么结果、日志在哪。原先在盖章那一刻整个消失，于是「通过了」和「我明确跳过了那条红」
  // 在界面上长得一模一样，而两者的区别恰恰是这次合并到底有没有凭据。
  //
  // 回执**只认这一按自己的凭据**（`basis`），绝不拿「最近一次门禁」反推（第 1 轮审查
  // F1 实测：命令在 A 上跑绿、代码改成 B、项目再撤掉命令，那时「最近一次」仍是那条绿的，
  // 而真正放行的理由是「现在没有门禁」—— 照最近那次说话就是给一份从没测过的代码背书）。
  const receipt = settled && !running ? basis : null;
  // 状态读不出来时**先把这件事说出来**：从前这里直接 return null，于是一次 500 之后页面
  // 上什么都没有，看起来就跟「没设门禁」一样（第 1 轮审查不拦项 3）。
  if (!state) {
    return (
      <section className="accept-gate-card" aria-label="验收前置命令" aria-busy={error ? undefined : true}>
        <header>
          <span>{error ? <WarningCircle size={14} weight="fill" /> : <SpinnerGap size={14} className="is-spinning" />}</span>
          <div>
            <b>{error ? "验收前置命令的状态读不出来" : "正在读取验收前置命令…"}</b>
            {error
              ? <p role="alert">{error}。这不等于「没有命令在跑」—— 点一下刷新再看。</p>
              : <p role="status">正在核对项目配置和最近运行结果，读取完成后会在这里显示验收使用的命令。</p>}
          </div>
          <button type="button" className="pending-merge-refresh" disabled={busy || !error} onClick={() => void reload()}>
            <ArrowClockwise size={12} aria-hidden="true" />刷新
          </button>
        </header>
      </section>
    );
  }
  // 卡上摆的是哪一次：正在跑的 > 本次凭据那一次 > 最近一次（最后这种只作历史，措辞里说破）。
  const shown = running ?? receipt?.run ?? latest;

  const cancel = async () => {
    if (busy || !running) return;
    setBusy(true);
    try {
      const result = await api.cancelAcceptGate(task.id, running.id);
      notify(acceptGateCancelMessage(result));
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
    if (busy || !shown) return;
    setBusy(true);
    try {
      setLog({ runId: shown.id, text: await api.acceptGateLog(task.id, shown.id) });
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

  // 取消和被打断**不是红**：那两种根本没有结论（用户自己收掉的、ash 重启打断的），
  // 套上失败色会让人以为命令真的跑出了问题，而出路完全不同（重点一次就行）。
  // 验收做完之后这张卡不再是关口：通过的那一次照常是绿的（stale 与否已经不重要，
  // 它就是这次合并的凭据），没通过的那一次是**你明确跳过的**，用琥珀而不是红 ——
  // 红表示「现在有东西拦着你」，而这时什么都没拦着，只是那条红没人修。
  const tone = stale ? "" : running
    ? "is-running"
    : receipt
      // 回执的调子只由凭据决定：通过是绿的；明确跳过是琥珀（红表示「现在有东西拦着你」，
      // 而这时什么都没拦着，只是那条红没人修）；那一刻没设门禁则是中性的一句陈述。
      ? receipt.mode === "passed" ? "is-passed" : receipt.mode === "skipped" ? "is-skipped" : ""
      : settled || state.unavailable || state.sourceError ? ""
        : !latest ? ""
          : latest.status === "passed" ? (!latest.stale ? "is-passed" : "")
            : latest.status === "failed" ? "is-failed" : "";
  return (
    <section className={`accept-gate-card ${idle ? "is-idle" : tone}`} aria-label="验收前置命令">
      <header>
        <span>{stale ? <WarningCircle size={14} /> : running
          ? running.status === "running" ? <SpinnerGap size={14} className="is-spinning" /> : <WarningCircle size={14} weight="fill" />
          : receipt
            ? receipt.mode === "passed" ? <CheckCircle size={14} weight="fill" /> : <WarningCircle size={14} weight="fill" />
            : settled
              ? <WarningCircle size={14} weight="fill" />
              : latest?.status === "passed"
                ? <CheckCircle size={14} weight="fill" />
                : latest?.status === "failed"
                  ? <WarningCircle size={14} weight="fill" />
                  : latest
                    ? <XCircle size={14} />
                    : <FileText size={14} />}
        </span>
        <div>
          <b>{stale ? "验收前置命令状态待核对" : !settled && !running && !atFinalGate ? "此处只放行，不运行前置命令" : idle ? "这个项目没设验收前置命令" : heading(state, running, latest, receipt, settled, runningFor)}</b>
          <p>{stale ? "以下为上次读取的记录，当前状态尚未确认。" : !settled && !running && !atFinalGate
            ? "这次只放行到下一站；项目配置的前置命令在最终验收时才生效。"
            : idle && latest
            ? `项目当前没有验收前置命令，下次验收不会跑它。历史记录：${summarizeAcceptGate(latest)}；这不是下次验收的测试凭据。`
            : idle
            ? "本次验收不会运行前置命令。项目管理员可在这里或项目设置中配置。"
            : detail(state, running, latest, receipt, settled)}</p>
          {shown?.executionNotice && <p role="note">{running ? "本次运行：" : settled ? "本次验收运行：" : "历史运行："}{shown.executionNotice}</p>}
          {!settled && !running && state.command && state.executionNotice && state.executionNotice !== shown?.executionNotice
            && <p role="note">下次运行：{state.executionNotice}</p>}
          {error && <p role="alert">状态读取失败：{error}（下面这份可能已经不是最新的，可刷新重试）</p>}
          {stale && !error && <p role="status">正在核对，下面是上次读取的记录。</p>}
        </div>
        <button type="button" className="pending-merge-refresh" disabled={busy} onClick={() => void reload()}>
          <ArrowClockwise size={12} aria-hidden="true" />刷新
        </button>
      </header>
      {!settled && (
        <dl className="accept-gate-command">
          <dt>{running ? "本次正在运行" : stale ? "上次读取的项目命令" : "项目配置的前置命令"}</dt>
          <dd><code>{running?.command ?? state.command ?? (stale ? "当时未设置，当前配置待核对" : "未设置（验收时不运行前置命令）")}</code></dd>
        </dl>
      )}
      {shown?.logTail && (
        <div className="accept-gate-log">
          <span>日志末尾{receipt?.run ? "（本次验收凭据那一次）" : settled || idle ? "（历史记录，不是本次凭据）" : ""}</span>
          <pre>{shown.logTail}</pre>
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
            （和「设置 → 项目设置 → 验收」里那一格是同一个）。命令跑在独立源码快照里，不使用未提交文件或未纳入的本地配置。
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
            ) : atFinalGate && state.command && latest && latest.status !== "passed" && !settled ? (
              <>
                <button type="button" disabled={busy || disabled || !!state.unavailable} onClick={() => onIntent("rerun", latest)}>
                  <ArrowClockwise size={13} />重跑一次
                </button>
                <button type="button" disabled={busy || disabled} onClick={() => onIntent("skip", latest)}>
                  这次跳过它，直接合并
                </button>
              </>
            ) : null}
            {atFinalGate && state.unavailable && !running && !settled && !latest && <button type="button" disabled={busy || disabled} onClick={() => onIntent("skip", null)}>这次跳过它，直接合并</button>}
            {running && running.status !== "running" && running.processPending && <AcceptGateForceRelease key={running.id} taskId={task.id} runId={running.id} reload={reload} notify={notify} />}
            {state.command && latest?.status === "failed" && !running && !settled && !state.unavailable && (
              <button type="button" className={latest.handoff?.error ? "is-primary" : ""} disabled={busy || disabled} onClick={() => void handOff()}>
                <ArrowUUpLeft size={13} />{latest.handoff && !latest.handoff.error ? "再交给智能体一次" : "交给智能体去修"}
              </button>
            )}
            {shown && (
              <button type="button" disabled={busy || shown.logAvailable === false} onClick={() => void openLog()}><FileText size={13} />{shown.logAvailable === false ? "日志未迁入或已清理，当前不可查" : "看完整日志"}</button>
            )}
            {/* 正在跑的时候不给改：这一次用的是开跑时那条命令原文，改了也不作数，
                摆在那儿只会让人以为能中途换一条。 */}
            {/* 验收做完之后不摆「改这条命令」：改的是**项目**设置，而这张卡此刻是这一个
                任务的历史回执，在这儿改会让人以为是在改这条记录。设置页那一份照常能改。 */}
            {canManage && !running && !settled && atFinalGate && (
              <button type="button" className={idle ? "is-primary" : ""} disabled={busy} onClick={() => setDraft(state.command ?? "")}>
                <PencilSimple size={13} />{idle ? "设一条" : "改这条命令"}
              </button>
            )}
          </>
        )}
      </div>
      {log !== null && log.runId === shown?.id && (
        <div className="accept-gate-log is-full">
          <span>完整日志（{shown.logPath}）<button type="button" onClick={() => setLog(null)}>收起</button></span>
          <pre>{log.text || "（日志为空）"}</pre>
        </div>
      )}
    </section>
  );
}

function heading(
  state: AcceptGateState,
  running: AcceptGateView | null,
  latest: AcceptGateView | null,
  receipt: AcceptGateBasis | null,
  settled: boolean,
  runningFor: string | null,
): string {
  if (running) return running.status === "running" ? `验收前置命令正在跑（已经 ${runningFor}）` : "验收前置命令尚待停止，工作区仍被占用";
  // 已经盖过章了：这张卡是回执，说的是**这一按当初拿什么放的行**。stale 在这儿一概不
  // 参与 —— 「现在这棵树变了」对一次已经合完的验收毫无意义。
  if (receipt) {
    if (receipt.mode === "passed") return "本次验收前，验收前置命令通过了";
    if (receipt.mode === "skipped") return "这次跳过了验收前置命令";
    return "本次验收没有经过验收前置命令";
  }
  if (settled) return "这次验收没有留下门禁凭据";
  if (state.unavailable) return "验收前置命令未执行：本机能力不可用";
  if (state.sourceError) return "验收前置命令未执行：源码输入不可用";
  if (!latest) return "这个项目设了验收前置命令";
  if (latest.status === "passed") {
    if (!latest.stale) return "验收前置命令已通过";
    return latest.command !== state.command ? "上次通过的不是现在这条命令" : "上次通过的不是现在这棵树";
  }
  return `验收前置命令${ACCEPT_GATE_STATUS_LABELS[latest.status]}`;
}

function detail(
  state: AcceptGateState,
  running: AcceptGateView | null,
  latest: AcceptGateView | null,
  receipt: AcceptGateBasis | null,
  settled: boolean,
): string {
  if (running) {
    if (running.status !== "running") return "尚未确认整棵进程树退出，合并和清理继续阻止；这不是已收干净的证明。";
    return `\`${running.command}\`（在 ${running.cwd}）。rc=0 才会继续合并：绿了这次验收会自动做完，`
      + "不用再点；红了会把日志交回这个任务的智能体去修，目标分支一个字节都不会动。";
  }
  if (receipt) return receiptDetail(receipt, state, latest);
  if (!settled && state.unavailable) return state.unavailable;
  if (!settled && state.sourceError) return state.sourceError;
  if (settled) {
    // 凭据是后来才开始记的。老数据只能如实说「不知道」—— 拿「最近一次」替它背书，正是
    // 第 1 轮审查实测出来的那条假回执。
    return "这次验收是在 ash 开始记「这一按拿什么放的行」之前做的，所以查不到凭据。"
      + (latest
        ? `这个任务名下最近一次执行记录是「${summarizeAcceptGate(latest)}」，但它并不能证明本次验收前跑过它。`
        : "");
  }
  if (!latest) return `点「验收通过」时会先在独立源码快照里跑一遍 \`${state.command}\`，rc=0 且进程监督收尾后才合并。`;
  if (latest.status === "passed") {
    if (!latest.stale) return `${summarizeAcceptGate(latest)}。源码、依赖输入和命令仍与被测快照一致，所以这次验收不会重跑它。`;
    // 「不作数了」有两种，出路一样但原因完全不同，说错一种用户会去查错的地方。
    return latest.command !== state.command
      ? `那次跑的是另一条命令（\`${latest.command}\`）。现在这条 \`${state.command}\` 在这棵树上一次都没跑过——再点验收会跑它。`
      : `那次跑的是 ${latest.sourceCommit?.slice(0, 8) ?? "另一份源码快照"}，当前源码或依赖输入已变化，或旧记录没有可核对的快照身份——再点验收会重跑一遍。`;
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

/** 已验收那张回执的正文：只陈述**本次验收那一按**的凭据，历史一律标清「不是凭据」。 */
function receiptDetail(receipt: AcceptGateBasis, state: AcceptGateState, latest: AcceptGateView | null): string {
  if (receipt.mode === "passed") {
    const run = receipt.run;
    // 凭据在、但记录被归档清理带走了：只剩「是拿一次跑绿放的行」这件事本身，说到这儿为止。
    if (!run) return "这一按是拿一次真的跑绿放的行，但那一次的执行记录已经不在了（归档清理），所以没有日志可查。";
    return `${summarizeAcceptGate(run)}。${run.sourceCommit ? `验的是 ${run.sourceCommit.slice(0, 8)}，` : ""}`
      + "本次验收就是拿它放的行。"
      + (run.fastForward === false && run.targetBranch
        ? `（当时 ${run.targetBranch} 已经领先于这棵树，所以它验的是任务分支那一棵，不是最终的合并结果。）`
        : "");
  }
  if (receipt.mode === "skipped") {
    return "这次验收明确跳过了验收前置命令：ash 没有跑它，也没有任何它通过的证据，验收是你明确选的。"
      + (latest?.status === "failed" ? `这个任务名下最近一次是红的（${summarizeAcceptGate(latest)}），那条红没有人修过。` : "");
  }
  // unset：那一刻这个项目根本没有这一关。后来又设了一条的话必须说破 —— 否则用户看着
  // 卡上那条命令，会读成「这次是跑了它才合的」。
  return "那一刻这个项目没有设验收前置命令，所以本次验收没有经过这道测试。"
    + (state.command ? `（这个项目后来设了 \`${state.command}\`，但它不是本次验收的凭据。）` : "")
    + (latest ? `下面那条是这个任务名下最近一次执行记录，同样不是这次验收的凭据。` : "");
}
