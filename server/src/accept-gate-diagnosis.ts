// 门禁失败的**归类**这一层：把一次 rc≠0 翻译成「所以我该干什么」。
//
// 判定本身（哪些措辞算什么、哪一档敢说什么）在 accept-gate-miss.ts，那边是纯函数。
// 这里负责三件 I/O：核一眼入口文件在不在快照里、去仓库里核那几条 git 事实、把结论落到行上。
//
// 为什么核的是**仓库**而不是快照：快照里没有这条命令已经是既成事实，用户真正缺的那条
// 信息是「它在目标分支上是什么情形、我是不是只要把目标分支合进来就行」。这几条查询全是
// 只读（rev-parse / rev-list / grep / show / log），不动任何 ref，也不进仓库锁。
//
// **这一段不许把门禁拖住**（第 1 轮审查 N5）：它跑在 settleGate 里，而终态要等它写完才
// 落盘；大仓或慢存储上一次 grep 就能卡住，取消/超时又在等这次结算。所以每条查询有超时、
// 整段有总预算，超了就退成「没核对出来」那一档 —— 结论差一点，总比门禁停在「正在跑」好。
import { eq } from "drizzle-orm";
import type { AcceptGateFailure, AcceptGateMissAttribution } from "@ash/shared/accept-gate";
import { db } from "./db/index.js";
import { acceptGateRuns, projects, tasks } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import { statSync } from "node:fs";
import { acceptGateLogHead } from "./accept-gate-process.js";
import { classifyGateLaunch, gateCommandMissNotice, occursAsWord,
  type GateMissOrigin } from "./accept-gate-miss.js";
import { decodeGateEntryProbe, entryFile, gateEntryAsk, scriptDefinedIn,
  type GateEntryProbe, type GateEntryAsk } from "./accept-gate-entry.js";

type GateRow = typeof acceptGateRuns.$inferSelect;

/** 日志开头读多少字节做判定。命令没跑起来时整份日志也就几百字节，这是宽松的上界。 */
/**
 * 判「这次日志里有没有别的程序写过东西」要看**完整**那一份（accept-gate-miss.ts 的第三件
 * 必要条件），所以这里按字节读整份、并把「是不是完整的」一起交出去。
 *
 * 仍然有上限：这段跑在结算里，几十 MB 的回归输出不该整份进内存。超限 = 那一道核不出来 →
 * 不授权免修（而且真到那个量级，日志里几乎必然已经有别的程序的输出了）。
 */
const LOG_PROOF_BYTES = 1_000_000;

/** 单条 git 查询的超时。只读查询，正常都是毫秒级；到这个数就是存储有事。 */
const GIT_TIMEOUT_MS = 4_000;

/** 整段核对的总预算。超了就退成「没核对出来」，不再发起新查询。 */
const ORIGIN_BUDGET_MS = 12_000;

/** 最多核几个候选文件 / 每份读多少字节。两道闸都是为了不让一次核对变成全仓扫描。 */
const MAX_CANDIDATES = 20;
const MAX_HOLDERS = 5;
/** 沿历史往回核定义时最多看几次提交。每看一次就是一次 `git show`。 */
const MAX_HISTORY = 10;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;

/**
 * 整段核对的账本。`until` 到点之后一条查询都不再发；`incomplete` 一旦被置上，**「目标
 * 分支上也没有」这个结论就不许再下**。
 *
 * 这两件事必须分开记（审查 F4 同源）：一次查询失败（超时、输出超限、仓库读不出）和
 * 「查了，没有」长得一模一样，而前者只能说「不知道」。拿一份残清单去否定它的存在，就是
 * 换一个地方重犯那条空头保证。正面证据不受影响 —— 找到落点就是找到了。
 */
type Budget = { until: number; incomplete: boolean };
const budget = (): Budget => ({ until: Date.now() + ORIGIN_BUDGET_MS, incomplete: false });
const spent = (b: Budget) => Date.now() >= b.until;

/** 一次 git 查询的结果。`ok: false` = 没问出来（跟「问了，答案是没有」不是一回事）。 */
type GitResult = { ok: true; code: number; stdout: string } | { ok: false };

