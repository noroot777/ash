// 自用模式下「这次请求是不是机主发的」。
//
// 自用模式原先的判据是「连得上端口就是机主」:服务监听所有网卡(手机、接力都要从别的
// 机器连进来),于是局域网 / tailnet 里任何一台机器都能派任务、读代码、开终端 —— 终端
// API 本身就是一个 shell。网络位置不是身份,能证明身份的只有两样:
//
//   ① **请求确实从这台机器上直接发出**(回环连接)。坐在机器前的人、本机的 MCP / hook /
//      脚本都属于这一档,照旧零摩擦。
//   ② **机主放进来的设备**。每台设备一把自己的凭证(浏览器是 cookie,手机 app 是
//      `Authorization: Bearer`),可以单独移除。放进来有三条路(remote-pairing.ts):
//      设备申请、机主点「允许」;扫机主出示的一次性二维码;粘访问密钥。
//   ③ **拿得出访问密钥**。给脚本用:每请求带 `Authorization: Bearer`,不登记成设备。
//
// 都不满足就是匿名,只碰得到免登录名单(middleware.ts)—— 接力那几条端点在名单里,
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
// ## 凭证作废,从它派生出去的东西一起作废
//
// 一件凭证(一台设备、那把访问密钥)名下不止有「下一次请求」:还有它开着的长连接(事件流),
// 和凭它签发出去的预览凭证(preview-access.ts —— 那是地址里的一串随机数,自己不认设备)。
// 这些都记在凭证的名字(`holder`)下,收回只有 `revoke` 一个出口:掐连接、通知派生授权的
// 那一方。移除设备、设备自己登出、换密钥都走它,不靠各条路由各自记得多调一句。
//
// ## 凭证放哪
//
// `<db>.remote-access.json`(0600),与接力身份的私钥同一个道理(handoff-identity.ts):
// 库会被 preview-seed 快照、被备份来回搬,凭证跟着走就等于多发了一份。
//   · 访问密钥明文存放 —— 读得到这个目录的人本来就读得到库里的供应商 key 和接力私钥,
//     哈希挡不住任何人,却会让机主想再看一眼时只能重置。
//   · 设备凭证只存 sha256:它发出去之后没有人需要再看一眼。
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { isIP, type Socket } from "node:net";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { Context } from "hono";
import type { RemoteDeviceVia } from "@ash/shared";
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

/** 这次请求底下的 TCP 连接。`null` = 进程内派发,根本没有连接。 */
function socketOf(c: Context): Socket | undefined | null {
  const env = c.env as { incoming?: { socket?: Socket }; server?: { incoming?: { socket?: Socket } } } | undefined;
  const incoming = env?.server?.incoming ?? env?.incoming;
  return incoming ? incoming.socket : null;
}

/** 对端地址,只用来给机主看「这台设备从哪连进来的」。不参与任何判定。 */
export function peerAddress(c: Context): string {
  const socket = socketOf(c);
  if (socket === null) return "本机";
  return (socket?.remoteAddress ?? "").replace(/^::ffff:/i, "") || "未知地址";
}

export function requestOrigin(c: Context): RequestOrigin {
  const socket = socketOf(c);
  return {
    remoteAddress: socket === null ? null : socket?.remoteAddress,
    host: c.req.header("host") ?? new URL(c.req.url).host,
    forwarded: FORWARDED_HEADERS.some((name) => c.req.header(name) !== undefined),
  };
}

export const isLocalDirect = (c: Context): boolean => isLocalDirectOrigin(requestOrigin(c));

/** 没经过 Hono 的请求(WebSocket 升级)的来源。 */
export function originOfIncoming(incoming: IncomingMessage): RequestOrigin {
  return {
    remoteAddress: incoming.socket?.remoteAddress,
    host: incoming.headers.host,
    forwarded: FORWARDED_HEADERS.some((name) => incoming.headers[name] !== undefined),
  };
}

/**
 * ash 自己替别人转发时(预览代理)该盖在 `X-Forwarded-For` 上的值;请求本来就是本机直连的回
 * null(不盖)。代理到上游走的是回环,被预览的服务又多半把 `/api` 转回这台 ash —— 不盖这个章,
 * 别的设备经预览绕一圈回来就成了「本机直连」,拿到的比它自己的凭证还多(读得到访问密钥)。
 */
export function forwardedFor(origin: RequestOrigin): string | null {
  if (isLocalDirectOrigin(origin)) return null;
  const address = (origin.remoteAddress ?? "").replace(/^::ffff:/i, "");
  return /^[0-9a-f:.]+$/i.test(address) ? address : "unknown";
}

