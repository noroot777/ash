// 任务备忘的前端数据层：**一个任务一份，全页面共用**。
//
// 为什么不是面板自己 useState 拉一次：加备忘有两个入口，而它们不在同一棵子树里 ——
// 面板里的「新建」，和会话选文浮条上的「添加到备忘」（它在中间栏，加完才切到面板）。
// 各拉各的话，浮条加完那条要等面板重新挂载才看得见，面板开着的时候则永远不刷新。
// 共用一份之后，谁写进来都是同一个 Map，订阅它的那几处当场一起更新。
//
// 没做 SSE 推送：备忘是**人自己写给自己看的**，不会有第二个来源在后台改它（agent 碰不到
// 这张表）。多开一个标签页的话另一页要刷新才同步 —— 为这点代价开一条实时通道不划算。
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { TaskMemo } from "@ash/shared/task-memo";
import { api } from "../lib/api.ts";

export type TaskMemoState = {
  memos: readonly TaskMemo[];
  /** 还没从后端读到过（区分「这个任务没有备忘」和「还没问过」）。 */
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /**
   * 刚加进来那条的 id。给面板高亮用 —— 从会话里选一段「添加到备忘」时，面板是**这一下
   * 才切过去的**，列表里可能已经躺着十几条，不指一下没人知道刚才那段落在哪儿了。
   */
  justAddedId: string | null;
};

const EMPTY: TaskMemoState = { memos: [], loaded: false, loading: false, error: null, justAddedId: null };

const store = new Map<string, TaskMemoState>();
const listeners = new Map<string, Set<() => void>>();
/** 每个任务最近一次读取的代号：迟到的旧应答不许覆盖新结果。 */
const reads = new Map<string, number>();
/**
 * 每个任务**已确认写入**的次数。读取和写入必须共用这一道版本边界，光防「旧读取覆盖
 * 新读取」是不够的：一发在写入之前发出的 GET，回来时带的是还没有那条新备忘的快照，
 * 照样会把刚存上的那条从界面上抹掉（独立审查第 1 轮按住 GET 应答实测：条目先出现、
 * 随后自己消失，刷新整页才回来）。同理还有「编辑后回退成旧正文」「删掉的又冒出来」。
 */
const writes = new Map<string, number>();

function emit(taskId: string) {
  for (const listener of listeners.get(taskId) ?? []) listener();
}

function set(taskId: string, patch: Partial<TaskMemoState>) {
  store.set(taskId, { ...(store.get(taskId) ?? EMPTY), ...patch });
  emit(taskId);
}

function snapshot(taskId: string): TaskMemoState {
  return store.get(taskId) ?? EMPTY;
}

function subscribe(taskId: string, listener: () => void): () => void {
  const set = listeners.get(taskId) ?? new Set();
  set.add(listener);
  listeners.set(taskId, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(taskId);
  };
}

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/**
 * 新的排前面：列表按 updatedAt 倒序，改过的一条会自己浮到最上面。
 *
 * 顺手**按 id 去重**：读取快照和本地刚写进来的那条可以是同一条（GET 已经含它、POST 的
 * 应答随后才到），不去重就是同一条备忘在列表里出现两次、计数也多一个。撞上时留先遇到
 * 的那份 —— 调用点一律把更权威的那份排在前面（写入应答 > 读取快照）。
 */
