// Core domain types shared between server and web.
// Mirrors the decisions in DESIGN.md (§3 data model, §5 agents, §7 debate,
// §8 statuses, §12 debate mechanism, §13 sessions).
import type { SessionRole } from "./session.js";
import type { TeamConfig } from "./team.js";
export type { Session, SessionRole } from "./session.js";
export type {
  ReviewConclusion,
  ReviewDispatchInput,
  TaskReviewInfo,
  TaskReviewRound,
  TeamConfig,
} from "./team.js";
// 执行器覆盖的继承规则住在 ./executor-overrides.ts,走 "@harness/shared/executors"
// 子路径导出(跟 "@harness/shared/team" 同一套):index.ts 只做类型再导出,不能在这里
// 转发运行时函数 —— 服务端直接跑 .ts 源码,而 Node 的类型擦除不会把 "./x.js" 映射
// 回 "./x.ts",转发一加进程就起不来。

// ── Global app settings ────────────────────────────────────────────────────
// Stored server-side in the generic app_settings KV table. Consumers always
// merge persisted values over this object so a fresh/older database gets the
// current factory defaults without requiring seed rows.
export interface AppSettings {
  worktreeDefault: boolean;
}

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({
  worktreeDefault: true,
});

// ── Agents (§5) ────────────────────────────────────────────────────────────
// Abstraction layer: the *type* is what you @ / pick as a debater.
// Single source of truth: the runtime list drives both the union type and any
// server-side validation (e.g. the batch API), so they can never drift.
//
// 顺序 = 展示顺序,与 server/src/executors/catalog 的登记顺序一致。**加/删一个
// 智能体只有两步**:这个数组加/删一个字符串,catalog 目录加/删一个 spec 文件
// (catalog/index.ts 的 `satisfies Record<AgentType, CliSpec>` 会在编译期逼你两边对齐)。
export const AGENT_TYPES = [
  "claude",
  "codex",
  "antigravity",
  "gemini",
  "opencode",
  "trae",
  "grok",
  "kimi",
  "cursor",
  "qwen",
  "qoder",
  "copilot",
  "kiro",
  "kilo",
  "pi",
] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

// CLI-native model aliases used when an executor is on its official account.
// Provider-backed executors replace these with that provider's /v1/models list.
// 全键 Record 是刻意的:新类型不填就编译不过,免得漏登记后下拉框静默空着。
// 空数组 = 该 CLI 的模型别名还没实测(用户仍可在 profile 里手填任意模型名)。
export const CLI_MODEL_PRESETS: Record<AgentType, readonly string[]> = {
  claude: ["opus", "sonnet", "haiku", "fable"],
  codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
  antigravity: [],
  gemini: [],
  opencode: [],
  trae: [],
  grok: [],
  kimi: [],
  cursor: [],
  qwen: [],
  qoder: [],
  copilot: [],
  kiro: [],
  kilo: [],
  pi: [],
};

// CLI-specific reasoning levels. Unsupported model/effort combinations are
// rejected by the CLI/API at run time (for example gpt-5.5 tops out at xhigh).
// 同样是全键 Record;空数组 = 该 CLI 没有(或还没实测出)思考强度档位。
export const REASONING_EFFORT_VALUES: Record<AgentType, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "ultra", "max"],
  antigravity: [],
  gemini: [],
  opencode: [],
  trae: [],
  grok: [],
  kimi: [],
  cursor: [],
  qwen: [],
  qoder: [],
  copilot: [],
  kiro: [],
  kilo: [],
  pi: [],
};

export const REASONING_EFFORT_DETAIL: Record<string, string> = {
  xhigh: "gpt-5.5 支持的最高档",
  ultra: "仅 gpt-5.6-sol/terra 等新模型支持",
};

