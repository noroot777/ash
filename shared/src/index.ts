// Core domain types shared between server and web.
// Mirrors the decisions in DESIGN.md (§3 data model, §5 agents, §7 debate,
// §8 statuses, §12 debate mechanism, §13 sessions).

// ── Agents (§5) ────────────────────────────────────────────────────────────
// Abstraction layer: the *type* is what you @ / pick as a debater.
// Single source of truth: the runtime list drives both the union type and any
// server-side validation (e.g. the batch API), so they can never drift.
export const AGENT_TYPES = ["claude", "codex", "antigravity"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

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
  priority: Priority;
  labels: string[];
  dependsOn: string[]; // [废弃,保留为 []] 旧的指针依赖,被 queue 模型取代,见 DESIGN-scheduling.md
  resumeDependsOn: string[]; // [废弃,保留为 []] 同上
  // 队列归属(DESIGN-scheduling.md §1):任务在某个 queue 里的位置。null = 不在任何队列。
  // 推进规则:前一个位置 done/canceled 时,这个位置才开始;前一个 failed 时链停。
  queueId?: string | null;
  queuePosition?: number | null;
  autoTitle?: boolean; // title is AI-generated on first run until the user edits it
  // single mode:
  agentType?: AgentType;
  // Concrete executor profile. If set and still exists, server runs that profile;
  // if null/stale, it falls back to the current default executor for agentType.
  executorId?: string | null;
  // Read-only display label for the profile that will run this task:
  // selected agents.name, else the current default profile name for agentType.
  executorLabel?: string | null;
  // debate mode config (§7):
  debate?: DebateConfig;
  // team mode config (§Team)：调度者 + 默认执行者类型。只有 mode:"team" 的任务有。
  team?: TeamConfig;
  // 执行者旗标（§Team）：这个执行者做完(done)要不要汇报给调度者。派活时逐个指定；
  // false = 静默完成（UI 自己会更新，不花一轮模型调用去叫醒调度者）。
  reportBack?: boolean;
  scheduleId?: string | null;
  createdAt: string;
  updatedAt: string;
  // Run timing. startedAt = first time the task entered `running` (kept across
  // re-runs); endedAt = the last terminal time, cleared while running. These
  // bracket the task's whole LIFESPAN, so `endedAt − startedAt` is a wall-clock
  // SPAN, not execution time: a single session the user replies to over hours
  // includes the idle waits between turns. Use `activeMs` for execution time.
  startedAt?: string | null;
  endedAt?: string | null;
  // Execution time (server-computed): the sum of every run-turn's active span
  // [prompt sent → turn finished], so the idle between turns (waiting for a reply
  // / a gate) is excluded. null = the task has turns from before per-turn timing
  // was recorded (historical) and can't be reconstructed — surfaces then fall
  // back to showing the lifespan, labeled as a span rather than execution time.
  activeMs?: number | null;
  // While a turn is live, the ISO start of that turn so a client can tick
  // `activeMs + (now − liveSince)`; null when idle/terminal.
  liveSince?: string | null;
  archived?: boolean;
  archivedAt?: string | null;
  // Per-task git worktree opt-in (§4). When `useWorktree` is true and the project
  // is a real git repo, runTask materializes `<repoPath>/.worktrees/<taskId>` on a
  // fresh branch `harness/<taskId 前 8 位>` BRANCHED OFF `worktreeBase` (the user-
  // chosen base; null = current HEAD), and the agent runs there instead of the
  // repoPath. Existing worktree → reused, not re-created (idempotent re-run).
  // harness never removes worktrees on its own — the UI offers a one-click cleanup.
  useWorktree?: boolean;
  worktreeBase?: string | null;
  // Backlink to the issue this task was derived from (§Issues). Null for tasks
  // created directly. An issue can spawn many tasks over time.
  issueId?: string | null;
  // 检查点续跑（§Pause）：agent 在执行中调 pause_task 时写下的「下次继续时该
  // 喂给我什么」prompt。任务结算时若此字段非空，则状态进入 `paused` 而不是
  // `done`；scheduler 在依赖满足后把它当 continueTask 的 userText 喂回 CLI
  // session，并清空此字段。null = 无待续跑指令。
  resumePrompt?: string | null;
  // 提问（§Team）：agent 在执行中调 ask_question 留下的问题。结算时此字段非空 →
  // 状态落 paused 且**队列不推进也不自动续跑**（区别于 resumePrompt 检查点），
  // 同时通知它的调度者；answer_question 清空它并带着答复 resume 会话。
  // 团队任务自己也能用它 —— 那就是「调度者在问用户」。null = 没有待答复的问题。
  question?: string | null;
  // 提问的候选答案：agent 调 ask_question 时可选地附上的几个候选，网页把它们渲染
  // 成可点按钮 —— 点一下等价于把该选项**原文**填进答复框发出去，所以答复链路
  // （/answer → resume 会话）跟自由作答完全一样，选项只是省掉打字。
  // null/[] = 没给候选，只能自由作答。
  questionOptions?: string[] | null;
  // 一次询问多个相关决策：question 此时作为引言/背景，每个 item 才是一个需要
  // 独立答复的问题；options 仍只是可编辑答复的快捷填充。null/[] = 沿用上面的
  // 单问题 question + questionOptions 结构，老调用无需改动。
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
export interface TeamConfig {
  lead: AgentType; // 调度者的 CLI 类型 —— 必须支持常驻会话（见 executors 的 openResident）
  worker: AgentType; // 派活时的默认执行者类型（dispatch 可逐个覆盖）
  leadExecutorId?: string | null; // 调度者具体执行器；缺省/悬空 → lead 类型默认执行器
  workerExecutorId?: string | null; // 执行者任务的默认执行器；缺省/悬空 → worker 类型默认执行器
  leadExecutorLabel?: string | null; // server 只读展示字段
  workerExecutorLabel?: string | null; // server 只读展示字段
}

export const TEAM_DEFAULTS: TeamConfig = { lead: "claude", worker: "claude" };

// ── Issues (§Issues) ─────────────────────────────────────────────────────────
// An Issue is the lightweight planning/discussion layer that sits UPSTREAM of
// tasks (like GitHub Issues → Actions runs): you capture it in one line, the AI
// structures it and infers its project, you discuss it, then you @-mention a CLI
// agent to EXECUTE it — which derives a task carrying the full context.
export type IssueStatus = "open" | "in_progress" | "done" | "canceled";
export const ISSUE_STATUSES: IssueStatus[] = ["open", "in_progress", "done", "canceled"];

// Which AI handled the parse/recognition for an issue — always a concrete local
// CLI executor (AgentExecutorProfile.id). There is no direct-HTTP path: a provider
// is just an attribute of an executor, not a separate backend.
// 历史数据里的旧格式({kind:'cli'|'api',…})没有 executorId,读到就降级为默认执行器。
export type AiBackend = { executorId: string };

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

export interface Issue {
  id: string;
  projectId: string | null; // null = 未归类: AI couldn't infer a project; surfaced for manual assignment
  title: string;
  body: string; // AI-structured description (Markdown)
  sourceText: string; // the raw user input, kept for re-parsing / reference
  status: IssueStatus;
  priority: Priority;
  labels: string[];
  // Absolute paths of pasted/picked files (images + any file), handed to the agent
  // to Read on @-execution (same model as task attachments — see attachmentsPrompt).
  attachments: string[];
  aiBackend?: AiBackend | null; // who parsed it; also the default for the hero composer next time
  parsed: boolean; // false = AI parse failed and we fell back to raw text
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
}

// A comment on an issue. Plain human comments are discussion; an agent author
// marks a turn produced by @-mentioning that agent (which also triggers execution
// server-side — see POST /issues/:id/comments).
export type CommentAuthor =
  | { kind: "human" }
  | { kind: "agent"; agentType: AgentType };

export interface IssueComment {
  id: string;
  issueId: string;
  author: CommentAuthor;
  body: string;
  attachments: string[]; // absolute paths (see Issue.attachments)
  createdAt: string;
  updatedAt?: string | null; // set when a comment is edited
  // Only set on agent comments produced by a discuss-intent @-mention:
  // pending 时 body 还是空的、气泡显示「…正在思考」；done/failed 是终态。
  status?: "pending" | "done" | "failed" | null;
}

// ── Global search (⌘K) ───────────────────────────────────────────────────────
// One hit per task/issue — the best-matching field wins, ranked
// title > body > comment > conversation. `conversation` means the match was
// found inside the task's session transcripts (data/runs/<taskId>/*.md|jsonl),
// which is where run artifacts like output directory names live.
export type SearchField = "title" | "body" | "comment" | "conversation";
export interface SearchHit {
  kind: "task" | "issue";
  id: string;
  title: string;
  status: TaskStatus | IssueStatus;
  projectId: string | null;
  projectName: string | null;
  archived: boolean; // tasks only; issues are always false
  field: SearchField;
  // Context around the first match, whitespace-collapsed to one line.
  // Empty for title hits (the title is already shown).
  snippet: string;
  updatedAt: string;
}

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
    priority?: Priority;
    labels?: string[];
  };
}

