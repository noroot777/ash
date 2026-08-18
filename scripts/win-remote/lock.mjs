// 对端那个固定 worktree(`.worktrees/win-remote`)是**全局单份**的:两个人同时 sync+test,
// 后来者的 checkout 会把前者正在测的代码整个换掉,而前者照样把结果记在自己那次改动头上 ——
// 假绿假红都可能,而且事后完全看不出来。所以互斥要罩住整条「同步 + 跑测试」,不只是同步那几秒。
//
// 锁只能是对端文件系统上的一个文件:每条远端命令都是一个独立的 pwsh 进程,没法跨命令攥着句柄。
// 于是靠三件事凑出一把够用的锁:
//
// 1. **用 `CreateNew` 打开来创建** —— 已存在就抛,这一步是原子的;`Test-Path` 再写不是。
// 2. **锁里写上本次调用的随机 owner id,locked 区间内每条命令都先核对**。被别人接管了就当场
//    炸掉,而不是继续往一个已经不属于自己的工作区里写、最后交出一份不知道测的是谁的报告。
// 3. **心跳写在锁的内容里**(`beat=<UTC ISO>`),locked 区间内一直刷;超过 TTL 没心跳算过期、
//    可被接管。过期机制不能省:持锁的进程在开发机上,它崩了、被 Ctrl-C 了,对端一无所知,
//    没有过期就等于把那台机器永久锁死,唯一的解锁办法是人肉删文件。单条远端命令自身有超时
//    上限(测试 10 分钟),TTL 取得比它大一倍多,保证不会跑着跑着被抢走。
//
// 心跳刷的是**内容**而不只是 mtime,这一点是接管正确性的地基,理由见下面 tryAcquire 的注释。
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { rexec } from "./transport.mjs";

const LOCK_REL = ".worktrees\\win-remote.lock";
const STALE_MS = 25 * 60_000;
const HEARTBEAT_MS = 30_000; // 命令跑着的时候由 ThreadJob 一直刷,远小于 STALE_MS
const GUARD_TRIES = 5; // 守卫刷心跳时撞上别人的独占句柄就重试,别让一瞬间的争用把命令打死
const WAIT_MS = 5_000;
const WAIT_TRIES = 24; // 最多等 2 分钟,再久就该去看看那边到底谁在跑

const lockPath = (repoPath) => `${repoPath.replace(/[\\/]+$/, "")}\\${LOCK_REL}`;
const q = (s) => `'${s.replace(/'/g, "''")}'`;

// 刷心跳 = 拿独占句柄、确认锁还是自己的、把内容里的 beat 换成当下时间,再写回去。
// 全程在 FileShare::None 的句柄里做:同一时刻只有一个人开得了这个文件,所以竞争者的
// 「读-判-写」和这里的「读-判-写」不可能交错,也不会让竞争者读到写了一半的内容。
// 返回 ok / lost(锁已易主**或已经不在了**)/ busy(此刻被别人独占,重试即可)。
// 打不开要分两种:文件还在 = 有人正拿着句柄,重试即可;文件没了 = 锁已经不属于我们了,
// 这是 lost 不是 busy —— 混为一谈会把「锁被人删了」报成「一直被独占」,查起来南辕北辙。
const PS_BEAT_FN = `function Set-WinRemoteBeat {
  param($p, $o)
  $fs = $null
  try { $fs = [IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
  catch { if (Test-Path -LiteralPath $p) { return 'busy' } else { return 'lost' } }
  try {
    $buf = New-Object byte[] $fs.Length
    $null = $fs.Read($buf,0,$buf.Length)
    $c = [Text.Encoding]::UTF8.GetString($buf)
    if ($c -notlike "owner=$o*") { return 'lost' }
    $n = [Text.RegularExpressions.Regex]::Replace($c, 'beat=\\S+', ('beat=' + (Get-Date).ToUniversalTime().ToString('o')))
    $nb = [Text.Encoding]::UTF8.GetBytes($n)
    $fs.SetLength(0); $fs.Position = 0; $fs.Write($nb,0,$nb.Length)
    return 'ok'
  } finally { $fs.Close() }
}`;

// 锁有多久没心跳了。beat 写在内容里;老格式(没有 beat 字段)退回看 mtime,免得升级前
// 留下的锁永远过不了期。
const PS_AGE_FN = `function Get-WinRemoteAgeMs {
  param($c, $it)
  if ($c -match 'beat=(\\S+)') {
    try { return ((Get-Date).ToUniversalTime() - [datetime]::Parse($Matches[1],[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()).TotalMilliseconds } catch { }
  }
  if ($it) { return ((Get-Date) - $it.LastWriteTime).TotalMilliseconds }
  return 0
}`;