// Execution layer: a concrete executor under a type (CLI + target + model).
export interface AgentExecutorProfile {
  id: string;
  name: string; // human label, e.g. "claude@local·opus"
  type: AgentType;
  target: ExecTarget; // local spawn or ssh host
  model?: string;
  extraArgs?: string[];
  // 推理强度。缺省 = 跟随 CLI 默认;claude: --effort <v>;codex: -c model_reasoning_effort="<v>"。
  // 取值集按 CLI 而异(claude 无 ultra;模型不支持的档位会被 API 拒绝,如 gpt-5.5 最高 xhigh)。
  reasoningEffort?: string;
  // 速度档。缺省/"standard" = 标准（不额外传参，跟随 CLI 自己的默认）；
  // "fast" = 1.5x 加速档（codex: -c service_tier="priority"）。
  speed?: "standard" | "fast";
  // 挂载的供应商(LlmProvider.id)。缺省/null = 用 CLI 自己的官方登录账号。
  // 非空时启动 CLI 前注入供应商的 base_url + key(见 executors/index.ts)。
  providerId?: string | null;
  isDefault: boolean; // the default executor resolved for its type
}

export type ExecTarget =
  | { kind: "local" }
  | { kind: "ssh"; host: string; cwdPrefix?: string };

// ── Hierarchy (§3) ──────────────────────────────────────────────────────────
export interface Project {
  id: string;
  name: string;
  repoPath: string; // git repo this project's tasks operate on
  createdAt: string;
}

// repoPath is load-bearing (it's the cwd of every run). Health is computed
// server-side and is NEVER persisted — see ProjectView. 🔴 !exists / 🟡 exists
// but not a git repo / 🟢 git repo (with branch + dirty in the full check).
export interface ProjectHealth {
  exists: boolean;
  isRepo: boolean;
  isWorktree?: boolean; // repoPath is itself a linked git worktree (.git is a file, not a dir)
  branch?: string | null; // only in the full check (settings panel / path validation)
  dirty?: boolean; // working tree has uncommitted changes (full check only)
}

// Wire shape returned by the project endpoints: the persisted row + computed
// health. The web client uses this everywhere; it never inserts a bare Project.
export interface ProjectView extends Project {
  health: ProjectHealth;
}

// ── 任务留在磁盘上的工作区(worktree 目录 + harness/<id8> 分支) ──────────────
// 删除任务前先问一次服务端「这两样还在不在」,在的话删除对话框才提示要不要连它们
// 一起删。两个字段各自独立:目录被手删过、分支还留着是常见状态。
export interface TaskWorkspaceLeftover {
  path: string | null; // worktree 目录,不存在为 null
  branch: string | null; // 任务分支 harness/<id8>,本地不存在为 null
}

// 一次清理的逐项结果。git 拒绝(worktree 有未提交改动 / 分支未合并)不是异常,
// 是要如实回给用户、由他决定要不要再来一次 --force / -D 的信息。
export interface TaskWorkspaceDiscardResult {
  path: string | null; // 本次尝试删除的 worktree 目录(没尝试则 null)
  branch: string | null; // 本次尝试删除的分支(没尝试则 null)
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  worktreeError: string | null; // git 原样 stderr
  branchError: string | null;
}

