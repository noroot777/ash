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
// 目标目录可以改(调试、故障注入),但改到哪儿都要过所有权校验:同步会**强制检出 + git clean**,
// 指错地方就是把别人未提交的活抹掉。判据不是「它是不是个 worktree」而是「是不是我建的那个」,
// 见下面 PS 里的 $__magic 一段。已存在却没有标记的目录一律拒绝,除非显式 WIN_REMOTE_ADOPT=1 ——
// 那一句就是「我知道这个目录会被整个覆盖」的确认。
const WORKSPACE = process.env.WIN_REMOTE_WORKSPACE ?? ".worktrees/win-remote";
const ADOPT = /^(1|true|yes)$/i.test(process.env.WIN_REMOTE_ADOPT ?? "");

/**
 * 把 WIN_REMOTE_WORKSPACE 收成一个「一定落在 repo 里、一定不是 repo 根」的相对路径。
 *
 * 拼字符串之前必须先过这一关。上一版直接 `repoPath + '\' + WORKSPACE`,于是
 * `WIN_REMOTE_WORKSPACE=.` 和 `=''` 都解析成 repo 根本身 —— 那台机器上的 repo 根是**正在跑
 * harness、带着用户未提交内容**的 live 主仓。sync 走的那条路会在所有权校验上拒掉它
 * (git-dir = common-dir),但 exec 和 test --no-sync 不经过 sync,直接把它当 cwd 用,
 * 于是「绝不动主工作区」这句承诺在两个入口上是空的。实测 doctor 报「测试 worktree
 * D:\...\ash\. 已就绪」、exec 报 `CWD=D:\ai_workspace\ash`,都 exit 0。
 *
 * 判据只有一条:**它必须是 repo 下的一个真子目录**。绝对路径、UNC、`.`、`..`、空值一律拒 ——
 * 拒在这里,后面每个入口就都不用再各自想一遍。至于「这个子目录是不是我建的那个 worktree」,
 * 那是运行时才答得出来的问题,见 workspaceGuardPs。
 */
function workspaceRel() {
  const raw = String(WORKSPACE).trim();
  const bad = (why) =>
    new Error(`WIN_REMOTE_WORKSPACE=${JSON.stringify(raw)} 不能用:${why}。它必须是 repo 下的相对子目录,比如 .worktrees/win-remote`);
  if (!raw) throw bad("空值会解析成对端 repo 根,也就是那个正在跑 harness 的主工作区");
  if (/^[a-zA-Z]:/.test(raw) || /^[\\/]/.test(raw)) throw bad("是绝对路径或 UNC 路径,越出了 repo");
  const segs = raw.split(/[\\/]+/).filter(Boolean);
  if (!segs.length) throw bad("规范化之后什么都不剩");
  if (segs.some((s) => s === "." || s === "..")) throw bad("含 `.` 或 `..`,可能解析回 repo 根或 repo 之外");
  return segs.join("\\");
}

/**
 * 对端那个 worktree 的绝对路径。**要用这个目录的地方一律从这儿取**,别再各自拼一遍字符串:
 * 上一版 CLI 的 doctor/exec/test 三处都把 `.worktrees\win-remote` 写死了,于是设了
 * WIN_REMOTE_WORKSPACE 之后同步的是 A、跑测试的是 B —— 同步报着新 SHA,测试跑的是上一次
 * 留在默认目录里的旧快照,而两边都各自「成功」,假绿假红都看不出来。
 */
export const remoteWorkspacePath = (repoPath) => {
  const repo = String(repoPath ?? "").replace(/[\\/]+$/, "");
  if (!repo) throw new Error("拿不到对端仓库路径,没法定位工作区目录");
  return `${repo}\\${workspaceRel()}`;
};

/**
 * 「这个目录确实是 win-remote 自己那个 worktree」的运行时断言,失败就 throw(命令非 0 退出)。
 *
 * sync 里那套所有权校验(见下面 $__magic 一段)原来是**只有 sync 有**的,而 exec 和
 * `test --no-sync` 压根不经过 sync —— 保护逻辑存在,新的传播路径却没复用它。所以抽成这一段,
 * 让每个会在对端目录里干活的入口都先跑一遍。
 */
