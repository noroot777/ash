import { lstat, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { copyLink, insideTree } from "./accept-gate-tree.js";
import { DEPENDENCY_DIRS } from "./accept-gate-dirs.js";
import { declaredPackageDirs, recordedLinks, type RecordedLinks } from "./accept-gate-deps.js";
import type { OwnedPackage } from "./accept-gate-relocate.js";
import { resolutionInputs, type ResolutionEntry } from "./accept-gate-resolution.js";
import { identityProblem, projectSources, type ProjectSources } from "./accept-gate-project.js";
import { inputFailure, optionalRead, readResult, requiredRead } from "./accept-gate-fs.js";

// 源码隔离的**收口**:快照里跑的每一个本项目自有源码入口,都必须解析到快照里那份被认证的源码。
//
// 这一版是「一张计划 + 三条不变量」,而不是在触发点上加判据。前三轮每一轮都是按报告里的具体布局
// 补一条检查,每一轮都被下一个布局绕过(写入穿链 → 只验根主干;同名遮蔽 → 只验包名;运行入口 →
// 只验根 import)。2026-10-27 第二轮独立审查在两台机器上实测了这种补法的三个代价,它们共用一个
// 根因:**决定「删什么、遮蔽什么」的依据不是可证明的事实**。所以口径换成一句话——
//
//                        **证明不了,就无副作用地拒绝。**
//
// 三条不变量,全部在任何写入之前校验完,一条不过就整体拒绝、一个字节都不动快照之外的东西:
//
// ① **写入所有权**:每个计划目的地的**完整父链**逐段真实落在快照内。
//    上一版只验 `<快照>/node_modules` 这个根。实测反例:项目声明 workspace(整棵克隆),而
//    `node_modules/@demo` 是一条指向另一处安装存储的目录链——克隆按「落点在项目外」原样保留了它,
//    根主干是真目录所以检查通过,随后 `rm(<快照>/node_modules/@demo/lib)` 穿过 scope 链,把用户
//    原安装存储里那个包目录整个删掉,再在原存储上建链。macOS 上最后一道写后核对会报错(相对链在
//    外部 scope 下解析不通),但破坏已经发生、不可逆;Windows 的 junction 用绝对落点,写后核对
//    照样解析进快照,**连错都不报**。字面路径在快照内、根主干在快照内,都证明不了实际写入目的地
//    在快照内——只有逐段验父链能证明。也不能给 `@scope` 加白名单:路径里任何一段都可能是链。
//
// ② **来源身份**:哪些入口是「本项目自己的包」,只认**安装记录**(node_modules/.package-lock.json
//    的 link + resolved),建立「安装入口 ↔ 安装来源 ↔ 本次提交目录」的三元映射。
//    上一版扫快照源码里的 package.json.name 当身份。实测反例:项目正式依赖 left-pad@1.3.0、从祖
//    先安装目录解析,仓库里另存了一份 `patches/left-pad`(也叫 left-pad,但不是安装来源)——源码扫
//    描把补丁副本算成自有包,于是在快照里建了一条更近的绑定,**遮蔽了项目实际使用的正式包**。两
//    台机器输出一致:工作区 REGISTRY_1_3_0、快照 PATCH_COPY,而快照自证为真。名字从来不是来源,
//    同名两个包是合法的。注册表包(树内真实目录)、外部 `file:` 包(记录里 resolved 指向项目外)、
//    项目内真实包(resolved 指向项目内)三类分开判,不共用一个按名字的判据。「分开判」还有一层在
//    落点上:安装来源落在被冻结项目内即是自有源码，目录自带 .git 也一样；其它 worktree 通过仓库
//    身份对齐。无关仓库的包与系统工具不是本次要冻的源码，读不出的身份另给元数据修复说明。
//
//    2026-10-27 第三轮独立审查又在这一条上实测到两个代价,都已收进来:
//    · **来源要三态,不是两态**。记录认下的「装自项目外」(`file:../另一个仓库`)是一个**已知**来源。
//      只留「自有包 / 未知」两格时,一个正常 `npm install` 装好的外部 file 包落在独立 Git 仓库里,
//      于是被当成「未知的活源码」拒掉:门禁说「安装记录里没有这个入口、请重新安装依赖」,而重装只
//      会得到同一份合法记录——项目永久过不去(两平台实测)。外部包由不由 Git 管理不改变它是明确外
//      部来源这个事实,所以三态由 recordedLinks 带出来,不在这里按路径加例外。
//    · **「唯一同名」不是搬迁的证明**。安装来源在本次提交里消失后按包名兜底时,原目录被**删掉**、
//      仓库里另留一份同名副本(`examples/lib`、`patches/lib`)的布局会让安装入口绑到那份无关副本上
//      ——等于把被测代码换成另一份还报绿。真正的搬迁一定同步改过声明(不改 npm 装不出来),所以候
//      选还必须由本次提交的声明指向(declaredPackageDirs),见 sourceFor。
//
// ③ **运行入口闭包**:要校验的不只是「包名 import」,而是这棵树上所有会被快照里的命令用到的入口
//    ——包入口、`@scope/包`、`.bin/<命令>`、别名目录项、以及嵌套在包里的那一层 node_modules。
//    上一版只按包名从快照根往上查一次。实测反例:任务借用主检出的依赖树、树里没有 npm 的隐藏安装
//    记录,`.bin/demo-cli -> ../@demo/lib/cli.mjs` 被当成「未知外部路径」原样保留成主检出的绝对
//    地址——根 import 已经是 TASK_NEW,同一份快照里那个 CLI 跑出来却是 MAIN_OLD,随后改主检出的
//    源码,它跟着变成 MAIN_LIVE,而快照自证与工作区新鲜度全程为真。「根 import 修好了」和「命令
//    实际跑的是本次提交」可以同时一真一假,所以入口必须成闭包。元数据缺失只说明**来源尚未证明**,
//    不是「可以跳过证明」的理由。
//
//    闭包还有**消费者**那一半,2026-10-27 第三轮独立审查实测补上:往 `<快照>/node_modules/<入口>`
//    补一条绑定,只对「从快照根出发」的解析有效。快照之外那棵树里的第三方包是从**它自己的位置**
//    向上解析的,先命中那棵树里的原入口。实测形状(真实 npm 离线安装):主检出有 workspace 包
//    @demo/lib,另装了第三方包 plain-consumer 传递导入它,任务 worktree 没装依赖——同一份快照里直接
//    import 得到 TASK_NEW、经 plain-consumer 间接 import 得到 MAIN_OLD,改主检出源码后变 MAIN_LIVE。
//    判据仍是可证事实:那棵树上除了自有包入口**还有没有实际可解析的别的入口**。没有(只有本项目自己的
//    包)时根上的绑定就是全部解析路径;有别的入口时它们都是潜在消费者,「它会不会 import 我的包」要
//    静态分析整个包才知道,证明不了就拒绝。树**在快照里**(依赖整棵克隆进来)不受这条约束:消费者的
//    副本也在快照里,它向上解析先命中快照这棵树里被改写过的入口。
//
// **这一版覆盖不到的**(写在这里是为了别让下一个人以为已经包住了):
//   · Windows 上 npm 生成的 `.bin/*.cmd` / `*.ps1` 是**真文件**,相对路径写在文件内容里。它和
//     Python 的 editable install(.pth 文件里一条绝对路径)同类:要改得重写文件内容,不是改链。
//     这里只处理链形态的入口;真文件形态的入口落点就是文件自己(树内),不会被误判成活源码,但也
//     得不到隔离。开发者模式下 npm 建的是文件软链,那种形态这一版覆盖得到(有定点回归)。
//   · 快照**外**那棵树的嵌套层(`node_modules/a/node_modules/@demo/lib`)无法从快照遮蔽——node 从
//     `a/` 内部解析时先看 `a/node_modules`。所以那种布局只能拒绝,不能绑定(同样有定点回归)。

/** 一条计划好的绑定：把快照依赖树里的某个入口，接到快照里那份被认证的源码上。 */
type Binding = {
  /** 相对依赖树根的入口路径，如 `@demo/lib`、`.bin/demo-cli`、`aliased`。 */
  entry: string;
  /** 这个入口现在解析到哪（快照之外的活源码）。 */
  landing: string;
  /** 要写到快照里的哪个位置。 */
  destination: string;
  /** 快照里那份被认证的源码路径。 */
  source: string;
};

/** 枚举出来的一个运行入口。 */
type Entry = ResolutionEntry;

/**
 * 一棵树的安装记录。`usable=false` 表示无从证明任何入口的来源。
 *
 * `owned` 是记录说装自项目内的，`external` 是记录说装自项目外的，`unknown` 保留读取失败的
 * 仓库身份及元数据位置。身份读不出来与「安装记录没有这条入口」不是同一种失败。
 */
type InstallRecord = RecordedLinks & { usable: boolean };

/** 入口的来源归属：安装记录认下的那个自有包，以及入口落在那个包**内部**的哪一段。 */
type Ownership<Source extends OwnedPackage = OwnedPackage> = {
  owned: Source;
  /** 包内相对路径。入口就是包本身时是空串（`.bin/demo-cli` 这种则是 `cli.mjs`）。 */
  within: string;
};

/** 这个目录上摆的包叫什么。读不出来（没有、坏了、没有 name）就回 null。 */
async function manifestName(root: string): Promise<string | null> {
  const raw = await optionalRead(join(root, "package.json"), () => readFile(join(root, "package.json"), "utf8"));
  if (raw === null) return null;
  try {
    const name = (JSON.parse(raw) as { name?: unknown }).name;
    return typeof name === "string" && name !== "" ? name : null;
  } catch { return null; }
}

/**
 * 不变量 ①：这个计划目的地的**完整父链**是否逐段真实落在快照内。
 *
 * 逐段 `lstat` + `realpath`：
 *   · 这一段还不存在 —— 下面全是 `mkdir` 新建，而到这里为止的每一段都已证明在快照内，安全；
 *   · 这一段存在 —— 它的**落点**（realpath，解析掉所有中间链）必须在快照内，而且它得是个目录。
 *     落点在快照内的链是安全的（穿过去还在快照里），所以继续往下验；落在快照外、或者解析不通
 *     （`mkdir` 会在断链的那一头造目录）都是拒绝。
 *
 * 只验**父链**，不验最后一段：最后一段是我们要 `rm` 掉再重建的那个条目，而 `rm` 对一条链是
 * `unlink`（删链不删落点），真正会穿出去的是父链。
 */
async function provenInside(target: string, realTarget: string, destination: string): Promise<string | null> {
  const rel = relative(target, destination);
  if (rel === "" || isAbsolute(rel) || rel.split(sep).includes("..")) {
    return `${destination} 不在快照目录里`;
  }
  const segments = rel.split(sep);
  let walked = target;
  for (const segment of segments.slice(0, -1)) {
    walked = join(walked, segment);
    if (await optionalRead(walked, () => lstat(walked), ["ENOENT"]) === null) return null;
    const landing = await optionalRead(walked, () => realpath(walked));
    if (landing === null) {
      return `${walked} 是一条解析不通的链（往里写会在它落点那头造目录）`;
    }
    if (!insideTree(realTarget, landing)) {
      return `${walked} 是一条落在 ${landing}（快照之外）的链`;
    }
    if ((await optionalRead(walked, () => stat(walked)))?.isDirectory() !== true) {
      return `${walked} 不是目录`;
    }
  }
  return null;
}

/**
 * 不变量 ②：这棵树的安装记录。
 *
 * 只认 npm 的隐藏安装树 `.package-lock.json`：它是唯一一份**安装器自己写下的**「这个入口装自
 * 哪里」（`link: true` + `resolved`）。别的生态的记录文件（pnpm 的 .modules.yaml、yarn 的
 * .yarn-state.yml）这里读不懂，于是它们算 `usable=false` —— 那不是漏洞而是口径：读不懂就等于
 * 来源未证明，按拒绝走，而不是凭名字猜。
 *
 * `usable=true, owned=[]` 和 `usable=false` 是**两件不同的事**，不能合成一个空数组：前者是
 * 「记录读到了，它说这棵树里一个自有包都没有」（纯第三方树，正常布局），后者是「无从证明」。
 */
async function installRecord(tree: string, project: ProjectSources, origin = tree): Promise<InstallRecord> {
  const unusable = (): InstallRecord => ({ usable: false, owned: [], external: [], unknown: [] });
  const raw = await optionalRead(join(tree, ".package-lock.json"), () => readFile(join(tree, ".package-lock.json"), "utf8"));
  if (raw === null) return unusable();
  try {
    if (typeof (JSON.parse(raw) as { packages?: unknown }).packages !== "object") return unusable();
  } catch { return unusable(); }
  const links = await recordedLinks(tree, "node_modules", project, origin);
  return { usable: true, ...links };
}

// 说明里点名的一律是**原树**而不是快照里那份副本:依赖整棵克隆进快照之后 `item.tree` 就是副本,
// 而拒绝的那条路上快照整个会被丢掉 —— 叫用户去「删除 <快照>/node_modules/.bin/orphan」是一句
// 无从照做的话。origins 本来就记着「副本 → 原树」,两处(安装记录读取、这几句说明)共用它。
const commandRemedy = (item: Entry, tree: string) => `命令入口 ${join(tree, item.entry)} 不是包名。请检查这条入口：`
  + `若为遗留或损坏项，删除该入口后重试；若仍需使用，在任务工作区重新安装提供该命令的工具`
  + `并使入口被就近遮蔽，或把工作区里不完整的依赖目录整个移走、让门禁按同仓参考检出整棵克隆进快照`
  + `（见 accept-gate-supply），或将 ASH_RUNS_DIR 移出 ${tree} 的解析祖先链`;


/**
 * 快照源码里叫这个名字的包目录（相对快照根）。**只用于兜底**，见 sourceFor。
 *
 * 依赖目录整棵跳过（里面是第三方包，几万个 package.json），软链不跟随（`isDirectory()` 对软链
 * 就是 false）。同名的全部收下来，因为兜底要求**唯一**才算证明得了。
 */
async function sourcePackages(target: string): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  const add = (name: string, path: string) => found.set(name, [...(found.get(name) ?? []), path]);
  const rootName = await manifestName(target);
  if (rootName !== null) add(rootName, ".");
  const walk = async (sub: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    for (const item of await optionalRead(join(target, sub), () => readdir(join(target, sub), { withFileTypes: true })) ?? []) {
      if (!item.isDirectory() || item.name === ".git" || DEPENDENCY_DIRS.includes(item.name)) continue;
      const path = sub === "" ? item.name : join(sub, item.name);
      const name = await manifestName(join(target, path));
      if (name !== null) add(name, path);
      await walk(path, depth + 1);
    }
  };
  await walk("", 0);
  return found;
}