// Quick notes are project-scoped scraps that keep the user's original text.
// `taskId` is a backlink set after one or more notes are merged into a task;
// the note itself remains available for reference.
export interface Note {
  id: string;
  projectId: string;
  body: string;
  attachments: string[];
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type GroupMode = "parallel" | "serial";

// Group = transient homogeneous batch container (§3). Not persistent-by-design,
// not schedulable. Controls parallel/serial scheduling.
export interface Group {
  id: string;
  projectId: string;
  name: string;
  mode: GroupMode;
  paused: boolean; // 暂停 = 立刻冻结整组：调度器不再启动"还没开始"的任务，正在运行的也会被停掉（结算为 canceled，可继续）；再次「运行/继续」时恢复，被停的任务从中断处接着跑
  // 内部组（§Team）：非空 = 这个组是某个团队任务(mode:"team")派活时自动建的，
  // 它的成员都是那个任务的执行者。分组管理界面不列它 —— 用户在团队视图里看。
  ownerTaskId?: string | null;
  createdAt: string;
}

export type TaskMode = "single" | "debate" | "team";

export type TaskStatus =
  | "backlog"
  | "queued"
  | "running"
  | "idle" // 只有 team：调度台在线但这一刻没在说话（没有「完成」这个终态，归档才结束）
  | "awaiting_review"
  | "paused" // 跑到检查点：agent 主动调 pause_task 后留下 resumePrompt，等依赖满足或用户手动继续
  | "done"
  | "failed"
  | "canceled";

// 与 TaskStatus 正交的验收进度。status 只管调度/结算，stage 只管展示/协作。
export const STAGE_ORDER = [
  "implemented", "verifying", "verified", "verify_failed",
  "awaiting_acceptance", "merged", "accepted",
] as const;
export type TaskStage = (typeof STAGE_ORDER)[number];
export const STAGE_LABELS: Record<TaskStage, string> = {
  implemented: "已实现", verifying: "验证中", verified: "已验证", verify_failed: "未通过验证",
  awaiting_acceptance: "待验收", merged: "已合并", accepted: "验收完成",
};
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "待排期", queued: "排队中", running: "运行中", idle: "待命",
  awaiting_review: "等待审核", paused: "暂停中", done: "完成", failed: "失败", canceled: "已取消",
};
export type TaskDisplayStatusKey = "awaiting_answer" | TaskStatus | TaskStage;
export type TaskDisplayStatus = { key: TaskDisplayStatusKey; label: string };
export function isTaskStage(value: unknown): value is TaskStage {
  return typeof value === "string" && (STAGE_ORDER as readonly string[]).includes(value);
}
export function taskDisplayStatus(
  status: TaskStatus, stage: TaskStage | null | undefined, awaitingAnswer: boolean,
): TaskDisplayStatus {
  if (awaitingAnswer) return { key: "awaiting_answer", label: "等答复" };
  if (status === "failed" || status === "canceled") return { key: status, label: TASK_STATUS_LABELS[status] };
  if (stage) return { key: stage, label: STAGE_LABELS[stage] };
  return { key: status, label: TASK_STATUS_LABELS[status] };
}

export type Priority = "none" | "low" | "medium" | "high" | "urgent";

// Single-task user-Run guard (POST /tasks/:id/run). User explicitly clicked Run,
// so `canceled` is allowed here — they want to redo it. running/queued = already
// in flight; awaiting_review = waiting on a gate; done = finished (must not be
// casually re-run via this endpoint). paused = 跑到检查点等续跑。
// Distinct from the queue advance rule (DESIGN-scheduling.md §3) which treats
// `canceled` as transparent and only advances on `done` — that's the
// group/queue automation view, not direct user intent.
export const SINGLE_RUN_FROM: TaskStatus[] = ["backlog", "canceled", "failed", "paused"];
export function canSingleRun(status: TaskStatus): boolean {
  return SINGLE_RUN_FROM.includes(status);
}

// running / queued / awaiting_review reflect live execution — only the
// orchestrator/scheduler/gate set them. A human may only set these "settled"
// statuses; the rest are system-owned (so you can't e.g. mark a task "running"
// by hand, which would desync from reality).
export const USER_SETTABLE_STATUSES: TaskStatus[] = ["backlog", "done", "failed", "canceled"];
export function isUserSettableStatus(status: TaskStatus): boolean {
  return USER_SETTABLE_STATUSES.includes(status);
}

// 归档 = 结束。team 任务没有 done —— 它只在忙(running)/闲(idle)之间摆动，所以
// `idle` 也算可归档：归档才是团队解散的那一刻。
export const ARCHIVABLE_STATUSES: TaskStatus[] = ["done", "failed", "canceled", "idle"];
export function canArchive(status: TaskStatus): boolean {
  return ARCHIVABLE_STATUSES.includes(status);
}

