import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Task, Group, AgentType, Priority, ProjectView, TeamConfig, TeamPresetConfig } from "@harness/shared";
import { AGENT_TYPES } from "@harness/shared";
import { X, ArrowsOut, ArrowsIn, Robot, Stack, Plus, Sparkle, Scales, CaretDown, Clock, Play, Tray, ArrowsClockwise, GitBranch, TreeStructure, UsersThree, Crown } from "@phosphor-icons/react";
import { api } from "./api";
import { PRIORITIES } from "./constants";
import { PriorityIcon, LabelAdder, RunLocation } from "./ui";
import { groupLabel } from "./util";
import { useEscape } from "./useEscape";
import { Menu, Pill } from "./Menu";
import { usePasteAttachments, AttachmentChips } from "./pasteAttachments";
import { AttachmentDisplay } from "./messageAttachments";
import { ScheduleFields, toLocalInput } from "./ScheduleFields";
import { ExecutorPicker, type ExecutorSelection, useExecutorProfiles } from "./ExecutorPicker";
import { teamExecutorDefaults } from "./teamExecutorDefaults";
import { createDebateConfig, DebateComposerFields } from "./DebateComposer";
import { TaskModelControls } from "./TaskModelControls";
import { TeamPresetBar } from "./TeamPresetBar";

export type CreateTaskMode = "single" | "team" | "debate";
const TASK_MODES: { key: CreateTaskMode; label: string; icon: ReactNode }[] = [
  { key: "single", label: "普通任务", icon: <Robot size={15} /> },
  { key: "team", label: "团队任务", icon: <UsersThree size={15} /> },
  { key: "debate", label: "辩论", icon: <Scales size={15} /> },
];

// 启动时机 (§9)：创建一个任务时「什么时候开始跑」。create=仅落 backlog；run=建完
// 立即跑（默认）；once/cron=挂定时，由调度器到点入队（不立即跑）。
type LaunchMode = "create" | "run" | "once" | "cron";
const LAUNCH_MODES: { key: LaunchMode; label: string; detail: string; icon: ReactNode; btn: string }[] = [
  { key: "create", label: "仅创建", detail: "进待办，手动再跑", icon: <Tray size={15} />, btn: "创建任务" },
  { key: "run", label: "创建并执行", detail: "立即开跑", icon: <Play size={15} weight="fill" />, btn: "创建并执行" },
  { key: "once", label: "一次性…", detail: "约定时间跑一次", icon: <Clock size={15} />, btn: "创建并定时" },
  { key: "cron", label: "循环…", detail: "按周期反复跑", icon: <ArrowsClockwise size={15} />, btn: "创建并定时" },
];

