import {
  mergeTaskReads, parseTaskReads,
  type TaskReadEntry, type TaskReads, type TaskReadsSnapshot, type TaskReadsWriteResult,
} from "@ash/shared/task-reads";
import { json, request } from "./apiClient.ts";
import { subscribeConnection, subscribeEvents } from "./events.ts";
import { readRenamedStorage } from "./renamedStorage.ts";

// 「看过哪些任务」的那一份记录：真值在服务端（按人存，server/src/task-reads.ts），这里是它在本页的副本。
// 从前只存 localStorage，每个浏览器各记各的 —— 飞书内置浏览器里打开 ash，桌面上看过的任务全亮着绿点。
//
// 三条不变量，各守一类毛病：
//  ① **新旧只认 round**（shared/src/task-reads.ts 文件头）。副本、服务端回执、服务端那份已知状态，合并时
//     各条都取 round 大的那份 —— 先发后到的 GET、晚到的 PUT 回执拿什么回来，都回滚不了已经记下的新一轮。
//  ② **「还没送到」不另记，是算出来的**：副本里比服务端已知那份新的条目就是没送到的。副本按账号写进
//     localStorage，所以没送到就关掉、刷新、断网重开，下次一拉对比出来照样补送；服务端收下以后自然不再算。
//  ③ **缓存按账号分开，账号以服务端说的为准**。GET 回执带 owner；确认之前本页看的几眼先记着，确认之后
//     落到那个账号名下再送 —— 同一个浏览器换了人登录，不会把上一个人看过的东西记到这个人头上。
//     进库之前那份不带账号的老缓存，只有自用模式（只有一个人）才认作他的、补送上去；随后删掉，只做一次。
//
// 跟上服务端的几条路：开始订阅时拉一次；服务端说这个人的记录变了（task.reads）再拉；断线重连再拉；
// 拉失败了过一会儿自己再拉。

const CACHE_PREFIX = "ash:task-reads-v2:";
const LAST_OWNER_KEY = "ash:task-reads-v2-owner";
const LEGACY_KEY = "ash:task-read-state-v1";
const PUSH_DELAY_MS = 400;
const RETRY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** 服务端确认过的账号（自用模式空串）；null = 还没问到。 */
let owner: string | null = null;
let snapshot: TaskReads | null = null;
/** 服务端已知收下的那份（也按 round 只进不退）。 */
let known: TaskReads = {};
/** 账号确认之前本页看的那几眼，确认后在那个账号的副本上重放一遍。 */
let early: ((current: TaskReads) => TaskReads)[] = [];
const listeners = new Set<() => void>();
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pullTimer: ReturnType<typeof setTimeout> | null = null;
let pushing = false;
let stopSync: (() => void) | null = null;

const storage = (): Storage | null => (typeof window === "undefined" ? null : window.localStorage);
const cacheKey = (who: string) => `${CACHE_PREFIX}${who || "local"}`;
const isEmpty = (reads: TaskReads) => Object.keys(reads).length === 0;
const sameEntry = (a: TaskReadEntry | undefined, b: TaskReadEntry | undefined) => a?.event === b?.event && a?.round === b?.round;

function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveCache(who: string, reads: TaskReads) {
  try {
    storage()?.setItem(cacheKey(who), JSON.stringify(reads));
  } catch {
    // 写不进去只是少了首屏缓存和断线补送，服务端那份不受影响。
  }
}

