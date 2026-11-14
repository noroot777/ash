import { parseTaskReads, trimTaskReads, type TaskReads } from "@ash/shared/task-reads";
import { json, request } from "./apiClient.ts";
import { subscribeConnection, subscribeEvents } from "./events.ts";
import { readRenamedStorage } from "./renamedStorage.ts";

// 「看过哪些任务」的那一份记录：真值在服务端（按人存，server/src/task-reads.ts），这里是它在
// 本页的副本。从前只存 localStorage，每个浏览器各记各的 —— 飞书内置浏览器里打开 ash，桌面上
// 看过的任务全亮着绿点。localStorage 留着当首屏缓存：服务端那份读回来之前先照它画，免得一刷新
// 满屏亮一下再熄。
//
// 三条路让这份副本跟上服务端：开始订阅时拉一次；服务端说「这个人的记录变了」（task.reads，另一台
// 设备看了一眼）再拉；断线重连后再拉。本页看了一眼，先改副本、攒一小会儿再整批 PUT 上去。
//
// 副本 = 服务端那份 + 本页还没送到的几条（叠在上面）。不拿两边的 readAt 比谁新：那是各台设备自己
// 的钟，一台钟快的设备会拿它看过的旧一轮把别人刚看的新一轮盖回去，绿点又亮起来。

const STORAGE_KEY = "ash:task-read-state-v1";
const PUSH_DELAY_MS = 400;
const RETRY_MS = 5_000;

let snapshot: TaskReads | null = null;
const listeners = new Set<() => void>();
/** 本页看过、还没交出去的几条；inFlight = 正在送的那一批（送到之前照样叠在副本上，免得闪一下）。 */
let pending: TaskReads = {};
let inFlight: TaskReads = {};
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let stopSync: (() => void) | null = null;
/** 本机缓存里的老记录补送过没有（只在头一回拉到服务端那份时做一次）。 */
let migrated = false;

function loadCache(): TaskReads {
  if (typeof window === "undefined") return {};
  try {
    const raw = readRenamedStorage(STORAGE_KEY);
    return raw ? parseTaskReads(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function saveCache(reads: TaskReads) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reads));
  } catch {
    // 缓存只是首屏用的，写不进去不影响服务端那份。
  }
}

export function getTaskReads(): TaskReads {
  if (snapshot === null) snapshot = loadCache();
  return snapshot;
}

function publish(next: TaskReads) {
  snapshot = next;
  saveCache(next);
  listeners.forEach((listener) => listener());
}

const sameEntry = (a: TaskReads[string] | undefined, b: TaskReads[string] | undefined) =>
  a?.event === b?.event && a?.readAt === b?.readAt;

const isEmpty = (reads: TaskReads) => Object.keys(reads).length === 0;
const withLocal = (server: TaskReads): TaskReads => trimTaskReads({ ...server, ...inFlight, ...pending });

function schedulePush(delay = PUSH_DELAY_MS) {
  if (pushTimer || typeof window === "undefined") return;
  pushTimer = setTimeout(() => { pushTimer = null; void push(); }, delay);
}

async function push() {
  if (!isEmpty(inFlight) || isEmpty(pending)) return;
  inFlight = pending;
  pending = {};
  try {
    const { reads } = await request<{ reads: unknown }>("/task-reads", json("PUT", { reads: inFlight }));
    inFlight = {};
    publish(withLocal(parseTaskReads(reads)));
  } catch {
    pending = { ...inFlight, ...pending };
    inFlight = {};
    schedulePush(RETRY_MS);
    return;
  }
  if (!isEmpty(pending)) schedulePush();
}

/** 把服务端那份拉回来，本页没送到的几条叠在上面。 */
async function pull() {
  let server: TaskReads;
  try {
    server = parseTaskReads((await request<{ reads: unknown }>("/task-reads")).reads);
  } catch {
    return; // 读不到就先照副本画，重连或下一条信号再来。
  }
  if (!migrated) {
    migrated = true;
    // 进库之前只记在这台浏览器里的那些：服务端一条都没有的补送上去。服务端有的以它为准（理由见文件头）。
    const legacy = Object.fromEntries(Object.entries(getTaskReads()).filter(([taskId]) => !server[taskId]));
    pending = { ...legacy, ...pending };
  }
  publish(withLocal(server));
  if (!isEmpty(pending)) schedulePush();
}

function startSync(): () => void {
  void pull();
  let wasConnected = true;
  const offEvents = subscribeEvents((event) => { if (event.type === "task.reads") void pull(); });
  const offConnection = subscribeConnection((connected) => {
    if (connected && !wasConnected) void pull();
    wasConnected = connected;
  });
  return () => { offEvents(); offConnection(); };
}

export function subscribeTaskReads(listener: () => void) {
  listeners.add(listener);
  if (!stopSync) stopSync = startSync();
  return () => {
    listeners.delete(listener);
    if (listeners.size || !stopSync) return;
    stopSync();
    stopSync = null;
  };
}

/** 本页看了一眼：先改副本，变了的那几条攒一下送上去。 */
export function updateTaskReads(update: (current: TaskReads) => TaskReads) {
  const current = getTaskReads();
  const next = update(current);
  if (next === current) return;
  const changed: TaskReads = {};
  for (const [taskId, entry] of Object.entries(next)) {
    if (!sameEntry(current[taskId], entry)) changed[taskId] = entry;
  }
  if (isEmpty(changed) && Object.keys(next).length === Object.keys(current).length) return;
  publish(next);
  if (isEmpty(changed)) return;
  pending = { ...pending, ...changed };
  schedulePush();
}
