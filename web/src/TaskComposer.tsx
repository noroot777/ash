import { useEffect, useMemo, useRef, useState } from "react";
import type { Task, Group, AgentType, Priority, ProjectView, TeamConfig, TeamPresetConfig } from "@harness/shared";
import { AGENT_TYPES, DEFAULT_APP_SETTINGS } from "@harness/shared";
import { X, Robot, Stack, Sparkle, Scales, UsersThree } from "@phosphor-icons/react";
import { api } from "./api";
import { PRIORITIES } from "./constants";
import { PriorityIcon, LabelAdder, RunLocation } from "./ui";
import { groupLabel } from "./util";
import { useEscape } from "./useEscape";
import { Pill } from "./Menu";
import { usePasteAttachments, AttachmentChips } from "./pasteAttachments";
import { AttachmentDisplay } from "./messageAttachments";
import { ImagePreviewGroup } from "./ImagePreview";
import { toLocalInput } from "./ScheduleFields";
import { type ExecutorSelection, useExecutorProfiles } from "./ExecutorPicker";
import { teamExecutorDefaults } from "./teamExecutorDefaults";
import { createDebateConfig, DebateComposerFields } from "./DebateComposer";
import { TeamPresetBar } from "./TeamPresetBar";
import { toast } from "./toast";
import { TASK_MODES, LAUNCH_MODES, type ComposerMode, type LaunchMode } from "./composer/modes";
import { WorktreeField } from "./composer/WorktreeField";
import { ExecutorField, TeamExecutorFields } from "./composer/ExecutorFields";
import { ComposerFooter } from "./composer/ComposerFooter";

export type { ComposerMode } from "./composer/modes";

// 正文和底部操作条共用的限宽，让内容在宽屏上仍然像一封「信」而不是摊开的表单。
const COL = "w-full max-w-[760px]";