// ── 落盘的那份状态:访问密钥 + 设备名册 ──────────────────────────────────────

export interface RemoteDevice {
  id: string;
  name: string;
  /** 设备凭证的 sha256。凭证本体只在发出去的那一刻存在。 */
  tokenHash: string;
  via: RemoteDeviceVia;
  createdAt: string;
  lastSeenAt: string;
  /** 最近一次连进来的对端地址(展示用)。 */
  address: string;
}

interface StateFile {
  version: 1;
  /** 还没人看过「远程访问」时没有密钥:那时脚本进不来,设备配对不受影响。 */
  key?: string;
  createdAt?: string;
  devices?: RemoteDevice[];
  hosts?: string[];
}

interface State {
  key: string | null;
  createdAt: string;
  devices: RemoteDevice[];
  /** 机主实际用过的访问名字,见 `knownHost`。 */
  hosts: string[];
}

const stateFilePath = (): string => `${resolveAshDbFile()}.remote-access.json`;

// 按路径缓存:同一个进程里换了 ASH_DB(回归测试模拟两台机器)就得重读。
let cached: { path: string; state: State } | null = null;

function loadState(): State {
  const path = stateFilePath();
  if (cached?.path === path) return cached.state;
  const state: State = { key: null, createdAt: new Date().toISOString(), devices: [], hosts: [] };
  if (existsSync(path)) {
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as Partial<StateFile>;
      if (file.version === 1) {
        if (typeof file.key === "string" && file.key.length >= 32) state.key = file.key;
        if (typeof file.createdAt === "string") state.createdAt = file.createdAt;
        if (Array.isArray(file.devices)) {
          state.devices = file.devices.filter((d) => d && typeof d.id === "string" && typeof d.tokenHash === "string");
        }
        if (Array.isArray(file.hosts)) state.hosts = file.hosts.filter((h) => typeof h === "string");
      }
    } catch {
      // 读不懂的文件当作空的:远程一律进不来,本机不受影响,重新配对即可。
    }
  }
  cached = { path, state };
  return state;
}

/** 落盘成功之后才换掉内存里那份:写不下去(盘满、权限)时进程里认的和重启后读到的不能是两套。 */
function saveState(state: State): void {
  const path = stateFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const file: StateFile = {
    version: 1,
    ...(state.key ? { key: state.key } : {}),
    createdAt: state.createdAt,
    devices: state.devices,
    hosts: state.hosts,
  };
  // 先写旁边再改名:写到一半断电留下半个文件,等于把所有设备一起踢下线。
  const staging = `${path}.tmp`;
  writeFileSync(staging, JSON.stringify(file, null, 2), { mode: 0o600 });
  // 已存在的文件 writeFileSync 不改权限,补一次(Windows 上是空操作)。
  try { chmodSync(staging, 0o600); } catch { /* 文件系统不支持权限位 */ }
  renameSync(staging, path);
  cached = { path, state };
}

/** 改一下状态:在副本上改、落盘,成了才生效。 */
function update(change: (draft: State) => void): State {
  const draft = structuredClone(loadState());
  change(draft);
  saveState(draft);
  return draft;
}

// ── 访问密钥 ────────────────────────────────────────────────────────────────

/** 现在这把密钥;还没有就发一把。只给「本机查看」那条路用 —— 验证方不该顺手造密钥。 */
export function ensureRemoteAccessKey(): string {
  return loadState().key ?? update((draft) => { draft.key = mintKey(); }).key!;
}

/**
 * 换一把。旧密钥当场失效,**凭它进来的设备一并移除**(`via: "key"`):换密钥要回答的
 * 就是「这把密钥漏了怎么办」,拿它登过的浏览器不跟着走的话等于没换。机主亲手点过
 * 「允许」或出示过二维码的那些设备不靠这把密钥,不受牵连。
 */
export function rotateRemoteAccessKey(): string {
  const before = loadState();
  const next = update((draft) => {
    draft.devices = draft.devices.filter((d) => d.via !== "key");
    draft.key = mintKey();
  });
  if (before.key) revoke(keyHolder(before.key));
  for (const device of before.devices) if (device.via === "key") revoke(deviceHolder(device.id));
  return next.key!;
}

export function remoteKeyMatches(candidate: string): boolean {
  const { key } = loadState();
  return !!key && secretsEqual(candidate.trim(), key);
}

