import { chmod, copyFile, lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { copyLink, insideTree, linkLanding, linkTarget } from "./accept-gate-tree.js";
import { optionalRead, requiredRead } from "./accept-gate-fs.js";
import { execFileText } from "./exec.js";

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
  if (!inSnapshot(where, relocation)) return where;
  // `relative()` 对「落点**就是**目的地的父目录」给出空串（`node_modules/.bin/.bin -> …/.bin`
  // 这种指回自己所在目录的链就是这个形状），而 `symlink("")` 建出来的是一条解析不到任何东西的
  // 链：源端活着、副本里死掉，随后对账报「副本里却落在 解析不出来」。POSIX 和 Win32 都用 `.`
  // 表示「我所在的这个目录」，所以空串一律换成它。2026-10-31 定点实测见 test-accept-gate-relocate。
  const target = relative(dirname(destination), where);
  return target === "" ? "." : target;
}

export type CopyOptions = {
  /** 数据块共享（macOS clonefile / Linux reflink），见 cloneInto。文件系统不支持时内核自动整块复制。 */
  clone?: boolean;
  /** 给定时按 relocatedTarget 决定每条链的新原文；不给就照抄原文。 */
  relocate?: Relocation;
  /** 这条源路径要不要跳过。源码侧那份排除计划同款，用来挡住运行产物。 */
  skip?: (path: string) => boolean;
  /** 快照根的真实路径。遍历绝不进入它——目标不能变成自己的输入。 */
  snapshotRoot?: string;
};

/**
 * 数据块共享只能交给外部命令，**不能用 `copyFile` 的 `COPYFILE_FICLONE`**。
 *
 * 2026-10-31 在 node v26.4 / macOS 15 (APFS) 上定点实测：`COPYFILE_FICLONE` 整块复制了 200 MB 的
 * 测试文件（`cp -c` 同一份是 0），`COPYFILE_FICLONE_FORCE` 直接 `ENOSYS` —— libuv 在 macOS 上**压根
 * 没有 clonefile 路径**，而 FICLONE 的语义是「尽力而为，不支持就整块复制」，所以它既不报错也不共享。
 * 本模块和 accept-gate-deps、docs/accept-gate.md 里「实际占用 16 MB」那组数是在更早的 node 上测的，
 * 从那以后门禁每建一次快照都在实打实地拷满盘：本仓一次 1034 MB。
 *
 * 所以克隆走平台自己的拷贝命令（macOS `cp -c` = clonefile(2)，GNU `cp --reflink=auto`），**一次调用
 * 搬一整批**：逐文件起进程会把 69110 个文件变成 69110 次 spawn。不支持的平台（Windows）回 null，由
 * 调用方退回逐条复制 —— 那里本来也没有数据块共享这回事。
 */
function cloneArgv(sources: string[], into: string): string[] | null {
  // `-p` 连权限位一起搬（逐条那条路靠 chmod 做同一件事）；`--` 之后全是路径，`-` 开头的目录名不会
  // 被当成选项。GNU 的 `--reflink=auto` 在不支持的文件系统上静默退回整块复制，与 macOS `-c` 同义。
  if (process.platform === "darwin") return ["-Rpc", "--", ...sources, into];
  if (process.platform === "linux") return ["-R", "-p", "--reflink=auto", "--", ...sources, into];
  return null;
}

/** 这台机器上有没有那条命令（Windows 没有）。cloneArgv 是唯一的平台判据，这里只问它一次。 */
const CLONE_SUPPORTED = cloneArgv([], "") !== null;

/** 一次 `cp` 的实参上限。ARG_MAX 在 macOS 上是 1 MB，分批只为留出余量，与正确性无关。 */
const CLONE_BATCH = 256;

async function cloneInto(sources: string[], into: string): Promise<boolean> {
  for (let at = 0; at < sources.length; at += CLONE_BATCH) {
    const argv = cloneArgv(sources.slice(at, at + CLONE_BATCH), into);
    if (argv === null) return false;
    // 失败一律退回逐条复制，不在这里分辨原因：**竞态和真故障在这里长得一样**。包管理器随时在改依赖
    // 树，`cp` 碰上「刚读到、拷的时候没了」会整条命令失败，而那一种按本模块的口径该放过；真故障
    // （EACCES/ENOSPC）退回去之后逐条那条路一样会撞上并明确失败。所以退路保留了原有的错误口径。
    if (await execFileText("cp", argv).then(() => false, () => true)) return false;
  }
  return true;
}

/**
 * 这棵子树能不能整棵交给 `cp`：它不认识 skip / relocate / snapshotRoot 这三件特判，所以**有任何一件
 * 需要特判的东西，整棵就退回逐条**。软链一律算需要特判——原文要不要改写由 relocatedTarget 判，这里
 * 不复述那套判据。代价是一条链会让它所在的那棵子树整棵逐条复制（`node_modules/.bin` 就是这个形状，
 * 它很小）；收益是判定只看目录项类型，不读一个字节。
 *
 * 结果记在 plan 里：非克隆子树会被 copyTree 再走一遍，不记就要按深度重复扫描。
 */
