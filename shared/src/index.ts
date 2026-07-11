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
  createdAt: string;
}

export type TaskMode = "single" | "debate";

export type TaskStatus =
  | "backlog"
  | "queued"
  | "running"
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

export const ARCHIVABLE_STATUSES: TaskStatus[] = ["done", "failed", "canceled"];
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
  // debate mode config (§7):
  debate?: DebateConfig;
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
}

// ── Issues (§Issues) ─────────────────────────────────────────────────────────
// An Issue is the lightweight planning/discussion layer that sits UPSTREAM of
// tasks (like GitHub Issues → Actions runs): you capture it in one line, the AI
// structures it and infers its project, you discuss it, then you @-mention a CLI
// agent to EXECUTE it — which derives a task carrying the full context.
export type IssueStatus = "open" | "in_progress" | "done" | "canceled";
export const ISSUE_STATUSES: IssueStatus[] = ["open", "in_progress", "done", "canceled"];

// Which AI handled the parse/recognition for an issue. CLI = a local executor
// (claude/codex/…, has tools); API = a configured direct-LLM connection (LlmProvider,
// text-only — fine for parsing, NOT for execution). Execution always uses CLI.
export type AiBackend =
  | { kind: "cli"; agentType: AgentType }
  | { kind: "api"; providerId: string };

// ── Direct-LLM connections (中转站, system-level) ────────────────────────────
// A configured way to call a model over HTTP — an official endpoint OR a relay
// (中转站): pick the wire protocol, fill the base URL + API key + a model. Global
// (not per-project). Used ONLY for issue parsing, never for execution.
export type LlmProtocol = "anthropic" | "openai";
export interface LlmProvider {
  id: string;
  name: string;
  protocol: LlmProtocol; // anthropic-compatible (/messages) | openai-compatible (/chat/completions)
  baseUrl: string; // e.g. https://api.openai.com/v1 — or a relay's base, version path included
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
    priority?: Priority;
    labels?: string[];
  };
}

// ── Debate (§7) ──────────────────────────────────────────────────────────────
export type HitlGate = "off" | "on";

// Two ways two AIs can work together. "辩论给你答案,协作给你代码":
//   debate      = 对抗 → 出结论（不改代码：无实现方/审查方/G2）
//   collaborate = 协作 → 出代码（一方实现、另一方 review）
export type DebateStyle = "debate" | "collaborate";

export interface DebateConfig {
  topic: string;
  style: DebateStyle; // 辩论 | 协作
  debaterA: AgentType;
  debaterB: AgentType;
  implementer: "A" | "B"; // (collaborate only) who implements; the OTHER reviews
  maxRounds: number | null; // null = unlimited
  gateG1: HitlGate; // 收敛门(辩论) / 方案门(协作)
  gateG2: HitlGate; // (collaborate only) 代码门
}

export const DEBATE_DEFAULTS: DebateConfig = {
  topic: "",
  style: "debate",
  debaterA: "claude",
  debaterB: "codex",
  implementer: "A",
  maxRounds: null,
  gateG1: "on",
  gateG2: "off",
};

// ── Sessions / traceability (§13) ─────────────────────────────────────────────
export type SessionRole = "single" | "debaterA" | "debaterB" | "implementer" | "reviewer";

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
export type GateName = "G1" | "G2"; // G1 = consensus gate, G2 = code gate
export type GateAction =
  | { kind: "approve"; text?: string; side?: "A" | "B" } // 放行 (text = note; side = chosen plan when debaters disagreed)
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
  | { kind: "done"; exitStatus: number };

export type DebateSpeaker = "A" | "B" | "impl" | "review" | "user";

// SSE envelope pushed to the web client.
export type ServerEvent =
  | { type: "task.status"; taskId: string; status: TaskStatus; startedAt?: string | null; endedAt?: string | null; activeMs?: number | null; liveSince?: string | null }
  | { type: "task.title"; taskId: string; title: string }
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