export interface Task {
  id: string;
  projectId: string;
  groupId: string | null;
  parentId: string | null; // reserved for sub-tasks (§3)
  title: string;
  body: string; // the prompt / objective
  mode: TaskMode;
  status: TaskStatus;
  stage?: TaskStage | null;
  pinnedAt?: number | null; // null=未置顶；整数毫秒时间戳用于置顶区排序
  reviewOf?: string | null;
  reviewRound?: number | null;
  reviewRequested?: boolean;
  priority: Priority;
  labels: string[];
  dependsOn: string[]; // [废弃,保留为 []] 旧的指针依赖,被 queue 模型取代,见 DESIGN-scheduling.md
  resumeDependsOn: string[]; // [废弃,保留为 []] 同上
  // 队列归属与位置（null = 不在队列），推进规则见 DESIGN-scheduling.md §1。
  queueId?: string | null;
  queuePosition?: number | null;
  autoTitle?: boolean; // title is AI-generated on first run until the user edits it
  // single mode:
  agentType?: AgentType;
  // Concrete profile; null/stale falls back to the default for agentType.
  executorId?: string | null;
  // Per-task CLI overrides. null/omitted follows the resolved executor profile.
  model?: string | null;
  reasoningEffort?: string | null;
  // Read-only label for the selected/default executor profile.
  executorLabel?: string | null;
  // debate mode config (§7):
  debate?: DebateConfig;
  // team mode config (§Team)：调度者 + 默认执行者类型。只有 mode:"team" 的任务有。
  team?: TeamConfig;
  // §Team：执行者 done 后是否额外唤醒调度者汇报。
  reportBack?: boolean;
  scheduleId?: string | null;
  createdAt: string;
  updatedAt: string;
  // Lifecycle span; use activeMs for execution time excluding idle waits.
  startedAt?: string | null;
  endedAt?: string | null;
  // Server-computed active turn time; null = historical data cannot be reconstructed.
  activeMs?: number | null;
  // Live turn start used to tick activeMs; null when idle/terminal.
  liveSince?: string | null;
  archived?: boolean;
  archivedAt?: string | null;
  // §4 per-task worktree opt-in; worktreeBase null means current HEAD.
  // Existing worktrees are reused; cleanup is an explicit user action.
  useWorktree?: boolean;
  worktreeBase?: string | null;
  // Backlink used by debate ↔ team derivation chains.
  originTaskId?: string | null;
  // §Pause 检查点续跑指令；非空时结算 paused，恢复后清空。
  resumePrompt?: string | null;
  // §Team 待答问题；非空时 paused 且队列不推进，answer_question 后恢复并清空。
  question?: string | null;
  // ask_question 的可编辑候选快捷填充；null/[] = 纯自由作答。
  questionOptions?: string[] | null;
  // 多问题列表；null/[] 沿用单问题 question + questionOptions。
  questionItems?: QuestionItem[] | null;
}

export interface QuestionItem {
  question: string;
  options?: string[];
}

// 候选答案的上限：server 校验、MCP 工具描述、网页渲染共用这一处来源（写死两遍
// 必然改一处漏一处）。超限一律 400 而不是静默截断 —— 悄悄砍掉一个候选，agent
// 以为它还在、用户压根没见过，两边对不上。
export const MAX_QUESTION_OPTIONS = 6;
export const MAX_QUESTION_OPTION_LEN = 200;
// 一次最多并列问 4 个相关问题（与 Claude Code 一致）。再多会让答复卡片过长，
// 也通常意味着决策应拆成两轮；超限同样明确报 400，不静默截断。
export const MAX_QUESTION_ITEMS = 4;