/** 进库之前的老格式没有 round：从 event 里带的时刻还原（单飞是两个 ISO 时刻，团队是毫秒数）。 */
function legacyRound(event: string): number | null {
  const team = /^team:(\d+)$/.exec(event);
  if (team) return Number(team[1]);
  const times = (event.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? []).map(Date.parse).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

/** 取走老缓存（取完就删：它分不清是谁的，只给自用模式用一次）。 */
function takeLegacy(): TaskReads {
  let raw: string | null = null;
  try {
    raw = typeof window === "undefined" ? null : readRenamedStorage(LEGACY_KEY);
    storage()?.removeItem(LEGACY_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const out: TaskReads = {};
  if (!parsed || typeof parsed !== "object") return out;
  for (const [taskId, value] of Object.entries(parsed)) {
    const event = (value as { event?: unknown } | null)?.event;
    const round = typeof event === "string" ? legacyRound(event) : null;
    if (typeof event === "string" && round !== null) out[taskId] = { event, round };
  }
  return parseTaskReads(out);
}

export function getTaskReads(): TaskReads {
  if (snapshot === null) {
    // 首屏先照上次那个账号的缓存画；账号确认之前这份只拿来看，不往上送。
    const last = readJson(LAST_OWNER_KEY);
    snapshot = typeof last === "string" ? parseTaskReads(readJson(cacheKey(last))) : {};
  }
  return snapshot;
}

function publish(next: TaskReads) {
  snapshot = next;
  if (owner !== null) saveCache(owner, next);
  listeners.forEach((listener) => listener());
}

/** 副本里比服务端已知那份新的：就是还没送到的。 */
function unsent(): TaskReads {
  const out: TaskReads = {};
  for (const [taskId, entry] of Object.entries(getTaskReads())) {
    const remote = known[taskId];
    if (!remote || entry.round > remote.round) out[taskId] = entry;
  }
  return out;
}

/** 服务端说了这是谁的那份。头一回、或者换了人：换成那个账号的缓存，把确认之前看的那几眼记到它名下。 */
function adopt(who: string) {
  if (owner === who) return;
  const assumed = readJson(LAST_OWNER_KEY);
  owner = who;
  try {
    storage()?.setItem(LAST_OWNER_KEY, JSON.stringify(who));
  } catch {
    // 只影响下次首屏先照谁的缓存画。
  }
  known = {};
  let base = assumed === who && snapshot !== null ? snapshot : parseTaskReads(readJson(cacheKey(who)));
  const legacy = takeLegacy();
  if (who === "") base = mergeTaskReads(legacy, base);
  if (assumed !== who) base = early.reduce((current, update) => update(current), base);
  early = [];
  publish(base);
}

function schedulePush(delay = PUSH_DELAY_MS) {
  if (pushTimer || typeof window === "undefined") return;
  pushTimer = setTimeout(() => { pushTimer = null; void push(); }, delay);
}

function schedulePull() {
  if (pullTimer || typeof window === "undefined" || !stopSync) return;
  pullTimer = setTimeout(() => { pullTimer = null; void pull(); }, RETRY_MS);
}

/**
 * 服务端的回执合进来。送出去的那几条服务端没照收的，以服务端为准，别一直重送：任务不存在或看不见
 * （rejected）、round 被封顶、或者收下又被裁掉了（它是这个人记录里最旧的那几轮）。
 */
function absorb(result: TaskReadsSnapshot, sent: TaskReads = {}, rejected: string[] = []) {
  adopt(result.owner);
  known = mergeTaskReads(known, parseTaskReads(result.reads));
  const next = { ...getTaskReads() };
  for (const [taskId, entry] of Object.entries(sent)) {
    if (!sameEntry(next[taskId], entry)) continue; // 送出之后本页又看过更新的一轮
    const stored = known[taskId];
    if (rejected.includes(taskId) || !stored) delete next[taskId];
    else if (stored.round < entry.round) next[taskId] = stored;
  }
  publish(mergeTaskReads(next, known));
  if (!isEmpty(unsent())) schedulePush();
}

async function pull() {
  try {
    absorb(await request<TaskReadsSnapshot>("/task-reads", { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
  } catch {
    schedulePull(); // 读不到先照副本画，过一会儿再来
  }
}

async function push() {
  if (pushing || owner === null) return;
  const sent = unsent();
  if (isEmpty(sent)) return;
  pushing = true;
  try {
    const result = await request<TaskReadsWriteResult>("/task-reads", {
      ...json("PUT", { reads: sent }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    pushing = false;
    absorb(result, sent, Array.isArray(result.rejected) ? result.rejected : []);
  } catch {
    pushing = false;
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
  return () => {
    offEvents();
    offConnection();
    if (pullTimer) clearTimeout(pullTimer);
    pullTimer = null;
  };
}

export function subscribeTaskReads(listener: () => void) {
  listeners.add(listener);
  if (!stopSync) {
    stopSync = startSync();
    void pull();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size || !stopSync) return;
    stopSync();
    stopSync = null;
  };
}

/** 本页看了一眼：先改副本，再把没送到的那几条攒一下送上去。 */
export function updateTaskReads(update: (current: TaskReads) => TaskReads) {
  const current = getTaskReads();
  const next = update(current);
  if (next === current) return;
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  if ([...keys].every((taskId) => sameEntry(current[taskId], next[taskId]))) return;
  if (owner === null) early.push(update);
  publish(next);
  schedulePush();
}
