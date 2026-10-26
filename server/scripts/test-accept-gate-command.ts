import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAcceptGate, stopAcceptGate, type GateExit } from "../src/accept-gate-process.js";
import { IS_WINDOWS, userShellLaunch } from "../src/platform.js";
import { classifyGateLaunch, gateCommandMissNotice, missFailure, occursAsWord } from "../src/accept-gate-miss.js";
import { gateFailurePrompt } from "../src/accept-gate-messages.js";

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

  // ── 失败归类：「命令点名要跑的东西不在树里」≠「测试红了」────────────────────────
  //
  // 本机四次（2026-10-24/25，日志见 data/runs/*/accept-gate-*.log）门禁给出的全部信息
  // 就是 npm 的原始报错 + rc=1，于是人和 agent 都读不出出路。这一组钉住的是：
  //  · 那四条日志**那个形状**真能被认出来（第一条用例就是原文照抄）；
  //  · 判定不写死在 npm 上 —— 一行一个 runner，shell/make/yarn/PowerShell 一并认；
  //  · **嵌套缺失不许冒充顶层缺失**（第 1 轮审查 F1）：顶层已经跑起来、它内部某一步缺了
  //    东西时，只许落 inner、不许改写 failure，更不许说「不是你的代码」；
  //  · 一份真跑起来、真红了的测试日志**不许**被归成这一类。
  const MISS_CASES: { name: string; command: string; exitCode: number | null; log: string;
    entryPresent?: boolean | null; kind: "entry" | "inner" | null; missing?: string | null }[] = [
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
      kind: "entry", missing: "test:accept",
    },
    { name: "npm 6/8 老措辞", command: "npm run test:accept", exitCode: 1,
      log: "npm ERR! missing script: test:accept", kind: "entry", missing: "test:accept" },
    { name: "yarn 1", command: "yarn accept", exitCode: 1,
      log: 'error Command "accept" not found.', kind: "entry", missing: "accept" },
    { name: "yarn berry", command: "yarn run accept", exitCode: 1,
      log: 'Usage Error: Couldn\'t find a script named "accept".', kind: "entry", missing: "accept" },
    { name: "pnpm", command: "pnpm accept", exitCode: 1,
      log: " ERR_PNPM_NO_SCRIPT  Missing script: accept", kind: "entry", missing: "accept" },
    { name: "make", command: "make accept", exitCode: 2,
      log: "make: *** No rule to make target 'accept'.  Stop.", kind: "entry", missing: "accept" },
    { name: "just", command: "just accept", exitCode: 1,
      log: "error: Justfile does not contain recipe `accept`.", kind: "entry", missing: "accept" },
    { name: "cargo", command: "cargo accept", exitCode: 101,
      log: "error: no such command: `accept`", kind: "entry", missing: "accept" },
    { name: "go", command: "go accept ./...", exitCode: 2,
      log: 'go accept: unknown command "accept"', kind: "entry", missing: "accept" },
    { name: "task", command: "task accept", exitCode: 1,
      log: 'task: Task "accept" does not exist', kind: "entry", missing: "accept" },
    { name: "gradle", command: "./gradlew accept", exitCode: 1,
      log: "FAILURE: Task 'accept' not found in root project 'app'.", kind: "entry", missing: "accept" },
    { name: "zsh 命令不存在", command: "kbtest full", exitCode: 127,
      log: "zsh: command not found: kbtest", kind: "entry", missing: "kbtest" },
    { name: "bash 命令不存在", command: "kbtest full", exitCode: 127,
      log: "bash: line 1: kbtest: command not found", kind: "entry", missing: "kbtest" },
    { name: "dash 命令不存在", command: "kbtest full", exitCode: 127,
      log: "sh: 1: kbtest: not found", kind: "entry", missing: "kbtest" },
    { name: "脚本文件不在这份快照里", command: "./run-accept.sh full", exitCode: 127,
      log: "sh: ./run-accept.sh: No such file or directory", kind: "entry", missing: "./run-accept.sh" },
    { name: "PowerShell", command: ".\\kb.ps1 test full", exitCode: 1,
      log: ".\\kb.ps1 : The term '.\\kb.ps1' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      kind: "entry", missing: ".\\kb.ps1" },
    { name: "cmd.exe", command: "kbtest full", exitCode: 9009,
      log: "'kbtest' is not recognized as an internal or external command,", kind: "entry", missing: "kbtest" },
    // 入口文件在快照里确实不在:这是硬证据,命令把输出全吞了也照样成立(审查 N1 那条
    // 「只凭退出码的兜底在生产里走不到」的正解 —— 别再指望 127 去证明顶层缺失)。
    { name: "入口文件不在快照里（输出被吞）", command: "./kb.sh test", exitCode: 1, log: "",
      entryPresent: false, kind: "entry", missing: "./kb.sh" },
    //
    // ── 第 1 轮审查 F1：顶层**已经跑起来**，缺的是它内部点名的东西 ──
    // 审查用真实 npm 复现：test:accept 存在且已输出，它内部调的 npm run helper-missing 缺了。
    // 旧版本按「这条措辞天生是 runner 在说找不到」判成顶层缺失，于是对一条**可能正是这次
    // 改动写错的**脚本名说「不是你的代码、不要修」。判据改成「那个名字是不是命令自己点名
    // 的」之后，这些一律只落 inner。
    { name: "F1 嵌套 npm：顶层跑起来了，内部脚本名缺了", command: "npm run test:accept", exitCode: 1,
      log: ["", "> test:accept", "> node check.cjs", "", "ACCEPTANCE STARTED",
        'npm error Missing script: "helper-missing"', "npm error"].join("\n"),
      kind: "inner", missing: "helper-missing" },
    { name: "F1 同类 make：缺的是 prerequisite，不是目标本身", command: "make test", exitCode: 2,
      log: "make: *** No rule to make target 'fixture.json', needed by 'test'.  Stop.",
      kind: "inner", missing: "fixture.json" },
    { name: "F1 同类 shell：脚本跑起来了，它内部调的程序没装", command: "./kb.sh test", exitCode: 127,
      log: "KB START\nsh: 1: legacy-tool: not found", entryPresent: true, kind: "inner", missing: "legacy-tool" },
    { name: "F1 同类 yarn：顶层在跑，子 runner 的脚本名缺了", command: "yarn accept", exitCode: 1,
      log: 'yarn run v1.22\n$ node ci.js\nerror Command "inner-step" not found.', kind: "inner", missing: "inner-step" },
    // 命令内部要用的模块/包：本来就是 inner，出路不同，所以不改写 failure。
    { name: "命令里一步缺模块", command: "npm run test:accept", exitCode: 1,
      log: "node:internal/modules: Error: Cannot find module 'playwright'", kind: "inner", missing: "playwright" },
    { name: "命令里一步缺 python 包", command: "./kb.sh test", exitCode: 1,
      log: "/usr/bin/python3: No module named pytest", kind: "inner", missing: "pytest" },
    // 只剩退出码:POSIX 说的是「shell 找不到要执行的东西」,可一个已经跑起来的脚本最后一步
    // 撞上同样的事也会这么退 —— 所以**只够 inner**,不许据此宣称顶层没启动(审查 N1)。
    { name: "只有退出码 127", command: "./kb.sh test", exitCode: 127, log: "（没有可读的输出）", kind: "inner", missing: null },
    { name: "只有退出码 126", command: "./kb.sh test", exitCode: 126, log: "", kind: "inner", missing: null },
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
    const miss = classifyGateLaunch({ command: testCase.command, exitCode: testCase.exitCode, log: testCase.log,
      entryPresent: testCase.entryPresent });
    assert.equal(miss?.kind ?? null, testCase.kind, `${testCase.name}: 归类应为 ${testCase.kind}，实际 ${miss?.kind ?? "null"}（${miss?.by ?? "-"}）`);
    if (testCase.kind) assert.equal(miss!.name, testCase.missing ?? null, `${testCase.name}: 缺的那个名字抽错了`);
    // failure 只在 entry 这一档改写：inner 和「认不出」都必须原样留在 exit_code 上，
    // 否则一次误判会把一条真的红说成「不是你的代码」。
    assert.equal(missFailure(miss), testCase.kind === "entry" ? "command_missing" : null, `${testCase.name}: failure 归类错了`);
    assert.ok(miss?.evidence?.trim() || !testCase.kind, `${testCase.name}: 认出来了就必须留下判据原文`);
  }

  // 整词命中：子串会把 `test:accept-merge` 算成含 `test:accept`，而原始事故的仓库里恰好
  // 两者都有 —— 按子串算，「目标分支有、快照没有」的落点就会把真正那个文件排除掉
  // （第 1 轮审查 F3 实测）。
  for (const [text, hit] of [
    ['{"scripts":{"test:accept":"node x"}}', true],
    ['{"scripts":{"test:accept-merge":"node x"}}', false],
    ['{"scripts":{"test:accept-gate-process":"node x"}}', false],
    ["跑 npm run test:accept 就行", true],
    ["见 test:accept。", true],
    ["pretest:accept-merge", false],
  ] as const) {
    assert.equal(occursAsWord(text, "test:accept"), hit, `整词判据算错了：${text}`);
  }

  // 结论的措辞。三件事（没启动 / 目标分支上的情形 / 出路）要齐，而且**出路必须跟核实档位
  // 对上**（第 1 轮审查 F4：旧版本连「目标分支上也没有」都照样保证「合进来就在树里了」）。
  const entryMiss = { kind: "entry" as const, name: "test:accept", evidence: 'npm error Missing script: "test:accept"', by: "npm" };
  const confirmed = gateCommandMissNotice({
    command: "npm run test:accept", miss: entryMiss, sourceCommit: "de91d6c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    origin: { targetBranch: "main", targetCommit: "cf182e15bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", behind: 80, unverified: false,
      holders: [{ file: "package.json", how: "text", commit: "968c5de45ab4ebde5252f6cc0a5e16fc690d49a2",
        date: "2026-10-24T17:24:52+08:00", subject: "Move frontend regression from push to acceptance" }] },
  });
  assert.match(confirmed, /一行都没跑到/, "① 命令点名要跑的东西没解析出来");
  assert.match(confirmed, /Missing script/, "① 判据原文");
  assert.match(confirmed, /package\.json/, "② 它在目标分支上的落点");
  assert.match(confirmed, /968c5de4/, "② 最早写进那个文件的是哪次提交");
  assert.match(confirmed, /落后 main 80 个提交/, "② 任务分支落后目标分支多少");
  assert.match(confirmed, /文字命中，不等于它就是那条命令的定义/, "② 不许把文字命中冒充命令定义");
  assert.match(confirmed, /把 main 合进任务分支/, "③ 核实过目标分支上有，才给合入建议");
  assert.match(confirmed, /跳过前置命令/, "③ 出路之二：这次显式跳过");
  assert.match(confirmed, /都要你自己定/, "两条出路都是用户的决定，ash 不许自己做");
  assert.equal(/\*\*|`/.test(confirmed), false, "结论要纯文本：日志和 MCP 回执都不渲染 markdown（N4）");

  // 路径模式那一档是**文件级的确定事实**，措辞不许套用文字命中的对冲（反过来也不许）。
  const byPath = gateCommandMissNotice({
    command: "./kb.sh test full", sourceCommit: "de91d6c0",
    miss: { kind: "entry", name: "./kb.sh", evidence: "被测快照里没有 ./kb.sh 这个文件", by: "entry-absent" },
    origin: { targetBranch: "main", targetCommit: "cf182e15", behind: 4, unverified: false,
      holders: [{ file: "kb.sh", how: "path", commit: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
        date: "2026-10-25T09:00:00+08:00", subject: "add gate entry script" }] },
  });
  assert.match(byPath, /只有目标分支上有/, "文件级事实可以直说");
  assert.match(byPath, /那时这个文件就在树里了/, "文件级事实的合入建议不必对冲");
  assert.equal(/文字命中/.test(byPath), false, "路径模式不许套用文字命中的对冲");

  // 目标分支上也没有：合分支解决不了,**绝不许**给合入建议。
  const absent = gateCommandMissNotice({
    command: "npm run test:accept", miss: entryMiss, sourceCommit: "de91d6c0",
    origin: { targetBranch: "main", targetCommit: "cf182e15", behind: 3, unverified: false, holders: [] },
  });
  assert.match(absent, /上也找不到/, "如实说目标分支上也没有");
  assert.match(absent, /合目标分支进来也不会让它出现/, "要说破合分支解决不了");
  assert.match(absent, /核对项目设置里这条验收前置命令本身/, "换成真正的出路");
  assert.equal(/合进任务分支/.test(absent), false, "目标分支上也没有时，不许保证合入能解决（F4）");

  // 没核对出来（不是 git 任务 / 分支读不出 / 核对超了预算）：如实说不知道，同样不许保证。
  for (const origin of [null, { targetBranch: "main", targetCommit: "cf182e15", behind: 3, unverified: true, holders: [] }]) {
    const unknown = gateCommandMissNotice({ command: "npm run test:accept", miss: entryMiss, sourceCommit: null, origin });
    assert.match(unknown, /没能核对出来/, "如实说没核对出来");
    assert.match(unknown, /不能保证/, "明说不能保证合入就解决");
    assert.equal(/把 main 合进任务分支/.test(unknown), false, "没核实过就不许给确定的合入建议（F4）");
  }

  // inner 那一档的措辞：既不敢说「测试没跑」，也不敢说「跟这次改动无关」，更不给出路保证。
  const inner = gateCommandMissNotice({
    command: "npm run test:accept", sourceCommit: "de91d6c0", origin: null,
    miss: { kind: "inner", name: "./regressed-helper.cjs", evidence: "Cannot find module './regressed-helper.cjs'", by: "node" },
  });
  assert.match(inner, /这条命令跑起来了/, "inner 要如实说命令启动了");
  assert.match(inner, /也可能是这次改动把名字写错了/, "inner 不许排除「是你改出来的」");
  assert.equal(/一行都没跑到|跳过前置命令|合进任务分支/.test(inner), false, "inner 不许摆那两条出路，也不许说测试没跑（F1/F4）");

  // 第 1 轮审查 F2：回流模板按**失败类型**分支,不拿「有没有诊断文字」代替类型。
  // inner 的诊断（failure 仍是 exit_code）绝不能被交成「不要改任何代码」。
  const promptOf = (failure: "command_missing" | "exit_code", diagnosis: string) => gateFailurePrompt({
    command: "npm run test:accept", summary: "未通过", logPath: "/tmp/gate.log", tail: "…",
    cwd: "/tmp/snap", sourceCwd: "/tmp/ws", failure, diagnosis,
  });
  const innerPrompt = promptOf("exit_code", inner);
  assert.match(innerPrompt, /定位到底是哪一条红的/, "inner 走的是普通「去修」那一版");
  assert.equal(innerPrompt.includes("不要为这件事改任何代码"), false, "inner 不许被交成「不许修」（F2）");
  assert.ok(innerPrompt.includes(inner), "inner 的那段观察仍要附上去 —— 它是定位线索");
  assert.equal(innerPrompt.includes("没能启动"), false, "inner 不是「没能启动」");
  const missingPrompt = promptOf("command_missing", confirmed);
  assert.match(missingPrompt, /不要为这件事改任何代码/, "command_missing 才换那副面孔");
  assert.match(missingPrompt, /转述给用户/);
  assert.equal(missingPrompt.includes("定位到底是哪一条红的"), false, "普通红那一版的措辞不该出现在这一种上");
  console.log("✅ 门禁失败归类（entry/inner 两档 29 种形状 + 嵌套不冒充顶层 + 整词命中 + 出路跟核实档位对上 + 回流按失败类型分支）通过");
} finally {
  for (const launch of launches) {
    assert.equal(await stopAcceptGate("process-test", launch.pid, launch.startedAt, launch.logPath), true);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
