// 「正文里提到的这条路径是不是工作区里真有的文件」的缓存与重查——React 和 HTTP 都不在这里，
// 由 taskFileLocate.ts 接上（这样才能拿假时钟把「过期之后有没有真的重查」钉死）。
//
// 核心不变量：**还挂在屏幕上的路径，答案过期了就重查**，不是只给缓存记一个过期时间。
// agent 常常先说「我要写 docs/plan.md」、过一会儿才真写出来；第一次问的答案是「没有」，
// 而那一处正文一直挂着、不会重挂——只在挂载那一刻问一次，它就永远点不了（审查第 1 轮 F1）。
// 所以每条答案带一个到期时刻，有人在看的那些由一个定时巡检在到期后重新排进下一批。
//
//   • 「有」五分钟复核一次（文件可能被删了）；
//   • 「没有」先 20 秒、再按次数翻倍，封顶两分钟：长会话里那几十处 `fileView.openFile`
//     一类永远不会存在，不该每 20 秒整批再问一遍；
//   • 请求失败（断网、服务端重启）不改答案，只把下次重查排在 20 秒后——一次抖动不该把已经
//     点得开的链接变回普通文字；
//   • 缓存满了只清没人在看的那些。

export type TaskFileTarget = { path: string; kind: "file" | "dir" };
export type LocateEntries = Record<string, TaskFileTarget | null>;

export type Known = {
  value: TaskFileTarget | null;
  /** 过了这一刻，有人在看就重查。 */
  expires: number;
  /** 连着答「没有」的次数，决定下一次隔多久再问。 */
  misses: number;
};

export const HIT_TTL = 5 * 60_000;
export const MISS_TTL = 20_000;
export const MISS_TTL_MAX = 2 * 60_000;
export const SWEEP_MS = 5_000;
const BATCH_WINDOW = 30;
/** 跟服务端 `MAX_LOCATE_PATHS` 同一个数：多了就拆成几批。 */
const BATCH_SIZE = 200;
const MAX_KNOWN = 5000;

type Timers = {
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
};

export function createTaskFileLocator({ locate, now = Date.now, timers, visible = () => true }: {
  locate: (taskId: string, paths: string[]) => Promise<LocateEntries>;
  now?: () => number;
  timers: Timers;
  /** 页面藏在后台时不巡检：没人看的答案过期了也不急着重查。 */
  visible?: () => boolean;
}) {
  const known = new Map<string, Known>();
  const queued = new Map<string, Set<string>>();
  const inflight = new Map<string, Promise<void>>();
  /** 此刻有几处正文挂着这条路径（key → 次数 + 拆开的 taskId/path）。 */
  const watched = new Map<string, { taskId: string; path: string; count: number }>();
  const listeners = new Set<() => void>();
  let flushTimer = 0;
  let sweepTimer = 0;

  const keyOf = (taskId: string, path: string) => `${taskId}\u0000${path}`;
  const fresh = (entry: Known | undefined) => !!entry && now() < entry.expires;
  const emit = () => { for (const listener of listeners) listener(); };

  function evictUnwatched() {
    for (const key of known.keys()) if (!watched.has(key)) known.delete(key);
  }

  function settle(taskId: string, paths: readonly string[], entries: LocateEntries | null) {
    if (known.size > MAX_KNOWN) evictUnwatched();
    const at = now();
    for (const path of paths) {
      const key = keyOf(taskId, path);
      const previous = known.get(key);
      inflight.delete(key);
      if (!entries) {
        known.set(key, { value: previous?.value ?? null, expires: at + MISS_TTL, misses: previous?.misses ?? 0 });
        continue;
      }
      const value = entries[path] ?? null;
      const misses = value ? 0 : (previous && !previous.value ? previous.misses : 0) + 1;
      const ttl = value ? HIT_TTL : Math.min(MISS_TTL * 2 ** (misses - 1), MISS_TTL_MAX);
      known.set(key, { value, expires: at + ttl, misses });
    }
    emit();
  }

  function flush() {
    if (flushTimer) timers.clearTimeout(flushTimer);
    flushTimer = 0;
    for (const [taskId, paths] of queued) {
      const list = [...paths];
      for (let at = 0; at < list.length; at += BATCH_SIZE) {
        const chunk = list.slice(at, at + BATCH_SIZE);
        const done = locate(taskId, chunk)
          .then((entries) => settle(taskId, chunk, entries), () => settle(taskId, chunk, null));
        for (const path of chunk) inflight.set(keyOf(taskId, path), done);
      }
    }
    queued.clear();
  }

  function want(taskId: string, path: string) {
    const key = keyOf(taskId, path);
    if (fresh(known.get(key)) || inflight.has(key)) return;
    const paths = queued.get(taskId) ?? new Set<string>();
    paths.add(path);
    queued.set(taskId, paths);
    if (!flushTimer) flushTimer = timers.setTimeout(flush, BATCH_WINDOW);
  }

  /** 把有人在看、又已经过期的那些排进下一批。 */
  function sweep() {
    sweepTimer = 0;
    if (!watched.size) return;
    if (visible()) for (const { taskId, path } of watched.values()) want(taskId, path);
    sweepTimer = timers.setTimeout(sweep, SWEEP_MS);
  }

  return {
    peek: (taskId: string, path: string) => known.get(keyOf(taskId, path)),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** 一处正文挂上这条路径：马上问（没答案或过期时），之后过期了自动重查，直到它卸下来。 */
    watch(taskId: string, path: string) {
      const key = keyOf(taskId, path);
      const current = watched.get(key);
      if (current) current.count += 1;
      else watched.set(key, { taskId, path, count: 1 });
      want(taskId, path);
      if (!sweepTimer) sweepTimer = timers.setTimeout(sweep, SWEEP_MS);
      return () => {
        const entry = watched.get(key);
        if (entry && --entry.count <= 0) watched.delete(key);
      };
    },
    /** 页面从后台切回来：不等下一次巡检。 */
    revisit: () => { if (visible()) for (const { taskId, path } of watched.values()) want(taskId, path); },
    /** 点下去的那一刻还没问到时用：不等攒批，马上问。 */
    async locateNow(taskId: string, path: string): Promise<TaskFileTarget | null> {
      const key = keyOf(taskId, path);
      const entry = known.get(key);
      if (fresh(entry)) return entry!.value;
      want(taskId, path);
      if (queued.size) flush();
      await inflight.get(key);
      return known.get(key)?.value ?? null;
    },
  };
}
