// 任务接力的 HTTP 面。业务全在 handoff.ts / handoff-import.ts,这里只做参数搬运
// 和 HandoffError → HTTP 状态码的翻译。
//
// 两类端点,别混:
//  ① **机器对机器**(/handoff/ping、/projects/:id/refs、/import):由源机的 ash 服务端来调,
//     不给浏览器用——server→server 顺带绕开了 CORS。这三个走身份签名:/refs 和 /import
//     要求来源机器已被批准(handoff-peers.ts requireApprovedPeer),/ping 是配对入口
//     本身,谁都能敲,但没获批准就不报项目清单。
//     `/handoff/identity` 也算这一类:**读它的是对端**(源机的 probePeerIdentity 不签名地
//     拉一次,把用户填的主机名映射成指纹),回的只有公钥指纹和主机名,本来就是拿去两边
//     肉眼核对的东西。
//  ② **本机设置面**(/handoff/peers*、/handoff/targets*、/handoff/request):给自己的网页用。
//     自用模式下和 ash 其它端点一样没有鉴权(整机在可信网络里用的既定取舍);**多人模式下
//     它们必须先登录** —— 它们管的是「谁能把任务推进来」和「我在对端的账号 key」,不是
//     「谁能打开这个网页」。豁免名单在 auth/middleware.ts,只列 ① 那几条(refs 带路径参数,
//     写成路径形状的正则),别把 `/api/handoff/` 整个前缀放进去。
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
import { fetchPeer, normalizePeerUrl, pingPeer, probePeerIdentity, requestHandoffApproval } from "./handoff-peer-client.js";
import { repoRefTips } from "./handoff-collect.js";
import { HandoffError, type HandoffManifest, type HandoffPingResponse } from "./handoff-types.js";
import { canonicalPingChallenge, localIdentity, sameFingerprint, shortFingerprint, signWithLocalKey } from "./handoff-identity.js";
import { looksSealed, openSealed } from "./handoff-crypto.js";
import { readCappedBody } from "./handoff-body.js";
import {
  deletePeer, listPeers, peerAddr, peerStanceFor, requireApprovedPeer, setPeerStatus, touchPeer,
  unblockPeer, verifyPeerSignature,
} from "./handoff-peers.js";
import { importHandoff } from "./handoff-import.js";
import { publishTaskUpdated } from "./task-store.js";
import { now } from "./util.js";
import { mountHandoffRemoteRoutes } from "./handoff-remote.js";
import { assertReturnProject, listReturnGrants, returnArchiveForPeer } from "./handoff-return.js";
import { returnTargetForTask, sourceUrlFromPeer } from "./handoff-return-address.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { isMultiUser } from "./auth/mode.js";
import { countUsers } from "./auth/store.js";
import { peerActor, peerOwnerId, peerUserFor, peerUserSoft } from "./auth/handoff-peer-user.js";
import { canSeeProject, visibleProjectsFor } from "./auth/visibility.js";
import { actorOf } from "./auth/context.js";
import { addTarget, deleteTarget, listTargets, patchTarget, setPeerKey } from "./auth/handoff-scope.js";

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
    // code 是机器可读的原因(见 handoff-types.ts)。它既发给本机网页(接力对话框据此
    // 就地给出补 key 的输入框),也发给源机(入站拒绝时,由源机 fetchPeer 原样挂回)。
    return c.json(
      {
        error: e.message,
        ...(e.unsettled ? {} : { ash: true }),
        ...(e.code ? { code: e.code } : {}),
      },
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
    if (error instanceof HandoffError && error.remoteStatus === 404 && error.remoteAsh) {
      throw new PendingCancellationError(
        `这个地址上的新版 ash 没有对应的历史存档，可能地址已经换机或存档已删除，原目标机的任务状态无法核验；本机标记未移除。请先找回原目标机或修正地址；也可显式承担双任务风险后强制恢复。原始原因：${detail}`,
        "identity",
      );
    }
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
  instance?: { mode: "single" | "multi"; userCount?: number; peerUser?: { id: string; name: string } | null },
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
    // 「审批必须知情」(§十一):对端是不是多人实例必须写在应答里,审批界面才说得出
    // 「批准后对方所有用户都可经此配对接力进来」。
    ...(instance ? {
      instanceMode: instance.mode,
      ...(instance.userCount === undefined ? {} : { userCount: instance.userCount }),
      ...(instance.peerUser === undefined ? {} : { peerUser: instance.peerUser }),
    } : {}),
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
    // 多人实例:导入要求**发起人在本机的账号**对目标项目有权限(§十一)。机器级配对
    // 只说明「那台机器可以连我」,说明不了「那台机器上的这个人可以往这个项目里塞东西」。
    const peerUser = await peerUserFor(c);
    if (peerUser.kind === "user" && body.targetProjectId
        && !(await canSeeProject(peerActor(peerUser), body.targetProjectId))) {
      // 与本机所有面同一口径:看不见的项目和不存在的项目回同一句话,免得拿 id 试探。
      throw new HandoffError("目标项目不存在(对端项目清单可能过期,重新预检)", 404);
    }
    return c.json(await importHandoff(body, {
      sourceUrl: sourceUrlFromPeer(peerAddr(c), body.sourcePort),
      ownerUserId: peerOwnerId(peerUser),
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
    // **只有真的在申请配对时才建待批准记录。** 同一条 ping 被三种场景共用:显式点
    // 「发送接力申请」、打开接力对话框的预检、代理链路的身份核对。后两种建记录 =
    // 用户没申请过却在对端刷出「接力申请」,所以新版源机在非申请场景带 `intent=probe`
    // (见 handoff-peer-client.ts pingPeer)。缺省仍按申请处理:老版源机不带这个参数,
    // 而它点申请走的就是这条路,默认成 probe 会让老版永远配不上对。
    const pairing = c.req.query("intent") !== "probe";
    // 归属:源机带的「我在对端的账号 key」说明了它要以谁的身份进来。
    const multi = await isMultiUser();
    const peerUser = multi ? await peerUserSoft(c) : null;
    // **多人实例不收无主申请**(用户 2026-08-31 拍板)。认不出主人的申请只能推给全体
    // 成员,而「谁都能替本人放行一台机器」正是要修的病。这里只是不落库 —— ping 照常
    // 200 回全套身份和 instanceMode,源机据此当场提示「先补上你在对端的账号 key」
    // (出站侧同一道判据在 pingPeer 的 requirePeerUser,这一道是不信任源机的兜底:
    // 老版源机和自己拼请求的都到不了这儿)。单人实例没有用户概念,不受此限。
    const claimed = !multi || Boolean(peerUser?.user);
    if (peer) {
      await touchPeer(peer, peerAddr(c), {
        create: pairing && claimed,
        requestedBy: peerUser?.user?.id ?? null,
      });
    }
    const stance = await peerStanceFor(peer, handoffRequireApproval);
    const nonce = c.req.query("nonce") ?? "";
    // 多人实例:项目清单按**这次请求代表的那个人**的可见集过滤(§十一)。没带 key 或
    // key 不认时清单为空、peerUser 为 null —— 源机据此提示「去配对端 key」,而不是
    // 把空清单误读成「对端没有项目」。
    const instance = {
      mode: (multi ? "multi" : "single") as "single" | "multi",
      ...(multi ? { userCount: await countUsers() } : {}),
      ...(multi
        ? { peerUser: peerUser?.user ? { id: peerUser.user.id, name: peerUser.user.name } : null }
        : {}),
    };
    const cleared = stance === "approved" || stance === "open";
    const rows = !cleared || (multi && !peerUser?.user)
      ? []
      : multi
        ? await visibleProjectsFor(peerActor(peerUser!))
        : await db.select().from(projects);
    return c.json(pingPayload(nonce, stance, rows.map((p) => ({
        id: p.id,
        name: p.name,
        repoPath: p.repoPath,
        isRepo: projectHealthLight(p.repoPath).isRepo,
      })), undefined, instance));
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
    let peerUser: Awaited<ReturnType<typeof peerUserFor>>;
    try {
      await requireApprovedPeer(c, "");
      // 分支尖会泄露仓库布局,所以这条跟 /import 同一道用户级闸:多人实例下必须是
      // 本机某个账号,而且那个账号看得见这个项目。
      peerUser = await peerUserFor(c);
    } catch (e) {
      return fail(c, e);
    }
    const row = (await db.select().from(projects)).find((p) => p.id === c.req.param("id"));
    if (!row) return c.json({ error: "项目不存在", ash: true }, 404);
    if (peerUser.kind === "user" && !(await canSeeProject(peerActor(peerUser), row.id))) {
      return c.json({ error: "项目不存在", ash: true }, 404);
    }
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

  // 本机网页代理读取目标机公开身份：不签名、不带任务 id，不会让目标机新增待审批来源。
  api.post("/handoff/identity-probe", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { targetUrl?: string };
    if (!body.targetUrl) return c.json({ error: "缺 targetUrl" }, 400);
    try {
      return c.json(await probePeerIdentity(body.targetUrl));
    } catch (e) {
      return fail(c, e);
    }
  });

  // 接力来源(入站信任表):谁来敲过门、批没批准。
  // 多人模式下按人收窄:一条申请只给它冲着的那个人看(加上要能审计名单的管理员),
  // 判据在 handoff-peers.ts `peerAudience`。
  api.get("/handoff/peers", async (c) => c.json({ peers: await listPeers(actorOf(c)) }));
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
    if (action !== "approve" && action !== "block" && action !== "unblock") {
      return c.json({ error: "只支持 approve / block / unblock" }, 400);
    }
    try {
      const actor = actorOf(c);
      if (action === "unblock") {
        return c.json({ unblocked: true, peer: await unblockPeer(actor, c.req.param("fingerprint")) });
      }
      // 谁能点由 peerAudience 定:申请冲着的本人可批可拒,管理员看得见、能拒能删但
      // 批不了。放行一台机器等于让它上面所有人都敲得开本机的门,所以操作人一律记下。
      return c.json(await setPeerStatus(
        actor,
        c.req.param("fingerprint"),
        action === "approve" ? "approved" : "blocked",
      ));
    } catch (e) {
      return fail(c, e);
    }
  });

  // 删掉记录 = 忘记这台机器。它再来敲门会重新落进待批准列表(不是永久拉黑,拉黑用 block)。
  api.delete("/handoff/peers/:fingerprint", async (c) => {
    try {
      await deletePeer(actorOf(c), c.req.param("fingerprint"));
      return c.json({ deleted: true });
    } catch (e) {
      return fail(c, e);
    }
  });

  // 出站配对申请:只向目标机发一次带身份签名的 ping，让本机出现在它的待审批列表里。
  // 与 preflight 分开，避免用户只是打开接力对话框就悄悄发出申请。
  // ── 目标机清单(按人)────────────────────────────────────────────────────
  // 多人模式下它装着「我在对端的账号 key」,所以**不能**放进 app_settings ——
  // `GET /settings` 会把整份吐回前端(§十一)。自用模式仍读写 app_settings,
  // 行为与本功能上线前一致。读侧永不回显 key,只报 hasKey。
  api.get("/handoff/targets", async (c) => c.json({ targets: await listTargets(actorOf(c)) }));

  api.post("/handoff/targets", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { name?: string; url?: string; peerKey?: string };
    const name = (b.name ?? "").trim();
    if (!name || name.length > 64) return c.json({ error: "名称必填,不超过 64 字" }, 400);
    let url: string;
    try { url = normalizePeerUrl(b.url ?? ""); } catch (e) { return fail(c, e); }
    try {
      return c.json({ targets: await addTarget(actorOf(c), { name, url, peerKey: (b.peerKey ?? "").trim() }) });
    } catch (e) { return fail(c, e); }
  });

  api.patch("/handoff/targets/:id", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { name?: string; url?: string; peerKey?: string };
    const patch: { name?: string; url?: string; peerKey?: string } = {};
    if (b.name !== undefined) {
      const name = b.name.trim();
      if (!name || name.length > 64) return c.json({ error: "名称必填,不超过 64 字" }, 400);
      patch.name = name;
    }
    if (b.url !== undefined) {
      try { patch.url = normalizePeerUrl(b.url); } catch (e) { return fail(c, e); }
    }
    // 空串是**明确清空**(对端转回单人实例了),不是「没传」。
    if (b.peerKey !== undefined) patch.peerKey = b.peerKey.trim();
    try {
      return c.json({ targets: await patchTarget(actorOf(c), c.req.param("id"), patch) });
    } catch (e) { return fail(c, e); }
  });

  api.delete("/handoff/targets/:id", async (c) => {
    try {
      return c.json({ targets: await deleteTarget(actorOf(c), c.req.param("id")) });
    } catch (e) { return fail(c, e); }
  });

  // 按**地址**配「我在对端的账号 key」。为什么不是 PATCH /handoff/targets/:id:调用点
  // 手上常常只有地址 —— 自用模式那份清单存在 app_settings 里,根本没有行 id;接力对话框
  // 预检失败时要当场补 key,那里也只有选中的那台机器。两种模式的写入差异收在
  // `setPeerKey` 里(见 auth/handoff-scope.ts),路由这层只有一条路。
  api.put("/handoff/targets/key", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { url?: string; peerKey?: string };
    if (typeof b.peerKey !== "string") return c.json({ error: "缺 peerKey(空串 = 清除)" }, 400);
    let url: string;
    try { url = normalizePeerUrl(b.url ?? ""); } catch (e) { return fail(c, e); }
    try {
      return c.json({ targets: await setPeerKey(actorOf(c), url, b.peerKey.trim()) });
    } catch (e) { return fail(c, e); }
  });

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
    const body = (await c.req.json().catch(() => ({}))) as {
      targetUrl?: string;
      allowReturnFallback?: boolean;
    };
    if (!body.targetUrl) return c.json({ error: "缺 targetUrl" }, 400);
    if (body.allowReturnFallback !== undefined && typeof body.allowReturnFallback !== "boolean") {
      return c.json({ error: "allowReturnFallback 必须是 boolean" }, 400);
    }
    try {
      return c.json(await preflightHandoff(c.req.param("id"), body.targetUrl, {
        allowReturnFallback: body.allowReturnFallback,
      }));
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