async function clonable(source: string, options: CopyOptions, plan: Map<string, boolean>): Promise<boolean> {
  const known = plan.get(source);
  if (known !== undefined) return known;
  const decide = async (): Promise<boolean> => {
    if (options.skip?.(source) === true) return false;
    const info = await optionalRead(source, () => lstat(source));
    if (info === null || info.isSymbolicLink()) return false;
    if (info.isFile()) return true;
    if (!info.isDirectory()) return false;
    if (options.snapshotRoot !== undefined) {
      const real = await requiredRead(source, () => realpath(source));
      if (real === options.snapshotRoot || insideTree(options.snapshotRoot, real)) return false;
    }
    for (const name of await readdir(source)) {
      if (!await clonable(join(source, name), options, plan)) return false;
    }
    return true;
  };
  const answer = await decide();
  plan.set(source, answer);
  return answer;
}

/**
 * 把一棵树复制一遍：克隆形态的实现，同时是借用建不出来时的退路。
 *
 * 不走 gateTreeDigest：那条路对**树外**的可达链是「跟随并把目标内容冻进快照」（源码外链该那么
 * 办），用在依赖目录上会把 .venv/bin/python -> /opt/homebrew/… 指向的整个解释器拷进来。这里一律
 * 按链重建、绝不跟随。
 */
export async function copyTree(source: string, destination: string, options: CopyOptions = {}): Promise<void> {
  await copyInto(source, destination, options, new Map());
}

async function copyInto(source: string, destination: string, options: CopyOptions,
  plan: Map<string, boolean>): Promise<void> {
  if (options.skip?.(source) === true) return;
  // 包管理器随时在改依赖树：读完目录到读条目之间文件被删掉不该崩掉整次快照。放过的只有「真的
  // 没了」(ENOENT/ENOTDIR)这一种；读不动(EACCES/EIO/句柄耗尽)必须明确失败，否则这一棵子树被
  // 静默跳过，副本里缺了那个包，快照跑起来向上解析就落回工作区那一份活依赖 —— 又是报绿跑活源码。
  const info = await optionalRead(source, () => lstat(source));
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
      // 这里**不许**退让：lstat 刚说过它是真目录，realpath 还失败就说明读不动，而这一问的答案
      // 决定「要不要走进正在建的那个快照」。当成「不在快照里」继续遍历，就是一层层把快照自己拷
      // 进自己，直到路径过长为止。
      const real = await requiredRead(source, () => realpath(source));
      if (real === options.snapshotRoot || insideTree(options.snapshotRoot, real)) return;
    }
    await mkdir(destination, { recursive: true });
    const names = (await readdir(source)).sort();
    const batch: string[] = [];
    if (options.clone === true && CLONE_SUPPORTED) {
      for (const name of names) {
        if (await clonable(join(source, name), options, plan)) batch.push(name);
      }
    }
    const cloned = batch.length > 0 && await cloneInto(batch.map(name => join(source, name)), destination);
    // `cp` 中途失败可能已经落下半棵树，而逐条那条路对已存在的软链会 EEXIST。整个清掉再重来：清的
    // 是正在建的快照里的东西，源端一个字节都不碰。
    if (batch.length > 0 && !cloned) {
      for (const name of batch) await rm(join(destination, name), { recursive: true, force: true });
    }
    for (const name of names) {
      if (cloned && batch.includes(name)) continue;
      await copyInto(join(source, name), join(destination, name), options, plan);
    }
    return;
  }
  if (!info.isFile()) return;
  // 不传 COPYFILE_FICLONE：macOS 上它只是整块复制（见 cloneInto），Linux 上这条路只在上面那一批
  // 退回来时才走到，两种情形都已经由 `cp` 表态过了。标志位留着只会让人以为这里共享了数据块。
  await copyFile(source, destination);
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
  // 「解析不出东西来」只认 ENOENT/ENOTDIR/ELOOP。读不动一律抛:这一趟是**核验**,两侧都读不动会
  // 一起落 null、被判成「没有不一致」,等于把整条链的对账静默跳过 —— 对账放过的代价是副本里的链
  // 指着工作区还报绿。
  const absent = ["ENOENT", "ENOTDIR", "ELOOP"];
  const landingOf = async (path: string): Promise<string | null> =>
    await optionalRead(path, () => stat(path), absent) === null
      ? null : await optionalRead(path, () => realpath(path), absent);
  const check = async (path: string): Promise<string | null> => {
    const from = await landingOf(join(relocation.treeRoot, path));
    const to = await landingOf(join(relocation.treeDest, path));
    if (from === null) {
      return to === null ? null : `${path} 在工作区里解析不出东西来，副本里却落在了 ${to}`;
    }
    const want = counterpart(from, relocation);
    const real = await optionalRead(want, () => realpath(want), absent);
    if (to === real) return null;
    return `${path} 在工作区落在 ${from}，副本里却落在 ${to ?? "解析不出来"}（应当对应 ${want}）`;
  };
  const walk = async (sub: string): Promise<string | null> => {
    const directory = join(relocation.treeDest, sub);
    for (const entry of await optionalRead(directory, () => readdir(directory, { withFileTypes: true })) ?? []) {
      const path = sub === "" ? entry.name : join(sub, entry.name);
      const problem: string | null = entry.isSymbolicLink() ? await check(path)
        : entry.isDirectory() ? await walk(path) : null;
      if (problem !== null) return problem;
    }
    return null;
  };
  return await walk("");
}
