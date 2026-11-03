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
import { copyFile, mkdtemp, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckoutSettings, readOnlyGit, sealedGitEnv } from "./accept-gate-preview.js";
import { execFileText as exec } from "./exec.js";

const MAX_BUFFER = 32 * 1024 * 1024;

export type SealedCheckout = {
  /** 在封好的环境里跑一条 git（工作区 = 目标检出，索引 = 临时那份）；`attrs` = 属性取自哪棵树。 */
  run(attrs: string, args: string[]): Promise<string>;
  dispose(): Promise<void>;
};

/** 为目标检出 `checkout` 建一份封好的发布环境。`settings` 是门禁测的时候用的检出语义。 */
async function sealedCheckout(checkout: string, settings: CheckoutSettings): Promise<SealedCheckout & { index: string }> {
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
    const env = { ...base, GIT_DIR: gitDir, GIT_WORK_TREE: checkout, GIT_INDEX_FILE: index };
    return {
      index,
      run: async (attrs, args) => (await exec("git", [`--attr-source=${attrs}`, ...args], { env, maxBuffer: MAX_BUFFER })).stdout,
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export type SealedMove =
  | { ok: true }
  | { ok: false; stage: "locked" | "blocked" | "publish"; message: string; restored?: boolean };

/**
 * 把目标检出（HEAD 在 `from`）的工作区与索引改成 `to` 那棵树，在封好的环境里。`publish` 在换上新索引
 * 之前调用（挪分支；不提交那一档不传）：它失败就把工作区按同一个环境退回 `from`，索引原样不动。
 * `attrs` 是测过的那棵树（属性的唯一出处）。
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
  try {
    sealed = await sealedCheckout(checkout, settings);
    // 新建的索引没有文件状态，先按封好的语义逐个核一遍字节补上（与目标提交对不上的照旧记成「改过」，
    // 下一步要改到它时 git 就拒），两树合并才认得出哪些文件是干净的。
    await sealed.run(attrs, ["read-tree", from]);
    await sealed.run(attrs, ["update-index", "-q", "--refresh"]).catch(() => "");
    try {
      await sealed.run(attrs, ["read-tree", "-m", "-u", from, to]);
    } catch (error) {
      return { ok: false, stage: "blocked", message: error instanceof Error ? error.message : String(error) };
    }
    const refused = await publish?.() ?? null;
    if (refused) {
      const restored = await sealed.run(attrs, ["read-tree", "-m", "-u", to, from]).then(() => true, () => false);
      return { ok: false, stage: "publish", message: refused, restored };
    }
    await copyFile(sealed.index, lock);
    await rename(lock, index);
    installed = true;
    return { ok: true };
  } finally {
    if (!installed) await rm(lock, { force: true });
    await sealed?.dispose();
  }
}
