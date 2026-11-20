// 用户按「派出去」那一下：照那几行此刻的样子（改过的标题、说明、换过的人、开工起点、补的那句话）建普通任务，
// 挂在这条任务名下，交给调度。同一笔事务里（createTasks 的 `atomic`）：认领那几件、等着的那一批处理完时认领那一问
// （dispatch-suggestion-resolve.ts）、建分组、任务、前置、串行队列，加上每条该开工的挂一笔开工请求（launch-request.ts，
// 跟一切自动开工同一份账：同时 = 每一条，一个接一个 = 队首，后面的由队列推进）。任何一步失败整笔回滚：那几件原样
// 还在，一条任务都没留下，再按一次不会多建；认领落空同样整笔不落。开工起点这类仓库准备在事务之前做。
//
// 不等的那几件派出去，这条任务的智能体不被叫醒，所以它在跑时也照派；会话里那一句「开了新任务」由页面从任务列表里
// 认（web/src/task-detail/dispatchNotes.ts：dispatchedBy 指向这条、创建来源是用户）。等着的那一批处理完时按它说定的
// 那一档收尾：done 结成完成、不叫醒（欠账跟处理完同一笔落库，怎么还见 dispatch-suggestion-settle.ts）；continue 把清单
// 作为答复续上会话。
import type { Context } from "hono";
import { suggestionTaskBody, type StoredSuggestion } from "@navi/shared/dispatch-suggestion";
import { db } from "./db/index.js";
import { groups, queueItems } from "./db/schema.js";
import { actorOf } from "./auth/context.js";
import { visibleTaskIds } from "./auth/visibility.js";
import { batchPrerequisiteEdges } from "./prerequisite-routes.js";
import { republishPrerequisiteView } from "./prerequisite-view.js";
import { requestLaunch, sweepLaunchRequests } from "./launch-request.js";
import { requestTaskCreationOrigin } from "./task-creation-origin.js";
import { createTasks, type TaskRow } from "./task-store.js";
import { bindUploadsToTask } from "./uploads.js";
import { readSuggestions, scopedKey } from "./dispatch-suggestion.js";
import { launchedSettings, serialOrderConflict, type LaunchRequest } from "./dispatch-suggestion-input.js";
import { proposedTarget, targetLabeler } from "./dispatch-suggestion-wait.js";
import {
  afterResolved, prepareResolve, resolveWithin, SuggestionClaimLost, SuggestionConflict, type Resolved,
} from "./dispatch-suggestion-resolve.js";
import { attachmentsPrompt, id, now, taskBody } from "./util.js";

type Outcome =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 404 | 409; body: { error: string; missing?: string[] } };

/**
 * 前置：同一批里用 key 指的，被等的那一件也在这一下里就照 key 认；还挂着却没一起派的，拒（要它的代码就得一起派，
 * 或者先把它点叉）；不是同批 key 的就是已有的任务 id（同批被等的那件早先派出去时已经换成了它的任务 id）。
 */
function prerequisiteSpecs(picked: StoredSuggestion[], all: StoredSuggestion[]): { key?: string; prerequisites?: string[] }[] | string {
  const chosen = new Set(picked.map((item) => item.id));
  const specs: { key?: string; prerequisites?: string[] }[] = [];
  for (const item of picked) {
    const refs: string[] = [];
    for (const ref of item.prerequisites ?? []) {
      const dependency = all.find((other) => other.batch === item.batch && other.key === ref && !other.settled);
      if (dependency && !chosen.has(dependency.id)) {
        return `「${item.title}」要等同一批的「${dependency.title}」：一起派，或先把「${dependency.title}」点叉`;
      }
      refs.push(dependency ? scopedKey(item, ref) : ref);
    }
    specs.push({ ...(item.key ? { key: scopedKey(item, item.key) } : {}), ...(refs.length ? { prerequisites: refs } : {}) });
  }
  return specs;
}

