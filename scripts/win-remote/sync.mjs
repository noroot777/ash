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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { rexec, detectLocalAddress } from "./transport.mjs";

// ref 和端口都**按次唯一**。共享一个 `refs/win-remote/head` + 固定 9418 时,两次调用交错就是:
// A 拍下快照 SHA-A 起 daemon,B 随后把同名 ref 改成 SHA-B(哪怕 B 自己因端口被占失败了,
// 改 ref 这步也已经做完),于是 A 的对端 fetch 拉到的是 SHA-B —— A 测的是 B 的代码,
// 报告却记在 A 的改动名下。这个工具的全部意义就是「验当前工作区快照」,拉错快照即根本失效。
const WIP_PREFIX = "refs/win-remote/snap-";
const WORKSPACE = process.env.WIN_REMOTE_WORKSPACE ?? ".worktrees/win-remote";

const git = (args, opts = {}) =>
  execFileSync("git", args, { encoding: "utf8", ...opts }).trim();

/** 把当前工作区(含未提交/未跟踪)固化成一个游离提交,挂到一个本次专用的 ref 上。 */
export function snapshotWorkspace(ref = `${WIP_PREFIX}${randomBytes(6).toString("hex")}`) {
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
    git(["update-ref", ref, sha], { cwd: root });
    return { sha, ref, root };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 让内核挑一个空闲端口,再把它让给 git daemon(daemon 自己不报回实际端口)。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "0.0.0.0", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** 起一个只读 git daemon,返回 { url, stop }。 */
export async function serveRepo(port = 0) {
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const repoRoot = gitDir.replace(/[/\\]\.git$/, "");
  const basePath = repoRoot.slice(0, repoRoot.lastIndexOf("/"));
  const name = repoRoot.slice(repoRoot.lastIndexOf("/") + 1);
  const fixed = port || Number(process.env.WIN_REMOTE_GIT_PORT ?? 0);

  // 让内核挑端口 → 从 listen 到 daemon 真正绑上有一小段窗口,期间可能被别人抢走,
  // 所以要允许重试;显式指定端口(调试/开防火墙口子)时不重试,占了就该直说。
  let lastErr = null;
  for (let i = 0; i < (fixed ? 1 : 5); i++) {
    const chosen = fixed || (await freePort());
    const child = spawn("git", [
      "daemon", `--port=${chosen}`, `--base-path=${basePath}`,
      "--export-all", "--informative-errors", "--reuseaddr", repoRoot,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const up = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(true), 700);
      child.on("exit", (code) => {
        clearTimeout(timer);
        lastErr = new Error(`git daemon 起不来(exit ${code}):${stderr.trim() || `端口 ${chosen} 可能被占`}`);
        resolve(false);
      });
    });
    if (up) {
      return {
        port: chosen,
        url: `git://${detectLocalAddress()}:${chosen}/${name}`,
        stop: () => { try { child.kill(); } catch { /* 已退出 */ } },
      };
    }
  }
  throw lastErr ?? new Error("git daemon 起不来");
}

/** 对端拉取 + 检出到独立 worktree,并补齐 @harness 软链。返回对端的 HEAD sha。 */
export async function syncToRemote({ repoPath, onLine = null, projectId = null, guard = "" } = {}) {
  const { sha, ref, root } = snapshotWorkspace();
  let daemon = null;
  try {
    daemon = await serveRepo();
    const ps = String.raw`${guard ? `${guard}\n` : ""}
$repo = '${repoPath}'
$wt   = Join-Path $repo '${WORKSPACE.replace(/\//g, "\\")}'
git -C $repo fetch --force --no-tags '${daemon.url}' '${ref}:${ref}'
if ($LASTEXITCODE -ne 0) { throw 'fetch 失败:对端连不回开发机的 git daemon' }
# 检出**钉死在 SHA 上**而不是 ref 名:ref 只是运输容器,认 SHA 才谈得上「测的就是这份快照」。
if (Test-Path (Join-Path $wt '.git')) {
  git -C $wt checkout --detach --force '${sha}'
} else {
  git -C $repo worktree add --detach --force $wt '${sha}'
}
if ($LASTEXITCODE -ne 0) { throw 'checkout 失败' }
git -C $repo update-ref -d '${ref}' 2>$null
# 不补这几个软链,@harness/shared 会向上解析到主仓那份 —— 改了 shared 却测旧代码。
$scope = Join-Path $wt 'node_modules\@harness'
New-Item -ItemType Directory -Force -Path $scope | Out-Null
foreach ($p in @('shared','server','web-next','mcp')) {
  $link = Join-Path $scope $p
  if (-not (Test-Path $link)) { cmd /c mklink /J "$link" (Join-Path $wt $p) | Out-Null }
}
Write-Output ('WORKTREE=' + $wt)
Write-Output ('HEAD=' + (git -C $wt rev-parse HEAD))
`;
    const res = await rexec(ps, { cwd: repoPath, onLine, projectId, timeout: 5 * 60_000 });
    if (res.code !== 0) throw new Error(`同步失败(exit ${res.code}):\n${res.out}`);
    const worktree = /WORKTREE=(.+)/.exec(res.out)?.[1]?.trim() ?? null;
    const remoteSha = /HEAD=([0-9a-f]{40})/.exec(res.out)?.[1] ?? null;
    // 比的是**完整** SHA,而且不一致就地拒绝往下跑。以前这里只打印两个短 sha 就继续测,
    // 于是「对端根本不是这份代码」这件事只体现为一行没人看的输出。
    if (remoteSha !== sha) {
      throw new Error(
        `对端检出的不是本次快照 —— 本地 ${sha},对端 ${remoteSha ?? "读不到"}。\n` +
          `  已中止:继续测下去,结果会被记在一份并不存在于对端的改动上。\n${res.out}`,
      );
    }
    return { localSha: sha.slice(0, 7), remoteSha: remoteSha.slice(0, 7), sha, worktree, out: res.out };
  } finally {
    daemon?.stop();
    // 本地这个 ref 只为这次运输而存在:对端已经把快照 checkout 出来了(detached HEAD 撑着
    // 可达性),这边留着只会让 refs/win-remote/ 越积越多。
    try { git(["update-ref", "-d", ref], { cwd: root }); } catch { /* 已经没了 */ }
  }
}
