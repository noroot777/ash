import { useEffect, useMemo, useState } from "react";
import type { Task } from "@harness/shared";
import { TEAM_DEFAULTS } from "@harness/shared";
import { Crown, Robot, UsersThree } from "@phosphor-icons/react";
import { isTeamSettled, workersOf } from "@harness/shared/team";
import { ExecutorPicker, type ExecutorSelection, useExecutorProfiles } from "./ExecutorPicker";
import { Modal } from "./Modal";
import { api } from "./api";
import { teamExecutorDefaults, type DetectedAgent } from "./teamExecutorDefaults";
import { foldTeamStatus } from "./util";
import { STATUS_META } from "./constants";
import { StatusIcon } from "./StatusIcon";
import { isTeamCommand } from "./debateHandoff";

export type TeamHandoffChoice = {
  note: string;
  lead: ExecutorSelection;
  worker: ExecutorSelection;
};

export function TeamHandoffModal({
  busy,
  onClose,
  onConfirm,
}: {
  busy: boolean;
  onClose: () => void;
  onConfirm: (choice: TeamHandoffChoice) => Promise<boolean>;
}) {
  const [note, setNote] = useState("");
  const [leadPick, setLeadPick] = useState<ExecutorSelection | null>(null);
  const [workerPick, setWorkerPick] = useState<ExecutorSelection | null>(null);
  const [detected, setDetected] = useState<DetectedAgent[] | null>(null);
  const { profiles, providers } = useExecutorProfiles();

  useEffect(() => {
    let alive = true;
    api.detectAgents().then(
      (items) => alive && setDetected(items),
      () => alive && setDetected([]),
    );
    return () => { alive = false; };
  }, []);

  const { leadTypes, workerTypes, leadSelection, workerSelection } = useMemo(
    () => teamExecutorDefaults(detected, leadPick, workerPick),
    [detected, leadPick, workerPick],
  );
  const label = (role: "调度者" | "执行者", selection: ExecutorSelection) => {
    const profile = selection.executorId ? profiles.find((item) => item.id === selection.executorId) : null;
    return `${role} ${profile?.name ?? `默认 ${selection.agentType}`}`;
  };
  const submit = async () => {
    if (busy) return;
    if (await onConfirm({ note, lead: leadSelection, worker: workerSelection })) onClose();
  };

  return (
    <Modal
      title="交给团队开干"
      onClose={onClose}
      width={560}
      footer={(
        <>
          <button onClick={onClose} disabled={busy} className="px-3 py-1.5 text-[13px] text-muted disabled:opacity-40">取消</button>
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="rounded-md bg-cyan-600 px-3.5 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-40"
          >
            {busy ? "创建中…" : "创建并开干"}
          </button>
        </>
      )}
    >
      <div className="space-y-4">
        <p className="text-[12.5px] leading-relaxed text-muted">
          辩题、结论与完整转写路径会自动带过去。选择谁负责调度，以及执行者默认使用哪个执行器。
        </p>
        <div className="flex flex-wrap gap-2">
          <ExecutorPicker
            icon={<Crown size={14} />}
            selection={leadSelection}
            onSelect={setLeadPick}
            profiles={profiles}
            providers={providers}
            types={leadTypes}
            label={label("调度者", leadSelection)}
            menuWidth={320}
          />
          <ExecutorPicker
            icon={<Robot size={14} />}
            selection={workerSelection}
            onSelect={setWorkerPick}
            profiles={profiles}
            providers={providers}
            types={workerTypes}
            label={label("执行者", workerSelection)}
            menuWidth={320}
          />
        </div>
        <label className="block text-[12px] font-medium text-muted">
          可选附言
          <textarea
            autoFocus
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            rows={3}
            placeholder="补充执行重点、边界或验收要求…"
            className="mt-1.5 w-full resize-y rounded-md border border-line bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent"
          />
        </label>
      </div>
    </Modal>
  );
}

