#!/usr/bin/env node
// 在开发机上改 Windows 相关代码,在那台真 Windows 上验 —— 一条命令走完。
//
//   node scripts/win-remote.mjs doctor              # 两端体检:通道、Node/git 版本、前提条件
//   node scripts/win-remote.mjs sync                # 把当前工作区(含未提交)送过去
//   node scripts/win-remote.mjs exec "<powershell>" # 在对端 worktree 里跑一条命令
//   node scripts/win-remote.mjs test win-launch …   # sync + 跑 server 的回归测试(可多条)
//   node scripts/win-remote.mjs test --all          # 跑三条 Windows 专属回归
//
// 环境变量:
//   WIN_REMOTE_HOST=http://192.168.1.187:4317   对端 harness 地址(默认就是它)
//   WIN_REMOTE_SELF=<ip>                        本机对外 IP(自动探测不准时用)
//   WIN_REMOTE_PROJECT=<projectId>              对端项目 id(默认按 repoPath 猜)
//   WIN_REMOTE_GIT_PORT=<port>                  钉死 git daemon 端口(默认每次现挑空闲端口)
//   WIN_REMOTE_WORKSPACE=<相对路径>              对端 worktree 位置(默认 .worktrees/win-remote)
//
// 为什么是这套通道、为什么不动对端主工作区,见 scripts/win-remote/{transport,sync}.mjs 顶部;
// 对端那个 worktree 是全局单份的,所以整段 sync+test 上锁,见 scripts/win-remote/lock.mjs 顶部。
//
// 一个必须知道的边界:**通道本身就跑在被测的 harness 里**。改了 server 代码想看真实行为
// 而不是测试结果,就得重启对端的 harness —— 那会连着把这条通道一起掐了(重启完自己会回来)。
// 所以默认路线是「跑回归测试」,它是独立进程,不需要重启对端服务。
import { rexec, resolveProject, controlSignal } from "./win-remote/transport.mjs";
import { syncToRemote, remoteWorkspacePath, workspaceGuardPs } from "./win-remote/sync.mjs";
import { withRemoteLock } from "./win-remote/lock.mjs";

// Windows 上「伪造 platform 也验不了」的那几条,才值得占用真机(docs/windows-testing.md)。
const WINDOWS_SUITES = ["win-launch", "path-boundary", "openers-windows"];

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

const live = (line) => process.stdout.write(dim(`  │ ${line}\n`));
const note = (line) => console.log(dim(`  · ${line}`));

async function target() {
  // 期限在**第一次远端请求之前**就建好。这一跳原来是裸的:rexec 内部的 deadline 覆盖不到
  // 它(那是进 rexec 之后才起算的),对端只接连接不回包时,四个子命令都停在这儿不动。
  const p = await resolveProject(undefined, controlSignal());
  if (!p.repoPath) throw new Error("拿不到对端仓库路径,请用 WIN_REMOTE_PROJECT 指定正确的项目");
  return p;
}

/** 凡是要动对端那个共享 worktree 的命令,整段都在锁里跑(见 win-remote/lock.mjs 顶部)。 */
const inWorkspace = (p, fn) => withRemoteLock({ repoPath: p.repoPath, projectId: p.id, onNote: note }, fn);

