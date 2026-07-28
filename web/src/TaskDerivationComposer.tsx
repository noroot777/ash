import { useEffect, useMemo, useState } from "react";
import type { DebateConfig, Task, TeamConfig } from "@harness/shared";
import { Crown, GitBranch, Robot, Scales, TreeStructure, UsersThree, X } from "@phosphor-icons/react";
import { api } from "./api";
import { createDebateConfig, DebateComposerFields } from "./DebateComposer";
import { ExecutorPicker, type ExecutorSelection, useExecutorProfiles } from "./ExecutorPicker";
import { teamExecutorDefaults, type DetectedAgent } from "./teamExecutorDefaults";
import {
  buildTaskDerivationBody,
  defaultPairTopic,
  derivedWorktreeDefaults,
  type TaskDerivationCommand,
} from "./taskDerivation";
import { toast } from "./toast";
import { Kbd, submitShortcutTitle } from "./ui";

type WorktreeContext = {
  isRepo: boolean;
  branches: string[];
  current: string | null;
};

export function TaskDerivationComposer({
  task,
  command,
  onClose,
  onCreated,
}: {
  task: Task;
  command: TaskDerivationCommand;
  onClose: () => void;
  onCreated: (task: Task, doRun?: boolean, select?: boolean) => void;
}) {
  const teamMode = command.kind === "team";
  const { profiles, providers } = useExecutorProfiles();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(command.note);
  const [debate, setDebate] = useState<DebateConfig>(() => ({
    ...createDebateConfig(),
    topic: defaultPairTopic(task, command.note),
  }));
  const [leadPick, setLeadPick] = useState<ExecutorSelection | null>(null);
  const [workerPick, setWorkerPick] = useState<ExecutorSelection | null>(null);
  const [detected, setDetected] = useState<DetectedAgent[] | null>(null);
  const [worktreeContext, setWorktreeContext] = useState<WorktreeContext | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.projectHealth(task.projectId), api.projectBranches(task.projectId)]).then(
      ([health, branches]) => {
        if (alive) setWorktreeContext({ isRepo: health.isRepo, ...branches });
      },
      (error) => {
        if (!alive) return;
        setWorktreeContext({ isRepo: false, branches: [], current: null });
        toast(`无法确认 worktree 基点：${error instanceof Error ? error.message : String(error)}`);
      },
    );
    return () => { alive = false; };
  }, [task.projectId]);

  useEffect(() => {
    if (!teamMode) return;
    let alive = true;
    api.detectAgents().then(
      (items) => alive && setDetected(items),
      () => alive && setDetected([]),
    );
    return () => { alive = false; };
  }, [teamMode]);

  const { leadTypes, workerTypes, leadSelection, workerSelection } = useMemo(
    () => teamExecutorDefaults(detected, leadPick, workerPick),
    [detected, leadPick, workerPick],
  );
  const worktree = derivedWorktreeDefaults(
    task,
    worktreeContext?.branches ?? [],
    !!worktreeContext?.isRepo,
  );

  const executorLabel = (role: "调度者" | "执行者", selection: ExecutorSelection) => {
    const profile = selection.executorId ? profiles.find((item) => item.id === selection.executorId) : null;
    return `${role} ${profile?.name ?? `默认 ${selection.agentType}`}`;
  };

  const submit = async () => {
    const topic = debate.topic.trim();
    if (busy || !worktreeContext || (!teamMode && !topic)) return;
    setBusy(true);
    let created: Task;
    try {
      const sessions = await api.sessions(task.id);
      const userNote = teamMode ? note : topic;
      const body = buildTaskDerivationBody(task, sessions, command.kind, userNote);
      if (teamMode) {
        const team: TeamConfig = {
          lead: leadSelection.agentType,
          worker: workerSelection.agentType,
          leadExecutorId: leadSelection.executorId,
          workerExecutorId: workerSelection.executorId,
        };
        created = await api.createTask({
          projectId: task.projectId,
          title: `团队接手：${task.title}`.slice(0, 60),
          body,
          mode: "team",
          originTaskId: task.id,
          agentType: leadSelection.agentType,
          team,
          autoTitle: false,
          useWorktree: worktree.useWorktree,
          worktreeBase: worktree.worktreeBase,
        });
      } else {
        created = await api.createTask({
          projectId: task.projectId,
          title: `任务讨论：${task.title}`.slice(0, 60),
          body,
          mode: "debate",
          originTaskId: task.id,
          debate: { ...debate, topic, style: "debate" },
          autoTitle: false,
          useWorktree: worktree.useWorktree,
          worktreeBase: worktree.worktreeBase,
        });
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
      setBusy(false);
      return;
    }

    onCreated(created, false, false);
    try {
      await api.runTask(created.id);
      toast(teamMode ? "已创建团队任务并开干" : "已创建辩论任务并开跑", "info");
    } catch (error) {
      toast(`任务已创建，但启动失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
      onClose();
    }
  };

  const accent = teamMode ? "cyan" : "violet";
  return (
    <section
      className={`rounded-lg border ${teamMode ? "border-cyan-500/30 bg-cyan-500/[0.06]" : "border-violet-500/30 bg-violet-500/[0.06]"} p-3`}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void submit();
        }
      }}
    >
      <div className="flex items-start gap-2">
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md ${teamMode ? "bg-cyan-500/15 text-cyan-700" : "bg-violet-500/15 text-violet-700"}`}>
          {teamMode ? <UsersThree size={15} weight="fill" /> : <Scales size={15} weight="fill" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold text-ink">
            {teamMode ? "以当前任务为背景创建团队" : "以当前任务为背景发起辩论"}
          </div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-faint">
            命令不会发给当前 agent；创建新任务也不会改变当前任务状态。
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted transition-colors hover:bg-overlay hover:text-ink disabled:opacity-40"
          title="收起配置"
        >
          <X size={13} />
        </button>
      </div>

      <div className="mt-3">
        {teamMode ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <ExecutorPicker
                icon={<Crown size={14} />}
                selection={leadSelection}
                onSelect={setLeadPick}
                profiles={profiles}
                providers={providers}
                types={leadTypes}
                label={executorLabel("调度者", leadSelection)}
                menuWidth={320}
              />
              <ExecutorPicker
                icon={<Robot size={14} />}
                selection={workerSelection}
                onSelect={setWorkerPick}
                profiles={profiles}
                providers={providers}
                types={workerTypes}
                label={executorLabel("执行者", workerSelection)}
                menuWidth={320}
              />
            </div>
            <label className="block text-[12px] font-medium text-muted">
              可选附言
              <textarea
                autoFocus
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                placeholder="补充执行重点、边界或验收要求…"
                className="mt-1.5 w-full resize-y rounded-md border border-line bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent"
              />
            </label>
          </div>
        ) : (
          <DebateComposerFields
            value={debate}
            onChange={setDebate}
            profiles={profiles}
            providers={providers}
          />
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/70 pt-2.5">
        <WorktreeHint context={worktreeContext} worktree={worktree} />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !worktreeContext || (!teamMode && !debate.topic.trim())}
          title={submitShortcutTitle(teamMode ? "创建并开干" : "创建并开辩")}
          className={`ml-auto inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition-colors disabled:opacity-40 ${accent === "cyan" ? "bg-cyan-600 hover:bg-cyan-500" : "bg-violet-600 hover:bg-violet-500"}`}
        >
          {busy ? "创建中…" : teamMode ? "创建并开干" : "创建并开辩"} <Kbd className="border-white/20 bg-white/10" />
        </button>
      </div>
    </section>
  );
}

function WorktreeHint({
  context,
  worktree,
}: {
  context: WorktreeContext | null;
  worktree: ReturnType<typeof derivedWorktreeDefaults>;
}) {
  if (!context) {
    return <span className="inline-flex items-center gap-1 text-[11px] text-faint"><TreeStructure size={12} />正在确认 worktree 基点…</span>;
  }
  if (!context.isRepo) {
    return <span className="inline-flex items-center gap-1 text-[11px] text-faint"><TreeStructure size={12} />项目不是 Git 仓库，将使用项目目录</span>;
  }
  if (worktree.inheritsSource && worktree.worktreeBase) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted" title={`从 ${worktree.worktreeBase} 创建新 worktree`}>
        <GitBranch size={12} className="shrink-0 text-accent" />
        <span className="truncate">worktree 默认开启 · 基于来源分支 {worktree.worktreeBase}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted">
      <TreeStructure size={12} className="shrink-0 text-accent" />
      <span className="truncate">
        worktree 默认开启 · {worktree.sourceBranch ? `来源分支 ${worktree.sourceBranch} 已不存在，改从项目当前 HEAD 创建` : "从项目当前 HEAD 创建"}
      </span>
    </span>
  );
}
