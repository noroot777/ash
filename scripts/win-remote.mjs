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
//
// 为什么是这套通道、为什么不动对端主工作区,见 scripts/win-remote/{transport,sync}.mjs 顶部。
//
// 一个必须知道的边界:**通道本身就跑在被测的 harness 里**。改了 server 代码想看真实行为
// 而不是测试结果,就得重启对端的 harness —— 那会连着把这条通道一起掐了(重启完自己会回来)。
// 所以默认路线是「跑回归测试」,它是独立进程,不需要重启对端服务。
import { rexec, resolveProject } from "./win-remote/transport.mjs";
import { syncToRemote } from "./win-remote/sync.mjs";

// Windows 上「伪造 platform 也验不了」的那几条,才值得占用真机(docs/windows-testing.md)。
const WINDOWS_SUITES = ["win-launch", "path-boundary", "openers-windows"];

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

const live = (line) => process.stdout.write(dim(`  │ ${line}\n`));

async function target() {
  const p = await resolveProject();
  if (!p.repoPath) throw new Error("拿不到对端仓库路径,请用 WIN_REMOTE_PROJECT 指定正确的项目");
  return p;
}

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
    `Write-Output ('worktree=' + (Test-Path '${p.repoPath}\\.worktrees\\win-remote'))`,
  ].join("\n");
  const res = await rexec(probe, { cwd: p.repoPath, projectId: p.id, timeout: 60_000 });
  const kv = Object.fromEntries(res.out.split("\n").filter((l) => l.includes("=")).map((l) => {
    const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
  const nodeOk = /v(\d+)\.(\d+)/.exec(kv.node ?? "");
  const nodeVersionOk = nodeOk && (Number(nodeOk[1]) > 22 || (Number(nodeOk[1]) === 22 && Number(nodeOk[2]) >= 16));
  console.log(`  node ${kv.node ?? "?"} ${nodeVersionOk ? green("✓") : red("✗ 需 >= 22.16.0(node:sqlite)")}`);
  console.log(`  git ${kv.git ?? "?"}   pwsh ${kv.pwsh ?? "?"}`);
  console.log(`  symlink ${kv.symlink === "ok" ? green("✓ 建得出来(夹具可用)") : red("✗ 建不出来 —— 开发者模式没开,symlink 夹具会红")}`);
  console.log(`  测试 worktree ${kv.worktree === "True" ? green("已就绪") : dim("尚未创建(首次 sync 时建)")}`);
  console.log(bold("\n通道") + `  ${green("✓")} 终端 API 可用,输出回传正常`);
  return 0;
}

async function cmdSync() {
  const p = await target();
  console.log(bold("同步工作区快照 →"), p.repoPath);
  const r = await syncToRemote({ repoPath: p.repoPath, projectId: p.id, onLine: live });
  console.log(`  本地 ${r.localSha} → 对端 ${green(r.remoteSha)}`);
  console.log(`  工作区 ${r.worktree}`);
  return 0;
}

async function cmdExec(args) {
  const p = await target();
  const cmd = args.join(" ");
  if (!cmd) throw new Error("exec 需要一条命令");
  const cwd = `${p.repoPath}\\.worktrees\\win-remote`;
  const res = await rexec(cmd, { cwd, projectId: p.id, onLine: live });
  console.log(res.out);
  console.log(res.code === 0 ? green(`[exit 0]`) : red(`[exit ${res.code}]`));
  return res.code;
}

async function cmdTest(args) {
  const suites = args.includes("--all") ? WINDOWS_SUITES : args.filter((a) => !a.startsWith("--"));
  if (!suites.length) throw new Error(`test 需要测试名,或 --all(= ${WINDOWS_SUITES.join(", ")})`);
  const p = await target();

  if (!args.includes("--no-sync")) {
    console.log(bold("① 同步"));
    const r = await syncToRemote({ repoPath: p.repoPath, projectId: p.id, onLine: live });
    console.log(`  ${r.localSha} → ${green(r.remoteSha)}\n`);
  }

  console.log(bold("② 在真 Windows 上跑回归"));
  const cwd = `${p.repoPath}\\.worktrees\\win-remote`;
  const results = [];
  for (const s of suites) {
    process.stdout.write(`  ${s} … `);
    const res = await rexec(`npm -w server run test:${s} 2>&1`, { cwd, projectId: p.id, timeout: 10 * 60_000 });
    const ok = res.code === 0;
    console.log(ok ? green("通过") : red(`失败 (exit ${res.code})`));
    if (!ok) console.log(res.out.split("\n").slice(-40).map((l) => `    ${l}`).join("\n"));
    results.push({ s, ok, out: res.out });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${bold("结果")} ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) console.log(dim("  红了先对 docs/windows-testing.md —— 有几条是「本来就跑不了」而不是 bug"));
  return failed.length ? 1 : 0;
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
