// Core domain types shared between server and web.
import type { TeamConfig } from "./team.ts";
import type { DuetConfig } from "./duet.ts";
import type { WorkflowDef } from "./workflow.ts";
import type { TaskWorkflowMode } from "./free-workflow.ts";
import type { HandoffTarget, TaskHandoff } from "./handoff.ts";
export type { Session, SessionRole } from "./session.ts";
// 归一化后的 token 用量。运行时函数(累加/格式化)走 "@harness/shared/usage" 子路径
// 导出,这里同上只再导出类型。
export type { ContextUsage, TokenUsage } from "./usage.ts";
export type {
  ReviewConclusion,
  ReviewDispatchInput,
  TaskReviewInfo,
  TaskReviewRound,
  TeamConfig,
} from "./team.ts";
export type {
  FreeReviewCheckMode,
  FreeReviewDispatchInput,
  FreeReviewExecutorOverride,
  FreeReviewRound,
  FreeReviewRun,
  FreeWorkflowExecution,
  FreeWorkflowExecutionStatus,
  FreeWorkflowPreviewEvent,
  FreeWorkflowPreviewEventKind,
  FreeWorkflowPreviewEventSource,
  FreeWorkflowState,
  ReviewerProfile,
  TaskWorkflowMode,
} from "./free-workflow.ts";
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
  // 新建任务默认用哪条起手式（workflows.id 或内置 key）。空串 = 没设过，服务端落到
  // DEFAULT_WORKFLOW_KEY —— 那个 key 是运行时常量，这里不能 import（见上面的说明）。
  defaultWorkflowId: string;
  // 输入框里的 `/技能` 清单多久重拉一次(秒)。0 = 关闭轮询,只在打开输入框那一下拉。
  // 这是**前端轮询间隔**,不是服务端扫描周期:服务端每次请求都真扫盘(命中 mtime
  // 指纹就走缓存,~0.5ms)。按小时计:装新技能是低频动作,等不及有「立即重新扫描」。
  skillRefreshSeconds: number;
  // 任务接力的候选目标:另一台跑着 harness 的机器。url 是对端根地址(http://host:4317)。
  handoffTargets: HandoffTarget[];
}

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({
  worktreeDefault: true,
  defaultWorkflowId: "",
  skillRefreshSeconds: 3600,
  handoffTargets: [],
});

// ── 任务接力（跨机器 handoff）──────────────────────────────────────────────
// 类型本体在 ./handoff.ts（纯类型模块）,这里只做再导出,消费方 import 路径不变。
export type {
  HandoffExportResult,
  HandoffPingProject,
  HandoffPreflightResult,
  HandoffTarget,
  TaskHandoff,
} from "./handoff.ts";

// ── CLI skills (输入框的 `/` 补全) ────────────────────────────────────────
export type { SkillEntry, SkillList, SkillScanOverview, SkillScanRow, SkillSource } from "./skills.ts";

// ── Agents (§5) ────────────────────────────────────────────────────────────
// Abstraction layer: the *type* is what you @ / pick as a duet voice.
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

// CLI 各自的模型别名(CLI_MODEL_PRESETS)与思考强度档位(REASONING_EFFORT_VALUES /
// REASONING_EFFORT_DETAIL)在 `./cli-presets.ts`,走子路径 `@harness/shared/cli-presets`。
// 这里刻意不转发:服务端跑 shared 的 .ts 源码,index 转发运行时值会让它起不来。

// Execution layer: a concrete executor under a type (CLI + model)。
// 执行位置永远是 harness 所在的这台机器;要换机器请用「接力」把整个任务交出去。
export interface AgentExecutorProfile {
  id: string;
  name: string; // human label, e.g. "claude@local·opus"
  type: AgentType;
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
  // 覆盖 CLI 自己配置文件里的设置(以环境变量注入,只对 harness 起的进程生效)。
  // 可覆盖哪些项、各自盖掉谁,声明在 @harness/shared/cli-overrides。
  configOverrides?: Record<string, number>;
  isDefault: boolean; // the default executor resolved for its type
}

