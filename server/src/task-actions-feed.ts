// 「任务此刻能做什么可能变了」的推送：只广播失效信号（`task.actions.stale`），不广播结论。开着那个
// 任务的页面收到后自己 `GET /tasks/:id/actions`（web/src/lib/useTaskActions.ts）。
//
// 为什么不推结论：推结论就得知道「谁在看哪个任务」，服务端没有这份账 —— 拿「最近被取过」去猜，
// 猜的人一多就把还开着的页面挤掉，那张页面的键从此再也不跟着变。失效信号谁都能收、收了不看的页面
// 直接丢掉，服务端一份账都不用记，也就没有容量这回事。
//
// 脏从哪来：判据依赖的事实一落库，库里的触发器就记一笔（db/task-action-triggers.ts）；不在库里的
// 那一样（有没有活进程）由 runs.ts 自己记。这里攒 30ms 合成一批，再按库把牵连展开：同队成员（队列
// 挡路是别人的状态）、被停下 / 恢复的分组的成员和它所属的团队。展开出错就退成「开着的全部重取」——
// 宁可多取一次，不能漏掉一个。
import { inArray } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { groups, queueItems, tasks } from "./db/schema.js";
import { onTaskActionsDirty } from "./task-actions-dirty.js";

const dirty = new Set<string>();
const dirtyGroups = new Set<string>();
let everything = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flush(); }, 30);
}

/** 这一批脏任务牵连到的全部任务（含它们自己）。 */
async function affected(ids: string[], groupIds: string[]): Promise<string[]> {
  const out = new Set(ids);
  if (ids.length) {
    const queues = await db.select({ queueId: queueItems.queueId }).from(queueItems).where(inArray(queueItems.taskId, ids));
    if (queues.length) {
      const mates = await db.select({ taskId: queueItems.taskId }).from(queueItems)
        .where(inArray(queueItems.queueId, [...new Set(queues.map((q) => q.queueId))]));
      for (const mate of mates) out.add(mate.taskId);
    }
  }
  if (groupIds.length) {
    const members = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.groupId, groupIds));
    for (const member of members) out.add(member.id);
    // 团队派活建的分组停下 / 恢复了：团队的「停止全组」跟着变。
    const owners = await db.select({ owner: groups.ownerTaskId }).from(groups).where(inArray(groups.id, groupIds));
    for (const row of owners) if (row.owner) out.add(row.owner);
  }
  return [...out];
}

async function flush(): Promise<void> {
  const ids = [...dirty];
  const groupIds = [...dirtyGroups];
  const all = everything;
  dirty.clear();
  dirtyGroups.clear();
  everything = false;
  if (all) {
    bus.publish({ type: "task.actions.stale.all" });
    return;
  }
  let targets: string[];
  try {
    targets = await affected(ids, groupIds);
  } catch (error) {
    console.error("[ash] 展开动作失效的牵连失败，改为全部重取:", error);
    bus.publish({ type: "task.actions.stale.all" });
    return;
  }
  for (const taskId of targets) bus.publish({ type: "task.actions.stale", taskId });
}

let started = false;

export function startTaskActionsFeed(): void {
  if (started) return;
  started = true;
  onTaskActionsDirty((mark) => {
    if (mark.kind === "all") everything = true;
    else if (mark.kind === "group") dirtyGroups.add(mark.groupId);
    else dirty.add(mark.taskId);
    schedule();
  });
  // 审查辩论这类散在别的表里的审查链状态，触发器没有逐张盯，靠审查链自己发的事件补上。
  bus.subscribe((event) => {
    if (event.type !== "task.review") return;
    dirty.add(event.taskId);
    schedule();
  });
}
