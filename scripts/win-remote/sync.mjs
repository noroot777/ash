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
// 这四个包在 workspace 里互相 import,靠 `node_modules/@harness/<pkg>` 找到对方。
const HARNESS_LINKS = ["shared", "server", "web-next", "mcp"];

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
# 整段包在 try/finally 里,只为一件事:**这个 ref 无论怎么失败都不许留在对端**。
# 它指着一个含未提交/未跟踪内容的快照 —— checkout 撞占用、junction 位置被真目录占了、
# 输出校验不过,任何一条早退路径把它留下,那份内容就无限期躺在别人机器的仓库里。
try {
git -C $repo fetch --force --no-tags '${daemon.url}' '${ref}:${ref}'
if ($LASTEXITCODE -ne 0) { throw 'fetch 失败:对端连不回开发机的 git daemon' }
# 检出**钉死在 SHA 上**而不是 ref 名:ref 只是运输容器,认 SHA 才谈得上「测的就是这份快照」。
if (Test-Path (Join-Path $wt '.git')) {
  git -C $wt checkout --detach --force '${sha}'
} else {
  git -C $repo worktree add --detach --force $wt '${sha}'
}
if ($LASTEXITCODE -ne 0) { throw 'checkout 失败' }
# 那个 worktree 是**跨所有调用复用的固定目录**,而 checkout --force 只管 Git 跟踪的文件:
# 上一次跑测试/构建留下的未跟踪与 ignored 产物(data\harness.db、dist\、*.tsbuildinfo)
# 原样活到下一次快照里。SHA 和 junction 全绿也照不出这类污染 —— 而 server 的生产入口直接跑
# server\dist\index.js,验的可能是上一版构建产物,「测的就是这份快照」对文件树并不成立。
# 两个前提缺一不可:
#  ① 先确认这真是个**链接式** worktree(自己的 git-dir 不等于 common-dir),不敢在谁的
#     主工作区上跑 git clean;
#  ② 先把目录型 reparse point 摘掉再 clean —— git clean 的递归删除会**穿过** junction 去删
#     目标目录里的东西(那头是主仓源码),而 [IO.Directory]::Delete($link,$false) 只删链接本体。
#     摘掉的正是下面那四个 @harness junction,紧接着就原地重建。
$gd = ([string](git -C $wt rev-parse --git-dir)).Trim()
$gc = ([string](git -C $wt rev-parse --git-common-dir)).Trim()
if ($LASTEXITCODE -ne 0 -or -not $gd -or $gd -eq $gc) {
  throw ('拒绝清理:' + $wt + ' 看着不是链接式 worktree(git-dir=' + $gd + ' common-dir=' + $gc + '),不在它上面跑 git clean')
}
$__links = 0
$__stack = New-Object System.Collections.Stack
$__stack.Push($wt)
while ($__stack.Count -gt 0) {
  $__d = $__stack.Pop()
  foreach ($__sub in [IO.Directory]::GetDirectories($__d)) {
    $__di = New-Object IO.DirectoryInfo $__sub
    # 命中 reparse point 就地摘掉,**并且不往里走** —— 枚举本身也会穿过 junction,
    # 走进去就是在遍历主仓。
    if ($__di.Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($__sub, $false); $__links++ }
    else { $__stack.Push($__sub) }
  }
}
$__cleaned = @(git -C $wt clean -xdff)
if ($LASTEXITCODE -ne 0) { throw ('git clean 失败:' + ($__cleaned -join '; ')) }
Write-Output ('CLEAN=' + $__cleaned.Count + '|' + $__links)
# 不补这几个软链,@harness/shared 会向上解析到主仓那份 —— 改了 shared 却测旧代码。
# 「缺了就建」不够:junction **在**、却指着主仓,是同一个坑的另一半,而且更隐蔽 —— 检出、
# SHA 校验全绿,测的却仍是主仓旧代码。所以每次同步都把四个目标读出来核对,并把它们回传给
# 开发机当成功判据的一部分(见下面的 LINK= 解析)。
$scope = Join-Path $wt 'node_modules\@harness'
New-Item -ItemType Directory -Force -Path $scope | Out-Null
foreach ($p in @(${HARNESS_LINKS.map((p) => `'${p}'`).join(",")})) {
  $link = Join-Path $scope $p
  $want = ([string](Join-Path $wt $p)).TrimEnd('\')
  $it = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
  # 真目录/真文件占了位置就停手报错:那可能是别人装的依赖或手工放的东西,自动删属于越权。
  if ($it -and $it.LinkType -ne 'Junction') { throw ('node_modules\@harness\' + $p + ' 已存在且不是 junction(' + $it.LinkType + '),不敢自动删,请人工处理') }
  if ($it) {
    $cur = ([string]($it.Target | Select-Object -First 1)) -replace '^\\\\\?\\',''
    if ($cur.TrimEnd('\') -ne $want) {
      # 只删链接本体。Remove-Item -Recurse 会**穿过** junction 去删目标目录里的东西 ——
      # 这里的目标要么是 worktree 要么是主仓,两个都删不起。
      [IO.Directory]::Delete($link, $false)
      $it = $null
    }
  }
  if (-not $it) { cmd /c mklink /J "$link" "$want" | Out-Null }
  $now = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
  if ($now -and $now.LinkType -eq 'Junction') { $tgt = ([string]($now.Target | Select-Object -First 1)) -replace '^\\\\\?\\','' } else { $tgt = '(不是 junction)' }
  Write-Output ('LINK=' + $p + '|' + $tgt.TrimEnd('\'))
}
Write-Output ('WORKTREE=' + $wt)
Write-Output ('HEAD=' + (git -C $wt rev-parse HEAD))
# 干不干净不靠「我调过 clean 了」自证 —— 回读一遍工作区状态。除了我们自己建的 node_modules
# (那四个 junction 的家,本来就 ignored)之外还剩东西,就说明这次的文件树不是这份快照,
# 和 SHA / junction 一样当场算失败。
$__st = @(git -C $wt status --porcelain=v1 --ignored | Where-Object { $_ -and ($_ -notmatch '^!!\s+node_modules[/\\]') })
Write-Output ('RESIDUE=' + $__st.Count + '|' + (($__st | Select-Object -First 12) -join ' ;; '))
} finally {
  git -C $repo update-ref -d '${ref}' 2>$null
}
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
    // SHA 对上只说明 worktree 自己是对的,不说明 Node 会从这儿解析 `@harness/*`。
    // junction 指着主仓时:fetch、checkout、SHA 校验全绿,`import '@harness/shared'` 拿到的
    // 却是主仓旧代码 —— 一个「全部通过」的假绿。所以四个目标同样是成功判据。
    if (!worktree) throw new Error(`同步没回传 worktree 路径,输出不完整:\n${res.out}`);
    const links = new Map(
      [...res.out.matchAll(/LINK=([^|\r\n]+)\|([^\r\n]*)/g)].map((m) => [m[1].trim(), m[2].trim()]),
    );
    const norm = (s) => s.replace(/\\+$/, "").toLowerCase(); // NTFS 不分大小写,比较也别分
    const bad = HARNESS_LINKS.map((p) => ({ p, want: `${worktree}\\${p}`, got: links.get(p) ?? "(没回传)" }))
      .filter(({ want, got }) => norm(got) !== norm(want));
    if (bad.length) {
      throw new Error(
        `对端 node_modules/@harness 没指向本次 worktree:\n` +
          bad.map(({ p, want, got }) => `  ${p}: ${got}\n    应为 ${want}`).join("\n") +
          `\n  已中止:这么跑下去 @harness/* 解析到的是别处的代码,测了也不算数。\n${res.out}`,
      );
    }
    // 清理和 junction 一样是成功判据:固定 worktree 复用了几十次,残留一份旧 dist\ 就够让
    // 「测的是当前快照」变成假话,而 SHA 全绿照不出来。
    const clean = /CLEAN=(\d+)\|(\d+)/.exec(res.out);
    if (!clean) throw new Error(`同步没回传清理结果(工作区可能没被清理干净):\n${res.out}`);
    const residue = /RESIDUE=(\d+)\|([^\r\n]*)/.exec(res.out);
    if (!residue) throw new Error(`同步没回传残留检查结果,输出不完整:\n${res.out}`);
    if (Number(residue[1]) > 0) {
      throw new Error(
        `对端 worktree 清理后仍有 ${residue[1]} 项不属于本次快照:\n  ${residue[2].split(" ;; ").join("\n  ")}\n` +
          `  已中止:这些是上次跑测试/构建留下的东西,测下去可能验的是旧产物。\n${res.out}`,
      );
    }
    return {
      localSha: sha.slice(0, 7), remoteSha: remoteSha.slice(0, 7), sha, worktree, links,
      cleaned: Number(clean[1]), relinked: Number(clean[2]), out: res.out,
    };
  } finally {
    daemon?.stop();
    // 本地这个 ref 只为这次运输而存在:对端已经把快照 checkout 出来了(detached HEAD 撑着
    // 可达性),这边留着只会让 refs/win-remote/ 越积越多。
    try { git(["update-ref", "-d", ref], { cwd: root }); } catch { /* 已经没了 */ }
  }
}