// ── Hierarchy (§3) ──────────────────────────────────────────────────────────
export interface Project {
  id: string;
  name: string;
  repoPath: string; // git repo this project's tasks operate on
  // 本项目新建任务默认走哪条起手式；null = 跟随全局默认（见 AppSettings）
  workflowId: string | null;
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

export interface NoteTaskLink {
  taskId: string;
  title: string;
  status: TaskStatus;
  archived: boolean;
  linkedAt: number;
}

// Quick notes are project-scoped scraps that keep the user's original text.
// Every conversion appends a task backlink; the note itself remains available.
export interface Note {
  id: string;
  projectId: string;
  body: string;
  attachments: string[];
  taskLinks: NoteTaskLink[];
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

export type TaskMode = "single" | "duet" | "team";

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

// Single-task user-Run guard (POST /tasks/:id/run). User explicitly clicked Run,
// so `canceled` is allowed here — they want to redo it. running/queued = already
// in flight; awaiting_review = waiting on a gate; done = finished (must not be
// casually re-run via this endpoint). paused = 跑到检查点等续跑。
// Distinct from the queue advance rule, which treats
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
  starredAt?: number | null; // 星标：用户手动的软记号，与自动状态正交。null=未标
  reviewOf?: string | null;
  reviewRound?: number | null;
  reviewRequested?: boolean;
  labels: string[];
  dependsOn: string[]; // [废弃,保留为 []] 旧的指针依赖,被 queue 模型取代
  resumeDependsOn: string[]; // [废弃,保留为 []] 同上
  // 队列归属与位置（null = 不在队列），推进规则见 queues.ts。
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
  // duet (讨论) mode config (§7):
  duet?: DuetConfig;
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
  // 统一验收冻结的合并快照。三项齐全时才能发起合并结果审查。
  acceptedTargetBranch?: string | null;
  acceptedBaseCommit?: string | null;
  acceptedMergeCommit?: string | null;
  // §Workflow 这个任务当初挑的那条线，**创建时拷下来的快照**（改起手式库不会追着改
  // 它）。老任务为 null —— 那时还没有这个概念，按写死的老流程走。
  workflow?: WorkflowDef | null;
  // 普通任务的执行方式。preset 读取上面的起手式快照；free 完全由显式操作驱动。
  workflowMode?: TaskWorkflowMode;
  // §Workflow 这条线此刻停在哪一站（step id）。有了它，「自动验证」「等我点头」才能在
  // 一条线上出现多次——唤醒事件落回来时才知道是**第几个**验证站有了结论、用户在**哪
  // 一道**关口点了头。null = 还没走到任何锚点，或者是没有线的老任务。
  workflowAt?: string | null;
  // Backlink used by duet ↔ team derivation chains.
  originTaskId?: string | null;
  // §Pause 检查点续跑指令；非空时结算 paused，恢复后清空。
  resumePrompt?: string | null;
  // 就地验证轮的轮次号；非空 = 这一轮验证还没出结论。任务此刻多半没有进程在跑
  // （status 是它原来的终态），但这一版的生命周期没结束：验收、/fire 这类「给这一版
  // 盖章 / 另起一版」的动作都得等它收尾，前端据此禁用按钮而不是靠 409 兜底。
  verifyRound?: number | null;
  // §Team 待答问题；非空时 paused 且队列不推进，answer_question 后恢复并清空。
  question?: string | null;
  // ask_question 的可编辑候选快捷填充；null/[] = 纯自由作答。
  questionOptions?: string[] | null;
  // 多问题列表；null/[] 沿用单问题 question + questionOptions。
  questionItems?: QuestionItem[] | null;
  // 任务接力标记（见 TaskHandoff）。null = 从未接力。
  handoff?: TaskHandoff | null;
}

export interface QuestionItem {
  question: string;
  options?: string[];
}

// 侧边栏横向铺开时，每一行右边那句「我发的最后一条追问」（判据见 `isUserFollowUp`）。
// 会话正文不在库里，而是 data/runs/<taskId>/<sessionId>.md，读一次要摸盘 —— 所以它
// **不进** `Task`、不进 /tasks 列表，由 POST /tasks/follow-ups 在铺开的那一下按需批量取。
export interface TaskFollowUp {
  taskId: string;
  // 已摘掉附件块的正文，超长截断（悬浮卡片够用，不是全文归档）。
  text: string;
  truncated: boolean;
  at: string | null;
  // 附件路径原样带回，交给前端的 attachmentView 变成缩略图 / 下载链接。
  attachments: string[];
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

// 选模型面板(对话框 @ 之后那一步、以及所有模型下拉)从哪里拿这家供应商的候选模型:
// "api"    = 每次打开都调它的 /models 接口,拿到什么列什么(总是最新,但慢且可能失败)
// "pinned" = 只列用户在供应商页面固定下来的那几个(离线、稳定、可控)
// 两者随时可切换;切到 pinned 时 pinnedModels 为空只是「这家暂时没候选」,不是错误。
export type ProviderModelListMode = "api" | "pinned";
export const PROVIDER_MODEL_LIST_MODES: readonly ProviderModelListMode[] = ["api", "pinned"];

export interface LlmProvider {
  id: string;
  name: string;
  protocol: LlmProtocol; // anthropic-compatible (挂 claude) | openai-compatible (挂 codex)
  baseUrl: string; // 根地址,不含 /v1 —— e.g. https://your-relay.com
  model: string;
  // OpenAI 兼容供应商若只实现 Chat Completions，开启后由 harness 把 Codex 的
  // Responses API 请求/流式响应转换成 Chat Completions 再转回来。
  protocolConversionEnabled: boolean;
  modelListMode: ProviderModelListMode;
  pinnedModels: string[]; // modelListMode === "pinned" 时的候选;另一模式下保留不动
  hasKey: boolean; // the key itself is never sent to the client; only whether one is set
  createdAt: string;
}

// ── Global search (⌘K) ───────────────────────────────────────────────────────
// 形状住在 ./search.ts(纯类型,这里只再导出)。
export type { NoteSearchHit, SearchField, SearchHit, TaskSearchHit } from "./search.ts";

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
  workflowId?: string | null; // 起手式 id；省略则按项目→全局默认解析，并拷成快照
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
    workflowId?: string | null; // 这一批默认走哪条起手式
    worktreeBase?: string | null;
    labels?: string[];
  };
}