// ── Debate (§7) ──────────────────────────────────────────────────────────────
export type HitlGate = "off" | "on";

// /pair is discussion-only: two debaters challenge each other and produce a
// conclusion. Code execution belongs to /team.
export type DebateStyle = "debate";

export interface DebateConfig {
  topic: string;
  style: DebateStyle;
  debaterA: AgentType;
  debaterB: AgentType;
  maxRounds: number | null; // null = unlimited
  gateG1: HitlGate; // consensus gate
}

export const DEBATE_DEFAULTS: DebateConfig = {
  topic: "",
  style: "debate",
  debaterA: "claude",
  debaterB: "codex",
  maxRounds: null,
  gateG1: "on",
};

// Database rows and localStorage may contain fields from retired /pair modes.
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
    maxRounds,
    gateG1: raw.gateG1 === "off" ? "off" : "on",
  };
}

// ── Sessions / traceability (§13) ─────────────────────────────────────────────
// "lead" = 团队任务的常驻调度台会话（一个进程跑很多回合，见 server/src/team）；
// 执行者自己的会话仍是 "single"。
export type SessionRole =
  | "single"
  | "lead"
  | "debaterA"
  | "debaterB"
  | "implementer" // legacy: retained so historical sessions still decode
  | "reviewer"; // legacy: retained so historical sessions still decode

export interface Session {
  id: string;
  taskId: string;
  role: SessionRole;
  agentType: AgentType;
  executor: string; // executor profile name
  target: string; // "local" | "ssh:host"
  worktreePath: string | null;
  branch: string | null;
  cwd: string | null; // the actual working directory this run executed in (truth, incl. scratch fallback)
  cliSessionId: string | null; // the CLI's own session/thread id = core credential
  resumeCommand: string | null; // ready-to-paste resume command
  commandLine: string | null; // full command invoked
  startedAt: string;
  endedAt: string | null; // when this run finished (set with exitStatus); null while live
  exitStatus: number | null;
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
    }
  | { type: "debate.gate"; taskId: string; gate: GateName; open: boolean; consensus?: boolean; conclusionA?: string | null; conclusionB?: string | null }
  // A human intervention in a /pair timeline (gate inject/ask). Carries the time
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
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) segs.push({ kind: "agent", text: t });
    buf = [];
  };
  for (const line of out.split("\n")) {
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
    const trimmed = line.trim();
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
