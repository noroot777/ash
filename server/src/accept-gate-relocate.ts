import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { copyLink, insideTree } from "./accept-gate-tree.js";

// 把一棵依赖树搬进快照时，**每一条软链都得重新决定指向哪里**。这个模块只做这件事，判据统一在
// counterpart 一处，复制和对账都从它出来——2026-10-26 独立审查打回来的三处失败都是「复制那一侧
// 自己猜，对账那一侧又用另一套判据」造成的：
//
//   · 按路径后缀猜包身份：一个第三方依赖恰好装在 packages/lib，就被当成项目自己声明的那个包改写
//     过去（实测 before=FOREIGN → after=CERTIFIED，而快照自证照旧通过）。后缀不是身份。
//   · 抹掉尾部分隔符：`/path/to/file/` 这种原文在源端原生读是 ENOTDIR，而 dirname/basename/join
//     会把那个分隔符吃掉，于是副本里它反而读得通（before=ENOTDIR → after=VALUE）。本地失败的用例
//     到门禁里成功，比反过来更难发现。
//   · 相对外链搬到不同深度：原文照抄，副本里就指不到原来那个外部包了（before 可读 → after
//     ENOENT）。本地跑得通的测试在门禁里找不到文件。
//
// 共同点是**没有保持落点身份**。所以这里一律先算原生落点（realpath，末段不解析），再按落点分四
// 类决定新原文；对账则独立地把两侧落点各算一遍做比较，而不是看文本像不像。
export type Relocation = {
  /** 项目根（realpath 过的）。 */
  realRoot: string;
  /** 快照根（调用方给的原样路径：目的地链的相对原文要相对它算）。 */
  target: string;
  /** 被搬运的那棵依赖树的真实根。 */
  treeRoot: string;
  /** 那棵树在快照里的位置。 */
  treeDest: string;
  /** 声明的 workspace 包目录 → 包名。改写前要用它验证目标身份。 */
  identity: Record<string, string>;
};

const fold = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);

