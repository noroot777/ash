import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileText } from "../exec.js";
import { expandHome, gitError } from "../git.js";
import { getGitOverview } from "../git-overview.js";
import { readScmStatus, type ScmStatus } from "../git-status.js";
import { ScmOperationError } from "../scm-paths.js";
import type { GitAction } from "@ash/shared/git-workbench";

export function fail(message: string, status = 409): never {
  throw new ScmOperationError(message, status);
}
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export async function git(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  try {
    const advice = ["rebase", "cherry-pick", "revert"].includes(args[0])
      ? ["-c", "advice.mergeConflict=false"]
      : [];
    const result = await execFileText("git", ["-C", root, ...advice, ...args], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
        ...env,
      },
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const output = error as { stderr?: string; stdout?: string };
    return fail(
      [output.stdout?.trim(), output.stderr?.trim()]
        .filter(Boolean)
        .join("\n") || gitError(error),
    );
  }
}

export async function selectRoot(
  repoPath: string,
  requested?: string,
): Promise<{ repo: string; root: string }> {
  const registered = await realpath(expandHome(repoPath)).catch(() =>
    fail("项目目录不存在", 404),
  );
  const top = (await git(registered, ["rev-parse", "--show-toplevel"])).trim();
  const root = requested
    ? await realpath(requested).catch(() => fail("工作树已经不存在", 404))
    : await realpath(top);
  const { worktrees } = await getGitOverview(registered);
  const repo = await realpath(worktrees[0]?.path || registered);
  const allowed = await Promise.all(
    worktrees.map((item) => realpath(item.path).catch(() => item.path)),
  );
  if (!allowed.includes(root)) fail("目标不在这个项目的工作树列表中", 400);
  const common = async (path: string) =>
    realpath(
      resolve(
        path,
        (await git(path, ["rev-parse", "--git-common-dir"])).trim(),
      ),
    );
  if ((await common(repo)) !== (await common(root)))
    fail("工作树归属已经改变，请刷新", 409);
  return { repo, root };
}

export async function stateVersion(
  root: string,
  status: ScmStatus,
): Promise<string> {
  const index = await git(root, ["ls-files", "--stage", "-z"]);
  const paths = [
    ...new Set(
      [
        ...status.staged,
        ...status.unstaged,
        ...status.untracked,
        ...status.merge,
      ].map((f) => f.path),
    ),
  ];
  const stamps = await Promise.all(
    paths
      .map((path) => resolve(root, path))
      .map(async (path) => {
        const st = await lstat(path, { bigint: true }).catch(() => null);
        return st
          ? `${path}:${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.mode}`
          : `${path}:missing`;
      }),
  );
  return digest(JSON.stringify(status) + index + stamps.join("\0"));
}

export function requireClean(status: ScmStatus): void {
  if (status.operation || status.merge.length)
    fail("请先完成或中止正在进行的 Git 操作");
  if (
    status.staged.length ||
    status.unstaged.length ||
    status.untracked.length ||
    status.truncated
  ) {
    fail("工作区有未提交或未跟踪的文件，请先提交或贮藏后再操作");
  }
}
export async function commitOid(root: string, ref: string): Promise<string> {
  if (!ref || ref.startsWith("-") || /[\0\r\n]/.test(ref) || ref.length > 1024)
    fail("提交引用不合法", 400);
  return (
    await git(root, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ])
  ).trim();
}
export async function refName(
  root: string,
  name: string,
  kind: "heads" | "tags" = "heads",
): Promise<string> {
  if (
    !name ||
    name.startsWith("-") ||
    name === "HEAD" ||
    name.length > 240 ||
    /[\0\r\n]/.test(name)
  )
    fail("名称不合法", 400);
  await git(root, ["check-ref-format", `refs/${kind}/${name}`]);
  return name;
}
export async function exactRef(
  root: string,
  name: string,
  sha: string,
  kind: "heads" | "tags" = "heads",
): Promise<string> {
  await refName(root, name, kind);
  const current = (
    await git(root, ["rev-parse", "--verify", `refs/${kind}/${name}`])
  ).trim();
  if (current !== sha) fail("目标引用已经改变，请刷新后重新确认");
  return current;
}
export function confirmationFor(
  action: GitAction,
  status: ScmStatus,
): string | null {
  switch (action.kind) {
    case "discard-conflicts":
      return "放弃冲突改动";
    case "backup-delete":
      return action.ref;
    case "remote-remove":
      return action.name;
    case "remote-delete-ref":
      return `${action.remote}/${action.name}`;
    case "reset":
      return action.mode === "hard" ? status.branch.head || "HEAD" : null;
    case "branch-delete":
      return action.force ? action.name : null;
    case "tag-delete":
      return action.name;
    case "stash-drop":
      return action.sha.slice(0, 8);
    case "worktree-remove":
      return action.path;
    case "push":
      return action.lease !== undefined ? status.branch.head || "HEAD" : null;
    case "discard":
      return "丢弃";
    default:
      return null;
  }
}

export async function freshStatus(
  root: string,
  version: string,
): Promise<ScmStatus> {
  const status = await readScmStatus(root);
  if ((await stateVersion(root, status)) !== version)
    fail("工作区已经变化，这次操作未执行。请查看刷新后的内容再操作");
  return status;
}
