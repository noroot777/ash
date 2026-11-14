import {
  coversRead, parseTaskReads,
  type TaskReads, type TaskReadsSnapshot, type TaskReadsWrite, type TaskReadsWriteResult,
} from "@ash/shared/task-reads";
import { ApiError, json, request } from "./apiClient.ts";
import { subscribeConnection, subscribeEvents } from "./events.ts";
import { readRenamedStorage } from "./renamedStorage.ts";
import { createOutbox, type OutboxEntry } from "./taskReadOutbox.ts";

// 「看过哪些任务」的那一份记录：真值在服务端（按人存，server/src/task-reads.ts），这里是它在本页的样子。
// 从前只存 localStorage，每个浏览器各记各的 —— 飞书内置浏览器里打开 ash，桌面上看过的任务全亮着绿点。
//
// 本页的样子 = 服务端那份（known，按 rev 只认新回执）+ 还没被服务端收下的那几眼（待发队列）。
//
//  ① **一页只属于一个账号**。登录关口确认身份时就绑定（AuthGate → bindTaskReadsOwner），此前不看、不记、
//     不送。往上送的每一批都写明账号，服务端认出来的人对不上就 409；回执里的账号对不上也一样 —— 都说明
//     同一个浏览器另一个标签页换了人登录，这一页的一切（任务列表、实时连接）都还是上一个人的，整页重载。
//     没送出去的那几眼留在上一个人名下，他回来登录时照送。
//  ② **看的那一眼当场记下**：记在待发队列（lib/taskReadOutbox.ts）—— 一眼一个键、本页的同时留在内存里，几个
//     标签页同时记不会互相盖掉，存储写不进去也照样送；收下以后才删。所以没送到就关页、刷新、断网重开，下次
//     照送；哪一页先送都行。
//  ③ **新旧只认 round，回执新旧只认 rev**（shared/src/task-reads.ts 文件头）。先发后到的旧回执整份不认。
//  ④ **容量由服务端按「最近看到」裁**，前端不裁 known；待发队列只在攒到上限时丢最早看的那几眼。
//
// 跟上服务端的几条路：绑定后拉一次；服务端说这个人的记录变了（task.reads）再拉；断线重连再拉；拉失败过一会儿
// 再拉；别的标签页往待发队列里记了一笔（storage 事件）也照着更新、顺手帮它送。

const PREFIX = "ash:task-reads-v3:";
const LEGACY_KEY = "ash:task-read-state-v1";
const PUSH_DELAY_MS = 400;
const RETRY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;

let owner: string | null = null;
let outbox: ReturnType<typeof createOutbox> | null = null;
/** 已经认过的最新一份回执的 rev；页面打开时从 -1 起，缓存里的 known 只拿来画首屏。 */
let rev = -1;
let known: TaskReads = {};
let view: TaskReads = {};
const listeners = new Set<() => void>();
let pushTimer: ReturnType<typeof setTimeout> | null = null;
/** 已经排好的那一次推送什么时候发：再要求更早的就提前，不会被一个更晚的排期压着。 */
let pushDue = 0;
let pullTimer: ReturnType<typeof setTimeout> | null = null;
let pushing = false;
let stopSync: (() => void) | null = null;
let leaving = false;

const storage = (): Storage | null => (typeof window === "undefined" ? null : window.localStorage);
const ownerPrefix = (who: string) => `${PREFIX}${who || "local"}`;
const knownKey = (who: string) => `${ownerPrefix(who)}:known`;

function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // known 只是首屏缓存，写不进去下次首屏多亮一下，不丢东西。
  }
}

/** 进库之前的老格式没有 round：从 event 里带的时刻还原（单飞是两个 ISO 时刻，团队是毫秒数）。 */
function legacyRound(event: string): number | null {
  const team = /^team:(\d+)$/.exec(event);
  if (team) return Number(team[1]);
  const times = (event.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? []).map(Date.parse).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

/** 取走老缓存（取完就删）。它不带账号：只有自用模式（只有一个人）才认作他的。 */
function takeLegacy(): Record<string, OutboxEntry> {
  let raw: string | null = null;
  try {
    raw = readRenamedStorage(LEGACY_KEY);
    storage()?.removeItem(LEGACY_KEY);
  } catch {
    return {};
  }
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return {};
  }
  const out: Record<string, OutboxEntry> = {};
  if (!parsed || typeof parsed !== "object") return out;
  for (const [taskId, value] of Object.entries(parsed)) {
    const event = (value as { event?: unknown } | null)?.event;
    const round = typeof event === "string" ? legacyRound(event) : null;
    if (typeof event === "string" && round !== null) out[taskId] = { event, round, at: 0 };
  }
  return out;
}

function compose() {
  const next: TaskReads = { ...known };
  for (const [taskId, { event, round }] of Object.entries(outbox?.latest() ?? {})) {
    if (!coversRead(next[taskId], { event, round })) next[taskId] = { event, round };
  }
  view = next;
  listeners.forEach((listener) => listener());
}

/** 这一页的账号被别的标签页换掉了：这一页的东西全是上一个人的，整页重载。 */
function identityChanged() {
  if (leaving) return;
  leaving = true;
  stopSync?.();
  if (typeof window !== "undefined") window.location.reload();
}