/**
 * 跑一条只读 git 查询。
 *
 * `tolerate` 列出「非 0 但仍是确定答案」的退出码：`git grep` 没命中是 1，`cat-file -e`
 * 文件不存在也是 1。不在这张表里的失败一律算「没问出来」，并把账本标成 incomplete。
 */
async function gitRun(repo: string, args: string[], b: Budget, tolerate: number[] = []): Promise<GitResult> {
  if (spent(b)) { b.incomplete = true; return { ok: false }; }
  try {
    const { stdout } = await exec("git", ["-C", repo, ...args],
      { maxBuffer: MAX_BLOB_BYTES, timeout: Math.max(1, Math.min(GIT_TIMEOUT_MS, b.until - Date.now())) });
    return { ok: true, code: 0, stdout };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number" && tolerate.includes(code)) return { ok: true, code, stdout: "" };
    b.incomplete = true;
    return { ok: false };
  }
}

/** 只要内容、不在意「没问出来」与「答案是空」之分的那几处。 */
async function git(repo: string, args: string[], b: Budget): Promise<string | null> {
  const result = await gitRun(repo, args, b);
  return result.ok ? result.stdout : null;
}

/**
 * 整词含这个名字的文件。先用 `git grep` 取候选（子串、超集），再逐份按整词核实。
 *
 * 候选数、每份字节数都有闸：一次核对不该变成全仓扫描。候选被闸截断、或哪一份读不出来，
 * 都算没核全（incomplete），因为「漏掉的那一份里可能就有」。
 */
async function holdersIn(repo: string, commit: string, name: string, b: Budget): Promise<string[]> {
  const found = await gitRun(repo, ["grep", "-l", "--fixed-strings", "-e", name, commit, "--", "."], b, [1]);
  if (!found.ok) return [];
  // 输出形如 `<commit>:<path>`，而 path 自己可能含冒号，所以只切第一个。
  const all = found.stdout.split("\n").filter(Boolean).map(line => line.slice(line.indexOf(":") + 1));
  if (all.length > MAX_CANDIDATES) b.incomplete = true;
  const hits: string[] = [];
  for (const file of all.slice(0, MAX_CANDIDATES)) {
    const blob = await gitRun(repo, ["show", `${commit}:${file}`], b);
    if (blob.ok && occursAsWord(blob.stdout, name)) hits.push(file);
  }
  return hits;
}

/**
 * 这个路径在某棵树里是不是一个真实存在的文件。null = 没问出来。
 *
 * 用 `ls-tree` 而不是 `cat-file -e`：后者对「树里没这个路径」退的是 **128**，跟「仓库读
 * 不出」「提交号不认识」用的是同一个码，分不开「问了，答案是没有」和「没问出来」—— 这一层
 * 最要紧的恰恰就是这两者之别。`ls-tree` 把答案放在 stdout 上，路径不存在也退 0，于是任何
 * 非零都是真失败。只认 blob：树项不是一个能当入口跑的东西。
 */
async function blobExists(repo: string, commit: string, path: string, b: Budget): Promise<boolean | null> {
  const result = await gitRun(repo, ["ls-tree", "--full-tree", commit, "--", path], b);
  if (!result.ok) return null;
  return result.stdout.split("\n").some(line => line.split(/\s+/)[1] === "blob");
}

/**
 * 这个名字在那棵树里**有没有定义**。null = 核不出来。
 *
 * 这是第 2 轮审查 F2 换来的那条铁律的落点：存在性只认定义级判据（manifest 里的 scripts、
 * 或那个文件本身在不在树里），文字检索的空结果什么都不证明 —— 基线 `description` 里提过
 * 一句 `test:accept`，就足以让「出现这个名字的文件集合」差集为空。
 */
async function definitionOnTree(repo: string, commit: string, ask: GateEntryAsk, b: Budget): Promise<boolean | null> {
  const file = askFile(ask);
  if (ask.kind === "path") return blobExists(repo, commit, file, b);
  const manifest = await gitRun(repo, ["show", `${commit}:${file}`], b);
  return manifest.ok ? scriptDefinedIn(manifest.stdout, ask.name) : null;
}

/**
 * 这个名字在哪个文件里定义/落地。
 *
 * 定义级那一档**跟着 runner 真会读的那个目录走**（`npm --prefix child run x` 读的是
 * `child/package.json`，不是根目录那份 —— 第 3 轮审查 F1）。
 */
