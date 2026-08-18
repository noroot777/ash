// 把开发机上**当前工作区的样子**(含还没提交的改动)送到那台 Windows 上的一个独立 worktree。
//
// 三个设计决定,都是被现场情况逼出来的:
//
// 1. **不走 GitHub 中转,起临时 git daemon 让对端来拉。** 迭代期每改一行就往公共 remote 推
//    一版 WIP 既脏又慢;局域网直连零污染。daemon 只在 sync 这几秒内活着,只读(upload-pack)。
//
// 2. **同步的是「工作区快照」而不是 HEAD。** 调 Windows 功能时改一行就想看结果,要求先
//    commit 太别扭。这里用一个临时 index 做 `add -A` + `write-tree` + `commit-tree`,
//    造出一个不进任何分支的游离提交 —— 未提交的改动和新增文件(受 .gitignore 约束)都在里面,
//    而你的分支、index、stash 全程没被碰过。
//
// 3. **落到对端的 `.worktrees/win-remote`,绝不动它的主工作区。** 那台机器上的
//    `D:\ai_workspace\ash` 是**正在跑着的 harness 自己**,而且有用户没提交的本地改动
//    (`server/src/executors/claude.ts` 等)。往那儿 checkout 等于既覆盖别人的活,又把
//    live 服务的源码换掉。放在主仓内部的 `.worktrees/` 下还白捡一个好处:Node 解析
//    node_modules 会逐级向上,worktree 里不装依赖也能直接用主仓那份。
//    唯一要补的是 `node_modules/@harness/*` —— 不补的话 `@harness/shared` 会解析到
//    **主仓的** shared,于是你改了 shared 却测的是旧代码(docs 里记过这个坑)。
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rexec, detectLocalAddress } from "./transport.mjs";

const WIP_REF = "refs/win-remote/head";
const WORKSPACE = process.env.WIN_REMOTE_WORKSPACE ?? ".worktrees/win-remote";

const git = (args, opts = {}) =>
  execFileSync("git", args, { encoding: "utf8", ...opts }).trim();

/** 把当前工作区(含未提交/未跟踪)固化成一个游离提交,并挂到 WIP_REF 上。返回 sha。 */
export function snapshotWorkspace() {
  const root = git(["rev-parse", "--show-toplevel"]);
  const tmp = mkdtempSync(join(tmpdir(), "win-remote-idx-"));
  const indexFile = join(tmp, "index");
  try {
    // 用临时 index,真实 index 不受影响 —— 同步不该有副作用。
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    git(["read-tree", "HEAD"], { cwd: root, env });
    git(["add", "-A"], { cwd: root, env });
    const tree = git(["write-tree"], { cwd: root, env });
    const head = git(["rev-parse", "HEAD"], { cwd: root });
    const sha = git(["commit-tree", tree, "-p", head, "-m", "win-remote: workspace snapshot"], { cwd: root, env });
    git(["update-ref", WIP_REF, sha], { cwd: root });
    return sha;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 起一个只读 git daemon,返回 { url, stop }。 */
export async function serveRepo(port = 0) {
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const repoRoot = gitDir.replace(/[/\\]\.git$/, "");
  const basePath = repoRoot.slice(0, repoRoot.lastIndexOf("/"));
  const name = repoRoot.slice(repoRoot.lastIndexOf("/") + 1);
  // 端口 0 交给内核挑不了(git daemon 不报回实际端口),固定一个高位端口,被占就往上找。
  const chosen = port || Number(process.env.WIN_REMOTE_GIT_PORT ?? 9418);

  const child = spawn("git", [
    "daemon", `--port=${chosen}`, `--base-path=${basePath}`,
    "--export-all", "--informative-errors", "--reuseaddr", repoRoot,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 700);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`git daemon 起不来(exit ${code}):${stderr.trim() || "端口可能被占"}`));
    });
  });

  return {
    url: `git://${detectLocalAddress()}:${chosen}/${name}`,
    stop: () => { try { child.kill(); } catch { /* 已退出 */ } },
  };
}

/** 对端拉取 + 检出到独立 worktree,并补齐 @harness 软链。返回对端的 HEAD 短 sha。 */
export async function syncToRemote({ repoPath, onLine = null, projectId = null } = {}) {
  const sha = snapshotWorkspace();
  const daemon = await serveRepo();
  try {
    const ps = String.raw`
$repo = '${repoPath}'
$wt   = Join-Path $repo '${WORKSPACE.replace(/\//g, "\\")}'
git -C $repo fetch --force --no-tags '${daemon.url}' '${WIP_REF}:${WIP_REF}'
if ($LASTEXITCODE -ne 0) { throw 'fetch 失败:对端连不回开发机的 git daemon' }
if (Test-Path (Join-Path $wt '.git')) {
  git -C $wt checkout --detach --force '${WIP_REF}'
} else {
  git -C $repo worktree add --detach --force $wt '${WIP_REF}'
}
if ($LASTEXITCODE -ne 0) { throw 'checkout 失败' }
# 不补这几个软链,@harness/shared 会向上解析到主仓那份 —— 改了 shared 却测旧代码。
$scope = Join-Path $wt 'node_modules\@harness'
New-Item -ItemType Directory -Force -Path $scope | Out-Null
foreach ($p in @('shared','server','web-next','mcp')) {
  $link = Join-Path $scope $p
  if (-not (Test-Path $link)) { cmd /c mklink /J "$link" (Join-Path $wt $p) | Out-Null }
}
Write-Output ('WORKTREE=' + $wt)
Write-Output ('HEAD=' + (git -C $wt rev-parse --short HEAD))
`;
    const res = await rexec(ps, { cwd: repoPath, onLine, projectId, timeout: 5 * 60_000 });
    if (res.code !== 0) throw new Error(`同步失败(exit ${res.code}):\n${res.out}`);
    const worktree = /WORKTREE=(.+)/.exec(res.out)?.[1]?.trim() ?? null;
    return { localSha: sha.slice(0, 7), remoteSha: /HEAD=(\w+)/.exec(res.out)?.[1] ?? "?", worktree, out: res.out };
  } finally {
    daemon.stop();
  }
}