/**
 * 每条远端命令的前置守卫:确认锁还在自己手里,并在**整条命令期间**持续刷心跳。
 * 不在自己手里就 throw —— 那条命令连带整次调用一起失败,这是想要的。
 *
 * 心跳必须跟着命令跑完,而不是开头点一下:守卫只在命令开头查一次 owner,一条 10 分钟的测试
 * 进了临界区之后就再没人回头看了。心跳停在开头意味着「跑够 TTL 那么久的命令」会被别人正当
 * 接管,而它自己还在往同一个 worktree 里写 —— 恰好是这把锁要防的那件事。
 * 用 ThreadJob 而不是 Start-Job:同进程另开一个线程,脚本一退它跟着没,不会留下孤儿进程。
 */
export function lockGuardPs(repoPath, owner) {
  const lock = lockPath(repoPath);
  return [
    PS_BEAT_FN,
    `$__r = 'busy'`,
    `for ($__i = 0; $__i -lt ${GUARD_TRIES} -and $__r -eq 'busy'; $__i++) {`,
    `  if ($__i -gt 0) { Start-Sleep -Milliseconds 400 }`,
    `  $__r = Set-WinRemoteBeat ${q(lock)} '${owner}'`,
    `}`,
    `if ($__r -eq 'lost') { throw ('[win-remote] 对端工作区的锁已易主或已被删除(现在是: ' + [string](Get-Content ${q(lock)} -Raw -ErrorAction SilentlyContinue) + '),本次结果不可信,已中止') }`,
    `if ($__r -ne 'ok') { throw '[win-remote] 对端工作区的锁一直被别人独占着,刷不上心跳,本次结果不可信,已中止' }`,
    `if (Get-Command Start-ThreadJob -ErrorAction SilentlyContinue) {`,
    `  $null = Start-ThreadJob -ArgumentList ${q(lock)},'${owner}' -ScriptBlock {`,
    `    param($p,$o)`,
    PS_BEAT_FN.split("\n").map((l) => `    ${l}`).join("\n"),
    `    while ($true) {`,
    `      Start-Sleep -Seconds ${Math.floor(HEARTBEAT_MS / 1000)}`,
    `      if (-not (Test-Path -LiteralPath $p)) { break }`,
    // 只有「确实读到了、而且已经不是我的」才收手 —— 别人短暂独占(busy)只是重试的理由,
    // 要是就此收手,一个竞争者瞄一眼就能把活锁的心跳停掉,反手再把它当过期锁接管。
    `      if ((Set-WinRemoteBeat $p $o) -eq 'lost') { break }`,
    `    }`,
    `  }`,
    `}`,
  ].join("\n");
}

