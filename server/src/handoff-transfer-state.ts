import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TaskHandoff } from "@ash/shared";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { sameFingerprint } from "./handoff-identity.js";
import { HandoffError } from "./handoff-types.js";
import { DATA_DIR } from "./paths.js";

const importsInFlight = new Set<string>();
const cancellationsInFlight = new Set<string>();

const stateRoot = (() => {
  const dbPath = process.env.ASH_DB?.trim();
  return dbPath && dbPath !== ":memory:"
    ? join(dirname(resolve(dbPath)), "handoff-canceled")
    : join(DATA_DIR, "handoff-canceled");
})();

function cancellationPath(taskId: string, transferId: string, sourceFingerprint: string): string {
  const key = createHash("sha256")
    .update(sourceFingerprint).update("\0").update(taskId).update("\0").update(transferId)
    .digest("hex");
  return join(stateRoot, `${key}.json`);
}

export function beginHandoffImport(taskId: string): boolean {
  if (importsInFlight.has(taskId) || cancellationsInFlight.has(taskId)) return false;
  importsInFlight.add(taskId);
  return true;
}

export function endHandoffImport(taskId: string): void {
  importsInFlight.delete(taskId);
}

export function assertHandoffNotCanceled(taskId: string, transferId?: string | null, sourceFingerprint?: string | null): void {
  if (!transferId || !sourceFingerprint) return;
  if (existsSync(cancellationPath(taskId, transferId, sourceFingerprint))) {
    throw new HandoffError("这次接力已由来源机安全撤销，旧请求不能再导入；需要迁移时请重新发起一次接力", 409);
  }
}

function markerOf(raw: string | null): TaskHandoff | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as TaskHandoff; } catch { return null; }
}

export async function cancelPendingInboundTransfer(input: {
  taskId: string;
  transferId: string;
  sourceFingerprint: string;
  returning: boolean;
  returnTransferId?: string | null;
}): Promise<void> {
  const { taskId, transferId, sourceFingerprint, returning, returnTransferId } = input;
  if (importsInFlight.has(taskId) || cancellationsInFlight.has(taskId)) {
    throw new HandoffError("对端正处理这次导入或撤销，暂时不能恢复本机任务；稍后再试", 409);
  }
  cancellationsInFlight.add(taskId);
  try {
    const row = (await db.select({ handoff: tasks.handoff }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (row) {
      const marker = markerOf(row.handoff);
      const unchangedReturnArchive = returning
        && marker?.direction === "out" && !marker.pending
        && Boolean(marker.peerFp) && sameFingerprint(marker.peerFp!, sourceFingerprint)
        && (!marker.transferId || marker.transferId === returnTransferId);
      if (!unchangedReturnArchive) {
        throw new HandoffError("对端已经收到这份任务，不能恢复本机旧副本；请原样重试接力以幂等收口", 409);
      }
    }
    mkdirSync(stateRoot, { recursive: true });
    const path = cancellationPath(taskId, transferId, sourceFingerprint);
    if (!existsSync(path)) {
      writeFileSync(path, JSON.stringify({ taskId, transferId, sourceFingerprint, at: new Date().toISOString() }));
    }
  } finally {
    cancellationsInFlight.delete(taskId);
  }
}