// ── 设备名册 ────────────────────────────────────────────────────────────────

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** 登记一台设备,回它的凭证(只此一次)。 */
export function enrollDevice(input: { name: string; via: RemoteDeviceVia; address: string }): { device: RemoteDevice; token: string } {
  const token = `ashd_${randomBytes(32).toString("base64url")}`;
  const at = new Date().toISOString();
  const device: RemoteDevice = {
    id: randomBytes(9).toString("base64url"),
    name: input.name,
    tokenHash: hashToken(token),
    via: input.via,
    createdAt: at,
    lastSeenAt: at,
    address: input.address,
  };
  update((draft) => { draft.devices.push(device); });
  return { device, token };
}

export const listDevices = (): RemoteDevice[] => loadState().devices;

export function deviceByToken(token: string | undefined): RemoteDevice | null {
  if (!token?.startsWith("ashd_")) return null;
  const hash = hashToken(token);
  return loadState().devices.find((d) => d.tokenHash === hash) ?? null;
}

/**
 * 移除一台设备:凭证作废,它还开着的连接一并掐断 —— 事件流是一条长连接,只作废凭证的话
 * 被移除的设备还能顺着它一直看下去。`keep` 是「正在办这件事的那条连接」(设备自己登出时
 * 就是它自己),掐了它这次应答就发不回去。
 */
export function removeDevice(id: string, keep?: Socket | null): boolean {
  if (!loadState().devices.some((d) => d.id === id)) return false;
  update((draft) => { draft.devices = draft.devices.filter((d) => d.id !== id); });
  revoke(deviceHolder(id), keep);
  return true;
}

// 「最近活跃」只是给机主认设备用的,不值得每个请求写一次盘。
const SEEN_FLUSH_MS = 5 * 60_000;

function noteSeen(device: RemoteDevice, address: string): void {
  const now = Date.now();
  if (device.address === address && now - Date.parse(device.lastSeenAt) < SEEN_FLUSH_MS) return;
  // 记不上不拦这次请求:这只是给人看的。
  try {
    update((draft) => {
      const entry = draft.devices.find((d) => d.id === device.id);
      if (entry) Object.assign(entry, { lastSeenAt: new Date(now).toISOString(), address });
    });
  } catch { /* 下次再记 */ }
}

// ── 认得的访问名字 ───────────────────────────────────────────────────────────
//
// 「申请 → 允许」这条路有一个别的路没有的口子:递申请不要任何凭证,而 DNS 重绑定能让
// 机主自己的浏览器替攻击页递一张 —— 机主看到的是一张来自自己电脑的申请,顺手点了允许,
// 攻击页就领到凭证。重绑定的前提是页面开在攻击者控制的**域名**下,所以只收从认得的名字
// 打开的页面递来的申请:
//   · IP 字面量 —— 那个源上的页面只可能是 ash 自己给的;
//   · 这台机器自己的主机名(含 `.local`);
//   · 机主已经带着凭证用过的名字(自定义域名、tailnet 全名):先扫码或粘密钥进来一次,
//     这个名字就记下了。带凭证的请求造不出来 —— cookie 按域名存,攻击者的域名下没有;
//   · 机主在设置里亲手填的对外地址(`configured`,飞书消息里的链接就指向它):填它要
//     机主身份,攻击者写不进去。不认它的话,机主点开 ash 自己发来的链接反倒申请不了。
// 别的名字不是进不来,只是不能走「申请」:扫码和访问密钥都要机主手里的东西,不吃这一套。

const MAX_HOSTS = 16;

