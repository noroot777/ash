// 移回的**授权**一侧:哪台机器有资格把一条任务免审批地移回本机,落回哪个项目。
// 「该往哪个地址移回」是另一件事,在 handoff-return-address.ts。
import type { HandoffPingProject, HandoffReturnGrant, TaskHandoff } from "@ash/shared";
import type { Actor } from "./auth/context.js";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { handoffPeers, projects, tasks } from "./db/schema.js";
import { sameFingerprint, shortFingerprint } from "./handoff-identity.js";
import { HandoffError } from "./handoff-types.js";
import { projectHealthLight } from "./git.js";

function markerOf(raw: string | null): TaskHandoff | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as TaskHandoff; } catch { return null; }
}

function grantsTaskReturn(marker: TaskHandoff | null): marker is TaskHandoff & { peerFp: string } {
  if (!marker?.peerFp) return false;
  const confirmedOut = marker.direction === "out" && !marker.pending;
  const completedReturn = marker.direction === "returned"
    && Object.prototype.hasOwnProperty.call(marker, "returnTransferId");
  return confirmedOut || completedReturn;
}

export async function returnArchiveForPeer(
  taskId: string,
  callerFingerprint: string,
  returnTransferId?: string | null,
): Promise<{ project: HandoffPingProject; marker: TaskHandoff }> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row) throw new HandoffError("原机没有这条任务的历史存档", 404);
  const marker = markerOf(row.handoff);
  if (!grantsTaskReturn(marker) || !sameFingerprint(marker.peerFp, callerFingerprint)) {
    throw new HandoffError("只有这条任务当前记录的持有机器才能免审批移回", 403);
  }
  const completedReturn = marker.direction === "returned";
  const completedReturnTransferId = (marker as TaskHandoff & { returnTransferId?: string | null }).returnTransferId;
  const expectedReturnTransferId = completedReturn ? completedReturnTransferId : marker.transferId;
  if (expectedReturnTransferId && expectedReturnTransferId !== returnTransferId) {
    throw new HandoffError("移回凭据与原接力记录不一致", 403);
  }
  const peer = (await db.select({ status: handoffPeers.status }).from(handoffPeers)
    .where(eq(handoffPeers.fingerprint, callerFingerprint))).at(0);
  if (peer?.status === "blocked") {
    throw new HandoffError("这台持有机器已被原机明确拒绝，不能自动移回", 403);
  }
  const project = (await db.select().from(projects).where(eq(projects.id, row.projectId))).at(0);
  if (!project) throw new HandoffError("原任务所属项目不存在", 404);
  return {
    marker,
    project: {
      id: project.id,
      name: project.name,
      repoPath: project.repoPath,
      isRepo: projectHealthLight(project.repoPath).isRepo,
    },
  };
}

/**
 * 哪些人有资格拒绝**这个指纹**的历史回程 —— 返回授权它移回的那些任务的归属人。
 * 空集合 = 这个指纹压根没有历史回程可拒。
 *
 * 存在的理由:「拒绝这台机器」是接力来源名单上唯一一个**记录还不存在就能点**的动作
 * (它拒的是任务标记给出的回程权限,不是一条配对申请)。不把这条路收窄到「确实有回程
 * 可拒」的话,任意成员随手一个指纹就能凭空落一行全局 blocked,把那台机器之后所有人的
 * 正式申请一起挡死,而被申请的本人连这行记录都看不见(第 1 轮审查 P1)。
 */
export async function returnGrantOwners(fingerprint: string): Promise<Set<string | null>> {
  const owners = new Set<string | null>();
  const rows = await db.select({ handoff: tasks.handoff, ownerUserId: tasks.ownerUserId }).from(tasks);
  for (const row of rows) {
    const marker = markerOf(row.handoff);
    if (!grantsTaskReturn(marker)) continue;
    if (sameFingerprint(marker.peerFp, fingerprint)) owners.add(row.ownerUserId ?? null);
  }
  return owners;
}

/**
 * 历史回程清单。`canRevoke` 跟 `requireReturnGrantToRevoke` 是同一条判据的两面:后端拒得
 * 住,前端才知道该不该露那颗按钮 —— 留一颗按下去 403 的按钮只会让人以为功能坏了。
 */
export async function listReturnGrants(actor: Actor): Promise<HandoffReturnGrant[]> {
  const [taskRows, peerRows] = await Promise.all([
    db.select({ handoff: tasks.handoff, ownerUserId: tasks.ownerUserId }).from(tasks),
    db.select({ fingerprint: handoffPeers.fingerprint, status: handoffPeers.status }).from(handoffPeers),
  ]);
  const blocked = new Set(peerRows.filter((peer) => peer.status === "blocked")
    .map((peer) => peer.fingerprint.trim().toLowerCase()));
  const anyGrant = actor.kind === "single" || actor.role === "admin";
  const grants = new Map<string, HandoffReturnGrant>();
  for (const row of taskRows) {
    const marker = markerOf(row.handoff);
    if (!grantsTaskReturn(marker)) continue;
    const fingerprint = marker.peerFp.trim().toLowerCase();
    const mine = anyGrant || Boolean(actor.userId && row.ownerUserId === actor.userId);
    const current = grants.get(fingerprint);
    const at = marker.at || "";
    if (!current) {
      grants.set(fingerprint, {
        fingerprint,
        short: shortFingerprint(marker.peerFp),
        name: marker.peerName || "历史持有机器",
        taskCount: 1,
        lastGrantedAt: at,
        blocked: blocked.has(fingerprint),
        canRevoke: mine,
      });
      continue;
    }
    current.taskCount += 1;
    current.canRevoke = current.canRevoke || mine;
    if (at > current.lastGrantedAt) {
      current.lastGrantedAt = at;
      current.name = marker.peerName || current.name;
    }
  }
  return [...grants.values()].sort((a, b) => b.lastGrantedAt.localeCompare(a.lastGrantedAt));
}

export function assertReturnProject(targetProjectId: string, archiveProjectId: string): void {
  if (targetProjectId !== archiveProjectId) {
    throw new HandoffError("免审批移回只能落回原任务所属项目", 403);
  }
}
