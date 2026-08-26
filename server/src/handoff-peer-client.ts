// 接力**出站**侧的对端客户端:所有发往另一台 ash 的请求都从这里出去。
//
// 两件事,缺一不可:
//   1. **签名**每一个请求(方法+路径+时间戳+nonce+body 哈希,ed25519)。对端据此确认
//      来的是哪台机器、body 有没有被改过。密钥与规范串在 handoff-identity.ts。
//   2. **反向核对对端身份** —— 这一半才是接力最该防的。接力推出去的是整个 git bundle
//      加完整 CLI 会话历史(里面什么都有);地址是会漂的(DHCP 换租约、路由器重启、局域网
//      里有人抢地址),而共享口令那类方案只能证明「来的人有资格进」,证明不了「我要发的
//      这台还是不是原来那台」。所以:第一次接力成功后把对端指纹记进 handoffTargets(TOFU),
//      之后每次预检/导出都先核对,对不上就**拒绝打包**,连探测都不往下走。
//
// 入站方向(谁能推进本机)在 handoff-peers.ts。
import type { HandoffApprovalResult, HandoffIdentity, HandoffPeerIdentity, HandoffTarget } from "@ash/shared";
import { getAppSettings, patchAppSettings } from "./app-settings.js";
import { HandoffError } from "./handoff-types.js";
import type { HandoffPingResponse } from "./handoff-types.js";
import {
  canonicalPingChallenge, canonicalRequest, fingerprintOf, localIdentity, newNonce,
  sameFingerprint, sha256Hex, shortFingerprint, signWithLocalKey, verifyWithPeerKey,
} from "./handoff-identity.js";
import { PEER_HEADERS } from "./handoff-peers.js";
import { sealForPeer } from "./handoff-crypto.js";
import { hostname } from "node:os";

export function normalizePeerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) throw new HandoffError("目标地址必须以 http(s):// 开头");
  return trimmed.replace(/\/api$/, "");
}

/**
 * 给一个出站请求配上身份签名头。body 为空(GET)时按空串签,两端算法一致。
 * 导出是为了让回归测试发原始请求时也能走**同一份**签名实现 —— 测试自己拼一套
 * 就会和产品代码各自漂移,那样验的是拷贝而不是真货。
 */
export function peerRequestHeaders(url: string, method: string, body: string | Buffer): Record<string, string> {
  const identity = localIdentity();
  const ts = String(Date.now());
  const nonce = newNonce();
  const canonical = canonicalRequest({
    method,
    path: new URL(url).pathname,
    ts,
    nonce,
    bodyHash: sha256Hex(body),
  });
  return {
    [PEER_HEADERS.key]: identity.publicKey,
    [PEER_HEADERS.sig]: signWithLocalKey(canonical),
    [PEER_HEADERS.ts]: ts,
    [PEER_HEADERS.nonce]: nonce,
    // HTTP 头只装 ByteString:主机名里有中文(中文 Windows 上是常态)直接 percent
    // 编码,不然 fetch 在构造请求头那一刻就抛,整条接力起都起不来。
    [PEER_HEADERS.host]: encodeURIComponent(hostname()).slice(0, 180),
  };
}

export async function fetchPeer<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number; sealTo?: { kx: string; fingerprint: string } | null },
): Promise<T> {
  const method = init?.method ?? "GET";
  const plain = typeof init?.body === "string" ? init.body : "";
  // 加密在签名**之前**:线上传的是信封,验签方拿到的也是信封,两边哈希的是同一串字节。
  // 信封是二进制帧(不再 base64),所以 content-type 也要跟着换。
  const body = init?.sealTo ? sealForPeer(init.sealTo.kx, init.sealTo.fingerprint, plain) : plain;
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  // Buffer 不在 fetch 的 BodyInit 里(DOM 的 BufferSource 只收非共享的 ArrayBuffer),
  // 套一层零拷贝视图交出去 —— 签名仍按同一串字节算。
  const wire: string | Uint8Array<ArrayBuffer> = typeof body === "string"
    ? body
    : new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength);
  if (typeof body !== "string") headers["content-type"] = "application/octet-stream";
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      ...(init?.body === undefined ? {} : { body: wire }),
      headers: { ...headers, ...peerRequestHeaders(url, method, body) },
      signal: AbortSignal.timeout(init?.timeoutMs ?? 15_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new HandoffError(`连不上对端 ash（${url}）：${msg}`, 502, true);
  }
  const payload = (await res.json().catch(() => null)) as { error?: string; ash?: boolean } | null;
  if (!res.ok) {
    // 只有带 ash 标记的错误应答才可信为「对端业务层明确拒绝,可证明没落库」。
    // 没有标记的非 2xx 可能是中间网关在对端已处理成功后伪造的(上游读超时回 502 等),
    // 按网络类失败(network=true)处理,让调用方保留 pending 而不是回滚——宁可让用户
    // 多点一次收口重试,也不能让同一个任务在两台机器上各跑一份。
    // 鉴权拒绝(401/403)一律带 ash 标记,确实什么都没导入,回滚才是对的。
    const error = new HandoffError(
      `对端返回 ${res.status}：${payload?.error ?? "未知错误"}`,
      502,
      payload?.ash !== true,
    );
    error.remoteStatus = res.status;
    error.remoteAsh = payload?.ash === true;
    throw error;
  }
  if (payload === null) {
    // 2xx 但应答体读不出来:对端多半已经处理成功,只是应答在路上断了——按网络类失败
    // 处理(network=true),让调用方按「可能已送达」收口而不是当确认失败。
    throw new HandoffError(`对端应答不完整（${url}）:连接中断或应答不是 JSON`, 502, true);
  }
  return payload as T;
}

