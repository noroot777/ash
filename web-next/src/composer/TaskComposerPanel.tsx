import { useEffect, useMemo, useState } from "react";
import type { AgentExecutorProfile, AgentType, Group, Priority, ProjectView, Task, TaskMode } from "@harness/shared";
import {
  AGENT_TYPES,
  CLI_MODEL_PRESETS,
  DEFAULT_APP_SETTINGS,
  DEBATE_DEFAULTS,
  REASONING_EFFORT_VALUES,
} from "@harness/shared";
import { Paperclip, Play, Robot, Scales, UsersThree, X } from "@phosphor-icons/react";
import { Button, Toggle } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { AttachmentPicker, UploadAttachmentList, useAttachments } from "../task-detail/Attachments.tsx";
import { attachmentView } from "../task-detail/utils.ts";
import {
  emptyComposerExecutorConfigs,
  patchComposerExecutor,
  setComposerExecutorProfile,
  type ComposerExecutorRole,
} from "./executorOverrides.ts";

export type ComposerDraft = { body: string; attachments: string[]; noteIds?: string[] };

const MODES: { value: TaskMode; label: string; icon: typeof Robot }[] = [
  { value: "single", label: "单任务", icon: Robot },
  { value: "team", label: "团队", icon: UsersThree },
  { value: "debate", label: "辩论", icon: Scales },
];
const SLASHES = [
  { command: "/single", mode: "single" as const, label: "创建单任务" },
  { command: "/team", mode: "team" as const, label: "创建常驻团队" },
  { command: "/debate", mode: "debate" as const, label: "发起双智能体辩论" },
];
const PRIORITIES: { value: Priority; label: string }[] = [
  { value: "none", label: "无优先级" }, { value: "low", label: "低" }, { value: "medium", label: "中" }, { value: "high", label: "高" }, { value: "urgent", label: "紧急" },
];

function profileType(profiles: AgentExecutorProfile[], id: string, fallback: AgentType): AgentType {
  if (id.startsWith("__type:")) return id.slice(7) as AgentType;
  return profiles.find((profile) => profile.id === id)?.type ?? fallback;
}
function executorId(value: string) {
  return value && !value.startsWith("__type:") ? value : null;
}
function defaultProfile(profiles: AgentExecutorProfile[], type: AgentType) {
  return profiles.find((profile) => profile.type === type && profile.isDefault) ?? profiles.find((profile) => profile.type === type);
}
function profileLabel(profile: AgentExecutorProfile) {
  return `${profile.name}${profile.model ? ` · ${profile.model}` : ""}${profile.reasoningEffort ? ` · ${profile.reasoningEffort}` : ""}`;
}

function ExecutorSelect({ label, value, profiles, onChange }: { label: string; value: string; profiles: AgentExecutorProfile[]; onChange: (value: string) => void }) {
  return <label className="composer-field"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{AGENT_TYPES.map((type) => <option value={`__type:${type}`} key={`type:${type}`}>{type} · 类型默认</option>)}{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profileLabel(profile)}{profile.isDefault ? "（默认）" : ""}</option>)}</select></label>;
}

