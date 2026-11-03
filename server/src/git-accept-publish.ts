// 合并预览档最终发布的执行边界：把目标检出的文件改成测过的那份时，git 读到的配置、属性与环境
// 只能是 ash 定下的那一份，不能是仓库此刻的样子（第 5 轮复审第 2 轮 F2：门禁核对之后另一个窗口给
// 仓库配了 `filter.<名>.smudge`，最终的 `merge --ff-only` 照样把它跑了起来 —— 只关钩子封不住，
// 再扫一遍配置也封不住，扫完之后照样能改）。
//
// 做法与测试快照同一个思路（accept-gate-preview.ts 的 cloneSealedSnapshot）：
//  · 一份临时 git 目录，对象库借项目的（alternates，只读），本地配置只有 ash 写的那几项 —— 门禁测的
//    时候用的检出语义（换行 / 链接 / 路径，进凭据的那份身份核过才用）、空钩子目录、空属性文件、
//    fsmonitor 关；系统 / 全局配置与属性不读（sealedGitEnv）。没有任何一项能指向程序：过滤器驱动
//    没定义，带 `filter=` 属性的文件就原样写出 —— 测试快照也正是这么写的。
//  · 属性只取自测过的那棵树（`--attr-source`），不读工作区里可能被改过的 .gitattributes。
//  · 目标检出当工作区，索引用一份临时的：从目标提交建起，两树 `read-tree -m -u` 只改这次要改的
//    文件（会覆盖本地改动或未跟踪文件时 git 自己拒绝、什么都不写）。
//
// 这几步全程持有目标检出的 `index.lock`（与 git 自己的约定相同：拿不到就说明有别的 git 在用这个检出，
// 拒），最后才把临时索引换进去。分支本身由调用方带旧值挪（update-ref 不读属性、不调过滤器）。
//
// 顺序是「先演、再挪分支、最后写文件」（用户 2026-11-04 拍板，第 6 轮审查第 3～5 轮 F1）。写文件那一步
// 不是事务，旧做法先写文件、挪分支被拒再把写下的放回原样；但「放回」要删掉这次写下的条目，而删之前
// 证明它仍是自己写的那个版本（没被另一个窗口原地保存过、目录项没被换过）在用户态没有原子做法，
// 三轮下来每补一道核对都还剩一个窗口。所以不再放回：
//  · 两树合并先在临时索引上演一遍（`read-tree -n`，不写文件）—— 会覆盖本地改动或未跟踪文件这类拒绝
//    在这里就出来，什么都没动；
//  · 再挪分支（带旧值，被别人挪过就拒）—— 最常见的失败「测过之后目标分支动了」在写任何文件之前出来；
//  · 最后才写文件、换索引。写到一半失败（权限、磁盘满）就停在那儿如实交付：分支已挪的，换上测过那棵
//    的索引，`git status` 显示的正是还没写成的那些，`git checkout HEAD -- <路径>` 补齐；不提交那一档
//    分支和索引都没动，交付已经写下的那些。ash 不删检出里的任何东西。
import { copyFile, lstat, mkdtemp, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { type CheckoutSettings, readOnlyGit, sealedGitEnv } from "./accept-gate-preview.js";
import { execFileText as exec } from "./exec.js";

const MAX_BUFFER = 32 * 1024 * 1024;

export type SealedCheckout = {
  /** 在封好的环境里跑一条 git（工作区 = 目标检出，索引缺省 = 临时那份）；`attrs` = 属性取自哪棵树。 */
  run(attrs: string, args: string[], index?: string): Promise<string>;
  dispose(): Promise<void>;
};

/** 为目标检出 `checkout` 建一份封好的发布环境。`settings` 是门禁测的时候用的检出语义。 */
async function sealedCheckout(checkout: string, settings: CheckoutSettings): Promise<SealedCheckout & { index: string; dir: string; checkout: string }> {
  const { env: base, empty } = await sealedGitEnv();
  const ask = async (args: string[]) => (await readOnlyGit(checkout, args)).stdout.trim();
  const format = await ask(["rev-parse", "--show-object-format"]) || "sha1";
  const common = await ask(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const filemode = (await readOnlyGit(checkout, ["config", "--type=bool", "core.filemode"]).catch(() => null))?.stdout.trim() || "true";
  const dir = await mkdtemp(join(tmpdir(), "ash-publish-"));
  try {
    const gitDir = join(dir, "git");
    await exec("git", ["init", "--bare", "-q", "--template=", `--object-format=${format}`, gitDir], { env: base });
    await mkdir(join(gitDir, "objects", "info"), { recursive: true });
    await writeFile(join(gitDir, "objects", "info", "alternates"), `${join(common, "objects")}\n`);
    const entries: [string, string][] = [["core.bare", "false"], ["core.filemode", filemode], ...settings,
      ["core.hooksPath", empty], ["core.attributesFile", empty], ["core.fsmonitor", "false"]];
    for (const [key, value] of entries) await exec("git", ["config", "--file", join(gitDir, "config"), key, value], { env: base });
    const index = join(dir, "index");
    const env = { ...base, GIT_DIR: gitDir, GIT_WORK_TREE: checkout };
    return {
      index,
      dir,
      checkout,
      run: async (attrs, args, file = index) => (await exec("git", [`--attr-source=${attrs}`, ...args],
        { env: { ...env, GIT_INDEX_FILE: file }, maxBuffer: MAX_BUFFER })).stdout,
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

const zList = (text: string) => text.split("\0").filter(Boolean);
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * 建一份 `tree` 的索引（`file`），按封好的语义逐个核过工作区字节；返回 `changed` 里还没成那份的路径：
 * 该在的字节不对（或没了），该删的还在。
 */
async function pendingAgainst(sealed: Awaited<ReturnType<typeof sealedCheckout>>, attrs: string, tree: string,
  file: string, changed: readonly string[]): Promise<string[]> {
  await sealed.run(attrs, ["read-tree", tree], file);
  await sealed.run(attrs, ["update-index", "-q", "--refresh"], file).catch(() => "");
  const tracked = new Set(zList(await sealed.run(attrs, ["ls-files", "-z"], file)));
  const dirty = new Set(zList(await sealed.run(attrs, ["diff-files", "--name-only", "-z"], file)));
  const pending: string[] = [];
  for (const path of changed) {
    if (tracked.has(path) ? dirty.has(path) : await lstat(join(sealed.checkout, path)).then(() => true, () => false)) pending.push(path);
  }
  return pending;
}

/**
 * 失败回执。`blocked` / `publish` = 分支和检出里的文件都没动。`partial` = 写文件写到一半失败：
 * `published` 说分支挪没挪；`pending` 是还没写成测过那份的路径，`written` 是已经写成的（null = 核不出来）；
 * `indexInstalled` = 已换上测过那棵的索引（只有分支挪了才换）。`index` = 文件都写成了，只有索引没换上。
 */
export type SealedMove =
  | { ok: true }
  | { ok: false; stage: "locked"; message: string }
  | { ok: false; stage: "blocked"; message: string }
  | { ok: false; stage: "publish"; message: string }
  | { ok: false; stage: "partial"; message: string; published: boolean; pending: string[] | null;
    written: string[] | null; indexInstalled: boolean }
  | { ok: false; stage: "index"; message: string; published: boolean };

/**
 * 拿到锁之后核真实索引（第 6 轮审查 F2）：「工作区干净」是拿锁之前核的，那之后另一个终端仍可能
 * `git add` 了东西（再把文件改回原样，工作区与物理摘要都看不出来）。新索引是从目标提交建的，直接换上去
 * 就把那份暂存抹掉了。所以持锁后读一份真实索引的拷贝，它的暂存内容必须正是目标提交那棵树；不是就拒，
 * 什么都还没写。持着锁，之后谁也改不了它。返回 null = 对得上。
 *
 * 真实索引不一定自包含（第 6 轮审查第 2 轮 F2）：拆分索引（`core.splitIndex`）的主文件只记增量，靠
 * 扩展引用旁边的 `sharedindex.<哈希>`，git 按「索引文件所在目录」找它。所以拷贝时把它一起拷到副本旁边；
 * 读不了就如实说读不了，不当成「多了暂存」。
 */
async function stagedBeyond(env: Awaited<ReturnType<typeof sealedCheckout>>, attrs: string, checkout: string,
  index: string, from: string): Promise<string | null> {
  const copy = join(env.dir, "index.real");
  if (!await copyFile(index, copy).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) return null;
  let staged: string[];
  try {
    const shared = (await readOnlyGit(checkout, ["rev-parse", "--shared-index-path"])).stdout.trim();
    if (shared) await copyFile(resolve(checkout, shared), join(env.dir, basename(shared)));
    staged = zList(await env.run(attrs, ["diff-index", "--cached", "--name-only", "-z", from], copy));
  } catch (error) {
    return `读不了目标检出的暂存区（${failure(error)}），没法确认换上测过的索引不会抹掉别人的暂存`;
  }
  if (!staged.length) return null;
  const shown = staged.slice(0, 10).join("、") + (staged.length > 10 ? ` 等 ${staged.length} 个` : "");
  return `目标检出的暂存区在核对之后有了别的内容（${shown}），换上测过的索引会把它们抹掉`;
}

/**
 * 把目标检出（HEAD 在 `from`）的工作区与索引改成 `to` 那棵树，在封好的环境里。`publish` 是挪分支那一步
 * （不提交那一档不传），在演过两树合并之后、写任何文件之前调用。`attrs` 是测过的那棵树（属性的唯一出处）。
 *
 * 不抛异常：回执由真实走到了哪一步决定（见 SealedMove）。之后只剩清理临时目录，它失败不改变回执。
 */
export async function sealedMove(checkout: string, settings: CheckoutSettings, from: string, to: string, attrs: string,
  publish?: () => Promise<string | null>): Promise<SealedMove> {
  const index = (await readOnlyGit(checkout, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
  const lock = `${index}.lock`;
  const handle = await open(lock, "wx").catch(() => null);
  if (!handle) return { ok: false, stage: "locked", message: `${lock} 已经存在：有别的 git 命令正在用这个检出` };
  await handle.close();
  let installed = false;
  let sealed: Awaited<ReturnType<typeof sealedCheckout>> | null = null;
  const outcome = await (async (): Promise<SealedMove> => {
    let published = false;
    let wrote = false;
    try {
      const env = sealed = await sealedCheckout(checkout, settings);
      const drift = await stagedBeyond(env, attrs, checkout, index, from);
      if (drift) return { ok: false, stage: "blocked", message: drift };
      // 新建的索引没有文件状态，先按封好的语义逐个核一遍字节补上（与目标提交对不上的照旧记成「改过」，
      // 要改到它时 git 就拒），两树合并才认得出哪些文件是干净的。先演一遍，什么都不写。
      await env.run(attrs, ["read-tree", from]);
      await env.run(attrs, ["update-index", "-q", "--refresh"]).catch(() => "");
      await env.run(attrs, ["read-tree", "-n", "-m", "-u", from, to]);
      const refused = await publish?.().catch(failure) ?? null;
      if (refused) return { ok: false, stage: "publish", message: refused };
      published = !!publish;
      try {
        await env.run(attrs, ["read-tree", "-m", "-u", from, to]);
      } catch (error) {
        return await stopped(env, failure(error), published);
      }
      wrote = true;
      await copyFile(env.index, lock);
      await rename(lock, index);
      installed = true;
      return { ok: true };
    } catch (error) {
      if (wrote) return { ok: false, stage: "index", message: failure(error), published };
      if (published && sealed) return stopped(sealed, failure(error), published);
      return { ok: false, stage: "blocked", message: failure(error) };
    }
  })();

  /** 写到一半失败：不放回（见文件头）。分支挪了就换上测过那棵的索引；核出哪些写成了、哪些还没有。 */
  async function stopped(env: Awaited<ReturnType<typeof sealedCheckout>>, message: string,
    published: boolean): Promise<SealedMove> {
    const changed = await env.run(attrs, ["diff-tree", "-r", "-z", "--name-only", from, to]).then(zList, () => null);
    const target = join(env.dir, "index.tested");
    const pending = changed && await pendingAgainst(env, attrs, to, target, changed).catch(() => null);
    const written = changed && pending ? changed.filter(path => !pending.includes(path)) : null;
    let indexInstalled = false;
    if (published && pending) {
      indexInstalled = await copyFile(target, lock).then(() => rename(lock, index)).then(() => true, () => false);
      installed = indexInstalled;
    }
    return { ok: false, stage: "partial", message, published, pending: pending ?? changed, written, indexInstalled };
  }

  const lockStuck = !installed && await rm(lock, { force: true }).then(() => false, () => true);
  // 清理失败不改变回执（走到哪一步的事实已定），但留一条看得见的记录。
  const done = sealed as Awaited<ReturnType<typeof sealedCheckout>> | null;
  await done?.dispose().catch((error: unknown) =>
    console.warn(`[ash] 验收发布的临时目录没能删掉：${done.dir}（${failure(error)}），可以手动删掉`));
  if (!lockStuck || outcome.ok) return outcome;
  return { ...outcome, message: `${outcome.message}（另外 ${lock} 没能删掉，它在的时候这个检出里的 git 命令都会拒绝，请手动删掉）` };
}
