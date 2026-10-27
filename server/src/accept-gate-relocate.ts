import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { copyLink, insideTree, linkLanding, linkTarget } from "./accept-gate-tree.js";

// 把一棵依赖树搬进快照时,**每一条软链都得重新决定指向哪里**。这个模块只做这件事,判据统一在
// counterpart 一处,复制和对账都从它出来。
//
// 两条铁律是被实测打回来换来的,别再各自为政:
//
// ① **归属只认安装记录,不认路径长得像不像。** 曾经用「路径后缀匹配 + package.json.name 相等」
//    猜一个落点是不是项目自己的 workspace 包。真实 npm 离线安装的反例:根项目声明 packages/*、
//    自有 packages/lib 叫 @demo/lib@1.0.0;另一个独立目录 foreign/packages/lib 也叫 @demo/lib,
//    版本 9.0.0,以 `file:` 装成逻辑依赖。后缀同、包名同,于是它被改写成项目自己那份——本地
//    import 得到 FOREIGN_V9,门禁里得到 CERTIFIED,而快照自证照旧通过。**换掉了被测的代码,还
//    报了绿**。两个同名包是合法的,名字从来不是来源。现在只认安装器自己写下的 resolved(见
//    OwnedPackage):它指向项目内就是自有包,指向项目外就不是,没有记录就不改写。
//
// ② **落点只由原生调用给出,这里一个字符都不自己解释。** 曾经用 /[/\\]$/ 判尾部分隔符、用词法
//    resolve 算落点,于是 POSIX 上以字面 `\` 结尾的文件名被当成「带分隔符」剥掉(本地读得通的
//    链在门禁里报「依赖没放对」),穿链之后的 `..` 被提前消掉(原生先穿 bridge 再回上级读到
//    store/entry.mjs,词法消掉后指向另一个 entry.mjs)。accept-gate-tree 的 linkLanding 早就把
//    这三种平台语义处理对了,这里再实现一遍就是把同一个不变量劈成两份——现在一律从那里拿。
export type OwnedPackage = {
  /** 相对依赖树根的入口路径,如 `@demo/lib`。 */
  entry: string;
  /** 相对被冻结项目根的包目录，由安装来源与仓库身份对齐，不按包名猜。 */
  inside: string;
  /** 工作区里这个入口的真实落点。改写只认它。 */
  landing: string;
};

export type Relocation = {
  /** 项目根（realpath 过的）。 */
  realRoot: string;
  /** 快照根（调用方给的原样路径：目的地链的相对原文要相对它算）。 */
  target: string;
  /** 被搬运的那棵依赖树的真实根。 */
  treeRoot: string;
  /** 那棵树在快照里的位置。 */
  treeDest: string;
  /** 安装记录认下的自有包。**空数组 = 没有可证明的归属,一条都不改写**(理由见上面①)。 */
  owned: OwnedPackage[];
};

const fold = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);

/**
 * 这个落点是安装记录认下的某个自有包（或它内部的文件）吗？是就给出它在快照里的位置。
 *
 * 比的是**落点**:借自另一个检出的依赖树,它的 workspace 链指着那个检出的源码(Windows 的 npm
 * 把这种链建成绝对 junction),安装记录里的 resolved 仍然把它认成「项目内的 packages/lib」,于是
 * 这里把它接回快照自己那份。而一个碰巧同名同形状的第三方包不在记录里,原样保留。
 */
function ownedCounterpart(landing: string, relocation: Relocation): string | null {
  // 长的先试:packages/lib 和 packages/lib/inner 各自成包时,该取更具体的那一个。
  const owned = [...relocation.owned].sort((left, right) => right.landing.length - left.landing.length);
  for (const pkg of owned) {
    if (fold(landing) === fold(pkg.landing)) return join(relocation.target, pkg.inside);
    if (insideTree(pkg.landing, landing)) {
      return join(relocation.target, pkg.inside, relative(pkg.landing, landing));
    }
  }
  return null;
}

/** 这个原生落点在快照里**应该**对应哪个位置。无从证明归属的落点身份就是它自己，所以原样返回。 */
export function counterpart(landing: string, relocation: Relocation): string {
  // 顺序要紧：依赖树自己先判。树通常就装在项目内，若先判项目就会把树内条目映射到源码那一侧去。
  if (insideTree(relocation.treeRoot, landing) || landing === relocation.treeRoot) {
    return join(relocation.treeDest, relative(relocation.treeRoot, landing));
  }
  if (insideTree(relocation.realRoot, landing)) {
    return join(relocation.target, relative(relocation.realRoot, landing));
  }
  return ownedCounterpart(landing, relocation) ?? landing;
}

const inSnapshot = (path: string, relocation: Relocation) =>
  path === relocation.target || insideTree(relocation.target, path);

/**
 * 这条链在副本里的新原文。
 *
 * 落点和可达性全部来自 linkLanding（原生语义，理由见顶部②）。四类落点四种办法：依赖树内部的
 * 相对原文照抄（快照里结构一致，照抄同时保住文本和惰性解析）；树内的绝对原文、项目源码、安装
 * 记录认下的自有包都改写到快照内对应位置（相对目的地写，这样整个快照还能整体搬走）；落在快照
 * 外的一律写**绝对**路径指向原落点——相对原文照抄到不同深度就指空了，那是本地跑得通、门禁里
 * ENOENT 的来源。原生到不了的（悬空、环、尾部分隔符指着文件、字面反斜杠指不到东西）照抄原文，
 * 保持原样不可达。
 */
export async function relocatedTarget(source: string, destination: string,
  relocation: Relocation): Promise<string> {
  const raw = await linkTarget(source);
  const { reachable, landing } = await linkLanding(source, raw);
  if (!reachable) return raw;
  if (insideTree(relocation.treeRoot, landing) && !isAbsolute(raw)) return raw;
  const where = counterpart(landing, relocation);
  return inSnapshot(where, relocation) ? relative(dirname(destination), where) : where;
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
      ? await linkTarget(source)
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
 * 一侧算得对不对：复制错了（归属认错、落点算错）这里都对不上账。
 *
 * 不跟随链递归（lstat 的类型直接用 readdir 给的），所以遍历量就是副本树的条目数，链本身通常只有
 * 几十条。
 */
export async function linkMismatch(relocation: Relocation): Promise<string | null> {
  // 可达性交给 stat（原生，和 linkLanding 同一个判据：尾部分隔符、字面反斜杠、穿链后的 `..` 全
  // 在里面），落点交给 realpath（两侧同一个解析深度才可比）。**这两件事必须分开**：realpath 对
  // 「原文带尾部分隔符却指向普通文件」照样解析得出东西来（macOS 实测 stat=ENOTDIR 而
  // realpath=.../f.mjs），只用它判就会把一条两侧都读不通的链判成「副本放错了」，门禁在一个合法
  // 项目上直接不可用。
  const landingOf = async (path: string): Promise<string | null> =>
    await stat(path).then(() => realpath(path).catch(() => null), () => null);
  const check = async (path: string): Promise<string | null> => {
    const from = await landingOf(join(relocation.treeRoot, path));
    const to = await landingOf(join(relocation.treeDest, path));
    if (from === null) {
      return to === null ? null : `${path} 在工作区里解析不出东西来，副本里却落在了 ${to}`;
    }
    const want = counterpart(from, relocation);
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