const askFile = entryFile;

/**
 * 这个**定义**是哪一次提交带进来的：沿着改过那份文件的提交从旧往新走，第一次核出「定义在
 * 了」的那一次就是它。核不出来返回 null —— 那时**只丢时间，不丢存在性**（见 readOrigin）。
 *
 * 为什么不能用 `git log -S<name>`（第 3 轮审查 F3 实测）：那问的是「这串字的出现次数什么
 * 时候变了」。审查那条反例里，一次 `DOCUMENTATION ONLY mention command` 的提交只往
 * `description` 里写了一句 `test:accept`，真正加 `scripts["test:accept"]` 的是再下一次提交 ——
 * 按 `-S` 取最早，报出来的是那次改说明文字的提交，照着去找只会找到一处无关改动。
 */
async function definitionIntroducedBy(repo: string, targetCommit: string, sourceCommit: string | null,
  ask: GateEntryAsk, b: Budget): Promise<Introduction | null> {
  const log = await git(repo, ["log", "--format=%H%x09%cI%x09%s", "--reverse",
    targetCommit, ...(sourceCommit ? ["--not", sourceCommit] : []), "--", askFile(ask)], b);
  for (const row of (log ?? "").split("\n").filter(Boolean).slice(0, MAX_HISTORY)) {
    const [commit, date, ...subject] = row.split("\t");
    if (!commit) continue;
    const defined = await definitionOnTree(repo, commit, ask, b);
    // 读不出来（blob 超上限、超时、对象损坏）**不等于「那时还没有」**。跳过它继续往后找，
    // 就会把后面第一个读得动的提交冒认成「最早带进来的」—— 第 4 轮审查 F3 实测：一份 2 MiB
    // 的 package.json 读不动，于是一次只缩短 description 的提交被报成了引入提交。
    // 这里交白卷只丢「什么时候」，存在性和落后多少仍由 readOrigin 照常给出。
    if (defined === null) return null;
    if (!defined) continue;
    // **「那次提交上有定义」不等于「是那次加进来的」**（第 7 轮审查 F4 实测）：共同历史上
    // 本来就有定义、父分支把它删了、任务从缺失那一版开工时，`--not source` 剩下的第一个
    // 提交只是「目标独有历史里最早看见它」—— 审查那条反例里那是一次只改 description 的
    // 提交，照它去找只会找到一处无关改动。所以要核出 absent→present 这个转换本身。
    const introduced = await definitionAbsentInParents(repo, commit, ask, b);
    if (introduced === null) return null;
    if (introduced) return { commit, date: date ?? null, subject: subject.join("\t") || null };
  }
  return null;
}

/**
 * 这次提交的**每个父提交**上这个定义都不存在吗 —— 即它是不是真的在这儿从「没有」变成
 * 「有」。null = 没问出来（那时只丢时间，不丢存在性）。
 *
 * 合并提交上只要有一个父已经有定义，它就不是引入点（定义是从那条支线合过来的，真正的引入
 * 在支线上）。根提交没有父，它本身就是起点。
 */
async function definitionAbsentInParents(repo: string, commit: string, ask: GateEntryAsk, b: Budget): Promise<boolean | null> {
  const parents = await gitRun(repo, ["log", "--format=%P", "-1", commit], b);
  if (!parents.ok) return null;
  const list = parents.stdout.trim().split(/\s+/).filter(Boolean);
  if (!list.length) return true;
  for (const parent of list) {
    const defined = await definitionOnTree(repo, parent, ask, b);
    if (defined === null) return null;
    if (defined) return false;
  }
  return true;
}

