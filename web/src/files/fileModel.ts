import { useCallback, useEffect, useRef, useState } from "react";
import { api, type FileEntry, type FileWorkspaceRoot } from "../lib/api.ts";

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
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState<ReadonlySet<string>>(new Set<string>());
  const loaded = useRef(new Set<string>());
  const expandedRef = useRef<ReadonlySet<string>>(expanded);
  expandedRef.current = expanded;

  const load = useCallback(async (path: string, force = false) => {
    if (!force && loaded.current.has(path)) return;
    loaded.current.add(path);
    setBusy((current) => withAdded(current, path));
    try {
      const listing = await api.taskFiles(taskId, path);
      setRoot(listing.root);
      setChildren((current) => ({ ...current, [path]: listing.entries }));
      setTruncated((current) => listing.truncated ? withAdded(current, path) : withRemoved(current, path));
      setError(null);
    } catch (reason) {
      loaded.current.delete(path);
      setError(messageOf(reason));
    } finally {
      setBusy((current) => withRemoved(current, path));
    }
  }, [taskId]);

  useEffect(() => {
    loaded.current = new Set();
    setRoot(null);
    setChildren({});
    setExpanded(new Set<string>());
    setTruncated(new Set<string>());
    setError(null);
    void load("");
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

  return {
    root,
    children,
    expanded,
    busy,
    error,
    truncated,
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