// ── Team (§Team) ─────────────────────────────────────────────────────────────
// 一个 mode:"team" 的任务 = 一个常驻的「调度台」：进程不退、会话不断，你随时插话；
// 它用 MCP 的 dispatch 派出真任务当执行者（执行者挂在 parentId 上，成批地放进自动建的
// 内部组里，串行批次还配 queue）。调度者没有「完成」这个状态，只有忙/闲。
// Global named shortcuts for filling a new TeamConfig. Display-label fields are
// read-only API enrichments; only the executor/model/effort choices are stored.
export type TeamPresetConfig = Pick<
  TeamConfig,
  | "lead"
  | "worker"
  | "leadExecutorId"
  | "workerExecutorId"
  | "leadModel"
  | "leadReasoningEffort"
  | "workerModel"
  | "workerReasoningEffort"
  | "review"
  | "reviewerAgentType"
  | "reviewerExecutorId"
  | "reviewerModel"
  | "reviewerReasoningEffort"
  | "leadExecutorLabel"
  | "workerExecutorLabel"
  | "reviewerExecutorLabel"
>;

export interface TeamPreset {
  id: string;
  name: string;
  config: TeamPresetConfig;
  createdAt: string;
}

export const TEAM_DEFAULTS: TeamConfig = { lead: "claude", worker: "claude", review: true };

// ── 供应商 (relay, system-level) ─────────────────────────────────────────────
// 一个可挂到执行器上的模型来源:官方 API 端点,或第三方代理/聚合服务。挂上后启动 CLI 时注入
// base_url + key,顶掉 CLI 自己的登录账号 —— 于是 claude@官方 和 claude@公司
// 可以并存。全局(不分项目)。harness 自己不再直连它调模型。
export type LlmProtocol = "anthropic" | "openai";
export interface LlmProvider {
  id: string;
  name: string;
  protocol: LlmProtocol; // anthropic-compatible (挂 claude) | openai-compatible (挂 codex)
  baseUrl: string; // 根地址,不含 /v1 —— e.g. https://your-relay.com
  model: string;
  hasKey: boolean; // the key itself is never sent to the client; only whether one is set
  createdAt: string;
}

// ── Global search (⌘K) ───────────────────────────────────────────────────────
// One hit per task or note. Task fields rank title > body > conversation, and
// task hits are returned before note hits. `conversation` means the match was
// found inside the task's session transcripts (data/runs/<taskId>/*.md|jsonl),
// which is where run artifacts like output directory names live.
export type SearchField = "title" | "body" | "conversation";
export interface TaskSearchHit {
  kind: "task";
  id: string;
  title: string;
  status: TaskStatus;
  projectId: string;
  projectName: string | null;
  archived: boolean;
  field: SearchField;
  // Context around the first match, whitespace-collapsed to one line.
  // Empty for title hits (the title is already shown).
  snippet: string;
  // Task body prefix for the command-palette preview.
  preview?: string;
  updatedAt: string;
}

export interface NoteSearchHit {
  kind: "note";
  id: string;
  title: string;
  projectId: string;
  projectName: string | null;
  field: "body";
  snippet: string;
  // Note body for the command-palette preview.
  preview?: string;
  updatedAt: string;
  taskId: string | null;
}

export type SearchHit = TaskSearchHit | NoteSearchHit;

// ── Attachments (pasted into the composer / reply box) ───────────────────────
// Pasted images OR files. We don't feed them to a vision API — each is persisted
// to disk and its absolute path is appended to the prompt for the agent to Read
// (see server util.attachmentsPrompt). So "type" only decides the web preview
// (thumbnail vs file chip); the agent can Read any file. Limits mirror Claude
// Code / Codex CLI: vision images PNG/JPEG/GIF/WebP ≤ 5MB, any other file ≤ 20MB.
export const VISION_IMAGE_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 视觉图片：对齐 claude/codex 5MB
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 其它文件：20MB

export type AttachmentKind = "image" | "file";
export const attachmentKind = (mime: string): AttachmentKind =>
  (VISION_IMAGE_MIME as readonly string[]).includes(mime) ? "image" : "file";