/**
 * 这个定义**是不是目标分支新加的**（共同祖先上没有、目标上有）。
 *  - `true`  目标独有的新增；
 *  - `false` 共同祖先上就有，而这份快照里没有 —— 删除发生在**任务这一侧**；
 *  - `null`  没问出来。
 *
 * **它只是两份内容事实，推不出合并结果**（第 8 轮审查 F3 实测）：审查那条反例给仓库配了
 * `.gitattributes` 里的 `package.json merge=keep-local` 自定义驱动，`git merge main` 退 0、
 * 没有冲突、按项目这份合法配置保留了任务侧的 manifest —— 合完那条命令照旧不在树里。合并
 * 策略、合并驱动、多个共同祖先、冲突都能改掉结果，而那些都不是读几个提交的内容能预测的。
 * 所以 `true` 这一档**也不许**说「合进来它就在树里了」，只能说「它是目标分支新加的，合完
 * 请先核一眼它在不在树里」（措辞在 accept-gate-miss.ts）。
 *
 * 要拿到可信的合并结果只能真去合一次 —— 那又是一次带副作用的额外执行，第 8 轮审查 F2 已经
 * 判死那条路（诊断不许替用户多做事）。
 *
 * 第 7 轮审查 F3 实测的拓扑：共同祖先/目标 main 上有验收脚本，父分支删了它，任务从父分支那
 * 一版开工（自己没再删一次，所以归因是 not-mine），main 还停在祖先位置 —— 旧版同时说出
 * 「合它进来也不会多出什么」和「把 main 合进来，那时它就在树里了」，而 `git merge main`
 * 根本不会恢复源侧的删除。
 *
 * **这里用共同祖先是对的，跟归因那条规矩不冲突**：归因问「这个定义是谁弄没的」，那只能用
 * 任务自己记下的开工起点（第 4 轮审查 F2：共同祖先会把继承来的删除错判成 not-mine）；这里
 * 问的是「合并会把什么带进来」，而三方合并的语义本身就定义在共同祖先上。
 */
async function targetAddedDefinition(repo: string, sourceCommit: string, targetCommit: string,
  ask: GateEntryAsk, b: Budget): Promise<boolean | null> {
  const base = await gitRun(repo, ["merge-base", sourceCommit, targetCommit], b);
  const at = base.ok ? base.stdout.trim().split("\n")[0]?.trim() : "";
  if (!at) return null;
  const atBase = await definitionOnTree(repo, at, ask, b);
  return atBase === null ? null : !atBase;
}

type Introduction = { commit: string; date: string | null; subject: string | null };

/** 这串**字**最早是哪一次提交写进那个文件的（只给文字线索那一档用）。 */
async function textIntroducedBy(repo: string, targetCommit: string, sourceCommit: string | null,
  name: string, file: string, b: Budget): Promise<Introduction | null> {
  const log = await git(repo, ["log", "--format=%H%x09%cI%x09%s", `-S${name}`,
    targetCommit, ...(sourceCommit ? ["--not", sourceCommit] : []), "--", file], b);
  const oldest = (log ?? "").split("\n").filter(Boolean).at(-1);
  if (!oldest) return null;
  const [commit, date, ...subject] = oldest.split("\t");
  return { commit: commit!, date: date ?? null, subject: subject.join("\t") || null };
}

/**
 * 「它在目标分支上存不存在、是什么时候进去的」。
 *
 * `behind`（落后几个提交）总是先算：核对后面几步可能读不出来或超预算，而这一条只要两个
 * 提交号就成立，是最低那一档也要给的事实（需求第 2 点允许退到这里）。
 */
