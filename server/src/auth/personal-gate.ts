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
import {
  HUMAN_ACTION_TOKEN_HEADER,
  HUMAN_ACTION_TOKEN_NEXT_HEADER,
  consumeHumanActionToken,
  issueHumanActionToken,
  markHumanActionVerified,
} from "./human-action-token.js";
import { WRITE_METHODS } from "./middleware.js";
import { isMultiUser } from "./mode.js";
import { humanRequestRejection, rejectHumanRequest } from "./human-request.js";
export { AGENT_HUMAN_ONLY_REFUSAL } from "./human-request.js";

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
 * 不在第一段上的那几条,逐条写死形状。前几条住在 `/api/handoff/` 这一族下面,最后一条挂在
 * 任务上 —— 它不是「一张逐人隔离的表」,而是**只有账号本人做得了的动作**,判据同一条:
 * 回合凭证代表的是那一条任务,不是这个账号。
 *  · 接力目标机装着「我在对端的账号 key」。
 *  · 接力**来源**名单管的是「谁能把任务推进这台机器」。批准一台来源机 = 让它上面所有人
 *    都敲得开本机的门,比改一个供应商还重;而按人归属之后,它同样是一张逐人隔离的表
 *    (handoff-peers.ts `peerAudience`)。回合凭证身上挂的 owner userId 是**归属戳**,
 *    不是「它就是这个人」—— 不登记进来的话,任意一条正在跑的任务只凭
 *    `x-ash-source-task-id` + `x-ash-turn-token` 就能替 owner 放行一台陌生机器,
 *    还会把操作人记成 owner 本人(第 1 轮审查 P1)。
 *  · 接力**申请**是「以 owner 的身份去敲另一台机器的门」:index.ts 用
 *    `withHandoffActor(ownerIdOf(actorOf(c)))` 包住 /api/*,所以回合凭证走到这条路由时
 *    会顶着 owner 的名义,而 `requestHandoffApproval` 是唯一 `pairing: true` 的出口 ——
 *    它会把 owner 存的**「我在对端的账号 key」随请求发给那个 URL**。任意一条正在跑的
 *    任务因此能在用户没点过的情况下往任意地址制造远端申请并带走那把 key(第 2 轮审查
 *    P1 实测复现)。agent 要探路仍有只读的 /tasks/:id/handoff/preflight,那条不配对。
 */
const PERSONAL_PATHS = [
  /^\/api\/handoff\/targets(?:\/|$)/,
  /^\/api\/handoff\/peers(?:\/|$)/,
  /^\/api\/handoff\/request(?:\/|$)/,
  // `POST` = 正式接力(停任务 → 打包 → 推给对端 → 本地落存档),`DELETE` = 「在本机继续」
  // 那道逃生门(去对端撤单,必要时带 acknowledgeDuplicateRisk 强来)。两边都是把任务整个
  // 搬走或搬回的**用户决定**,比发一封申请重得多:对端要是已批准/单人/旧版开放接收,那不
  // 是一条待审批通知,而是任务正文、会话历史和仓库状态**直接迁移**过去(第 3 轮审查 P1)。
  // 精确到末尾:`/handoff/preflight` 只探路不动任务,派活要用,留给它。
  /^\/api\/tasks\/[^/]+\/handoff$/,
  //  · 任务备忘是**人写给自己看的私有批注**(shared/src/task-memo.ts 顶部那份分界):它不进
  //    任何 prompt,agent 压根读不到,自然也没有任何理由改得动。而 `canUseOwned` 判的是
  //    `ownerUserId` 相等 —— 回合凭证身上恰好挂着 owner 的归属戳,于是只凭
  //    `x-ash-source-task-id` + `x-ash-turn-token` 就能改写、删掉用户自己记的东西
  //    (第 2 轮审查 F2 实测:对照 `POST /api/notes` 返 403,备忘这三条却 201/200/200)。
  //    随手记走的是第一段(PERSONAL_COLLECTIONS 里的 "notes"),备忘挂在任务下面所以在这里。
  //    **末尾那条摘要端点不在内**:`/api/tasks/memos` 是只读集合查询(POST 只因为要带一批
  //    taskId),下面这条正则要求中间那段是任务 id,正好不会误伤它。
  /^\/api\/tasks\/[^/]+\/memos(?:\/|$)/,
];

