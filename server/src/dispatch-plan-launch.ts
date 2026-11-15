// 派活单「派出去」那一下：按卡上此刻的样子建任务、挂在这条任务名下、起跑，再把建好的清单作为答复
// 续上这条任务的会话。
//
// 「认领这一问」和「建任务」必须同进同退：认领落空（这一问已经被答掉、被新消息撤下）就一条都不建；
// 认领到了才建。所以认领塞进 createTasks 的最后一道检查（`beforeInsert`，拿到仓库锁之后、产生任何副作用
// 之前）。认领之后建任务仍可能失败（开工起点读不出来、前置成环），那时把这一问原样挂回去——卡还在，
// 用户看得到为什么没派出去，改了再按一次。
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import type { Task } from "@ash/shared";
import type { DispatchPlan, DispatchPlanItem, DispatchRunTarget } from "@ash/shared/dispatch-plan";
import { dispatchDefaultTarget, parseDispatchTarget } from "@ash/shared/dispatch-plan";
import type { QuestionRecord } from "@ash/shared/questions";
import { nanoid } from "nanoid";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { agents, groups, queueItems, tasks } from "./db/schema.js";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { visibleTaskIds } from "./auth/visibility.js";
import { batchPrerequisiteEdges } from "./prerequisite-routes.js";
import { republishPrerequisiteView } from "./prerequisite-view.js";
import { runGroupInBackground } from "./scheduler.js";
import { deliverAnswer } from "./task-answer.js";
import { requestTaskCreationOrigin } from "./task-creation-origin.js";
import { createTasks, type TaskRow } from "./task-store.js";
import { id, now, taskBody } from "./util.js";
import { launchBubble, launchReply, type LaunchPick, type TargetLabel } from "./dispatch-plan.js";
import type { AgentType } from "@ash/shared";

class PlanClaimLost extends Error {}

/** 交给谁读成一句人话：执行器名（没钉 profile 时取该类型的默认执行器名），模型、智能水平跟在后面。 */
export async function targetLabeler(): Promise<TargetLabel> {
  const profiles = await db.select({ id: agents.id, name: agents.name, type: agents.type, isDefault: agents.isDefault }).from(agents);
  return (target) => {
    const name = profiles.find((profile) => profile.id === target.executorId)?.name
      ?? profiles.find((profile) => profile.type === target.agentType && profile.isDefault)?.name
      ?? target.agentType;
    return [name, target.model, target.reasoningEffort].filter(Boolean).join(" · ");
  };
}

/** 卡上那一格的初始值：智能体指明的那个，没指明就是这条任务「派出去的活交给谁」。 */
export function proposedTarget(task: TaskRow): (item: DispatchPlanItem) => DispatchRunTarget | null {
  const fallback = dispatchDefaultTarget({
    ...task, agentType: task.agentType as AgentType | null, dispatchTarget: parseDispatchTarget(task.dispatchTarget),
  });
  return (item) => item.target ?? fallback;
}

export async function launchDispatchPlan(c: Context, task: TaskRow, plan: DispatchPlan, order: "serial" | "parallel", picks: LaunchPick[]): Promise<
  { status: 200; body: Record<string, unknown> } | { status: 400 | 404 | 409; body: { error: string } }