/**
 * 这个安装来源在**本次提交**里对应哪个目录。映射建不起来就回 null（调用方据此拒绝）。
 *
 * 第一手是安装记录自己记下的那条相对路径（`resolved`）—— 它就是三元映射的中间一环。
 *
 * 它在快照里不存在时才按**包名**在快照源码里兜底找一次：包在本次提交里搬过位置（`packages/lib`
 * → `libs/lib`）而依赖没重装，是一次合法重构，不该让验收不可用。这里用名字是安全的，和 ② 批评
 * 的「按名字认来源」不是一回事：**此刻「这个入口是自有包」已经由安装记录证明过了**，名字只用来
 * 回答「它搬到哪了」。包名从工作区那个包目录读（它可达），所以别名入口也对得上。
 *
 * 但光有「唯一同名」不够——那是 2026-10-27 第三轮独立审查按代码指出的缺口：原目录在本次提交里
 * 被**删掉**、仓库里另留着一份同名副本（`examples/lib`、`patches/lib`）时，唯一同名命中的是那份
 * 无关副本，于是安装入口被绑到它身上，等于把被测代码换成另一份还报绿。真正的搬迁一定同步改过
 * 声明（不改 npm 装不出来），所以候选还得由本次提交中同一个安装入口的声明指向：另一个别名
 * 声明过同名目录并不证明这个入口迁移到了那里。
 */