// ── Duet 讨论 (§7) ───────────────────────────────────────────────────────────
// 类型从 ./duet.ts 再导出(type-only,编译期抹掉,安全);DUET_DEFAULTS 与
// normalizeDuetConfig 是运行时值,走子路径 `@harness/shared/duet`。
export type { DuetConfig, DuetConsensusBy, DuetStyle, HitlGate } from "./duet.ts";

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

// 一条「待发送消息」：不是重跑任务（那是 Schedule），而是等条件到了用
// continueTask 把这句话送进任务**原来那个会话**。两种到期条件，也就是 mode：
//   • timed  = 定时发送：等 `sendAt` 这个时刻到了再发（任务此刻在忙就继续等）
//   • queued = 排队追问：不看时间，任务一空下来就发（运行中还想补一句时用）
// 两者共用同一张表、同一条投递链路和同一个取消入口——区别只有「什么时候算到期」
// 这一条，其余（附件、@指派的执行器/模型/思考强度、托盘展示、取消）完全一样。
// 一个任务可以同时挂多条，按 `sendAt` 升序依次投递，每次只发一条。
export type ScheduledMessageStatus = "pending" | "sent" | "canceled";
export type ScheduledMessageMode = "timed" | "queued";
export interface ScheduledMessage {
  id: string;
  taskId: string;
  text: string;
  attachments: string[];
  agent: AgentType | null;
  // @指派时一并选定的执行器/模型/思考强度；null = 按 agent 的默认执行器 / 跟随执行器。
  executorId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  mode: ScheduledMessageMode;
  // timed：ISO 到期发送时间。queued：入队时刻（排队消息不看时间，只用它排先后）。
  sendAt: string;
  status: ScheduledMessageStatus;
  createdAt: string;
  sentAt: string | null;
}

// ── HITL gates (§7) / Executor streaming events (§12) ───────────────────────
// 形状住在 ./events.ts(纯类型,这里只再导出);拆分理由见那个文件的头部注释。
export type { AgentEvent, DuetSpeaker, GateAction, GateName, ServerEvent, TurnTraceEvent } from "./events.ts";

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
  // bySystem：走真人回合通道、但作者是后端的那种（验证打回、验收冲突交接）。
  // 它们**必须**是 user 回合（要 followUpFrom 护住任务原来的终态），所以只能另开一位来标。
  | { kind: "user"; text: string; at?: string; bySystem?: true }
  | { kind: "system"; text: string; at?: string };

// 「答复」是回答 agent 提问的那条，走 /tasks/:id/answer 时由服务端加的前缀。
export const ANSWER_PREFIX = "【答复】";

// 化石名单，只服务**加 by 标记之前**写下的老会话：那时后端代写的消息跟真人打的字
// 在盘上长得一模一样，只能靠开头这几个方括号认（名单是把 data/runs 全扫一遍点出来的，
// 「自动审查」是「自动验证」之前的老措辞）。老正文不会再变，所以这张表也永远不用加
// 东西 —— 新增的后端代写消息走 continueTask 的 `byBackend`，落盘就带 by:"system"。
// 代价说在明处：真人**引用**这些原话再补一句时会被误判成代写（实测有过一次），
// 只影响老会话，且宁可漏一条也好过把机器的话冒充成我说的。
const LEGACY_SYSTEM_AUTHORED = [ANSWER_PREFIX, "【自动审查未通过", "【自动验证未通过", "【验收未通过"];

// 「后续追问」= 真人自己打字发的话。两处判据必须是同一份：详情页 Inspector 的
// 「后续追问」列表，和侧边栏铺开后那一列。三件事都要排除：
// ① agent 说的（kind 不是 user）；② 系统代发的继续/恢复提示（落成 kind:"system"）；
// ③ 后端代用户发、但占着真人回合的那些（验证打回、验收冲突、答复提问）。
export function isUserFollowUp(seg: { kind: string; text?: string | null; bySystem?: boolean }): boolean {
  const text = seg.text ?? "";
  if (seg.kind !== "user" || !text.trim() || seg.bySystem) return false;
  return !LEGACY_SYSTEM_AUTHORED.some((prefix) => text.startsWith(prefix));
}

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
        const j = JSON.parse(line.slice(1)) as { t?: string; text?: string; at?: string; by?: string };
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
            : { kind: "user", text: j.text ?? "", at: j.at, ...(j.by === "system" ? { bySystem: true as const } : {}) },
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
