// 真人专属动作的凭据**载体名字**:服务端发、页面读、回归钉，三边共用这一份。
//
// 为什么放进 shared 而不是各写一份字符串:这几个名字一改，少改任何一边都是「开关突然按
// 不动了」，而编译器不会说一句话。机制本体与它的能力边界在
// `server/src/auth/human-action-token.ts`。

/** 真人动作请求带凭据的头。 */
export const HUMAN_ACTION_TOKEN_HEADER = "x-ash-human-action-token";

/** 页面文档里承载凭据的 meta 名。 */
export const HUMAN_ACTION_TOKEN_META = "ash-human-action-token";

/**
 * 响应里给回「下一份凭据」的**头**名（服务端用一次就烧掉，所以必须轮换）。
 *
 * 为什么是头而不是响应体字段（原先是 body 里的 `nextHumanActionToken`）:烧掉凭据的是闸
 * （`personalWriteGate`），而 body 由各条路由自己拼 —— 于是「谁来发下一份」就落在每个路由的
 * **成功分支**上:业务拒绝（400/409）、异常（500）这些路径一个字都没发，而凭据已经烧了,
 * 同一个页面的下一次点击必然 403「需要页面凭据」(第 5 轮审查 N2)。换成头之后,闸自己在
 * `await next()` 之后挂上去,不分状态码 —— 消费与续发收在同一处,新增一条真人端点不需要
 * 记得做任何事。
 */
export const HUMAN_ACTION_TOKEN_NEXT_HEADER = "x-ash-human-action-token-next";
