import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import type { GitAction } from "@ash/shared/git-workbench";
import { getGitOverview } from "../git-overview.js";
import { readScmStatus } from "../git-status.js";
import { checkoutProjectBranch } from "../git-project-ops.js";
import { ensureWorktreesIgnored, repoKey } from "../git.js";
import {
  commitOid,
  exactRef,
  fail,
  git,
  refName,
  requireClean,
} from "./core.js";
import { readStashes, ownerPrefix, readRefs } from "./read.js";

export async function runRefAction(
  repo: string,
  root: string,
  action: GitAction,
  actor: string,
  executeSequence: typeof git = git,
): Promise<boolean> {
  switch (action.kind) {
    case "checkout":
      requireClean(await readScmStatus(root));
      await checkoutProjectBranch(root, action.name);
      return true;
    case "branch-create": {
      await refName(root, action.name);
      const target = await commitOid(root, action.target);
      if (action.checkout) {
        requireClean(await readScmStatus(root));
        await git(root, ["switch", "-c", action.name, target]);
      } else await git(root, ["branch", "--", action.name, target]);
      return true;
    }
    case "branch-rename":
    case "branch-delete": {
      await exactRef(root, action.name, action.sha);
      const row = (await readRefs(root)).find(
        (r) => r.kind === "branch" && r.name === action.name,
      );
      if (
        row?.worktree &&
        (action.kind === "branch-delete" ||
          (await realpath(row.worktree)) !== (await realpath(root)))
      )
        fail("这条分支正被工作树检出，请先切换该工作树的分支");
      if (action.kind === "branch-rename") {
        await refName(root, action.next);
        await git(root, ["branch", "-m", "--", action.name, action.next]);
      } else
        await git(root, [
          "branch",
          action.force ? "-D" : "-d",
          "--",
          action.name,
        ]);
      return true;
    }
    case "upstream": {
      await refName(root, action.name);
      const refs = await readRefs(root);
      if (!refs.some((r) => r.kind === "branch" && r.name === action.name))
        fail("本地分支不存在");
      if (action.target) {
        if (!refs.some((r) => r.kind === "remote" && r.name === action.target))
          fail("远端分支不存在，请先 fetch");
        await git(root, [
          "branch",
          `--set-upstream-to=${action.target}`,
          "--",
          action.name,
        ]);
      } else await git(root, ["branch", "--unset-upstream", "--", action.name]);
      return true;
    }
    case "tag-create":
      await refName(root, action.name, "tags");
      await git(root, [
        "tag",
        ...(action.message ? ["-a", "-m", action.message] : []),
        "--",
        action.name,
        await commitOid(root, action.target),
      ]);
      return true;
    case "tag-delete":
      await exactRef(root, action.name, action.sha, "tags");
      await git(root, ["tag", "-d", "--", action.name]);
      return true;
    case "stash-save": {
      const status = await readScmStatus(root);
      if (
        !status.staged.length &&
        !status.unstaged.length &&
        !(action.untracked && status.untracked.length)
      )
        fail("没有可贮藏的改动");
      if (status.merge.length || status.operation)
        fail("请先解决当前冲突或中止操作，再贮藏");
      await git(root, [
        "stash",
        "push",
        ...(action.untracked ? ["--include-untracked"] : []),
        "-m",
        `${ownerPrefix(actor)} ${action.message || "工作台贮藏"}`,
      ]);
      return true;
    }
    case "stash-apply":
    case "stash-pop":
    case "stash-drop": {
      const entry = (await readStashes(root, actor)).find(
        (s) => s.sha === action.sha,
      );
      if (!entry) fail("这份贮藏已不存在，请刷新");
      if (action.kind !== "stash-apply" && !entry!.owned)
        fail("这份贮藏不属于当前用户，只能应用副本");
      if (action.kind !== "stash-drop") requireClean(await readScmStatus(root));
      const execute = action.kind === "stash-drop" ? git : executeSequence;
      await execute(root, ["stash", action.kind.slice(6), entry!.ref]);
      return true;
    }
    case "worktree-add": {
      await refName(root, action.name);
      const target = await commitOid(root, action.target);
      await ensureWorktreesIgnored(repo);
      const path = join(repo, ".worktrees", `git-${randomUUID()}`);
      await git(repo, [
        "worktree",
        "add",
        "-b",
        action.name,
        "--",
        path,
        target,
      ]);
      return true;
    }
    case "worktree-remove":
    case "worktree-lock":
    case "worktree-unlock": {
      const { worktrees } = await getGitOverview(repo);
      const row = worktrees.find(
        (w) => repoKey(w.path) === repoKey(action.path),
      );
      if (!row || (await realpath(row.path)) === (await realpath(repo)))
        fail("不能操作项目主工作树");
      if (action.kind === "worktree-remove") {
        if ((await realpath(row.path)) === (await realpath(root)))
          fail("不能删除正在浏览的工作树，请先切回项目主仓");
        if (row.head !== action.sha)
          fail("工作树 HEAD 已变化，请刷新后重新确认");
        requireClean(await readScmStatus(row.path));
        await git(repo, ["worktree", "remove", "--", row.path]);
      } else
        await git(repo, [
          "worktree",
          action.kind === "worktree-lock" ? "lock" : "unlock",
          "--",
          row.path,
        ]);
      return true;
    }
    default:
      return false;
  }
}
