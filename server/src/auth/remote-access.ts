// 自用模式下「这次请求是不是机主发的」。
//
// 自用模式原先的判据是「连得上端口就是机主」:服务监听所有网卡(手机、接力都要从别的
// 机器连进来),于是局域网 / tailnet 里任何一台机器都能派任务、读代码、开终端 —— 终端
// API 本身就是一个 shell。网络位置不是身份,能证明身份的只有两样:
//
//   ① **请求确实从这台机器上直接发出**(回环连接)。坐在机器前的人、本机的 MCP / hook /
//      脚本都属于这一档,照旧零摩擦。
//   ② **拿得出访问密钥**。别的设备(手机、另一台电脑的浏览器、别处的脚本)凭它进:
//      网页粘一次换 cookie,程序每请求带 `Authorization: Bearer`。
//
// 两条都不满足就是匿名,只碰得到免登录名单(middleware.ts)—— 接力那几条端点在名单里,
// 它们自有 ed25519 签名 + 来源机审批那一套,不靠这里。
//
// ## 「本机直连」不能只看 socket 地址
//
// 回环 socket 只说明「最后一跳在本机」。两类请求最后一跳在本机、发起者却不是机主:
//   · **同机反代 / 隧道**(tailscale serve、Caddy、cloudflared、`ssh -R`…)把外面的请求
//     转进来。它们要么保留对外的 Host,要么带着 `X-Forwarded-For`,两样都当作「不是直连」。
//     (既改写 Host 又不带转发头的反代 —— nginx 的缺省配置 —— 这里认不出来,那种部署得让
//     反代自己做认证,docs/install.md 里写着。)
//   · **DNS 重绑定**:攻击页把自己的域名解析到 127.0.0.1,机主的浏览器就替它打进回环,
//     而且在浏览器眼里还是同源。这种请求的 Host 是攻击者的域名,所以 Host 必须本身就是
//     回环名字。
//
// 进程内派发(`app.fetch` 直接调,没有 socket)按本机算:它根本没经过网络。真正从外面
// 转述进来的那一类(飞书通道)在这道判据之前就由 imGate 单独认了身份。
//
// ## 密钥放哪
//
// `<db>.remote-access.json`(0600),与接力身份的私钥同一个道理(handoff-identity.ts):
// 库会被 preview-seed 快照、被备份来回搬,凭证跟着走就等于多发了一份。明文存放 —— 读得到
// 这个目录的人本来就读得到库里的供应商 key 和接力私钥,哈希挡不住任何人,却会让机主加
// 第二台设备时只能重置、把第一台踢下线。
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Context } from "hono";
import { resolveAshDbFile } from "../db/path.js";
import { isLoopbackAddress } from "../dir-picker.js";
import { secretsEqual } from "../openai-converter/common.js";
import { mintKey } from "./store.js";

/** 机主身份是怎么证明的。`local`/`cookie` 是浏览器会自动带上的那一类,写操作要过 CSRF。 */
export type OwnerProof = "local" | "cookie" | "bearer";

export interface RequestOrigin {
  /** TCP 对端地址。`null` = 进程内派发(没有 socket);`undefined` = 有连接但地址读不到。 */
  remoteAddress: string | null | undefined;
  /** 请求指名要找的主机(Host 头;进程内派发时取 URL 里的)。 */
  host: string | undefined;
  /** 带着「我是替别人转发的」那几个头。 */
  forwarded: boolean;
}

/** 反代声明原始客户端地址用的头。`x-forwarded-prefix/proto` 不算:它们不说明客户端是谁。 */
const FORWARDED_HEADERS = ["forwarded", "x-forwarded-for", "x-real-ip"];

/** Host 是不是回环名字。经 URL 解析归一(`127.1`、十六进制写法、大小写、末尾的点)。 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  let name: string;
  try {
    name = new URL(`http://${host.trim()}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return name === "localhost" || name === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/** 判据本体,拆成纯函数是为了让回归测试逐条钉住(`test:remote-access`)。 */
