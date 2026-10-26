import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAcceptGate, stopAcceptGate, type GateExit } from "../src/accept-gate-process.js";
import { IS_WINDOWS, userShellLaunch } from "../src/platform.js";
import { classifyGateLaunch, gateCommandMissNotice, missFailure, occursAsWord,
  type GateMissOrigin } from "../src/accept-gate-miss.js";
import { gateEntryAsk, gateEntryProbeAnswer, gateEntryProbeAsk, gateEntryProbeNow, scriptDefinedIn,
  type GateEntryAsk, type GateEntryProbe } from "../src/accept-gate-entry.js";
import { gateFailurePrompt } from "../src/accept-gate-messages.js";
import type { AcceptGateMissAttribution } from "@ash/shared/accept-gate";

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
  // **这一组最硬的那条不变量**（第 2 轮审查 F1 两条反例换来的）：
  //   `entry`（= 测试压根没启动，唯一会改写 failure 的那一档）**只能**由起跑前核到的那份
  //   事实授权。日志措辞一个字都不授权它 —— 下面每一种 runner 的措辞都会被拿去跑两遍：
  //   没有那份事实时必须退成 inner，核出来「入口在树里」时同样必须退成 inner。
  const PROBE_BY = "被测快照 package.json 的 scripts（npm 自己列的）";
  const MISS_CASES: { name: string; command: string; exitCode: number | null; log: string;
    entry?: GateEntryProbe | null; kind: "entry" | "inner" | null; missing?: string | null }[] = [
    {
      // data/runs/4n0946g2eW1e/accept-gate-MzYxZdGAyzhv.log 原文（四条一模一样）。
      name: "原始事故（npm 10）", command: "npm run test:accept", exitCode: 1,
      log: 'npm error Missing script: "test:accept"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run\n',
      entry: { ask: "test:accept", resolved: false, by: PROBE_BY },
      kind: "entry", missing: "test:accept",
    },
    // ── 各家 runner 的措辞：这里验的是「那个名字抽得出来」。没有起跑前的事实，一律 inner ──
    { name: "npm 6/8", command: "npm run test:accept", exitCode: 1,
      log: "npm ERR! missing script: test:accept", kind: "inner", missing: "test:accept" },
    { name: "yarn 1", command: "yarn run accept", exitCode: 1,
      log: 'error Command "accept" not found.', kind: "inner", missing: "accept" },
    { name: "yarn berry", command: "yarn run accept", exitCode: 1,
      log: 'Usage Error: Couldn\'t find a script named "accept".', kind: "inner", missing: "accept" },
    { name: "pnpm", command: "pnpm run accept", exitCode: 1,
      log: " ERR_PNPM_NO_SCRIPT  Missing script: accept", kind: "inner", missing: "accept" },
    { name: "make", command: "make accept", exitCode: 2,
      log: "make: *** No rule to make target 'accept'.  Stop.", kind: "inner", missing: "accept" },
    { name: "just", command: "just accept", exitCode: 1,
      log: "error: Justfile does not contain recipe `accept`.", kind: "inner", missing: "accept" },
    { name: "cargo", command: "cargo accept", exitCode: 101,
      log: "error: no such command: `accept`", kind: "inner", missing: "accept" },
    { name: "go", command: "go accept", exitCode: 2,
      log: 'go accept: unknown command "accept"', kind: "inner", missing: "accept" },
    { name: "task", command: "task accept", exitCode: 1,
      log: 'task: Task "accept" does not exist', kind: "inner", missing: "accept" },
    { name: "gradle", command: "./gradlew accept", exitCode: 1,
      log: "FAILURE: Task 'accept' not found in root project 'app'.", kind: "inner", missing: "accept" },
    { name: "zsh", command: "kbtest", exitCode: 127,
      log: "zsh: command not found: kbtest", kind: "inner", missing: "kbtest" },
    { name: "bash", command: "kbtest", exitCode: 127,
      log: "bash: line 1: kbtest: command not found", kind: "inner", missing: "kbtest" },
    { name: "dash", command: "kbtest", exitCode: 127,
      log: "sh: 1: kbtest: not found", kind: "inner", missing: "kbtest" },
    { name: "脚本文件不在树里", command: "./run-accept.sh", exitCode: 127,
      log: "sh: ./run-accept.sh: No such file or directory", kind: "inner", missing: "./run-accept.sh" },
    { name: "PowerShell", command: ".\\kb.ps1 test", exitCode: 1,
      log: "The term '.\\kb.ps1' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      kind: "inner", missing: ".\\kb.ps1" },
    { name: "cmd.exe", command: "kbtest", exitCode: 1,
      log: "'kbtest' is not recognized as an internal or external command,", kind: "inner", missing: "kbtest" },

    // ── 起跑前核到「入口在树里」：命令确实跑起来了，缺的是它内部那一层点名的东西 ──
    { name: "同名嵌套（审查二 F1 反例①）", command: "npm run test:accept", exitCode: 1,
      log: 'ACCEPTANCE STARTED\nnpm error Missing script: "test:accept"\n',
      entry: { ask: "test:accept", resolved: true, by: PROBE_BY },
      kind: "inner", missing: "test:accept" },
    { name: "自删入口后报断言失败（审查二 F1 反例②）", command: "./verify.sh", exitCode: 1,
      log: "ACCEPTANCE STARTED\nASSERTION FAILED\n",
      entry: { ask: "./verify.sh", resolved: true, by: "被测快照里的文件" },
      kind: null },
    { name: "同名但起跑前没核到", command: "npm run test:accept", exitCode: 1,
      log: 'npm error Missing script: "test:accept"\n', entry: null,
      kind: "inner", missing: "test:accept" },
    { name: "跑起来之后缺模块", command: "npm run test:accept", exitCode: 1,
      log: "node:internal/modules: Error: Cannot find module 'playwright'",
      entry: { ask: "test:accept", resolved: true, by: PROBE_BY }, kind: "inner", missing: "playwright" },
    { name: "跑起来之后缺 python 包", command: "npm run test:accept", exitCode: 1,
      log: "/usr/bin/python3: No module named pytest",
      entry: { ask: "test:accept", resolved: true, by: PROBE_BY }, kind: "inner", missing: "pytest" },
    { name: "make 缺 prerequisite", command: "make accept", exitCode: 2,
      log: "KB START\nmake: *** No rule to make target 'fixture.json', needed by 'accept'.  Stop.",
      kind: "inner", missing: "fixture.json" },

    // ── 只剩退出码：POSIX 约定说的是 shell 找不到东西，但跑起来的脚本也能这么退 ──
    { name: "只有退出码 127", command: "./kb.sh test", exitCode: 127, log: "（没有可读的输出）", kind: "inner", missing: null },
    { name: "只有退出码 126", command: "./kb.sh test", exitCode: 126, log: "", kind: "inner", missing: null },

    // ── 真跑起来、真红了：一个字都不许被改写 ──
    { name: "真的断言失败", command: "npm run test:accept", exitCode: 1,
      log: "KB START\n1) 登录态应当保留\n   AssertionError: expected 200 to equal 302\n  1 failing\n",
      entry: { ask: "test:accept", resolved: true, by: PROBE_BY }, kind: null },
    { name: "日志里只是提到过这些字", command: "npm run test:accept", exitCode: 1,
      log: "KB START\n看文档: 如果报 missing script 就先 npm i\n  2 failing\n",
      entry: { ask: "test:accept", resolved: true, by: PROBE_BY }, kind: null },
  ];
  for (const testCase of MISS_CASES) {
    const miss = classifyGateLaunch({ command: testCase.command, exitCode: testCase.exitCode, log: testCase.log,
      entry: testCase.entry });
    assert.equal(miss?.kind ?? null, testCase.kind, `${testCase.name}: 归类应为 ${testCase.kind}，实际 ${miss?.kind ?? "null"}（${miss?.by ?? "-"}）`);
    if (testCase.kind) assert.equal(miss!.name, testCase.missing ?? null, `${testCase.name}: 缺的那个名字抽错了`);
    // failure 只在 entry 这一档改写：inner 和「认不出」都必须原样留在 exit_code 上，
    // 否则一次误判会把一条真的红说成「不是你的代码」。
    assert.equal(missFailure(miss), testCase.kind === "entry" ? "command_missing" : null, `${testCase.name}: failure 归类错了`);
    assert.ok(miss?.evidence?.trim() || !testCase.kind, `${testCase.name}: 认出来了就必须留下判据原文`);
  }

  // 上面那张表的每一种措辞，都再跑两遍，钉住那条不变量（审查二 F1）：
  //  · 起跑前核出来「入口不在树里」→ 才许落 entry；
  //  · 核出来「在树里」、或压根没核到  → 一律不许落 entry，哪怕日志措辞一模一样。
  for (const testCase of MISS_CASES.filter(one => one.missing)) {
    const ask = testCase.missing!;
    const absent = classifyGateLaunch({ ...testCase, entry: { ask, resolved: false, by: PROBE_BY } });
    assert.equal(absent?.kind, "entry", `${testCase.name}: 起跑前核出「不在树里」就该落 entry`);
    assert.equal(absent!.name, ask, `${testCase.name}: entry 的名字取起跑前核的那个`);
    assert.match(absent!.evidence, /起跑前核过/, `${testCase.name}: entry 的判据必须是起跑前那份事实`);
    for (const entry of [{ ask, resolved: true, by: PROBE_BY }, null]) {
      const weaker = classifyGateLaunch({ ...testCase, entry });
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
    // 期望值只写下游真会用到的那几个字段:kind/name/dir 决定去哪份 manifest 核。flags/env
    // （重放「问 npm」那两问时要带什么）单独一组钉住。
    const ask = gateEntryAsk(command);
    const shape = ask?.kind === "script" ? { kind: ask.kind, name: ask.name, dir: ask.dir } : ask;
    assert.deepEqual(shape, expected, `入口解析错了：${command}`);
  }

  // 重放那两问要带什么:目录选项规范成「选项 值」两词(等号写法也一样),前置赋值原样带上,
  // 而 `--silent`/`--loglevel` 一概不带 —— 实测 `npm run --silent --json` 把 JSON 一起吞掉
  // （stdout 空）,带上就等于逢 `--silent` 必交白卷,而它本来就是「确定只影响输出」才进白
  // 名单的。
  for (const [command, flags, env] of [
    ["npm run test:accept", [], {}],
    ["npm --prefix child run test:accept", ["--prefix", "child"], {}],
    ["npm --prefix=child run test:accept", ["--prefix", "child"], {}],
    ["npm -C packages/kb run accept", ["-C", "packages/kb"], {}],
    ["npm run --silent test:accept", [], {}],
    ["npm run --loglevel warn test:accept", [], {}],
    ["npm run test:accept --loglevel=warn", [], {}],
    ["CI=1 TZ=UTC npm run test:accept", [], { CI: "1", TZ: "UTC" }],
    ["npm_config_workspace=child npm run test:accept", [], { npm_config_workspace: "child" }],
  ] as const) {
    const ask = gateEntryAsk(command);
    assert.equal(ask?.kind, "script", `这条应当解析得出来：${command}`);
    const script = ask as GateEntryAsk & { kind: "script" };
    assert.deepEqual(script.flags, flags, `重放要带的目录选项错了：${command}`);
    assert.deepEqual(script.env, env, `重放要带的前置赋值错了：${command}`);
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

  // ── 起跑前那一层：问得出答案，还得问的是**真要跑的那一个** ──
  //    这一组按门禁的真实方式跑：把 gateEntryProbeAsk 生成的那段查询插在用户命令前面，交给
  //    同一个登录 shell 执行，再用 gateEntryProbeAnswer 把答案读回来。
  //
  //    为什么必须这么测（第 7 轮审查 F1 实测）：上一版自己 execFile 起 npm，于是「问的那个」
  //    和「跑的那个」不是一回事 —— 审查把项目自带的 npm 启动器放进命令的前置 `PATH=`，真跑
  //    的是它、真报了断言失败，探针问的却是系统 npm，于是报「入口不存在」并发出免修令。
  if (!IS_WINDOWS) {
    const tree = mkdtempSync(join(tmpdir(), "ash-gate-rc-"));
    const logPath = join(mkdtempSync(join(tmpdir(), "ash-gate-rc-log-")), "gate.log");
    mkdirSync(join(tree, "child"));
    mkdirSync(join(tree, "bin"));
    writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "root", private: true,
      workspaces: ["child"], scripts: { build: "echo x" } }));
    writeFileSync(join(tree, "child/package.json"), JSON.stringify({ name: "child", private: true,
      scripts: { "test:accept": "echo c" } }));
    // 项目自带的那个「npm」：真跑它会打出启动提示再报断言失败。
    writeFileSync(join(tree, "bin/npm"),
      "#!/bin/sh\necho ACCEPTANCE STARTED\necho ASSERTION FAILED >&2\nexit 1\n", { mode: 0o755 });
    const rc = join(tree, ".npmrc");
    const probe = async (command = "npm run test:accept") => {
      for (const suffix of [".entry-scripts.json", ".entry-prefix", ".entry-ask.err"]) {
        rmSync(`${logPath}${suffix}`, { force: true });
      }
      const prelude = gateEntryProbeAsk(tree, command, logPath);
      if (prelude === null) return gateEntryProbeNow(tree, command);
      // 门禁就是这么发的：prelude 一行、用户命令一行，同一个 `sh -lc`（accept-gate-process.ts）。
      const launch = userShellLaunch(`${prelude}\n${command}`);
      try { execFileSync(launch.file, launch.args, { cwd: tree, stdio: "ignore" }); } catch { /* 红不红不影响这一层 */ }
      return gateEntryProbeAnswer(tree, command, logPath);
    };
    const defined = { ask: "test:accept", resolved: false, by: PROBE_BY };
    // 这台机器上 npm 会把自己的配置全量注入子进程（实测 12 个 `npm_config_*`，含 prefix /
    // userconfig / globalconfig）。这一条同时钉住「不许因那些内省变量白卷」—— 那等于在任何
    // 由 npm 启动的环境里永远交白卷，整个判定作废。
    assert.deepEqual(await probe(), defined, "没有改过配置时照常给确定答案");
    writeFileSync(rc, "registry=https://example.com\naudit=false\n");
    assert.deepEqual(await probe(), defined, "npmrc 里只有无关键,不影响去哪儿找脚本");
    writeFileSync(rc, "; workspace=child\n# workspace=child\n");
    assert.deepEqual(await probe(), defined, "注释掉的设置不算");
    writeFileSync(rc, "workspace=child\n");
    assert.equal(await probe(), null, "npmrc 把 runner 指到子项目:命令行上一个字都看不出来,交白卷");
    writeFileSync(rc, "workspace[]=child\n");
    assert.equal(await probe(), null, "数组写法一样算（第 6 轮审查 F1 实测:旧版按键名比对,放过了它）");
    rmSync(rc, { force: true });
    for (const key of ["npm_config_workspace", "NPM_CONFIG_WORKSPACE"]) {
      assert.equal(await probe(`${key}=child npm run test:accept`), null,
        `前置赋值里的 scope 配置照样算（大小写 npm 都认）：${key}`);
    }
    // ★ 本轮那条：命令自己选了另一个启动器。问的必须是它 —— 它不认 `run --json`，于是这一层
    //   交白卷，而不是拿系统 npm 的答案去发免修令。
    assert.equal(await probe("PATH=bin npm run test:accept"), null,
      "命令用前置 PATH 选了项目自带的启动器:问的得是同一个,答不上来就交白卷（第 7 轮审查 F1）");
    assert.deepEqual(await probe("CI=1 npm run test:accept"), defined, "无关的前置赋值不影响答案");
    assert.deepEqual(await probe("npm run --silent test:accept"), defined,
      "`--silent` 不许让这一层倒退成白卷:重放时不带它（实测带上会把 JSON 一起吞掉）");
    assert.deepEqual(await probe("npm --prefix child run test:accept"),
      { ask: "test:accept", resolved: true, by: "被测快照 child/package.json 的 scripts（npm 自己列的）" },
      "换了目录就核那份 manifest,而且要跟 npm 自己说的目录对得上");
    assert.equal(await probe("npm --prefix nosuch run test:accept"), null,
      "目录对不上（npm 答不出那个 prefix）就交白卷,不许拿这一层算的目录硬下结论");
    // 答案没写出来（命令起不来、被取消、这一问自己挂了）时也不许冒认。
    rmSync(`${logPath}.entry-scripts.json`, { force: true });
    assert.equal(await gateEntryProbeAnswer(tree, "npm run test:accept", `${logPath}.nope`), null,
      "那两问的答案不在就交白卷");
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

  // ── 结论的措辞：三件事（没启动 / 目标分支上的情形 / 出路）要齐,而且**出路必须跟核实
  //    档位对上**。存在性只认定义级/文件级判据,文字命中只是线索（审查二 F2）。
  const entryMiss = { kind: "entry" as const, name: "test:accept", entryResolved: false,
    evidence: '起跑前核过：被测快照 package.json 的 scripts里没有 test:accept', by: PROBE_BY };
  const origin = (patch: Partial<GateMissOrigin>): GateMissOrigin => ({
    targetBranch: "main", targetCommit: "cf182e15bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", behind: 80,
    holders: [], absent: null, removedByTask: null, mergeRecovers: true, unverified: false, ...patch });
  const notice = (patch: Partial<Parameters<typeof gateCommandMissNotice>[0]>) => gateCommandMissNotice({
    command: "npm run test:accept", miss: entryMiss, sourceCommit: "de91d6c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    origin: null, ...patch });
  const holder = { commit: "968c5de45ab4ebde5252f6cc0a5e16fc690d49a2",
    date: "2026-10-24T17:24:52+08:00", subject: "Move frontend regression from push to acceptance" };

  // ① 定义级：读出目标分支那份 manifest 核过。这一档敢直说,也敢给合入建议。
  const defined = notice({ origin: origin({ holders: [{ file: "package.json", how: "definition", ...holder }] }) });
  assert.match(defined, /一行都没跑到/, "① 命令点名要跑的东西没解析出来");
  assert.match(defined, /起跑前核过/, "① 判据是起跑前那份事实");
  assert.match(defined, /是有定义的/, "② 定义级事实可以直说");
  assert.match(defined, /968c5de4/, "② 最早写进那个文件的是哪次提交");
  assert.match(defined, /落后 main 80 个提交/, "② 任务分支落后目标分支多少");
  assert.match(defined, /把 main 合进任务分支/, "③ 核实过目标分支上有,才给合入建议");
  assert.match(defined, /跳过前置命令/, "③ 出路之二：这次显式跳过");
  assert.match(defined, /都要你自己定/, "两条出路都是用户的决定,ash 不许自己做");
  assert.equal(/文字命中/.test(defined), false, "定义级不该退回文字命中那一档的对冲");
  assert.equal(/\*\*|`/.test(defined), false, "结论要纯文本：日志和 MCP 回执都不渲染 markdown");

  // ② 文字命中只是线索 —— 措辞必须说破,否则就是拿检索结果冒充命令定义（审查一 F3）。
  // 文字线索那一档真跑时 mergeRecovers 必然是 null（它压根没走定义级那条查询）。
  const byText = notice({ origin: origin({ mergeRecovers: null, holders: [{ file: "docs/ci.md", how: "text", ...holder }] }) });
  assert.match(byText, /文字命中，不等于它就是那条命令的定义/, "② 不许把文字命中冒充命令定义");
  assert.match(byText, /把 main 合进任务分支/, "② 线索也算正面证据,出路照给但要带条件");
  assert.match(byText, /合完仍然报同样的错/, "② 并且要说清合完可能还是不行");

  // ③ 文件级（命令点名的就是个文件）：确定事实,不必对冲。
  const byPath = gateCommandMissNotice({
    command: "./kb.sh test full", sourceCommit: "de91d6c0",
    miss: { kind: "entry", name: "./kb.sh", entryResolved: false, by: "被测快照里的文件",
      evidence: "起跑前核过：被测快照里的文件里没有 ./kb.sh" },
    origin: origin({ behind: 4, holders: [{ file: "kb.sh", how: "path", ...holder }] }),
  });
  assert.match(byPath, /只有目标分支上有/, "文件级事实可以直说");
  assert.match(byPath, /就在树里了/, "文件级事实的合入建议不必对冲");
  assert.equal(/文字命中/.test(byPath), false, "路径模式不许套用文字命中的对冲");

  // ④ 目标分支上**确实**也没有（定义级核出来的）：合分支解决不了,绝不许给合入建议。
  const absent = notice({ origin: origin({ behind: 3, absent: "definition" }) });
  assert.match(absent, /上也找不到/, "如实说目标分支上也没有");
  assert.match(absent, /合目标分支进来也不会让它出现/, "要说破合分支解决不了");
  assert.match(absent, /核对项目设置里这条验收前置命令本身/, "换成真正的出路");
  assert.equal(/合进任务分支/.test(absent), false, "目标分支上也没有时,不许保证合入能解决");

  // ⑤ 没核对出来。**文字检索查空也落在这一档**（审查二 F2：基线 description 里提过一句,
  //    就足以让「出现这个名字的文件集合」差集为空,而定义明明在目标分支上）。
  for (const unverifiedOrigin of [null, origin({ behind: 3, unverified: true }),
    origin({ behind: 3, unverified: false, holders: [], absent: null })]) {
    const unknown = notice({ origin: unverifiedOrigin });
    assert.match(unknown, /在目标分支上是什么情形，这次没能核对出来/, "如实说目标分支那件事没核对出来");
    assert.match(unknown, /不能保证/, "明说不能保证合入就解决");
    assert.equal(/把 main 合进任务分支/.test(unknown), false, "没核实过就不许给确定的合入建议");
    assert.equal(/上也找不到/.test(unknown), false, "更不许反过来说目标分支上也没有（审查二 F2）");
    // 归因未知 ≠ 归因为「不是你删的」。结论里必须留着这一步,否则 agent 读到的是免修令
    // （第 3 轮审查 F2：任务真把验收脚本删了、而目标 ref 又读不到时，它会被按住不许修）。
    assert.match(unknown, /先核一眼这件事/, "归因没核出来,就得让它先去核");
  }

  // ⑤' 核实过「不是这次改动弄没的」：这一档才不必再去核归因。
  const notMine = notice({ origin: origin({ behind: 3, removedByTask: false,
    holders: [{ file: "package.json", how: "definition", ...holder }] }) });
  assert.equal(/先核一眼这件事/.test(notMine), false, "核过不是它删的,就不该再让它去核一遍");

  // ⑥ 是**这次改动**把它弄没的：缺失推不出「与本次改动无关」（审查二 F1 末条）。
  const mine = notice({ origin: origin({ behind: 2, removedByTask: true }) });
  assert.match(mine, /开工基线上/, "要说清它在基线上是有的");
  assert.match(mine, /删掉或改名/, "要指出最可能的原因");
  assert.match(mine, /要改代码的一种/, "这一档的出路就是去改代码");
  assert.equal(/都要你自己定/.test(mine), false, "这一档不该先摆成「用户拍板」那两条出路");

  // ⑦ 存在性核实了、但「哪次提交带进来的」追不出来：**只丢时间,不丢那条事实**。旧版本
  //    在这种情形下把整个 holder 丢掉,于是核实过的存在性退回到「没核对出来」那一档,
  //    合入建议也一起消失了（第 3 轮审查 F3）。
  const noTime = notice({ origin: origin({ behind: 5,
    holders: [{ file: "package.json", how: "definition", commit: null, date: null, subject: null }] }) });
  assert.match(noTime, /是有定义的/, "存在性已经核实了,不许因为缺个时间一起丢掉");
  assert.match(noTime, /哪次提交带进来的，这次没追出来/, "追不出来就如实说,不许编一个");
  assert.match(noTime, /把 main 合进任务分支/, "存在性这一档的出路照给");
  // 这里要钉的是**第二件事**（目标分支上的情形）没退化成「没核对出来」。归因那句用的是同
  // 一个词，所以断言得指名道姓 —— 这条 origin 的归因默认是未知的,归因那句本来就该在。
  assert.equal(/在目标分支上是什么情形，这次没能核对出来/.test(noTime), false, "缺时间不等于没核对出来");

  // ⑧ 「目标分支上有」推不出「合它进来就有」（第 7 轮审查 F3）：共同祖先上本来就有、而任务
  //    这一侧把它删了的时候，合并会保留那个删除 —— 那时给合入保证，照着做只会再撞同一个错。
  const kept = notice({ origin: origin({ behind: 0, mergeRecovers: false, removedByTask: false,
    holders: [{ file: "package.json", how: "definition", ...holder }] }) });
  assert.match(kept, /是有定义的/, "存在性照说");
  assert.match(kept, /并不会把它带回来/, "明说合进来恢复不了");
  assert.match(kept, /共同祖先上就有/, "说清为什么：删除在任务这一侧");
  assert.match(kept, /把那个定义取回来/, "给真正能解决的那条出路");
  assert.match(kept, /跳过前置命令/, "另一条出路照给");
  assert.equal(/合进任务分支（或以它为基线重建任务分支），再点验收/.test(kept), false,
    "恢复不了就不许摆出「合进来再点验收」那条出路");
  assert.equal(/就在树里了/.test(kept), false, "更不许给「那时它就在树里了」这种保证");

  // ⑧' 合入能不能恢复**没核出来**：只能给条件句,不许保证。
  const maybe = notice({ origin: origin({ mergeRecovers: null,
    holders: [{ file: "package.json", how: "definition", ...holder }] }) });
  assert.match(maybe, /把 main 合进任务分支/, "存在性核过了,出路照给");
  assert.match(maybe, /合完也可能仍然报同样的错/, "但要说破:这次没核出合入能不能恢复");
  assert.equal(/就在树里了/.test(maybe), false, "没核出来就不许给「合进来它就在树里了」那句保证");
  for (const [what, text] of [["恢复不了", kept], ["没核出来", maybe]] as const) {
    assert.equal(/\*\*|`/.test(text), false, `结论要纯文本:日志和 MCP 回执都不渲染 markdown（${what} 那一档）`);
  }

  // ── inner 三种措辞：命令整体有没有跑起来,只许照起跑前那份事实说（审查二 F1）──
  const innerOf = (patch: Partial<Parameters<typeof gateCommandMissNotice>[0]["miss"]>) => gateCommandMissNotice({
    command: "npm run test:accept", sourceCommit: "de91d6c0", origin: null,
    miss: { kind: "inner", name: "./regressed-helper.cjs", by: "node", entryResolved: null,
      evidence: "Cannot find module './regressed-helper.cjs'", ...patch },
  });
  const inner = innerOf({ entryResolved: true });
  assert.match(inner, /不是「它不在树里」那一种/, "核过入口在树里,只敢排除这一种");
  // 在树里 ≠ 跑起来了：权限位（126）、解释器缺失都挡在前面（第 3 轮审查 F1 实测）。
  assert.match(inner, /这一层说不了/, "存在性推不出执行,这一句必须留着");
  assert.equal(/确实跑起来了|跑起来了。/.test(inner), false, "存在性不许被抬成「它跑起来了」");
  assert.match(inner, /也可能是这次改动把名字写错了/, "inner 不许排除「是你改出来的」");
  assert.equal(/一行都没跑到|跳过前置命令|合进任务分支/.test(inner), false, "inner 不许摆那两条出路,也不许说测试没跑");

  const unknownStart = innerOf({ entryResolved: null });
  assert.match(unknownStart, /这一层核不出来/, "没核到就不许说它跑起来了");
  assert.equal(/确实跑起来了/.test(unknownStart), false, "没核到就不许说它跑起来了");

  const sameName = innerOf({ name: "test:accept", entryResolved: null, sameName: true,
    evidence: 'npm error Missing script: "test:accept"' });
  assert.match(sameName, /可能不是一回事/, "同名那一条必须说破两件事可能不是一回事");
  assert.match(sameName, /不敢断定它有没有跑起来/, "没核实到就明说不敢断定");
  assert.equal(/一行都没跑到/.test(sameName), false, "同名不等于顶层缺失（审查二 F1 反例①）");

  // ── 回流模板三副面孔。两件事分开授权（第 1 轮审查 F2 + 第 3 轮审查 F2）：
  //    ① 测试有没有启动 → 看 failure,不看「有没有诊断文字」;
  //    ② 该不该让 agent 改代码 → 看归因。免修只许由**核实过**的 not-mine 授权。
  const promptOf = (failure: "command_missing" | "exit_code", diagnosis: string,
    missAttribution?: AcceptGateMissAttribution | null) => gateFailurePrompt({
    command: "npm run test:accept", summary: "未通过", logPath: "/tmp/gate.log", tail: "…",
    cwd: "/tmp/snap", sourceCwd: "/tmp/ws", failure, diagnosis, missAttribution,
  });
  const innerPrompt = promptOf("exit_code", inner);
  assert.match(innerPrompt, /定位到底是哪一条红的/, "inner 走的是普通「去修」那一版");
  assert.equal(innerPrompt.includes("不要为这件事改任何代码"), false, "inner 不许被交成「不许修」");
  assert.ok(innerPrompt.includes(inner), "inner 的那段观察仍要附上去 —— 它是定位线索");
  assert.equal(innerPrompt.includes("没能启动"), false, "inner 不是「没能启动」");
  // 即便带着一段 command_missing 的结论文字,归因是 exit_code 的那一种也不许换面孔。
  assert.equal(promptOf("exit_code", defined, "not-mine").includes("不要为这件事改任何代码"), false,
    "免修由失败类型 + 归因共同授权,光有结论文字不算");

  const missingPrompt = promptOf("command_missing", defined, "not-mine");
  assert.match(missingPrompt, /没能启动/, "① 这一种的标题是「没能启动」");
  assert.match(missingPrompt, /不要为这件事改任何代码/, "核实过不是它删的,才给免修指令");
  assert.match(missingPrompt, /在开工基线上也没有，这一条也核过了/, "免修的依据要写在面孔里");
  assert.match(missingPrompt, /转述给用户/);
  assert.match(missingPrompt, /以上面那段结论为准/, "出路和核实档位都由结论说,模板不自己下判断");
  assert.equal(/这条红跟你这次的改动无关/.test(missingPrompt), false,
    "缺失推不出「与本次改动无关」（审查二 F1 末条）");
  assert.equal(missingPrompt.includes("定位到底是哪一条红的"), false, "普通红那一版的措辞不该出现在这一种上");

  // 归因没核出来：未启动这件事照说（它核过了），但**不许**给免修令 —— 任务自己把验收脚本
  //    删了、而目标 ref 恰好读不到时，免修令会把 agent 按在原地（第 3 轮审查 F2）。
  for (const attribution of [null, undefined, "unknown"] as const) {
    const unknownPrompt = promptOf("command_missing", notice({ origin: null }), attribution);
    assert.match(unknownPrompt, /没能启动/, "未启动这件事是核过的,照说");
    assert.match(unknownPrompt, /解析不出来/, "照说它点名要跑的东西没解析出来");
    assert.equal(unknownPrompt.includes("不要为这件事改任何代码"), false,
      `归因=${attribution}：没核出来就不许发免修令`);
    assert.match(unknownPrompt, /是不是你这次改动把它弄没的/, "要让它先去核归因");
    assert.match(unknownPrompt, /改回来或同步改配置/, "核下来是自己弄没的,就该去改");
    assert.match(unknownPrompt, /转述给用户/, "核下来无关,再转述给用户");
    assert.equal(unknownPrompt.includes("定位到底是哪一条红的"), false, "它也不是普通红那一种");
    assert.match(unknownPrompt, /别为了「让它跑起来」去凭空补一个脚本/, "补个空脚本是伪造放行条件");
  }

  console.log("✅ 门禁失败归类（entry 只由起跑前事实授权 + 27 种措辞各验三遍 + 入口解析跟 runner 语义对齐（问的就是真要跑的那个 npm） + 定义级判据 + 出路跟核实档位对上（含合入恢复不了） + 回流三副面孔）通过");
} finally {
  for (const launch of launches) {
    assert.equal(await stopAcceptGate("process-test", launch.pid, launch.startedAt, launch.logPath), true);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
