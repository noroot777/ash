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
import type { AcceptGateFailure } from "@ash/shared/accept-gate";
import { db } from "./db/index.js";
import { acceptGateRuns, projects } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import { acceptGateLogHead } from "./accept-gate-process.js";
import { classifyGateLaunch, gateCommandMissNotice, missFailure, occursAsWord,
  type GateMissOrigin } from "./accept-gate-miss.js";
import { decodeGateEntryProbe, gateEntryAsk, scriptDefinedIn, type GateEntryAsk } from "./accept-gate-entry.js";

type GateRow = typeof acceptGateRuns.$inferSelect;

/** 日志开头读多少字节做判定。命令没跑起来时整份日志也就几百字节，这是宽松的上界。 */
const DIAGNOSIS_HEAD_BYTES = 16_000;

/** 单条 git 查询的超时。只读查询，正常都是毫秒级；到这个数就是存储有事。 */
const GIT_TIMEOUT_MS = 4_000;

/** 整段核对的总预算。超了就退成「没核对出来」，不再发起新查询。 */
const ORIGIN_BUDGET_MS = 12_000;

/** 最多核几个候选文件 / 每份读多少字节。两道闸都是为了不让一次核对变成全仓扫描。 */
const MAX_CANDIDATES = 20;
const MAX_HOLDERS = 5;
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
  if (ask.kind === "path") return blobExists(repo, commit, ask.name.replace(/^\.\/+/, ""), b);
  const manifest = await gitRun(repo, ["show", `${commit}:package.json`], b);
  return manifest.ok ? scriptDefinedIn(manifest.stdout, ask.name) : null;
}

/** 这个名字在哪个文件里定义/落地。定义级那一档固定看 manifest。 */
const askFile = (ask: GateEntryAsk) => ask.kind === "path" ? ask.name.replace(/^\.\/+/, "") : "package.json";

/** 某个落点在目标分支上**最早**是哪一次提交写进去的（从新往旧列，取最后一行）。 */
async function introducedBy(repo: string, targetCommit: string, sourceCommit: string | null, name: string | null,
  file: string, added: boolean, b: Budget): Promise<{ commit: string; date: string; subject: string } | null> {
  const log = await git(repo, ["log", "--format=%H%x09%cI%x09%s",
    ...(added ? ["--diff-filter=A"] : [`-S${name}`]),
    targetCommit, ...(sourceCommit ? ["--not", sourceCommit] : []), "--", file], b);
  const oldest = (log ?? "").split("\n").filter(Boolean).at(-1);
  if (!oldest) return null;
  const [commit, date, ...subject] = oldest.split("\t");
  return { commit: commit!, date: date ?? "", subject: subject.join("\t") };
}

/**
 * 「它在目标分支上存不存在、是什么时候进去的」。
 *
 * `behind`（落后几个提交）总是先算：核对后面几步可能读不出来或超预算，而这一条只要两个
 * 提交号就成立，是最低那一档也要给的事实（需求第 2 点允许退到这里）。
 */