async function tryAcquire(repoPath, owner, opts) {
  const lock = lockPath(repoPath);
  const me = `owner=${owner} from=${hostname()} at=${new Date().toISOString()}`;
  const ps = [
    PS_AGE_FN,
    `$__l = ${q(lock)}`,
    `New-Item -ItemType Directory -Force -Path (Split-Path -Parent $__l) | Out-Null`,
    // beat 由对端的钟写,判过期也用对端的钟 —— 两台机器的时钟不用对齐。
    `function New-WinRemoteMe { ${q(me)} + ' beat=' + (Get-Date).ToUniversalTime().ToString('o') }`,
    // 建锁这一步是原子的:CreateNew 已存在就抛,内核保证只有一个人建得出来。
    `function New-WinRemoteLock { try { $f = [IO.File]::Open($__l,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); $b = [Text.Encoding]::UTF8.GetBytes((New-WinRemoteMe)); $f.Write($b,0,$b.Length); $f.Close(); $true } catch { $false } }`,
    `if (New-WinRemoteLock) { Write-Output 'LOCK=acquired' }`,
    `else {`,
    `  $__was = [string](Get-Content $__l -Raw -ErrorAction SilentlyContinue)`,
    `  $__it = Get-Item $__l -Force -ErrorAction SilentlyContinue`,
    `  $__state = 'busy'`,
    `  if ((Get-WinRemoteAgeMs $__was $__it) -gt ${STALE_MS}) {`,
    // 接管过期锁是唯一能凭空造出两个持有者的路径,所以这段的正确性要求是完整的一句话:
    // **「owner 没变,而且此刻仍然过期」**,两个条件缺一不可,还得原子地成立。
    //
    // 踩过的三个版本:
    // - 「覆盖 owner 再读回来认一次」不是 CAS —— 两个竞争者各自读到自己刚写的内容,双双自认
    //   接管成功,一起进临界区。
    // - 换成原子改名也不够 —— A 接管后重建了锁,晚两秒动手的 B 照样能把**新锁**移走。
    // - 只校验 owner 的 CAS 仍然不够 —— 心跳当时只刷 mtime、不动内容,于是「原持有者在我判过
    //   期之后恢复了心跳」这件事在内容上看不出来,B 会夺走一把刚刚变新鲜的**活锁**。
    //
    // 所以现在心跳刷的是内容里的 beat 字段:内容一旦被心跳动过,下面这个逐字节比较就不成立。
    // 再加上在句柄里重新算一次 age(顺带覆盖没有 beat 的老格式锁),两个条件同时满足才写入。
    `    $__fs = $null`,
    `    try { $__fs = [IO.File]::Open($__l,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) } catch { }`,
    `    if ($__fs) {`,
    `      try {`,
    `        $__buf = New-Object byte[] $__fs.Length`,
    `        $null = $__fs.Read($__buf,0,$__buf.Length)`,
    `        $__cur = [Text.Encoding]::UTF8.GetString($__buf)`,
    `        $__age = Get-WinRemoteAgeMs $__cur (Get-Item -LiteralPath $__l -Force -ErrorAction SilentlyContinue)`,
    `        if (($__cur -ceq $__was) -and ($__age -gt ${STALE_MS})) {`,
    `          $__nb = [Text.Encoding]::UTF8.GetBytes((New-WinRemoteMe))`,
    `          $__fs.SetLength(0); $__fs.Position = 0; $__fs.Write($__nb,0,$__nb.Length)`,
    `          $__state = 'stolen'`,
    `        }`,
    `      } finally { $__fs.Close() }`,
    `    }`,
    `  }`,
    `  Write-Output ('LOCK=' + $__state)`,
    `  Write-Output ('HELD=' + $__was)`,
    `}`,
  ].join("\n");
  const res = await rexec(ps, { cwd: repoPath, projectId: opts.projectId, timeout: 60_000 });
  if (res.code !== 0) throw new Error(`拿对端工作区锁失败(exit ${res.code}):\n${res.out}`);
  return {
    state: /LOCK=(\w+)/.exec(res.out)?.[1] ?? "busy",
    held: /HELD=(.*)/.exec(res.out)?.[1]?.trim() ?? "",
  };
}

/**
 * 拿下对端工作区的独占权,跑 fn,无论成败都还回去。
 * fn 收到 `guard`:一段 PowerShell 前言,**每条**在 locked 区间里发出去的命令都要拼在最前面。
 */
export async function withRemoteLock({ repoPath, projectId, onNote = null }, fn) {
  const owner = randomBytes(6).toString("hex");
  let acquired = false;
  for (let i = 0; i < WAIT_TRIES; i++) {
    const r = await tryAcquire(repoPath, owner, { projectId });
    if (r.state === "acquired" || r.state === "stolen") {
      if (r.state === "stolen") onNote?.(`接管了一把过期的锁(原持有者 ${r.held || "未知"},已超过 ${STALE_MS / 60_000} 分钟没动静)`);
      acquired = true;
      break;
    }
    onNote?.(`对端工作区正被占用(${r.held || "未知持有者"}),等待中… ${i + 1}/${WAIT_TRIES}`);
    await new Promise((r2) => setTimeout(r2, WAIT_MS));
  }
  if (!acquired) {
    throw new Error(
      `对端工作区 ${lockPath(repoPath)} 一直被占着,等了 ${(WAIT_TRIES * WAIT_MS) / 1000}s 仍拿不到。\n` +
        `  确认没人在跑之后,删掉那个文件即可解锁。`,
    );
  }
  try {
    return await fn({ owner, guard: lockGuardPs(repoPath, owner) });
  } finally {
    // 只删自己的那把:万一已经被人正当接管(我们卡了太久),别顺手把别人的锁掀了。
    const ps = [
      `$__l = ${q(lockPath(repoPath))}`,
      `$__c = [string](Get-Content $__l -Raw -ErrorAction SilentlyContinue)`,
      `if ($__c -like 'owner=${owner}*') { Remove-Item $__l -Force -ErrorAction SilentlyContinue }`,
    ].join("\n");
    await rexec(ps, { cwd: repoPath, projectId, timeout: 60_000 }).catch(() => {});
  }
}