// Unified composer for single, team, and debate tasks. The optional title is
// explicit; leaving it blank preserves each mode's existing auto-title policy.
export function CreateTask({
  project,
  groups,
  onClose,
  onCreated,
  onCreateGroup,
  onOpenAgents,
  initialMode = "single",
  initialBody,
  initialAttachments,
}: {
  project: ProjectView;
  groups: Group[];
  onClose: () => void;
  onCreated: (t: Task) => void;
  onCreateGroup: () => void;
  onOpenAgents?: () => void;
  initialMode?: CreateTaskMode;
  initialBody?: string;
  initialAttachments?: string[];
}) {
  const projectId = project.id;
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  useEscape(onClose, !presetDialogOpen);
  const [mode, setMode] = useState<CreateTaskMode>(initialMode);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState(initialBody ?? "");
  const [debate, setDebate] = useState(createDebateConfig);
  const [seedAttachments, setSeedAttachments] = useState(initialAttachments ?? []);
  const [priority, setPriority] = useState<Priority>("none");
  const [executorPick, setExecutorPick] = useState<ExecutorSelection>({ agentType: "claude", executorId: null });
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [groupId, setGroupId] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [launchMode, setLaunchMode] = useState<LaunchMode>("run"); // 默认：建完立即跑
  const [at, setAt] = useState(""); // datetime-local value (once)
  const [cron, setCron] = useState("0 9 * * *"); // 5-field expr (cron)
  // 团队模式就地把这张单子改成「建一个常驻调度台」。
  // lead/worker 存的是**用户显式挑过的那个**,没挑就现算(见下面的 lead/worker) ——
  // 这样本机执行器的探测结果晚到也能把缺省补对,而用户挑过的永远不被覆盖。
  const teamOn = mode === "team";
  const debateOn = mode === "debate";
  const [leadPick, setLeadPick] = useState<ExecutorSelection | null>(null);
  const [workerPick, setWorkerPick] = useState<ExecutorSelection | null>(null);
  const [leadModel, setLeadModel] = useState("");
  const [leadReasoningEffort, setLeadReasoningEffort] = useState("");
  const [workerModel, setWorkerModel] = useState("");
  const [workerReasoningEffort, setWorkerReasoningEffort] = useState("");
  const [detected, setDetected] = useState<{ type: AgentType; available: boolean; resident: boolean }[] | null>(null);
  const { profiles, providers } = useExecutorProfiles();

  // Per-task worktree opt-in. When on, the server creates <repo>/.worktrees/<id>
  // on a fresh `harness/<id8>` branch off the user-picked base before running.
  // Toggle is only meaningful for git projects; for non-repos we hide it.
  const [useWorktree, setUseWorktree] = useState(false);
  const [base, setBase] = useState(""); // empty = current HEAD
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  // Lazy-load branches the first time the toggle opens — non-repos still get an
  // empty list so the menu degrades gracefully.
  useEffect(() => {
    if (!useWorktree || branchesLoaded) return;
    let alive = true;
    api.projectBranches(project.id).then((r) => {
      if (!alive) return;
      setBranches(r.branches);
      if (!base && r.current) setBase(r.current);
      setBranchesLoaded(true);
    }).catch(() => alive && setBranchesLoaded(true));
    return () => { alive = false; };
  }, [useWorktree, branchesLoaded, project.id, base]);
  const objRef = useRef<HTMLTextAreaElement>(null);
  const { attachments, onPaste, remove, clear, error } = usePasteAttachments();

  // 只有切到团队模式才探测本机装了哪些 CLI(几个 which + --version,不值得每次开单子都跑)。
  useEffect(() => {
    if (!teamOn || detected) return;
    let alive = true;
    api.detectAgents().then(
      (d) => alive && setDetected(d),
      () => alive && setDetected([]),
    );
    return () => { alive = false; };
  }, [teamOn, detected]);

  const { leadTypes, workerTypes, leadSelection, workerSelection } = useMemo(
    () => teamExecutorDefaults(detected, leadPick, workerPick),
    [detected, leadPick, workerPick],
  );
  const lead = leadSelection.agentType;
  const worker = workerSelection.agentType;
  const currentTeamPresetConfig: TeamPresetConfig = {
    lead,
    worker,
    leadExecutorId: leadSelection.executorId,
    workerExecutorId: workerSelection.executorId,
    leadModel: leadModel || null,
    leadReasoningEffort: leadReasoningEffort || null,
    workerModel: workerModel || null,
    workerReasoningEffort: workerReasoningEffort || null,
  };
  const applyTeamPreset = (config: TeamPresetConfig) => {
    const leadType = detected === null || leadTypes.includes(config.lead)
      ? config.lead
      : leadSelection.agentType;
    const workerType = detected === null || workerTypes.includes(config.worker)
      ? config.worker
      : workerSelection.agentType;
    const leadCompatible = leadType === config.lead;
    const workerCompatible = workerType === config.worker;
    setLeadPick({
      agentType: leadType,
      executorId: leadCompatible ? config.leadExecutorId ?? null : null,
    });
    setWorkerPick({
      agentType: workerType,
      executorId: workerCompatible ? config.workerExecutorId ?? null : null,
    });
    setLeadModel(leadCompatible ? config.leadModel ?? "" : "");
    setLeadReasoningEffort(leadCompatible ? config.leadReasoningEffort ?? "" : "");
    setWorkerModel(workerCompatible ? config.workerModel ?? "" : "");
    setWorkerReasoningEffort(workerCompatible ? config.workerReasoningEffort ?? "" : "");
  };

  // Agent detection can finish after a preset was clicked. If that reveals the
  // chosen type cannot fill its role on this machine, degrade the whole role
  // config together instead of leaving a model/effort from an incompatible CLI.
  useEffect(() => {
    if (detected === null) return;
    if (leadPick && !leadTypes.includes(leadPick.agentType)) {
      setLeadPick({ agentType: leadSelection.agentType, executorId: null });
      setLeadModel("");
      setLeadReasoningEffort("");
    }
    if (workerPick && !workerTypes.includes(workerPick.agentType)) {
      setWorkerPick({ agentType: workerSelection.agentType, executorId: null });
      setWorkerModel("");
      setWorkerReasoningEffort("");
    }
  }, [detected, leadPick, workerPick, leadTypes, workerTypes, leadSelection, workerSelection]);

  const submit = async () => {
    const obj = body.trim();
    const topic = debate.topic.trim();
    const hasTaskContent = !!obj || seedAttachments.length > 0 || attachments.length > 0;
    if ((debateOn ? !topic : !hasTaskContent) || busy) return;
    // A timed mode needs its time/expr (guards the ⌘↵ path, which skips the button).
    if (!debateOn && ((launchMode === "once" && !at) || (launchMode === "cron" && !cron.trim()))) return;
    setBusy(true);
    try {
      const explicitTitle = title.trim();
      const content = debateOn ? topic : obj;
      const provisionalTitle = content.split("\n")[0].slice(0, 30) || (debateOn ? "新建辩论" : "未命名任务");
      const team: TeamConfig = {
        lead,
        worker,
        leadExecutorId: leadSelection.executorId,
        workerExecutorId: workerSelection.executorId,
        leadModel: leadModel || null,
        leadReasoningEffort: leadReasoningEffort || null,
        workerModel: workerModel || null,
        workerReasoningEffort: workerReasoningEffort || null,
      };
      const t = debateOn
        ? await api.createTask({
            projectId,
            title: explicitTitle || provisionalTitle,
            mode: "debate",
            autoTitle: !explicitTitle,
            debate: { ...debate, topic, style: "debate" },
          })
        : await api.createTask({
            projectId,
            title: explicitTitle || provisionalTitle,
            body: obj,
            attachments: [...new Set([...seedAttachments, ...attachments.map((a) => a.path)])],
            mode: teamOn ? "team" : "single",
            // 团队任务的执行器由 team.lead 决定;agentType 跟着填一份,好让只认这个字段的
            // 列表/徽标显示对。
            agentType: teamOn ? lead : executorPick.agentType,
            executorId: teamOn ? null : executorPick.executorId,
            ...(teamOn
              ? { team }
              : {
                  model: model || null,
                  reasoningEffort: reasoningEffort || null,
                }),
            priority,
            labels,
            // 自定义名称一律关闭自动起名；留空时普通任务由首个 agent 起名，团队任务
            // 继续直接使用正文首行（调度台没有普通任务的首回合起名协议）。
            autoTitle: explicitTitle ? false : !teamOn,
            // 默认仍直接在项目目录跑；团队显式开启后，调度台和默认执行者共用
            // 同一个 worktree。执行者自己再 opt-in 时才另开一层隔离。
            useWorktree: project.health.isRepo ? useWorktree : false,
            worktreeBase: useWorktree && base ? base : null,
          });
      onCreated(t);
      // 启动时机：run=立即跑；once/cron=挂定时（调度器到点入队，不在此刻跑）；
      // create=什么都不做（任务停在 backlog，手动再运行）。
      if (debateOn || launchMode === "run") await api.runTask(t.id);
      else if (launchMode === "once") await api.setSchedule(t.id, { kind: "once", at: new Date(at).toISOString() });
      else if (launchMode === "cron") await api.setSchedule(t.id, { kind: "cron", cron: cron.trim() });
      if (more) {
        setTitle("");
        setBody("");
        setDebate(createDebateConfig());
        setLabels([]);
        setSeedAttachments([]);
        clear();
        objRef.current?.focus();
      } else {
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  const selectedGroup = groups.find((g) => g.id === groupId);
  const groupTrigger = selectedGroup ? groupLabel(selectedGroup) : "分组";
  const prioLabel = priority === "none" ? "优先级" : PRIORITIES.find((p) => p.key === priority)!.label;

  const active = LAUNCH_MODES.find((m) => m.key === launchMode)!;
  // The exact derived branch (`harness/<id8>`) is only known after the server
  // mints the task id — show a generic preview so the user knows the format.
  const taskIdPreview = "harness/<id8>";
  // A scheduled mode needs a valid time/expr before it can submit.
  const schedInvalid = !debateOn && ((launchMode === "once" && !at) || (launchMode === "cron" && !cron.trim()));
  const canSubmit = (debateOn
    ? !!debate.topic.trim()
    : !!body.trim() || seedAttachments.length > 0 || attachments.length > 0) && !busy && !schedInvalid;
  const pickMode = (m: LaunchMode) => {
    if (m === "once" && !at) setAt(toLocalInput(new Date(Date.now() + 3600_000).toISOString())); // 默认 +1h
    setLaunchMode(m);
  };

  return (
    <div className={`${initialBody !== undefined ? "t-modal-overlay" : ""} fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]`} onClick={onClose}>
      <div
        className={`${initialBody !== undefined ? "t-modal note-task-enter" : ""} flex flex-col overflow-visible rounded-xl border border-line2 bg-panel shadow-2xl transition-all ${
          expanded ? "h-[78vh] w-[920px]" : "w-[640px]"
        } max-w-[94vw]`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      >
        {/* Header / breadcrumb */}
        <div className="flex items-center gap-2 px-4 pt-3.5">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-raised px-1.5 py-0.5 text-[12px] font-medium text-ink">
            <span className="grid h-4 w-4 place-items-center rounded bg-accent text-[9px] font-semibold text-accent-fg">
              {project.name.slice(0, 1).toUpperCase()}
            </span>
            {project.name}
          </span>
          <span className="text-faint">›</span>
          <span className="text-[13px] font-medium text-muted">新建任务</span>

          <div className="ml-auto flex items-center gap-1">
            <button onClick={() => setExpanded((v) => !v)} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink" title={expanded ? "收起" : "展开"}>
              {expanded ? <ArrowsIn size={15} /> : <ArrowsOut size={15} />}
            </button>
            <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink" title="关闭 Esc">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="px-4 pt-3">
          <div className="grid grid-cols-3 rounded-lg bg-raised p-1" role="tablist" aria-label="任务模式">
            {TASK_MODES.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={mode === item.key}
                onClick={() => setMode(item.key)}
                className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
                  mode === item.key ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="任务名称（可选）"
            className="mt-2.5 w-full rounded-md border border-line bg-canvas px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint focus:border-accent"
          />
          <div className="mt-1 flex items-center gap-1 text-[11px] text-faint">
            {title.trim() ? (
              <>将使用这个名称，不再自动改名</>
            ) : debateOn ? (
              <><Scales size={12} className="text-violet-600" />留空时由辩论议题生成名称</>
            ) : teamOn ? (
              <><UsersThree size={12} weight="fill" className="text-accent/70" />留空时使用目标首行作为名称</>
            ) : (
              <><Sparkle size={12} weight="fill" className="text-accent/70" />留空时由首个执行的 agent 自动生成名称</>
            )}
          </div>
        </div>
        {/* Run location — agents run in this dir (or a temp dir if it's missing) */}
        <div className="px-4 pt-1.5">
          <RunLocation project={project} />
        </div>
        {!debateOn && project.health.isRepo && (
          <WorktreeField
            taskIdPreview={taskIdPreview}
            team={teamOn}
            on={useWorktree}
            base={base}
            branches={branches}
            onToggle={() => setUseWorktree((v) => !v)}
            onBase={setBase}
          />
        )}
        {teamOn && (
          <TeamPresetBar
            currentConfig={currentTeamPresetConfig}
            profiles={profiles}
            onApply={applyTeamPreset}
            onDialogOpenChange={setPresetDialogOpen}
          />
        )}

        {debateOn ? (
          <div className={`min-h-0 px-4 pt-3 ${expanded ? "flex-1" : ""}`}>
            <DebateComposerFields
              value={debate}
              onChange={setDebate}
              profiles={profiles}
              providers={providers}
              onOpenAgents={onOpenAgents}
            />
          </div>
        ) : (
          <div className={`relative flex min-h-0 flex-col px-4 pt-3 ${expanded ? "flex-1" : ""}`}>
            <textarea
              ref={objRef}
              autoFocus
              value={body}
              onChange={(event) => setBody(event.target.value)}
              onPaste={onPaste}
              placeholder={teamOn
                ? "给调度者的目标…（它会自己拆活、派执行者、有问题问你）"
                : "描述要做什么 / 给 agent 的目标…"}
              className={`resize-y bg-transparent text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint ${
                expanded ? "flex-1" : "min-h-[88px]"
              }`}
            />
            {teamOn && (
              <div className="flex items-center gap-1 pb-1 text-[11px] text-faint">
                <UsersThree size={12} weight="fill" className="text-accent/70" />
                调度者常驻不断线：随时插话改方向
              </div>
            )}
            <AttachmentChips attachments={attachments} onRemove={remove} error={error} />
            <AttachmentDisplay
              paths={seedAttachments}
              className="pt-2"
              onRemove={(path) => setSeedAttachments((paths) => paths.filter((item) => item !== path))}
            />
          </div>
        )}

        {/* Property pills */}
        {!debateOn && <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3 pt-3">
          {teamOn ? (
            <>
              <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-raised/50 p-1">
                <ExecutorPicker
                  icon={<Crown size={14} />}
                  selection={leadSelection}
                  onSelect={(next) => {
                    if (next.agentType !== leadSelection.agentType) {
                      setLeadModel("");
                      setLeadReasoningEffort("");
                    }
                    setLeadPick(next);
                  }}
                  profiles={profiles}
                  providers={providers}
                  types={leadTypes}
                  label={`调度者 ${profiles.find((a) => a.id === leadSelection.executorId)?.name ?? `默认 ${lead}`}`}
                  includeManage={!!onOpenAgents}
                  onOpenAgents={onOpenAgents}
                  menuWidth={320}
                />
                <TaskModelControls
                  selection={leadSelection}
                  profiles={profiles}
                  providers={providers}
                  model={leadModel}
                  reasoningEffort={leadReasoningEffort}
                  onModelChange={setLeadModel}
                  onReasoningEffortChange={setLeadReasoningEffort}
                />
              </div>
              <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-raised/50 p-1">
                <ExecutorPicker
                  icon={<Robot size={14} />}
                  selection={workerSelection}
                  onSelect={(next) => {
                    if (next.agentType !== workerSelection.agentType) {
                      setWorkerModel("");
                      setWorkerReasoningEffort("");
                    }
                    setWorkerPick(next);
                  }}
                  profiles={profiles}
                  providers={providers}
                  types={workerTypes}
                  label={`执行者 ${profiles.find((a) => a.id === workerSelection.executorId)?.name ?? `默认 ${worker}`}`}
                  includeManage={!!onOpenAgents}
                  onOpenAgents={onOpenAgents}
                  menuWidth={320}
                />
                <TaskModelControls
                  selection={workerSelection}
                  profiles={profiles}
                  providers={providers}
                  model={workerModel}
                  reasoningEffort={workerReasoningEffort}
                  onModelChange={setWorkerModel}
                  onReasoningEffortChange={setWorkerReasoningEffort}
                />
              </div>
            </>
          ) : (
            <>
              <ExecutorPicker
                icon={<Robot size={14} />}
                selection={executorPick}
                onSelect={(next) => {
                  if (next.agentType !== executorPick.agentType) {
                    setModel("");
                    setReasoningEffort("");
                  }
                  setExecutorPick(next);
                }}
                profiles={profiles}
                providers={providers}
                types={[...AGENT_TYPES]}
                includeManage={!!onOpenAgents}
                onOpenAgents={onOpenAgents}
                menuWidth={320}
              />
              <TaskModelControls
                selection={executorPick}
                profiles={profiles}
                providers={providers}
                model={model}
                reasoningEffort={reasoningEffort}
                onModelChange={setModel}
                onReasoningEffortChange={setReasoningEffort}
              />
            </>
          )}

          <Pill icon={<Stack size={14} />} label={groupTrigger} value={groupId} onChange={(v) => (v === "__new" ? onCreateGroup() : setGroupId(v))} options={[{ value: "", label: "无分组" }, ...groups.map((g) => ({ value: g.id, label: groupLabel(g) })), { value: "__new", label: "+ 新建分组" }]} />
          <Pill icon={<PriorityIcon p={priority} />} label={prioLabel} value={priority} onChange={(v) => setPriority(v as Priority)} options={PRIORITIES.map((p) => ({ value: p.key, label: p.label }))} />
          {labels.map((l) => (
            <button key={l} onClick={() => setLabels((ls) => ls.filter((x) => x !== l))} className="rounded-full bg-overlay px-2 py-1 text-[12px] text-ink hover:line-through" title="移除">
              {l}
            </button>
          ))}
          <LabelAdder onAdd={(l) => !labels.includes(l) && setLabels((ls) => [...ls, l])} />
        </div>}

        {/* Schedule strip — slides in only for the timed modes (once / cron) */}
        {!debateOn && (launchMode === "once" || launchMode === "cron") && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5 text-[12px]">
            <span className="inline-flex items-center gap-1.5 text-faint">
              {launchMode === "once" ? <Clock size={13} /> : <ArrowsClockwise size={13} />}
              {launchMode === "once" ? "一次性" : "循环"}
            </span>
            <ScheduleFields kind={launchMode} at={at} cron={cron} onAt={setAt} onCron={setCron} />
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-3 border-t border-line px-4 py-2.5">
          <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-[12px] text-muted">
            <span>再建一个</span>
            <button type="button" onClick={() => setMore((v) => !v)} className={`relative h-4 w-7 rounded-full transition-colors ${more ? "bg-accent" : "bg-line2"}`} aria-pressed={more}>
              <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-panel transition-all ${more ? "left-3.5" : "left-0.5"}`} />
            </button>
          </label>
          <div className="inline-flex items-stretch overflow-hidden rounded-md">
            <button disabled={!canSubmit} onClick={submit} className="inline-flex items-center gap-1.5 bg-accent px-3.5 py-1.5 text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-40">
              <Plus size={14} weight="bold" /> {debateOn ? "开跑" : active.btn}
            </button>
            {!debateOn && (
              <Menu
                value={launchMode}
                onChange={(v) => pickMode(v as LaunchMode)}
                options={LAUNCH_MODES.map((m) => ({ value: m.key, label: m.label, icon: m.icon, detail: m.detail }))}
                align="right"
                menuWidth={232}
                triggerClassName="grid place-items-center border-l border-accent-fg/20 bg-accent px-1.5 text-accent-fg transition-colors hover:bg-accent-hover"
              >
                <CaretDown size={13} weight="bold" />
              </Menu>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// 「在新 worktree 里跑」开关 + base 分支选择。和 RunLocation 同一视觉层，让用户
// 一眼看清「这次任务跑在哪、用哪个分支」。关闭时只占一行；开启时展开一个紧凑的
// base 选择面板（沿用 Pill / Menu 风格，和正文 Pill 一致）。
function WorktreeField({
  on,
  base,
  branches,
  taskIdPreview,
  team,
  onToggle,
  onBase,
}: {
  on: boolean;
  base: string;
  branches: string[];
  taskIdPreview: string;
  team: boolean;
  onToggle: () => void;
  onBase: (b: string) => void;
}) {
  const baseLabel = base || "当前分支";
  return (
    <div className="px-4 pt-1">
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-muted hover:bg-raised hover:text-ink"
        title={on ? "关闭：直接在项目目录跑" : team ? "开启：整支团队在同一个新 worktree 里跑" : "开启：本次任务在新 worktree 里跑"}
      >
        <TreeStructure size={12} className={on ? "text-accent" : "text-faint"} />
        <span>{team ? "团队共用 worktree" : "用 worktree 隔离"}</span>
        <span
          className={`relative ml-0.5 inline-block h-3 w-5 rounded-full transition-colors ${on ? "bg-accent" : "bg-line2"}`}
          aria-pressed={on}
        >
          <span className={`absolute top-0.5 h-2 w-2 rounded-full bg-panel transition-all ${on ? "left-2.5" : "left-0.5"}`} />
        </span>
      </button>
      {on && (
        <div className="ml-1 mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          <span className="text-faint">base</span>
          <Pill
            icon={<GitBranch size={11} />}
            label={baseLabel}
            value={base}
            onChange={onBase}
            options={[
              { value: "", label: "当前分支（HEAD）" },
              ...branches.map((b) => ({ value: b, label: b })),
            ]}
            menuWidth={220}
          />
          <span className="text-faint">→ 新分支 {taskIdPreview}</span>
        </div>
      )}
    </div>
  );
}
