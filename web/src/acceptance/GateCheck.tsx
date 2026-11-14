import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { SlidersHorizontal, Stop } from "@phosphor-icons/react";
import type { AcceptGateBaseline } from "@ash/shared/accept-gate";
import { acceptGateCancelMessage } from "@ash/shared/accept-gate";
import type { TaskListItem } from "@ash/shared";
import { api } from "../lib/api.ts";
import { useCatchUp } from "../lib/useCatchUp.ts";
import { localeTime } from "../lib/localeFormat.ts";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import type { useAcceptGate } from "../review/useAcceptGate.ts";
import { AcceptGateForceRelease } from "../review/AcceptGateForceRelease.tsx";
import { AcceptGateBaselineChoice } from "../review/AcceptGateBaselineChoice.tsx";
import { AcceptLayer } from "./AcceptLayer.tsx";
import { CheckAction, CheckRow } from "./CheckRow.tsx";
import { baselineEffect, gateLine, supervisionName } from "./gateLine.ts";

type Gate = ReturnType<typeof useAcceptGate>;

/**
 * 「验收前置命令」那一行。这条命令要跑十几分钟，所以它必须是**持久**的：刷新之后仍看得出在跑、
 * 跑了多久、怎么停；红了之后日志在哪、有没有交给任务。点这一行展开日志末尾；指上去才出设置键
 * （项目设置：和「设置 → 项目设置 → 验收」改的是同一组字段）。
 */
