import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export type IndependentVerificationBasis = {
  kind: "independent";
  generation: string;
  monitors: Array<{ id: string; unitToken: string; digest: string }>;
};

export type RegressionSettlement = {
  outcome: "done" | "failed" | "canceled";
  conclusion: "verified" | "verify_failed" | null;
  ownerTaskId: string;
  round: number;
  freeRoundId?: string;
  pending: boolean;
  target?: ReviewTargetIdentity | null;
};

export type ReviewTargetIdentity = {
  turnToken: string | null;
  directionToken: string | null;
  directionEpoch: number;
};

export type ReviewContinuation = {
  phase: "running" | "waiting" | "delivery" | "uncertain" | "exited";
  start?: { ownerTaskId: string; identity: ReviewTargetIdentity };
  messageId?: string;
  wait?: {
    owner?: ReviewTargetIdentity;
    question: { text: string; options: string | null; items: string | null } | null;
    checkpoint: { text: string; generation: number } | null;
  };
};

export type ReviewDelivery = { generation: string; kind: "answer" | "repair"; messageId: string }
  | { generation: string | null; kind: "checkpoint"; text: string; promptGeneration: number };

export type RegressionFinalization = {
  kind: "preset" | "free";
  payload: string;
  done: string[];
  steps: string[];
  runningStep?: string;
  blockedStep?: string;
  acceptance?: { token: string; stepId: string; stage: "merged" | "accepted" };
  repair?: { messageId: string; token: string; stepId: string; attempt: number; identity: ReviewTargetIdentity };
  completed?: boolean;
  superseded?: boolean;
};

export const regressionEvidence = sqliteTable("regression_evidence", {
  directory: text("directory").primaryKey(),
  taskId: text("task_id").notNull(),
  generation: text("generation").notNull(),
  // 已退役(用户 2026-10-26 改回归口径):没有写入方也没有读取方,恒为 0。列和存量数据保留,
  // 不做迁移 —— 退役原因见 `regression-evidence-lifecycle.ts` 的 `evidenceState`。
  revoked: integer("revoked", { mode: "boolean" }).notNull().default(false),
  excludedMonitors: text("excluded_monitors", { mode: "json" }).$type<string[]>().notNull(),
  acceptedBasis: text("accepted_basis", { mode: "json" }).$type<IndependentVerificationBasis>(),
  unavailable: text("unavailable"),
  settlement: text("settlement", { mode: "json" }).$type<RegressionSettlement>(),
  finalization: text("finalization", { mode: "json" }).$type<RegressionFinalization>(),
  targetIdentity: text("target_identity", { mode: "json" }).$type<ReviewTargetIdentity>(),
  continuation: text("continuation", { mode: "json" }).$type<ReviewContinuation>(),
});

export async function ensureRegressionEvidenceSchema(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS regression_evidence (
    directory TEXT PRIMARY KEY, task_id TEXT NOT NULL, generation TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0, excluded_monitors TEXT NOT NULL,
    accepted_basis TEXT, unavailable TEXT, settlement TEXT
  )`);
  const columns = (await client.execute("PRAGMA table_info(regression_evidence)")).rows;
  if (!columns.some((column) => column.name === "settlement")) {
    await client.execute("ALTER TABLE regression_evidence ADD COLUMN settlement TEXT");
  }
  if (!columns.some((column) => column.name === "finalization")) {
    await client.execute("ALTER TABLE regression_evidence ADD COLUMN finalization TEXT");
  }
  for (const column of ["target_identity", "continuation"]) {
    if (!columns.some((entry) => entry.name === column)) await client.execute(`ALTER TABLE regression_evidence ADD COLUMN ${column} TEXT`);
  }
}
