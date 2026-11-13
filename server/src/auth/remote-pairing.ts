// 设备怎么被放进来(自用模式)。身份判定本身在 remote-access.ts,这里只管「放」这一下。
//
// 两条不用抄密钥的路,第三条(粘访问密钥)在登录端点里:
//
//   ① **申请 → 允许**。新设备打开 ash 就自动递一张申请,机主在任何一处已经进得来的
//      页面上点「允许」。两边各显示同一个四位数:局域网里同时有两台设备在申请时,机主
//      靠它认出哪张是自己手上那台。递申请不要凭证,所以只收从认得的地址打开的页面递来
//      的(remote-access.ts `knownHost`,挡 DNS 重绑定)。
//   ② **扫码**。机主出示一个一次性的码(五分钟内、只能兑一次),设备带着它来就直接进。
//      码不是访问密钥:被人拍走也只能用一次,而且机主会在设备名册里看到多出来的那台。
//
// 申请和码都只放在内存里:它们活不过十分钟,重启后设备那边重新申请一次就是了,落盘反而
// 要多管一份过期清理。放进来之后的设备凭证才落盘(remote-access.ts)。
//
// 递了申请、机主做了决定,这两下往外报一声(`onPairEvent`):飞书通道据此给机主推一张能直接
// 点的卡、在别处处理掉之后把卡收起来(im/pairing.ts)。这里不认识通道,只管报。
import { createHash, randomBytes, randomInt } from "node:crypto";
import { networkInterfaces } from "node:os";
import type { PairClaim, PairCode, PairRequestView, PairTicket } from "@ash/shared";
import { enrollDevice } from "./remote-access.js";

export const PAIR_REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
// 递申请不用任何凭证,所以要有上限:否则同一网段里的一台机器能把机主的页面刷成一墙弹窗。
const MAX_REQUESTS = 8;
const MAX_REQUESTS_PER_ADDRESS = 3;
const MAX_CODES = 4;

interface PairRequest {
  id: string;
  secretHash: string;
  name: string;
  address: string;
  code: string;
  createdAt: number;
  status: "pending" | "approved" | "denied";
}

const requests = new Map<string, PairRequest>();
/** 一次性码的 sha256 → 过期时刻。 */
const codes = new Map<string, number>();

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export type PairEvent =
  | { kind: "opened"; request: PairRequestView }
  | { kind: "decided"; id: string; name: string; approved: boolean };

const listeners = new Set<(event: PairEvent) => void>();

/** 订阅申请的动静。回调同步跑在递申请 / 做决定的那个请求里:只该记一笔就返回,抛错也不连累请求。 */
export function onPairEvent(listener: (event: PairEvent) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function emit(event: PairEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("[ash] 配对事件的订阅方出错:", error);
    }
  }
}

const viewOf = (r: PairRequest): PairRequestView =>
  ({ id: r.id, name: r.name, address: r.address, code: r.code, createdAt: new Date(r.createdAt).toISOString() });

function sweep(now: number): void {
  for (const [id, request] of requests) {
    if (now - request.createdAt >= PAIR_REQUEST_TTL_MS) requests.delete(id);
  }
  for (const [hash, expiresAt] of codes) {
    if (now >= expiresAt) codes.delete(hash);
  }
}

/** 递一张申请。`null` = 等着的申请太多了。 */
export function openPairRequest(input: { name: string; address: string }, now = Date.now()): PairTicket | null {
  sweep(now);
  const waiting = [...requests.values()].filter((r) => r.status === "pending");
  if (waiting.length >= MAX_REQUESTS) return null;
  if (waiting.filter((r) => r.address === input.address).length >= MAX_REQUESTS_PER_ADDRESS) return null;
  const id = randomBytes(9).toString("base64url");
  const secret = randomBytes(24).toString("base64url");
  const code = String(randomInt(0, 10_000)).padStart(4, "0");
  const request: PairRequest = {
    id, secretHash: sha256(secret), name: input.name, address: input.address, code, createdAt: now, status: "pending",
  };
  requests.set(id, request);
  emit({ kind: "opened", request: viewOf(request) });
  return { id, secret, code, expiresAt: new Date(now + PAIR_REQUEST_TTL_MS).toISOString() };
}

