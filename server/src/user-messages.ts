// 「我说过的话」（R 键那张表）：跨全部任务、按时间倒序列出真人自己打的每一句 —— 原始需求加每次追问。
//
// 会话正文不在库里，是 data/runs/<taskId>/<sessionId>.md，全量一千多个任务、一万多份文件、一百多 MB。
// 每次打开都整份重读太慢（冷读一秒上下），所以按文件记一份摘好的发言：文件的修改时刻和大小没变就
// 直接用，变了（续聊往里追加、删了一段）才重读那一份。一次刷新只剩一轮 stat；几秒内连着来的请求
// （翻页、边打字边筛）共用同一份快照。
//
// 口径：
// - 「我说的」= isUserFollowUp，跟会话左侧输入导航、侧栏铺开那一列同一份；原始需求只算真人建的任务
//   （creationOrigin 是 user，或没记且不挂在别的任务名下），派生、团队执行者的正文是智能体写的。
// - 看得见哪些项目照 visibleProjectIds；多人模式下会话里的发言没记是谁说的，只能按任务归属认，
//   所以只列自己名下的任务。
import { readFile, stat } from "node:fs/promises";
import type { Hono } from "hono";
import { parseTaskCreationOrigin } from "@ash/shared/task-origin";
import { USER_MESSAGE_PAGE, type UserMessage, type UserMessagePage, type UserMessageTask } from "@ash/shared/user-messages";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import { actorOf, type Actor } from "./auth/context.js";
import { isMultiUser } from "./auth/mode.js";
import { visibleProjectIds } from "./auth/visibility.js";
import { readableRunPath, sessionTranscriptPath } from "./transcript.js";
import {
  compareNewestFirst,
  pageMessages,
  toIndexed,
  utterancesIn,
  type IndexedMessage,
  type SessionUtterance,
} from "./user-messages-pick.js";

/** 这么久之内再来的请求直接用上一份快照：翻页、边打字边筛都在这个量级里。 */
const FRESH_MS = 3_000;
/** 同时开着的文件数。 */
const READ_CONCURRENCY = 48;
const PAGE_MAX = 200;

type TaskRow = {
  id: string;
  title: string;
  status: string;
  projectId: string;
  parentId: string | null;
  archived: boolean;
  body: string;
  creationOrigin: string | null;
  createdAt: string;
  ownerUserId: string | null;
};

type Snapshot = { builtAt: number; messages: IndexedMessage[]; tasks: Map<string, TaskRow> };

const fileCache = new Map<string, { mtimeMs: number; size: number; utterances: SessionUtterance[] }>();
let snapshot: Snapshot | null = null;
let building: Promise<Snapshot> | null = null;

async function utterancesOf(path: string): Promise<SessionUtterance[]> {
  const info = await stat(path);
  const cached = fileCache.get(path);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.utterances;
  const utterances = utterancesIn(await readFile(path, "utf8"));
  fileCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, utterances });
  return utterances;
}

async function build(): Promise<Snapshot> {
  const taskRows: TaskRow[] = await db.select({
    id: tasks.id,
    title: tasks.title,
    status: tasks.status,
    projectId: tasks.projectId,
    parentId: tasks.parentId,
    archived: tasks.archived,
    body: tasks.body,
    creationOrigin: tasks.creationOrigin,
    createdAt: tasks.createdAt,
    ownerUserId: tasks.ownerUserId,
  }).from(tasks);
  const byId = new Map(taskRows.map((row) => [row.id, row]));
  const sessionRows = (await db.select({ id: sessions.id, taskId: sessions.taskId, startedAt: sessions.startedAt }).from(sessions))
    .filter((row) => byId.has(row.taskId));

  const messages: IndexedMessage[] = [];
  for (const task of taskRows) {
    const origin = parseTaskCreationOrigin(task.creationOrigin);
    // 没记来源的老任务挂在别的任务名下（团队执行者、派生出来的子任务），正文是调度者写的。
    if (origin ? origin.kind !== "user" : task.parentId !== null) continue;
    const message = toIndexed({ id: `${task.id}:requirement`, taskId: task.id, sessionId: null, index: null, at: task.createdAt }, task.body);
    if (message) messages.push(message);
  }

  const seen = new Set<string>();
  for (let start = 0; start < sessionRows.length; start += READ_CONCURRENCY) {
    await Promise.all(sessionRows.slice(start, start + READ_CONCURRENCY).map(async (session) => {
      const path = readableRunPath(sessionTranscriptPath(session.taskId, session.id));
      seen.add(path);
      let utterances: SessionUtterance[];
      try {
        utterances = await utterancesOf(path);
      } catch {
        // 没跑起来过、文件被清掉了：这条会话里就当没说过话，别的照算。
        fileCache.delete(path);
        return;
      }
      for (const utterance of utterances) {
        const message = toIndexed({
          id: `${session.taskId}:${session.id}:${utterance.index}`,
          taskId: session.taskId,
          sessionId: session.id,
          index: utterance.index,
          // 老会话（写围栏之前跑的）的发言没有时刻，退回会话开始时刻 —— 不编时间，也不让它沉到底。
          at: utterance.at ?? session.startedAt,
        }, utterance.raw);
        if (message) messages.push(message);
      }
    }));
  }
  for (const path of fileCache.keys()) if (!seen.has(path)) fileCache.delete(path);

  messages.sort(compareNewestFirst);
  return { builtAt: Date.now(), messages, tasks: byId };
}

async function currentSnapshot(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.builtAt < FRESH_MS) return snapshot;
  // 同一时刻只刷一份：并发进来的请求等同一次刷新，而不是各自把一万多个文件 stat 一遍。
  building ??= build().then((built) => {
    snapshot = built;
    return built;
  }).finally(() => {
    building = null;
  });
  return building;
}

async function scopeOf(actor: Actor): Promise<(task: TaskRow) => boolean> {
  const visible = await visibleProjectIds(actor);
  const multi = await isMultiUser();
  return (task) => (visible === null || visible.has(task.projectId)) && (!multi || task.ownerUserId === actor.userId);
}

const strip = ({ full: _full, ...message }: IndexedMessage): UserMessage => message;

export async function userMessagePage(
  actor: Actor,
  options: { query: string; cursor?: string | null; limit: number },
): Promise<UserMessagePage> {
  const { messages, tasks: byId } = await currentSnapshot();
  const inScope = await scopeOf(actor);
  const scoped = messages.filter((message) => {
    const task = byId.get(message.taskId);
    return task !== undefined && inScope(task);
  });
  const page = pageMessages(scoped, (taskId) => byId.get(taskId)?.title ?? "", options);
  const taskIds = [...new Set(page.messages.map((message) => message.taskId))];
  const pageTasks: UserMessageTask[] = taskIds.flatMap((taskId) => {
    const task = byId.get(taskId);
    return task ? [{ id: task.id, title: task.title, status: task.status, projectId: task.projectId, archived: task.archived }] : [];
  });
  return { messages: page.messages.map(strip), tasks: pageTasks, next: page.next };
}

export function mountUserMessageRoutes(api: Hono): void {
  // q：空白分词、全都得出现；cursor：上一页回的 next；limit：一页多少条（缺省 USER_MESSAGE_PAGE）。
  api.get("/user-messages", async (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
    return c.json(await userMessagePage(actorOf(c), {
      query: (c.req.query("q") ?? "").trim(),
      cursor: c.req.query("cursor") ?? null,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, PAGE_MAX) : USER_MESSAGE_PAGE,
    }));
  });
}
