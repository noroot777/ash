// 出站接力的「我是谁」上下文。
//
// 为什么用 AsyncLocalStorage 而不是把 `ownerUserId` 一路当参数传:一次接力是
// **ping → refs → import** 三四个来回,分散在 handoff.ts / handoff-peer-client.ts /
// handoff-remote.ts / handoff-routes.ts 里十几个调用点。逐个加参数的结果一定是漏掉
// 其中一两条,而漏掉的那条会**不带 key 发出去** —— 对端多人实例会拒收,用户看到的是
// 「有时能接力、有时报没账号」这种最难查的毛病。
//
// 用 ALS 就只有一个约束:每条出站入口在最外层包一次 `withHandoffActor`。忘了包不会
// 静默降级 —— 不带 key 时对端会明确回「必须带上你在对端的账号 key」。
import { AsyncLocalStorage } from "node:async_hooks";
import { PEER_USER_KEY_HEADER } from "./handoff-peer-user.js";
import { peerKeyForRequest } from "./handoff-scope.js";

const store = new AsyncLocalStorage<{ ownerUserId: string | null }>();

/** 在这一段异步调用链里,出站接力都以 `ownerUserId` 的身份发出。 */
export function withHandoffActor<T>(ownerUserId: string | null, fn: () => Promise<T>): Promise<T> {
  return store.run({ ownerUserId }, fn);
}

/** 当前出站链路代表谁。没建立上下文时是 null(自用模式下本来就没有区别)。 */
export const handoffActorId = (): string | null => store.getStore()?.ownerUserId ?? null;

/**
 * 给一个出站请求补上「我在对端的账号 key」。自用模式、或这个目标机还没配 key 时
 * 返回空对象 —— 让对端来说那句「你在这台机器上没有账号」,本机不猜。
 *
 * 入参是**这条请求的完整 URL**(带 `/api/handoff/...` 路径和查询串),所以匹配走
 * `peerKeyForRequest` 的最长前缀,不能拿它去和清单里的根地址精确比 —— 那样永远匹配
 * 不上,每个出站请求都会不带 key 出门(2026-08-29 修,详见那个函数的注释)。
 */
export async function peerUserKeyHeader(url: string): Promise<Record<string, string>> {
  const key = await peerKeyForRequest(handoffActorId(), url);
  return key ? { [PEER_USER_KEY_HEADER]: key } : {};
}
