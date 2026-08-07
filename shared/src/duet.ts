// Duet(讨论)配置与归一 —— 从 index.ts 拆出的**含运行时值**模块。
// 消费端走子路径 `@harness/shared/duet`(照 team/executors 的先例):index.ts 只
// type re-export,不转发运行时值 —— 服务端直接跑 shared 的 .ts 源码,index 转发
// 运行时值会让进程起不来(见 server/CLAUDE.md「执行器与模型」最后一条)。
import { AGENT_TYPES, type AgentType } from "./index.ts";

// ── Duet 讨论 (§7) ───────────────────────────────────────────────────────────
export type HitlGate = "off" | "on";
export type DuetConsensusBy = "both" | "A" | "B";

// /duet is discussion-only: two voices work a hard decision into one plan.
// Code execution belongs to /team.
export type DuetStyle = "duet";

export interface DuetConfig {
  topic: string;
  style: DuetStyle;
  voiceA: AgentType;
  voiceB: AgentType;
  voiceAExecutorId?: string | null;
  voiceBExecutorId?: string | null;
  // Per-voice model / effort overrides. null = follow that voice's executor
  // profile. Voices are picked independently, so their models are too — a
  // single task-level model would silently apply to both sides.
  voiceAModel?: string | null;
  voiceAReasoningEffort?: string | null;
  voiceBModel?: string | null;
  voiceBReasoningEffort?: string | null;
  maxRounds: number | null; // null = unlimited
  gateG1: HitlGate; // consensus gate
}

export const DUET_DEFAULTS: DuetConfig = {
  topic: "",
  style: "duet",
  voiceA: "claude",
  voiceB: "codex",
  voiceAExecutorId: null,
  voiceBExecutorId: null,
  voiceAModel: null,
  voiceAReasoningEffort: null,
  voiceBModel: null,
  voiceBReasoningEffort: null,
  maxRounds: null,
  gateG1: "on",
};

// Database rows and localStorage may contain fields from retired variants —
// including the pre-rename debate shape (debaterA/debaterB/…). Normalize at
// every boundary so old tasks remain readable while all new runs use the single
// supported duet shape.
export function normalizeDuetConfig(value: unknown): DuetConfig {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  // Pre-rename fallback: voiceA used to be called debaterA (etc.).
  const pick = (voiceKey: string, debaterKey: string): unknown =>
    raw[voiceKey] !== undefined ? raw[voiceKey] : raw[debaterKey];
  const agent = (v: unknown, fallback: AgentType): AgentType =>
    typeof v === "string" && AGENT_TYPES.includes(v as AgentType) ? v as AgentType : fallback;
  const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const maxRounds = raw.maxRounds === null
    ? null
    : typeof raw.maxRounds === "number" && Number.isFinite(raw.maxRounds) && raw.maxRounds >= 1
      ? Math.floor(raw.maxRounds)
      : DUET_DEFAULTS.maxRounds;
  const idOf = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    topic: typeof raw.topic === "string" ? raw.topic : DUET_DEFAULTS.topic,
    style: "duet",
    voiceA: agent(pick("voiceA", "debaterA"), DUET_DEFAULTS.voiceA),
    voiceB: agent(pick("voiceB", "debaterB"), DUET_DEFAULTS.voiceB),
    voiceAExecutorId: idOf(pick("voiceAExecutorId", "debaterAExecutorId")),
    voiceBExecutorId: idOf(pick("voiceBExecutorId", "debaterBExecutorId")),
    voiceAModel: text(pick("voiceAModel", "debaterAModel")),
    voiceAReasoningEffort: text(pick("voiceAReasoningEffort", "debaterAReasoningEffort")),
    voiceBModel: text(pick("voiceBModel", "debaterBModel")),
    voiceBReasoningEffort: text(pick("voiceBReasoningEffort", "debaterBReasoningEffort")),
    maxRounds,
    gateG1: raw.gateG1 === "off" ? "off" : "on",
  };
}