export function LinkedTeamCard({
  team,
  allTasks,
  onOpen,
  compact = false,
  onDebateAgain,
  debateAgainBusy = false,
}: {
  team: Task;
  allTasks: Task[];
  onOpen: (taskId: string) => void;
  compact?: boolean;
  onDebateAgain?: (team: Task) => void;
  debateAgainBusy?: boolean;
}) {
  const workers = workersOf(allTasks, team.id);
  const fold = foldTeamStatus(team, workers);
  const status = fold.awaitingAnswer ? "等答复" : STATUS_META[fold.status].label;
  const settled = isTeamSettled(team.status === "running", workers);
  const origin = allTasks.find((item) => item.id === team.originTaskId);
  const hasIteration = allTasks.some((item) => item.mode === "debate" && item.originTaskId === team.id);
  const canIterate = settled && origin?.mode === "debate" && !hasIteration && !!onDebateAgain;
  return (
    <div className={`flex min-w-0 items-stretch rounded-lg border border-cyan-500/30 bg-cyan-500/[0.07] ${compact ? "max-w-[430px]" : "w-full"}`}>
      <button
        type="button"
        onClick={() => onOpen(team.id)}
        className={`group flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:bg-cyan-500/[0.05] ${compact ? "px-2.5 py-1.5" : "px-3 py-2.5"}`}
        title={`打开关联团队：${team.title}`}
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-cyan-500/15 text-cyan-700">
          <UsersThree size={15} weight="fill" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-semibold tracking-wide text-cyan-700">已交给团队</span>
          <span className="block truncate text-[12.5px] font-medium text-ink">{team.title}</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted">
          <StatusIcon status={fold.status} size={11} awaitingAnswer={fold.awaitingAnswer} />
          {team.archived ? "已归档" : status}
        </span>
        <span className="shrink-0 text-[13px] text-faint transition-transform group-hover:translate-x-0.5">→</span>
      </button>
      {canIterate && (
        <button
          type="button"
          disabled={debateAgainBusy}
          onClick={() => onDebateAgain?.(team)}
          className="shrink-0 border-l border-cyan-500/20 px-3 text-[11px] font-medium text-cyan-700 transition-colors hover:bg-cyan-500/10 disabled:opacity-40"
        >
          {debateAgainBusy ? "创建中…" : "再辩一轮"}
        </button>
      )}
    </div>
  );
}

export function FinishedTeamHandoffBar({
  linkedTeam,
  allTasks,
  busy,
  onOpenTask,
  onOpenPicker,
  onDirectTeam,
  onDebateAgain,
  debateAgainBusy,
}: {
  linkedTeam?: Task;
  allTasks: Task[];
  busy: boolean;
  onOpenTask: (taskId: string) => void;
  onOpenPicker: () => void;
  onDirectTeam: (command: string) => Promise<boolean>;
  onDebateAgain?: (team: Task) => void;
  debateAgainBusy?: boolean;
}) {
  const [text, setText] = useState("");
  const submit = async () => {
    if (busy || !isTeamCommand(text)) return;
    if (await onDirectTeam(text.trim())) setText("");
  };
  return (
    <div className="border-t border-line bg-panel px-6 py-3">
      {linkedTeam ? (
        <div className="space-y-2">
          <LinkedTeamCard
            team={linkedTeam}
            allTasks={allTasks}
            onOpen={onOpenTask}
            onDebateAgain={onDebateAgain}
            debateAgainBusy={debateAgainBusy}
          />
          <details className="text-[11px] text-faint">
            <summary className="w-fit cursor-pointer select-none transition-colors hover:text-muted">再开一组（/team）</summary>
            <div className="mt-2 flex gap-2">
              <input
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit();
                }}
                placeholder="/team 给另一组的附言"
                className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-faint focus:border-accent"
              />
              <button
                type="button"
                disabled={busy || !isTeamCommand(text)}
                onClick={() => void submit()}
                className="rounded-md border border-line px-3 py-1.5 text-[12px] text-muted hover:text-ink disabled:opacity-40"
              >
                {busy ? "创建中…" : "直通创建"}
              </button>
            </div>
          </details>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-ink">把结论交给一支团队落实</div>
            <div className="text-[11px] text-faint">创建前可选择调度者、默认执行者，并补充交接附言。</div>
          </div>
          <TeamHandoffButton busy={busy} onClick={onOpenPicker} />
        </div>
      )}
    </div>
  );
}

export function TeamHandoffButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-cyan-500 bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-cyan-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 disabled:opacity-40"
    >
      <UsersThree size={13} weight="bold" />
      {busy ? "创建中…" : "交给团队开干"}
    </button>
  );
}

export function defaultTeamConfig(choice?: TeamHandoffChoice) {
  const lead = choice?.lead ?? { agentType: TEAM_DEFAULTS.lead, executorId: null };
  const worker = choice?.worker ?? { agentType: TEAM_DEFAULTS.worker, executorId: null };
  return {
    lead: lead.agentType,
    worker: worker.agentType,
    leadExecutorId: lead.executorId,
    workerExecutorId: worker.executorId,
  };
}
