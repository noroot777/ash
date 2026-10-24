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
};

export const regressionEvidence = sqliteTable("regression_evidence", {
  directory: text("directory").primaryKey(),
  taskId: text("task_id").notNull(),
  generation: text("generation").notNull(),
  revoked: integer("revoked", { mode: "boolean" }).notNull().default(false),
  excludedMonitors: text("excluded_monitors", { mode: "json" }).$type<string[]>().notNull(),
  acceptedBasis: text("accepted_basis", { mode: "json" }).$type<IndependentVerificationBasis>(),
  unavailable: text("unavailable"),
  settlement: text("settlement", { mode: "json" }).$type<RegressionSettlement>(),
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
}