/**
 * 只读取目标机公开身份，不带本机签名、不携带任务 id，也不会触发对端 touchPeer。
 * 批量弹窗用它把用户填写的主机名/IP 映射到 marker 指纹；正式预检仍会做签名挑战。
 */
export async function probePeerIdentity(rawTargetUrl: string, timeoutMs = 2_000): Promise<HandoffIdentity> {
  const url = `${normalizePeerUrl(rawTargetUrl)}/api/handoff/identity`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HandoffError(`连不上对端 ash（${url}）：${message}`, 502, true);
  }
  const body = (await response.json().catch(() => null)) as Partial<HandoffIdentity> | null;
  if (!response.ok || !body || typeof body.fingerprint !== "string"
    || !/^[0-9a-f]{64}$/i.test(body.fingerprint)) {
    throw new HandoffError(`目标机身份应答无效（${url}）`, 502, true);
  }
  const fingerprint = body.fingerprint.toLowerCase();
  return {
    fingerprint,
    short: shortFingerprint(fingerprint),
    host: typeof body.host === "string" && body.host ? body.host : new URL(url).hostname,
  };
}

export interface PeerProbe {
  ping: HandoffPingResponse;
  /** true = 本次使用任务级免审批回程；false = 普通接力（缺存档/旧版时需整机审批）。 */
  taskScopedReturn: boolean;
  /** null = 对端没报身份、本机也没记过指纹(两边都是旧版,无从核对)。 */
  peer: HandoffPeerIdentity | null;
  /**
   * 非 null = 这次接力的载荷要封给这把公钥。null 有两种成因,预检 notes 里已分别说明:
   * 对端是旧版报不出加密公钥,或者本机在设置里把接力加密关了(调试用)。
   */
  sealTo: { kx: string; fingerprint: string } | null;
}

export interface HandoffReturnContext {
  taskId: string;
  returnTransferId?: string | null;
}

const identityRecoveryGuidance = (returnContext?: HandoffReturnContext): string => returnContext
  ? "任务来源指纹保存在这条任务的接力记录里，设置页没有可清除项。确认是同一台来源机时，请先恢复来源机原来的 ash 数据和身份；若身份无法恢复，不要忽略校验直接移回，应在本机继续任务并手工迁移。"
  : "确认无误再到「设置 → 默认规则」清掉记住的指纹重新配对。";

/**
 * 探活 + 身份核对。任何一步对不上都直接抛(HandoffError,非 network)——**在打包之前**
 * 拦下来,不能等 bundle 都推出去了才发现推错了机器。
 *
 * `expectedFp` 来自整机目标设置或任务 marker；`returnContext` 非空表示后者。
 * 两者都没有才是首次配对(TOFU)。
 */