async function sourceFor(target: string, ownership: Ownership,
  packages: Map<string, string[]>, declaredDirs: Map<string, string[]>): Promise<string | null> {
  const { owned, within } = ownership;
  // 安装来源证明到包目录；包内的 dist 等输出可以尚未构建，绑定保留同一相对路径，让测试自己的
  // 构建步骤生成它。包目录本身不存在才需要寻找经同入口声明认证的搬迁位置。
  const located = async (directory: string): Promise<string | null> => {
    return (await optionalRead(directory, () => stat(directory)))?.isDirectory() === true ? join(directory, within) : null;
  };
  const declared = await located(join(target, owned.inside));
  if (declared !== null) return declared;
  const name = await manifestName(owned.landing);
  const candidates = (name === null ? [] : packages.get(name) ?? [])
    .filter(dir => (declaredDirs.get(portable(owned.entry)) ?? []).includes(portable(dir)));
  return candidates.length === 1 ? await located(join(target, candidates[0])) : null;
}

const missingSource = async (source: string): Promise<boolean> =>
  await optionalRead(source, () => lstat(source), ["ENOENT"]) === null;

async function sourceProblem(target: string, realTarget: string, source: string): Promise<string | null> {
  if (source !== target) {
    const refusal = await provenInside(target, realTarget, source);
    if (refusal !== null) return refusal;
  }
  const result = await readResult(() => realpath(source));
  if (result.kind === "value") return insideTree(realTarget, result.value)
    ? null : `${source} 实际解析到 ${result.value}（快照之外）`;
  if (result.error.code !== "ENOENT") throw inputFailure(source, result.error);
  return await missingSource(source) ? null : `${source} 是一条解析不通的链`;
}

