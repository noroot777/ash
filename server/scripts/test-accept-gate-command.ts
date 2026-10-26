import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAcceptGate, stampAshNote, stopAcceptGate, type GateExit } from "../src/accept-gate-process.js";
import { IS_WINDOWS, userShellLaunch } from "../src/platform.js";
import { classifyGateLaunch, foreignOutputIn, missFailure, occursAsWord,
  runnerRanOrLookedElsewhere } from "../src/accept-gate-miss.js";
import { decodeGateEntryProbe, encodeGateEntryProbe, gateEntryAsk, probeGateEntry, scriptDefinedIn,
  type GateEntryProbe } from "../src/accept-gate-entry.js";
import { PROBE_BY, testGateNoticeWording } from "./test-accept-gate-notice.js";

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
  // 就是 npm 的原始报错 + rc=1，于是人和 agent 都读不出出路。
  //
  // **这一组最硬的那条不变量**（第 2 轮审查 F1 两条反例 + 第 8 轮 F1 那条换来的）：
  //   `entry`（= 测试压根没启动，唯一会改写 failure 的那一档）要**三件事同时成立**才给：
  //     ① 起跑前核到它不在；② runner 自己说了解析不出这个名字（路径档可由 127/126 顶上）；
  //     ③ 这次完整日志里除了门禁的记事和 runner 自己的报错，没有别的程序写过东西。
  //   所以每一种措辞都会被拿去跑三遍：没有①时必须退成 inner；①说「在树里」时同样退成
  //   inner；①成立但②③缺一件时也必须退成 inner（`forced` 那一列写的就是这一遍的期望）。
  const MISS_CASES: { name: string; command: string; exitCode: number | null; log: string;
    entry?: GateEntryProbe | null; kind: "entry" | "inner" | null; missing?: string | null;
    /** 强行把①设成「不在树里」之后该落哪一档（②③齐不齐决定它）。 */
    forced?: "entry" | "inner"; logComplete?: boolean }[] = [
    {
      // data/runs/4n0946g2eW1e/accept-gate-MzYxZdGAyzhv.log 原文（四条一模一样）。
      name: "原始事故（npm 10）", command: "npm run test:accept", exitCode: 1,
      log: 'npm error Missing script: "test:accept"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run\n',
      entry: { ask: "test:accept", file: "package.json", resolved: false, by: PROBE_BY },
      kind: "entry", missing: "test:accept", forced: "entry",
    },
    // ── 各家 runner 的措辞：这里验的是「那个名字抽得出来」。没有起跑前的事实，一律 inner ──
    //    `forced` 那一列（①强行成立之后落哪一档）在这里还顺带钉住第三件事的覆盖面：npm 和
    //    三家 POSIX shell 的自有输出形状这台机器上实测过，所以它们齐得了三件；yarn/pnpm/
    //    make/just/cargo/go/task/gradle/PowerShell/cmd 没实测过，一律核不出来 → 只报观察。
    { name: "npm 6/8", command: "npm run test:accept", exitCode: 1,
      log: "npm ERR! missing script: test:accept", kind: "inner", missing: "test:accept", forced: "entry" },
    { name: "yarn 1", command: "yarn run accept", exitCode: 1,
      log: 'error Command "accept" not found.', kind: "inner", missing: "accept", forced: "inner" },
    { name: "yarn berry", command: "yarn run accept", exitCode: 1,
      log: 'Usage Error: Couldn\'t find a script named "accept".', kind: "inner", missing: "accept", forced: "inner" },
    { name: "pnpm", command: "pnpm run accept", exitCode: 1,
      log: " ERR_PNPM_NO_SCRIPT  Missing script: accept", kind: "inner", missing: "accept", forced: "inner" },
    { name: "make", command: "make accept", exitCode: 2,
      log: "make: *** No rule to make target 'accept'.  Stop.", kind: "inner", missing: "accept", forced: "inner" },
    { name: "just", command: "just accept", exitCode: 1,
      log: "error: Justfile does not contain recipe `accept`.", kind: "inner", missing: "accept", forced: "inner" },
    { name: "cargo", command: "cargo accept", exitCode: 101,
      log: "error: no such command: `accept`", kind: "inner", missing: "accept", forced: "inner" },
    { name: "go", command: "go accept", exitCode: 2,
      log: 'go accept: unknown command "accept"', kind: "inner", missing: "accept", forced: "inner" },
    { name: "task", command: "task accept", exitCode: 1,
      log: 'task: Task "accept" does not exist', kind: "inner", missing: "accept", forced: "inner" },
    { name: "gradle", command: "./gradlew accept", exitCode: 1,
      log: "FAILURE: Task 'accept' not found in root project 'app'.", kind: "inner", missing: "accept", forced: "inner" },
    { name: "zsh", command: "kbtest", exitCode: 127,
      log: "zsh: command not found: kbtest", kind: "inner", missing: "kbtest", forced: "entry" },
    { name: "bash", command: "kbtest", exitCode: 127,
      log: "bash: line 1: kbtest: command not found", kind: "inner", missing: "kbtest", forced: "entry" },
    { name: "dash", command: "kbtest", exitCode: 127,
      log: "sh: 1: kbtest: not found", kind: "inner", missing: "kbtest", forced: "entry" },
    { name: "脚本文件不在树里", command: "./run-accept.sh", exitCode: 127,
      log: "sh: ./run-accept.sh: No such file or directory", kind: "inner", missing: "./run-accept.sh", forced: "entry" },
    { name: "PowerShell", command: ".\\kb.ps1 test", exitCode: 1,
      log: "The term '.\\kb.ps1' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      kind: "inner", missing: ".\\kb.ps1", forced: "inner" },
    { name: "cmd.exe", command: "kbtest", exitCode: 1,
      log: "'kbtest' is not recognized as an internal or external command,", kind: "inner", missing: "kbtest", forced: "inner" },

    // ── 起跑前核到「入口在树里」：命令确实跑起来了，缺的是它内部那一层点名的东西 ──
    { name: "同名嵌套（审查二 F1 反例①）", command: "npm run test:accept", exitCode: 1,
      log: 'ACCEPTANCE STARTED\nnpm error Missing script: "test:accept"\n',
      entry: { ask: "test:accept", file: "package.json", resolved: true, by: PROBE_BY },
      kind: "inner", missing: "test:accept", forced: "inner" },
    { name: "自删入口后报断言失败（审查二 F1 反例②）", command: "./verify.sh", exitCode: 1,
      log: "ACCEPTANCE STARTED\nASSERTION FAILED\n",
      entry: { ask: "./verify.sh", file: "verify.sh", resolved: true, by: "被测快照里的文件" },
      kind: null },
    { name: "同名但起跑前没核到", command: "npm run test:accept", exitCode: 1,
      log: 'npm error Missing script: "test:accept"\n', entry: null,
      kind: "inner", missing: "test:accept", forced: "entry" },
    { name: "跑起来之后缺模块", command: "npm run test:accept", exitCode: 1,
      log: "node:internal/modules: Error: Cannot find module 'playwright'",
      entry: { ask: "test:accept", file: "package.json", resolved: true, by: PROBE_BY }, kind: "inner", missing: "playwright", forced: "inner" },
    { name: "跑起来之后缺 python 包", command: "npm run test:accept", exitCode: 1,
      log: "/usr/bin/python3: No module named pytest",
      entry: { ask: "test:accept", file: "package.json", resolved: true, by: PROBE_BY }, kind: "inner", missing: "pytest", forced: "inner" },
    { name: "make 缺 prerequisite", command: "make accept", exitCode: 2,
      log: "KB START\nmake: *** No rule to make target 'fixture.json', needed by 'accept'.  Stop.",
      kind: "inner", missing: "fixture.json", forced: "inner" },

    // ── 只剩退出码：POSIX 约定说的是 shell 找不到东西，但跑起来的脚本也能这么退 ──
    { name: "只有退出码 127", command: "./kb.sh test", exitCode: 127, log: "（没有可读的输出）", kind: "inner", missing: null },
    { name: "只有退出码 126", command: "./kb.sh test", exitCode: 126, log: "", kind: "inner", missing: null },

    // ── ①成立（起跑前读到「它不在」），但②③缺一件：只报观察，不改 failure、不免修 ──
    //    这一组是第 8 轮审查 F1 的钉子：那一层现在是纯读的，读出来的「不在」可能是落点读错
    //    （配置能把 runner 指到别处），也可能是真跑那一刻才被生成出来。
    { name: "preload 在真跑那次把脚本生成出来（审查八 F1 反例）",
      command: "NODE_OPTIONS='--require ./preload.cjs' npm run test:accept", exitCode: 1,
      log: "ACCEPTANCE STARTED\nASSERTION FAILED\n",
      entry: { ask: "test:accept", file: "package.json", resolved: false, by: PROBE_BY },
      kind: "inner", missing: "test:accept", forced: "inner" },
    { name: "配置把 runner 指到子项目、那边真跑了（审查五/六/八 F1）", command: "npm run test:accept", exitCode: 1,
      log: "> child@1.0.0 test:accept\n> echo ACCEPTANCE STARTED; exit 1\n\nACCEPTANCE STARTED\n",
      entry: { ask: "test:accept", file: "package.json", resolved: false, by: PROBE_BY },
      kind: "inner", missing: "test:accept", forced: "inner" },
    { name: "日志太大被截断（第三件事核不出来）", command: "npm run test:accept", exitCode: 1,
      log: 'npm error Missing script: "test:accept"\n', logComplete: false,
      entry: { ask: "test:accept", file: "package.json", resolved: false, by: PROBE_BY },
      kind: "inner", missing: "test:accept", forced: "inner" },
    // 本机实测 npm 11.17 的原文：workspace 配置把落点挪到子项目、那边缺同名脚本时，报错块
    // 自带这几行；根目录缺脚本那一次一行都没有。这是第 9 轮审查两条反例唯一的分辨依据。
    { name: "npm 自己交代它跑过脚本、读的是子项目那份（②′不成立）", command: "npm run test:accept", exitCode: 1,
      log: "npm error Lifecycle script `test:accept` failed with error:\nnpm error workspace child\n"
        + "npm error location /tmp/x/child\nnpm error Missing script: \"test:accept\"\n"
        + "npm error\nnpm error To see a list of scripts, run:\nnpm error   npm run --workspace=child\n",
      entry: { ask: "test:accept", file: "package.json", resolved: false, by: PROBE_BY },
      kind: "inner", missing: "test:accept", forced: "inner" },
    { name: "runner 自己没说它解析不出来（②不成立）", command: "npm run test:accept", exitCode: 1,
      log: "npm error code ELIFECYCLE\nnpm error errno 1\n",
      entry: { ask: "test:accept", file: "package.json", resolved: false, by: PROBE_BY },
      kind: "inner", missing: "test:accept", forced: "inner" },

    // ── 真跑起来、真红了：一个字都不许被改写 ──
    { name: "真的断言失败", command: "npm run test:accept", exitCode: 1,
      log: "KB START\n1) 登录态应当保留\n   AssertionError: expected 200 to equal 302\n  1 failing\n",
      entry: { ask: "test:accept", file: "package.json", resolved: true, by: PROBE_BY }, kind: null },
    { name: "日志里只是提到过这些字", command: "npm run test:accept", exitCode: 1,
      log: "KB START\n看文档: 如果报 missing script 就先 npm i\n  2 failing\n",
      entry: { ask: "test:accept", file: "package.json", resolved: true, by: PROBE_BY }, kind: null },
  ];
  for (const testCase of MISS_CASES) {
    const miss = classifyGateLaunch({ command: testCase.command, exitCode: testCase.exitCode, log: testCase.log,
      logComplete: testCase.logComplete ?? true, entry: testCase.entry });
    assert.equal(miss?.kind ?? null, testCase.kind, `${testCase.name}: 归类应为 ${testCase.kind}，实际 ${miss?.kind ?? "null"}（${miss?.by ?? "-"}）`);
    if (testCase.kind) assert.equal(miss!.name, testCase.missing ?? null, `${testCase.name}: 缺的那个名字抽错了`);
    // failure 只在 entry 这一档改写：inner 和「认不出」都必须原样留在 exit_code 上，
    // 否则一次误判会把一条真的红说成「不是你的代码」。
    assert.equal(missFailure(miss), testCase.kind === "entry" ? "command_missing" : null, `${testCase.name}: failure 归类错了`);
    assert.ok(miss?.evidence?.trim() || !testCase.kind, `${testCase.name}: 认出来了就必须留下判据原文`);
  }

  // 上面那张表的每一种措辞，都再跑三遍，钉住那条不变量（审查二 F1、审查八 F1）：
  //  · 起跑前核出「入口不在树里」**且**②③也齐 → 才许落 entry；
  //  · ①成立而②③缺一件 → 只报观察（`forced: "inner"`），failure 一个字不许改；
  //  · ①说「在树里」、或压根没核到 → 一律不许落 entry，哪怕日志措辞一模一样。
  for (const testCase of MISS_CASES.filter(one => one.missing)) {
    const ask = testCase.missing!;
    const absent = classifyGateLaunch({ ...testCase, logComplete: testCase.logComplete ?? true,
      entry: { ask, file: "package.json", resolved: false, by: PROBE_BY } });
    const forced = testCase.forced ?? "entry";
    assert.equal(absent?.kind, forced, `${testCase.name}: 强行把①设成「不在树里」之后该落 ${forced}`);
    assert.equal(absent!.name, ask, `${testCase.name}: 名字取起跑前核的那个`);
    assert.match(absent!.evidence, /起跑前核过/, `${testCase.name}: 判据里必须有起跑前那份事实`);
    if (forced === "inner") {
      assert.ok(absent!.withheld, `${testCase.name}: ②③没齐就得记下缺的是哪一件`);
      assert.equal(missFailure(absent), null, `${testCase.name}: ②③没齐,failure 不许被改写`);
    } else {
      assert.equal(absent!.withheld, undefined, `${testCase.name}: 三件都齐了就没有「缺哪一件」`);
      assert.match(absent!.evidence, /没有别的程序写过东西/, `${testCase.name}: entry 的判据要把第三件事也写上`);
      assert.equal(missFailure(absent), "command_missing", `${testCase.name}: 三件齐了才改写 failure`);
    }
    for (const entry of [{ ask, file: "package.json", resolved: true, by: PROBE_BY }, null]) {
      const weaker = classifyGateLaunch({ ...testCase, logComplete: testCase.logComplete ?? true, entry });
      assert.notEqual(weaker?.kind, "entry",
        `${testCase.name}: ${entry ? "入口在树里" : "起跑前没核到"}时,日志措辞不许把它抬成 entry`);
      assert.equal(missFailure(weaker), null, `${testCase.name}: 没有起跑前的事实,failure 不许被改写`);
    }
  }

  // 「这条命令点名要跑的是什么」—— 认不出来必须交白卷（null），不许挑一个来充当那个入口。
  // 判据是**runner 真会怎么做**,不是「字面像不像」（第 3 轮审查 F1：三条反例都实测过）。
  for (const [command, expected] of [
    ["npm run test:accept", { kind: "script", name: "test:accept", dir: "." }],
    ["CI=1 npm run test:accept -- --ci", { kind: "script", name: "test:accept", dir: "." }],
    ["npm run-script accept", { kind: "script", name: "accept", dir: "." }],
    // 只认 npm:pnpm/yarn 的配置层和内建脚本语义这台机器上没有实测环境,外推错了要发出去的
    // 是「测试一行都没跑、不要改代码」（第 6 轮审查 F1 收口）。
    ["pnpm run accept", null],
    ["yarn run accept", null],
    ["npm test", { kind: "script", name: "test", dir: "." }],
    ["npm run test:accept > out.log 2>&1", { kind: "script", name: "test:accept", dir: "." }],
    // 引号是 shell 的,runner 拿到的名字不带它（实测）。
    ["npm run 'test:accept'", { kind: "script", name: "test:accept", dir: "." }],
    ['npm run "test:accept"', { kind: "script", name: "test:accept", dir: "." }],
    // 换了目录就得去**那份** manifest 里核;核错一份,「没有这个脚本」就是假话（反例②）。
    ["npm --prefix child run test:accept", { kind: "script", name: "test:accept", dir: "child" }],
    ["npm --prefix=child run test:accept", { kind: "script", name: "test:accept", dir: "child" }],
    ["npm run --prefix child test:accept", { kind: "script", name: "test:accept", dir: "child" }],
    ["npm -C packages/kb run accept", { kind: "script", name: "accept", dir: "packages/kb" }],
    // 目录值本身读不出来 → 白卷,不许退回「当前目录」充数。
    ["npm --prefix run test:accept", null],
    ["npm run -C", null],
    // `--` 之后是**脚本的** argv,npm 自己不再解释（第 4 轮审查 F1 实测：跑的是根目录那个
    // 脚本,`--prefix child` 只是它的参数）。照旧版本整条扫一遍,就会去读 child/package.json,
    // 把一次真跑起来、真报断言失败的红说成「一行都没跑到、不要改代码」。
    ["npm run test:accept -- --prefix child", { kind: "script", name: "test:accept", dir: "." }],
    ["npm run test:accept -- --ci --prefix=child", { kind: "script", name: "test:accept", dir: "." }],
    ["npm --prefix child run test:accept -- --prefix ..", { kind: "script", name: "test:accept", dir: "child" }],
    // 确定不吃下一个词的开关可以跳过;`--x=y` 自带值也一样。
    ["npm run --silent test:accept", { kind: "script", name: "test:accept", dir: "." }],
    ["npm run test:accept --loglevel=warn", { kind: "script", name: "test:accept", dir: "." }],
    // 点名要跑的是那个**脚本文件**,不是传给它的参数 —— 参数在不在树里,这一层答不了。
    ["./runner.sh test:accept", { kind: "path", name: "./runner.sh" }],
    ["./only-on-target.sh 2>/dev/null", { kind: "path", name: "./only-on-target.sh" }],
    ["scripts/verify.sh", { kind: "path", name: "scripts/verify.sh" }],
    // `npm start`/`restart` 缺脚本时有**默认行为**（实测：没有 scripts.start 时去跑
    // node server.js）,所以「manifest 里没有」推不出「没东西可跑」（反例①）。
    ["npm start", null],
    ["npm restart", null],
    ["npm stop", null],
    // 换成 `run` 写法照样绕不开默认行为（第 4 轮审查 F1 实测:`npm run start` 真去跑了
    // node server.js）。pnpm/yarn 没实测,一并保守。
    ["npm run start", null],
    ["npm run restart", null],
    ["pnpm run start", null],
    // 未知选项可能把后面那个词当成自己的值。`--loglevel` 在白名单里(它只影响输出),所以这
    // 条解释得了 —— 实测 npm 真跑的就是 test:accept,把 warn 当脚本名才是错的。
    ["npm run --loglevel warn test:accept", { kind: "script", name: "test:accept", dir: "." }],
    ["npm --userconfig /tmp/x run test:accept", null],
    // ── 会把 runner 指到另一份 manifest 的三个入口（第 5 轮审查 F1，四条都本机实测）──
    // ① 命令行:白名单之外一律白卷,**带等号的也一样**。旧版「`--x=y` 自带值就跳过」把
    //    `--workspace=child` 当成了无关选项,于是去核根目录那份,把一次真跑起来、真报断言
    //    失败的红说成「一行都没跑到、不要改代码」。
    ["npm --workspace=child run test:accept", null],
    ["npm --workspace child run test:accept", null],
    ["npm --workspaces=true run test:accept", null],
    ["npm --include-workspace-root run test:accept", null],
    ["pnpm --filter=child run test:accept", null],
    // ② 环境:前置赋值一律剥下来、**原样带到那两问上**(实测 `npm_config_workspace=child`
    //    真让 npm 跑了子项目那个脚本,大小写都认)。带上它,npm 自己就把这份 scope 算进答案 ——
    //    于是白卷落在探针那一层,见下面那一组真跑用例。
    ["yarn_x=1 yarn run accept", null],
    ["CI=1 TZ=UTC npm run test:accept", { kind: "script", name: "test:accept", dir: "." }],
    // ③ shell 注释按语义截断:注释里那个 `--prefix .` 不是真的目录(旧版拿它覆盖了 child)。
    ["npm --prefix child run test:accept # --prefix .", { kind: "script", name: "test:accept", dir: "child" }],
    ["npm run test:accept # 这后面写什么都不执行", { kind: "script", name: "test:accept", dir: "." }],
    // 子命令必须在最前:`npm test run` 是「跑 test 这个生命周期、把 run 当参数」。
    ["npm test run", { kind: "script", name: "test", dir: "." }],
    // 这些把「去哪儿找脚本」整个换掉,解析不了结果就别猜（反例③）。
    ["npm -w web run test", null],
    ["npm run test -w web", null],
    ["npm --workspaces run test", null],
    ["npm exec kbtest", null],
    ["pnpm -r run accept", null],
    ["pnpm --filter kb run accept", null],
    ["npm run test:accept --if-present", null],
    // 引号没闭合、带通配:切不准就白卷。
    ["npm run 'test:accept", null],
    ["npm run 'test:*'", null],
    ["npm run test:accept \\; echo done", null],
    // 分组、后台:shell 照样把里面那条跑了,旧版却去查一个字面上并不存在的文件名(`(./runner.sh)`),
    // 查不到就发免修令;`&` 那条则拿前半截的缺失代表整条命令（第 6 轮审查 F1 实测两条）。
    ["(./runner.sh)", null],
    ["(npm run test:accept)", null],
    ["./missing & ./runner.sh", null],
    ["./runner.sh & wait", null],
    // npm 内建的 `env`:`npm run --json` 列的表里**没有**它,可它真能跑(实测
    // `npm run env -- node fail.cjs` 把 fail.cjs 跑了)——「表里没有」推不出「没东西可跑」。
    ["npm run env", null],
    ["npm run env -- node fail.cjs", null],
    // 多步没有「一个入口」可言;裸程序名、绝对路径、命令替换也都核不了。
    ["npm ci && npm run test:accept", null],
    ["cd web; npm run test:accept", null],
    ["npm run a | tee log", null],
    ["kbtest", null],
    ["make accept", null],
    ["yarn accept", null],
    ["/usr/local/bin/kb test", null],
    ["$(cat cmd.txt)", null],
  ] as const) {
    assert.deepEqual(gateEntryAsk(command), expected, `入口解析错了：${command}`);
  }

  // package.json 的 scripts 是定义级判据：读不动/形状不对一律 null（「不知道」）。
  for (const [manifest, name, expected] of [
    ['{"scripts":{"test:accept":"node x"}}', "test:accept", true],
    ['{"scripts":{"test:accept-merge":"node x"}}', "test:accept", false],
    ['{"scripts":{}}', "test:accept", false],
    ['{"description":"run test:accept"}', "test:accept", false],
    ['{"scripts":null}', "test:accept", null],
    ['{"scripts":{"test:accept":{}}}', "test:accept", false],
    ["not json at all", "test:accept", null],
  ] as const) {
    assert.equal(scriptDefinedIn(manifest, name), expected, `scripts 判据算错了：${manifest}`);
  }

  // ── 起跑前那一层：**纯读**，而且读出来的东西不够单独下结论 ──
  //    第 8 轮审查 F1/F2 之后这一层一个进程都不起（第 6、7 轮「让 npm 自己回答」那条路为什么
  //    被判死，见 accept-gate-entry.ts 文件头）。代价是：配置能把 runner 指到另一份 manifest，
  //    这一层读的仍是命令行上解释出来的那份，于是会读出「没有」。
  //
  //    那种读错**不会**变成免修令 —— 授权收在归类层，那边还要另两件来自真跑那一次的事实
  //    （上面 MISS_CASES 里「配置把 runner 指到子项目、那边真跑了」钉的就是它）。
  if (!IS_WINDOWS) {
    const tree = mkdtempSync(join(tmpdir(), "ash-gate-probe-"));
    mkdirSync(join(tree, "child"));
    writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "root", private: true,
      workspaces: ["child"], scripts: { build: "echo x" } }));
    writeFileSync(join(tree, "child/package.json"), JSON.stringify({ name: "child", private: true,
      scripts: { "test:accept": "echo c" } }));
    const absent = { ask: "test:accept", file: "package.json", resolved: false, by: PROBE_BY };
    assert.deepEqual(probeGateEntry(tree, "npm run test:accept"), absent, "读命令行解释出来的那份 manifest");
    // 历史反例原样留着：这几种都会让 runner 去读别处，而这一层读不出这件事。
    for (const rc of ["workspace=child\n", "workspace[]=child\n"]) {
      writeFileSync(join(tree, ".npmrc"), rc);
      assert.deepEqual(probeGateEntry(tree, "npm run test:accept"), absent,
        `npmrc 改落点这一层看不出来（${rc.trim()}）—— 它只是三件必要条件里的一件`);
    }
    rmSync(join(tree, ".npmrc"), { force: true });
    for (const command of ["npm_config_workspace=child npm run test:accept", "PATH=bin npm run test:accept"]) {
      assert.deepEqual(probeGateEntry(tree, command), absent, `前置赋值改落点这一层也看不出来：${command}`);
    }
    // 命令行上解释得了的那一档照核那份 manifest（第 3 轮审查 F1 反例②）。
    assert.deepEqual(probeGateEntry(tree, "npm --prefix child run test:accept"),
      { ask: "test:accept", file: "child/package.json", resolved: true, by: "被测快照 child/package.json 的 scripts" },
      "换了目录就核那份 manifest");
    assert.deepEqual(probeGateEntry(tree, "npm run --silent test:accept"), absent,
      "`--silent` 这种确定只影响输出的开关不改答案");
    assert.equal(probeGateEntry(tree, "npm --prefix nosuch run test:accept"), null,
      "那份 manifest 读不动就交白卷");
    assert.equal(probeGateEntry(tree, "npm --prefix ../outside run test:accept"), null,
      "踩出这棵树的目录一律不判");
    assert.equal(probeGateEntry(tree, "(./grouped.sh)"), null, "读不准的 shell 语义照旧白卷");
    assert.deepEqual(probeGateEntry(tree, "./missing.sh"),
      { ask: "./missing.sh", file: "missing.sh", resolved: false, by: "被测快照里的文件" }, "路径那一档看文件在不在");
    // 落盘与读回：`file` 是归因层核 git 时要对齐的那个字段（第 9 轮审查 F2），所以它缺了
    // 就当没核过 —— 旧行、跨机接力都可能带着老形状，照老形状去核 git 等于各说各话。
    const probe = probeGateEntry(tree, "npm --prefix child run test:accept")!;
    assert.deepEqual(decodeGateEntryProbe(encodeGateEntryProbe(probe)), probe, "新形状原样读回");
    assert.equal(decodeGateEntryProbe(JSON.stringify({ ask: "test:accept", resolved: false, by: PROBE_BY })), null,
      "老形状（没有 file）一律当没核过");
    assert.equal(decodeGateEntryProbe("not json"), null, "读不动就当没核过");
    rmSync(tree, { recursive: true, force: true });
  }

  // 整词命中（文字线索那一路用它）：子串会把 `test:accept-merge` 算成含 `test:accept`，
  // 而原始事故的仓库里恰好两者都有（第 1 轮审查 F3 实测）。
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

  // ── ash 自己的注记要**逐行**自带标记：第三件必要条件靠它分辨「这一行是谁写的」 ──
  // 结算时追加的归类结论是多行的，`String(error)` 还会带堆栈。只标第一行，重新归类时 ash
  // 就会把自己的话当成「别的程序写过东西」（第 8 轮 F1 之后被端到端回归抓到的真 bug）。
  const multiline = "\n[ash] 2026-10-26 验收前置命令未通过\n起跑前核过 package.json：没有 test:accept\n出路：合 main 再验收\n";
  assert.equal(stampAshNote(multiline), "\n[ash] 2026-10-26 验收前置命令未通过\n"
    + "[ash] 起跑前核过 package.json：没有 test:accept\n[ash] 出路：合 main 再验收\n",
    "每一行都要打上标记，已经有的不许打第二遍，空行照旧留空");
  assert.equal(foreignOutputIn(stampAshNote(multiline), "npm"), false, "打完标记就不该再被当成别人的输出");
  assert.equal(foreignOutputIn(multiline, "npm"), true, "没逐行打标记的多行注记正是那个 bug 的样子");
  // ②′ runner 自己交代的两件否决事项（第 9 轮审查 F1/F2 的根因）。实测原文见上面那一条用例。
  const workspaceSaid = "npm error Lifecycle script `test:accept` failed with error:\n"
    + "npm error workspace child\nnpm error location /tmp/x/child\nnpm error Missing script: \"test:accept\"\n";
  assert.equal(runnerRanOrLookedElsewhere(workspaceSaid, "npm"), true, "它说了跑过脚本、读的是别处");
  assert.equal(runnerRanOrLookedElsewhere('npm error Missing script: "test:accept"\nnpm error\n'
    + "npm error To see a list of scripts, run:\nnpm error   npm run\n", "npm"), false,
    "根目录缺脚本那一次它什么都没多说 —— 不许把普通缺失也否决掉");
  assert.equal(runnerRanOrLookedElsewhere(workspaceSaid, "yarn"), false, "没实测过的 runner 不外推");
  assert.equal(runnerRanOrLookedElsewhere(workspaceSaid, null), false, "没人认领就没有「它说过」这件事");

  // 谁都没认领过（runner=null）时：有输出就是别人写的 —— 没有哪一行能拿「runner 自己的报错」
  // 豁免。`.npmrc` 把落点改到子项目那一次真跑了脚本，靠的就是这一条才答对。
  assert.equal(foreignOutputIn("\n[ash] 开跑\nACCEPTANCE STARTED\nASSERTION FAILED\n", null), true,
    "没人认领时,日志里的每一行都是别的程序写的");
  assert.equal(foreignOutputIn("\n[ash] 开跑\n[ash] 收尾\n", null), false, "只有 ash 的注记就不算别人写过");
  assert.equal(foreignOutputIn("yarn: 1: accept: not found\n", "yarn"), null,
    "认领了、但这家 runner 的输出形状没实测过:只能说核不出来");

  testGateNoticeWording();

  console.log("✅ 门禁失败归类（entry 要三件事同时成立 + 31 种措辞各验三遍 + 入口解析跟 runner 语义对齐"
    + " + 入口那一层纯读、读错也不发免修令 + 整词判据）通过");
} finally {
  for (const launch of launches) {
    assert.equal(await stopAcceptGate("process-test", launch.pid, launch.startedAt, launch.logPath), true);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
