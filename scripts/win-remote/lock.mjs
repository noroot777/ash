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
// 3. **靠 mtime 判过期**(核对 owner 时顺手刷新)。持锁的进程在开发机上,它崩了、被 Ctrl-C 了,
//    对端一无所知 —— 没有过期机制就等于把那台机器永久锁死,而唯一的解锁办法是人肉删文件。
//    单条远端命令自身有超时上限(测试 10 分钟),TTL 取得比它大一倍多,保证不会跑着跑着被抢走。
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { rexec } from "./transport.mjs";

const LOCK_REL = ".worktrees\\win-remote.lock";
const STALE_MS = 25 * 60_000;
const WAIT_MS = 5_000;
const WAIT_TRIES = 24; // 最多等 2 分钟,再久就该去看看那边到底谁在跑

const lockPath = (repoPath) => `${repoPath.replace(/[\\/]+$/, "")}\\${LOCK_REL}`;
const q = (s) => `'${s.replace(/'/g, "''")}'`;

/**
 * 每条远端命令的前置守卫:确认锁还在自己手里,并刷新 mtime(心跳)。
 * 不在自己手里就 throw —— 那条命令连带整次调用一起失败,这是想要的。
 */
export function lockGuardPs(repoPath, owner) {
  const lock = lockPath(repoPath);
  return [
    `$__c = [string](Get-Content ${q(lock)} -Raw -ErrorAction SilentlyContinue)`,
    `if ($__c -notlike 'owner=${owner}*') { throw '[win-remote] 对端工作区的锁已易主(现在是: ' + $__c + '),本次结果不可信,已中止' }`,
    `(Get-Item ${q(lock)}).LastWriteTime = Get-Date`,
  ].join("\n");
}

async function tryAcquire(repoPath, owner, opts) {
  const lock = lockPath(repoPath);
  const me = `owner=${owner} from=${hostname()} at=${new Date().toISOString()}`;
  const ps = [
    `$__l = ${q(lock)}`,
    `New-Item -ItemType Directory -Force -Path (Split-Path -Parent $__l) | Out-Null`,
    `$__me = ${q(me)}`,
    `try {`,
    `  $__f = [IO.File]::Open($__l,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)`,
    `  $__b = [Text.Encoding]::UTF8.GetBytes($__me); $__f.Write($__b,0,$__b.Length); $__f.Close()`,
    `  Write-Output 'LOCK=acquired'`,
    `} catch {`,
    `  $__was = [string](Get-Content $__l -Raw -ErrorAction SilentlyContinue)`,
    `  $__it = Get-Item $__l -ErrorAction SilentlyContinue`,
    `  if ($__it -and ((Get-Date) - $__it.LastWriteTime).TotalMilliseconds -gt ${STALE_MS}) {`,
    `    [IO.File]::WriteAllText($__l,$__me,(New-Object Text.UTF8Encoding $false))`,
    // 抢的动作本身不原子(两个抢锁的可能同时判定过期),所以写完再读回来认一次 ——
    // 认输的那个退回去继续等,总有一个是真拿到了。
    `    $__now = [string](Get-Content $__l -Raw -ErrorAction SilentlyContinue)`,
    `    if ($__now -eq $__me) { Write-Output 'LOCK=stolen' } else { Write-Output 'LOCK=busy' }`,
    `  } else { Write-Output 'LOCK=busy' }`,
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
