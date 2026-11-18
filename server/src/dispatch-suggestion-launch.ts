// 「可以派出去的活」派出去那一下：照那一行此刻的样子（用户改过的标题、说明、换过的人、开工起点、补的那句话）
// 建普通任务，挂在这条任务名下，交给调度；那几件同一笔从这条任务上摘掉。
//
// 跟派活单「派出去」（dispatch-plan-launch.ts）同一套建法——同一笔事务里摘建议、建分组、建任务、串队列、
// 挂开工请求，任何一步失败整笔回滚、建议原样还在，再按一次不会多建；摘的时候那几件已经不在了（别处刚派掉、
// 回合结束刚收掉）整笔不落。少的是两样：不认领提问（建议不占那一格），也不往这条任务的会话里送答复——
// **这条任务的智能体不被叫醒**，所以它在跑时也照派。会话里那一句「开了新任务」由页面从任务列表里认
// （web/src/task-detail/dispatchNotes.ts：dispatchedBy 指向这条、创建来源是用户）。
import type { Context } from "hono";
import {
  suggestionTaskBody, type DispatchSuggestionLaunchInput, type DispatchSuggestionLaunchItem,
} from "@ash/shared/dispatch-suggestion";
import type { DispatchRunTarget } from "@ash/shared/dispatch-plan";
import { groups, queueItems } from "./db/schema.js";
import type { ExecutorScope } from "./auth/owned-executors.js";
import { normalizeTarget } from "./dispatch-plan.js";
import { requestLaunch, sweepLaunchRequests } from "./launch-request.js";
import { requestTaskCreationOrigin } from "./task-creation-origin.js";
import { createTasks, publishTaskUpdated, type TaskRow } from "./task-store.js";
import { bindUploadsToTask } from "./uploads.js";
import { updateSuggestions, withoutSuggestions } from "./dispatch-suggestion.js";
import { attachmentsPrompt, id, now, taskBody } from "./util.js";

class SuggestionClaimLost extends Error {
  constructor(readonly missing: string[]) { super("suggestion gone"); }
}

type Picked = DispatchSuggestionLaunchItem & { target: DispatchRunTarget };

/** 用户交来的派出清单核一遍：每件写得齐、不重复、交给谁写得对。 */
export function normalizeSuggestionLaunch(
  body: Partial<DispatchSuggestionLaunchInput>,
  scope: ExecutorScope,
): { order: "serial" | "parallel"; items: Picked[]; attachments: string[] } | { error: string } {
  const order = body.order ?? "parallel";
  if (order !== "serial" && order !== "parallel") return { error: "order 只能是 serial 或 parallel" };
  if (!Array.isArray(body.items) || !body.items.length) return { error: "一件都没选，派不出去" };
  const seen = new Set<string>();
  const items: Picked[] = [];
  for (const [at, raw] of body.items.entries()) {
    const where = `items[${at}]`;
    if (!raw || typeof raw.id !== "string" || seen.has(raw.id)) return { error: `${where}.id 不对或重复了` };
    seen.add(raw.id);
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const text = typeof raw.body === "string" ? raw.body.trim() : "";
    if (!title || !text) return { error: `「${title || "没写标题"}」的标题或说明是空的，派不出去` };
    const target = normalizeTarget(raw.target ?? {}, scope, `${where}.target`);
    if (!target) return { error: `${where}.target 要写明交给谁` };
    if ("error" in target) return target;
    if (raw.worktreeBase !== null && raw.worktreeBase !== undefined && typeof raw.worktreeBase !== "string") {
      return { error: `${where}.worktreeBase 要是分支名或 null` };
    }
    items.push({
      id: raw.id, title, body: text, target,
      extra: typeof raw.extra === "string" ? raw.extra : undefined,
      worktreeBase: raw.worktreeBase?.trim() || null,
    });
  }
  const attachments = Array.isArray(body.attachments) ? body.attachments.filter((path): path is string => typeof path === "string") : [];
  return { order, items, attachments };
}

export async function launchSuggestions(
  c: Context,
  task: TaskRow,
  /** 新任务归谁：路由按它核过交给谁，这里按它建（两处必须是同一个人）。 */
  owner: string | null,
  launch: { order: "serial" | "parallel"; items: Picked[]; attachments: string[] },
): Promise<{ status: 200; body: Record<string, unknown> } | { status: 409; body: { error: string; missing?: string[] } }> {
  const creationOrigin = await requestTaskCreationOrigin(c);
  const ids = launch.items.map(() => id());
  // 一件就是一条独立任务（同回复框里「派出去」）；好几件才成一组，「一个接一个」靠这一组的队列。
  const several = launch.items.length > 1;
  const groupId = several ? id() : null;
  const serial = several && launch.order === "serial";
  const base = Date.now();
  const rows = launch.items.map((item, at) => {
    const ts = new Date(base + at).toISOString();
    return {
      id: ids[at]!, creationOrigin, projectId: task.projectId, groupId, parentId: null as string | null,
      title: item.title,
      body: taskBody(suggestionTaskBody(item.body, item.extra), ids[at]!) + attachmentsPrompt(launch.attachments),
      mode: "single", status: "backlog",
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]",
      agentType: item.target.agentType, executorId: item.target.executorId,
      model: item.target.model, reasoningEffort: item.target.reasoningEffort,
      autoTitle: false, duet: null as string | null, scheduleId: null as string | null, createdAt: ts, updatedAt: ts,
      worktreeBase: item.worktreeBase, workflowMode: "free", ownerUserId: owner, dispatchedBy: task.id,
    };
  });
  const claim = withoutSuggestions(launch.items.map((item) => item.id));
  let committed = false;
  try {
    await createTasks(rows, undefined, undefined, [], [], {
      before: async (transaction) => {
        const taken = await updateSuggestions(task.id, claim.change, transaction);
        if (!taken) throw new SuggestionClaimLost(claim.missing());
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
        // 贴的图归给新任务（一份上传只归一条，选中一件派时才有图）：跟建任务同一笔，写不进去整笔不落、建议原样还在，
        // 不会出现任务建好了、同项目的人却永远读不到图。问的是点「派出去」的这个人手里有没有这几张（uploads.ts）。
        if (launch.attachments.length) await bindUploadsToTask(launch.attachments, ids[0]!, owner, transaction);
      },
      onCommitted: () => { committed = true; },
    });
  } catch (error) {
    if (error instanceof SuggestionClaimLost) {
      return { status: 409, body: { error: "这件已经派出去或收掉了，请看最新的那一行", missing: error.missing } };
    }
    if (!committed) return { status: 409, body: { error: `没能派出去：${error instanceof Error ? error.message : String(error)}` } };
    console.error(`[ash] 可派出的活已派出，读回或广播新任务时出错 ${task.id}:`, error);
  }

  // —— 提交之后：只剩「让人看见」和「催一下」，各自兜底，都不改变「已经派出」。
  const settle = (what: string, work: () => unknown) => {
    void Promise.resolve().then(work).catch((error) => console.error(`[ash] 可派出的活已派出，${what}出错 ${task.id}:`, error));
  };
  settle("广播收掉那几件", () => publishTaskUpdated(task.id));
  settle("催起跑", () => sweepLaunchRequests());
  return { status: 200, body: { launched: true, groupId, tasks: rows.map((row) => ({ id: row.id, title: row.title })) } };
}