/**
 * **只有账号本人按得动的危险动作。** 跟上面那两段的差别有两处,都是刻意的:
 *
 * ① **不看单人/多人。** 上面那张清单防的是「别人家的 agent 动了我的私产」,自用模式下
 *    没有「别人」,所以整道闸放行。这里防的是另一件事 —— **agent 替用户点了那个只有
 *    用户能点的开关**,而它在自用模式下一模一样地成立:同项目另一条任务只凭
 *    `x-ash-source-task-id` + `x-ash-turn-token` 就按得动(第 1 轮审查 F2 实测:
 *    `kind:"agent"` 的请求拿到 200、目标任务的锁被放开,日志还记成「用户主动放开」)。
 * ② 回合身份不能代替人工授权。自用模式没有账号鉴权边界,本机默认身份本身不证明
 *    用户同意;入口仍核验来源,路由另要求显式确认风险。
 *
 * 为什么这类动作必须这样收:`reclaim-turn` 解除的是**互斥本身**。判据(没句柄、没令牌、
 * 占得久)证不了原持有者已经结束,按错一次就是同一个任务两个回合并行改同一个工作区。
 * 它之所以存在,全部理由就是「系统判不了,所以让知情的人来判」(AGENTS.md 对这类不可逆
 * 又外溢操作的口径)。那么把一次 agent 发来的 HTTP 请求当成「用户知情同意」,等于把这个
 * 设计的唯一前提抽掉 —— 界面上那段风险说明也就只是说给没在看的人听。
 */
const HUMAN_ONLY_PATHS = [
  /^\/api\/tasks\/[^/]+\/reclaim-turn(?:\/approval)?$/,
  // 杀掉 CUA 旁路会话:AGENTS.md 对它的口径就是「不可逆又外溢,默认必须是告诉用户 + 给
  // 一个他自己按的开关」—— 它杀的是**开机级全局单例**,外溢到用户在 ChatGPT 里的其它会话。
  // 既然那条规矩写的是「他自己按」,这道闸就得真的只让他按得动,否则那句话只是说给没在看
  // 的人听的(同 reclaim-turn 的理由)。
  /^\/api\/tasks\/[^/]+\/team\/kill-cua$/,
];

/** 导出给回归测试直接钉住:哪几条只有真人按得动。 */
export function isHumanOnlyPath(path: string): boolean {
  return HUMAN_ONLY_PATHS.some((p) => p.test(path));
}

export const HUMAN_ACTION_TOKEN_REFUSAL =
  "这个动作需要本次会话的页面凭据：请在 ash 页面上点这个开关。"
  + "凭据随页面下发、用一次就失效，刷新页面可以换一份新的";

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
    /**
     * 烧掉一份就得发下一份 —— **由这道闸发,不分成功失败**(第 5 轮审查 N2)。
     *
     * 原先是各条路由在自己的成功分支里 `[HUMAN_ACTION_TOKEN_FIELD]: issueHumanActionToken()`:
     * 消费在闸这一处、续发散在 N 条路由的 happy path 上,于是一次业务拒绝(400/409)或异常
     * (500)之后,凭据已经烧了、页面手里还攥着废号,同一个页面的下一次点击必然 403「需要页面
     * 凭据」——而那句话读起来像是开关坏了。收回这里之后,新增一条真人端点不需要记得做任何事。
     */
    let issued: string | null = null;
    const handoff = async () => {
      await next();
      if (issued) c.header(HUMAN_ACTION_TOKEN_NEXT_HEADER, issued);
    };
    // 真人专属动作先判:它**不看单人/多人**(理由见 HUMAN_ONLY_PATHS)。
    if (isHumanOnlyPath(c.req.path)) {
      const rejection = humanRequestRejection(c);
      if (rejection) return rejectHumanRequest(c, rejection);
      // **正面凭据,默认拒绝。** 上面那三段判的全是「调用方自己说了什么」:没自称 agent、
      // 没带浏览器头 —— 于是一个什么头都不带的裸请求把三段全满足了,诚实申报的 403、
      // 一言不发的 200(审查实测)。穷举「哪些头没带算可疑」救不了这个形状:少一种组合
      // 就是一个缺口。所以改成要一份**本服务自己发出去**的凭据,拿不出来就是拒绝;
      // 它的能力边界写在 human-action-token.ts 顶部,别把它当密码学边界用。
      //
      // 这几条 403 都**不发**下一份:凭据没被烧掉(或者这根本不是本人),页面手里那份还能用。
      if (!consumeHumanActionToken(c.req.header(HUMAN_ACTION_TOKEN_HEADER))) {
        return rejectHumanRequest(c, HUMAN_ACTION_TOKEN_REFUSAL);
      }
      // 核验过了盖个戳。路由拿它决定留痕的措辞 —— 别让路由自己去重读请求头推断
      // (那是第二份判据,而且推断不出「闸到底跑没跑」,见 humanActionOrigin)。
      markHumanActionVerified(c);
      issued = issueHumanActionToken();
    }
    if (!(await isMultiUser())) return handoff();
    // 只拦 agent:真人(cookie / Bearer)本来就是账号本人,匿名早被 authGate 拦掉了。
    if (actorOf(c).kind !== "agent") return handoff();
    if (!isPersonalWritePath(c.req.path)) return handoff();
    return c.json({ error: AGENT_PERSONAL_REFUSAL }, 403);
  };
}
