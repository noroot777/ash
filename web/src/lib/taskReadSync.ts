import {
  TASK_READS_MAX, coversRead, parseTaskReads,
  type TaskReadEntry, type TaskReads, type TaskReadsSnapshot, type TaskReadsWrite, type TaskReadsWriteResult,
} from "@ash/shared/task-reads";
import { ApiError, json, request } from "./apiClient.ts";
import { subscribeConnection, subscribeEvents } from "./events.ts";
import { readRenamedStorage } from "./renamedStorage.ts";

// 「看过哪些任务」的那一份记录：真值在服务端（按人存，server/src/task-reads.ts），这里是它在本页的样子。
// 从前只存 localStorage，每个浏览器各记各的 —— 飞书内置浏览器里打开 ash，桌面上看过的任务全亮着绿点。
//
// 本页的样子 = 服务端那份（known，按 rev 只认新回执）+ 还没被服务端收下的那几眼（pending）。
//
//  ① **一页只属于一个账号**。登录关口确认身份时就绑定（AuthGate → bindTaskReadsOwner），此前不看、不记、
//     不送。往上送的每一批都写明账号，服务端认出来的人对不上就 409；回执里的账号对不上也一样 —— 都说明
//     同一个浏览器另一个标签页换了人登录，这一页的一切（任务列表、实时连接）都还是上一个人的，整页重载。
//     没送出去的那几眼留在上一个人名下，他回来登录时照送。
//  ② **看的那一眼当场落盘**：pending 按账号存进 localStorage，每次读最新的那份、合进去再写回，几个标签页
//     各写各的不会互相盖掉；收下以后才删。所以没送到就关页、刷新、断网重开，下次照送；哪一页先送都行。
//  ③ **新旧只认 round，回执新旧只认 rev**（shared/src/task-reads.ts 文件头）。先发后到的旧回执整份不认。
//  ④ **容量由服务端按「最近看到」裁**，前端不裁 known；pending 只在攒到上限时丢最早看的那几眼。
//
// 跟上服务端的几条路：绑定后拉一次；服务端说这个人的记录变了（task.reads）再拉；断线重连再拉；拉失败过一会儿
// 再拉；别的标签页往 pending 里记了一笔（storage 事件）也照着更新、顺手帮它送。

const PREFIX = "ash:task-reads-v3:";
const LEGACY_KEY = "ash:task-read-state-v1";
const PUSH_DELAY_MS = 400;
const RETRY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;

type Pending = Record<string, TaskReadEntry & { at: number }>;

let owner: string | null = null;
/** 已经认过的最新一份回执的 rev；页面打开时从 -1 起，缓存里的 known 只拿来画首屏。 */
let rev = -1;
let known: TaskReads = {};
let view: TaskReads = {};
const listeners = new Set<() => void>();
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pullTimer: ReturnType<typeof setTimeout> | null = null;
let pushing = false;
let stopSync: (() => void) | null = null;
let leaving = false;

const storage = (): Storage | null => (typeof window === "undefined" ? null : window.localStorage);
const keyOf = (who: string, part: "known" | "pending") => `${PREFIX}${who || "local"}:${part}`;

function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** 这一页最后写进去的 pending：storage 事件带回来的若正是它，就是自己写的那一笔（同一页里的 iframe 也收得到）。 */
let lastPendingWrite: string | null = null;

function writeJson(key: string, value: unknown) {
  try {
    const raw = JSON.stringify(value);
    if (key.endsWith(":pending")) lastPendingWrite = raw;
    storage()?.setItem(key, raw);
  } catch {
    // 写不进去：这一页照样送，只是关掉之前没送到的那几眼补不回来了。
  }
}

function loadPending(who: string): Pending {
  const raw = readJson(keyOf(who, "pending"));
  const reads = parseTaskReads(raw);
  const out: Pending = {};
  for (const [taskId, entry] of Object.entries(reads)) {
    const at = (raw as Record<string, { at?: unknown }>)[taskId]?.at;
    out[taskId] = { ...entry, at: typeof at === "number" && Number.isFinite(at) ? at : 0 };
  }
  return out;
}

/** 读最新的那份 pending（可能刚被别的标签页改过），改完写回。 */
function editPending(who: string, edit: (current: Pending) => Pending): Pending {
  const next = edit(loadPending(who));
  const entries = Object.entries(next);
  const capped = entries.length > TASK_READS_MAX
    ? Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, TASK_READS_MAX))
    : next;
  writeJson(keyOf(who, "pending"), capped);
  return capped;
}