async function readOrigin(repo: string, targetBranch: string, sourceCommit: string | null,
  name: string | null, command: string, startCommit: string | null,
  probe: GateEntryProbe | null): Promise<GateMissOrigin | null> {
  const b = budget();
  // `--verify --quiet` 对「没有这条分支」退 1，那是确定答案,不是读不出来。
  const resolved = await gitRun(repo, ["rev-parse", "--verify", "--quiet", `${targetBranch}^{commit}`], b, [1]);
  const targetCommit = resolved.ok ? resolved.stdout.trim() || null : null;
  if (!targetCommit) return null;
  const behindOut = sourceCommit ? await git(repo, ["rev-list", "--count", `${sourceCommit}..${targetCommit}`], b) : null;
  const behind = behindOut === null ? null : Number.parseInt(behindOut.trim(), 10);
  const origin: GateMissOrigin = { targetBranch, targetCommit,
    behind: Number.isFinite(behind as number) ? behind as number : null,
    holders: [], absent: null, removedByTask: null, targetAddedIt: null, unverified: true };
  // ── ① 定义级：命令形状认得出来，就能给出「有／没有」的确定答案 ──
  // **核的对象必须跟起跑前真核过的那个是同一个**（第 9 轮审查 F2）：这一层重新解释一遍命令行
  // 只会再得到同一个静态答案，而那个答案可能压根不是 runner 真去找的那份 manifest。对不上
  // （没核过、名字不同、落点那份文件不是同一个）就不走这一档 —— 不给 absent、不给
  // removedByTask，于是归因只能落 unknown，不会变成一张免修令。
  const ask = gateEntryAsk(command);
  const sameObject = !!ask && !!probe && probe.ask === ask.name && probe.file === askFile(ask);
  if (ask && sameObject) {
    const onTarget = await definitionOnTree(repo, targetCommit, ask, b);
    const inSnapshot = sourceCommit ? await definitionOnTree(repo, sourceCommit, ask, b) : null;
    // 「没启动」推不出「不是你改的」（审查 F1）：基线上有、快照里没了 = 这次改动弄没的。
    if (inSnapshot === false && sourceCommit) origin.removedByTask = await removedByTask(repo, startCommit, ask, b);
    if (onTarget === true && inSnapshot !== true) {
      // 存在性已经核实了,时间核不出来**只丢时间**:旧版本在这儿没有 holder 就整段退成
      // 「没能核对出来」,把已经拿到的正面事实一起丢掉（第 3 轮审查 F3 末段）。
      const where = await definitionIntroducedBy(repo, targetCommit, sourceCommit, ask, b);
      origin.holders.push({ file: askFile(ask), how: ask.kind === "path" ? "path" : "definition",
        commit: where?.commit ?? null, date: where?.date ?? null, subject: where?.subject ?? null });
      // 「目标上有」推不出「合它进来就有」（第 7、8 轮审查 F3）：源侧删除会被合并保留，
      // 而自定义合并驱动连「目标新加」也能挡掉。所以这里只取两份内容事实，不预测合并结果。
      const added = sourceCommit ? await targetAddedDefinition(repo, sourceCommit, targetCommit, ask, b) : null;
      return { ...origin, targetAddedIt: added, unverified: false };
    }
    if (onTarget === false) return { ...origin, absent: ask.kind === "path" ? "path" : "definition", unverified: false };
    // onTarget === null（manifest 读不动等）：落到底下的文字线索，但**不许**据此说「也没有」。
  }
  // ── ② 文字线索：只能给正面落点（带对冲），查空什么都不证明（审查 F2）──
  if (!name) return origin;
  const onTarget = await holdersIn(repo, targetCommit, name, b);
  const inSnapshot = sourceCommit ? new Set(await holdersIn(repo, sourceCommit, name, b)) : new Set<string>();
  for (const file of onTarget.filter(hit => !inSnapshot.has(hit)).slice(0, MAX_HOLDERS)) {
    const where = await textIntroducedBy(repo, targetCommit, sourceCommit, name, file, b);
    origin.holders.push({ file, how: "text",
      commit: where?.commit ?? null, date: where?.date ?? null, subject: where?.subject ?? null });
  }
  // 找到落点 = 正面证据，残不残都算数。一个都没找到时**不是**「目标分支上没有」—— 文字
  // 检索答不了那个问题，所以留在 unverified 这一档（absent 仍是 null）。
  return { ...origin, unverified: !origin.holders.length };
}

/**
 * 它是不是**这次改动**弄没的：这个任务**真实的开工起点**上有定义、而任务这份快照里没有。
 * null = 核不出来（没记起点、或者那个提交已经读不到了）。
 *
 * **不许用 merge-base 代替**（第 4 轮审查 F2 实测）：共同祖先只证明「两边都从这儿分出去
 * 过」，证明不了这份任务从哪份代码开工。派生任务从父任务分支开工时，共同祖先往往是更早的
 * 目标分支、上面本来就没有这个脚本 —— 于是「任务把继承来的验收脚本删了」会被判成 not-mine，
 * 紧接着发一张免修令，而那时正确的出路恰恰是去把它改回来。起点读不出来就老实说未知。
 */