> {
  const label = await targetLabeler();
  const kept = new Set(picks.map((pick) => pick.index));
  const keptKeys = new Set(picks.map((pick) => plan.items[pick.index]!.key).filter(Boolean));
  const droppedKeys = new Set(plan.items.filter((item, index) => item.key && !kept.has(index)).map((item) => item.key!));
  const ids = picks.map(() => id());
  // 前置：同一批里用 key 指的照旧认；指向被去掉的那几条的一并划掉（那一条没建，不是「已有的任务」）。
  const specs = picks.map((pick) => {
    const item = plan.items[pick.index]!;
    return { key: item.key, prerequisites: item.prerequisites?.filter((ref) => !droppedKeys.has(ref) || keptKeys.has(ref)) };
  });
  const prerequisites = batchPrerequisiteEdges(specs, ids);
  if (typeof prerequisites === "string") return { status: 400, body: { error: prerequisites } };
  const visible = new Set(await visibleTaskIds(actorOf(c), prerequisites.existing));
  const hidden = prerequisites.existing.find((taskId) => !visible.has(taskId));
  if (hidden) return { status: 404, body: { error: `前置任务 ${hidden} 不存在` } };

  const owner = ownerIdOf(actorOf(c));
  const creationOrigin = await requestTaskCreationOrigin(c);
  const groupId = id();
  // 一条以上才谈得上「一个接一个」：单独一条的串行组没有队列，调度会退化成并行还打一句警告。
  const groupMode = picks.length > 1 ? order : "parallel";
  const base = Date.now();
  const rows = picks.map((pick, at) => {
    const item = plan.items[pick.index]!;
    const ts = new Date(base + at).toISOString();
    return {
      id: ids[at]!, creationOrigin, projectId: task.projectId, groupId, parentId: null as string | null,
      title: item.title, body: taskBody(item.body, ids[at]!), mode: "single", status: "backlog",
      labels: JSON.stringify(item.labels ?? []), dependsOn: "[]", resumeDependsOn: "[]",
      agentType: pick.target.agentType, executorId: pick.target.executorId,
      model: pick.target.model, reasoningEffort: pick.target.reasoningEffort,
      autoTitle: false, duet: null as string | null, scheduleId: null as string | null, createdAt: ts, updatedAt: ts,
      useWorktree: item.useWorktree, worktreeBase: item.worktreeBase ?? null, mergeTargetBranch: item.mergeTargetBranch ?? null,
      workflowMode: "free", ownerUserId: owner, dispatchedBy: task.id,
    };
  });
  const dropped = plan.items.filter((_item, index) => !kept.has(index));
  const launched = rows.map((row, at) => ({ id: row.id, title: row.title, target: picks[at]!.target }));
  const record: QuestionRecord = {
    question: task.question, questionOptions: null, questionItems: null,
    id: nanoid(12), answeredAt: now(),
    answer: launchBubble(plan, order, picks, proposedTarget(task), label),
    reply: launchReply(order, launched, dropped, label),
  };

  await db.insert(groups).values({ id: groupId, projectId: task.projectId, name: `派出：${task.title}`.slice(0, 80), mode: groupMode, paused: false, createdAt: now() });
  let created: Task[] = [];
  let claimed = false;
  let delivered;
  try {
    delivered = await deliverAnswer(c, task, record, {
      claim: async (claimOnce) => {
        try {
          created = await createTasks(rows, groupMode === "serial"
            ? async () => {
              const at = now();
              const queueId = id();
              await db.insert(queueItems).values(ids.map((taskId, position) => ({ taskId, queueId, position, createdAt: at })));
            }
            : undefined, async () => {
            claimed = await claimOnce();
            if (!claimed) throw new PlanClaimLost();
          }, [], prerequisites.edges);
          return true;
        } catch (error) {
          if (error instanceof PlanClaimLost) return false;
          if (claimed) await restoreQuestion(task, record);
          throw error;
        }
      },
    });
  } catch (error) {
    await db.delete(groups).where(eq(groups.id, groupId)).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    return { status: 409, body: { error: `没能派出去：${message}` } };
  }
  if (delivered.status !== 200) {
    await db.delete(groups).where(eq(groups.id, groupId)).catch(() => {});
    return { status: 409, body: { error: String(delivered.body.error ?? "派活单已经变了，请刷新后再看") } };
  }
  if (prerequisites.existing.length) await republishPrerequisiteView(prerequisites.existing);
  void runGroupInBackground(groupId);
  return { status: 200, body: { ...delivered.body, launched: true, groupId, tasks: created } };
}

/**
 * 认领之后没建成：把这一问原样挂回去（条件写：此刻仍是认领后的那一刻，没有别人又动过）。
 * 卡回到回复框上，用户看得到失败原因，改了再按一次。
 */
async function restoreQuestion(task: TaskRow, record: QuestionRecord): Promise<void> {
  const history: QuestionRecord[] = task.questionHistory ? JSON.parse(task.questionHistory) : [];
  const restored = await db.update(tasks).set({
    question: task.question, questionOptions: task.questionOptions, questionItems: task.questionItems,
    dispatchPlan: task.dispatchPlan, questionHistory: task.questionHistory, updatedAt: now(),
  }).where(and(
    eq(tasks.id, task.id), isNull(tasks.question),
    eq(tasks.questionHistory, JSON.stringify([...history, record])),
  )).returning({ updatedAt: tasks.updatedAt });
  if (!restored.length) return;
  const plan = task.dispatchPlan ? JSON.parse(task.dispatchPlan) as DispatchPlan : null;
  bus.publish({
    type: "task.question", taskId: task.id, updatedAt: restored[0]!.updatedAt, question: task.question,
    questionOptions: null, questionItems: null, dispatchPlan: plan,
  });
}