export function GateCheck({ task, gate, canManage, settled, atFinalGate, disabled, editRequested, onEditClosed, notify }: {
  task: TaskListItem;
  gate: Gate;
  /** 项目管理权限（useCanManage）；null = 还没读到，设置键先不出。 */
  canManage: boolean | null;
  settled: boolean;
  atFinalGate: boolean;
  /** 归档、任务在跑、这一屏正忙：会真的起一轮的「交给任务」跟着禁用。 */
  disabled: boolean;
  /** 确认层里点了「设一条前置命令」：没有这一行时也得摆出来，好让设置层有地方挂。 */
  editRequested: boolean;
  onEditClosed: () => void;
  notify: (message: string) => void;
}) {
  const { state, reload } = gate;
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [log, setLog] = useState<{ runId: string; text: string } | null>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const tip = useHoverTip();
  const line = gateLine({ ...gate, settled, atFinalGate });
  useEffect(() => { if (editRequested && canManage) setSettingsOpen(true); }, [editRequested, canManage]);

  const act = async (work: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    try {
      const message = await work();
      if (message) notify(message);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const closeSettings = () => { setSettingsOpen(false); onEditClosed(); };
  const editing = settingsOpen && !!state && canManage === true;
  if (!line && !editing) return null;

  const run = line?.run ?? null;
  const editable = canManage === true && (line ? line.editable : !settled && atFinalGate && !gate.running);
  const tools = <>
    {line?.stop && run && <CheckAction busy={busy} onClick={() => void act(async () => {
      const result = await api.cancelAcceptGate(task.id, run.id);
      await reload();
      return acceptGateCancelMessage(result);
    })}><Stop size={11} weight="fill" aria-hidden="true" />停止</CheckAction>}
    {line?.forceRelease && run && <AcceptGateForceRelease key={run.id} taskId={task.id} runId={run.id} reload={reload} notify={notify} />}
    {line?.handOff && <CheckAction disabled={disabled} busy={busy} onClick={() => void act(async () => {
      // 通知跟着**后端实际交回的那一行**说：按下之前读到的 latest 和请求到达时可能已经不是同一次。
      const handed = (await api.rehandOffAcceptGate(task.id)).gate;
      await reload();
      return handed.failure === "entry_missing" ? "已交给任务：它会先看入口为什么不在被测的树里" : "已把这条红交给任务去修";
    })}>交给任务</CheckAction>}
    {line?.retry && <CheckAction busy={busy} onClick={() => void act(async () => { await reload(); return null; })}>重试</CheckAction>}
    {editable && <button ref={gear} type="button" className="acc-icon-btn acc-reveal" aria-label="前置命令设置"
      aria-expanded={editing} onClick={() => (editing ? closeSettings() : setSettingsOpen(true))}>
      <SlidersHorizontal size={14} aria-hidden="true" />
    </button>}
  </>;

  const notice = run?.executionNotice ?? null;
  const shownLog = log && log.runId === run?.id ? log.text : run?.logTail;
  const detail = run && (run.logTail || run.logAvailable !== false) ? (
    <div className="acc-log">
      <div className="acc-log-head">
        <span>
          {run.id} · {localeTime(run.startedAt)} 起{run.finishedAt ? ` · ${localeTime(run.finishedAt)} 止` : ""}
          {notice && <> · <span className="acc-log-note" tabIndex={0} aria-label={notice} {...tip.anchorProps}>{supervisionName(notice)}</span></>}
        </span>
        <button type="button" className="acc-link" disabled={busy || run.logAvailable === false}
          onClick={() => void act(async () => { setLog({ runId: run.id, text: await api.acceptGateLog(task.id, run.id) }); return null; })}>
          {run.logAvailable === false ? "日志已清理" : "全文"}
        </button>
      </div>
      <pre ref={(node) => { if (node) node.scrollTop = node.scrollHeight; }}>{shownLog || "（日志为空）"}</pre>
      <HoverTip at={tip.at}>{notice}</HoverTip>
    </div>
  ) : undefined;

  return (
    <>
      <CheckRow
        key={`${run?.id ?? "none"}:${line?.tone ?? "edit"}`}
        check="gate"
        tone={line?.tone ?? "idle"}
        text={line?.command ? <code>{line.command}</code> : "前置命令"}
        state={line?.word ?? "未设"}
        detail={detail}
        defaultOpen={line?.openLog}
        tools={tools}
      />
      {editing && state && <GateSettings task={task} anchorRef={gear} state={state} onClose={closeSettings}
        onSaved={async (message) => { closeSettings(); await reload(); notify(message); }} notify={notify} />}
    </>
  );
}

/** 指上去出来的那一层：前置命令、准备命令、基准三档。它是**项目设置**，这一层要把这句说破。 */
function GateSettings({ task, anchorRef, state, onClose, onSaved, notify }: {
  task: TaskListItem;
  anchorRef: RefObject<HTMLButtonElement | null>;
  state: NonNullable<Gate["state"]>;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [command, setCommand] = useState(state.command ?? "");
  const [prepare, setPrepare] = useState(state.prepare ?? "");
  const [baseline, setBaseline] = useState<AcceptGateBaseline>(state.baseline ?? "branch");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy) return;
    const next = command.trim() || null;
    const nextPrepare = prepare.trim() || null;
    // 只发改了的那几项。
    const patch = {
      ...(next !== (state.command ?? null) ? { acceptGateCommand: next } : {}),
      ...(nextPrepare !== (state.prepare ?? null) ? { acceptGatePrepare: nextPrepare } : {}),
      ...(baseline !== (state.baseline ?? "branch") ? { acceptGateBaseline: baseline } : {}),
    };
    if (!Object.keys(patch).length) { onClose(); return; }
    setBusy(true);
    try {
      await api.updateProject(task.projectId, patch);
      await onSaved(!next ? "已撤掉这个项目的验收前置命令"
        : "acceptGateCommand" in patch ? "已设为这个项目的验收前置命令，之后每次验收先跑它"
          : `这个项目的验收前置命令设置已更新`);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const onEnter = (event: KeyboardEvent) => { if (event.key === "Enter") void save(); };
  return (
    <AcceptLayer open anchorRef={anchorRef} onClose={onClose} label="前置命令设置" align="end" className="acc-layer-gate">
      <label className="acc-field"><span>前置命令</span>
        <input className="mono" value={command} autoFocus aria-label="验收前置命令" placeholder="例如 npm test，留空就是不设"
          onChange={(event) => setCommand(event.target.value)} onKeyDown={onEnter} /></label>
      <label className="acc-field"><span>准备命令</span>
        <input className="mono" value={prepare} aria-label="准备命令" placeholder="例如 npm ci --offline，可留空"
          onChange={(event) => setPrepare(event.target.value)} onKeyDown={onEnter} /></label>
      <div className="acc-field"><span>基准</span><AcceptGateBaselineChoice value={baseline} onChange={setBaseline} disabled={busy} /></div>
      <p className="acc-layer-hint">{baselineEffect(baseline, state.baselineTarget?.branch ?? null, task.useWorktree !== false)}</p>
      <footer>
        <span className="acc-layer-note">项目设置，之后每次验收都按它</span>
        <button type="button" className="acc-btn is-primary" disabled={busy} onClick={() => void save()}>
          {busy && <i className="acc-spin" aria-hidden="true" />}保存
        </button>
      </footer>
    </AcceptLayer>
  );
}

/**
 * 这个项目的管理权限。**读失败一律保持 null 并自己重试到读到**：null（还没读到）和 false（确认
 * 没权限）在界面上长得一样，把一次 503 当成「你不是管理员」，设置键就再也不回来了（C3）。
 * 走列表接口（`/projects/:id` 不存在），重试策略与任务列表共用 useCatchUp。
 */
export function useCanManage(projectId: string): boolean | null {
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const catchUp = useCatchUp((signal) => {
    const mine = projectId;
    return api.projects(signal).then(
      (list) => {
        if (projectRef.current === mine) setCanManage(list.find((row) => row.id === mine)?.myRole === "admin");
        return true;
      },
      () => false,
    );
  }, projectId);
  useEffect(() => {
    setCanManage(null);
    void catchUp.run();
  }, [catchUp]);
  return canManage;
}
