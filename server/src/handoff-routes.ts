// 任务接力的 HTTP 面。业务全在 handoff.ts / handoff-import.ts,这里只做参数搬运
// 和 HandoffError → HTTP 状态码的翻译。
//
// 两类端点,别混:
//  ① **机器对机器**(/handoff/ping、/refs、/import):由源机的 ash 服务端来调,不给
//     浏览器用——server→server 顺带绕开了 CORS。这三个走身份签名:/refs 和 /import
//     要求来源机器已被批准(handoff-peers.ts requireApprovedPeer),/ping 是配对入口
//     本身,谁都能敲,但没获批准就不报项目清单。
//  ② **本机设置面**(/handoff/identity、/handoff/peers*):给自己的网页用,和 ash 其它
//     端点一样没有鉴权(整机在可信网络里用的既定取舍)。这里管的是「谁能把任务推进来」,
//     不是「谁能打开这个网页」。
import { hostname } from "node:os";
import type { HandoffAudit, TaskHandoff } from "@ash/shared";
import type { Hono } from "hono";
import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { projectHealthLight } from "./git.js";
import { getAppSettings } from "./app-settings.js";
import { exportHandoff, handoffRemoteUrl, preflightHandoff } from "./handoff.js";
import { fetchPeer, normalizePeerUrl, pingPeer, requestHandoffApproval } from "./handoff-peer-client.js";
import { repoRefTips } from "./handoff-collect.js";
import { HandoffError, type HandoffManifest, type HandoffPingResponse } from "./handoff-types.js";
import { canonicalPingChallenge, localIdentity, sameFingerprint, shortFingerprint, signWithLocalKey } from "./handoff-identity.js";
import { looksSealed, openSealed } from "./handoff-crypto.js";
import { readCappedBody } from "./handoff-body.js";
import {
  deletePeer, listPeers, peerAddr, peerStanceFor, requireApprovedPeer, setPeerStatus, touchPeer,
  verifyPeerSignature,
} from "./handoff-peers.js";
import { importHandoff } from "./handoff-import.js";
import { publishTaskUpdated } from "./task-store.js";
import { now } from "./util.js";
import { mountHandoffRemoteRoutes } from "./handoff-remote.js";
import {
  assertReturnProject, listReturnGrants, returnArchiveForPeer, returnTargetForTask, sourceUrlFromPeer,
} from "./handoff-return.js";
import { appendTaskTimeline } from "./task-timeline.js";

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 500 | 502;

// 错误应答带 ash:true = 「ash 业务层的明确拒绝,本机可证明没留下这次接力的
// 任务」——importHandoff 里任务行插入之后的失败都会补偿回滚再抛 HandoffError,没插
// 之前的失败(含非 HandoffError 逃逸)本来就没落任何行,所以两个分支都能安全带标记。
// 唯一的例外是补偿回滚自身失败(e.unsettled):那时本机可能留有半截任务,故意不带
// 标记,让源机按「送达未知」保留 pending。源机 fetchPeer 只信这个标记:没有它的非
// 2xx(网关/代理伪造的 502 等)一律按网络类失败处理,防止「对端已导入成功、网关却
// 回 502」触发回滚造成双跑。
const fail = (c: Context, e: unknown) => {
  if (e instanceof HandoffError) {
    return c.json(
      e.unsettled ? { error: e.message } : { error: e.message, ash: true },
      e.status as ErrorStatus,
    );
  }
  const msg = e instanceof Error ? e.message : String(e);
  console.error("[handoff]", e);
  return c.json({ error: `接力失败:${msg}`, ash: true }, 500);
};

class PendingCancellationError extends HandoffError {
  constructor(message: string, readonly forceReason: HandoffAudit["forceReason"]) {
    super(message, 409);
  }
}