export const maxBytesFor = (mime: string): number =>
  attachmentKind(mime) === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;

// ── External batch API (agent-facing, § interfaces) ──────────────────────────
// One call to create a whole batch of single-mode tasks into an EXISTING group,
// wiring cross-task dependency edges that the in-group scheduler honors. The
// chain case ("A 做完再做 B …") is the headline; arbitrary in-batch DAGs are
// expressible via per-task `key` + `dependsOn`. projectId is inherited from the
// group, so the caller never repeats it.
export interface BatchTaskInput {
  // Local id used ONLY to reference this task from a sibling's dependsOn within
  // the same batch (ids don't exist yet at call time). Not persisted.
  key?: string;
  title?: string; // omitted → derived from body's first line, and autoTitle'd
  body?: string; // the prompt / objective
  agentType?: AgentType; // overrides defaults.agentType
  executorId?: string | null; // overrides defaults.executorId; stale id degrades by agentType
  model?: string | null; // overrides defaults.model; null follows the resolved executor profile
  reasoningEffort?: string | null; // overrides defaults.reasoningEffort
  useWorktree?: boolean; // overrides defaults.useWorktree; omitted follows the global setting
  worktreeBase?: string | null; // base ref when this task uses a worktree
  priority?: Priority;
  labels?: string[];
  // Each entry is resolved against sibling `key`s first; anything that doesn't
  // match a sibling key is treated as an existing task id and passed through.
  dependsOn?: string[];
  // Same resolution as dependsOn, but checked only when resuming a paused task.
  resumeDependsOn?: string[];
}

export interface BatchCreateTasksBody {
  tasks: BatchTaskInput[];
  chain?: boolean; // true → append the previous task's id to each task's deps (A→B→C→D)
  run?: boolean; // true → kick off the group (runGroup) right after creating
  defaults?: {
    // applied to every task unless that task overrides the field
    agentType?: AgentType;
    executorId?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    useWorktree?: boolean; // omitted follows DEFAULT_APP_SETTINGS.worktreeDefault
    worktreeBase?: string | null;
    priority?: Priority;
    labels?: string[];
  };
}

// ── Debate (§7) ──────────────────────────────────────────────────────────────
export type HitlGate = "off" | "on";
export type DebateConsensusBy = "both" | "A" | "B";

// /debate is discussion-only: two debaters challenge each other and produce a
// conclusion. Code execution belongs to /team.
export type DebateStyle = "debate";

export interface DebateConfig {
  topic: string;
  style: DebateStyle;
  debaterA: AgentType;
  debaterB: AgentType;
  debaterAExecutorId?: string | null;
  debaterBExecutorId?: string | null;
  maxRounds: number | null; // null = unlimited
  gateG1: HitlGate; // consensus gate
}

export const DEBATE_DEFAULTS: DebateConfig = {
  topic: "",
  style: "debate",
  debaterA: "claude",
  debaterB: "codex",
  debaterAExecutorId: null,
  debaterBExecutorId: null,
  maxRounds: null,
  gateG1: "on",
};

// Database rows and localStorage may contain fields from retired debate variants.
// Normalize at every boundary so old tasks remain readable while all new runs
// use the single supported debate shape.
export function normalizeDebateConfig(value: unknown): DebateConfig {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const agent = (v: unknown, fallback: AgentType): AgentType =>
    typeof v === "string" && AGENT_TYPES.includes(v as AgentType) ? v as AgentType : fallback;
  const maxRounds = raw.maxRounds === null
    ? null
    : typeof raw.maxRounds === "number" && Number.isFinite(raw.maxRounds) && raw.maxRounds >= 1
      ? Math.floor(raw.maxRounds)
      : DEBATE_DEFAULTS.maxRounds;
  return {
    topic: typeof raw.topic === "string" ? raw.topic : DEBATE_DEFAULTS.topic,
    style: "debate",
    debaterA: agent(raw.debaterA, DEBATE_DEFAULTS.debaterA),
    debaterB: agent(raw.debaterB, DEBATE_DEFAULTS.debaterB),
    debaterAExecutorId: typeof raw.debaterAExecutorId === "string" ? raw.debaterAExecutorId : null,
    debaterBExecutorId: typeof raw.debaterBExecutorId === "string" ? raw.debaterBExecutorId : null,
    maxRounds,
    gateG1: raw.gateG1 === "off" ? "off" : "on",
  };
}

