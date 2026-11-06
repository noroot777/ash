// 「验收合并了」「门禁出结果了」这两类通知的生产判据（设置页「完成也推」的承诺）。
//
// 不看决策卡：飞书上点验收成功时，那张待验收卡先被按钮的结果收起（actions.ts），对账再来时卡已经
// 不在打开状态，以卡为判据就一条也发不出（审查实测）；门禁的结果更可能根本没有对应的卡。所以每个
// 任务记一份「上次对账看到的结局」（im_outcomes），对账时现算一遍，变了就发一条新消息 —— 原地改卡
// 在手机上不会提醒。
//   result  验收合并的是哪一版成果（task-result-version.ts）；没验收是 "-"
//   gate    最近一次跑出结果（通过 / 没通过）的那一次门禁；被打断、取消的不算结果
// 第一次看到一个任务只记下现状不发：刚绑定、刚升级时不把历史结局补推一遍。「任务完成」那一下由
// 待验收卡本身负责（新卡就是一条新消息），这里不重复发。
import { isAcceptedStage } from "@ash/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { acceptGateRuns } from "../db/schema-accept-gate.js";
import { imOutcomes } from "../db/schema-im.js";
import type { ConclusionTransaction } from "../regression-conclusion-commit.js";
import { resultVersionOf } from "../task-result-version.js";
import { now } from "../util.js";
import type { TaskView } from "./attention.js";
import { scrubTitle } from "./scrub.js";

type OutcomeKind = "result" | "gate";
const NONE = "-";

/** 一样结局此刻的值，和它变成这个值时该发的那句话（null = 变成这样不用告诉人，比如摘牌回到没验收）。 */
export interface Outcome { kind: OutcomeKind; value: string; text: string | null }

export async function outcomesOf(view: TaskView): Promise<Outcome[]> {
  const task = view.task;
  const title = `「${scrubTitle(task.title)}」`;
  const run = (await db.select({ id: acceptGateRuns.id, status: acceptGateRuns.status }).from(acceptGateRuns)
    .where(and(eq(acceptGateRuns.taskId, task.id), inArray(acceptGateRuns.status, ["passed", "failed"])))
    .orderBy(desc(acceptGateRuns.startedAt)).limit(1)).at(0);
  // 门禁在前：绿了紧接着自动合并时，两条按事情发生的先后发。
  return [
    run
      ? { kind: "gate", value: `${run.id}:${run.status}`,
        text: run.status === "passed" ? `验收前置命令通过了：${title}` : `验收前置命令没通过：${title}，详情回 ash 看。` }
      : { kind: "gate", value: NONE, text: null },
    isAcceptedStage(task.stage)
      ? { kind: "result", value: `accepted:${await resultVersionOf(task)}`, text: `已验收合并：${title}` }
      : { kind: "result", value: NONE, text: null },
  ];
}

/** 账上已经是此刻的样子（绝大多数对账都是这样）：不必开事务、不必找收件人。 */
export async function outcomesRecorded(appId: string, taskId: string, current: Outcome[]): Promise<boolean> {
  const known = new Map((await db.select().from(imOutcomes)
    .where(and(eq(imOutcomes.appId, appId), eq(imOutcomes.taskId, taskId)))).map((row) => [row.kind, row.value]));
  return current.every((outcome) => known.get(outcome.kind) === outcome.value);
}

/**
 * 把账改成此刻的样子，返回比账上变了、且该告诉人的那几样。账上还没有这个任务 = 第一次看到：只记不发。
 * tx：和通知入队放进同一个事务 —— 记了账就一定入了队，重复对账不会再发一遍。
 */
export async function advanceOutcomes(tx: ConclusionTransaction, appId: string, taskId: string, current: Outcome[]): Promise<Outcome[]> {
  const known = new Map((await tx.select().from(imOutcomes)
    .where(and(eq(imOutcomes.appId, appId), eq(imOutcomes.taskId, taskId)))).map((row) => [row.kind, row.value]));
  const changed: Outcome[] = [];
  for (const outcome of current) {
    const before = known.get(outcome.kind);
    if (before === outcome.value) continue;
    await tx.insert(imOutcomes).values({ appId, taskId, kind: outcome.kind, value: outcome.value, updatedAt: now() })
      .onConflictDoUpdate({ target: [imOutcomes.appId, imOutcomes.taskId, imOutcomes.kind], set: { value: outcome.value, updatedAt: now() } });
    if (known.size && outcome.text) changed.push(outcome);
  }
  return changed;
}

/** 任务删了：账一起清掉。 */
export async function forgetOutcomes(appId: string, taskId: string): Promise<void> {
  await db.delete(imOutcomes).where(and(eq(imOutcomes.appId, appId), eq(imOutcomes.taskId, taskId)));
}
