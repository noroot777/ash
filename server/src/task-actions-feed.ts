// 「任务此刻能做什么可能变了」的推送：只广播失效信号（`task.actions.stale`），不广播结论。开着那个
// 任务的页面收到后自己 `GET /tasks/:id/actions`（web/src/lib/useTaskActions.ts）。
//
// 为什么不推结论：推结论就得知道「谁在看哪个任务」，服务端没有这份账 —— 拿「最近被取过」去猜，
// 猜的人一多就把还开着的页面挤掉，那张页面的键从此再也不跟着变。失效信号谁都能收、收了不看的页面
// 直接丢掉，服务端一份账都不用记，也就没有容量这回事。
//
// 脏从哪来：判据依赖的事实一落库，库里的触发器就记一笔（db/task-action-triggers.ts）—— 依赖边
// （同队、上级、审查目标、所在分组）也是触发器在行变化那一刻按 OLD / NEW 两侧当场记下的；不在库里的
// 那一样（有没有活进程）由 runs.ts 自己记。这里攒 30ms 合成一批，把记下的队列、分组展开成此刻的
// 成员。展开出错就退成「开着的全部重取」—— 宁可多取一次，不能漏掉一个。
import { inArray } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { queueItems, tasks } from "./db/schema.js";
import { onTaskActionsDirty } from "./task-actions-dirty.js";

const dirty = new Set<string>();
const dirtyQueues = new Set<string>();
const dirtyGroups = new Set<string>();
let everything = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flush(); }, 30);
}

/** 这一批脏键指向的全部任务：记下的任务本身，加上记下的队列、分组**此刻**的成员。 */
async function affected(ids: string[], queueIds: string[], groupIds: string[]): Promise<string[]> {
  const out = new Set(ids);
  if (queueIds.length) {
    const members = await db.select({ taskId: queueItems.taskId }).from(queueItems).where(inArray(queueItems.queueId, queueIds));
    for (const member of members) out.add(member.taskId);
  }
  if (groupIds.length) {
    const members = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.groupId, groupIds));
    for (const member of members) out.add(member.id);
  }
  return [...out];
}

async function flush(): Promise<void> {
  const ids = [...dirty];
  const queueIds = [...dirtyQueues];
  const groupIds = [...dirtyGroups];
  const all = everything;
  dirty.clear();
  dirtyQueues.clear();
  dirtyGroups.clear();
  everything = false;
  if (all) {
    bus.publish({ type: "task.actions.stale.all" });
    return;
  }
  let targets: string[];
  try {
    targets = await affected(ids, queueIds, groupIds);
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
    else if (mark.kind === "queue") dirtyQueues.add(mark.queueId);
    else if (mark.kind === "group") dirtyGroups.add(mark.groupId);
    else dirty.add(mark.taskId);
    schedule();
  });
  // 审查链的几张表触发器都盯着；审查链自己发的事件再兜一层（它可能读到触发器没盯的那几张表）。
  bus.subscribe((event) => {
    if (event.type !== "task.review") return;
    dirty.add(event.taskId);
    schedule();
  });
}