/**
 * 登录关口确认了这一页是谁（自用模式空串）。在任务列表渲染出来之前调用，此后看的每一眼都落在他名下。
 * 同一页换了人只会发生在登录态被别处改掉之后，那时整页重载。
 */
export function bindTaskReadsOwner(who: string) {
  if (owner === who) return;
  if (owner !== null) return identityChanged();
  owner = who;
  outbox = createOutbox(ownerPrefix(who));
  const legacy = takeLegacy();
  if (who === "") for (const [taskId, entry] of Object.entries(legacy)) outbox.add(taskId, entry, entry.at);
  known = parseTaskReads(readJson(knownKey(who)));
  compose();
  ensureSync();
}

export function getTaskReads(): TaskReads {
  return view;
}

function schedulePush(delay = PUSH_DELAY_MS) {
  if (leaving || typeof window === "undefined") return;
  const due = Date.now() + delay;
  if (pushTimer && pushDue <= due) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushDue = due;
  pushTimer = setTimeout(() => { pushTimer = null; void push(); }, delay);
}

function schedulePull() {
  if (pullTimer || leaving || typeof window === "undefined" || !stopSync) return;
  pullTimer = setTimeout(() => { pullTimer = null; void pull(); }, RETRY_MS);
}

/** 待发队列里服务端还没覆盖到的（每个任务取看到的最新一轮）。 */
function unsent(): TaskReads {
  const out: TaskReads = {};
  for (const [taskId, { event, round }] of Object.entries(outbox?.latest() ?? {})) {
    if (!coversRead(known[taskId], { event, round })) out[taskId] = { event, round };
  }
  return out;
}

/**
 * 服务端的回执合进来。rev 不比已经认过的新就不换 known（先发后到的旧回执）。送出去的那几条服务端都已经
 * 表了态（收下、已有更新的、封顶、裁掉、不存在），待发队列里那一轮及更早的一律删掉，别一直重送；送出之后别的
 * 标签页又记下的更新一轮不受影响。
 */
function absorb(result: TaskReadsSnapshot, sent: TaskReads = {}) {
  if (owner === null || outbox === null || leaving) return;
  if (result.owner !== owner) return identityChanged();
  if (typeof result.rev === "number" && result.rev >= rev) {
    rev = result.rev;
    known = parseTaskReads(result.reads);
    writeJson(knownKey(owner), known);
  }
  outbox.settle(sent, known);
  compose();
  if (Object.keys(unsent()).length) schedulePush();
}

async function pull() {
  if (owner === null || leaving) return;
  try {
    absorb(await request<TaskReadsSnapshot>("/task-reads", { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
  } catch {
    schedulePull(); // 读不到先照现有的画，过一会儿再来
  }
}

async function push() {
  if (pushing || owner === null || leaving) return;
  const sent = unsent();
  if (!Object.keys(sent).length) return;
  pushing = true;
  try {
    const body: TaskReadsWrite = { owner, reads: sent };
    const result = await request<TaskReadsWriteResult>("/task-reads", {
      ...json("PUT", body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    pushing = false;
    absorb(result, sent);
  } catch (error) {
    pushing = false;
    if (error instanceof ApiError && error.status === 409) return identityChanged();
    schedulePush(RETRY_MS);
  }
}

function startSync(): () => void {
  let wasConnected = true;
  const offEvents = subscribeEvents((event) => { if (event.type === "task.reads") void pull(); });
  const offConnection = subscribeConnection((connected) => {
    if (connected && !wasConnected) void pull();
    wasConnected = connected;
  });
  const onStorage = (event: StorageEvent) => {
    if (!outbox?.owns(event.key)) return;
    compose();
    // 记下那一笔的标签页可能马上就关了：这一页也帮着送（服务端收两遍是一样的）。
    if (Object.keys(unsent()).length) schedulePush(PUSH_DELAY_MS * 3);
  };
  window.addEventListener("storage", onStorage);
  return () => {
    offEvents();
    offConnection();
    window.removeEventListener("storage", onStorage);
    if (pullTimer) clearTimeout(pullTimer);
    pullTimer = null;
  };
}

/** 有人在看、账号也确认了，才开始跟服务端同步。 */
function ensureSync() {
  if (stopSync || owner === null || leaving || !listeners.size || typeof window === "undefined") return;
  stopSync = startSync();
  void pull();
  if (Object.keys(unsent()).length) schedulePush();
}

export function subscribeTaskReads(listener: () => void) {
  listeners.add(listener);
  ensureSync();
  return () => {
    listeners.delete(listener);
    if (listeners.size || !stopSync) return;
    stopSync();
    stopSync = null;
  };
}

/** 本页看了一眼：比现在记下的新的那几条当场记进待发队列，再攒一下送上去。账号还没确认的页面不记。 */
export function updateTaskReads(update: (current: TaskReads) => TaskReads) {
  if (owner === null || outbox === null || leaving) return;
  const current = view;
  const next = update(current);
  if (next === current) return;
  const changed = Object.entries(next).filter(([taskId, entry]) => !coversRead(current[taskId], entry));
  if (!changed.length) return;
  for (const [taskId, entry] of changed) outbox.add(taskId, entry);
  compose();
  schedulePush();
}
