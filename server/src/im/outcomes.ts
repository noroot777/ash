// 「验收了」「门禁出结果了」这两类通知的生产判据（设置页「完成也推」的承诺）。
//
// 不看决策卡：飞书上点验收成功时，那张待验收卡先被按钮的结果收起（actions.ts），对账再来时卡已经
// 不在打开状态，以卡为判据就一条也发不出（审查实测）；门禁的结果更可能根本没有对应的卡。所以每个
// 任务记一份「上次对账看到的结局」（im_outcomes），对账时现算一遍，变了就发一条新消息 —— 原地改卡
// 在手机上不会提醒。
//   result  最近一次验收的身份：tasks.acceptance_id（每次真落章领一个，摘牌挂回随快照回来）。不拿成果
//           版本（结束时刻）当身份：验收之后问一句、跑一次合并结果审查，结束时刻都会变，会把同一次验收
//           再推一遍（对抗复核实测）；也不拿合并事实：就地、只标记的那几档前后两次真验收落下的事实一模
//           一样，第二次就推不出来（审查第 2 轮实测）。加列之前的老验收没有 id，才回落到合并事实。牌子
//           摘下的那段时间不记 —— 这一轮没改东西、原样挂回来的还是同一次验收，不算新的。
//   gate    最近一次跑出结果（通过 / 没通过）的那一次门禁；被打断、取消的不算结果
//   review  自由工作流最近一条工作区审查链通过了（哪一条）。审查不改任务状态：失败、取消、暂停着的任务也能派审，
//           通过时没有待验收卡可以带上这句话，所以单独记一笔。待验收卡已经写着「审查通过」的不重复发；任务还在跑
//           （审查回合本身、结算还没落回原状态）时先不记通过，落定了再看。这一样是后来加的：账上还没有它的
//           老任务第一次看到只记不发，不把历史上的通过补推一遍
// 第一次看到一个任务只记下现状不发：刚绑定、刚升级时不把历史结局补推一遍。「任务完成」那一下由
// 待验收卡本身负责（新卡就是一条新消息），这里不重复发。
// 事件丢了（重启、通道重启正好落在对账前）由全量对账按「账和现状对不上」补（staleOutcomeTasks）。
import { isAcceptedStage, type TaskStage } from "@ash/shared";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { acceptGateRuns } from "../db/schema-accept-gate.js";
import { freeReviewRuns } from "../db/schema-free-workflow.js";
import { imOutcomes } from "../db/schema-im.js";
import { tasks } from "../db/schema.js";
import type { ConclusionTransaction } from "../regression-conclusion-commit.js";
import { now } from "../util.js";
import type { TaskView } from "./attention.js";
import { acceptedLabel } from "./cards.js";
import { scrubTitle } from "./scrub.js";

type OutcomeKind = "result" | "gate" | "review";
const NONE = "-";

/** 这一次验收的身份（db/schema.ts acceptanceId）；加列之前的老验收没有，按落章时写下的那几样合并事实认。 */
const acceptanceIdentity = sql<string>`CASE WHEN ${tasks.acceptanceId} IS NOT NULL THEN 'acceptance:' || ${tasks.acceptanceId}
  ELSE 'accepted:' || coalesce(${tasks.acceptedSourceCommit}, '') || '|' || coalesce(${tasks.acceptedTargetBranch}, '')
  || '|' || coalesce(${tasks.acceptedBaseCommit}, '') || '|' || coalesce(${tasks.acceptedMergeCommit}, '')
  || '|' || coalesce(${tasks.acceptedMergeMethod}, '') || '|' || coalesce(${tasks.acceptedGateRunId}, '') END`;
/** 最近一次跑出结果的门禁，跟 outcomesOf 里那一份同一个口径。 */
const latestGate = sql<string>`coalesce((SELECT r.id || ':' || r.status FROM accept_gate_runs r
  WHERE r.task_id = ${imOutcomes.taskId} AND r.status IN ('passed', 'failed') ORDER BY r.started_at DESC LIMIT 1), '-')`;

/** 最近一条工作区审查链通过了就是「那一条:passed」，否则 "-"。跟 outcomesOf 里那一份同一个口径。 */
const latestReview = sql<string>`coalesce((SELECT CASE WHEN r.status = 'passed' THEN r.id || ':passed' ELSE '-' END FROM free_review_runs r
  WHERE r.task_id = ${imOutcomes.taskId} AND r.target_kind = 'workspace' ORDER BY r.created_at DESC LIMIT 1), '-')`;

