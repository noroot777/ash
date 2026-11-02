// 真人专属动作的**正面凭据**。
//
// ## 为什么非得有这个东西
//
// 原先这道闸的判据是「调用方有没有自称 agent」:带着 `x-ash-source-task-id` +
// `x-ash-turn-token` 的拿 403,**什么头都不带的裸请求拿 200**（审查实测
// `200 {reclaimed:true, role:"single", heldMs:45}`，锁确实被放开）。诚实申报的被拦、
// 一言不发的放行，顺序正好是反的 —— 于是这道闸只拦得住愿意配合的调用方，而 agent 手里
// 有 shell，`curl` 一行就绕过去了。
//
// 不变量:**身份判定不能建立在调用方自愿申报上**。得有一份本服务自己发出去的凭据，
// 拿不出来就是拒绝。
//
// ## 能力边界(写在前面，别让下一个人以为这是密码学边界)
//
// 凭据随**页面文档**下发，而本机任何程序都读得到那份文档。所以它挡不住一个铁了心模仿
// 页面的本机程序 —— 要挡那个，凭据就得走一条「页面读得到、程序读不到」的通道，而本机
// HTTP 之上不存在这样的通道（终端里打印一串让用户手抄算一条，但那是另一种产品）。
//
// 它真正改掉的是三件事，每一件都是原先那道闸的实际缺口:
//   ① 默认从「放行」翻成「拒绝」——不再有「少说话就多拿权限」这种反向激励，也不再
//      需要穷举「哪些头没带算可疑」(那条路永远少一种组合);
//   ② 凭据**每次启动换一批、用一次就烧掉**——历史记录、日志、截图里抄到的那一串按不动
//      第二次，重启之后整批作废;
//   ③ 记录只说得出它能证的那一档(见 turn-lock-reclaim.ts 的措辞)。
import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { HUMAN_ACTION_TOKEN_META } from "@ash/shared/human-action";
export { HUMAN_ACTION_TOKEN_HEADER, HUMAN_ACTION_TOKEN_META, HUMAN_ACTION_TOKEN_NEXT_HEADER } from "@ash/shared/human-action";

/**
 * 这次启动的前缀。上次启动发出去的凭据因此一律验不过 —— 不必持久化、也不必清理。
 */
const EPOCH = randomBytes(8).toString("base64url");

/** 一份凭据活多久。页面开着不动一整天仍按得动那个开关，超过就重新加载页面换一份。 */
const TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * 在册凭据的上限。每打开一次页面发一份，所以这个数就是「同时开着的页面份数」的上界;
 * 到顶时先丢最早的那一批（Map 迭代序即插入序），不让一台长跑的实例把内存堆起来。
 */
const MAX_LIVE = 512;

const live = new Map<string, number>(); // token → 过期时刻

function sweep(now: number): void {
  for (const [token, expiresAt] of live) {
    if (expiresAt > now) break; // 插入序 ≈ 过期序(TTL 固定)，遇到第一个没过期的就可以停
    live.delete(token);
  }
}

/**
 * 发一份新凭据。**只有两个调用点**:「服务端把页面文档交出去」那一刻(下面的
 * `stampHumanActionToken`,`index.ts` 的 serveSpa 经它盖),以及**闸烧掉一份之后的轮换**
 * (personalWriteGate —— 烧和发在同一处,不分成功失败)。别给它开一个 JSON 端点,那等于把
 * 「要先拿到页面文档」这一步也省掉了;也别在路由里自己发一份 —— 那正是 N2 的形状:错误
 * 分支一定会漏。
 */
export function issueHumanActionToken(): string {
  const now = Date.now();
  sweep(now);
  while (live.size >= MAX_LIVE) {
    const oldest = live.keys().next();
    if (oldest.done) break;
    live.delete(oldest.value);
  }
  const token = `${EPOCH}.${randomBytes(24).toString("base64url")}`;
  live.set(token, now + TTL_MS);
  return token;
}

/**
 * 把一份新凭据盖进一份页面文档 —— **凭据长在文档上的形状只有这一处定义**。
 *
 * 为什么要收成一个函数:交付这个应用文档的入口不止服务端自己那一条(vite 的 dev 与 preview
 * 也交,见 `web/vite/page-token.ts` —— 它们从本服务取一份文档再把这个 meta 抬过去),而回归
 * 要钉的恰恰是「那两条路上的页面,凭据后端真的认」。盖法散成两份字符串时,这种测试只能自己
 * 照抄一遍形状,于是测的是抄件而不是本体(本轮审查 F2:fixture 里写死 `page-token-1` 的那份
 * DOM 回归,对真实文档一个字都证明不了)。
 */
export function stampHumanActionToken(html: string): string {
  return html.replace(
    "</head>",
    `<meta name="${HUMAN_ACTION_TOKEN_META}" content="${issueHumanActionToken()}"></head>`,
  );
}

/**
 * 核验并**烧掉**一份凭据。拿不出、对不上、过期、或者是上次启动发的 —— 一律 false。
 *
 * 烧掉之后**闸**会把 `issueHumanActionToken()` 发的新一份挂在响应头上交回页面(见
 * HUMAN_ACTION_TOKEN_NEXT_HEADER),这样「从日志里抄一串重放」就不成立。页面万一两边都丢了(响应在路上没了)，它重新加载
 * 一次文档就能换到新的 —— 那条恢复路径是刻意留的，不然用户会撞上一个按不动的开关。
 */
export function consumeHumanActionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const expiresAt = live.get(token);
  if (expiresAt === undefined) return false;
  live.delete(token);
  return expiresAt > Date.now();
}

/** 导出给回归:当前在册几份。 */
export function liveHumanActionTokenCount(): number {
  sweep(Date.now());
  return live.size;
}

// Hono 的 c.set/c.get 是无类型字符串键,收敛成下面两个函数(同 auth/context.ts 的口径)。
const VERIFIED_KEY = "ashHumanActionVerified";

/** 闸核验通过之后盖一个戳。**只有 `personalWriteGate` 该调它。** */
export function markHumanActionVerified(c: Context): void {
  c.set(VERIFIED_KEY as never, true as never);
}

/**
 * 这次请求**能证到哪一层**,给留痕措辞用。
 *
 * `"page"` = 闸核验过一份随页面文档下发的一次性凭据,也就是「这一下来自一个本服务发过
 * 文档的页面」;**不是**「某个人按了鼠标」(能力边界见本文件顶部),所以记录里也不许
 * 升格成「用户主动」。缺省 `"unverified"` 留给不过闸的内部直调 —— 读的是戳而不是
 * 「路径在不在 HUMAN_ONLY_PATHS 里」:后者是在推断「闸应该跑过」,而这里要的是闸**确实
 * 跑过**的证据,中间件哪天漏挂一条路径,措辞不该跟着说假话。
 */
export function humanActionOrigin(c: Context): "page" | "unverified" {
  return c.get(VERIFIED_KEY as never) === true ? "page" : "unverified";
}