async function cmdDoctor() {
  console.log(bold("对端 harness"));
  const p = await target();
  console.log(`  项目 ${p.id}  仓库 ${p.repoPath}`);

  const probe = [
    `Write-Output ('node=' + (node -v))`,
    `Write-Output ('git=' + ((git --version) -replace 'git version ',''))`,
    `Write-Output ('pwsh=' + $PSVersionTable.PSVersion.ToString())`,
    // 开发者模式**别读注册表**:实测那台机器上开关已经打开,
    // HKLM:\…\AppModelUnlock\AllowDevelopmentWithoutDevLicense 却仍读不到值,于是报了假警。
    // 真正要回答的问题是「symlink 建不建得出来」—— 那就直接建一个。
    `$__st = Join-Path $env:TEMP ('symprobe-' + [guid]::NewGuid())`,
    `New-Item -ItemType Directory -Path $__st -Force | Out-Null`,
    `try { New-Item -ItemType SymbolicLink -Path (Join-Path $__st 'l') -Target $__st -ErrorAction Stop | Out-Null; Write-Output 'symlink=ok' } catch { Write-Output 'symlink=no' }`,
    `Remove-Item $__st -Recurse -Force -ErrorAction SilentlyContinue`,
    `Write-Output ('temp=' + $env:TEMP)`,
    // 体检报的不是「那个路径下有东西」,而是「那个目录能用」—— 两者差着一整条安全边界:
    // 上一版只做 Test-Path,于是 WIN_REMOTE_WORKSPACE=. 时它对着 live 主仓报「已就绪」。
    // 跑真正的所有权断言,拿它的报错原文当结论。
    `try { ${workspaceGuardPs(p.repoPath).split("\n").join("; ")}; Write-Output 'worktree=ok' } catch { Write-Output ('worktree=' + $_.Exception.Message) }`,
  ].join("\n");
  const res = await rexec(probe, { cwd: p.repoPath, projectId: p.id, timeout: 60_000 });
  // 退出码先看。体检这条命令**自己失败了**的时候(回传拿不到、pwsh 炸了、对端 harness 半死),
  // out 里根本没有那几个 kv,下面每一行都会打成 `?`/`✗` —— 上一版照打不误,然后无条件宣布
  // 「通道 ✓ 输出回传正常」并 exit 0。于是一次「通道断了」的体检读起来像「机器缺 node、
  // 开发者模式没开」,查的方向从一开始就是错的。
  if (res.code !== 0) {
    throw new Error(
      `体检命令没跑通(exit ${res.code}) —— 下面的结论一条都不成立,先修通道:\n` +
        res.out.split("\n").slice(-20).map((l) => `  ${l}`).join("\n"),
    );
  }
  const kv = Object.fromEntries(res.out.split("\n").filter((l) => l.includes("=")).map((l) => {
    const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
  const nodeOk = /v(\d+)\.(\d+)/.exec(kv.node ?? "");
  const nodeVersionOk = nodeOk && (Number(nodeOk[1]) > 22 || (Number(nodeOk[1]) === 22 && Number(nodeOk[2]) >= 16));
  console.log(`  node ${kv.node ?? "?"} ${nodeVersionOk ? green("✓") : red("✗ 需 >= 22.16.0(node:sqlite)")}`);
  console.log(`  git ${kv.git ?? "?"}   pwsh ${kv.pwsh ?? "?"}`);
  console.log(`  symlink ${kv.symlink === "ok" ? green("✓ 建得出来(夹具可用)") : red("✗ 建不出来 —— 开发者模式没开,symlink 夹具会红")}`);
  const wt = kv.worktree ?? "";
  const wtOk = wt === "ok";
  const wtFresh = /工作区不存在/.test(wt);
  console.log(
    `  测试 worktree ${remoteWorkspacePath(p.repoPath)} ` +
      (wtOk ? green("已就绪") : wtFresh ? dim("尚未创建(首次 sync 时建)") : red(`✗ ${wt || "校验没跑通"}`)),
  );
  // 目录不可用 ≠ 通道不可用,但也绝不能只算个提示:exec / test --no-sync 都会在那个目录里
  // 干活,它没过所有权校验就是「这台机器上没有一个可用的落脚点」。通道那行照打 —— 它是真的通,
  // 少了它反而看不出问题出在哪一层。
  console.log(bold("\n通道") + `  ${green("✓")} 终端 API 可用,输出回传正常`);
  return wtOk || wtFresh ? 0 : 1;
}

async function cmdSync() {
  const p = await target();
  console.log(bold("同步工作区快照 →"), p.repoPath);
  const r = await inWorkspace(p, ({ guard }) =>
    syncToRemote({ repoPath: p.repoPath, projectId: p.id, onLine: live, guard }));
  console.log(`  本地 ${r.localSha} → 对端 ${green(r.remoteSha)}`);
  console.log(`  工作区 ${r.worktree}`);
  console.log(`  清理 ${r.cleaned} 项快照外内容,重建 ${r.relinked} 个软链`);
  if (r.adopted) console.log(red(`  ⚠︎ WIN_REMOTE_ADOPT=1:接管了一个不是本工具建的 worktree,里面原有的未提交内容已被覆盖`));
  return 0;
}

async function cmdExec(args) {
  const p = await target();
  const cmd = args.join(" ");
  if (!cmd) throw new Error("exec 需要一条命令");
  const cwd = remoteWorkspacePath(p.repoPath);
  // 用户的命令跑在那个目录里,所以在它之前先断言那个目录确实是 win-remote 自己的 worktree ——
  // exec 不经过 sync,原来一路上没有任何一处校验过归属(见 sync.mjs workspaceGuardPs)。
  const res = await inWorkspace(p, ({ guard }) =>
    rexec(`${guard}\n${workspaceGuardPs(p.repoPath)}\n${cmd}`, { cwd, projectId: p.id, onLine: live }));
  console.log(res.out);
  console.log(res.code === 0 ? green(`[exit 0]`) : red(`[exit ${res.code}]`));
  return res.code;
}

async function cmdTest(args) {
  const suites = args.includes("--all") ? WINDOWS_SUITES : args.filter((a) => !a.startsWith("--"));
  if (!suites.length) throw new Error(`test 需要测试名,或 --all(= ${WINDOWS_SUITES.join(", ")})`);
  const p = await target();

  // 锁罩的是**同步 + 跑完所有测试**这一整段,而不只是同步那几秒:中途被别人 checkout 掉,
  // 后面几条测的就已经不是这份快照了。
  return await inWorkspace(p, async ({ guard }) => {
    // 测试跑在哪儿,只有一个来源:同步真正检出的那个目录(没同步时才退回按环境变量算出来的
    // 路径)。上一版这里写死默认目录,同步到别处之后就变成「同步 A、测 B」。
    let cwd = remoteWorkspacePath(p.repoPath);
    if (!args.includes("--no-sync")) {
      console.log(bold("① 同步"));
      const r = await syncToRemote({ repoPath: p.repoPath, projectId: p.id, onLine: live, guard });
      cwd = r.worktree;
      console.log(`  ${r.localSha} → ${green(r.remoteSha)}(清理 ${r.cleaned} 项快照外内容)\n`);
    } else {
      // --no-sync 跳过的是同步,不是**校验** —— 这条路原来完全绕开了所有权那一段,
      // 于是 `WIN_REMOTE_WORKSPACE=.` 会把整批 npm 测试跑进对端的 live 主仓。
      const chk = await rexec(`${guard}\n${workspaceGuardPs(p.repoPath)}\nWrite-Output 'WS=ok'`, {
        cwd: p.repoPath, projectId: p.id, timeout: 60_000,
      });
      if (chk.code !== 0) throw new Error(`--no-sync 的目标目录不能用:\n${chk.out.split("\n").slice(-10).map((l) => `  ${l}`).join("\n")}`);
    }

    console.log(bold("② 在真 Windows 上跑回归"), dim(cwd));
    const results = [];
    for (const s of suites) {
      process.stdout.write(`  ${s} … `);
      // 好几条回归要求调用者自己给 HARNESS_DB(`tmp-db.ts` 的 requireTmpDb 会拦下来,
      // 免得测试写进用户的真库),没给就直接拒跑。那不是 Windows 的毛病 —— mac 上不设
      // 照样红,只是从这里跑的人看到的是「Windows 上失败了」,白查一轮。统一在这儿给一个
      // 临时库,跑完删掉;`$__code` 先接住退出码,免得 Remove-Item 把它冲掉。
      const db = `harness-wintest-${s}-${Date.now()}.db`;
      const cmd = [
        guard,
        `$env:HARNESS_DB = Join-Path $env:TEMP '${db}'`,
        `npm -w server run test:${s} 2>&1`,
        `$__code = $LASTEXITCODE`,
        `Remove-Item $env:HARNESS_DB -Force -ErrorAction SilentlyContinue`,
        `exit $__code`,
      ].join("\n");
      const res = await rexec(cmd, { cwd, projectId: p.id, timeout: 10 * 60_000 });
      const ok = res.code === 0;
      console.log(ok ? green("通过") : red(`失败 (exit ${res.code})`));
      if (!ok) console.log(res.out.split("\n").slice(-40).map((l) => `    ${l}`).join("\n"));
      results.push({ s, ok, out: res.out });
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${bold("结果")} ${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) console.log(dim("  红了先对 docs/windows-testing.md —— 有几条是「本来就跑不了」而不是 bug"));
    return failed.length ? 1 : 0;
  });
}

const [cmd, ...rest] = process.argv.slice(2);
const table = { doctor: cmdDoctor, sync: cmdSync, exec: () => cmdExec(rest), test: () => cmdTest(rest) };
if (!table[cmd]) {
  console.log("用法: node scripts/win-remote.mjs <doctor|sync|exec|test> [args]");
  process.exit(cmd ? 1 : 0);
}
try {
  process.exit(await table[cmd]());
} catch (e) {
  console.error(red(`✗ ${e.message}`));
  process.exit(1);
}