// 内嵌在任务详情区里的新建面板（单任务 / 团队 / 辩论三合一）。它不是弹层：右侧
// 区域直接切成这张单子，正文占主体、底部操作条钉在面板底边。可选标题留空时各模式
// 沿用原有的自动起名策略。
export function TaskComposer({
  project,
  groups,
  mode,
  onMode,
  onCancel,
  onDone,
  onCreated,
  onCreateGroup,
  onOpenAgents,
  initialBody,
  initialAttachments,
}: {
  project: ProjectView;
  groups: Group[];
  mode: ComposerMode;
  onMode: (m: ComposerMode) => void;
  // 放弃这张单子（X / Esc）：由宿主恢复打开前选中的任务。
  onCancel: () => void;
  // 建完且没开「再建一个」：关闭面板，右侧切回刚建出来的任务。
  onDone: () => void;
  onCreated: (t: Task) => void;
  onCreateGroup: () => void;
  onOpenAgents?: () => void;
  initialBody?: string;
  initialAttachments?: string[];
}) {
  const projectId = project.id;
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  useEscape(onCancel, !presetDialogOpen);
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
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
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
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [reviewerPick, setReviewerPick] = useState<ExecutorSelection | null>(null);
  const [reviewerModel, setReviewerModel] = useState("");
  const [reviewerReasoningEffort, setReviewerReasoningEffort] = useState("");
  const [detected, setDetected] = useState<{ type: AgentType; available: boolean; resident: boolean }[] | null>(null);
  const { profiles, providers } = useExecutorProfiles();

  // Start at the factory default immediately, then hydrate from the server-side
  // global setting. Failed reads intentionally stay at true. If the user toggles
  // before the request returns, their in-progress choice is never overwritten.
  const [worktreeDefault, setWorktreeDefault] = useState(DEFAULT_APP_SETTINGS.worktreeDefault);
  const [useWorktree, setUseWorktree] = useState(DEFAULT_APP_SETTINGS.worktreeDefault);
  const [savingWorktreeDefault, setSavingWorktreeDefault] = useState(false);
  const worktreeChoiceTouched = useRef(false);
  const [base, setBase] = useState(""); // empty = current HEAD
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    api.settings().then((settings) => {
      if (!alive) return;
      setWorktreeDefault(settings.worktreeDefault);
      if (!worktreeChoiceTouched.current) setUseWorktree(settings.worktreeDefault);
    }).catch(() => {
      // Factory fallback is already applied; creation can continue unattended.
    });
    return () => { alive = false; };
  }, []);
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
  const toggleWorktree = () => {
    worktreeChoiceTouched.current = true;
    setUseWorktree((value) => !value);
  };
  const saveWorktreeDefault = async () => {
    if (savingWorktreeDefault || useWorktree === worktreeDefault) return;
    setSavingWorktreeDefault(true);
    try {
      const settings = await api.patchSettings({ worktreeDefault: useWorktree });
      setWorktreeDefault(settings.worktreeDefault);
      toast(`已把“${useWorktree ? "使用 worktree" : "不使用 worktree"}”设为全局默认`, "info");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingWorktreeDefault(false);
    }
  };
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
  const reviewerSelection = reviewerPick && workerTypes.includes(reviewerPick.agentType)
    ? reviewerPick
    : { agentType: workerSelection.agentType, executorId: null };
  const currentTeamPresetConfig: TeamPresetConfig = {
    lead,
    worker,
    leadExecutorId: leadSelection.executorId,
    workerExecutorId: workerSelection.executorId,
    leadModel: leadModel || null,
    leadReasoningEffort: leadReasoningEffort || null,
    workerModel: workerModel || null,
    workerReasoningEffort: workerReasoningEffort || null,
    review: reviewEnabled,
    reviewerAgentType: reviewerSelection.agentType,
    reviewerExecutorId: reviewerSelection.executorId,
    reviewerModel: reviewerModel || null,
    reviewerReasoningEffort: reviewerReasoningEffort || null,
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
    const requestedReviewerType = config.reviewerAgentType ?? config.worker;
    const reviewerType = detected === null || workerTypes.includes(requestedReviewerType)
      ? requestedReviewerType
      : workerSelection.agentType;
    const reviewerCompatible = reviewerType === requestedReviewerType;
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
    setReviewEnabled(config.review !== false);
    setReviewerPick({
      agentType: reviewerType,
      executorId: reviewerCompatible ? config.reviewerExecutorId ?? null : null,
    });
    setReviewerModel(reviewerCompatible ? config.reviewerModel ?? "" : "");
    setReviewerReasoningEffort(reviewerCompatible ? config.reviewerReasoningEffort ?? "" : "");
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
    if (reviewerPick && !workerTypes.includes(reviewerPick.agentType)) {
      setReviewerPick({ agentType: workerSelection.agentType, executorId: null });
      setReviewerModel("");
      setReviewerReasoningEffort("");
    }
  }, [detected, leadPick, workerPick, reviewerPick, leadTypes, workerTypes, leadSelection, workerSelection]);

  const submit = async () => {
    const obj = body.trim();
    const topic = debate.topic.trim();
    const hasTaskContent = !!obj || seedAttachments.length > 0 || attachments.length > 0;
    if ((debateOn ? !topic : !hasTaskContent) || busy) return;
    // A timed mode needs its time/expr (guards the Cmd/Ctrl+Enter path, which skips the button).
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
        review: reviewEnabled,
        reviewerAgentType: reviewerSelection.agentType,
        reviewerExecutorId: reviewerSelection.executorId,
        reviewerModel: reviewerModel || null,
        reviewerReasoningEffort: reviewerReasoningEffort || null,
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
            // 普通/团队共用全局默认；团队开启后，调度台和默认执行者共用同一个
            // worktree。执行者自己再显式 opt-in 时才另开一层隔离。
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
        onDone();
      }
    } finally {
      setBusy(false);
    }
  };

  const selectedGroup = groups.find((g) => g.id === groupId);
  const groupTrigger = selectedGroup ? groupLabel(selectedGroup) : "分组";
  const prioLabel = priority === "none" ? "优先级" : PRIORITIES.find((p) => p.key === priority)!.label;

  const active = LAUNCH_MODES.find((m) => m.key === launchMode)!;
  // 留空时各模式的自动起名策略，直接排进名称输入框的占位层。
  const autoTitleHint = debateOn
    ? { icon: <Scales size={12} className="text-violet-600" />, text: "留空时由辩论议题生成名称" }
    : teamOn
      ? { icon: <UsersThree size={12} weight="fill" className="text-accent/70" />, text: "留空时使用目标首行作为名称" }
      : { icon: <Sparkle size={12} weight="fill" className="text-accent/70" />, text: "留空时由首个执行的 agent 自动生成名称" };
  const runLocation = <RunLocation project={project} />;
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
    <main
      className="t-composer-enter flex h-full min-h-0 flex-col"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-6 py-3">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-raised px-1.5 py-0.5 text-[12px] font-medium text-ink">
          <span className="grid h-4 w-4 place-items-center rounded bg-accent text-[9px] font-semibold text-accent-fg">
            {project.name.slice(0, 1).toUpperCase()}
          </span>
          {project.name}
        </span>
        <span className="text-faint">›</span>
        <span className="text-[13px] font-medium text-muted">新建任务</span>
        <button
          onClick={onCancel}
          className="ml-auto grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink"
          title="关闭 Esc"
        >
          <X size={16} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`${COL} mx-auto flex min-h-full flex-col px-6 py-5`}>
          <div className="grid grid-cols-3 rounded-lg bg-raised p-1" role="tablist" aria-label="任务模式">
            {TASK_MODES.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={mode === item.key}
                onClick={() => onMode(item.key)}
                className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
                  mode === item.key ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
          {/* 名称：自动起名的说明直接长在输入框里（13px「任务名称」+ 11px 括号小字），
              省掉下面那行独立提示——它说的本来就是「这个框留空会怎样」。 */}
          <div className="relative mt-3">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              // 占位是自绘覆盖层（原生 placeholder 混不了两种字号），所以标签走 aria。
              aria-label="任务名称"
              // 右侧常驻留白：给「不再自动改名」那枚内嵌小字占好位置，免得它出现/消失时文字跳动。
              className="w-full rounded-md border border-line bg-canvas py-1.5 pl-3 pr-[76px] text-[13px] text-ink outline-none focus:border-accent"
            />
            {title.trim() ? (
              <span
                className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[10px] text-faint"
                title="将使用这个名称，不再自动改名"
              >
                不再自动改名
              </span>
            ) : (
              <span className="pointer-events-none absolute inset-y-0 left-3 right-3 flex items-center gap-1 whitespace-nowrap text-faint">
                <span className="shrink-0 text-[13px]">任务名称</span>
                <span className="flex min-w-0 items-center text-[11px]">
                  <span className="shrink-0">（</span>
                  <span className="shrink-0">{autoTitleHint.icon}</span>
                  <span className="ml-1 truncate">{autoTitleHint.text}</span>
                  <span className="shrink-0">）</span>
                </span>
              </span>
            )}
          </div>

          {/* 运行位置 + worktree：同一行给出「这次跑在哪」。开着 worktree 时行尾是
              base → 新分支，关着时是项目目录（RunLocation，含目录异常的 amber 警告）。 */}
          {!debateOn && project.health.isRepo ? (
            <div className="mt-2.5">
              <WorktreeField
                taskIdPreview={taskIdPreview}
                team={teamOn}
                on={useWorktree}
                base={base}
                branches={branches}
                isGlobalDefault={useWorktree === worktreeDefault}
                savingDefault={savingWorktreeDefault}
                trailing={runLocation}
                onToggle={toggleWorktree}
                onSetDefault={() => void saveWorktreeDefault()}
                onBase={setBase}
              />
            </div>
          ) : (
            // 辩论模式和非 git 项目没有 worktree 开关，运行位置照旧独占一行。
            <div className="mt-2.5">{runLocation}</div>
          )}
          {teamOn && (
            <TeamPresetBar
              className="pt-3"
              currentConfig={currentTeamPresetConfig}
              profiles={profiles}
              onApply={applyTeamPreset}
              onDialogOpenChange={setPresetDialogOpen}
            />
          )}

          {debateOn ? (
            <div className="mt-3 min-h-0 flex-1">
              <DebateComposerFields
                fill
                value={debate}
                onChange={setDebate}
                profiles={profiles}
                providers={providers}
                onOpenAgents={onOpenAgents}
              />
            </div>
          ) : (
            <div className="mt-3 flex min-h-0 flex-1 flex-col">
              <textarea
                ref={objRef}
                autoFocus
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onPaste={onPaste}
                placeholder={teamOn
                  ? "给调度者的目标…（它会自己拆活、派执行者、有问题问你）"
                  : "描述要做什么 / 给 agent 的目标…"}
                className="min-h-[180px] flex-1 resize-none rounded-md border border-line bg-canvas px-3 py-2 text-[14px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent"
              />
              {teamOn && (
                <div className="flex items-center gap-1 pb-1 pt-1.5 text-[11px] text-faint">
                  <UsersThree size={12} weight="fill" className="text-accent/70" />
                  调度者常驻不断线：随时插话改方向
                </div>
              )}
              <ImagePreviewGroup>
                <AttachmentChips attachments={attachments} onRemove={remove} error={error} />
                <AttachmentDisplay
                  paths={seedAttachments}
                  className="pt-2"
                  onRemove={(path) => setSeedAttachments((paths) => paths.filter((item) => item !== path))}
                />
              </ImagePreviewGroup>
            </div>
          )}

          {/* Property pills */}
          {!debateOn && (
            <div className="flex flex-wrap items-center gap-1.5 pt-3">
              {teamOn ? (
                <TeamExecutorFields
                  lead={{
                    selection: leadSelection,
                    types: leadTypes,
                    model: leadModel,
                    reasoningEffort: leadReasoningEffort,
                    onSelect: setLeadPick,
                    onModel: setLeadModel,
                    onReasoningEffort: setLeadReasoningEffort,
                  }}
                  worker={{
                    selection: workerSelection,
                    types: workerTypes,
                    model: workerModel,
                    reasoningEffort: workerReasoningEffort,
                    onSelect: setWorkerPick,
                    onModel: setWorkerModel,
                    onReasoningEffort: setWorkerReasoningEffort,
                  }}
                  reviewer={{
                    selection: reviewerSelection,
                    types: workerTypes,
                    model: reviewerModel,
                    reasoningEffort: reviewerReasoningEffort,
                    onSelect: setReviewerPick,
                    onModel: setReviewerModel,
                    onReasoningEffort: setReviewerReasoningEffort,
                  }}
                  reviewEnabled={reviewEnabled}
                  onReviewEnabled={setReviewEnabled}
                  profiles={profiles}
                  providers={providers}
                  onOpenAgents={onOpenAgents}
                />
              ) : (
                <ExecutorField
                  icon={<Robot size={14} />}
                  selection={executorPick}
                  types={[...AGENT_TYPES]}
                  profiles={profiles}
                  providers={providers}
                  model={model}
                  reasoningEffort={reasoningEffort}
                  onSelect={setExecutorPick}
                  onModel={setModel}
                  onReasoningEffort={setReasoningEffort}
                  onOpenAgents={onOpenAgents}
                />
              )}

              <Pill icon={<Stack size={14} />} label={groupTrigger} value={groupId} onChange={(v) => (v === "__new" ? onCreateGroup() : setGroupId(v))} options={[{ value: "", label: "无分组" }, ...groups.map((g) => ({ value: g.id, label: groupLabel(g) })), { value: "__new", label: "+ 新建分组" }]} />
              <Pill icon={<PriorityIcon p={priority} />} label={prioLabel} value={priority} onChange={(v) => setPriority(v as Priority)} options={PRIORITIES.map((p) => ({ value: p.key, label: p.label }))} />
              {labels.map((l) => (
                <button key={l} onClick={() => setLabels((ls) => ls.filter((x) => x !== l))} className="rounded-full bg-overlay px-2 py-1 text-[12px] text-ink hover:line-through" title="移除">
                  {l}
                </button>
              ))}
              <LabelAdder onAdd={(l) => !labels.includes(l) && setLabels((ls) => [...ls, l])} />
            </div>
          )}
        </div>
      </div>

      <ComposerFooter
        width={COL}
        debateOn={debateOn}
        launchMode={launchMode}
        at={at}
        cron={cron}
        more={more}
        canSubmit={canSubmit}
        submitLabel={debateOn ? "开跑" : active.btn}
        onAt={setAt}
        onCron={setCron}
        onLaunchMode={pickMode}
        onMore={() => setMore((v) => !v)}
        onSubmit={submit}
      />
    </main>
  );
}
