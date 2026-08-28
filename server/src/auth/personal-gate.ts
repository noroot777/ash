// 个人面资源的**写闸**:回合凭证不是账号本人(§八 个人面 × §三 agent 身份)。
//
// `owned.ts` 那条私有轴的判据是 `actor.userId`,而 agent 回合凭证身上恰好挂着 owner 的
// userId —— 那是**归属戳**(它建的东西记在谁名下),不是「它就是这个人」(auth/context.ts
// `isAccountHolder`)。两者没接上的后果实测过:只带 `x-ash-source-task-id` +
// `x-ash-turn-token`、没有任何 cookie 或 Bearer key,`POST /api/llm-providers` 就在 owner
// 名下建出了一个供应商(第 1 轮审查 P1)。
//
// 这不是「多一行数据」那么轻:默认执行器、默认供应商、审查者、团队预设、个人接力目标机
// 都是**后续任务会继承的配置**。一条任务的凭证改得动它们,就等于一条任务能改写这个账号
// 往后所有任务的运行方式(还包括往 `llm_providers` 里塞一个指向攻击者的 baseUrl)。
//
// **为什么是中间件而不是每条路由自己判**:这几张表的 CRUD 摊在 routes.ts / workflows.ts /
// team-presets.ts / reviewer-profiles.ts / notes.ts / handoff-routes.ts 六个文件、十几条端点
// 上,还在继续长。逐条加判断的做法一定会漏,而漏掉的那条就是缺口 —— 与 resource-gate.ts
// 顶部同一个理由,也是本仓库已经吃过的亏(`docs/incidents.md`「对称端点只改了一个」)。
//
// **读侧照旧放行**,这是刻意的:派活要挑执行器、要解析供应商和审查者,那正是 MCP 的主路
// (`mcp/src/index.ts` 给每个调用都附那两个头)。而这几条读端点没有一条回显密钥 ——
// 供应商回 `hasKey`、接力目标机回 `hasKey`、git 凭证只写不读 —— 所以「读得到」不等于
// 「拿得到 key」。真正花掉 key 的动作(`POST /llm-providers/models`、`…/test`)是写方法,
// 被这道闸挡在外面。
import type { MiddlewareHandler } from "hono";
import { actorOf } from "./context.js";
import { WRITE_METHODS } from "./middleware.js";
import { isMultiUser } from "./mode.js";

/**
 * 个人面集合的**第一段**。新开一张 `ownerUserId` 的表就顺手加一行 ——
 * 判据看的是「这张表是不是逐人隔离的私产」(owned.ts 顶部那份清单)。
 */
const PERSONAL_COLLECTIONS = new Set([
  "agents", // 执行器
  "llm-providers", // 供应商(API key 装在里面)
  "workflows", // 起手式
  "team-presets", // 团队预设
  "reviewer-profiles", // 审查者
  "notes", // 随手记
  "settings", // 个人键(实例键另有管理员闸,叠加不冲突)
  "me", // 个人 CLI 环境与配置导入导出(personal-routes.ts 另有一份连读侧一起管)
]);

/**
 * 不在第一段上的那几条,逐条写死形状。
 *  · 接力目标机装着「我在对端的账号 key」,但它住在 `/api/handoff/` 这一族下面。
 */
const PERSONAL_PATHS = [/^\/api\/handoff\/targets(?:\/|$)/];

export const AGENT_PERSONAL_REFUSAL =
  "个人资源与账号设置只对账号本人开放：回合凭证代表的是那一条任务，不是这个账号";

/** 导出给回归测试直接钉住:哪几张表算个人面,是这道闸唯一的软肋。 */
export function isPersonalWritePath(path: string): boolean {
  const first = path.replace(/^\/api\/?/, "").split("/").filter(Boolean).at(0);
  return (!!first && PERSONAL_COLLECTIONS.has(first)) || PERSONAL_PATHS.some((p) => p.test(path));
}

export function personalWriteGate(): MiddlewareHandler {
  return async (c, next) => {
    if (!c.req.path.startsWith("/api/")) return next();
    if (!WRITE_METHODS.has(c.req.method)) return next();
    if (!(await isMultiUser())) return next();
    // 只拦 agent:真人(cookie / Bearer)本来就是账号本人,匿名早被 authGate 拦掉了。
    if (actorOf(c).kind !== "agent") return next();
    if (!isPersonalWritePath(c.req.path)) return next();
    return c.json({ error: AGENT_PERSONAL_REFUSAL }, 403);
  };
}
