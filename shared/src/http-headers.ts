// 我方 HTTP 头的名字：当前前缀 `x-navi-`，读的时候也认旧前缀 `x-ash-`（见 legacy-names.ts）。
//
// 发头的一侧有好几个进程、好几个版本：MCP 子进程、claude 钩子、网页、手机端、mac 启动器、局域网里
// 的另一台实例。升级那一刻，升级前起的 MCP 子进程和钩子、没刷新的网页、还没升级的对端发的都是旧名，
// 所以**收**一律走 `readHeader`（新名优先，退到旧名）；**认「带没带这个头」的闸**（比如「带了
// 回合令牌就不是真人」）同样两代都认，只认新名就成了一条绕过去的路。**发**只写新名，例外是发给
// 可能还是旧版的对端（接力），那里新旧各写一份，在调用处写明。
import { LEGACY_HTTP_HEADER_PREFIX } from "./legacy-names.ts";

export const HTTP_HEADER_PREFIX = "x-navi-";

/** 一个我方头的当前名。只收 `x-navi-` 开头的，写成别的前缀编译不过。 */
export type NaviHeaderName = `x-navi-${string}`;

/** 两边（MCP / 钩子 / 网页 ↔ 服务端）都要认的那几个头。 */
export const NAVI_HEADERS = {
  /** 谁发的请求（MCP 子进程发 `mcp`）。 */
  client: "x-navi-client",
  /** 回合身份：哪条任务、哪一回合、哪个方向。 */
  sourceTaskId: "x-navi-source-task-id",
  turnToken: "x-navi-turn-token",
  directionToken: "x-navi-direction-token",
  /** 网页 / 手机端标记「这是人点的」。 */
  userAction: "x-navi-user-action",
  /** 宿主机运维凭证（单例锁里那串 token，见 server/src/singleton.ts 的 liveLockToken）。 */
  hostToken: "x-navi-host-token",
  /** 这个请求是发给哪一台实例的（同端口换了实例时据此拒收）。 */
  instance: "x-navi-instance",
} as const satisfies Record<string, NaviHeaderName>;

/** 同一个头的各代名字，新名在前：`x-navi-turn-token` → `["x-navi-turn-token", "x-ash-turn-token"]`。 */
export function headerNameGenerations(name: NaviHeaderName): string[] {
  return [name, `${LEGACY_HTTP_HEADER_PREFIX}${name.slice(HTTP_HEADER_PREFIX.length)}`];
}

/** 按各代名字取头，新名优先。`get` 是取单个头的那个函数（Hono 的 `c.req.header`、`Headers#get`…）。 */
export function readHeader(
  get: (name: string) => string | null | undefined,
  name: NaviHeaderName,
): string | undefined {
  for (const key of headerNameGenerations(name)) {
    const value = get(key);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** 这个头名是不是我方的（任一代前缀）。转发给第三方前要剥掉的就是这些。 */
export function isNaviHeaderName(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith(HTTP_HEADER_PREFIX) || lower.startsWith(LEGACY_HTTP_HEADER_PREFIX);
}

/** 新旧两代各一份：只在发给可能还是旧版的那一头时用（接力对端、没刷新的旧页面读的响应头）。 */
export function withLegacyHeaderNames(headers: Readonly<Record<NaviHeaderName, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers) as [NaviHeaderName, string][]) {
    for (const key of headerNameGenerations(name)) out[key] = value;
  }
  return out;
}
