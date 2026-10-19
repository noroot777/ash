import { useSyncExternalStore } from "react";

const KEY = "ash.open-in-ide";

/**
 * 「上次真正打开成功的那个 IDE」。
 *
 * 为什么不是组件自己的一个 useState：同一个菜单在页面上有**两份**（文件树头部一份、
 * 文件夹详情一份），各自挂载时读一次 localStorage 就再也不同步了——在详情页用 Cursor
 * 打开过，回到头部的菜单仍然把上一个标成「上次用的」。所以读写都走这里，写完广播，
 * 两份一起更新；`storage` 事件再把多开的标签页捎上。
 */
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

export function readLastIde(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // 隐私模式 / 禁了存储：记不住上次用哪个而已，不影响打开
  }
}

/** 只在**真的打开成功之后**调用——这条标记说的是「上次用的」，不是「上次点过的」。 */
export function rememberIde(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // 写不进去就只是记不住，仍然要广播：这一轮的两份菜单该显示同一个选择
  }
  announce();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // 同一个 key 在别的标签页被改时浏览器只通知**其它**窗口，正好是我们缺的那一半。
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useLastIde(): string | null {
  return useSyncExternalStore(subscribe, readLastIde, () => null);
}