async function cancelPendingAtPeer(marker: TaskHandoff): Promise<boolean> {
  if (!marker.peerUrl || !marker.peerFp || !marker.transferId) {
    throw new PendingCancellationError(
      "这条旧记录缺少目标机地址、身份或 transferId，无法安全证明对端没收到；本机标记未移除",
      "unverifiable",
    );
  }
  const targetUrl = normalizePeerUrl(marker.peerUrl);
  const returning = Object.prototype.hasOwnProperty.call(marker, "returnTransferId");
  const returnTransferId = (marker as TaskHandoff & { returnTransferId?: string | null }).returnTransferId;
  try {
    await pingPeer(
      targetUrl,
      marker.peerFp,
      returning ? { taskId: marker.peerTaskId, returnTransferId: returnTransferId ?? null } : undefined,
      { allowReturnFallback: false },
    );
    await fetchPeer(`${targetUrl}/api/handoff/proxy/task/cancel-pending`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: marker.peerTaskId,
        transferId: marker.transferId,
        ...(returning ? { returnTransferId: returnTransferId ?? null } : {}),
      }),
    });
    return returning;
  } catch (error) {
    if (error instanceof HandoffError && error.remoteAsh && error.remoteStatus === 409) {
      throw new HandoffError(
        "对端已经收到或正在导入这份任务，不能恢复本机旧副本；请关闭确认框，重新打开接力弹窗并原样重试以幂等收口",
        409,
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof HandoffError && error.remoteStatus === 404) {
      throw new PendingCancellationError(
        `目标机版本过旧，不支持安全撤销核验；本机标记未移除。升级对端后可安全重试，或显式承担双任务风险后强制恢复。原始原因：${detail}`,
        "legacy",
      );
    }
    if (error instanceof HandoffError && !error.network && error.remoteStatus === null) {
      throw new PendingCancellationError(
        `这个地址当前无法证明仍是原目标机，原目标机的任务状态无从核验；本机标记未移除。请先找回原目标机或修正地址；也可显式承担双任务风险后强制恢复。原始原因：${detail}`,
        "identity",
      );
    }
    const unreachable = !(error instanceof HandoffError) || error.network;
    throw new PendingCancellationError(
      `${unreachable ? "当前连不上对端" : "对端未能完成安全撤销核验"}，本机标记未移除。连接恢复后原样重试最安全；也可显式承担双任务风险后强制恢复。原始原因：${detail}`,
      unreachable ? "unreachable" : "unverifiable",
    );
  }
}

function restoredInboundMarker(marker: TaskHandoff): TaskHandoff {
  const returnTransferId = (marker as TaskHandoff & { returnTransferId?: string | null }).returnTransferId;
  return {
    direction: "in",
    transferId: returnTransferId ?? null,
    autoResume: marker.autoResume,
    peerUrl: marker.peerUrl,
    peerName: marker.peerName,
    peerFp: marker.peerFp,
    originFp: marker.originFp,
    peerTaskId: marker.peerTaskId,
    at: marker.at,
    sessions: marker.sessions,
    git: marker.git,
  };
}

function pingPayload(
  nonce: string,
  peerStatus: NonNullable<HandoffPingResponse["peerStatus"]>,
  rows: HandoffPingResponse["projects"],
  returnRefs?: HandoffPingResponse["returnRefs"],
): HandoffPingResponse {
  const identity = localIdentity();
  return {
    ok: true,
    service: "ash",
    host: hostname(),
    identity: {
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
      kxPublicKey: identity.kxPublicKey,
      sig: signWithLocalKey(canonicalPingChallenge(nonce, identity.kxPublicKey)),
    },
    peerStatus,
    projects: rows,
    ...(returnRefs ? { returnRefs } : {}),
  };
}

