import type { FileSearchHit } from "./api.ts";

// `@` 菜单里那张列表的形状。纯函数，好单测（useFileMention 只管取数和键盘）。
//
// 两种形状，同一套行：
//   浏览态（token 为空或以 `/` 结尾）——**真的一棵树**：一次只列一层，目录能就地展开，
//     子项缩进挂在下面。一屏平铺四十条互不相干的路径，人是读不过来的；层级至少告诉你
//     「这几条是一家的」。
//   搜索态（敲了字）——按目录归堆：同一个目录的命中挤在一个目录头下面，路径只写一次。
//     排序仍按相关度（组的先后 = 组内最高分那条的先后），只是把同家的聚到一起。
//
// 搜索态的目录头**不可展开**：展开出来的子项会跟它下面的命中项重复，一条路径在同一张
// 列表里出现两次比没有树还糟。想往下翻就敲 `/` 进浏览态，那是它该干的活。

export interface MentionTreeRow {
  hit: FileSearchHit;
  /** 缩进层级，0 = 最外层。 */
  depth: number;
  /** 目录且这会儿能展开（只有浏览态给）。 */
  expandable: boolean;
  expanded: boolean;
  /** 展开了但子项还在路上。 */
  loading?: boolean;
  /**
   * 名字后面要不要再灰着写一遍所在目录。搜索态要（三个 `index.ts` 全靠它分辨），浏览态
   * 不要 —— 目录就摆在这一行的上面，再写一遍纯属噪音（`apiClient.ts src/lib/`）。
   */
  showDir?: boolean;
  /**
   * 只是个**分组标签**，不能被选中。搜索态的目录头就是这种：它存在是为了「这几条是一家
   * 的」看得出来，而不是给人选的 —— 敲完几个字母直接回车是最常走的那条路，第一行要是
   * 个目录头，用户就会一路把目录插进正文。
   */
  label?: boolean;
}

/** 展开深度的护栏：expanded 是用户点出来的，但别让一条环形软链把渲染带进无底洞。 */
const MAX_TREE_DEPTH = 10;

/**
 * 浏览态：从根那一层开始，把展开的目录就地摊平成带 depth 的行。
 *
 * @param levels 每个目录的直接子项（键是目录路径，根是 `""`）
 * @param expanded 用户展开着的目录路径
 */
export function browseRows(
  rootDir: string,
  levels: Map<string, FileSearchHit[]>,
  expanded: Set<string>,
): MentionTreeRow[] {
  const rows: MentionTreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_TREE_DEPTH) return;
    for (const hit of levels.get(dir) ?? []) {
      const isDir = hit.kind === "dir";
      const open = isDir && expanded.has(hit.path);
      const children = levels.get(hit.path);
      rows.push({ hit, depth, expandable: isDir, expanded: open, loading: open && !children });
      if (open && children) walk(hit.path, depth + 1);
    }
  };
  walk(rootDir, 0);
  return rows;
}

/** 一条合成的目录头：搜索结果里只有文件，它们的目录得自己补出来当组头。 */
function dirRow(path: string): FileSearchHit {
  const at = path.lastIndexOf("/");
  return {
    path,
    name: at < 0 ? path : path.slice(at + 1),
    dir: at < 0 ? "" : path.slice(0, at),
    kind: "dir",
  };
}

/** 搜索态：按目录归堆。组的先后跟着组内第一条命中走，所以相关度顺序不会被打乱。 */
export function searchRows(hits: FileSearchHit[]): MentionTreeRow[] {
  const groups = new Map<string, { header?: FileSearchHit; files: FileSearchHit[] }>();
  const order: string[] = [];
  const groupOf = (dir: string) => {
    let group = groups.get(dir);
    if (!group) {
      group = { files: [] };
      groups.set(dir, group);
      order.push(dir);
    }
    return group;
  };
  for (const hit of hits) {
    // 目录本身也是候选：它当自己那一堆的组头，省得同一条路径出现两次。
    if (hit.kind === "dir") groupOf(hit.path).header = hit;
    else groupOf(hit.dir).files.push(hit);
  }

  const rows: MentionTreeRow[] = [];
  for (const dir of order) {
    const group = groups.get(dir)!;
    // 根下的文件没有组头，本来就在最外层。
    if (dir) {
      rows.push({
        hit: group.header ?? dirRow(dir),
        depth: 0,
        expandable: false,
        expanded: false,
        showDir: true,
        label: true,
      });
    }
    for (const hit of group.files) {
      rows.push({ hit, depth: dir ? 1 : 0, expandable: false, expanded: false, showDir: !dir });
    }
  }
  return rows;
}

/**
 * 左右键在树里该干什么。**不碰任何状态**，只回一个动作 —— 因为同一棵树会挂在两种列表
 * 里：只有文件的那几个表面，和单飞对话框那张「智能体 + 文件」的合并列表。后者的下标空
 * 间跟树自己的不一样，所以「选到哪一行」只能由拥有那张列表的人自己落地。
 *
 * @param index 选中项在 rows 里的下标（合并列表要先减掉前面那些智能体）
 */
export function treeKeyAction(
  key: string,
  rows: MentionTreeRow[],
  index: number,
): { type: "expand" | "collapse"; dir: string } | { type: "select"; index: number } | null {
  const row = rows[index];
  if (!row) return null;
  if (key === "ArrowRight") {
    if (!row.expandable) return null; // 不是目录就让光标照常右移
    // 已经展开了，右键就是「进去」——走到第一个子项。
    return row.expanded
      ? { type: "select", index: Math.min(index + 1, rows.length - 1) }
      : { type: "expand", dir: row.hit.path };
  }
  if (key === "ArrowLeft") {
    if (row.expandable && row.expanded) return { type: "collapse", dir: row.hit.path };
    // 收着的话就跳回爹那一行（缩进比自己浅的最近一行）。爹是个不可选的分组标签、
    // 或者压根没有爹，就让光标照常左移。
    const parent = rows.slice(0, index).findLastIndex((other) => other.depth < row.depth);
    return parent < 0 || rows[parent]?.label ? null : { type: "select", index: parent };
  }
  return null;
}

/**
 * 上下键走一格，跳过不可选的行（分组标签）。环着走，跟原来一样。
 * 两张列表共用：只有文件的那几个表面，和「智能体 + 文件」的合并列表。
 */
export function stepIndex(
  count: number,
  from: number,
  delta: number,
  selectable: (at: number) => boolean,
): number {
  let at = from;
  for (let step = 0; step < count; step += 1) {
    at = (at + delta + count) % count;
    if (selectable(at)) return at;
  }
  return from;
}

/** 第一个能选的位置（列表全是标签时回 0，反正也没人选得动）。 */
export function firstSelectable(count: number, selectable: (at: number) => boolean): number {
  for (let at = 0; at < count; at += 1) if (selectable(at)) return at;
  return 0;
}