async function readOrigin(repo: string, targetBranch: string, sourceCommit: string | null,
  name: string | null, command: string): Promise<GateMissOrigin | null> {
  const b = budget();
  // `--verify --quiet` 对「没有这条分支」退 1，那是确定答案,不是读不出来。
  const resolved = await gitRun(repo, ["rev-parse", "--verify", "--quiet", `${targetBranch}^{commit}`], b, [1]);
  const targetCommit = resolved.ok ? resolved.stdout.trim() || null : null;
  if (!targetCommit) return null;
  const behindOut = sourceCommit ? await git(repo, ["rev-list", "--count", `${sourceCommit}..${targetCommit}`], b) : null;
  const behind = behindOut === null ? null : Number.parseInt(behindOut.trim(), 10);
  const origin: GateMissOrigin = { targetBranch, targetCommit,
    behind: Number.isFinite(behind as number) ? behind as number : null,
    holders: [], absent: null, removedByTask: null, unverified: true };
  // ── ① 定义级：命令形状认得出来，就能给出「有／没有」的确定答案 ──
  const ask = gateEntryAsk(command);
  if (ask) {
    const onTarget = await definitionOnTree(repo, targetCommit, ask, b);
    const inSnapshot = sourceCommit ? await definitionOnTree(repo, sourceCommit, ask, b) : null;
    // 「没启动」推不出「不是你改的」（审查 F1）：基线上有、快照里没了 = 这次改动弄没的。
    if (inSnapshot === false && sourceCommit) origin.removedByTask = await removedByTask(repo, sourceCommit, targetCommit, ask, b);
    if (onTarget === true && inSnapshot !== true) {
      const where = await introducedBy(repo, targetCommit, sourceCommit, name, askFile(ask), ask.kind === "path", b);
      if (where) origin.holders.push({ file: askFile(ask), how: ask.kind === "path" ? "path" : "definition", ...where });
      return { ...origin, unverified: !origin.holders.length && b.incomplete };
    }
    if (onTarget === false) return { ...origin, absent: ask.kind === "path" ? "path" : "definition", unverified: false };
    // onTarget === null（manifest 读不动等）：落到底下的文字线索，但**不许**据此说「也没有」。
  }
  // ── ② 文字线索：只能给正面落点（带对冲），查空什么都不证明（审查 F2）──
  if (!name) return origin;
  const onTarget = await holdersIn(repo, targetCommit, name, b);
  const inSnapshot = sourceCommit ? new Set(await holdersIn(repo, sourceCommit, name, b)) : new Set<string>();
  for (const file of onTarget.filter(hit => !inSnapshot.has(hit)).slice(0, MAX_HOLDERS)) {
    const where = await introducedBy(repo, targetCommit, sourceCommit, name, file, false, b);
    if (where) origin.holders.push({ file, how: "text", ...where });
  }
  // 找到落点 = 正面证据，残不残都算数。一个都没找到时**不是**「目标分支上没有」—— 文字
  // 检索答不了那个问题，所以留在 unverified 这一档（absent 仍是 null）。
  return { ...origin, unverified: !origin.holders.length };
}

/**
 * 它是不是**这次改动**弄没的：开工基线（任务与目标的共同祖先）上有定义，任务这份快照里
 * 没有。null = 核不出来。
 */
async function removedByTask(repo: string, sourceCommit: string, targetCommit: string,
  ask: GateEntryAsk, b: Budget): Promise<boolean | null> {
  const base = (await git(repo, ["merge-base", sourceCommit, targetCommit], b))?.trim();
  if (!base) return null;
  const atBase = await definitionOnTree(repo, base, ask, b);
  return atBase === null ? null : atBase;
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
  { failure: AcceptGateFailure | null; diagnosis: string } | null
> {
  if (outcome.failure !== "exit_code") return null;
  // **入口事实只从那一行读回来**：它是 spawn 之前核的（accept-gate-entry.ts），现在再去
  // 看一眼快照只会拿到跑完之后的状态 —— 审查 F1 那条自删脚本就是这么被说成「没启动」的。
  const miss = classifyGateLaunch({ command: row.command, exitCode: outcome.exitCode,
    log: acceptGateLogHead(row.logPath, DIAGNOSIS_HEAD_BYTES),
    entry: decodeGateEntryProbe(row.entryProbe) });
  if (!miss) return null;
  // inner 这一档不去核仓库：缺的是命令内部点名的东西（node 模块、python 包），「它在
  // 目标分支上有没有」对那种缺失既答不准也帮不上忙，查了只会给出一句误导的话。
  const repo = miss.kind === "entry"
    ? (await db.select().from(projects).where(eq(projects.id, row.projectId))).at(0)?.repoPath ?? null : null;
  const origin = repo && row.targetBranch
    ? await readOrigin(repo, row.targetBranch, row.sourceCommit ?? null, miss.name, row.command).catch(() => null)
    : null;
  // 这次改动自己把它删了/改名了 → 这条红**是**要改代码的那一种，不许改写成
  // command_missing（那一档的整副面孔都是「不要动代码」）。结论正文仍然照实说明。
  const failure = origin?.removedByTask === true ? outcome.failure : missFailure(miss) ?? outcome.failure;
  return {
    failure,
    diagnosis: gateCommandMissNotice({ command: row.command, miss, sourceCommit: row.sourceCommit ?? null, origin }),
  };
}
