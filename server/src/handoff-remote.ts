import type {
  HandoffOutboundStateResult,
  HandoffPeerOffline,
  HandoffRemoteState,
  HandoffTarget,
  TaskHandoff,
} from "@ash/shared";
import { outboundHolder } from "@ash/shared/handoff";
import { and, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { getAppSettings } from "./app-settings.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { readCappedBody } from "./handoff-body.js";
import { fetchPeer, normalizePeerUrl, pingPeer } from "./handoff-peer-client.js";
import { sameFingerprint } from "./handoff-identity.js";
import { requireApprovedPeer, verifyPeerSignature } from "./handoff-peers.js";
import { HandoffError } from "./handoff-types.js";
import { exportHandoff, preflightHandoff } from "./handoff.js";
import { replyToTask, type TaskReplyBody } from "./task-reply.js";
import { answerTask } from "./task-answer.js";
import { sessionOutputText, sessionsForTask, sessionTraceEntries } from "./task-session-routes.js";
import { enrichTasks } from "./task-store.js";
import { returnTargetForMarker } from "./handoff-return-address.js";
import { cancelPendingInboundTransfer } from "./handoff-transfer-state.js";

type ProxyBody = TaskReplyBody & {
  taskId?: string;
  transferId?: string;
  returnTransferId?: string | null;
  answer?: string;
  items?: { taskId: string; transferId?: string }[];
};
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
  // 持有机认的是**设置里那一条**，不是 marker 里冻着的旧地址（判据见 shared 的
  // outboundHolder：地址 → 指纹 → 名字，指纹明确冲突的一律出局）。
  const target = outboundHolder(marker, targets);
  if (!target) {
    // 认不出来有两种，**得说清是哪一种**：说错了用户会去改错的东西。
    // 「指纹对不上」时地址多半还在设置里躺着，报成「已移除」只会让人对着一条明明还在的
    // 记录发愣；这一条的正解是去核对指纹，不是重新添一台机器。
    const sameUrl = targets.find((item) => normalizedUrl(item.url) === normalizedUrl(marker.peerUrl ?? ""));
    if (sameUrl && marker.peerFp && sameUrl.peerFp && !sameFingerprint(marker.peerFp, sameUrl.peerFp)) {
      throw new HandoffError("任务记录的机器身份与当前设置不一致，请重新核对指纹", 409);
    }
    throw new HandoffError("这台持有机器已从接力设置中移除", 409);
  }
  // 请求带来的目标必须就是它现在的地址 —— 这一层仍要卡，否则前端传谁就往谁发。
  if (normalizedUrl(target.url) !== normalizedUrl(rawTargetUrl)) {
    throw new HandoffError("任务记录的持有机器与请求目标不一致", 409);
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

async function signedCancellation(c: Context): Promise<{
  peer: NonNullable<ReturnType<typeof verifyPeerSignature>>;
  body: ProxyBody;
  returning: boolean;
}> {
  const bytes = await readCappedBody(c.req.raw, 1);
  let body: ProxyBody;
  try { body = JSON.parse(bytes.toString("utf8")) as ProxyBody; }
  catch { throw new HandoffError("请求体不是合法 JSON", 400); }
  const returning = Object.prototype.hasOwnProperty.call(body, "returnTransferId");
  const peer = returning ? verifyPeerSignature(c, bytes) : await requireApprovedPeer(c, bytes);
  if (!peer) throw new HandoffError("撤销接力要求带机器身份签名", 401);
  return { peer, body, returning };
}

async function ownedInboundTask(taskId: string, peerFingerprint: string, transferId?: string) {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row) throw new HandoffError("远端任务不存在", 404);
  const marker = markerOf(row.handoff);
  if (marker?.direction !== "in") {
    throw new HandoffError("这台来源机无权读取或操作该任务", 403);
  }
  if (marker.peerFp) {
    if (!sameFingerprint(marker.peerFp, peerFingerprint)) {
      throw new HandoffError("这台来源机无权读取或操作该任务", 403);
    }
    return { row, marker };
  }

  // 身份功能上线前导入的任务没有 peerFp，今天新增远程会话代理后会被一律挡成 403。
  // 源机的 out 标记与目标机的 in 标记仍共同持有同一个随机 transferId；只有已获批准、
  // 签名有效且能给出这枚接力身份证的来源机，才可把旧记录一次性绑定到自己的指纹。
  if (!transferId || !marker.transferId || marker.transferId !== transferId) {
    throw new HandoffError("这台来源机无权读取或操作该任务", 403);
  }
  const upgraded: TaskHandoff = {
    ...marker,
    peerFp: peerFingerprint,
    originFp: marker.originFp ?? peerFingerprint,
  };
  const upgradedRaw = JSON.stringify(upgraded);
  const claimed = await db.update(tasks)
    .set({ handoff: upgradedRaw })
    .where(and(eq(tasks.id, taskId), eq(tasks.handoff, row.handoff!)))
    .returning({ id: tasks.id });
  if (claimed.length) return { row: { ...row, handoff: upgradedRaw }, marker: upgraded };

  // 并发请求可能已经先完成绑定：只接受同一个来源指纹，别让后到者覆盖归属。
  const refreshed = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  const current = markerOf(refreshed?.handoff ?? null);
  if (refreshed && current?.direction === "in" && current.peerFp
    && sameFingerprint(current.peerFp, peerFingerprint)) {
    return { row: refreshed, marker: current };
  }
  throw new HandoffError("这台来源机无权读取或操作该任务", 403);
}

async function snapshotFor(taskId: string, callerFingerprint: string, transferId?: string) {
  const { row, marker } = await ownedInboundTask(taskId, callerFingerprint, transferId);
  const task = (await enrichTasks([row]))[0];
  const sessions = await sessionsForTask(taskId);
  const persisted = await Promise.all(sessions.map(async (session) => ({
    session,
    output: await sessionOutputText(taskId, session.id),
    trace: await sessionTraceEntries(taskId, session.id),
  })));
  const returnTarget = await returnTargetForMarker(marker);
  return { task, sessions, persisted, returnAvailable: Boolean(returnTarget) };
}

// 出站存档的实时状态:一次一台机器批量问,只回状态不回会话内容。
// 逐个任务鉴权,读不到的**静默跳过**而不是整批 403 —— 对端可能已经把其中一个移回/删掉,
// 一颗坏果子不该让整台机器的行全部退回冻住的旧状态。
async function remoteStatesFor(
  items: { taskId: string; transferId?: string }[],
  callerFingerprint: string,
): Promise<HandoffRemoteState[]> {
  const rows: HandoffRemoteState[] = [];
  for (const item of items) {
    if (!item?.taskId) continue;
    const owned = await ownedInboundTask(item.taskId, callerFingerprint, item.transferId).catch(() => null);
    if (!owned) continue;
    const task = (await enrichTasks([owned.row]))[0];
    rows.push({
      taskId: task.id,
      status: task.status,
      stage: task.stage ?? null,
      question: task.question ?? null,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  }
  return rows;
}

// 本机所有「确认接力出去」的行,按持有机分组。pending(应答丢失、没确认送到)的不算:
// 那种任务本机还硬拦着不让跑,状态归本机自己说,问对端只会问出个 404。
//
// 分组的 key 是**持有机现在的地址**,不是 marker 里冻着的那个:同一台机器换过地址之后,
// 换地址前后交出去的行要合并成同一次请求,而不是拆成「一台连得上、一台永远连不上」。
type PeerBucket = {
  target: HandoffTarget;
  items: { taskId: string; transferId?: string }[];
  // 这些行在接力那一刻记下的对端指纹(去重)。设置里那条 target 自己没记指纹时,
  // 它就是唯一能用来验明「这个地址后面还是不是那台机器」的东西 —— 见下面 outboundRemoteStates。
  expectedFps: Set<string>;
};

async function outboundByPeer(): Promise<Map<string, PeerBucket>> {
  const { handoffTargets } = await getAppSettings();
  const rows = await db.select({ id: tasks.id, handoff: tasks.handoff }).from(tasks);
  const byPeer = new Map<string, PeerBucket>();
  for (const row of rows) {
    const marker = markerOf(row.handoff);
    if (marker?.direction !== "out" || marker.pending || !marker.peerUrl) continue;
    // 已经从接力设置里删掉的机器:没有名字也没有指纹,连签名都发不出去,当它不存在
    //（既不问也不报 offline —— 那是用户自己按的删除,handoff-state-check 钉着）。
    // 只是**换过地址**的不算删除,按名字认回同一台(判据在 shared 的 outboundHolder)。
    const target = outboundHolder(marker, handoffTargets);
    if (!target) continue;
    const url = normalizedUrl(target.url);
    const bucket = byPeer.get(url) ?? { target, items: [], expectedFps: new Set<string>() };
    bucket.items.push({ taskId: marker.peerTaskId || row.id, transferId: marker.transferId ?? undefined });
    if (marker.peerFp) bucket.expectedFps.add(marker.peerFp.trim().toLowerCase());
    byPeer.set(url, bucket);
  }
  return byPeer;
}

// 这一轮该不该先验明对端正身,以及拿谁当期望指纹。
//
// **要验的只有一种情况**:设置里那条 target 没有指纹,而这些出站行记着一个。改地址会
// 把记住的指纹一起丢掉(设置页那段注释:指纹是对上一个地址背后那台机器的承诺),于是
// outboundHolder 只能按名字把它认回来 —— 而名字认回来的地址可能根本是填错的。
// 不验就直接问的话,一台恰好也批准过本机的 ash 会回 200 + 空 rows:侧栏既没有实时状态、
// 也不会说「联系不上」,正是这次要修的那种「不是实时却没有提示」。
//
// target 自己有指纹时不必验:outboundHolder 的闸已经保证它跟 marker 记的是同一台。
// 一条 marker 都没记指纹(老版本导出的)时也不必:没有期望值可比,验了也是白验。
function identityToVerify(bucket: PeerBucket): { expectFp: string } | { conflict: true } | null {
  if (bucket.target.peerFp || bucket.expectedFps.size === 0) return null;
  // 同一个名字下混着两台机器的历史行:问哪一台都可能问错人,一律不发。
  if (bucket.expectedFps.size > 1) return { conflict: true };
  return { expectFp: [...bucket.expectedFps][0]! };
}

// 问一圈持有机：我交出去的那些任务，在它们那儿现在什么样。
// 联系不上的机器只列进 offline **不抛错** —— 一台机器关机不该让整个侧栏读不出状态，
// 而侧栏拿到 offline 才能如实说「这几行显示的是接力当时的状态」。
// 身份没核对过的先 ping 一次验明正身（判据见 identityToVerify），验不过同样只进 offline。
export async function outboundRemoteStates(): Promise<HandoffOutboundStateResult> {
  const rows: HandoffRemoteState[] = [];
  const offline: HandoffPeerOffline[] = [];
  for (const [url, bucket] of await outboundByPeer()) {
    const { target, items } = bucket;
    try {
      const verify = identityToVerify(bucket);
      if (verify) {
        if ("conflict" in verify) {
          throw new HandoffError(
            `「${target.name}」名下混着多台机器的接力记录，无法确认该问哪一台；`
            + "先在接力设置里对它重新申请一次，把指纹记回来", 409,
          );
        }
        // 指纹对不上时 pingPeer 自己会抛 409,话说得比这里清楚(记住的 / 这次的短指纹都列出来)。
        await pingPeer(url, verify.expectFp);
      }
      const answer = await fetchPeer<{ rows: HandoffRemoteState[] }>(
        `${url}/api/handoff/proxy/tasks/state`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items }),
          timeoutMs: 10_000,
        },
      );
      rows.push(...(answer.rows ?? []));
    } catch (error) {
      offline.push({ url, name: target.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { rows, offline };
}

export function mountHandoffRemoteRoutes(api: Hono): void {
  // 机器面：只接受获批且签名的来源机，并且只允许它访问自己交来的入站任务。
  api.post("/handoff/proxy/tasks/state", async (c) => {
    try {
      const { peer, body } = await signedBody(c);
      const items = Array.isArray(body.items) ? body.items : [];
      return c.json({ rows: await remoteStatesFor(items, peer.fingerprint) });
    } catch (error) { return fail(c, error); }
  });

  // 浏览器面：侧栏定时问一次「我交出去的那些任务，在对端现在什么样」。
  api.post("/tasks/outbound-state", async (c) => c.json(await outboundRemoteStates()));

  api.post("/handoff/proxy/task/snapshot", async (c) => {
    try {
      const { peer, body } = await signedBody(c);
      if (!body.taskId) throw new HandoffError("缺 taskId", 400);
      return c.json(await snapshotFor(body.taskId, peer.fingerprint, body.transferId));
    } catch (error) { return fail(c, error); }
  });

  // 来源机想恢复一条“送达未知”的本地任务时，先由当前目标机持久登记撤销。
  // 这样即使旧 import 请求晚到，也会在落库前被 tombstone 拒绝，不会清完标记后又冒出第二份。
  api.post("/handoff/proxy/task/cancel-pending", async (c) => {
    try {
      const { peer, body, returning } = await signedCancellation(c);
      if (!body.taskId || !body.transferId) throw new HandoffError("缺 taskId / transferId", 400);
      await cancelPendingInboundTransfer({
        taskId: body.taskId,
        transferId: body.transferId,
        sourceFingerprint: peer.fingerprint,
        returning,
        ...(returning ? { returnTransferId: body.returnTransferId ?? null } : {}),
      });
      return c.json({ canceled: true });
    } catch (error) { return fail(c, error); }
  });

  api.post("/handoff/proxy/task/reply", async (c) => {
    try {
      const { peer, body } = await signedBody(c);
      if (!body.taskId) throw new HandoffError("缺 taskId", 400);
      await ownedInboundTask(body.taskId, peer.fingerprint, body.transferId);
      return replyToTask(c, body.taskId, body);
    } catch (error) { return fail(c, error); }
  });

  api.post("/handoff/proxy/task/answer", async (c) => {
    try {
      const { peer, body } = await signedBody(c);
      if (!body.taskId) throw new HandoffError("缺 taskId", 400);
      await ownedInboundTask(body.taskId, peer.fingerprint, body.transferId);
      return answerTask(c, body.taskId, { answer: body.answer });
    } catch (error) { return fail(c, error); }
  });

  api.post("/handoff/proxy/task/return", async (c) => {
    try {
      const { peer, body } = await signedBody(c);
      if (!body.taskId) throw new HandoffError("缺 taskId", 400);
      const owned = await ownedInboundTask(body.taskId, peer.fingerprint, body.transferId);
      const target = await returnTargetForMarker(owned.marker);
      if (!target) throw new HandoffError("无法自动定位来源机器，请从来源机的本地远程任务视图重试", 409);
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
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          taskId: remote.marker.peerTaskId, transferId: remote.marker.transferId,
        }) },
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
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          ...reply, taskId: remote.marker.peerTaskId, transferId: remote.marker.transferId,
        }) },
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
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          taskId: remote.marker.peerTaskId, transferId: remote.marker.transferId, answer: body.answer,
        }) },
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
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          taskId: remote.marker.peerTaskId, transferId: remote.marker.transferId,
        }), timeoutMs: 600_000 },
      );
      const refreshed = (await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
      if (!refreshed) throw new HandoffError("任务已移回，但本机记录读取失败", 500);
      return c.json({ task: (await enrichTasks([refreshed]))[0] });
    } catch (error) { return fail(c, error); }
  });
}
