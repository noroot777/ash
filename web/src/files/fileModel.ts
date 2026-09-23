import { useCallback, useEffect, useRef, useState } from "react";
import { api, type FileEntry, type FileGitStatus, type FileWorkspaceRoot } from "../lib/api.ts";

export const ROOT_SOURCE_LABEL: Record<FileWorkspaceRoot["source"], string> = {
  session: "任务运行目录",
  worktree: "任务 worktree",
  repo: "项目仓库",
};

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * 「这个任务的工作目录被我们自己改了」。
 *
 * 只有一个订阅者（文件树）和一个发布者（中间栏的删除），却仍然走一个小广播：两边是
 * inspector 和中间栏两棵子树里的兄弟组件，没有共同的状态可挂，而删完之后树上那一行必须
 * 当场消失——等 5 秒轮询轮到它，用户看到的是「删了个东西，它还在」。
 */
const treeListeners = new Map<string, Set<() => void>>();

export function fileTreeChanged(taskId: string): void {
  for (const listener of treeListeners.get(taskId) ?? []) listener();
}

function subscribeFileTree(taskId: string, listener: () => void): () => void {
  const set = treeListeners.get(taskId) ?? new Set();
  set.add(listener);
  treeListeners.set(taskId, set);
  return () => {
    set.delete(listener);
    if (!set.size) treeListeners.delete(taskId);
  };
}

const withAdded = (set: ReadonlySet<string>, value: string) => new Set(set).add(value);
const withRemoved = (set: ReadonlySet<string>, value: string) => {
  const next = new Set(set);
  next.delete(value);
  return next;
};

/**
 * 一棵按需展开的目录树。
 *
 * 只在「展开某个目录」时才去问服务端那一层的内容 —— 仓库动辄几万个文件，一次拉全
 * 树既慢又没人看得完。已经拉过的层记在 `loaded` 里，`refresh` 会把它清空后**只重拉
 * 当前展开着的那些层**，避免刷新一下把折叠起来的几十层也顺手拉回来。
 */
export function useFileTree(taskId: string) {
  const [root, setRoot] = useState<FileWorkspaceRoot | null>(null);
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [truncated, setTruncated] = useState<ReadonlySet<string>>(new Set<string>());
  const [git, setGit] = useState<FileGitStatus | null>(null);
  const loaded = useRef(new Set<string>());
  const generation = useRef(0);
  const requests = useRef(new Map<string, number>());
  const expandedRef = useRef<ReadonlySet<string>>(expanded);
  expandedRef.current = expanded;

  const load = useCallback(async (path: string, force = false) => {
    if (!force && loaded.current.has(path)) return;
    const epoch = generation.current;
    const ticket = (requests.current.get(path) ?? 0) + 1;
    requests.current.set(path, ticket);
    const current = () => epoch === generation.current && requests.current.get(path) === ticket;
    loaded.current.add(path);
    setBusy((current) => withAdded(current, path));
    try {
      const listing = await api.taskFiles(taskId, path);
      if (!current()) return;
      if (path === "") {
        setRoot(listing.root);
        setGit(listing.git ?? null);
      }
      setChildren((current) => ({ ...current, [path]: listing.entries }));
      setTruncated((current) => listing.truncated ? withAdded(current, path) : withRemoved(current, path));
      setErrors((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
    } catch (reason) {
      if (!current()) return;
      loaded.current.delete(path);
      setErrors((current) => ({ ...current, [path]: messageOf(reason) }));
      if (path === "") setGit(null);
    } finally {
      if (current()) setBusy((current) => withRemoved(current, path));
    }
  }, [taskId]);

  useEffect(() => {
    generation.current += 1;
    requests.current.clear();
    loaded.current = new Set();
    setRoot(null);
    setChildren({});
    setExpanded(new Set<string>());
    setTruncated(new Set<string>());
    setErrors({});
    setGit(null);
    setBusy(new Set());
    void load("");
    return () => { generation.current += 1; };
  }, [load]);

  const toggle = useCallback((path: string) => {
    setExpanded((current) => {
      if (current.has(path)) return withRemoved(current, path);
      void load(path);
      return withAdded(current, path);
    });
  }, [load]);

  const refresh = useCallback(async () => {
    loaded.current = new Set();
    // 根目录永远要重拉；其余只补当前展开着的那几层。
    const paths = ["", ...expandedRef.current];
    await Promise.all(paths.map((path) => load(path, true)));
  }, [load]);

  useEffect(() => {
    let refreshing = false;
    const tick = async () => {
      if (document.visibilityState !== "visible" || refreshing) return;
      refreshing = true;
      try { await refresh(); } finally { refreshing = false; }
    };
    const timer = window.setInterval(() => void tick(), 5000);
    document.addEventListener("visibilitychange", tick);
    // 自己人改了工作目录（删文件/文件夹）就立刻重拉，不等这一轮 5 秒。
    const unsubscribe = subscribeFileTree(taskId, () => void refresh());
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      unsubscribe();
    };
  }, [refresh, taskId]);

  return {
    root,
    children,
    expanded,
    busy,
    error: Object.values(errors).join("；") || null,
    truncated,
    git,
    refresh,
    toggle,
    /** 展开到某个文件所在的目录（用于「在文件树中定位」）。 */
    revealPath: useCallback((path: string) => {
      const segments = path.split("/").slice(0, -1);
      let prefix = "";
      const dirs: string[] = [];
      for (const segment of segments) {
        prefix = prefix ? `${prefix}/${segment}` : segment;
        dirs.push(prefix);
      }
      setExpanded((current) => {
        const next = new Set(current);
        for (const dir of dirs) next.add(dir);
        return next;
      });
      for (const dir of dirs) void load(dir);
    }, [load]),
  };
}
