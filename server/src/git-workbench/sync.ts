import type { GitAction } from "@ash/shared/git-workbench";
import { gitNetInjection } from "../git-credentials.js";
import { execFileText } from "../exec.js";
import { gitError } from "../git.js";
import { readScmRemotes, readScmStatus } from "../git-status.js";
import { pushWorkspace } from "../git-workspace-ops.js";
import { commitOid, exactRef, fail, git, requireClean } from "./core.js";

export async function network(
  root: string,
  projectId: string,
  args: string[],
): Promise<void> {
  const injection = await gitNetInjection(projectId);
  try {
    await execFileText("git", ["-C", root, ...injection.args, ...args], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
        ...injection.env,
      },
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    fail(gitError(error));
  }
}
async function checkRemote(root: string, remote: string): Promise<void> {
  if (!(await readScmRemotes(root)).includes(remote) || remote.startsWith("-"))
    fail("远端不存在，请先配置项目远端");
}
export async function runSyncAction(
  repo: string,
  root: string,
  projectId: string,
  action: GitAction,
  executeSequence: typeof git = git,
): Promise<boolean> {
  switch (action.kind) {
    case "fetch":
      if (action.remote) await checkRemote(root, action.remote);
      await network(root, projectId, [
        "fetch",
        "--prune",
        ...(action.remote ? ["--", action.remote] : ["--all"]),
      ]);
      return true;
    case "pull": {
      const status = await readScmStatus(root);
      requireClean(status);
      if (!status.branch.head || !status.branch.upstream)
        fail("当前分支还没有上游，请先在分支视图设置上游");
      const remote = (
        await git(root, [
          "config",
          "--get",
          `branch.${status.branch.head}.remote`,
        ])
      ).trim();
      await checkRemote(root, remote);
      await network(root, projectId, ["fetch", "--", remote]);
      const target = await commitOid(root, status.branch.upstream!);
      if (action.strategy === "rebase")
        await executeSequence(root, ["rebase", target]);
      else if (action.strategy === "merge")
        await executeSequence(root, ["merge", "--no-edit", target]);
      else if (action.strategy === "ff-only")
        await executeSequence(root, ["merge", "--ff-only", target]);
      else fail("未知的拉取策略", 400);
      return true;
    }
    case "push": {
      const status = await readScmStatus(root);
      if (status.operation || status.merge.length)
        fail("请先完成冲突处理再推送");
      if (action.lease === undefined)
        await pushWorkspace(
          root,
          repo,
          action.remote || null,
          undefined,
          projectId,
        );
      else {
        const branch = status.branch.head;
        if (
          !branch ||
          !status.branch.upstream ||
          !/^[a-f0-9]{40,64}$/.test(action.lease)
        )
          fail("保护强推需要已获取的上游提交");
        const remote = (
          await git(root, ["config", "--get", `branch.${branch}.remote`])
        ).trim();
        const remoteRef = (
          await git(root, ["config", "--get", `branch.${branch}.merge`])
        ).trim();
        await checkRemote(root, remote);
        if (!remoteRef.startsWith("refs/heads/")) fail("上游不是远端分支");
        if ((await commitOid(root, status.branch.upstream!)) !== action.lease)
          fail("远端跟踪引用已变化，请重新确认");
        await network(root, projectId, [
          "push",
          `--force-with-lease=${remoteRef}:${action.lease}`,
          "--",
          remote,
          `HEAD:${remoteRef}`,
        ]);
      }
      return true;
    }
    case "tag-push":
      await exactRef(root, action.name, action.sha, "tags");
      await checkRemote(root, action.remote);
      await network(root, projectId, [
        "push",
        "--",
        action.remote,
        `refs/tags/${action.name}:refs/tags/${action.name}`,
      ]);
      return true;
    default:
      return false;
  }
}