/** 进库之前的老格式没有 round：从 event 里带的时刻还原（单飞是两个 ISO 时刻，团队是毫秒数）。 */
function legacyRound(event: string): number | null {
  const team = /^team:(\d+)$/.exec(event);
  if (team) return Number(team[1]);
  const times = (event.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? []).map(Date.parse).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

/** 取走老缓存（取完就删）。它不带账号：只有自用模式（只有一个人）才认作他的。 */
function takeLegacy(): Pending {
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
  const out: Pending = {};
  if (!parsed || typeof parsed !== "object") return out;
  for (const [taskId, value] of Object.entries(parsed)) {
    const event = (value as { event?: unknown } | null)?.event;
    const round = typeof event === "string" ? legacyRound(event) : null;
    if (typeof event === "string" && round !== null) out[taskId] = { event, round, at: 0 };
  }
  return out;
}

function compose(pending: Pending) {
  const next: TaskReads = { ...known };
  for (const [taskId, { event, round }] of Object.entries(pending)) {
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
  const legacy = takeLegacy();
  const pending = who === ""
    ? editPending(who, (current) => {
      const merged = { ...current };
      for (const [taskId, entry] of Object.entries(legacy)) if (!coversRead(merged[taskId], entry)) merged[taskId] = entry;
      return merged;
    })
    : loadPending(who);
  known = parseTaskReads(readJson(keyOf(who, "known")));
  compose(pending);
  ensureSync();
}

export function getTaskReads(): TaskReads {
  return view;
}

function schedulePush(delay = PUSH_DELAY_MS) {
  if (pushTimer || leaving || typeof window === "undefined") return;
  pushTimer = setTimeout(() => { pushTimer = null; void push(); }, delay);
}

function schedulePull() {
  if (pullTimer || leaving || typeof window === "undefined" || !stopSync) return;
  pullTimer = setTimeout(() => { pullTimer = null; void pull(); }, RETRY_MS);
}

/** pending 里服务端还没收下的。 */
const unsent = (pending: Pending): TaskReads =>
  Object.fromEntries(Object.entries(pending)
    .filter(([taskId, entry]) => !coversRead(known[taskId], entry))
    .map(([taskId, { event, round }]) => [taskId, { event, round }]));

/**
 * 服务端的回执合进来。rev 不比已经认过的新就不换 known（先发后到的旧回执）。送出去的那几条服务端都已经
 * 表了态（收下、已有更新的、封顶、裁掉、不存在），pending 里还是送出时那一条的，一律删掉，别一直重送。
 */
function absorb(result: TaskReadsSnapshot, sent: TaskReads = {}) {
  if (owner === null || leaving) return;
  if (result.owner !== owner) return identityChanged();
  if (typeof result.rev === "number" && result.rev >= rev) {
    rev = result.rev;
    known = parseTaskReads(result.reads);
    writeJson(keyOf(owner, "known"), known);
  }
  const pending = editPending(owner, (current) => {
    const next: Pending = {};
    for (const [taskId, entry] of Object.entries(current)) {
      const answered = sent[taskId] && sent[taskId].round === entry.round && sent[taskId].event === entry.event;
      if (!answered && !coversRead(known[taskId], entry)) next[taskId] = entry;
    }
    return next;
  });
  compose(pending);
  if (Object.keys(unsent(pending)).length) schedulePush();
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
  const sent = unsent(loadPending(owner));
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
    if (owner === null || event.key !== keyOf(owner, "pending") || event.newValue === lastPendingWrite) return;
    const pending = loadPending(owner);
    compose(pending);
    // 记下那一笔的标签页可能马上就关了：这一页也帮着送（服务端收两遍是一样的）。
    if (Object.keys(unsent(pending)).length) schedulePush(PUSH_DELAY_MS * 3);
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
  if (Object.keys(unsent(loadPending(owner))).length) schedulePush();
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

/** 本页看了一眼：比现在记下的新的那几条当场落盘，再攒一下送上去。账号还没确认的页面不记。 */
export function updateTaskReads(update: (current: TaskReads) => TaskReads) {
  if (owner === null || leaving) return;
  const current = view;
  const next = update(current);
  if (next === current) return;
  const changed = Object.entries(next).filter(([taskId, entry]) => !coversRead(current[taskId], entry));
  if (!changed.length) return;
  const at = Date.now();
  const pending = editPending(owner, (stored) => {
    const merged = { ...stored };
    for (const [taskId, entry] of changed) {
      if (!coversRead(merged[taskId], entry)) merged[taskId] = { event: entry.event, round: entry.round, at };
    }
    return merged;
  });
  compose(pending);
  schedulePush();
}