async function packageName(root: string): Promise<string | null> {
  const raw = await readFile(join(root, "package.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const name = (JSON.parse(raw) as { name?: unknown }).name;
    return typeof name === "string" && name !== "" ? name : null;
  } catch { return null; }
}

/**
 * 这个落点是某个**声明过的** workspace 包（或它内部的文件）吗？是就给出它在快照里的位置。
 *
 * 两道关，缺一不可：
 *   ① 路径尾部要匹配声明里的某个包目录——这一条让「依赖树借自另一个检出」也能落回快照自己那份
 *     （Windows 的 npm 把 workspace 链接建成绝对 junction，指的是那个检出的源码）；
 *   ② 那个目录的 `package.json.name` 要**确实是**声明里记的那个包名。只有①会把一个恰好装在
 *     `packages/lib` 的第三方依赖替换成项目自己的包——那不是「更隔离」，那是换掉了被测的代码。
 */
async function workspaceCounterpart(landing: string, relocation: Relocation): Promise<string | null> {
  const folded = fold(landing);
  // 长的先试：声明里若有 packages/lib 和 packages/lib/inner 这种嵌套，该取更具体的那个。
  const dirs = Object.keys(relocation.identity).sort((left, right) => right.length - left.length);
  for (const dir of dirs) {
    const marker = `${sep}${dir.split("/").join(sep)}`;
    const foldedMarker = fold(marker);
    const at = folded.endsWith(foldedMarker)
      ? folded.length - foldedMarker.length
      : folded.lastIndexOf(`${foldedMarker}${sep}`);
    if (at < 0) continue;
    if (await packageName(landing.slice(0, at + marker.length)) !== relocation.identity[dir]) continue;
    return join(relocation.target, landing.slice(at + 1));
  }
  return null;
}

/** 这个原生落点在快照里**应该**对应哪个位置。外部落点的身份就是它自己，所以原样返回。 */
export async function counterpart(landing: string, relocation: Relocation): Promise<string> {
  // 顺序要紧：依赖树自己先判。树通常就装在项目内，若先判项目就会把树内条目映射到源码那一侧去。
  if (insideTree(relocation.treeRoot, landing) || landing === relocation.treeRoot) {
    return join(relocation.treeDest, relative(relocation.treeRoot, landing));
  }
  if (insideTree(relocation.realRoot, landing)) {
    return join(relocation.target, relative(relocation.realRoot, landing));
  }
  return (await workspaceCounterpart(landing, relocation)) ?? landing;
}

const inSnapshot = (path: string, relocation: Relocation) =>
  path === relocation.target || insideTree(relocation.target, path);

/**
 * 这条链在副本里的新原文。
 *
 * 四类落点四种办法：依赖树内部的相对原文照抄（快照里结构一致，照抄同时保住文本和惰性解析）；
 * 树内的绝对原文、项目源码、声明过的 workspace 包都改写到快照内对应位置（相对目的地写，这样整个
 * 快照还能整体搬走）；落在快照外的一律写**绝对**路径指向原落点——相对原文照抄到不同深度就指空了，
 * 那是本地跑得通、门禁里 ENOENT 的来源。父目录都解析不到的（悬空、环）照抄，保持原样不可达。
 *
 * 尾部分隔符最后原样补回：`…/file/` 在源端原生读是 ENOTDIR，把它吃掉会让副本反而读得通。
 */
export async function relocatedTarget(source: string, destination: string,
  relocation: Relocation): Promise<string> {
  const raw = await readlink(source);
  const trailing = /[/\\]$/.test(raw);
  const bare = trailing ? raw.replace(/[/\\]+$/, "") : raw;
  const full = isAbsolute(bare) ? bare : resolve(dirname(source), bare);
  const parent = await realpath(dirname(full)).catch(() => null);
  if (parent === null) return raw;
  const landing = join(parent, basename(full));
  const where = await counterpart(landing, relocation);
  const next = insideTree(relocation.treeRoot, landing) && !isAbsolute(bare)
    ? bare
    : (inSnapshot(where, relocation) ? relative(dirname(destination), where) : where);
  return trailing ? `${next}${sep}` : next;
}

export type CopyOptions = {
  /** 数据块共享（macOS clonefile / Linux reflink）。内核在不支持的文件系统上自动退回整块复制。 */
  clone?: boolean;
  /** 给定时按 relocatedTarget 决定每条链的新原文；不给就照抄原文。 */
  relocate?: Relocation;
  /** 这条源路径要不要跳过。源码侧那份排除计划同款，用来挡住运行产物。 */
  skip?: (path: string) => boolean;
  /** 快照根的真实路径。遍历绝不进入它——目标不能变成自己的输入。 */
  snapshotRoot?: string;
};

/**
 * 把一棵树复制一遍：克隆形态的实现，同时是借用建不出来时的退路。
 *
 * 不走 gateTreeDigest：那条路对**树外**的可达链是「跟随并把目标内容冻进快照」（源码外链该那么
 * 办），用在依赖目录上会把 .venv/bin/python -> /opt/homebrew/… 指向的整个解释器拷进来。这里一律
 * 按链重建、绝不跟随。
 */
export async function copyTree(source: string, destination: string, options: CopyOptions = {}): Promise<void> {
  if (options.skip?.(source) === true) return;
  // 包管理器随时在改依赖树：读完目录到读条目之间文件被删掉不该崩掉整次快照。
  const info = await lstat(source).catch(() => null);
  if (info === null) return;
  if (info.isSymbolicLink()) {
    const target = options.relocate === undefined
      ? await readlink(source)
      : await relocatedTarget(source, destination, options.relocate);
    return await copyLink(source, destination, target);
  }
  if (info.isDirectory()) {
    // 目标绝不能进入自己的输入闭包：ASH_RUNS_DIR 落在依赖目录内时（它是可配的），遍历会走进正在
    // 建的那个快照，再把快照里已经建好的依赖树拷一遍，一层层嵌套到路径过长为止，一个测试命令都
    // 还没开始跑。按**落点**判而不是按字面路径，因为中间任意一层都可能是链。只在目录上做，文件
    // 不可能是谁的祖先。
    if (options.snapshotRoot !== undefined) {
      const real = await realpath(source).catch(() => null);
      if (real !== null && (real === options.snapshotRoot || insideTree(options.snapshotRoot, real))) return;
    }
    await mkdir(destination, { recursive: true });
    for (const name of (await readdir(source)).sort()) {
      await copyTree(join(source, name), join(destination, name), options);
    }
    return;
  }
  if (!info.isFile()) return;
  await copyFile(source, destination, options.clone === true ? constants.COPYFILE_FICLONE : 0);
  await chmod(destination, info.mode);
}

/**
 * 搬迁后的链闭包核验：副本里每一条链的落点，都必须是源端那条链落点在快照里的对应位置。
 *
 * 这是对**执行等价性**的核验，不是看原文文本像不像——「原文照抄」恰恰是相对外链失效的原因，而
 * 「根在快照里」也不能证明树内每条链都还指得对。两侧各自 realpath 一次再比，所以它独立于复制那
 * 一侧算得对不对：复制错了（猜身份、吃掉分隔符、照抄相对外链）这里都对不上账。
 *
 * 不跟随链递归（lstat 的类型直接用 readdir 给的），所以遍历量就是副本树的条目数，链本身通常只有
 * 几十条。
 */
export async function linkMismatch(relocation: Relocation): Promise<string | null> {
  const check = async (path: string): Promise<string | null> => {
    const from = await realpath(join(relocation.treeRoot, path)).catch(() => null);
    const to = await realpath(join(relocation.treeDest, path)).catch(() => null);
    if (from === null) {
      return to === null ? null : `${path} 在工作区里解析不出东西来，副本里却落在了 ${to}`;
    }
    const want = await counterpart(from, relocation);
    const real = await realpath(want).catch(() => null);
    if (to === real) return null;
    return `${path} 在工作区落在 ${from}，副本里却落在 ${to ?? "解析不出来"}（应当对应 ${want}）`;
  };
  const walk = async (sub: string): Promise<string | null> => {
    for (const entry of await readdir(join(relocation.treeDest, sub), { withFileTypes: true }).catch(() => [])) {
      const path = sub === "" ? entry.name : join(sub, entry.name);
      const problem = entry.isSymbolicLink() ? await check(path)
        : entry.isDirectory() ? await walk(path) : null;
      if (problem !== null) return problem;
    }
    return null;
  };
  return await walk("");
}