export async function launchSuggestions(
  c: Context,
  task: TaskRow,
  /** 新任务归谁：路由按它核过交给谁，这里按它建（两处必须是同一个人）。 */
  owner: string | null,
  launch: LaunchRequest,
): Promise<Outcome> {
  const all = readSuggestions(task);
  const byId = new Map(all.filter((item) => !item.settled).map((item) => [item.id, item]));
  const missing = launch.items.map((pick) => pick.id).filter((suggestion) => !byId.has(suggestion));
  if (missing.length) return { status: 409, body: { error: "这几件已经派出去、叉掉或被智能体收回了，请看最新的那几行", missing } };
  const picked = launch.items.map((pick) => byId.get(pick.id)!);
  const prepared = await prepareResolve(task, picked.map((item) => item.id));
  if ("error" in prepared) return { status: 409, body: { error: prepared.error } };

  const ids = picked.map(() => id());
  const specs = prerequisiteSpecs(picked, all);
  if (typeof specs === "string") return { status: 409, body: { error: specs } };
  const prerequisites = batchPrerequisiteEdges(specs, ids);
  if (typeof prerequisites === "string") return { status: 400, body: { error: prerequisites } };
  const visible = new Set(await visibleTaskIds(actorOf(c), prerequisites.existing));
  const hidden = prerequisites.existing.find((taskId) => !visible.has(taskId));
  if (hidden) return { status: 404, body: { error: `前置任务 ${hidden} 不存在` } };
  // 一件就是一条独立任务（同回复框里「派出去」）；好几件才成一组，「一个接一个」靠这一组的队列。
  const several = picked.length > 1;
  const serial = several && launch.order === "serial";
  // 选了一个接一个、照这个顺序排队会互相等住的：那几件原样留着、说清楚，不建。
  const deadlock = serial ? serialOrderConflict(picked.map((item, at) => ({ title: item.title, ...specs[at]! }))) : null;
  if (deadlock) return { status: 409, body: { error: `${deadlock}。改成「同时」再派，或者发回去让它调整顺序` } };

  const creationOrigin = await requestTaskCreationOrigin(c);
  const label = await targetLabeler();
  const groupId = several ? id() : null;
  const base = Date.now();
  const rows = launch.items.map((pick, at) => {
    const item = picked[at]!;
    const ts = new Date(base + at).toISOString();
    return {
      id: ids[at]!, creationOrigin, projectId: task.projectId, groupId, parentId: null as string | null,
      title: pick.title,
      body: taskBody(suggestionTaskBody(pick.body, pick.extra), ids[at]!) + attachmentsPrompt(launch.attachments),
      mode: "single", status: "backlog",
      labels: JSON.stringify(item.labels ?? []), dependsOn: "[]", resumeDependsOn: "[]",
      agentType: pick.target.agentType, executorId: pick.target.executorId,
      model: pick.target.model, reasoningEffort: pick.target.reasoningEffort,
      autoTitle: false, duet: null as string | null, scheduleId: null as string | null, createdAt: ts, updatedAt: ts,
      useWorktree: item.useWorktree, ...launchedSettings(pick, item),
      mergeTargetBranch: item.mergeTargetBranch ?? null,
      workflowMode: "free", ownerUserId: owner, dispatchedBy: task.id,
    };
  });
  let resolved: Resolved = { closed: null };
  let committed = false;
  try {
    await createTasks(rows, undefined, undefined, [], prerequisites.edges, {
      before: async (transaction) => {
        resolved = await resolveWithin(transaction, task.id, {
          launch: rows.map((row, at) => ({ id: picked[at]!.id, task: { id: row.id, title: row.title, target: launch.items[at]!.target } })),
          drop: [],
          expect: new Map(picked.map((item) => [item.id, item.prerequisites])),
        }, { label, proposed: proposedTarget(task), order: launch.order, delivery: prepared.delivery, owner });
        if (groupId) {
          await transaction.insert(groups).values({
            id: groupId, projectId: task.projectId, name: `派出：${task.title}`.slice(0, 80),
            mode: serial ? "serial" : "parallel", paused: false, createdAt: now(),
          });
        }
      },
      after: async (transaction) => {
        if (serial) {
          const queueId = id();
          const at = now();
          await transaction.insert(queueItems).values(ids.map((taskId, position) => ({ taskId, queueId, position, createdAt: at })));
        }
        await requestLaunch(serial ? ids.slice(0, 1) : ids, { source: "run", actingUserId: owner }, transaction);
        // 贴的图归给新任务（一份上传只归一条，选中一件派时才有图）：跟建任务同一笔，写不进去整笔不落、那一件原样还在。
        // 问的是点「派出去」的这个人手里有没有这几张（uploads.ts）。
        if (launch.attachments.length) await bindUploadsToTask(launch.attachments, ids[0]!, owner, transaction);
      },
      onCommitted: () => { committed = true; },
    });
  } catch (error) {
    if (error instanceof SuggestionClaimLost) return { status: 409, body: { error: error.message, missing: error.missing } };
    if (error instanceof SuggestionConflict) return { status: 409, body: { error: error.message } };
    if (!committed) return { status: 409, body: { error: `没能派出去：${error instanceof Error ? error.message : String(error)}` } };
    console.error(`[navi] 已派出，读回或广播新任务时出错 ${task.id}:`, error);
  }

  // —— 提交之后：只剩「让人看见」和「催一下」（外加等着的那一批的收尾），各自兜底，都不改变「已经派出」。
  afterResolved(task.id, resolved, "派出");
  const settle = (what: string, work: () => unknown) => {
    void Promise.resolve().then(work).catch((error) => console.error(`[navi] 已派出，${what}出错 ${task.id}:`, error));
  };
  if (prerequisites.existing.length) settle("刷新前置视图", () => republishPrerequisiteView(prerequisites.existing));
  // 不等下一次扫描：挂着的请求当场判一遍，齐了、有名额的就起（错过了还有开机补办和每分钟那一扫）。
  settle("催起跑", () => sweepLaunchRequests());
  const closed = (resolved as Resolved).closed;
  return {
    status: 200,
    body: {
      launched: true, groupId, closed: !!closed, ...(closed ? { record: closed.record } : {}),
      tasks: rows.map((row) => ({ id: row.id, title: row.title })),
    },
  };
}

/** 用户点叉：这一件不派。已经不在了就当叉掉了（用户要的结果本来就是它不在）。等着的那一批最后一件也算处理完。 */
export async function dropSuggestion(task: TaskRow, suggestion: string, owner: string | null): Promise<Outcome> {
  const item = readSuggestions(task).find((entry) => entry.id === suggestion && !entry.settled);
  if (!item) return { status: 200, body: { dropped: false, closed: false } };
  const prepared = await prepareResolve(task, [suggestion]);
  if ("error" in prepared) return { status: 409, body: { error: prepared.error } };
  const label = await targetLabeler();
  let resolved: Resolved;
  try {
    resolved = await db.transaction((transaction) => resolveWithin(transaction, task.id, { launch: [], drop: [suggestion] },
      { label, proposed: proposedTarget(task), delivery: prepared.delivery, owner }), { behavior: "immediate" });
  } catch (error) {
    if (error instanceof SuggestionClaimLost) return { status: 200, body: { dropped: false, closed: false } };
    if (error instanceof SuggestionConflict) return { status: 409, body: { error: error.message } };
    throw error;
  }
  afterResolved(task.id, resolved, "点叉");
  return { status: 200, body: { dropped: true, closed: !!resolved.closed } };
}