function hostNameOf(host: string | undefined): string {
  if (!host) return "";
  try {
    return new URL(`http://${host.trim()}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

function urlHostName(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** `configured`:机主配置过的对外地址(完整 URL),见上面最后一条。 */
export function knownHost(host: string | undefined, configured: readonly (string | null)[] = []): boolean {
  const name = hostNameOf(host);
  if (!name) return false;
  if (name === "localhost" || isIP(name.replace(/^\[|\]$/g, ""))) return true;
  const own = hostname().toLowerCase().replace(/\.local$/, "");
  if (own && (name === own || name === `${own}.local`)) return true;
  if (configured.some((url) => url && urlHostName(url) === name)) return true;
  return loadState().hosts.includes(name);
}

function rememberHost(host: string | undefined): void {
  const name = hostNameOf(host);
  if (!name || knownHost(host)) return;
  // 记不上不拦这次请求:它已经凭凭证进来了,只是这个名字下次还不能直接申请配对。
  try {
    update((draft) => { draft.hosts = [...draft.hosts, name].slice(-MAX_HOSTS); });
  } catch { /* 下次再记 */ }
}

// ── 凭证的名字、存活与收回 ───────────────────────────────────────────────────

/** 本机直连背后没有哪件能收回的凭证。 */
export const LOCAL_HOLDER = "local";
const deviceHolder = (id: string): string => `device:${id}`;
// 密钥的名字跟着密钥本身走:换一把之后,旧名字下的东西自然对不上。
const keyHolder = (key: string): string => `key:${hashToken(key).slice(0, 16)}`;

/** 这件凭证此刻还作不作数。派生出去的授权每次用之前都问一遍(preview-access.ts canUsePreview)。 */
export function credentialAlive(holder: string): boolean {
  if (holder === LOCAL_HOLDER) return true;
  const { key, devices } = loadState();
  if (holder.startsWith("device:")) return devices.some((d) => deviceHolder(d.id) === holder);
  return !!key && keyHolder(key) === holder;
}

const connections = new Map<string, Set<Socket>>();
const revocationListeners = new Set<(holder: string) => void>();

function holdConnection(holder: string, socket: Socket | undefined | null): void {
  if (!socket || socket.destroyed) return;
  let held = connections.get(holder);
  if (!held) connections.set(holder, held = new Set());
  if (held.has(socket)) return;
  held.add(socket);
  socket.once("close", () => {
    held.delete(socket);
    if (!held.size && connections.get(holder) === held) connections.delete(holder);
  });
}

/** 凭证被收回时叫一声。给「凭它签发过别的授权」的那一方用,让那些授权跟着作废。 */
export function onCredentialRevoked(listener: (holder: string) => void): () => void {
  revocationListeners.add(listener);
  return () => void revocationListeners.delete(listener);
}

/** 收回一件凭证名下的一切(文件头「凭证作废…」一节)。`keep` 见 `removeDevice`。 */
function revoke(holder: string, keep?: Socket | null): void {
  for (const socket of connections.get(holder) ?? []) {
    if (socket !== keep) socket.destroy();
  }
  for (const listener of revocationListeners) {
    try {
      listener(holder);
    } catch (error) {
      console.error("[ash] 凭证收回的订阅方出错:", error);
    }
  }
}

/** 这次请求底下的连接,给 `removeDevice` 的 `keep` 用。 */
export const connectionOf = (c: Context): Socket | null => socketOf(c) ?? null;

// ── 判定 ────────────────────────────────────────────────────────────────────

export interface OwnerProofResult {
  how: OwnerProof;
  deviceId: string | null;
  /** 这次身份背后那件凭证的名字;凭这次请求签发出去的授权记下它(`credentialAlive`)。 */
  holder: string;
}

/** 自用模式的身份判定:本机直连、放进来的设备、访问密钥。都不是就回 null(匿名)。 */
export function ownerProof(c: Context, sessionCookie: string | undefined): OwnerProofResult | null {
  if (isLocalDirect(c)) return { how: "local", deviceId: null, holder: LOCAL_HOLDER };
  const bearer = /^Bearer\s+(\S+)$/i.exec((c.req.header("authorization") ?? "").trim())?.[1];
  const host = requestOrigin(c).host;
  const socket = socketOf(c);
  const { key } = loadState();
  if (bearer && key && remoteKeyMatches(bearer)) {
    holdConnection(keyHolder(key), socket);
    rememberHost(host);
    return { how: "bearer", deviceId: null, holder: keyHolder(key) };
  }
  const viaBearer = deviceByToken(bearer);
  const device = viaBearer ?? deviceByToken(sessionCookie);
  if (!device) return null;
  holdConnection(deviceHolder(device.id), socket);
  rememberHost(host);
  // 经同机的一跳转进来的(反代、ash 自己的预览代理)对端是回环,不是这台设备在哪:不拿它盖掉原来记的。
  noteSeen(device, socket && isLoopbackAddress(socket.remoteAddress) ? device.address : peerAddress(c));
  return { how: viaBearer ? "bearer" : "cookie", deviceId: device.id, holder: deviceHolder(device.id) };
}

const HOLDER_KEY = "ashOwnerHolder";

/** 闸认下这次请求之后记一笔它凭的是哪件凭证(middleware.ts)。 */
export function noteOwnerHolder(c: Context, holder: string): void {
  c.set(HOLDER_KEY as never, holder as never);
}

/** 这次请求凭的那件凭证;不是凭机主身份进来的(agent 回合凭证、多人模式)回 null。 */
export const ownerHolderOf = (c: Context): string | null => (c.get(HOLDER_KEY as never) as string | undefined) ?? null;
