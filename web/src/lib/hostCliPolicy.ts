// 「宿主机那份 CLI 登录态对任务算不算数」这一档政策,在**前端**的单点。
//
// 服务端的判据是 `isHostCliIsolated()`(多人模式 且 不共用宿主机 CLI,§八之二),而前端
// 一堆按它变脸的东西里最要紧的是**模型 / 智能水平档位目录**:隔离档下服务端一次都不问
// 宿主机 CLI,端出来的是内置快照 + 兜底档位;共用档下端出来的是 CLI 的原话。
//
// 这档在页面开着的时候就能改(设置页「CLI 额度」那个开关,改了立刻对下一次派发生效),
// 所以凡是缓存了「按某一档取回来的东西」的地方,都得知道它什么时候翻面 ——
// 2026-10-01 第 2 轮审查:网页的目录缓存只按 AgentType 存,额度一改,菜单仍列着
// `ultra`,点下去保存 400,刷新页面才对。
//
// 这个文件**不 import 任何东西**:它要被 `api.ts` 调(学到新政策的那一刻),又要被
// `cliModelCatalog.ts` 订阅(按政策清缓存),夹在中间才不会把那两个绕成环。
export interface HostCliPolicy {
  instanceMode: string;
  sharedHostCli: boolean;
}

/** 与服务端 `isHostCliIsolated()` 同一条判据。自用模式恒为 false。 */
export function isHostCliIsolatedPolicy(policy: HostCliPolicy): boolean {
  return policy.instanceMode === "multi" && !policy.sharedHostCli;
}

/**
 * 只记**影响目录内容的那一位**,不记原始字段:`single` 与 `multi+共用` 对目录来说
 * 是同一档(都去问宿主机 CLI),把它们当成两档会在首启转多人时白清一次缓存。
 */
let isolated = false;
const listeners = new Set<(isolated: boolean) => void>();

/**
 * 学到一份新的政策。**变了才通知**,所以可以在每次读 `/settings` 时无脑调一次 ——
 * 调用点不必自己比较,也就不会漏。
 *
 * 初值取 `false`(= 不隔离),与服务端默认和自用模式一致,所以绝大多数实例第一次读到
 * 设置时根本不算「变」,一次请求都不多发。隔离档的实例会在第一次读到设置时翻一次面,
 * 代价是每个已挂载的选择器多取一次目录 —— 那一档的目录就是内置快照,服务端不问 CLI。
 *
 * **故意不做「第一次学到不算变」那个优化**:它的正确性依赖「页面一定先 GET 过
 * /settings 才可能 PATCH 它」这条隐式顺序。眼下确实成立(设置页要先把 AppSettings
 * 渲染出来才点得到那个开关),但它写不进类型、测不出来,哪天多一条新的学习路径就会
 * 悄悄回到第 2 轮审查那个样子。
 */
export function syncHostCliPolicy(policy: HostCliPolicy): void {
  const next = isHostCliIsolatedPolicy(policy);
  if (next === isolated) return;
  isolated = next;
  for (const notify of listeners) notify(next);
}

/** 订阅翻面。返回退订函数;模块级订阅不退订也无妨。 */
export function onHostCliPolicyChange(listener: (isolated: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