export function pendingPairRequests(now = Date.now()): PairRequestView[] {
  sweep(now);
  return [...requests.values()].filter((r) => r.status === "pending").map(viewOf);
}

/** 机主的决定。回被决定的那张申请;已经过期或决定过的回 null。 */
export function decidePairRequest(id: string, approve: boolean, now = Date.now()): { name: string } | null {
  sweep(now);
  const request = requests.get(id);
  if (!request || request.status !== "pending") return null;
  request.status = approve ? "approved" : "denied";
  emit({ kind: "decided", id, name: request.name, approved: approve });
  return { name: request.name };
}

/**
 * 设备来领结果。获准的那一次才登记设备、发凭证,然后申请作废 —— 机主点了允许、设备却
 * 再没回来领的话,名册里不会多出一台从没连上过的设备。
 */
export function claimPairRequest(id: string, secret: string, address: string, now = Date.now()): PairClaim {
  sweep(now);
  const request = requests.get(id);
  if (!request || request.secretHash !== sha256(secret)) return { status: "gone" };
  if (request.status === "pending") return { status: "pending" };
  requests.delete(id);
  if (request.status === "denied") return { status: "denied" };
  return { status: "approved", token: enrollDevice({ name: request.name, via: "approval", address }).token };
}

/** 机主出示一个一次性的码。 */
export function mintPairCode(now = Date.now()): PairCode {
  sweep(now);
  // 插入序即时间序:满了就让最早那个提前作废(机主连点几次「添加设备」的情形)。
  while (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value!);
  const code = randomBytes(18).toString("base64url");
  const expiresAt = now + CODE_TTL_MS;
  codes.set(sha256(code), expiresAt);
  return { code, expiresAt: new Date(expiresAt).toISOString(), hosts: reachableHosts() };
}

/** 设备带着码来。兑一次就作废;不认的回 null。 */
export function redeemPairCode(code: string, input: { name: string; address: string }, now = Date.now()): string | null {
  sweep(now);
  if (!codes.delete(sha256(code.trim()))) return null;
  return enrollDevice({ name: input.name, via: "code", address: input.address }).token;
}

/**
 * 这台机器在各张网卡上的 IPv4,给二维码拼地址用:机主多半是在 localhost 上点的「添加
 * 设备」,那个地址手机扫了没用。家用 / 办公网段排前面,其次 tailnet(100.64/10)。
 */
export function reachableHosts(): string[] {
  const rank = (address: string): number =>
    /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) ? 0
      : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) ? 1
        : 2;
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))
    .map((entry) => entry!.address)
    .sort((a, b) => rank(a) - rank(b));
}

/**
 * 给设备起个机主认得出的名字。浏览器不会报「我是谁家的手机」,能用的只有 User-Agent 里
 * 的系统和浏览器;手机 app 自己报名字(`hint`)。名字只用来认,不参与任何判定。
 */
export function deviceName(userAgent: string | undefined, hint?: unknown): string {
  const given = typeof hint === "string" ? hint.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40) : "";
  if (given) return given;
  const ua = userAgent ?? "";
  const system = /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
      : /Android/.test(ua) ? "Android"
        : /Macintosh|Mac OS X/.test(ua) ? "Mac"
          : /Windows/.test(ua) ? "Windows"
            : /Linux|X11/.test(ua) ? "Linux"
              : "";
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? "Edge"
    : /Firefox\/|FxiOS\//.test(ua) ? "Firefox"
      : /Chrome\/|CriOS\//.test(ua) ? "Chrome"
        : /Safari\//.test(ua) ? "Safari"
          : "";
  return [system, browser].filter(Boolean).join(" · ") || "未知设备";
}
