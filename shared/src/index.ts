// Core domain types shared between server and web.
// Mirrors the decisions in DESIGN.md (§3 data model, §5 agents, §7 debate,
// §8 statuses, §12 debate mechanism, §13 sessions).

// ── Agents (§5) ────────────────────────────────────────────────────────────
// Abstraction layer: the *type* is what you @ / pick as a debater.
export type AgentType = "claude" | "codex" | "antigravity";

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
}

// ── Debate (§7) ──────────────────────────────────────────────────────────────
export type HitlGate = "off" | "on";

export interface DebateConfig {
  topic: string;
  debaterA: AgentType;
  debaterB: AgentType;
  implementer: "A" | "B"; // who implements after consensus (default A)
  maxRounds: number | null; // null = unlimited
  gateG1: HitlGate; // consensus gate, default on
  gateG2: HitlGate; // code gate, default off
}

export const DEBATE_DEFAULTS: DebateConfig = {
  topic: "",
  debaterA: "claude",
  debaterB: "codex",
  implementer: "A",
  maxRounds: null,
  gateG1: "on",
  gateG2: "off",
};

// ── Sessions / traceability (§13) ─────────────────────────────────────────────
export type SessionRole = "single" | "debaterA" | "debaterB" | "implementer";

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
  | { kind: "error"; message: string }
  | { kind: "done"; exitStatus: number };

export type DebateSpeaker = "A" | "B" | "impl";

// SSE envelope pushed to the web client.
export type ServerEvent =
  | { type: "task.status"; taskId: string; status: TaskStatus }
  | { type: "task.title"; taskId: string; title: string }
  | {
      type: "agent.event";
      taskId: string;
      sessionId: string;
      role: SessionRole;
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
  | { type: "debate.gate"; taskId: string; gate: GateName; open: boolean; consensus?: boolean; conclusionA?: string | null; conclusionB?: string | null };
