// 「还没收干净的 agent 后代」的**两条端点**:披露面,以及用户自己按的重试入口。
//
// 从 routes.ts 搬出来有两个理由:那份已经贴着 700 行上限;而这两条端点的授权依据和披露
// 语义都得写清楚(下面两段),塞在那份里只会被当成又一条路由扫过去。清理结论本体住在
// `executors/cleanup-debt.ts` 和 `agent_cleanup_debts` 那张表的注释里,这里只管
// 「谁能看、谁能按」。
//
// ── 为什么要有这一面 ──────────────────────────────────────────────────────────
//
// 根约定「停止/暂停必须留下持久可见的状态」的同一条判据:刷新页面之后仍然看得出「有东西
// 没收掉」。重试之所以要一个显式入口而不只靠开机清扫:macOS 上记号只给得出 `suspected`
// (看得见、给不出落点),那种残留要等用户自己处置或者进程自己退出 —— 让他能当场再问一次,
// 比让他重启整个服务才知道结果强。这一问**只读 + 下刀只打这一刻证明过的成员**。
//
// ── 授权:两条合起来 ─────────────────────────────────────────────────────────
//
// **实例管理员**(`isAdminActor`,自用模式恒真)**而且账号本人**(`isAccountHolder`)。
//
//  · 少前一条就是第 2 轮审查 F2 实测的那一下:挂真实认证中间件,普通成员读到了别人任务的
//    taskId/sessionId,还能对全实例发起清扫(Linux 的 `ours` 档那一轮是真发信号的)。认证
//    中间件只负责「登录了没有」,资源授权是每条端点自己的义务。
//  · 少后一条就等于把这条路开给了回合凭证:agent 的 actor 带的是它那条任务 owner 的 role,
//    owner 是管理员时它就跟着成了管理员,于是任意一个正在跑的 agent 都能对全实例发起清扫
//    (判据同 `auth/context.ts` 里 `isAccountHolder` 那段:它的权限只到自己那条任务)。
//
// 为什么不是「只看自己的任务」:落账那一刻拿不到 taskId/sessionId(清理发生在
// `cleanupAfterRun`,那里只有一个 ChildProcess),库里那两列现在是空的 —— 按空值推断归属
// 等于把所有人的账都算成自己的。等那两列真填上了再按可见任务逐笔授权,**在那之前不开个人
// 入口**。读写两端一起判,不许只保护写端。
import type { Hono } from "hono";
import { actorOf, isAccountHolder, isAdminActor } from "./auth/context.js";

const denyCleanupDebts = (c: Parameters<typeof actorOf>[0]): { error: string } | null => {
  const actor = actorOf(c);
  if (isAccountHolder(actor) && isAdminActor(actor)) return null;
  return {
    error: "「没收干净的 agent 后代」只对实例管理员本人开放:"
      + "它是全实例的、不按任务过滤,而且重试会真的发信号",
  };
};

export function mountCleanupDebtRoutes(api: Hono): void {
  api.get("/cleanup-debts", async (c) => {
    const denied = denyCleanupDebts(c);
    if (denied) return c.json(denied, 403);
    // **收档的那几笔也要给**:收档是「能追的都追到头了」,不是「它走了」—— 握着那个 inode
    // 的进程可能还在写。按 closedAt 过滤掉它们,在披露面上跟销账长得一模一样(本轮 N2)。
    const { listAllCleanupDebts, pendingCleanupNoteCount } = await import("./executors/cleanup-debt.js");
    const listing = await listAllCleanupDebts();
    // 读失败**不许长成空列表**(第 2 轮审查 N3):那会让披露面在数据库出问题时安静地显示
    // 「干净」。
    if (!listing.ok) return c.json({ error: `这一问没答出来:${listing.reason}` }, 503);
    // **只在内存里扛着的那几笔也要说出来**(第 4 轮审查 N2):库里的行是「落过盘的责任」,
    // 而落库失败、或者连交接层都没加载起来的那几笔只活在本进程内 —— 它们跨不过重启。
    // 上一版这个端点只返回库内行,于是「INSERT 失败但 SELECT 正常」时披露面显示干干净净,
    // 正是这张表存在的理由要防的那件事。两个计数分开给,因为它们是两段路(见 sweep 的注释)。
    const { undeliveredCleanupDebtCount } = await import("./executors/cleanup-handoff.js");
    return c.json({
      debts: listing.debts,
      pendingNotes: pendingCleanupNoteCount(),
      undelivered: undeliveredCleanupDebtCount(),
    });
  });

  api.post("/cleanup-debts/sweep", async (c) => {
    const denied = denyCleanupDebts(c);
    if (denied) return c.json(denied, 403);
    const { sweepAgentCleanupDebts } = await import("./executors/cleanup-debt.js");
    const swept = await sweepAgentCleanupDebts();
    // 同上:0/0/0 跟「扫完了,一笔都没有」长得一样,所以问不出来就得说问不出来。
    if (!swept.ok) return c.json({ error: `这一轮没能确认:${swept.reason}` }, 503);
    return c.json(swept);
  });
}