function sorted(rows: readonly TaskMemo[]): TaskMemo[] {
  const byId = new Map<string, TaskMemo>();
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * 「这个任务的备忘动过了」。订阅者是**另一份缓存**：侧边栏铺开那一列的摘要由
 * `useSidebarSpread` 自己存一份，不订阅的话本页刚存上的那条在那边要等收起重开才出现
 * （第 2 轮审查 N1 实测）。
 *
 * 为什么不叫它去读这个 store：那一列要的是「共几条 + 最近那条的摘要」，口径在服务端
 * （taskMemoDigestText 的截断），而且它关心的任务远不止当前打开的那一个。
 */
const writeWatchers = new Set<(taskId: string) => void>();

export function onTaskMemoWrite(listener: (taskId: string) => void): () => void {
  writeWatchers.add(listener);
  return () => { writeWatchers.delete(listener); };
}

/** 写成功了就推一版：在这之前发出的读取，回来时一律作废重拉；顺带通知别的缓存。 */
function confirmWrite(taskId: string): void {
  writes.set(taskId, (writes.get(taskId) ?? 0) + 1);
  for (const watcher of writeWatchers) watcher(taskId);
}

/**
 * 这个任务**已确认写入**的次数。导出给另一份缓存（侧栏铺开那一列的摘要）当同一道
 * 版本边界用：它自己发的读取也必须「发出前记下、回来时比对」，否则迟到的旧摘要会把
 * 刚存上的那条倒退回旧正文（第 3 轮审查 N1 实测）。
 */
export function taskMemoWrites(taskId: string): number {
  return writes.get(taskId) ?? 0;
}

/**
 * 「这一发写飞着的时候，别的写先落地了吗」。
 *
 * 是的话手里这份应答可能比本地旧（同一条备忘的两发写逆序返回，先发那一发的正文会把后
 * 发那一发盖回去；删掉之后到达的编辑应答还会把条目补回来）。那就不拿它改本地状态，
 * 重拉一发让后端定胜负 —— 跟读取侧同一道边界。判据是「只有我自己那一下」：
 * `confirmWrite` 在这之前刚把计数 +1。
 */
function onlyMine(taskId: string, writtenAt: number): boolean {
  return (writes.get(taskId) ?? 0) === writtenAt + 1;
}

export async function reloadTaskMemos(taskId: string): Promise<void> {
  const token = (reads.get(taskId) ?? 0) + 1;
  reads.set(taskId, token);
  // 发请求**之前**记下写入版本：应答回来时它变过，说明这期间有一条写成功了，
  // 手里这份快照比本地旧 —— 不能拿它覆盖，重拉一发（loading 一直挂着不留空档）。
  const writtenAt = writes.get(taskId) ?? 0;
  set(taskId, { loading: true, error: null });
  try {
    const rows = await api.taskMemos(taskId);
    if (reads.get(taskId) !== token) return;
    if ((writes.get(taskId) ?? 0) !== writtenAt) return void reloadTaskMemos(taskId);
    set(taskId, { memos: sorted(rows), loaded: true, loading: false, error: null });
  } catch (reason) {
    if (reads.get(taskId) !== token) return;
    // 只收 loading / error：读失败不该把本地已确认的那几条也一起清掉。
    set(taskId, { loading: false, error: message(reason) });
  }
}

/**
 * 写进这个任务的备忘。会话选文浮条上的「添加到备忘」直接调它 —— 它不在面板那棵子树里，
 * 拿不到面板的 hook，而这条写入必须落进同一份缓存，否则切过去看不见刚加的那条。
 *
 * **不需要 `onlyMine` 那道仲裁**：它加的是一行新的，没有「谁覆盖谁」—— 期间别的写落地
 * 了也只是让 `current.memos` 更新，把新行并进去仍然对。
 */
export async function addTaskMemo(taskId: string, body: string): Promise<TaskMemo> {
  const memo = await api.createTaskMemo(taskId, body);
  confirmWrite(taskId);
  const current = snapshot(taskId);
  // 新的那条排在最前：撞 id 时（读取快照已经含它）sorted 留的就是这份权威应答。
  set(taskId, { memos: sorted([memo, ...current.memos]), loaded: current.loaded, justAddedId: memo.id });
  return memo;
}

export async function editTaskMemo(taskId: string, memoId: string, body: string): Promise<TaskMemo> {
  const writtenAt = writes.get(taskId) ?? 0;
  const memo = await api.updateTaskMemo(taskId, memoId, body);
  confirmWrite(taskId);
  if (!onlyMine(taskId, writtenAt)) {
    void reloadTaskMemos(taskId);
    return memo;
  }
  const current = snapshot(taskId);
  // 列表里还没有这条（比如先在别处改的）就补进去，别把这次改动丢掉。
  const rows = current.memos.some((row) => row.id === memo.id)
    ? current.memos.map((row) => (row.id === memo.id ? memo : row))
    : [memo, ...current.memos];
  set(taskId, { memos: sorted(rows) });
  return memo;
}

export async function removeTaskMemo(taskId: string, memoId: string): Promise<void> {
  const writtenAt = writes.get(taskId) ?? 0;
  await api.deleteTaskMemo(taskId, memoId);
  confirmWrite(taskId);
  if (!onlyMine(taskId, writtenAt)) return void reloadTaskMemos(taskId);
  const current = snapshot(taskId);
  set(taskId, {
    memos: current.memos.filter((row) => row.id !== memoId),
    // 删掉的正好是刚高亮那条时把记号也撤掉，免得它指着一条已经没了的备忘。
    ...(current.justAddedId === memoId ? { justAddedId: null } : {}),
  });
}

/** 高亮是一次性的提示，不是状态：面板认完就撤，免得下次再打开这一格它还亮着。 */
export function clearTaskMemoHighlight(taskId: string): void {
  if (snapshot(taskId).justAddedId === null) return;
  set(taskId, { justAddedId: null });
}

/**
 * 订阅一个任务的备忘。`enabled` 为 false 时只读缓存、不发请求 —— 面板没开的时候，
 * 详情页仍然要知道「这个任务有没有备忘」（图标条上那点底色），但那一发由开着的那一处
 * 统一负责，不必每个订阅者各拉一次。
 */
export function useTaskMemos(taskId: string, enabled = true): TaskMemoState {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(taskId, listener), [taskId]),
    () => snapshot(taskId),
    () => EMPTY,
  );
  useEffect(() => {
    if (!enabled) return;
    // 已经读到过就不再重复拉：切面板来回点不该每次都打一发。要最新的用 reloadTaskMemos。
    if (snapshot(taskId).loaded || snapshot(taskId).loading) return;
    void reloadTaskMemos(taskId);
  }, [enabled, taskId]);
  return state;
}