async function handleImport(c: Context, returning: boolean) {
  let bytes: Buffer;
  try {
    bytes = await readCappedBody(c.req.raw, (await getAppSettings()).handoffMaxBodyMb);
  } catch (e) {
    if (e instanceof HandoffError) return fail(c, e);
    return c.json({ error: "导入体读取失败", ash: true }, 400);
  }
  let peer: ReturnType<typeof verifyPeerSignature> = null;
  try {
    peer = returning ? verifyPeerSignature(c, bytes) : await requireApprovedPeer(c, bytes);
    if (returning && !peer) throw new HandoffError("免审批移回必须带机器身份签名", 401);
  } catch (e) {
    return fail(c, e);
  }
  let raw: string;
  try {
    raw = looksSealed(bytes) ? openSealed(bytes, localIdentity().fingerprint) : bytes.toString("utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `加密的接力载荷解不开(${msg})——多半是源机封给了别的机器,或者路上被改过`, ash: true }, 400);
  }
  let body: HandoffManifest;
  try {
    body = JSON.parse(raw) as HandoffManifest;
  } catch {
    return c.json({ error: "导入体不是合法 JSON", ash: true }, 400);
  }
  try {
    if (peer && body.sourceFingerprint && !sameFingerprint(peer.fingerprint, body.sourceFingerprint)) {
      throw new HandoffError("manifest 的来源指纹与实际签名机器不一致", 403);
    }
    if (returning) {
      if (!peer || !body.sourceFingerprint || !sameFingerprint(peer.fingerprint, body.sourceFingerprint)) {
        throw new HandoffError("移回载荷没有绑定到实际持有机器", 403);
      }
      const archive = await returnArchiveForPeer(body.task?.id ?? "", peer.fingerprint, body.returnTransferId);
      assertReturnProject(body.targetProjectId, archive.project.id);
    }
    return c.json(await importHandoff(body, {
      sourceUrl: sourceUrlFromPeer(peerAddr(c), body.sourcePort),
    }));
  } catch (e) {
    return fail(c, e);
  }
}

export function mountHandoffRoutes(api: Hono): void {
  mountHandoffRemoteRoutes(api);
  // 对端探活 + **配对入口**:证明「我是一台 ash、我是哪一台」,并报出可作为接力目的地
  // 的项目清单。源机带 ?nonce= 来,本机用私钥签它 —— 只报公钥证明不了持有私钥(公钥
  // 是公开的,谁都能复制一份复读)。源机没批准过的话,项目清单故意为空:仓库布局不该
  // 报给还没被认可的机器,而这次来访已经落进待批准列表,用户点一下就能放行。
  api.get("/handoff/ping", async (c) => {
    const { handoffRequireApproval } = await getAppSettings();
    // ping 的签名头是可选的(旧版源机没有),验不过则一律当没带 —— 探活不是写入口,
    // 没必要在这里把人拦死,真正的闸在 /refs 和 /import。
    let peer = null;
    try {
      peer = verifyPeerSignature(c, "");
    } catch {
      peer = null;
    }
    if (peer) await touchPeer(peer, peerAddr(c));
    const stance = await peerStanceFor(peer, handoffRequireApproval);
    const nonce = c.req.query("nonce") ?? "";
    const rows = stance === "approved" || stance === "open" ? await db.select().from(projects) : [];
    return c.json(pingPayload(nonce, stance, rows.map((p) => ({
        id: p.id,
        name: p.name,
        repoPath: p.repoPath,
        isRepo: projectHealthLight(p.repoPath).isRepo,
      }))));
  });

  // 移回专用探测:不建立整机级入站授权，只验证“当前签名机器就是这条 out 存档记录的
  // 持有者”，并且只返回原任务所属的一个项目。第三台机器没有对应私钥，拿不到清单。
  api.post("/handoff/return/ping", async (c) => {
    let bytes: Buffer;
    try { bytes = await readCappedBody(c.req.raw, 1); } catch (e) { return fail(c, e); }
    try {
      const peer = verifyPeerSignature(c, bytes);
      if (!peer) throw new HandoffError("移回探测必须带机器身份签名", 401);
      let body: { taskId?: string; returnTransferId?: string | null; nonce?: string };
      try { body = JSON.parse(bytes.toString("utf8")) as typeof body; }
      catch { throw new HandoffError("移回探测体不是合法 JSON", 400); }
      if (!body.taskId || typeof body.nonce !== "string") throw new HandoffError("移回探测参数不完整", 400);
      const archive = await returnArchiveForPeer(body.taskId, peer.fingerprint, body.returnTransferId);
      const refs = archive.project.isRepo ? await repoRefTips(archive.project.repoPath) : [];
      return c.json(pingPayload(body.nonce, "approved", [archive.project], refs));
    } catch (e) {
      return fail(c, e);
    }
  });

  // 分支尖清单,供源机协商 git bundle 的前置提交(对端已有的历史不重复打包)。
  // 它会泄露本机仓库的分支名和提交,和 /import 同一道闸。
  api.get("/handoff/projects/:id/refs", async (c) => {
    try {
      await requireApprovedPeer(c, "");
    } catch (e) {
      return fail(c, e);
    }
    const row = (await db.select().from(projects)).find((p) => p.id === c.req.param("id"));
    if (!row) return c.json({ error: "项目不存在", ash: true }, 404);
    if (!projectHealthLight(row.repoPath).isRepo) return c.json({ refs: [] });
    try {
      return c.json({ refs: await repoRefTips(row.repoPath) });
    } catch (e) {
      return fail(c, e);
    }
  });

  // 接收一整个任务(manifest 里带 git bundle 和会话文件,可能上百 MB)。
  // 必须先拿原文验签再解析:签名覆盖 body 哈希,先 parse 后验等于验的是解析结果,
  // 中间人改字段照样过。
  api.post("/handoff/import", (c) => handleImport(c, false));
  api.post("/handoff/return/import", (c) => handleImport(c, true));

  // ── 本机设置面(给自己的网页用)────────────────────────────────────────────
  // 本机身份:设置页展示,让用户拿去和另一台机器上记录的指纹肉眼核对。只出公钥侧。
  api.get("/handoff/identity", (c) => {
    const identity = localIdentity();
    return c.json({
      fingerprint: identity.fingerprint,
      short: shortFingerprint(identity.fingerprint),
      host: hostname(),
    });
  });

  // 接力来源(入站信任表):谁来敲过门、批没批准。
  api.get("/handoff/peers", async (c) => c.json({ peers: await listPeers() }));
  // 历史 out 存档另行授予的任务级回程权限；只读展示，不会暗中建立整机 approved。
  api.get("/handoff/return-grants", async (c) => c.json({ grants: await listReturnGrants() }));

  api.get("/tasks/:id/handoff/return-target", async (c) => {
    try {
      const target = await returnTargetForTask(c.req.param("id"));
      return target ? c.json({ target }) : c.json({ error: "无法自动定位来源机器" }, 404);
    } catch (e) {
      return fail(c, e);
    }
  });

  api.post("/handoff/peers/:fingerprint/:action", async (c) => {
    const action = c.req.param("action");
    if (action !== "approve" && action !== "block") return c.json({ error: "只支持 approve / block" }, 400);
    try {
      return c.json(await setPeerStatus(c.req.param("fingerprint"), action === "approve" ? "approved" : "blocked"));
    } catch (e) {
      return fail(c, e);
    }
  });

  // 删掉记录 = 忘记这台机器。它再来敲门会重新落进待批准列表(不是永久拉黑,拉黑用 block)。
  api.delete("/handoff/peers/:fingerprint", async (c) => {
    await deletePeer(c.req.param("fingerprint"));
    return c.json({ deleted: true });
  });

  // 出站配对申请:只向目标机发一次带身份签名的 ping，让本机出现在它的待审批列表里。
  // 与 preflight 分开，避免用户只是打开接力对话框就悄悄发出申请。
  api.post("/handoff/request", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { targetUrl?: string };
    if (!body.targetUrl) return c.json({ error: "缺 targetUrl" }, 400);
    try {
      return c.json(await requestHandoffApproval(body.targetUrl));
    } catch (e) {
      return fail(c, e);
    }
  });

  // 预检:探测目标机、匹配项目、盘点本地可搬运的东西。只读。
  api.post("/tasks/:id/handoff/preflight", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { targetUrl?: string };
    if (!body.targetUrl) return c.json({ error: "缺 targetUrl" }, 400);
    try {
      return c.json(await preflightHandoff(c.req.param("id"), body.targetUrl));
    } catch (e) {
      return fail(c, e);
    }
  });

  // 历史确认态标记没有 targetProjectId:服务端补查对端任务后跳到完整查询串,
  // 避免横幅只能拼出缺少项目定位信息的链接。
  api.get("/tasks/:id/handoff/open", async (c) => {
    try {
      return c.redirect(await handoffRemoteUrl(c.req.param("id")));
    } catch (e) {
      return fail(c, e);
    }
  });

  // 正式接力:停任务 → 打包 → 推给对端 → 本地落「已接力」标记。
  api.post("/tasks/:id/handoff", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      targetUrl?: string;
      targetProjectId?: string;
      targetName?: string;
      autoResume?: boolean;
    };
    if (!body.targetUrl || !body.targetProjectId) {
      return c.json({ error: "缺 targetUrl / targetProjectId" }, 400);
    }
    try {
      return c.json(await exportHandoff(c.req.param("id"), {
        targetUrl: body.targetUrl,
        targetProjectId: body.targetProjectId,
        targetName: body.targetName,
        autoResume: body.autoResume,
      }));
    } catch (e) {
      return fail(c, e);
    }
  });

  // 恢复本机任务只服务 pending（送达未知）的应急撤销。先让目标机确认尚未收到并
  // 持久登记 tombstone，再清本机标记；确认送达后只能从对端发起移回。
  api.delete("/tasks/:id/handoff", async (c) => {
    const taskId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      force?: boolean;
      acknowledgeDuplicateRisk?: boolean;
    };
    const force = body.force === true && body.acknowledgeDuplicateRisk === true;
    const row = (await db
      .select({ id: tasks.id, handoff: tasks.handoff })
      .from(tasks)
      .where(eq(tasks.id, taskId))).at(0);
    if (!row) return c.json({ error: "任务不存在" }, 404);
    let marker: TaskHandoff | null = null;
    if (row.handoff) {
      try { marker = JSON.parse(row.handoff) as TaskHandoff; } catch { marker = null; }
    }
    if (marker?.direction !== "out") {
      return c.json({ error: "任务没有「接力出去」的标记;接力进来的任务本来就在本机跑,不用移除" }, 409);
    }
    if (!marker.pending) {
      return c.json({ error: "任务已确认送达对端，只能从对端那份任务发起移回；本机不能恢复这份存档" }, 409);
    }
    const returning = Object.prototype.hasOwnProperty.call(marker, "returnTransferId");
    let forced = false;
    let forceReason: HandoffAudit["forceReason"] | null = null;
    try {
      await cancelPendingAtPeer(marker);
    } catch (e) {
      if (e instanceof PendingCancellationError) {
        if (!force) return c.json({ error: e.message, needsForce: true, forceReason: e.forceReason }, 409);
        forced = true;
        forceReason = e.forceReason;
      } else {
        return fail(c, e);
      }
    }
    const restored = returning ? restoredInboundMarker(marker) : null;
    const changedAt = now();
    const audit: HandoffAudit | null = forced && forceReason ? {
      kind: "forced-recovery",
      at: changedAt,
      returning,
      peerName: marker.peerName,
      forceReason,
    } : null;
    const updated = await db.update(tasks)
      .set({
        handoff: restored ? JSON.stringify(restored) : null,
        ...(audit ? { handoffAudit: JSON.stringify(audit) } : {}),
        updatedAt: changedAt,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.handoff, row.handoff!)))
      .returning({ id: tasks.id });
    if (!updated.length) {
      return c.json({ error: "核验期间任务的接力状态已经变化，请刷新后按最新状态处理" }, 409);
    }
    await appendTaskTimeline(taskId, audit
      ? returning
        ? "⚠️ 用户在无法核验原机状态时强制撤销了本次移回；任务继续由本机持有，但原机可能已有副本，恢复联网后必须人工确认只运行一份。"
        : "⚠️ 用户在无法核验目标机状态时强制恢复了本机任务；目标机可能已有副本，恢复联网后必须人工确认只运行一份。"
      : returning
        ? "🔁 用户安全撤销了本次移回，任务继续由本机持有；原机已登记忽略这次旧移回请求。"
        : "🔁 对端确认未收到任务并登记撤销后，用户移除了接力标记，任务恢复为本机可运行。");
    await publishTaskUpdated(taskId);
    return c.json({ cleared: true, restored: returning ? "in" : "local", forced });
  });
}