export function isLocalDirectOrigin(origin: RequestOrigin): boolean {
  // 地址读不到(连接已断)按不可信算:否则「发完就断开」能把自己变成本机。
  if (origin.remoteAddress !== null && !isLoopbackAddress(origin.remoteAddress)) return false;
  if (origin.forwarded) return false;
  return isLoopbackHost(origin.host);
}

export function requestOrigin(c: Context): RequestOrigin {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } }; server?: { incoming?: { socket?: { remoteAddress?: string } } } } | undefined;
  const incoming = env?.server?.incoming ?? env?.incoming;
  return {
    remoteAddress: incoming ? incoming.socket?.remoteAddress : null,
    host: c.req.header("host") ?? new URL(c.req.url).host,
    forwarded: FORWARDED_HEADERS.some((name) => c.req.header(name) !== undefined),
  };
}

export const isLocalDirect = (c: Context): boolean => isLocalDirectOrigin(requestOrigin(c));

// ── 访问密钥 ────────────────────────────────────────────────────────────────

interface KeyFile {
  version: 1;
  key: string;
  createdAt: string;
}

const keyFilePath = (): string => `${resolveAshDbFile()}.remote-access.json`;

// 按路径缓存:同一个进程里换了 ASH_DB(回归测试模拟两台机器)就得重读。
let cached: { path: string; key: string | null } | null = null;

function readKey(): string | null {
  const path = keyFilePath();
  if (cached?.path === path) return cached.key;
  let key: string | null = null;
  if (existsSync(path)) {
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as Partial<KeyFile>;
      if (file.version === 1 && typeof file.key === "string" && file.key.length >= 32) key = file.key;
    } catch {
      // 读不懂的文件当作没有密钥:远程一律进不来,本机下一次查看时重发一把。
    }
  }
  cached = { path, key };
  return key;
}

function writeKey(key: string): string {
  const path = keyFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const file: KeyFile = { version: 1, key, createdAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  // 已存在的文件 writeFileSync 不改权限,补一次(Windows 上是空操作)。
  try { chmodSync(path, 0o600); } catch { /* 文件系统不支持权限位 */ }
  cached = { path, key };
  return key;
}

/** 现在这把密钥;还没有就发一把。只给「本机查看」那条路用 —— 验证方不该顺手造密钥。 */
export function ensureRemoteAccessKey(): string {
  return readKey() ?? writeKey(mintKey());
}

/** 换一把。旧密钥和它换出来的所有网页会话当场失效(会话 token 是从密钥派生的)。 */
export function rotateRemoteAccessKey(): string {
  return writeKey(mintKey());
}

/**
 * 网页登录后种下的会话 token。从密钥派生而不是另存一张表:换密钥 = 所有会话一起失效,
 * 这正是「重新生成」该有的语义,也省掉一份要跟着库搬来搬去的状态。HMAC 单向,cookie
 * 泄露了也推不回密钥。
 */
const sessionTokenOf = (key: string): string =>
  createHmac("sha256", key).update("ash-remote-session-v1").digest("base64url");

export function remoteKeyMatches(candidate: string): boolean {
  const key = readKey();
  return !!key && secretsEqual(candidate.trim(), key);
}

/** 登录成功后发给浏览器的 cookie 值。没有密钥时为 null(那时也不可能登录成功)。 */
export function remoteSessionToken(): string | null {
  const key = readKey();
  return key ? sessionTokenOf(key) : null;
}

/** 自用模式的身份判定:本机直连,或者带着有效的密钥 / 会话。都不是就回 null(匿名)。 */
export function ownerProof(c: Context, sessionCookie: string | undefined): OwnerProof | null {
  if (isLocalDirect(c)) return "local";
  const key = readKey();
  if (!key) return null;
  const bearer = /^Bearer\s+(\S+)$/i.exec((c.req.header("authorization") ?? "").trim())?.[1];
  if (bearer && secretsEqual(bearer, key)) return "bearer";
  if (sessionCookie && secretsEqual(sessionCookie, sessionTokenOf(key))) return "cookie";
  return null;
}
