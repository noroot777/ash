import { useEffect, useMemo, useRef, useState } from "react";
import type { DebateConfig, Task, TeamConfig } from "@harness/shared";
import { DEFAULT_APP_SETTINGS } from "@harness/shared";
import { GitBranch, Scales, TreeStructure, UsersThree, X } from "@phosphor-icons/react";
import { api } from "./api";
import { createDebateConfig, DebateComposerFields } from "./DebateComposer";
import { type ExecutorSelection, useExecutorProfiles } from "./ExecutorPicker";
import { TeamExecutorFields } from "./composer/ExecutorFields";
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
  worktreeDefault: boolean;
};

export function TaskDerivationComposer({
  task,
  command,
  live = false,
  onClose,
  onCreated,
}: {
  task: Task;
  command: TaskDerivationCommand;
  /** true = 命令还在回复框里打着（即时预览）：不抢焦点，命令尾巴实时同步进
      附言/辩题；回车提交后转为 false，输入框清空、焦点移进卡片。 */
  live?: boolean;
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
  const [leadModel, setLeadModel] = useState("");
  const [leadEffort, setLeadEffort] = useState("");
  const [workerModel, setWorkerModel] = useState("");
  const [workerEffort, setWorkerEffort] = useState("");
  const [detected, setDetected] = useState<DetectedAgent[] | null>(null);
  const [worktreeContext, setWorktreeContext] = useState<WorktreeContext | null>(null);
  // 用户一旦亲手改过附言/辩题，就停止从回复框同步，免得把手改的内容冲掉。
  const noteTouched = useRef(false);
  const topicTouched = useRef(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!live) return;
    if (teamMode && !noteTouched.current) setNote(command.note);
    if (!teamMode && !topicTouched.current) {
      setDebate((cur) => ({ ...cur, topic: defaultPairTopic(task, command.note) }));
    }
  }, [live, teamMode, command.note, task]);

  // 预览转正式（回车）：焦点从回复框移进卡片，接着补充附言不用再点一下。
  useEffect(() => {
    if (!live) noteRef.current?.focus();
  }, [live]);

  useEffect(() => {
    let alive = true;
    Promise.all([api.projectHealth(task.projectId), api.projectBranches(task.projectId), api.settings()]).then(
      ([health, branches, settings]) => {
        if (alive) setWorktreeContext({ isRepo: health.isRepo, ...branches, worktreeDefault: settings.worktreeDefault });
      },
      (error) => {
        if (!alive) return;
        setWorktreeContext({ isRepo: false, branches: [], current: null, worktreeDefault: DEFAULT_APP_SETTINGS.worktreeDefault });
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
    worktreeContext?.worktreeDefault ?? DEFAULT_APP_SETTINGS.worktreeDefault,
  );

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
          leadModel: leadModel || null,
          leadReasoningEffort: leadEffort || null,
          workerModel: workerModel || null,
          workerReasoningEffort: workerEffort || null,
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
              <TeamExecutorFields
                lead={{
                  selection: leadSelection,
                  types: leadTypes,
                  model: leadModel,
                  reasoningEffort: leadEffort,
                  onSelect: setLeadPick,
                  onModel: setLeadModel,
                  onReasoningEffort: setLeadEffort,
                }}
                worker={{
                  selection: workerSelection,
                  types: workerTypes,
                  model: workerModel,
                  reasoningEffort: workerEffort,
                  onSelect: setWorkerPick,
                  onModel: setWorkerModel,
                  onReasoningEffort: setWorkerEffort,
                }}
                profiles={profiles}
                providers={providers}
              />
            </div>
            <label className="block text-[12px] font-medium text-muted">
              可选附言
              <textarea
                ref={noteRef}
                value={note}
                onChange={(event) => {
                  noteTouched.current = true;
                  setNote(event.target.value);
                }}
                rows={3}
                placeholder="补充执行重点、边界或验收要求…"
                className="mt-1.5 w-full resize-y rounded-md border border-line bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent"
              />
            </label>
          </div>
        ) : (
          <DebateComposerFields
            value={debate}
            onChange={(next) => {
              if (next.topic !== debate.topic) topicTouched.current = true;
              setDebate(next);
            }}
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
  if (!worktree.on) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-faint">
        <TreeStructure size={12} className="shrink-0" />
        <span className="truncate">
          全局默认关闭 worktree · 将在项目目录工作{worktree.inheritsSource ? `，不含来源分支 ${worktree.sourceBranch} 的改动` : ""}
        </span>
      </span>
    );
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
