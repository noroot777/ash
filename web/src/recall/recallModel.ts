// R 键那张「我说过的话」的纯逻辑：左边哪些任务、各自连带哪几条（执行者、派出去的子任务）、筛的时候
// 留谁；右边一串发言怎么按天、按子任务分段。拆出来是为了能脱 DOM 钉住（scripts/test-recall.ts）。
import type { TaskListItem } from "@ash/shared";
import type { UserMessage } from "@ash/shared/user-messages";

const two = (value: number) => String(value).padStart(2, "0");

function dayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 这一天的段头：今天、昨天，今年的写几月几日，更早的带上年份。 */
export function dayLabel(at: string, now: Date = new Date()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "更早";
  const days = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}年${monthDay}`;
}

/** 几点几分：哪一天已经写在段头上了。 */
export function clockOf(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** 沿 parentId → dispatchedBy 往上走（不含自己），碰到 `stop` 返回 true 就停。脏数据成环时每条只走一次。 */
function climbs(task: TaskListItem, byId: ReadonlyMap<string, TaskListItem>, stop: (id: string) => boolean): string | null {
  const seen = new Set([task.id]);
  let up = task.parentId ?? task.dispatchedBy ?? null;
  while (up && !seen.has(up)) {
    if (stop(up)) return up;
    seen.add(up);
    const next = byId.get(up);
    up = next ? next.parentId ?? next.dispatchedBy ?? null : null;
  }
  return null;
}

/**
 * 左边那一列的顺序：**跟侧栏人眼看到的一样** —— 跟 J/K 同一个来源（workspace/sidebarNavigation 的
 * sidebarRowOrder，读侧栏的 DOM）。侧栏的顺序有一摞只活在组件里的状态（任务模式按项目分组、名下最近
 * 一次动静、年龄闸、展开到第几页），在模型这一层重算一份迟早对不上。
 *
 * - 屏幕上展开着的团队执行者、收在别人下面的子任务也有自己的行：它们归到上面那一行（recallMembers），
 *   不单独成行。
 * - 侧栏此刻没画出来的（折进「展开」的旧任务、收起的分组）接在后面，按模型顺序（fallback）。
 * - 侧栏整栏收起（offscreen）就整份用 fallback，同 J/K 的退路。
 */
export function recallOrder(
  screen: { kind: "screen"; ids: readonly string[] } | { kind: "offscreen" },
  fallback: readonly TaskListItem[],
  all: readonly TaskListItem[],
): TaskListItem[] {
  if (screen.kind === "offscreen") return [...fallback];
  const byId = new Map(all.map((task) => [task.id, task]));
  const listed = new Set<string>();
  const order: TaskListItem[] = [];
  const add = (task: TaskListItem | undefined) => {
    if (!task || listed.has(task.id)) return;
    listed.add(task.id);
    order.push(task);
  };
  const onScreen = new Set(screen.ids);
  for (const id of screen.ids) {
    const task = byId.get(id);
    if (task && !climbs(task, byId, (up) => onScreen.has(up))) add(task);
  }
  for (const task of fallback) if (!climbs(task, byId, (up) => listed.has(up))) add(task);
  return order;
}

/**
 * 左边一行任务连带哪几条：它自己，加上挂在它下面的 —— 团队执行者（parentId）和派出去的子任务
 * （dispatchedBy）。侧栏把这些收在那一行底下，我在它们里面说的话也算在这一行上。
 *
 * 一路往上找（执行者 → 调度台 → 派它的那条 → …），碰到左边列着的那一行为止；中间那几条不在列表里
 * （归档了、被筛掉了）照样往上走 —— 跟侧栏收纳（dispatchForest）同一个方向。够不着任何一行的不算。
 * 归档的子任务也算：它里面我说过的话还在。
 */
export function recallMembers(order: readonly TaskListItem[], all: readonly TaskListItem[]): Map<string, string[]> {
  const listed = new Set(order.map((task) => task.id));
  const byId = new Map(all.map((task) => [task.id, task]));
  const members = new Map(order.map((task) => [task.id, [task.id]]));
  const below = all.filter((task) => !listed.has(task.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const task of below) {
    const root = climbs(task, byId, (up) => listed.has(up));
    if (root) members.get(root)!.push(task.id);
  }
  return members;
}

export type RecallTaskRow = { task: TaskListItem; members: string[]; hits: number };

/**
 * 筛过的左边那一列，顺序不动（同侧栏）。没打字时全列；打了字只留对得上的：任务标题（它自己或连带的
 * 那几条）里每个词都有，或者我在里面说过的话对得上（hits 是服务端按正文数的，各任务几句）。
 * hits 还没回来（null）时先只按标题筛，回来了再补上。
 */
export function recallTaskRows(
  order: readonly TaskListItem[],
  members: ReadonlyMap<string, readonly string[]>,
  titleOf: (taskId: string) => string,
  query: string,
  hits: ReadonlyMap<string, number> | null,
): RecallTaskRow[] {
  const terms = recallTerms(query);
  return order.flatMap((task) => {
    const ids = [...(members.get(task.id) ?? [task.id])];
    const count = ids.reduce((sum, id) => sum + (hits?.get(id) ?? 0), 0);
    if (!terms.length) return [{ task, members: ids, hits: 0 }];
    const titled = ids.some((id) => {
      const title = titleOf(id).toLowerCase();
      return terms.every((term) => title.includes(term));
    });
    return titled || count > 0 ? [{ task, members: ids, hits: count }] : [];
  });
}

/**
 * 右边那一串：旧的在前（跟会话一个方向）。换一天画一个段头；说话的地方换了（从这一条换到它名下的
 * 某个执行者 / 子任务，或者换回来）画一行那一条的标题 —— 一直在它自己身上说的就一行都不画。
 */
export type RecallBlock =
  | { kind: "day"; key: string; label: string }
  | { kind: "task"; key: string; taskId: string }
  | { kind: "message"; key: string; message: UserMessage };

export function recallBlocks(messages: readonly UserMessage[], rootId: string, now: Date = new Date()): RecallBlock[] {
  const blocks: RecallBlock[] = [];
  let day: string | null = null;
  let where = rootId;
  for (const message of messages) {
    const label = dayLabel(message.at, now);
    if (label !== day) {
      blocks.push({ kind: "day", key: `day:${message.id}`, label });
      day = label;
    }
    if (message.taskId !== where) {
      blocks.push({ kind: "task", key: `task:${message.id}`, taskId: message.taskId });
      where = message.taskId;
    }
    blocks.push({ kind: "message", key: message.id, message });
  }
  return blocks;
}

/** 查询拆成词：空白分开、不分大小写 —— 跟服务端筛的口径（server/src/user-messages-pick.ts 的 queryTerms）一样。 */
export function recallTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].sort((left, right) => right.length - left.length);
}

/** 这一句对不对得上（每个词都得出现）：右边打开时先落到第一句对得上的。 */
export function messageMatches(text: string, query: string): boolean {
  const terms = recallTerms(query);
  const lower = text.toLowerCase();
  return terms.length > 0 && terms.every((term) => lower.includes(term));
}

/** 正文切成「命中 / 没命中」几段，命中的词画出来。同一处有长有短时取长的。 */
export function highlightParts(text: string, query: string): { text: string; hit: boolean }[] {
  const terms = recallTerms(query);
  if (!terms.length) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  // 少数字符小写后长度会变（İ），下标就对不上原文：这种正文不画，照原样给。
  if (lower.length !== text.length) return [{ text, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  let position = 0;
  while (position < text.length) {
    let at = -1;
    let length = 0;
    for (const term of terms) {
      const index = lower.indexOf(term, position);
      if (index >= 0 && (at < 0 || index < at)) {
        at = index;
        length = term.length;
      }
    }
    if (at < 0) break;
    if (at > position) parts.push({ text: text.slice(position, at), hit: false });
    parts.push({ text: text.slice(at, at + length), hit: true });
    position = at + length;
  }
  if (position < text.length) parts.push({ text: text.slice(position), hit: false });
  return parts;
}

/**
 * 打开动作该不该发生。窗口里四个入口（回车、双击左边那行、点右边的任务名、点一句话）和「搜索中按的那下
 * 回车」都问它，判据只有这一份：
 *
 * - 窗口关着就什么都不开 —— 关窗口本身会让「搜索中」那一刻结束，不能把这当成「新结果到了，可以开了」；
 * - 列表还是上一问的结果（pending）就不开，开出去的会是上一问选中的那条；
 * - 搜索中按下的回车记着按下那一刻输入框里的词（`queued`）：词又改了就作废 —— 那下回车是冲着旧词按的。
 *
 * 返回 open = 现在开；wait = 回车留着，等结果跟上；drop = 这下回车作废。
 */
export type OpenGate = { open: boolean; pending: boolean; query: string };

export function openDecision(gate: OpenGate, queued?: string): "open" | "wait" | "drop" {
  if (!gate.open) return "drop";
  if (queued !== undefined && queued !== gate.query.trim()) return "drop";
  return gate.pending ? "wait" : "open";
}