export function TaskComposerPanel({
  project,
  groups,
  initialDraft,
  mode,
  onModeChange,
  onCancel,
  onCreated,
  notify,
}: {
  project: ProjectView;
  groups: Group[];
  initialDraft?: ComposerDraft | null;
  mode: TaskMode;
  onModeChange: (mode: TaskMode) => void;
  onCancel: () => void;
  onCreated: (task: Task, draft?: ComposerDraft | null) => void;
  notify: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState(initialDraft?.body ?? "");
  const [seedAttachments, setSeedAttachments] = useState(initialDraft?.attachments ?? []);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [executors, setExecutors] = useState(emptyComposerExecutorConfigs);
  const [debaterAProfile, setDebaterAProfile] = useState("");
  const [debaterBProfile, setDebaterBProfile] = useState("");
  const [review, setReview] = useState(true);
  const [rounds, setRounds] = useState("3");
  const [gate, setGate] = useState(true);
  const [priority, setPriority] = useState<Priority>("none");
  const [groupId, setGroupId] = useState("");
  const [useWorktree, setUseWorktree] = useState(DEFAULT_APP_SETTINGS.worktreeDefault);
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState(false);
  const uploads = useAttachments();

  useEffect(() => {
    Promise.all([api.agents(), api.settings(), project.health.isRepo ? api.projectBranches(project.id) : Promise.resolve({ branches: [], current: null })]).then(([agents, settings, refs]) => {
      setProfiles(agents);
      const claude = defaultProfile(agents, "claude") ?? agents[0];
      const codex = defaultProfile(agents, "codex") ?? agents.find((profile) => profile.id !== claude?.id) ?? claude;
      setExecutors((current) => ({
        ...current,
        single: { ...current.single, profile: claude?.id ?? "__type:claude" },
        lead: { ...current.lead, profile: claude?.id ?? "__type:claude" },
        worker: { ...current.worker, profile: codex?.id ?? "__type:codex" },
        reviewer: { ...current.reviewer, profile: codex?.id ?? "__type:codex" },
      }));
      setDebaterAProfile(claude?.id ?? "__type:claude");
      setDebaterBProfile(codex?.id ?? "__type:codex");
      setUseWorktree(project.health.isRepo && settings.worktreeDefault);
      setBranches(refs.branches);
      setBase(refs.current ?? "");
    }).catch((error) => notify(error instanceof Error ? error.message : "新建任务配置读取失败"));
  }, [notify, project.health.isRepo, project.id]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);

  const allAttachments = useMemo(() => [...new Set([...seedAttachments, ...uploads.attachments.map((item) => item.path)])], [seedAttachments, uploads.attachments]);
  const slashCandidates = useMemo(() => {
    const match = /^\s*(\/\S*)$/.exec(body);
    return match ? SLASHES.filter((item) => item.command.startsWith(match[1]!.toLowerCase())) : [];
  }, [body]);
  const applySlash = (nextMode: TaskMode, rest = "") => { onModeChange(nextMode); setBody(rest); };
  const changeBody = (value: string) => {
    const parsed = /^\s*\/(single|team|debate)\s+([\s\S]*)$/i.exec(value);
    if (parsed) applySlash(parsed[1]!.toLowerCase() as TaskMode, parsed[2] ?? "");
    else setBody(value);
  };
  const changeExecutor = (role: ComposerExecutorRole, profile: string) => setExecutors((current) => setComposerExecutorProfile(current, role, profile));
  const changeOverride = (role: ComposerExecutorRole, patch: { model?: string; effort?: string }) => setExecutors((current) => patchComposerExecutor(current, role, patch));
  const selectedSingleType = profileType(profiles, executors.single.profile, "claude");
  const selectedLeadType = profileType(profiles, executors.lead.profile, "claude");
  const selectedWorkerType = profileType(profiles, executors.worker.profile, "codex");
  const selectedReviewerType = profileType(profiles, executors.reviewer.profile, selectedWorkerType);
  const canSubmit = (mode === "debate" ? !!body.trim() : !!body.trim() || allAttachments.length > 0) && !busy;

  const submit = async (run: boolean) => {
    if (!canSubmit) return;
    setBusy(true);
    let task: Task;
    try {
      const explicitTitle = title.trim();
      const provisionalTitle = body.trim().split(/\r?\n/)[0]!.slice(0, 42) || (mode === "debate" ? "新建辩论" : "未命名任务");
      const common = { projectId: project.id, title: explicitTitle || provisionalTitle, autoTitle: !explicitTitle && mode === "single", priority, groupId: groupId || null };
      if (mode === "debate") {
        task = await api.createTask({ ...common, mode, debate: {
          ...DEBATE_DEFAULTS,
          topic: body.trim(),
          debaterA: profileType(profiles, debaterAProfile, "claude"),
          debaterB: profileType(profiles, debaterBProfile, "codex"),
          debaterAExecutorId: executorId(debaterAProfile),
          debaterBExecutorId: executorId(debaterBProfile),
          maxRounds: rounds ? Math.max(1, Number(rounds) || 3) : null,
          gateG1: gate ? "on" : "off",
        } });
      } else if (mode === "team") {
        task = await api.createTask({ ...common, body: body.trim(), attachments: allAttachments, mode, agentType: selectedLeadType, useWorktree: project.health.isRepo && useWorktree, worktreeBase: useWorktree && base ? base : null, team: {
          lead: selectedLeadType,
          worker: selectedWorkerType,
          leadExecutorId: executorId(executors.lead.profile),
          workerExecutorId: executorId(executors.worker.profile),
          leadModel: executors.lead.model || null,
          workerModel: executors.worker.model || null,
          leadReasoningEffort: executors.lead.effort || null,
          workerReasoningEffort: executors.worker.effort || null,
          review,
          reviewerAgentType: selectedReviewerType,
          reviewerExecutorId: executorId(executors.reviewer.profile),
          reviewerModel: executors.reviewer.model || null,
          reviewerReasoningEffort: executors.reviewer.effort || null,
        } });
      } else {
        task = await api.createTask({ ...common, body: body.trim(), attachments: allAttachments, mode, agentType: selectedSingleType, executorId: executorId(executors.single.profile), model: executors.single.model || null, reasoningEffort: executors.single.effort || null, useWorktree: project.health.isRepo && useWorktree, worktreeBase: useWorktree && base ? base : null });
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "任务创建失败");
      setBusy(false);
      return;
    }
    onCreated(task, initialDraft);
    if (!run) {
      notify("任务已创建");
      return;
    }
    try {
      await api.runTask(task.id);
      notify("任务已创建并启动");
    } catch (error) {
      notify(`任务已创建，但启动失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const modelField = (label: string, value: string, onChange: (value: string) => void, type: AgentType) => { const listId = `composer-models-${type}-${label}`; return <label className="composer-field"><span>{label}</span><input value={value} list={listId} onChange={(event) => onChange(event.target.value)} placeholder="跟随执行器" /><datalist id={listId}>{CLI_MODEL_PRESETS[type].map((item) => <option value={item} key={item} />)}</datalist></label>; };
  const effortField = (label: string, value: string, onChange: (value: string) => void, type: AgentType) => <label className="composer-field"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">跟随执行器</option>{REASONING_EFFORT_VALUES[type].map((item) => <option value={item} key={item}>{item}</option>)}</select></label>;

  return (
    <main className="task-composer-panel">
      <header className="composer-header"><span className="workspace-kind-chip">新建</span><b>新建任务</b><span>{project.name}</span><Button variant="ghost" onClick={onCancel}>取消 Esc</Button></header>
      <div className="composer-scroll"><div className="composer-inner">
        <div className="composer-tabs" role="tablist" aria-label="任务模式">{MODES.map((item) => { const Icon = item.icon; return <button type="button" role="tab" aria-selected={mode === item.value} key={item.value} onClick={() => onModeChange(item.value)}><Icon size={15} />{item.label}</button>; })}<span>切换模式不清空正文</span></div>
        <input className="composer-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="任务名称（可选；留空自动命名）" />
        <div className="composer-objective">
          <textarea autoFocus value={body} onChange={(event) => changeBody(event.target.value)} onPaste={uploads.onPaste} placeholder={mode === "team" ? "给调度者的目标…（可输入 /single 或 /debate 切换）" : mode === "debate" ? "要讨论并形成结论的议题…" : "描述要做什么…（可输入 /team 或 /debate）"} onKeyDown={(event) => {
            if (event.key === "Enter" && slashCandidates.length === 1 && body.trim() === slashCandidates[0]!.command) { event.preventDefault(); applySlash(slashCandidates[0]!.mode); }
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void submit(true); }
          }} />
          {!!slashCandidates.length && <div className="composer-slash-menu"><small>斜杠命令</small>{slashCandidates.map((item) => <button type="button" className="ui-selectable" key={item.command} onClick={() => applySlash(item.mode)}><b>{item.command}</b><span>{item.label}</span></button>)}</div>}
        </div>
        {mode !== "debate" && <><UploadAttachmentList attachments={uploads.attachments} error={uploads.error} onRemove={uploads.remove} />{!!seedAttachments.length && <div className="composer-seed-attachments">{seedAttachments.map((path) => { const view = attachmentView(path); return <span key={path}><Paperclip size={12} />{view.name}<button type="button" onClick={() => setSeedAttachments((current) => current.filter((item) => item !== path))}><X size={10} /></button></span>; })}</div>}</>}
        {mode === "debate" && allAttachments.length > 0 && <p className="composer-warning">辩论配置不接收附件；附件仍保留，切回单任务或团队后会随任务提交。</p>}
        <div className="composer-fields">
          {mode === "single" && <><ExecutorSelect label="执行器" value={executors.single.profile} profiles={profiles} onChange={(value) => changeExecutor("single", value)} />{modelField("模型", executors.single.model, (model) => changeOverride("single", { model }), selectedSingleType)}{effortField("思考强度", executors.single.effort, (effort) => changeOverride("single", { effort }), selectedSingleType)}</>}
          {mode === "team" && <><ExecutorSelect label="调度者执行器" value={executors.lead.profile} profiles={profiles} onChange={(value) => changeExecutor("lead", value)} /><ExecutorSelect label="执行者执行器" value={executors.worker.profile} profiles={profiles} onChange={(value) => changeExecutor("worker", value)} />{modelField("调度者模型", executors.lead.model, (model) => changeOverride("lead", { model }), selectedLeadType)}{modelField("执行者模型", executors.worker.model, (model) => changeOverride("worker", { model }), selectedWorkerType)}{effortField("调度者思考强度", executors.lead.effort, (effort) => changeOverride("lead", { effort }), selectedLeadType)}{effortField("执行者思考强度", executors.worker.effort, (effort) => changeOverride("worker", { effort }), selectedWorkerType)}<ExecutorSelect label="审查者执行器" value={executors.reviewer.profile} profiles={profiles} onChange={(value) => changeExecutor("reviewer", value)} />{modelField("审查者模型", executors.reviewer.model, (model) => changeOverride("reviewer", { model }), selectedReviewerType)}{effortField("审查者思考强度", executors.reviewer.effort, (effort) => changeOverride("reviewer", { effort }), selectedReviewerType)}<label className="composer-toggle-field"><span>自动审查</span><Toggle checked={review} onChange={setReview} label={review ? "已开启" : "已关闭"} /></label></>}
          {mode === "debate" && <><ExecutorSelect label="正方执行器" value={debaterAProfile} profiles={profiles} onChange={setDebaterAProfile} /><ExecutorSelect label="反方执行器" value={debaterBProfile} profiles={profiles} onChange={setDebaterBProfile} /><label className="composer-field"><span>最多轮数</span><select value={rounds} onChange={(event) => setRounds(event.target.value)}><option value="">不限</option>{[1, 2, 3, 5, 8].map((value) => <option value={value} key={value}>{value} 轮</option>)}</select></label><label className="composer-toggle-field"><span>共识闸门</span><Toggle checked={gate} onChange={setGate} label={gate ? "需要确认" : "自动结束"} /></label></>}
          {mode !== "debate" && project.health.isRepo && <><label className="composer-toggle-field"><span>worktree</span><Toggle checked={useWorktree} onChange={setUseWorktree} label={useWorktree ? "独立 worktree" : "直接使用项目目录"} /></label><label className="composer-field"><span>base 分支</span><select value={base} disabled={!useWorktree} onChange={(event) => setBase(event.target.value)}><option value="">当前 HEAD</option>{branches.map((branch) => <option value={branch} key={branch}>{branch}</option>)}</select></label></>}
          {mode !== "debate" && <label className="composer-field"><span>分组</span><select value={groupId} onChange={(event) => setGroupId(event.target.value)}><option value="">无分组</option>{groups.filter((group) => !group.ownerTaskId).map((group) => <option value={group.id} key={group.id}>{group.name} · {group.mode === "parallel" ? "并行" : "串行"}</option>)}</select></label>}
          <label className="composer-field"><span>优先级</span><select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>{PRIORITIES.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
        </div>
      </div></div>
      <footer className="composer-footer"><div>{mode !== "debate" && <AttachmentPicker addFiles={uploads.addFiles} disabled={busy} />}<span><Paperclip size={13} />{mode === "debate" ? "辩论沿用执行器 Profile 的模型" : `${allAttachments.length} 个附件`} · ⌘↵ 创建并运行</span></div><Button disabled={!canSubmit} onClick={() => void submit(false)}>仅创建</Button><Button variant="primary" disabled={!canSubmit} onClick={() => void submit(true)}><Play size={12} weight="fill" />{busy ? "创建中…" : "创建并运行"}</Button></footer>
    </main>
  );
}
