// 派活单「派出去」那一下：按卡上此刻的样子建任务、挂在这条任务名下、起跑，再把建好的清单作为答复
// 续上这条任务的会话。
//
// 「认领这一问」和「建任务」同一笔提交：认领那一问、分组、任务、前置、串行队列都写在 createTasks 的同一个
// 事务里（`atomic`），任何一步失败整笔回滚——单子原样还在，一条任务都没留下，再按一次不会多建；认领落空
// （这一问已经被答掉、被新消息撤下）同样整笔不落。所以这里**没有**「失败了把单子挂回去」的补偿写：挂回去
// 得证明这一格还归我管，而事务回滚让单子从头到尾就没被拿走过。开工起点这类仓库准备在事务之前做，失败时
// 还没认领。事务提交之后的事（读回、广播、续上会话、起跑）出了错，任务已经建好了，照「派出了」报。
import { inArray } from "drizzle-orm";
import type { Context } from "hono";
import type { Task } from "@ash/shared";
import type { DispatchPlan, DispatchPlanItem, DispatchRunTarget } from "@ash/shared/dispatch-plan";
import { dispatchDefaultTarget, parseDispatchTarget } from "@ash/shared/dispatch-plan";
import type { QuestionRecord } from "@ash/shared/questions";
import { nanoid } from "nanoid";
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

  let created: Task[] = [];
  // 事务提交了没有，以库里有没有这批任务为准（提交之后的读回、广播抛错时用它分辨）。
  const landed = async () => (await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, ids)).catch(() => [])).length > 0;
  let delivered;
  try {
    delivered = await deliverAnswer(c, task, record, {
      claim: async (claimWithin) => {
        try {
          created = await createTasks(rows, undefined, undefined, [], prerequisites.edges, {
            before: async (transaction) => {
              if (!await claimWithin(transaction)) throw new PlanClaimLost();
              await transaction.insert(groups).values({
                id: groupId, projectId: task.projectId, name: `派出：${task.title}`.slice(0, 80), mode: groupMode, paused: false, createdAt: now(),
              });
            },
            after: groupMode === "serial"
              ? async (transaction) => {
                const at = now();
                const queueId = id();
                await transaction.insert(queueItems).values(ids.map((taskId, position) => ({ taskId, queueId, position, createdAt: at })));
              }
              : undefined,
          });
          return true;
        } catch (error) {
          if (error instanceof PlanClaimLost) return false;
          if (!await landed()) throw error;
          console.error(`[ash] 派活单已派出，读回新任务时出错 ${task.id}:`, error);
          return true;
        }
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!await landed()) return { status: 409, body: { error: `没能派出去：${message}` } };
    // 任务已经建好、认领也落了，是续上会话那一段出的错：照派出了报，组照常起跑。
    console.error(`[ash] 派活单已派出，续上会话时出错 ${task.id}:`, error);
    void runGroupInBackground(groupId);
    return { status: 200, body: { launched: true, groupId, tasks: created, warning: `任务已派出，但续上会话时出错：${message}` } };
  }
  if (delivered.status !== 200) {
    return { status: 409, body: { error: String(delivered.body.error ?? "派活单已经变了，请刷新后再看") } };
  }
  if (prerequisites.existing.length) await republishPrerequisiteView(prerequisites.existing);
  void runGroupInBackground(groupId);
  return { status: 200, body: { ...delivered.body, launched: true, groupId, tasks: created } };
}