async function removedByTask(repo: string, startCommit: string | null,
  ask: GateEntryAsk, b: Budget): Promise<boolean | null> {
  if (!startCommit) return null;
  const resolved = await gitRun(repo, ["rev-parse", "--verify", "--quiet", `${startCommit}^{commit}`], b, [1]);
  const start = resolved.ok ? resolved.stdout.trim() : "";
  if (!start) return null;
  const atStart = await definitionOnTree(repo, start, ask, b);
  return atStart === null ? null : atStart;
}

/**
 * 一次门禁红了之后的归类。返回 null = 认不出，照旧按「命令退出码非 0」处理。
 *
 * 只在 `exit_code` 这一档上问：超时、取消、被打断、起不来都已经有确切的理由了，再往上
 * 盖一层只会把那些更准的结论盖掉。
 *
 * **退出码要拿这一次真的那个**（第 1 轮审查 N1）：`row` 是结算前读出来的那一行，上面的
 * exitCode 还是插入时的 null，所以只能由调用方把 outcome 里的真实值喂进来。
 */
export async function diagnoseGateFailure(row: GateRow, outcome: { failure: AcceptGateFailure | null; exitCode: number | null }): Promise<
  { failure: AcceptGateFailure | null; diagnosis: string; attribution: AcceptGateMissAttribution | null } | null
> {
  if (outcome.failure !== "exit_code") return null;
  // **入口事实只从那一行读回来**：它是 spawn 之前核的（accept-gate-entry.ts），现在再去
  // 看一眼快照只会拿到跑完之后的状态 —— 审查 F1 那条自删脚本就是这么被说成「没启动」的。
  const logSize = (() => { try { return statSync(row.logPath).size; } catch { return null; } })();
  const probe = decodeGateEntryProbe(row.entryProbe);
  const miss = classifyGateLaunch({ command: row.command, exitCode: outcome.exitCode,
    log: acceptGateLogHead(row.logPath, LOG_PROOF_BYTES),
    logComplete: logSize !== null && logSize <= LOG_PROOF_BYTES,
    entry: probe });
  if (!miss) return null;
  // inner 这一档不去核仓库：缺的是命令内部点名的东西（node 模块、python 包），「它在
  // 目标分支上有没有」对那种缺失既答不准也帮不上忙，查了只会给出一句误导的话。
  const repo = miss.kind === "entry"
    ? (await db.select().from(projects).where(eq(projects.id, row.projectId))).at(0)?.repoPath ?? null : null;
  // 归因要的是**这个任务从哪儿开工**，库里记着（`tasks.worktree_start_commit`），不许拿
  // 拓扑去推（第 4 轮审查 F2）。读不到就让 removedByTask 交白卷 → 归因落 unknown。
  const startCommit = miss.kind === "entry"
    ? (await db.select().from(tasks).where(eq(tasks.id, row.taskId))).at(0)?.worktreeStartCommit ?? null : null;
  const origin = repo && row.targetBranch
    ? await readOrigin(repo, row.targetBranch, row.sourceCommit ?? null, miss.name, row.command, startCommit, probe)
      .catch(() => null)
    : null;
  // 归因只有两档，**两档都是「你去核」**（第 10 轮审查 F2）：
  //  · mine     起跑前核的那份定义，开工基线上有、这份快照里没了 → 线索指向这次改动；
  //  · unknown  其余全部（基线上也没有、目标 ref 读不到、非 git 快照、超预算…）。
  //
  // 曾经有第三档 not-mine，由「基线上也没有」授权，交出去的是一张免修令。它撤掉了：核的是
  // **起跑前静态读到的那个对象**，而 runner 真去找的是不是它，这一层核不到（PATH 上的同名
  // 包装器、`.npmrc`、workspace 配置都能把落点挪走）。两次静态读到同一个对象 ≠ 对象身份已
  // 核实，所以存在性只当线索、责任保留为未知。
  //
  // failure 同理：**一律照实**留在 outcome 那一档。「测试没有启动」这句话没有能绑到这次执行
  // 身份上的证据（第 10 轮审查 F1），所以 `command_missing` 这个类别整个撤掉了。
  const attribution: AcceptGateMissAttribution | null = miss.kind !== "entry" ? null
    : origin?.removedByTask === true ? "mine" : "unknown";
  return {
    attribution,
    failure: outcome.failure,
    diagnosis: gateCommandMissNotice({ command: row.command, miss, sourceCommit: row.sourceCommit ?? null, origin }),
  };
}
