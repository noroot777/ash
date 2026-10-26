import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAcceptGate, stopAcceptGate, type GateExit } from "../src/accept-gate-process.js";
import { IS_WINDOWS, userShellLaunch } from "../src/platform.js";
import { classifyGateLaunch, gateCommandMissNotice, missFailure } from "../src/accept-gate-miss.js";

const root = mkdtempSync(join(tmpdir(), "ash-gate-process-"));
let runNumber = 0;
const launches: { logPath: string; pid?: number; startedAt?: string | null }[] = [];

async function run(command: string): Promise<{ exit: GateExit; log: string }> {
  const logPath = join(root, `gate-${runNumber++}.log`);
  const launch: typeof launches[number] = { logPath };
  launches.push(launch);
  const exit = await new Promise<GateExit>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`门禁命令超时: ${command}`)), 20_000);
    void spawnAcceptGate({
      command, cwd: root, logPath,
      onExit: (result) => { clearTimeout(timer); resolve(result); },
    }).then((result) => { Object.assign(launch, result); }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { exit, log: readFileSync(logPath, "utf8") };
}

try {
  const plain = await run('node -e "console.log(123); process.exit(7)"');
  assert.equal(plain.exit.code, 7);
  assert.match(plain.log, /123/);
  if (!IS_WINDOWS) {
    assert.deepEqual(userShellLaunch("./kb.ps1 test full"), { file: "sh", args: ["-lc", "./kb.ps1 test full"] });
  } else {
    writeFileSync(join(root, "kb.ps1"), [
      'param([string]$Action, [string]$Scope)',
      '[Console]::WriteLine("GATE_ARGS=$Action|$Scope")',
      '[IO.File]::WriteAllText((Join-Path $PWD "proof.json"), (@{ cwd = [string]$PWD; action = $Action; scope = $Scope } | ConvertTo-Json))',
      'exit 0',
    ].join("\r\n"), "utf8");
    const passed = await run('.\\kb.ps1 test full');
    assert.equal(passed.exit.code, 0, passed.log);
    assert.match(passed.log, /GATE_ARGS=test\|full/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "proof.json"), "utf8")), {
      cwd: root, action: "test", scope: "full",
    });
    const unicode = await run('.\\KB.PS1 test "全量 回归"');
    assert.equal(unicode.exit.code, 0, unicode.log);
    assert.match(unicode.log, /GATE_ARGS=test\|全量 回归/);
    assert.equal(JSON.parse(readFileSync(join(root, "proof.json"), "utf8")).scope, "全量 回归");

    const scripts = join(root, "scripts with spaces");
    mkdirSync(scripts);
    writeFileSync(join(scripts, "kb.ps1"), '[Console]::WriteLine("QUOTED=" + $args[0]); exit 23', "utf8");
    for (const command of [
      '".\\scripts with spaces\\kb.ps1" "full suite"',
      "& '.\\scripts with spaces\\kb.ps1' 'full suite'",
    ]) {
      const failed = await run(command);
      assert.equal(failed.exit.code, 23, failed.log);
      assert.match(failed.log, /QUOTED=full suite/);
    }

    writeFileSync(join(root, "native.ps1"), 'node -e "process.exit(17)"', "utf8");
    assert.equal((await run('.\\native.ps1')).exit.code, 17);
    writeFileSync(join(root, "success.ps1"), 'Write-Output "GATE_SUCCESS"', "utf8");
    const success = await run('.\\success.ps1');
    assert.equal(success.exit.code, 0, success.log);
    assert.match(success.log, /GATE_SUCCESS/);
    for (const testCase of [
      { name: "recovered", script: 'node -e "process.exit(7)"\nWrite-Output "RECOVERED"', code: 0 },
      { name: "native-failure", script: 'node -e "process.exit(19)"', code: 19 },
      { name: "cmdlet-failure", script: 'Write-Error "CMDLET_FAILURE"', code: 1 },
      { name: "throw", script: 'throw "THROWN_FAILURE"', code: 1 },
      { name: "explicit-success", script: 'node -e "process.exit(7)"\nexit 0', code: 0 },
      { name: "explicit-failure", script: 'Write-Output "BEFORE_EXIT"\nexit 23', code: 23 },
      { name: "nested-failure", script: '& .\\native.ps1', code: 17 },
      { name: "nested-recovery", script: '& .\\native.ps1\nWrite-Output "RECOVERED"', code: 0 },
      { name: "nested-explicit-exit", script: '& .\\explicit-failure.ps1', code: 23 },
      { name: "command-object-failure", script: '$child = Get-Command .\\native.ps1\n& $child', code: 17 },
      { name: "command-object-cached-failure", script: '$child = Get-Command .\\native.ps1\n& $child\n& $child', code: 17 },
      { name: "command-object-expression", script: '& (Get-Command .\\native.ps1)', code: 17 },
      { name: "command-object-recovery", script: '$child = Get-Command .\\native.ps1\n& $child\nWrite-Output "OBJECT_RECOVERED"', code: 0 },
      { name: "command-object-recovered-child", script: '& (Get-Command .\\recovered.ps1)', code: 0 },
      { name: "command-object-explicit-success", script: '& (Get-Command .\\explicit-success.ps1)', code: 0 },
      { name: "command-object-explicit-failure", script: '& (Get-Command .\\explicit-failure.ps1)', code: 23 },
      { name: "command-object-dot-source", script: '$child = Get-Command .\\native.ps1\n. $child', code: 17 },
      { name: "command-object-alias", script: 'Set-Alias -Name Invoke-ChildScript -Value .\\native.ps1\n& (Get-Command Invoke-ChildScript)', code: 17 },
      { name: "command-object-throw", script: '& (Get-Command .\\throw.ps1)', code: 1 },
      { name: "blocks-end-before-begin", script: 'end { Write-Output "END_OK" }\nbegin { Write-Output "BEGIN_OK" }', code: 0 },
      { name: "blocks-failure-end-before-begin", script: 'end { & .\\native.ps1 }\nbegin { Write-Output "BEGIN_OK" }', code: 17 },
    ]) {
      writeFileSync(join(root, `${testCase.name}.ps1`), testCase.script, "utf8");
      const result = await run(`.\\${testCase.name}.ps1`);
      assert.equal(result.exit.code, testCase.code, `${testCase.name}: ${result.log}`);
      if (testCase.name === "recovered") assert.match(result.log, /RECOVERED/);
    }
    assert.equal((await run('.\\success.ps1; .\\native.ps1')).exit.code, 17);
    assert.equal((await run('.\\native.ps1; .\\success.ps1')).exit.code, 0);
    assert.equal((await run('.\\success.ps1; .\\explicit-failure.ps1')).exit.code, 23);
    writeFileSync(join(root, "error.ps1"), 'Write-Error "GATE_FAILURE"', "utf8");
    const errored = await run('.\\error.ps1');
    assert.notEqual(errored.exit.code, 0, errored.log);
    assert.match(errored.log, /GATE_FAILURE/);
    assert.notEqual((await run('.\\missing.ps1 test full')).exit.code, 0);
    assert.equal((await run('node -e "process.exit(0)" && node -e "process.exit(9)"')).exit.code, 9);
  }
  console.log(`✅ 验收命令进程（${IS_WINDOWS ? "Windows ps1/参数/工作目录/退出码/异常/cmd 兼容" : "POSIX shell/日志/退出码"}）通过`);

  // ── 失败归类：「命令在被测快照里不存在」≠「测试红了」────────────────────────────
  //
  // 本机四次（2026-10-24/25，日志见 data/runs/*/accept-gate-*.log）门禁给出的全部信息
  // 就是 npm 的原始报错 + rc=1，于是人和 agent 都读不出出路。这一组钉住的是：
  //  · 那四条日志**那个形状**真能被认出来（第一条用例就是原文照抄）；
  //  · 判定不写死在 npm 上 —— 一行一个 runner，shell/make/yarn/PowerShell 一并认；
  //  · 一份真跑起来、真红了的测试日志**不许**被归成这一类（否则 agent 会被告知
  //    「不是你的代码」而放着真 bug 不修）。
  const MISS_CASES: { name: string; command: string; exitCode: number | null; log: string;
    kind: "command" | "program" | null; missing?: string | null }[] = [
    {
      // data/runs/4n0946g2eW1e/accept-gate-MzYxZdGAyzhv.log 原文（四条一模一样）。
      name: "npm Missing script（本机四次那一条）",
      command: "npm run test:accept", exitCode: 1,
      log: [
        "[ash] 2026-10-24T11:27:37.845Z 验收前置命令开跑",
        "[ash] source: /Users/fjh/code/harness/.worktrees/4n0946g2eW1e",
        "[ash] snapshot: /Users/fjh/code/harness/data/runs/4n0946g2eW1e/accept-gate-MzYxZdGAyzhv.source",
        "[ash] fingerprint: 2d287c27c0a75c0a76220f3050eeec3a0522d4f8116eb3f51e4574551472eedb",
        "[ash] $ npm run test:accept",
        "",
        "[ash] macOS 兼容监督：实际执行验收命令，按进程组、已观察后代和继承标记收尾。",
        'npm error Missing script: "test:accept"',
        "npm error",
        "npm error To see a list of scripts, run:",
        "npm error   npm run",
      ].join("\n"),
      kind: "command", missing: "test:accept",
    },
    { name: "npm 6/8 老措辞", command: "npm run test:accept", exitCode: 1,
      log: "npm ERR! missing script: test:accept", kind: "command", missing: "test:accept" },
    { name: "yarn 1", command: "yarn accept", exitCode: 1,
      log: 'error Command "accept" not found.', kind: "command", missing: "accept" },
    { name: "yarn berry", command: "yarn run accept", exitCode: 1,
      log: 'Usage Error: Couldn\'t find a script named "accept".', kind: "command", missing: "accept" },
    { name: "pnpm", command: "pnpm accept", exitCode: 1,
      log: " ERR_PNPM_NO_SCRIPT  Missing script: accept", kind: "command", missing: "accept" },
    { name: "make", command: "make accept", exitCode: 2,
      log: "make: *** No rule to make target 'accept'.  Stop.", kind: "command", missing: "accept" },
    { name: "just", command: "just accept", exitCode: 1,
      log: "error: Justfile does not contain recipe `accept`.", kind: "command", missing: "accept" },
    { name: "cargo", command: "cargo accept", exitCode: 101,
      log: "error: no such command: `accept`", kind: "command", missing: "accept" },
    { name: "go", command: "go accept ./...", exitCode: 2,
      log: 'go accept: unknown command "accept"', kind: "command", missing: "accept" },
    { name: "task", command: "task accept", exitCode: 1,
      log: 'task: Task "accept" does not exist', kind: "command", missing: "accept" },
    { name: "gradle", command: "./gradlew accept", exitCode: 1,
      log: "FAILURE: Task 'accept' not found in root project 'app'.", kind: "command", missing: "accept" },
    { name: "zsh 命令不存在", command: "kbtest full", exitCode: 127,
      log: "zsh: command not found: kbtest", kind: "command", missing: "kbtest" },
    { name: "bash 命令不存在", command: "kbtest full", exitCode: 127,
      log: "bash: line 1: kbtest: command not found", kind: "command", missing: "kbtest" },
    { name: "dash 命令不存在", command: "kbtest full", exitCode: 127,
      log: "sh: 1: kbtest: not found", kind: "command", missing: "kbtest" },
    { name: "脚本文件不在这份快照里", command: "./run-accept.sh full", exitCode: 127,
      log: "sh: ./run-accept.sh: No such file or directory", kind: "command", missing: "./run-accept.sh" },
    { name: "PowerShell", command: ".\\kb.ps1 test full", exitCode: 1,
      log: ".\\kb.ps1 : The term '.\\kb.ps1' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      kind: "command", missing: ".\\kb.ps1" },
    { name: "cmd.exe", command: "kbtest full", exitCode: 9009,
      log: "'kbtest' is not recognized as an internal or external command,", kind: "command", missing: "kbtest" },
    // 只凭退出码：哪条措辞都没认出来，但 shell 已经按 POSIX 约定说了「找不到」。
    { name: "只有退出码 127", command: "./kb.sh test", exitCode: 127, log: "（没有可读的输出）", kind: "command", missing: null },
    { name: "只有退出码 126", command: "./kb.sh test", exitCode: 126, log: "", kind: "command", missing: null },
    // 命令本体跑起来了，缺的是它中途要用的东西：出路不同，所以**不**改写 failure。
    { name: "命令里一步缺模块", command: "npm run test:accept", exitCode: 1,
      log: "node:internal/modules: Error: Cannot find module 'playwright'", kind: "program", missing: "playwright" },
    { name: "命令里一步缺 python 包", command: "./kb.sh test", exitCode: 1,
      log: "/usr/bin/python3: No module named pytest", kind: "program", missing: "pytest" },
    // 真跑起来、真红了的：一个字都不许改写。
    { name: "普通断言失败", command: "npm run test:accept", exitCode: 1,
      log: ["1) auth > rejects expired token", "   AssertionError: expected 401 to equal 200", "", "1 failing"].join("\n"),
      kind: null },
    { name: "被测代码自己打出来的 not found（在几十行输出之后）", command: "npm run test:accept", exitCode: 1,
      log: Array.from({ length: 60 }, (_, line) => `  ✓ case ${line}`).join("\n")
        + "\n  ✗ shell fallback: expected \"sh: 1: legacy-tool: not found\" to be handled\n1 failing",
      kind: null },
  ];
  for (const testCase of MISS_CASES) {
    const miss = classifyGateLaunch({ command: testCase.command, exitCode: testCase.exitCode, log: testCase.log });
    assert.equal(miss?.kind ?? null, testCase.kind, `${testCase.name}: 归类应为 ${testCase.kind}，实际 ${miss?.kind ?? "null"}（${miss?.by ?? "-"}）`);
    if (testCase.kind) assert.equal(miss!.name, testCase.missing ?? null, `${testCase.name}: 缺的那个名字抽错了`);
    // failure 只在 command 这一档改写：program 和「认不出」都必须原样留在 exit_code 上，
    // 否则一次误判会把一条真的红说成「不是你的代码」。
    assert.equal(missFailure(miss), testCase.kind === "command" ? "command_missing" : null, `${testCase.name}: failure 归类错了`);
    assert.ok(miss?.evidence?.trim() || !testCase.kind, `${testCase.name}: 认出来了就必须留下判据原文`);
  }

  // 结论的措辞：三件事（没启动 / 目标分支上的情形 / 出路）一件都不能少，而且不能把
  // 「出路」说成 ash 会自己去做（不自动合分支、不自动跳过 —— 那是用户的决定）。
  const notice = gateCommandMissNotice({
    command: "npm run test:accept",
    miss: { kind: "command", name: "test:accept", evidence: 'npm error Missing script: "test:accept"', by: "npm" },
    sourceCommit: "de91d6c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    origin: { targetBranch: "main", targetCommit: "cf182e15bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", behind: 80, partial: false,
      holders: [{ file: "package.json", commit: "968c5de45ab4ebde5252f6cc0a5e16fc690d49a2",
        date: "2026-10-24T17:24:52+08:00", subject: "Move frontend regression from push to acceptance" }] },
  });
  assert.match(notice, /测试一行都没跑/, "第一件事：命令没启动，不是代码红了");
  assert.match(notice, /Missing script/, "判据原文要留着");
  assert.match(notice, /package\.json/, "第二件事：它在目标分支上的落点");
  assert.match(notice, /968c5de4/, "第二件事：什么时候进目标分支的");
  assert.match(notice, /落后 main 80 个提交/, "第二件事：任务分支落后多少");
  assert.match(notice, /合进任务分支/, "第三件事之一：合目标分支再验收");
  assert.match(notice, /跳过前置命令/, "第三件事之二：这次显式跳过");
  assert.match(notice, /都要你自己定/, "两条出路都是用户的决定，ash 不许自己做");
  // 名字抽不出来（只凭退出码）时也要给得出结论，不能退化成一句空话。
  const bare = gateCommandMissNotice({
    command: "./kb.sh test", miss: { kind: "command", name: null, evidence: "退出码 127（POSIX shell：命令未找到）", by: "exit-code" },
    sourceCommit: null, origin: null,
  });
  assert.match(bare, /测试一行都没跑/);
  assert.match(bare, /退出码 127/);
  assert.match(bare, /跳过前置命令/);
  console.log("✅ 门禁失败归类（命令不存在 ≠ 测试红了，22 种 runner/shell 形状 + 真红的不误判）通过");
} finally {
  for (const launch of launches) {
    assert.equal(await stopAcceptGate("process-test", launch.pid, launch.startedAt, launch.logPath), true);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
