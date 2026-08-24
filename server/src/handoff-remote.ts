import type { HandoffTarget, TaskHandoff } from "@ash/shared";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { getAppSettings } from "./app-settings.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { readCappedBody } from "./handoff-body.js";
import { fetchPeer, normalizePeerUrl, pingPeer } from "./handoff-peer-client.js";
import { sameFingerprint } from "./handoff-identity.js";
import { requireApprovedPeer } from "./handoff-peers.js";
import { HandoffError } from "./handoff-types.js";
import { exportHandoff, preflightHandoff } from "./handoff.js";
import { replyToTask, type TaskReplyBody } from "./task-reply.js";
import { answerTask } from "./task-answer.js";
import { sessionOutputText, sessionsForTask, sessionTraceEntries } from "./task-session-routes.js";
import { enrichTasks } from "./task-store.js";

type ProxyBody = TaskReplyBody & { taskId?: string; answer?: string };
type BrowserProxyBody = TaskReplyBody & { targetUrl?: string; answer?: string };

function fail(c: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof HandoffError ? error.status : 500;
  return c.json({ error: message, ash: true }, status as 400 | 401 | 403 | 404 | 409 | 413 | 500 | 502);
}

function markerOf(raw: string | null): TaskHandoff | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as TaskHandoff; } catch { return null; }
}

function normalizedUrl(raw: string): string {
  return normalizePeerUrl(raw).replace(/\/+$/, "");
}

function targetForOutbound(marker: TaskHandoff, rawTargetUrl: string, targets: HandoffTarget[]): HandoffTarget {
  if (marker.direction !== "out" || marker.pending) {
    throw new HandoffError("这不是已确认接力出去的任务", 409);
  }
  const wanted = normalizedUrl(rawTargetUrl);
  if (!marker.peerUrl || normalizedUrl(marker.peerUrl) !== wanted) {
    throw new HandoffError("任务记录的持有机器与请求目标不一致", 409);
  }
  const target = targets.find((item) => normalizedUrl(item.url) === wanted);
  if (!target) throw new HandoffError("这台持有机器已从接力设置中移除", 409);
  if (marker.peerFp && target.peerFp && !sameFingerprint(marker.peerFp, target.peerFp)) {
    throw new HandoffError("任务记录的机器身份与当前设置不一致，请重新核对指纹", 409);
  }
  return target;
}

async function outboundTask(taskId: string, rawTargetUrl: string) {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row) throw new HandoffError("任务不存在", 404);
  const marker = markerOf(row.handoff);
  if (!marker) throw new HandoffError("任务没有接力记录", 409);
  const { handoffTargets } = await getAppSettings();
  const target = targetForOutbound(marker, rawTargetUrl, handoffTargets);
  const expectedFp = marker.peerFp ?? target.peerFp ?? null;
  const probe = await pingPeer(normalizedUrl(target.url), expectedFp);
  if (!probe.peer) throw new HandoffError("远端版本过旧，无法安全代理任务会话", 409);
  return { row, marker, target, targetUrl: normalizedUrl(target.url) };
}

async function signedBody(c: Context): Promise<{ peer: NonNullable<Awaited<ReturnType<typeof requireApprovedPeer>>>; body: ProxyBody }> {
  const bytes = await readCappedBody(c.req.raw, 1);
  const peer = await requireApprovedPeer(c, bytes);
  if (!peer) throw new HandoffError("远程任务代理要求带机器身份签名", 401);
  let body: ProxyBody;
  try { body = JSON.parse(bytes.toString("utf8")) as ProxyBody; } catch { throw new HandoffError("请求体不是合法 JSON", 400); }
  return { peer, body };
}

async function ownedInboundTask(taskId: string, peerFingerprint: string) {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row) throw new HandoffError("远端任务不存在", 404);
  const marker = markerOf(row.handoff);
  if (marker?.direction !== "in" || !marker.peerFp || !sameFingerprint(marker.peerFp, peerFingerprint)) {
    throw new HandoffError("这台来源机无权读取或操作该任务", 403);
  }
  return { row, marker };
}

async function snapshotFor(taskId: string, callerFingerprint: string) {
  const { row } = await ownedInboundTask(taskId, callerFingerprint);
  const task = (await enrichTasks([row]))[0];
  const sessions = await sessionsForTask(taskId);
  const persisted = await Promise.all(sessions.map(async (session) => ({
    session,
    output: await sessionOutputText(taskId, session.id),
    trace: await sessionTraceEntries(taskId, session.id),
  })));
  const { handoffTargets } = await getAppSettings();
  const returnTarget = handoffTargets.find((target) => target.peerFp && sameFingerprint(target.peerFp, callerFingerprint));
  return { task, sessions, persisted, returnAvailable: Boolean(returnTarget) };
}

