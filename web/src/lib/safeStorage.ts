// 「尽力而为」的 localStorage：取存储对象、枚举、读、写、删，任何一步抛异常（隐私模式 / 站点策略拒绝访问时
// 连 `window.localStorage` 这个 getter 都会抛 SecurityError，存储满时 setItem 抛 QuotaExceededError）都只当
// 「这一下没存上 / 没读到」，不往上冒。给那些「磁盘只是缓存、内存里另有真值」的调用方用（lib/taskReadOutbox.ts）。

function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export const safeStorage = {
  get(key: string): string | null {
    try {
      return store()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },

  /** 写进去了才返回 true。 */
  set(key: string, value: string): boolean {
    try {
      const target = store();
      if (!target) return false;
      target.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },

  remove(key: string) {
    try {
      store()?.removeItem(key);
    } catch {
      // 删不掉就留着，下次再删
    }
  },

  /** 以 prefix 开头的全部键；枚举到一半出错就返回已经拿到的那些。 */
  keys(prefix: string): string[] {
    const out: string[] = [];
    try {
      const target = store();
      if (!target) return out;
      for (let i = 0; i < target.length; i += 1) {
        const key = target.key(i);
        if (key?.startsWith(prefix)) out.push(key);
      }
    } catch {
      // 见上
    }
    return out;
  },
};