/** 一样结局此刻的值，和它变成这个值时该发的那句话（null = 变成这样不用告诉人）。没验收时不出 result 这一样。 */
export interface Outcome { kind: OutcomeKind; value: string; text: string | null }

export async function outcomesOf(view: TaskView): Promise<Outcome[]> {
  const task = view.task;
  const title = `「${scrubTitle(task.title)}」`;
  const run = (await db.select({ id: acceptGateRuns.id, status: acceptGateRuns.status }).from(acceptGateRuns)
    .where(and(eq(acceptGateRuns.taskId, task.id), inArray(acceptGateRuns.status, ["passed", "failed"])))
    .orderBy(desc(acceptGateRuns.startedAt)).limit(1)).at(0);
  // 牌子和身份同一条语句现读，不拿视图快照里的 stage 配后读的身份：两次读之间摘了牌，配出来的是一个谁都不是的身份。
  const accepted = isAcceptedStage(task.stage)
    ? (await db.select({
      stage: tasks.stage, identity: acceptanceIdentity,
      acceptedMergeMethod: tasks.acceptedMergeMethod, acceptedMergeCommit: tasks.acceptedMergeCommit,
    }).from(tasks).where(eq(tasks.id, task.id))).at(0)
    : undefined;
  // 门禁在前：绿了紧接着自动合并时，两条按事情发生的先后发。
  return [
    ...await reviewOutcome(view, title),
    run
      ? { kind: "gate", value: `${run.id}:${run.status}`,
        text: run.status === "passed" ? `验收前置命令通过了：${title}` : `验收前置命令没通过：${title}，详情回 ash 看。` }
      : { kind: "gate", value: NONE, text: null },
    ...(accepted && isAcceptedStage(accepted.stage as TaskStage | null)
      ? [{ kind: "result" as const, text: `${acceptedLabel(accepted)}：${title}`, value: accepted.identity }] : []),
  ];
}

async function reviewOutcome(view: TaskView, title: string): Promise<Outcome[]> {
  const task = view.task;
  if (task.workflowMode !== "free" || task.mode !== "single" || task.parentId) return [];
  const run = (await db.select({ id: freeReviewRuns.id, status: freeReviewRuns.status }).from(freeReviewRuns)
    .where(and(eq(freeReviewRuns.taskId, task.id), eq(freeReviewRuns.targetKind, "workspace")))
    .orderBy(desc(freeReviewRuns.createdAt)).limit(1)).at(0);
  if (run?.status !== "passed") return [{ kind: "review", value: NONE, text: null }];
  if (task.status === "running" || task.status === "queued" || task.status === "awaiting_review") return [];
  const onCard = view.turn?.kind === "accept" && view.turn.reviewPassed;
  return [{ kind: "review", value: `${run.id}:passed`, text: onCard ? null : `审查通过：${title}` }];
}

/**
 * 账和现状对不上的任务（全量对账带上它们）：已验收、账上却不是这一次验收的；最近一次门禁结果跟账上不同的。
 * 已验收的任务不在全量对账的常规候选里，那一次事件丢了就再没人来对。
 */
export async function staleOutcomeTasks(appId: string): Promise<string[]> {
  const accepted = await db.select({ id: tasks.id }).from(tasks).where(and(
    eq(tasks.archived, false), inArray(tasks.stage, ["accepted", "merged"]),
    sql`NOT EXISTS (SELECT 1 FROM im_outcomes o WHERE o.app_id = ${appId} AND o.task_id = ${tasks.id}
      AND o.kind = 'result' AND o.value = ${acceptanceIdentity})`,
  ));
  const gates = await db.select({ id: imOutcomes.taskId }).from(imOutcomes)
    .where(and(eq(imOutcomes.appId, appId), eq(imOutcomes.kind, "gate"), ne(imOutcomes.value, latestGate)));
  const reviews = await db.select({ id: imOutcomes.taskId }).from(imOutcomes)
    .where(and(eq(imOutcomes.appId, appId), eq(imOutcomes.kind, "review"), ne(imOutcomes.value, latestReview)));
  return [...new Set([...accepted, ...gates, ...reviews].map((row) => row.id))];
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
    // review 是后来加的一样：账上没有它 = 老任务第一次记这一笔，只记不发（文件头）。
    if (known.size && outcome.text && !(before === undefined && outcome.kind === "review")) changed.push(outcome);
  }
  return changed;
}

/** 任务删了：账一起清掉。 */
export async function forgetOutcomes(appId: string, taskId: string): Promise<void> {
  await db.delete(imOutcomes).where(and(eq(imOutcomes.appId, appId), eq(imOutcomes.taskId, taskId)));
}