/** 入口路径归一成 `/`：安装记录里的键来自 JSON（永远是 `/`），这边是 path.join（Win32 上是 `\`）。 */
const portable = (path: string) => path.split(sep).join("/");

/** 这个入口的落点，是安装记录认下的某个自有包、或它内部的某个文件吗。 */
function ownerOf<Source extends OwnedPackage>(item: Entry, owned: Source[]): Ownership<Source> | null {
  // 长的先试：packages/lib 与 packages/lib/inner 各自成包时取更具体的那个。
  const sorted = [...owned].sort((left, right) => right.landing.length - left.landing.length);
  const key = portable(item.entry);
  // ① 入口路径相等 —— 入口**就是**那个包。记录说「这个入口装自项目内的某个目录」,落点此刻指到
  // 哪都不改变这个事实:F1 的 scope 链把落点带去了另一处安装存储,那是拒绝的理由(父链验不过),
  // 不是放过它的理由。所以这里不看落点,包内相对路径是空。
  const byEntry = sorted.find(pkg => portable(pkg.entry) === key);
  if (byEntry !== undefined) return { owned: byEntry, within: "" };
  // ② 落点在某个自有包**内部** —— `.bin/demo-cli -> ../@demo/lib/cli.mjs` 就是这个形状(入口路径
  // 和包名毫无关系,身份只能由落点落在哪个包里给出)。要接到快照里那份源码的**同一个文件**上,所以
  // 把包内那段相对路径带过去;只接到包目录上会让 CLI 入口指着一个目录。
  // insideTree 对「落点就是那个包目录自己」也成立,所以不必再单列一次相等比较。
  const byLanding = sorted.find(pkg => insideTree(pkg.landing, item.landing));
  return byLanding === undefined
    ? null
    : { owned: byLanding, within: relative(byLanding.landing, item.landing) };
}

