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
import { appendFile } from "node:fs/promises";
import type { Hono } from "hono";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, sessions, tasks } from "./db/schema.js";
import { projectHealthLight } from "./git.js";
import { getAppSettings } from "./app-settings.js";
import { exportHandoff, handoffRemoteUrl, preflightHandoff } from "./handoff.js";
import { repoRefTips } from "./handoff-collect.js";
import { HandoffError, type HandoffPingResponse } from "./handoff-types.js";
import { canonicalPingChallenge, localIdentity, shortFingerprint, signWithLocalKey } from "./handoff-identity.js";
import { looksSealed, openSealed } from "./handoff-crypto.js";
import { readCappedText } from "./handoff-body.js";
import {
  deletePeer, listPeers, peerAddr, peerStanceFor, requireApprovedPeer, setPeerStatus, touchPeer,
  verifyPeerSignature,
} from "./handoff-peers.js";
import { importHandoff } from "./handoff-import.js";
import { publishTaskUpdated } from "./task-store.js";
import { sessionTranscriptPath, TURN_SENTINEL } from "./transcript.js";
import { now } from "./util.js";

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

export function mountHandoffRoutes(api: Hono): void {
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
    const identity = localIdentity();
    const nonce = c.req.query("nonce") ?? "";
    const rows = stance === "approved" || stance === "open" ? await db.select().from(projects) : [];
    const body: HandoffPingResponse = {
      ok: true,
      service: "ash",
      host: hostname(),
      identity: {
        publicKey: identity.publicKey,
        fingerprint: identity.fingerprint,
        // 本机的加密公钥。签名覆盖它(见 canonicalPingChallenge),中间人换不掉也删不掉。
        kxPublicKey: identity.kxPublicKey,
        // 没带 nonce 的老源机拿到的是对空串的签名:它本来也不会验,而带了 nonce 的
        // 新源机永远验的是自己刚生成的那个,拿不到可复用的签名。
        sig: signWithLocalKey(canonicalPingChallenge(nonce, identity.kxPublicKey)),
      },
      peerStatus: stance,
      projects: rows.map((p) => ({
        id: p.id,
        name: p.name,
        repoPath: p.repoPath,
        isRepo: projectHealthLight(p.repoPath).isRepo,
      })),
    };
    return c.json(body);
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
  api.post("/handoff/import", async (c) => {
    let raw: string;
    try {
      // 上限闸必须在验签之前,而且是流式的:签名覆盖 body 哈希,验签只能排在读完之后,
      // 所以没有这一层,一个未鉴权的巨大 body 就能把内存吃光(见 handoff-body.ts)。
      raw = await readCappedText(c.req.raw, (await getAppSettings()).handoffMaxBodyMb);
    } catch (e) {
      if (e instanceof HandoffError) return fail(c, e);
      return c.json({ error: "导入体读取失败", ash: true }, 400);
    }
    try {
      await requireApprovedPeer(c, raw);
    } catch (e) {
      return fail(c, e);
    }
    // 验签之后才解密:签名覆盖的是线上真正传的那串字节(信封),先解密后验等于验的是
    // 解密结果。加密与否由**源机**的设置决定,本机两种都收 —— 这个开关管的是「我发出去
    // 的东西加不加密」,拦别人的明文既没意义(签名已保证来源和完整性)也会平白拆掉兼容性。
    if (looksSealed(raw)) {
      try {
        raw = openSealed(raw, localIdentity().fingerprint);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: `加密的接力载荷解不开(${msg})——多半是源机封给了别的机器,或者路上被改过`, ash: true }, 400);
      }
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "导入体不是合法 JSON", ash: true }, 400);
    }
    try {
      return c.json(await importHandoff(body));
    } catch (e) {
      return fail(c, e);
    }
  });

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

  // 移除接力标记:「在本机继续」的唯一逃生门(接力出去/接力未确认的任务被硬拦后走这里)。
  // 只清本机标记,对端那份任务不动——两边并跑的风险由用户自担,所以前端必须走确认框,
  // 时间线也留一条持久可见的系统说明。
  api.delete("/tasks/:id/handoff", async (c) => {
    const taskId = c.req.param("id");
    const row = (await db
      .select({ id: tasks.id, handoff: tasks.handoff })
      .from(tasks)
      .where(eq(tasks.id, taskId))).at(0);
    if (!row) return c.json({ error: "任务不存在" }, 404);
    let marker: { direction?: string } | null = null;
    if (row.handoff) {
      try { marker = JSON.parse(row.handoff) as { direction?: string }; } catch { marker = null; }
    }
    if (marker?.direction !== "out") {
      return c.json({ error: "任务没有「接力出去」的标记;接力进来的任务本来就在本机跑,不用移除" }, 409);
    }
    await db.update(tasks).set({ handoff: null, updatedAt: now() }).where(eq(tasks.id, taskId));
    const latest = (await db
      .select({ id: sessions.id, agentType: sessions.agentType })
      .from(sessions)
      .where(eq(sessions.taskId, taskId))
      .orderBy(sessions.startedAt)).at(-1);
    if (latest) {
      const line = {
        t: "system" as const, agent: latest.agentType, by: "system" as const, at: now(),
        text: "🔁 用户移除了接力标记,任务恢复为本机可运行(对端那份仍存在,注意别两边同时跑)。",
      };
      await appendFile(sessionTranscriptPath(taskId, latest.id), `\n${TURN_SENTINEL}${JSON.stringify(line)}\n`)
        .catch(() => { /* 从未跑过就没有产物目录,标记已清,不阻塞 */ });
    }
    await publishTaskUpdated(taskId);
    return c.json({ cleared: true });
  });
}
