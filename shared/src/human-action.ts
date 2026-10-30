// 真人专属动作的凭据**载体名字**:服务端发、页面读、回归钉，三边共用这一份。
//
// 为什么放进 shared 而不是各写一份字符串:这两个名字一改，少改任何一边都是「开关突然按
// 不动了」，而编译器不会说一句话。机制本体与它的能力边界在
// `server/src/auth/human-action-token.ts`。

/** 真人动作请求带凭据的头。 */
export const HUMAN_ACTION_TOKEN_HEADER = "x-ash-human-action-token";

/** 页面文档里承载凭据的 meta 名。 */
export const HUMAN_ACTION_TOKEN_META = "ash-human-action-token";

/** 响应里给回「下一份凭据」的字段名（服务端用一次就烧掉，所以必须轮换）。 */
export const HUMAN_ACTION_TOKEN_FIELD = "nextHumanActionToken";