/**
 * 让快照里每个本项目自有源码入口都解析到快照这份被认证的源码。
 *
 * 返回第一处证明不了的说明（调用方据此让门禁失败，快照整个丢掉）；全都收住就回 null。
 * **校验全部走完才动手写**，所以拒绝的那条路上快照之外一个字节都没动。
 */
export async function confineOwnPackages(target: string, sourceRoot: string, origins = new Map<string, string>()): Promise<string | null> {
  const project = await projectSources(sourceRoot);
  const realTarget = await requiredRead(target, () => realpath(target));
  const records = new Map<string, InstallRecord>();
  /** 这棵树原来住在哪（副本 → 原树）。安装记录的来源解析与所有拒绝说明共用这一份映射。 */
  const originOf = (tree: string): string => {
    const origin = [...origins].find(([copy]) => insideTree(copy, tree));
    return origin ? join(origin[1], relative(origin[0], tree)) : tree;
  };
  const recordFor = async (item: Entry): Promise<InstallRecord> => {
    const record = records.get(item.tree) ?? await installRecord(item.tree, project, originOf(item.tree));
    records.set(item.tree, record);
    return record;
  };
  let packages: Map<string, string[]> | null = null;
  let declaredDirs: Map<string, string[]> | null = null;
  const sources = new Map<Entry, Promise<string | null>>();
  const sourceOf = (item: Entry, ownership: Ownership): Promise<string | null> => {
    if (!sources.has(item)) sources.set(item, (async () => {
      packages ??= await sourcePackages(target);
      declaredDirs ??= await declaredPackageDirs(target);
      return await sourceFor(target, ownership, packages, declaredDirs);
    })());
    return sources.get(item)!;
  };
  const inputs = await resolutionInputs([realTarget], undefined, async item => {
    if (insideTree(realTarget, item.landing) || insideTree(item.tree, item.landing)) return item.landing;
    const ownership = ownerOf(item, (await recordFor(item)).owned);
    if (ownership === null) return item.landing;
    const source = await sourceOf(item, ownership);
    return source !== null && await sourceProblem(target, realTarget, source) === null ? source : null;
  });
  const entries = inputs.flatMap(input => input.selected);
  const visible = new Map<string, Entry>();
  for (const input of inputs) {
    for (const item of input.direct) if (!visible.has(item.entry)) visible.set(item.entry, item);
  }
  const plan: Binding[] = [];
  /**
   * 快照**之外**、而且摆着本项目源码入口的那些树。消费者闭包要在这些树上证明，见循环后那一段。
   *
   * 判据取 `selected` 而**不是** `direct`，这不是疏漏（2026-10-28 第 1 轮审查把它报成「按会变的集合
   * 判」，实测不成立）：`direct` 是「从快照根出发」那一张遮蔽表，`selected` 是**每个解析根各自**的
   * 第一命中的并集。这棵树里的消费者是从它自己在树里的位置往上解析的，对它来说快照根上的遮蔽不
   * 存在 —— 所以 `visible` 按根新建正是在如实区分这两件事，不是把已遮蔽的条目重数一遍。两侧各有
   * 一个定点用例钉住，改判据会从相反方向各破一个：
   *   · 消费者住在这棵树里（tarball 装出来的真目录）→ 它确实读到活源码，必须拒。实测
   *     `test-accept-gate-plan.ts` 的 removedTask/rawLayout：直接 import 得 TASK_NEW，经
   *     plain-consumer 间接 import 得 MAIN_OLD 并随工作区改动变成 MAIN_LIVE；此时 `direct` 里
   *     没有那个自有包入口（已被快照就近遮住），只有 `selected` 里有。改读 `direct` 就放过它。
   *   · 消费者的落点在这棵树**之外**（`file:` 装成的链）→ 它的解析链压根不经过这棵树，必须放过。
   *     同一文件的 selectedTarget 用例钉住 `selected == ["external-only"]`，而 `entries` 更长。
   *     把「这棵树上摆着自有包吗」改读 `entries` 就反过来误拒它。
   */
  const exposed = new Set<string>();
  for (const item of entries) {
    const record = await recordFor(item);
    const ownership = record.usable ? ownerOf(item, record.owned) : null;
    // 落点在快照里:已经指着本次被认证的那份源码(或者是快照自己那棵树里的第三方包)。
    if (insideTree(realTarget, item.landing)) continue;
    // 落点在它自己那棵树里:这是一个普通的第三方包(真实目录,或指向树内另一处的链),它在哪解析都
    // 一样——依赖是 lockfile 的产物,身份按安装声明计(dependencyDigest)。
    if (insideTree(item.tree, item.landing)) continue;
    // 三类分开判(②要求的那件事),不共用一个判据:记录认下的是自有包;记录读到了却没认下、而落点
    // 又是活源码的,是「装出来的东西和记录不一致」;落点压根不在任何检出里的,不是这次要冻的源码。
    if (ownership === null) {
      // 记录明确说这个入口装自项目**外**（`file:../另一个仓库`）：已知来源，不是未证明。它不是
      // 这次要冻的源码，照既定外链策略原样留着。丢掉这一态的代价见 recordedLinks 上方。
      if (ownerOf(item, record.external) !== null) continue;
      const uncertain = ownerOf(item, record.unknown);
      if (uncertain !== null) return `${item.entry} 的安装来源已登记，但${identityProblem(uncertain.owned.location)}`;
      const location = await project.locate(item.landing);
      if (location.kind === "unknown") return `${item.entry}：${identityProblem(location)}`;
      if (location.kind === "external") continue;
      if (item.kind === "command") return `${item.entry} 指向本项目的活源码 ${item.landing}，`
        + `${record.usable ? "安装记录没有这个入口" : "没有 npm 的安装记录 .package-lock.json"}，无法证明安装来源。`
        + commandRemedy(item, originOf(item.tree));
      return record.usable
        // 记录读到了,它既没把这个入口认成项目内的包、又没法解释一条指着活源码的入口:那就是记录
        // 和实际装出来的东西不一致(装完之后手加过链),同样是**证明不了**。
        ? `${item.entry} 现在解析到 ${item.landing}（快照之外的活工作区源码），但那棵依赖树`
          + `（${originOf(item.tree)}）的安装记录里没有这个入口 —— 装出来的依赖和安装记录不一致（多半是装完`
          + `之后手工加过链），无从证明它该解析到哪份源码，请重新安装依赖后验收`
        : `${item.entry} 现在解析到 ${item.landing}（快照之外的活工作区源码），而那棵依赖树`
          + `（${originOf(item.tree)}）没有 npm 的安装记录 .package-lock.json，无从证明它是本项目自己的包`
          + `还是第三方包 —— 依赖布局无法证明隔离，请在标准安装布局下（重新安装依赖）验收`;
    }
    // 这棵树上摆着本项目的源码入口。树落在快照之外时，往快照根补绑定只覆盖「从快照根出发」的
    // 解析，覆盖不到这棵树**内部**的消费者——判据与实测见循环之后那一段。
    if (item.kind === "package" && !insideTree(realTarget, item.tree)) exposed.add(item.tree);
    if (!item.nested && visible.get(item.entry) !== item) continue;
    if (item.nested) {
      return `${item.entry} 在依赖树内层解析到 ${item.landing}（快照之外的活源码），而内层这一级`
        + `没法从快照遮蔽（node 从那个包内部解析时先看它自己那层 node_modules）—— 请重新安装依赖，`
        + `让依赖树落在任务自己的工作区里，再验收`;
    }
    const source = await sourceOf(item, ownership);
    if (source === null) {
      return `安装记录说 ${item.entry} 来自 ${join(ownership.owned.inside, ownership.within)}，但本次`
        + `提交里没有这个位置，也没有「声明过、而且同名唯一」的替代位置 —— 这个包要么搬过位置而`
        + `依赖没有重装，要么已经从本次提交里删掉（仓库里剩的同名目录证明不了是它搬过去的），`
        + `若仍使用该源码，请将安装来源目录纳入 Git 并提交；否则停止将该目录作为本项目自有包的安装来源，`
        + `更新依赖声明并重新安装依赖后验收`;
    }
    plan.push({ entry: item.entry, landing: item.landing, destination: join(target, "node_modules", item.entry), source });
  }
  // ── 不变量 ①:**先把整张计划验完**,再动手。一条不过就整体拒绝,外部一个字节都不动。
  for (const binding of plan) {
    const refusal = await provenInside(target, realTarget, binding.destination);
    if (refusal !== null) {
      return `要把 ${binding.entry}（现在解析到 ${binding.landing}）绑回快照里那份被认证的源码，`
        + `得写到 ${binding.destination}，但${refusal} —— 门禁不会往快照之外写，`
        + `请在标准安装布局下（重新安装依赖）验收`;
    }
    const sourceRefusal = await sourceProblem(target, realTarget, binding.source);
    if (sourceRefusal !== null) {
      return `${binding.entry} 对应的源码位置 ${binding.source} 无法证明在快照内：${sourceRefusal}。`
        + `本次提交没有提供可在快照内独立解析的该源码目录；请将安装来源及其父目录纳入 Git 并提交，`
        + `或停止将该目录作为本项目自有包的安装来源。门禁不会绑定到快照之外`;
    }
  }
  // ── 不变量 ③ 的另一半:**消费者**那一侧的解析边。排在 ① 之后:① 保护的是「别改坏用户工作区」,
  // 比这一条更基础,先确认「能不能安全地写」,再确认「写了够不够」。
  //
  // 往 `<快照>/node_modules/<入口>` 补一条绑定,只对「从快照根出发」的解析有效。快照之外那棵树里
  // 的第三方包是从**它自己的位置**向上解析的,先命中那棵树里的原入口,补的那条对它没有效力。
  // 2026-10-27 第三轮独立审查在两台机器上实测到这个代价(用真实 npm 离线安装,不是伪造记录):主
  // 检出有 workspace 包 @demo/lib,另装了一个第三方包 plain-consumer 传递导入它;任务 worktree 没
  // 装依赖。同一份快照里,直接 import 得到本次提交(TASK_NEW),经 plain-consumer 间接 import 得到
  // MAIN_OLD,随后改主检出的源码它跟着变成 MAIN_LIVE,而快照自证与工作区新鲜度全程为真。
  //
  // 判据是**可证事实**而不是「这棵树里大概没人 import 我的包」:那棵树上除了自有包入口之外**还有
  // 没有实际可解析的别的包入口**。根遮蔽表 direct 与真正消费者的 selected 分开；按计划绑定后的
  // 源码位置播种消费者，不再从将被替换的旧落点展开。命令参与重绑但不是模块入口，不能当消费者
  // 的证人。仍可见第三方包自身能解析到的入口仍在 selected 中。没有别的入口时闭包成立；有
  // 别的入口时,它们都是潜在消费者——「它会不会 import 本项目的包」要静态分析整个包才知道,证明
  // 不了,按拒绝走。树**在快照里**的那种(依赖整棵克隆进来了)不受这条约束:消费者的副本也在快照
  // 里,它向上解析先命中快照这棵树里被改写过的入口。
  for (const tree of exposed) {
    const record = records.get(tree)!;
    const outsider = entries.find(item => item.tree === tree && item.kind === "package"
      && ownerOf(item, record.owned) === null);
    if (outsider !== undefined) {
      return `依赖树 ${tree} 落在快照之外，里面既摆着本项目自己的包、又摆着 ${outsider.entry} 这样`
        + `不属于本项目的入口：往快照里补的绑定只对「从快照根出发」的解析有效，而那些入口是从它们`
        + `自己在那棵树里的位置向上解析的，会先命中那棵树里的原入口、读到活工作区的源码 —— `
        + `无法证明隔离。三条出路任选一条：在 ${tree} 所属的那个检出里重新安装依赖 —— `
        + `${outsider.entry} 只在那棵树里有、而本次提交已经不需要它时，npm install / npm prune 会把`
        + `它清掉，这棵树就不再摆着它（本次提交删掉过依赖的场合走这一条，不要把刚删掉的那条装回来）；`
        + `或在任务工作区安装提供 ${outsider.entry} 的依赖，使该入口被快照就近遮蔽；`
        + `或把任务工作区里那几个**不完整**的依赖目录整个移走 —— 某个位置上完全没有依赖目录时，`
        + `门禁会按同仓参考检出把整棵树克隆进快照（见 accept-gate-supply），解析根就落在快照内，`
        + `这一条不再适用；或将 ASH_RUNS_DIR 移到解析祖先链不经过 ${tree} 的目录后验收`;
    }
  }
  for (const binding of plan) {
    await mkdir(dirname(binding.destination), { recursive: true });
    await rm(binding.destination, { recursive: true, force: true });
    await copyLink(binding.landing, binding.destination, relative(dirname(binding.destination), binding.source));
    const bound = await optionalRead(binding.destination, () => realpath(binding.destination));
    const pendingBuild = bound === null && await missingSource(binding.source)
      && await sourceProblem(target, realTarget, binding.source) === null;
    if (!pendingBuild && (bound === null || !insideTree(realTarget, bound))) {
      return `${binding.entry} 仍然解析到 ${bound ?? "解析不出来"}，不是快照自己那份源码`;
    }
  }
  return null;
}
