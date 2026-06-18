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
// not schedulable. Controls parallel/serial + worktree isolation default.
export interface Group {
  id: string;
  projectId: string;
  name: string;
  mode: GroupMode;
  useWorktree: boolean; // default true
  paused: boolean; // 暂停 = 立刻冻结整组：调度器不再启动"还没开始"的任务，正在运行的也会被停掉（结算为 canceled，可继续）；再次「运行/继续」时恢复，被停的任务从中断处接着跑
  createdAt: string;
}

export type TaskMode = "single" | "debate";

export type TaskStatus =
  | "backlog"
  | "queued"
  | "running"
  | "awaiting_review"
  | "done"
  | "failed"
  | "canceled";

export type Priority = "none" | "low" | "medium" | "high" | "urgent";

// A task can be (re)started only from a settled, non-terminal-success state.
// running/queued = already in flight; awaiting_review = waiting on a gate;
// done = finished (must not be casually re-run). Single source of truth for the
// run guard across the UI (button/Cmd-K/key) and the server (/run, group run).
export function canStartTask(status: TaskStatus): boolean {
  return status === "backlog" || status === "canceled" || status === "failed";
}

// running / queued / awaiting_review reflect live execution — only the
// orchestrator/scheduler/gate set them. A human may only set these "settled"
// statuses; the rest are system-owned (so you can't e.g. mark a task "running"
// by hand, which would desync from reality).
export const USER_SETTABLE_STATUSES: TaskStatus[] = ["backlog", "done", "failed", "canceled"];
export function isUserSettableStatus(status: TaskStatus): boolean {
  return USER_SETTABLE_STATUSES.includes(status);
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
  dependsOn: string[]; // cross-task dependency edges (§3)
  autoTitle?: boolean; // title is AI-generated on first run until the user edits it
  // single mode:
  agentType?: AgentType;
  // debate mode config (§7):
  debate?: DebateConfig;
  scheduleId?: string | null;
  createdAt: string;
  updatedAt: string;
  // Run timing: startedAt = first time the task entered `running` (kept across
  // re-runs); endedAt = the last time it reached a terminal state, cleared while
  // running. Duration = (endedAt ?? now) − startedAt. Both null until first run.
  startedAt?: string | null;
  endedAt?: string | null;
}

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

// ── HITL gates (§7) ──────────────────────────────────────────────────────────
export type GateName = "G1" | "G2"; // G1 = consensus gate, G2 = code gate
export type GateAction =
  | { kind: "approve"; text?: string; side?: "A" | "B" } // 放行 (text = note; side = chosen plan when debaters disagreed)
  | { kind: "reject" } // 打回终止
  | { kind: "inject"; text: string } // 注入意见 → 回炉再辩
  | { kind: "ask"; text: string }; // 提问 → 答完继续

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
  | { type: "task.status"; taskId: string; status: TaskStatus; startedAt?: string | null; endedAt?: string | null }
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
  | { type: "debate.user"; taskId: string; round: number; text: string; at: string };
