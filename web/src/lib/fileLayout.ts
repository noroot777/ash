import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { readRenamedStorage } from "./renamedStorage.ts";

// 界面上几份**文件清单**怎么摆：平铺，还是按目录树。
//
// 平铺是一行一个文件，文件名后面跟一截所在目录。改动只有几个、又散在各处时它最快——一眼
// 扫完，不用展开任何东西。但同一个目录下改了十几个文件时，那一截目录就在每一行上重复
// 十几遍，真正要读的文件名反而被挤到左边一小条里。
//
// 目录树按文件夹分层，公共前缀只写一次，还能整个折叠起来。代价是多一层结构，改动很少时
// 纯属绕路。两种各有各的场合，所以给用户自己选，而不是替他定死。
//
// 偏好**全局一份**（跟 `diffLayout` 同一个思路）：这是「我习惯怎么看文件清单」，不是某个
// 面板、某个任务的属性。目前三处清单共用它——任务 inspector 的改动面板、Git 工作台的
// 「更改」、审查页的「改动文件」轨——在哪儿切，另外两处都跟着变。

export type FileListLayout = "flat" | "tree";

const STORAGE_KEY = "ash:file-list-layout";
/** 同一个页面里的多份清单靠它同步；`storage` 事件只跨标签页，本页要自己广播。 */
const SYNC_EVENT = "ash:file-list-layout";

/** 按钮上说的是「按下去会变成什么」，不是「现在是什么」——跟 VSCode 的 View as Tree/List 同约定。 */
export const FILE_LAYOUT_ACTION: Record<FileListLayout, string> = {
  flat: "按平铺列表展示文件",
  tree: "按目录树展示文件",
};

function stored(): FileListLayout {
  try {
    return readRenamedStorage(STORAGE_KEY) === "tree" ? "tree" : "flat";
  } catch {
    // 隐私模式下读 localStorage 会抛，回落到默认即可。
    return "flat";
  }
}

export function useFileListLayout(): [FileListLayout, (next: FileListLayout) => void] {
  const [layout, setLayout] = useState<FileListLayout>(stored);

  useEffect(() => {
    const sync = () => setLayout(stored());
    window.addEventListener("storage", sync);
    window.addEventListener(SYNC_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SYNC_EVENT, sync);
    };
  }, []);

  const change = useCallback((next: FileListLayout) => {
    setLayout(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 存不下也不该影响这一次切换。
    }
    window.dispatchEvent(new Event(SYNC_EVENT));
  }, []);

  return [layout, change];
}

/** 缩进走 CSS 变量而不是内联 padding：每一处清单的基准内边距都不一样。 */
export function indentStyle(depth: number, step = 11): CSSProperties {
  return { "--file-indent": `${depth * step}px` } as CSSProperties;
}

/**
 * 树摊平之后的一行。目录行和文件行混在同一个数组里，按显示顺序排好——渲染方只管挨个画，
 * 不用自己递归，也就不会在每一处清单里各写一遍递归。
 *
 * `items` 是这个目录**递归包含**的全部条目：目录行上的批量操作（整个目录一起暂存/丢弃）
 * 和加减行数合计都要用它。
 */
export type FileTreeRow<T> =
  | { kind: "dir"; key: string; path: string; label: string; depth: number; collapsed: boolean; items: T[] }
  | { kind: "file"; key: string; depth: number; item: T };

interface DirNode<T> {
  path: string;
  name: string;
  dirs: Map<string, DirNode<T>>;
  files: { name: string; item: T }[];
}

function emptyDir<T>(path: string, name: string): DirNode<T> {
  return { path, name, dirs: new Map(), files: [] };
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/** 一个目录递归包含的全部条目，顺序跟展开后看到的一致。 */
function collect<T>(dir: DirNode<T>): T[] {
  const out: T[] = [];
  for (const child of [...dir.dirs.values()].sort(byName)) out.push(...collect(child));
  for (const file of [...dir.files].sort(byName)) out.push(file.item);
  return out;
}

/**
 * 把一批路径摆成树，再摊平成行。
 *
 * **单链目录会压成一行**（`server/src/chat` 而不是三行各缩进一格）：中间那两层既没有别的
 * 文件也没有别的兄弟目录，摊开来只是在浪费三行高度和三级缩进——清单那一栏本来就窄，缩进
 * 越深文件名被切得越狠。VSCode 的 compact folders 是同一个道理。
 *
 * 折叠状态按**压缩之后**的那个路径记（也就是行上真正代表的那个目录），不然折叠一次之后
 * 标签变了、键对不上。
 */
export function buildFileTreeRows<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  collapsed: ReadonlySet<string>,
): FileTreeRow<T>[] {
  const root = emptyDir<T>("", "");
  for (const item of items) {
    const segments = pathOf(item).split("/").filter(Boolean);
    const name = segments.pop() ?? pathOf(item);
    let current = root;
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let next = current.dirs.get(segment);
      if (!next) {
        next = emptyDir<T>(prefix, segment);
        current.dirs.set(segment, next);
      }
      current = next;
    }
    current.files.push({ name, item });
  }

  const rows: FileTreeRow<T>[] = [];
  let seq = 0;
  const walk = (dir: DirNode<T>, depth: number) => {
    for (const child of [...dir.dirs.values()].sort(byName)) {
      let node = child;
      let label = child.name;
      while (node.files.length === 0 && node.dirs.size === 1) {
        const [only] = node.dirs.values();
        label = `${label}/${only.name}`;
        node = only;
      }
      const folded = collapsed.has(node.path);
      rows.push({
        kind: "dir",
        key: `dir:${node.path}`,
        path: node.path,
        label,
        depth,
        collapsed: folded,
        items: collect(node),
      });
      if (!folded) walk(node, depth + 1);
    }
    // 文件排在同级目录之后：先看结构、再看叶子，跟文件树面板一致。
    for (const file of [...dir.files].sort(byName)) {
      // 同一份清单里理论上路径唯一，但改名/复制可能让两行指向同名文件，所以键上带序号。
      rows.push({ kind: "file", key: `file:${dir.path}/${file.name}#${seq++}`, depth, item: file.item });
    }
  };
  walk(root, 0);
  return rows;
}

/** 摊平后的行 + 折叠开关。`enabled` 为 false 时不建树，平铺模式下一点活都不干。 */
export function useFileTreeRows<T>(items: readonly T[], pathOf: (item: T) => string, enabled: boolean) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggle = useCallback((path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);
  const rows = useMemo(
    () => (enabled ? buildFileTreeRows(items, pathOf, collapsed) : []),
    [items, pathOf, collapsed, enabled],
  );
  return { rows, toggle };
}
