import type { HandoffPingProject, HandoffTarget, TaskHandoff } from "@ash/shared";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { eq } from "drizzle-orm";
import { getAppSettings } from "./app-settings.js";
import { db } from "./db/index.js";
import { handoffPeers, projects, tasks } from "./db/schema.js";
import { sameFingerprint } from "./handoff-identity.js";
import { HandoffError } from "./handoff-types.js";
import { projectHealthLight } from "./git.js";

function markerOf(raw: string | null): TaskHandoff | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as TaskHandoff; } catch { return null; }
}

function hostForUrl(address: string): string | null {
  const raw = address.trim().replace(/^::ffff:/i, "");
  const unwrapped = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  const normalized = unwrapped.split("%")[0] ?? "";
  if (isIP(normalized)) return normalized.includes(":") ? `[${normalized}]` : normalized;
  const hostname = domainToASCII(normalized);
  if (!hostname || hostname.length > 253
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i.test(hostname)) {
    return null;
  }
  return hostname;
}

export function sourceUrlFromPeer(address: string | undefined, port: unknown): string | null {
  const host = hostForUrl(address ?? "");
  const numericPort = Number(port);
  if (!host || !Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) return null;
  return `http://${host}:${numericPort}`;
}

export async function returnArchiveForPeer(
  taskId: string,
  callerFingerprint: string,
  returnTransferId?: string | null,
): Promise<{ project: HandoffPingProject; marker: TaskHandoff }> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row) throw new HandoffError("原机没有这条任务的历史存档", 404);
  const marker = markerOf(row.handoff);
  const confirmedOut = marker?.direction === "out" && !marker.pending;
  const completedReturn = marker?.direction === "returned"
    && Object.prototype.hasOwnProperty.call(marker, "returnTransferId");
  if ((!confirmedOut && !completedReturn) || !marker?.peerFp
    || !sameFingerprint(marker.peerFp, callerFingerprint)) {
    throw new HandoffError("只有这条任务当前记录的持有机器才能免审批移回", 403);
  }
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

export function assertReturnProject(targetProjectId: string, archiveProjectId: string): void {
  if (targetProjectId !== archiveProjectId) {
    throw new HandoffError("免审批移回只能落回原任务所属项目", 403);
  }
}

export async function returnTargetForMarker(marker: TaskHandoff): Promise<HandoffTarget | null> {
  if (marker.direction !== "in" || !marker.peerFp) return null;
  // 任务本次导入时从真实 TCP 来源 + 对端自报端口恢复出的地址最新，也和这条任务绑定；
  // 设置项可能是 DHCP 变化前的旧地址，只作为老记录的兜底。
  if (marker.peerUrl) {
    return { name: marker.peerName || "来源机器", url: marker.peerUrl, peerFp: marker.peerFp };
  }
  const settings = await getAppSettings();
  const registered = settings.handoffTargets.find((target) => target.peerFp
    && sameFingerprint(target.peerFp, marker.peerFp));
  if (registered) return registered;
  // handoff_peers 只保存最近 TCP 地址，没有来源机监听端口。不能拿本机 PORT 猜；
  // 前端会让用户临时补一个 URL，服务端仍按 marker.peerFp 做任务级身份核对。
  return null;
}

export async function returnTargetForTask(taskId: string): Promise<HandoffTarget | null> {
  const row = (await db.select({ handoff: tasks.handoff }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  const marker = markerOf(row?.handoff ?? null);
  return marker ? returnTargetForMarker(marker) : null;
}
