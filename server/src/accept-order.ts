// 验收确认层两勾的记忆、项目设置「合并后提交」：**后到的那一次确认算数**。
//
// 只做「单条语句原子」不够（第 2 轮审查 F1，真实 HTTP + SQLite 复现过）：浏览器等记忆等到超时就放弃、
// 接着去验收，但放弃等待不是取消 —— 服务端那一下还卡在数据库写锁后面，用户又确认了一次，新的先落库，
// 旧的随后醒来照写，下次打开就成了上一次的选择。所以每个写请求**一到就取号**（第一个 await 之前），
// 写的时候跟库里那一笔的号比：比它早到的不写。号和值在同一笔事务里读写，谁先抢到写锁都一样。
//
// 号是「到达时刻（微秒）」，同一微秒内顺延一位；启动时用库里已有的最大号垫底，时钟往回校再重启也不回头
// （db/arrival-seq.ts；单实例，见 singleton.ts）。
// 写入方只有两处，都经这里：确认层（accept-memory.ts）和设置页（project-routes.ts PATCH）。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { nextArrivalSeq } from "./db/arrival-seq.js";
import { acceptCommitOrder, projects } from "./db/schema.js";

export type OrderTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 这个请求的到达序号。必须在 handler 的第一个 await 之前取：之后的先后已经由写锁说了算，不是到达顺序。 */
export const arrivalSeq = nextArrivalSeq;

/**
 * 按到达顺序写项目的「合并后提交」。比库里那一笔早到的不写（返回 null，那个更新的选择留着）；
 * 写了就返回值变没变（变了才该推 project.updated）。项目不在也返回 null。
 */
export async function writeAcceptCommit(tx: OrderTx, projectId: string, value: boolean, seq: number): Promise<{ changed: boolean } | null> {
  const order = (await tx.select({ seq: acceptCommitOrder.seq }).from(acceptCommitOrder).where(eq(acceptCommitOrder.projectId, projectId))).at(0);
  if (order && order.seq >= seq) return null;
  const before = (await tx.select({ acceptCommit: projects.acceptCommit }).from(projects).where(eq(projects.id, projectId))).at(0);
  if (!before) return null;
  if (before.acceptCommit !== value) await tx.update(projects).set({ acceptCommit: value }).where(eq(projects.id, projectId));
  await tx.insert(acceptCommitOrder).values({ projectId, seq }).onConflictDoUpdate({ target: acceptCommitOrder.projectId, set: { seq } });
  return { changed: before.acceptCommit !== value };
}