export function mountHandoffRemoteRoutes(api: Hono): void {
  // 机器面：只接受获批且签名的来源机，并且只允许它访问自己交来的入站任务。
  api.post("/handoff/proxy/task/snapshot", async (c) => {
    try {
      const { peer, body } = await signedBody(c);
      if (!body.taskId) throw new HandoffError("缺 taskId", 400);
      return c.json(await snapshotFor(body.taskId, peer.fingerprint));
    } catch (error) { return fail(c, error); }
  });

  api.post("/handoff/proxy/task/reply", async (c) => {
    try {
      const { peer, body } = await signedBody(c);
      if (!body.taskId) throw new HandoffError("缺 taskId", 400);
      await ownedInboundTask(body.taskId, peer.fingerprint);
      return replyToTask(c, body.taskId, body);
    } catch (error) { return fail(c, error); }
  });

  api.post("/handoff/proxy/task/answer", async (c) => {
    try {
      const { peer, body } = await signedBody(c);
      if (!body.taskId) throw new HandoffError("缺 taskId", 400);
      await ownedInboundTask(body.taskId, peer.fingerprint);
      return answerTask(c, body.taskId, { answer: body.answer });
    } catch (error) { return fail(c, error); }
  });

  api.post("/handoff/proxy/task/return", async (c) => {
    try {
      const { peer, body } = await signedBody(c);
      if (!body.taskId) throw new HandoffError("缺 taskId", 400);
      const owned = await ownedInboundTask(body.taskId, peer.fingerprint);
      const { handoffTargets } = await getAppSettings();
      const target = handoffTargets.find((item) => item.peerFp && sameFingerprint(item.peerFp, peer.fingerprint));
      if (!target) throw new HandoffError("远端没有登记与来源机指纹一致的移回目标", 409);
      const preflight = await preflightHandoff(body.taskId, target.url);
      const targetProjectId = preflight.suggestedProjectId ?? preflight.projects.at(0)?.id;
      if (!targetProjectId) throw new HandoffError("来源机没有可接收任务的项目", 409);
      return c.json(await exportHandoff(body.taskId, {
        targetUrl: target.url,
        targetProjectId,
        targetName: target.name,
        autoResume: !owned.row.question,
      }));
    } catch (error) { return fail(c, error); }
  });

  // 浏览器面：浏览器只跟本机 Ash 说话，本机核对出站存档和目标指纹后再签名转发。
  api.post("/tasks/:id/remote-snapshot", async (c) => {
    try {
      const body = await c.req.json<BrowserProxyBody>();
      if (!body.targetUrl) throw new HandoffError("缺 targetUrl", 400);
      const remote = await outboundTask(c.req.param("id"), body.targetUrl);
      const snapshot = await fetchPeer<Awaited<ReturnType<typeof snapshotFor>>>(
        `${remote.targetUrl}/api/handoff/proxy/task/snapshot`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: remote.marker.peerTaskId }) },
      );
      return c.json({ ...snapshot, target: { name: remote.target.name, url: remote.targetUrl } });
    } catch (error) { return fail(c, error); }
  });

  api.post("/tasks/:id/remote-reply", async (c) => {
    try {
      const body = await c.req.json<BrowserProxyBody>();
      if (!body.targetUrl) throw new HandoffError("缺 targetUrl", 400);
      if (body.attachments?.length) throw new HandoffError("远程任务暂不支持本机附件路径", 400);
      const remote = await outboundTask(c.req.param("id"), body.targetUrl);
      const { targetUrl: _targetUrl, ...reply } = body;
      const result = await fetchPeer<Record<string, unknown>>(
        `${remote.targetUrl}/api/handoff/proxy/task/reply`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...reply, taskId: remote.marker.peerTaskId }) },
      );
      return c.json(result, 202);
    } catch (error) { return fail(c, error); }
  });

  api.post("/tasks/:id/remote-answer", async (c) => {
    try {
      const body = await c.req.json<BrowserProxyBody>();
      if (!body.targetUrl) throw new HandoffError("缺 targetUrl", 400);
      const remote = await outboundTask(c.req.param("id"), body.targetUrl);
      const result = await fetchPeer<Record<string, unknown>>(
        `${remote.targetUrl}/api/handoff/proxy/task/answer`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: remote.marker.peerTaskId, answer: body.answer }) },
      );
      return c.json(result);
    } catch (error) { return fail(c, error); }
  });

  api.post("/tasks/:id/remote-return", async (c) => {
    try {
      const body = await c.req.json<BrowserProxyBody>();
      if (!body.targetUrl) throw new HandoffError("缺 targetUrl", 400);
      const remote = await outboundTask(c.req.param("id"), body.targetUrl);
      await fetchPeer(
        `${remote.targetUrl}/api/handoff/proxy/task/return`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: remote.marker.peerTaskId }), timeoutMs: 600_000 },
      );
      const refreshed = (await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
      if (!refreshed) throw new HandoffError("任务已移回，但本机记录读取失败", 500);
      return c.json({ task: (await enrichTasks([refreshed]))[0] });
    } catch (error) { return fail(c, error); }
  });
}