export async function pingPeer(
  targetUrl: string,
  expectedFp?: string | null,
  returnContext?: HandoffReturnContext,
  options: { allowReturnFallback?: boolean } = {},
): Promise<PeerProbe> {
  const nonce = newNonce();
  const pingUrl = returnContext ? `${targetUrl}/api/handoff/return/ping` : `${targetUrl}/api/handoff/ping?nonce=${encodeURIComponent(nonce)}`;
  let ping: HandoffPingResponse;
  let taskScopedReturn = Boolean(returnContext);
  try {
    ping = returnContext
      ? await fetchPeer<HandoffPingResponse>(pingUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...returnContext, nonce }),
        })
      : await fetchPeer<HandoffPingResponse>(pingUrl);
  } catch (error) {
    // 老版来源机没有任务级端点，或原机已删掉历史存档：退回普通接力通道。身份仍按
    // 任务来源指纹核对，但 refs/import 会恢复整机审批，不能借降级继续免审批写入。
    if (!returnContext || options.allowReturnFallback === false || !(error instanceof HandoffError)
      || error.remoteStatus !== 404) throw error;
    taskScopedReturn = false;
    ping = await fetchPeer<HandoffPingResponse>(`${targetUrl}/api/handoff/ping?nonce=${encodeURIComponent(nonce)}`);
  }
  if (!ping?.ok || ping.service !== "ash") {
    throw new HandoffError("对端不是 ash（/api/handoff/ping 应答不对）", 502);
  }
  const identity = ping.identity;
  if (!identity?.publicKey || !identity.sig) {
    // 对端没报身份 = 旧版 ash。本机从没记过它的指纹时按「无从核对」放行(否则升级路径
    // 直接断掉);**记过就一律拒绝** —— 一台报过身份的机器突然不报了,不是降级就是冒充。
    if (expectedFp) {
      throw new HandoffError(
        `目标机这次没有报出身份,但本机记着它的指纹是 ${shortFingerprint(expectedFp)}。这可能是对端被降级/换了机器,也可能是有人冒充它。${identityRecoveryGuidance(returnContext)}`,
        409,
      );
    }
    return { ping, peer: null, sealTo: null, taskScopedReturn };
  }
  // 指纹一律按公钥现算,不信对端自报的那个字段。
  const fingerprint = fingerprintOf(identity.publicKey);
  // 加密公钥在应答里就一起签,不在就退回老规范串 —— 中间人剥掉它不会换来明文,
  // 只会让验签失败(新版对端签的永远是带 kx 的那一版)。
  if (!verifyWithPeerKey(identity.publicKey, canonicalPingChallenge(nonce, identity.kxPublicKey), identity.sig)) {
    throw new HandoffError(
      "目标机的身份签名验不过 —— 它拿的是一份复制来的公钥,而不是对应的私钥。别把任务发过去。",
      409,
    );
  }
  const trust: HandoffPeerIdentity["trust"] = !expectedFp
    ? "first-seen"
    : sameFingerprint(expectedFp, fingerprint) ? "matched" : "mismatch";
  if (trust === "mismatch") {
    throw new HandoffError(
      `目标机的身份和上次不一样:记住的是 ${shortFingerprint(expectedFp!)},这次是 ${shortFingerprint(fingerprint)}。`
      + "可能是那台机器重装过、也可能是这个地址现在指向了别的机器 —— 接力会把整个仓库和对话历史发过去,所以先核对对端设置页上的指纹。"
      + identityRecoveryGuidance(returnContext),
      409,
    );
  }
  const { handoffEncrypt } = await getAppSettings();
  const sealTo = handoffEncrypt && identity.kxPublicKey ? { kx: identity.kxPublicKey, fingerprint } : null;
  return {
    ping,
    taskScopedReturn,
    peer: {
      fingerprint,
      short: shortFingerprint(fingerprint),
      trust,
      peerStatus: ping.peerStatus ?? "unknown",
      expectedShort: expectedFp ? shortFingerprint(expectedFp) : null,
      encrypted: sealTo !== null,
      canEncrypt: Boolean(identity.kxPublicKey),
    },
    sealTo,
  };
}

/** 从设置里取某个目标机记住的指纹(按归一后的 url 匹配)。 */
export async function rememberedFingerprint(targetUrl: string): Promise<string | null> {
  const { handoffTargets } = await getAppSettings();
  return findTarget(handoffTargets, targetUrl)?.peerFp ?? null;
}

/**
 * 显式发送接力申请。它只做带签名的 ping：对端据此把本机落进待审批列表，不读取
 * 分支、不打包任务、更不会传输仓库。用户已经明确点了「申请」，所以首次见到的对端
 * 身份可以在这一步记住；之后地址背后换了机器，连再次申请都会先被指纹校验拦下。
 */
export async function requestHandoffApproval(rawTargetUrl: string): Promise<HandoffApprovalResult> {
  const targetUrl = normalizePeerUrl(rawTargetUrl);
  const probe = await pingPeer(targetUrl, await rememberedFingerprint(targetUrl));
  if (probe.peer) await rememberPeerFingerprint(targetUrl, probe.peer.fingerprint);
  return {
    ok: true,
    target: { url: targetUrl, host: probe.ping.host },
    peer: probe.peer,
    projects: probe.ping.projects,
  };
}

const findTarget = (targets: HandoffTarget[], url: string): HandoffTarget | undefined => {
  const want = url.replace(/\/+$/, "");
  return targets.find((t) => t.url.trim().replace(/\/+$/, "") === want);
};

/**
 * TOFU 落地:显式申请或接力成功之后把对端指纹记进设置。普通预检仍然不调用它，避免
 * 「点开对话框看一眼就退出」静默改信任状态 —— 记住一台机器必须对应一次明确动作。
 * 目标机不在设置列表里(临时地址)就跳过,不给它凭空建一条。
 */
export async function rememberPeerFingerprint(targetUrl: string, fingerprint: string): Promise<void> {
  const { handoffTargets } = await getAppSettings();
  const hit = findTarget(handoffTargets, targetUrl);
  if (!hit || sameFingerprint(hit.peerFp, fingerprint)) return;
  await patchAppSettings({
    handoffTargets: handoffTargets.map((t) => (t === hit ? { ...t, peerFp: fingerprint } : t)),
  });
}
