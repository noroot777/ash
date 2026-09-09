// 全局搜索(⌘K)的结果形状。纯类型文件,index.ts 只做再导出 —— 拆分理由与
// 「只能搬类型、不能搬运行时值」的原因见 ./events.ts 头部注释。
import type { TaskStatus } from "./index.ts";

// One hit per task or note. Task fields rank id > title > body > conversation,
// and task hits are returned before note hits. `conversation` means the match
// was found inside the task's session transcripts (data/runs/<taskId>/*.md|jsonl),
// which is where run artifacts like output directory names live.
// `id` means the query itself is this task's id (or its 8-char branch prefix):
// it outranks everything, and it is the one field that can produce a hit with no
// match in the corpus at all — a task's own id appears nowhere in its own text.
export type SearchField = "id" | "title" | "body" | "conversation";

export interface TaskSearchHit {
  kind: "task";
  id: string;
  title: string;
  status: TaskStatus;
  projectId: string;
  projectName: string | null;
  archived: boolean;
  field: SearchField;
  // Context around the first match, whitespace-collapsed to one line.
  // Empty for title hits (the title is already shown).
  snippet: string;
  // Task body prefix for the command-palette preview.
  preview?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteSearchHit {
  kind: "note";
  id: string;
  title: string;
  projectId: string;
  projectName: string | null;
  field: "body";
  snippet: string;
  // Note body for the command-palette preview.
  preview?: string;
  createdAt: string;
  updatedAt: string;
  taskCount: number;
}

export type SearchHit = TaskSearchHit | NoteSearchHit;

// 一次搜索最多回多少条。服务端据此早停，前端据此切片 —— 两边同一个数。
export const SEARCH_MAX_HITS = 50;

export const SEARCH_FIELD_RANK: Record<SearchField, number> = { id: 0, title: 1, body: 2, conversation: 3 };

/**
 * 排序档。
 *   · relevance 相关度：任务在随手记前 → 当前项目 → 字段（id > 标题 > 正文 > 会话）
 *     → 更新时间倒序
 *   · recent  最近更新：**整份列表**按更新时间倒序，任务和随手记混排 —— 用户要的是
 *     「最近动过的在最前」，这时候把随手记整体压到任务之后就是在骗人（一条刚写的
 *     随手记会掉到几天前的任务下面）。
 */
export type SearchSort = "relevance" | "recent";

export const SEARCH_SORTS: SearchSort[] = ["relevance", "recent"];

export function isSearchSort(value: string): value is SearchSort {
  return (SEARCH_SORTS as string[]).includes(value);
}

/**
 * 搜索结果的排序判据，**只此一处**。
 *
 * 服务端拿它决定**扫描顺序**（扫描顺序 == 排序顺序，「够 50 条就停」才站得住），前端拿它
 * 把流式到达的命中插进列表。两边各写一份必然漂，而漂了就是「列表里的顺序跟服务端以为的
 * 不一样」——早停会砍错人。**换档时两边必须换同一档**，理由同上。
 *
 * relevance（默认）四把钥匙，依次：
 *   1. 任务在随手记前（产品顺序，历来如此）
 *   2. **当前项目在前** —— ⌘K 多半是在找手头这个项目的东西；这也让「先出本项目、再搜
 *      别的项目」这种分步返回不会中途重排
 *   3. 命中在哪个字段：id > 标题 > 正文 > 会话
 *   4. 越近改过的越前
 *
 * recent 只有一把钥匙：更新时间倒序，任务和随手记一起排。同一毫秒的并列拿 kind + id
 * 兜底 —— 不是产品偏好，是**要一个全序**：服务端按这个顺序早停、前端按它插队，判据在
 * 并列处含糊，两边就会各排各的。
 */
export function compareSearchHits(
  a: SearchHit,
  b: SearchHit,
  preferProjectId?: string | null,
  sort: SearchSort = "relevance",
): number {
  const kind = (hit: SearchHit) => (hit.kind === "task" ? 0 : 1);
  const local = (hit: SearchHit) => (preferProjectId && hit.projectId === preferProjectId ? 0 : 1);
  const field = (hit: SearchHit) => (hit.kind === "task" ? SEARCH_FIELD_RANK[hit.field] : SEARCH_FIELD_RANK.body);
  if (sort === "recent") {
    return b.updatedAt.localeCompare(a.updatedAt) || kind(a) - kind(b) || a.id.localeCompare(b.id);
  }
  return kind(a) - kind(b)
    || local(a) - local(b)
    || field(a) - field(b)
    || b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * 流式搜索（`GET /search/stream`）的一行。
 *
 * 命中一条吐一条；`marker` 是进度标记，让界面能说清「本项目已经列完了，正在搜别的项目」
 * ——不然用户看到的是一个停在半路、不知道还有没有下文的列表。
 */
export type SearchStreamLine = SearchHit | { marker: "local-done" };

