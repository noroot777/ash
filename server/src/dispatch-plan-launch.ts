// 派活单「派出去」那一下：按卡上此刻的样子建任务、挂在这条任务名下、交给调度，再把建好的清单作为答复
// 续上这条任务的会话。
//
// 一张单至多建一批，建了就一定有人去跑、有人把清单送回会话。所以「欠着的事」跟建任务同一笔提交
// （createTasks 的 `atomic`）：认领那一问、分组、任务、前置、串行队列，加上
//   · 答复：写成一条待发送消息（执行型，带答复身份），由待发送托盘送进会话——它本来就扛重启、扛「回合被
//     占着」「同队前项还在跑」，这里不再自己 continueTask；
//   · 起跑：派活单不记自己的账、也没有自己的起跑入口。该开工的那几条（同时：每一条；一个接一个：队首，后面的由
//     队列推进）各挂一笔开工请求（launch-request.ts，跟一切自动开工同一份账）——没有前置就立刻就齐。放行、
//     同组名额、停止撤回、重启补办全是那一套。
// 任何一步失败整笔回滚：单子原样还在，一条任务都没留下，再按一次不会多建；认领落空同样整笔不落。所以没有
// 「失败了把单子挂回去」的补偿写。开工起点这类仓库准备在事务之前做，失败时还没认领。
//
// 提交之后剩下的只是「让人看见」和「催一下」（读回、广播、通知派它的任务、前置视图、催一下起跑与投递），
// 每一步各自兜底、互不挡路：任何一步抛错都不改变「已经派出」这个结果，也不挡后面的起跑。
import type { Context } from "hono";
import type { DispatchPlan, DispatchPlanItem, DispatchRunTarget } from "@ash/shared/dispatch-plan";
import { dispatchDefaultTarget, parseDispatchTarget } from "@ash/shared/dispatch-plan";
import type { QuestionRecord } from "@ash/shared/questions";
import { nanoid } from "nanoid";
import { db } from "./db/index.js";
import { agents, groups, queueItems, scheduledMessages } from "./db/schema.js";
import { bus } from "./bus.js";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { visibleTaskIds } from "./auth/visibility.js";
import { batchPrerequisiteEdges } from "./prerequisite-routes.js";
import { republishPrerequisiteView } from "./prerequisite-view.js";
import { requestLaunch, sweepLaunchRequests } from "./launch-request.js";
import { answerRouteFor } from "./task-answer.js";
import { claimQuestionAnswerWithin, type QuestionClaim } from "./task-question-record.js";
import { deliverPendingMessages, pendingMessageRow, publishPendingMessages } from "./pending-messages.js";
import { requestTaskCreationOrigin } from "./task-creation-origin.js";
import { createTasks, type TaskRow } from "./task-store.js";
import { id, now, taskBody } from "./util.js";
import { launchBubble, launchReply, serialOrderConflict, type LaunchPick, type TargetLabel } from "./dispatch-plan.js";
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
  // 卡上可以把「同时」改成「一个接一个」：照这个顺序排队会互相等住的，单子原样留着、说清楚，不建。
  const deadlock = groupMode === "serial"
    ? serialOrderConflict(picks.map((pick, at) => ({ title: plan.items[pick.index]!.title, ...specs[at]! })))
    : null;
  if (deadlock) return { status: 409, body: { error: `${deadlock}。改成「同时」再派，或者发回去让它调整顺序` } };
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

  const delivery = await answerRouteFor(task);
  if (delivery.origin.kind !== "ordinary") return { status: 409, body: { error: "这张派活单不是在普通回合里摆的，派不出去，请刷新后再看" } };
  const answer = pendingMessageRow({
    taskId: task.id, text: record.reply, ...delivery.route, ownerUserId: owner, answerId: record.id, execution: !delivery.sideways,
  });
  let claim: QuestionClaim | null = null;
  let committed = false;
  try {
    await createTasks(rows, undefined, undefined, [], prerequisites.edges, {
      before: async (transaction) => {
        claim = await claimQuestionAnswerWithin(transaction, task, record);
        if (!claim) throw new PlanClaimLost();
        await transaction.insert(groups).values({
          id: groupId, projectId: task.projectId, name: `派出：${task.title}`.slice(0, 80), mode: groupMode, paused: false, createdAt: now(),
        });
      },
      after: async (transaction) => {
        const at = now();
        if (groupMode === "serial") {
          const queueId = id();
          await transaction.insert(queueItems).values(ids.map((taskId, position) => ({ taskId, queueId, position, createdAt: at })));
        }
        await transaction.insert(scheduledMessages).values(answer);
        const starters = groupMode === "serial" ? ids.slice(0, 1) : ids;
        await requestLaunch(starters, { source: "run", actingUserId: owner }, transaction);
      },
      onCommitted: () => { committed = true; },
    });
  } catch (error) {
    if (error instanceof PlanClaimLost) return { status: 409, body: { error: "派活单已经变了（答过了或被新消息撤下），请刷新后再看" } };
    if (!committed) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 409, body: { error: `没能派出去：${message}` } };
    }
    console.error(`[ash] 派活单已派出，读回或广播新任务时出错 ${task.id}:`, error);
  }

  // —— 提交之后：只剩「让人看见」和「催一下」，各自兜底。
  const settle = (what: string, work: () => unknown) => {
    try {
      void Promise.resolve(work()).catch((error) => console.error(`[ash] 派活单已派出，${what}出错 ${task.id}:`, error));
    } catch (error) {
      console.error(`[ash] 派活单已派出，${what}出错 ${task.id}:`, error);
    }
  };
  settle("通知派它的任务", () => (claim as QuestionClaim | null)?.announce());
  settle("广播收卡", () => bus.publish({
    type: "task.question", taskId: task.id, updatedAt: record.answeredAt, question: null, questionOptions: null, questionItems: null, answeredQuestion: record,
  }));
  settle("送答复", () => { publishPendingMessages(task.id); return deliverPendingMessages(task.id); });
  if (prerequisites.existing.length) settle("刷新前置视图", () => republishPrerequisiteView(prerequisites.existing));
  // 不等下一次扫描：挂着的请求当场判一遍，齐了、有名额的就起（错过了还有开机补办和每分钟那一扫）。
  settle("催起跑", () => sweepLaunchRequests());
  return {
    status: 200,
    body: { launched: true, answered: true, groupId, record, tasks: launched.map(({ id: taskId, title }) => ({ id: taskId, title })) },
  };
}