// ── Scheduling (§9) ──────────────────────────────────────────────────────────
// Schedules attach to a Task. Once = fire at a timestamp then disable; cron =
// recurring 5-field expression in local time. The scheduler only enqueues.
export interface Schedule {
  id: string;
  taskId: string;
  kind: "once" | "cron";
  at: string | null;
  cron: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

// A reply scheduled to send to a task's agent at a future time. Unlike Schedule
// (which re-runs a task), this delivers a message via continueTask once `sendAt`
// passes and the task is idle. A task may have several pending messages.
export type ScheduledMessageStatus = "pending" | "sent" | "canceled";
export interface ScheduledMessage {
  id: string;
  taskId: string;
  text: string;
  attachments: string[];
  agent: AgentType | null;
  sendAt: string; // ISO 到期发送时间
  status: ScheduledMessageStatus;
  createdAt: string;
  sentAt: string | null;
}

// ── HITL gates (§7) ──────────────────────────────────────────────────────────
export type GateName = "G1" | "G2"; // G2 is legacy, retained for historical events
export type GateAction =
  | { kind: "approve"; text?: string; side?: "A" | "B" } // side is retained for older clients
  | { kind: "reject" } // 打回终止
  | { kind: "inject"; text: string } // 注入意见 → 回炉再辩（始终双方一起回炉）
  | { kind: "ask"; text: string; target?: "A" | "B" }; // 提问 → 答完继续；target 缺省=问双方，指定=只问那一位辩手

// ── Executor streaming events (§12) ──────────────────────────────────────────
export type AgentEvent =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail?: string }
  | { kind: "session"; cliSessionId: string }
  | { kind: "system"; text: string } // a backend-initiated 〔系统〕 trace (e.g. 继续) — its own bubble, not agent text
  | { kind: "error"; message: string }
  // 常驻会话（team 调度台）专用：一个回合说完了，但进程还活着等下一条消息。
  // 一次性 run() 永远不发这个 —— 它的回合结束就是进程结束(done)。
  | { kind: "turnEnd" }
  | { kind: "done"; exitStatus: number };

export type DebateSpeaker = "A" | "B" | "impl" | "review" | "user"; // impl/review are legacy transcript speakers

// SSE envelope pushed to the web client.
export type ServerEvent =
  | { type: "task.created"; task: Task }
  | { type: "task.updated"; task: Task }
  | { type: "task.status"; taskId: string; status: TaskStatus; startedAt?: string | null; endedAt?: string | null; activeMs?: number | null; liveSince?: string | null }
  | { type: "task.stage"; taskId: string; stage: TaskStage | null }
  | { type: "task.review"; taskId: string }
  | { type: "task.title"; taskId: string; title: string }
  // 提问态变化（§Team）：agent 调 ask_question 提问、或答复把它清空。task.status
  // 只带状态字段，question 不跟着走 —— 少了这条事件，卡片要等下次全量拉取才出现/
  // 消失（答复完卡片还杵在那，像是没答上）。question=null 即「已答复，撤掉卡片」。
  | {
      type: "task.question";
      taskId: string;
      question: string | null;
      questionOptions: string[] | null;
      questionItems: QuestionItem[] | null;
    }
  | {
      type: "agent.event";
      taskId: string;
      sessionId: string;
      role: SessionRole;
      agentType?: AgentType; // which agent produced it (single tasks can host several via @-mention)
      event: AgentEvent;
    }
  | {
      type: "debate.progress";
      taskId: string;
      round: number;
      speaker: DebateSpeaker;
      phase: "start" | "end";
      raisedHand?: boolean;
      at?: string;
      startedAt?: string;
      durationMs?: number;
    }
  | { type: "debate.gate"; taskId: string; gate: GateName; open: boolean; consensus?: boolean; consensusBy?: DebateConsensusBy; conclusionA?: string | null; conclusionB?: string | null }
  // A human intervention in a /debate timeline (gate inject/ask). Carries the time
  // so the timeline can show when the user spoke. Persisted in the transcript too.
  // target: when a 提问 was directed at one debater, which side — so the timeline
  // can show 「你 → 辩手A」 (undefined = addressed to both).
  | { type: "debate.user"; taskId: string; round: number; text: string; at: string; target?: "A" | "B" };

