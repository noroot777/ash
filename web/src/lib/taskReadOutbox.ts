import type { TaskReadEntry, TaskReads } from "@ash/shared/task-reads";
import { TASK_READS_MAX, coversRead, parseTaskReads } from "@ash/shared/task-reads";

// 「看过、还没被服务端收下」的那几眼（lib/taskReadSync.ts 文件头 ②）。两条不变量，各守一类毛病：
//
//  ① **一眼一个键，只增删、不改写。** 键是 `…:p:<任务>:<round>`，值写进去就不再动。同一个浏览器几个标签页
//     同时在看：各写各的键，不存在「读出整份、改完写回」—— 那种写法在两页交错时，后写的那页会拿它读到的
//     旧快照把前一页刚记下的那几眼整个盖掉（审查第 3 轮 F1 实测：两页各记 150 条，只剩一页的）。送到以后
//     也只删「送出去的那一轮及更早的」那几个键，别的页刚记下的更新一轮不受影响。
//  ② **本页记的每一眼同时留在内存里，送没送出去不取决于写没写进磁盘。** 浏览器存储满了、被策略禁了，
//     这一页照样送；写盘失败告警一次，之后每次再记、再收都重试落盘（审查第 3 轮 F2）。磁盘那份只为了
//     「没送到就关了页面」时下次还能补。

export type OutboxEntry = TaskReadEntry & { at: number };

const storage = (): Storage | null => (typeof window === "undefined" ? null : window.localStorage);

export function createOutbox(prefix: string) {
  const keyPrefix = `${prefix}:p:`;
  const keyOf = (taskId: string, round: number) => `${keyPrefix}${encodeURIComponent(taskId)}:${round}`;
  /** 本页记下、还没被服务端表态的；persisted = 已经写进磁盘了。 */
  const memory = new Map<string, { taskId: string; entry: OutboxEntry; persisted: boolean }>();
  let warned = false;

  function persist(key: string, entry: OutboxEntry): boolean {
    try {
      const store = storage();
      if (!store) return false;
      store.setItem(key, JSON.stringify(entry));
      return true;
    } catch (error) {
      if (!warned) {
        warned = true;
        console.warn("[ash] 已读记录写不进浏览器存储：这一页照常同步，但没送到就关掉页面的那几眼补不回来了", error);
      }
      return false;
    }
  }

  function retryPersist() {
    for (const [key, item] of memory) if (!item.persisted) item.persisted = persist(key, item.entry);
  }

  /** 磁盘上这个人的全部那几眼（别的标签页记的也在）。 */
  function stored(): Map<string, { taskId: string; entry: OutboxEntry }> {
    const out = new Map<string, { taskId: string; entry: OutboxEntry }>();
    const store = storage();
    if (!store) return out;
    const keys: string[] = [];
    try {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key?.startsWith(keyPrefix)) keys.push(key);
      }
    } catch {
      return out;
    }
    for (const key of keys) {
      const rest = key.slice(keyPrefix.length);
      const cut = rest.lastIndexOf(":");
      let raw: unknown = null;
      try {
        raw = JSON.parse(store.getItem(key) ?? "null");
      } catch {
        // 坏值当没有，下面顺手删掉
      }
      const taskId = cut > 0 ? decodeURIComponent(rest.slice(0, cut)) : "";
      const entry = parseTaskReads({ [taskId || "_"]: raw })[taskId || "_"];
      if (!taskId || !entry) {
        remove(key);
        continue;
      }
      const at = (raw as { at?: unknown }).at;
      out.set(key, { taskId, entry: { ...entry, at: typeof at === "number" && Number.isFinite(at) ? at : 0 } });
    }
    return out;
  }

  function remove(key: string) {
    memory.delete(key);
    try {
      storage()?.removeItem(key);
    } catch {
      // 删不掉就留着：下次再表态时还会再删
    }
  }

  function all() {
    const items = stored();
    for (const [key, { taskId, entry }] of memory) if (!items.has(key)) items.set(key, { taskId, entry });
    return items;
  }

  return {
    /** storage 事件是不是在说这个人的待发记录。 */
    owns: (key: string | null) => key === null || key.startsWith(keyPrefix),

    /** 记下一眼：先进内存，再尽力落盘；攒过上限丢最早看的。 */
    add(taskId: string, entry: TaskReadEntry, at = Date.now()) {
      const key = keyOf(taskId, entry.round);
      const value: OutboxEntry = { event: entry.event, round: entry.round, at };
      memory.set(key, { taskId, entry: value, persisted: persist(key, value) });
      retryPersist();
      const items = [...all()];
      if (items.length > TASK_READS_MAX) {
        for (const [oldKey] of items.sort((a, b) => b[1].entry.at - a[1].entry.at).slice(TASK_READS_MAX)) remove(oldKey);
      }
    },

    /** 每个任务看到的最新一轮。 */
    latest(): Record<string, OutboxEntry> {
      const out: Record<string, OutboxEntry> = {};
      for (const { taskId, entry } of all().values()) {
        if (!coversRead(out[taskId], entry)) out[taskId] = entry;
      }
      return out;
    },

    /**
     * 服务端表了态：answered 是送出去的那一批（每个任务送的是哪一轮），收下、已有更新的、封顶、裁掉、不存在
     * 都算表了态；known 是服务端此刻那份。删掉送出去的那一轮及更早的、以及服务端已经覆盖到的，其余不碰。
     */
    settle(answered: TaskReads, known: TaskReads) {
      for (const [key, { taskId, entry }] of all()) {
        const sent = answered[taskId];
        if ((sent && entry.round <= sent.round) || coversRead(known[taskId], entry)) remove(key);
      }
      retryPersist();
    },
  };
}