export const workspaceGuardPs = (repoPath) => {
  const wt = remoteWorkspacePath(repoPath).replace(/'/g, "''");
  const repo = String(repoPath).replace(/[\\/]+$/, "").replace(/'/g, "''");
  return [
    `$__wt='${wt}'; $__repo='${repo}'`,
    `if(-not (Test-Path -LiteralPath $__wt)){ throw ('工作区不存在:' + $__wt + ' —— 先跑一次 win-remote sync') }`,
    `$__wti=New-Object IO.DirectoryInfo $__wt; if($__wti.Attributes -band [IO.FileAttributes]::ReparsePoint){ throw ('拒绝使用:' + $__wt + ' 是个链接(reparse point),不是 win-remote 建的 worktree') }`,
    `$__gd=([string](git -C $__wt rev-parse --path-format=absolute --git-dir 2>$null)).Trim(); $__gc=([string](git -C $__wt rev-parse --path-format=absolute --git-common-dir 2>$null)).Trim(); $__rc=([string](git -C $__repo rev-parse --path-format=absolute --git-common-dir 2>$null)).Trim()`,
    `if(-not $__gd -or -not $__gc -or -not $__rc){ throw ('拒绝使用:' + $__wt + ' 不是 git worktree(读不到 git-dir)') }`,
    `if($__gd -eq $__gc){ throw ('拒绝使用:' + $__wt + ' 是主工作区(git-dir = common-dir),win-remote 绝不在主工作区里干活') }`,
    `if($__gc.TrimEnd('\\','/') -ne $__rc.TrimEnd('\\','/')){ throw ('拒绝使用:' + $__wt + ' 不属于 ' + $__repo + '(common-dir=' + $__gc + ')') }`,
    `if(-not (Test-Path -LiteralPath (Join-Path $__gd 'win-remote-owner'))){ throw ('拒绝使用:' + $__wt + ' 没有 win-remote 的所有权标记 —— 不知道是谁在上面干活。先跑一次 win-remote sync(必要时带 WIN_REMOTE_ADOPT=1)') }`,
  ].join("\n");
};

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
# 规范化之后再用:'.'、'..'、多余的分隔符都得先塌掉,不然后面拿它做的任何比较都能被绕过。
$wt   = [IO.Path]::GetFullPath((Join-Path $repo '${workspaceRel()}'))
# ============ 所有权校验:必须跑在 fetch / checkout / clean **之前** ============
# 这一段要回答的不是「这是不是个 linked worktree」,而是「这是不是**我建的**那个」。
# 前者谁都满足:随便哪个任务的 worktree 都 git-dir != common-dir,于是路径一配错
# (WIN_REMOTE_WORKSPACE 写歪、默认路径被别的 worktree 占了),先被 checkout --force
# 抹掉未提交改动,再被 git clean -xdff 删掉未跟踪文件,全程 exit 0 还报「同步成功」。
# 证据是一枚标记文件,放在 worktree 的**管理目录**(.git/worktrees/<name>/)里而不是工作区里 ——
# 工作区里的东西正是我们等会儿要 clean 掉的,拿它当凭证等于自证。
# 校验也必须在**动手之前**:上一版把检查放在 checkout 之后,就算最后拒绝了 clean,
# tracked 的未提交改动也已经被 --force 丢了。
$__magic = 'win-remote-workspace-v1'
$__adopt = $${ADOPT ? "true" : "false"}
$__fresh = $true
if (Test-Path -LiteralPath $wt) {
  $__wti = New-Object IO.DirectoryInfo $wt
  if ($__wti.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('拒绝使用:' + $wt + ' 是个链接(reparse point),不是 win-remote 建的 worktree') }
  $__gd = ([string](git -C $wt rev-parse --path-format=absolute --git-dir 2>$null)).Trim()
  $__gc = ([string](git -C $wt rev-parse --path-format=absolute --git-common-dir 2>$null)).Trim()
  $__rc = ([string](git -C $repo rev-parse --path-format=absolute --git-common-dir 2>$null)).Trim()
  if (-not $__gd -or -not $__gc -or -not $__rc) { throw ('拒绝使用:' + $wt + ' 已存在但不是 git worktree(读不到 git-dir),不动它') }
  if ($__gd -eq $__gc) { throw ('拒绝使用:' + $wt + ' 是主工作区(git-dir = common-dir = ' + $__gd + '),win-remote 绝不往主工作区上检出') }
  if ($__gc.TrimEnd('\','/') -ne $__rc.TrimEnd('\','/')) { throw ('拒绝使用:' + $wt + ' 不属于 ' + $repo + '(common-dir=' + $__gc + ')') }
  $__own = Join-Path $__gd 'win-remote-owner'
  if (Test-Path -LiteralPath $__own) { $__tag = ([string](Get-Content -LiteralPath $__own -TotalCount 1 -ErrorAction SilentlyContinue)).Trim() } else { $__tag = '' }
  if ($__tag -ne $__magic) {
    if (-not $__adopt) {
      throw ('拒绝接管:' + $wt + ' 是个已经存在的 worktree,但没有 win-remote 的所有权标记(' + $__own + ') —— 不知道是谁在上面干活,而同步会强制检出并 git clean 掉里面所有未提交内容。确认这个目录可以整个覆盖,就带 WIN_REMOTE_ADOPT=1 跑一次接管它;否则换个目录,或先 git worktree remove 它。')
    }
    Set-Content -LiteralPath $__own -Value $__magic -Encoding ascii
    Write-Output ('ADOPTED=' + $wt)
  }
  $__fresh = $false
}
# 整段包在 try/finally 里,只为一件事:**这个 ref 无论怎么失败都不许留在对端**。
# 它指着一个含未提交/未跟踪内容的快照 —— checkout 撞占用、junction 位置被真目录占了、
# 输出校验不过,任何一条早退路径把它留下,那份内容就无限期躺在别人机器的仓库里。
try {
git -C $repo fetch --force --no-tags '${daemon.url}' '${ref}:${ref}'
if ($LASTEXITCODE -ne 0) { throw 'fetch 失败:对端连不回开发机的 git daemon' }
# 检出**钉死在 SHA 上**而不是 ref 名:ref 只是运输容器,认 SHA 才谈得上「测的就是这份快照」。
if ($__fresh) {
  git -C $repo worktree add --detach --force $wt '${sha}'
  if ($LASTEXITCODE -ne 0) { throw 'checkout 失败' }
  # 自己建的,当场盖章 —— 下一次同步就是靠这枚章认出「这是我的目录」。
  $__gd = ([string](git -C $wt rev-parse --path-format=absolute --git-dir 2>$null)).Trim()
  if (-not $__gd) { throw '新建 worktree 之后反而读不到它的 git-dir' }
  Set-Content -LiteralPath (Join-Path $__gd 'win-remote-owner') -Value $__magic -Encoding ascii
} else {
  git -C $wt checkout --detach --force '${sha}'
  if ($LASTEXITCODE -ne 0) { throw 'checkout 失败' }
}
# 那个 worktree 是**跨所有调用复用的固定目录**,而 checkout --force 只管 Git 跟踪的文件:
# 上一次跑测试/构建留下的未跟踪与 ignored 产物(data\harness.db、dist\、*.tsbuildinfo)
# 原样活到下一次快照里。SHA 和 junction 全绿也照不出这类污染 —— 而 server 的生产入口直接跑
# server\dist\index.js,验的可能是上一版构建产物,「测的就是这份快照」对文件树并不成立。
# 两个前提缺一不可:
#  ① 手上这个目录确实是 win-remote 自己的(上面已经验过所有权;这里再回读一次盖过的章,
#     确保上面那条分支真的把章盖上了 —— 要 clean 谁,凭据就得在 clean 前一刻还在);
#  ② 先把目录型 reparse point 摘掉再 clean —— git clean 的递归删除会**穿过** junction 去删
#     目标目录里的东西(那头是主仓源码),而 [IO.Directory]::Delete($link,$false) 只删链接本体。
#     摘掉的正是下面那四个 @harness junction,紧接着就原地重建。
$__gd2 = ([string](git -C $wt rev-parse --path-format=absolute --git-dir 2>$null)).Trim()
if (-not $__gd2 -or -not (Test-Path -LiteralPath (Join-Path $__gd2 'win-remote-owner'))) {
  throw ('拒绝清理:' + $wt + ' 上没有 win-remote 的所有权标记,不在别人的工作区上跑 git clean')
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
      cleaned: Number(clean[1]), relinked: Number(clean[2]), adopted: /^ADOPTED=/m.test(res.out), out: res.out,
    };
  } finally {
    daemon?.stop();
    // 本地这个 ref 只为这次运输而存在:对端已经把快照 checkout 出来了(detached HEAD 撑着
    // 可达性),这边留着只会让 refs/win-remote/ 越积越多。
    try { git(["update-ref", "-d", ref], { cwd: root }); } catch { /* 已经没了 */ }
  }
}