// ── Session-snapshot parsing ──────────────────────────────────────────────
// A persisted session .md is mostly agent Markdown, but backend continues and
// 你→@agent replies are interleaved as their own turns. New runs write each as a
// \x1e + JSON sentinel line (carrying a timestamp); older runs used inline
// 〔系统〕…/〔你 → @x〕… markers. Split the blob back into ordered segments so each
// turn renders as its own bubble instead of bleeding into the agent text around it.
// Shared by web (TaskDetail) and mobile (log.ts) so the two never drift apart.
export const LEGACY_SYS_MARKER = "〔系统〕继续（从中断处）";

export type ConvSeg =
  | { kind: "agent"; text: string; endedAt?: string }
  | { kind: "user"; text: string; at?: string }
  | { kind: "system"; text: string; at?: string };

export function parseSessionOutput(out: string): ConvSeg[] {
  const segs: ConvSeg[] = [];
  let buf: string[] = [];
  let skippingDiagnostic = false;
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) segs.push({ kind: "agent", text: t });
    buf = [];
  };
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    // Backend failure diagnostics are persisted beside the conversation so they
    // remain available in the raw run artifacts. They are not agent speech,
    // though, and rendering them inline makes a normal transcript look like a
    // stream of repeated reconnect errors. Keep them out of conversation bubbles.
    if (!skippingDiagnostic && trimmed === "> **执行诊断**") {
      flush();
      skippingDiagnostic = true;
      continue;
    }
    if (skippingDiagnostic) {
      if (!trimmed) {
        skippingDiagnostic = false;
        continue;
      }
      if (!line.startsWith("\x1e")) continue;
      skippingDiagnostic = false;
    }
    if (trimmed.startsWith("> 续聊回合异常结束(")) continue;
    if (line.startsWith("\x1e")) {
      try {
        const j = JSON.parse(line.slice(1)) as { t?: string; text?: string; at?: string };
        flush();
        if (j.t === "agentEnd") {
          // Not a new bubble — it stamps where the agent turn that just flushed
          // actually finished, so per-turn 用时 excludes the idle wait that follows.
          const last = segs[segs.length - 1];
          if (last?.kind === "agent") last.endedAt = j.at;
          continue;
        }
        segs.push(
          j.t === "system"
            ? { kind: "system", text: j.text || LEGACY_SYS_MARKER, at: j.at }
            : { kind: "user", text: j.text ?? "", at: j.at },
        );
        continue;
      } catch {
        /* not a turn line — fall through and treat as ordinary text */
      }
    }
    if (trimmed === LEGACY_SYS_MARKER) {
      flush();
      segs.push({ kind: "system", text: LEGACY_SYS_MARKER });
      continue;
    }
    // Legacy reply marker — best-effort (only the first line is recoverable, since
    // old multi-line replies weren't fenced); the rest folds into the next bubble.
    const m = /^〔你 → @[^〕]*〕([\s\S]*)$/.exec(trimmed);
    if (m) {
      flush();
      segs.push({ kind: "user", text: m[1] ?? "" });
      continue;
    }
    buf.push(line);
  }
  flush();
  return segs;
}
