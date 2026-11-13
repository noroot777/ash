import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAcceptGate, stopAcceptGate, type GateExit } from "../src/accept-gate-process.js";
import { IS_WINDOWS, userShellLaunch } from "../src/platform.js";
import { decodeGateEntryProbe, encodeGateEntryProbe, entryCertainlyMissing, gateEntryAsk, gateEntryNote, probeGateEntry,
  scriptDefinedIn } from "../src/accept-gate-entry.js";
import { entryInCommit } from "../src/accept-gate-entry-target.js";

const PROBE_BY = "被测快照 package.json 的 scripts";

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

  // ── 起跑前入口那一层（accept-gate-entry.ts）：命令点名要跑的是什么、核得准不准 ──
  //
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

  // ── 起跑前那一层：**纯读**，脚本那一档核不准 ──
  //    第 8 轮审查 F1/F2 之后这一层一个进程都不起（第 6、7 轮「让 npm 自己回答」那条路为什么
  //    被判死，见 accept-gate-entry.ts 文件头）。代价是：配置能把 runner 指到另一份 manifest，
  //    这一层读的仍是命令行上解释出来的那份，于是会读出「没有」—— 所以脚本那一档一律 certain:
  //    false，照常起跑，绝不据此拦下。
  if (!IS_WINDOWS) {
    const tree = mkdtempSync(join(tmpdir(), "ash-gate-probe-"));
    mkdirSync(join(tree, "child"));
    writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "root", private: true,
      workspaces: ["child"], scripts: { build: "echo x" } }));
    writeFileSync(join(tree, "child/package.json"), JSON.stringify({ name: "child", private: true,
      scripts: { "test:accept": "echo c" } }));
    const absent = { ask: "test:accept", file: "package.json", resolved: false, by: PROBE_BY, certain: false };
    assert.deepEqual(probeGateEntry(tree, "npm run test:accept"), absent, "读命令行解释出来的那份 manifest");
    // 历史反例原样留着：这几种都会让 runner 去读别处，而这一层读不出这件事。
    for (const rc of ["workspace=child\n", "workspace[]=child\n"]) {
      writeFileSync(join(tree, ".npmrc"), rc);
      assert.deepEqual(probeGateEntry(tree, "npm run test:accept"), absent,
        `npmrc 改落点这一层看不出来（${rc.trim()}）—— 所以脚本那一档只算核不准`);
    }
    rmSync(join(tree, ".npmrc"), { force: true });
    for (const command of ["npm_config_workspace=child npm run test:accept", "PATH=bin npm run test:accept"]) {
      assert.deepEqual(probeGateEntry(tree, command), absent, `前置赋值改落点这一层也看不出来：${command}`);
    }
    // 命令行上解释得了的那一档照核那份 manifest（第 3 轮审查 F1 反例②）。
    assert.deepEqual(probeGateEntry(tree, "npm --prefix child run test:accept"),
      { ask: "test:accept", file: "child/package.json", resolved: true, by: "被测快照 child/package.json 的 scripts", certain: false },
      "换了目录就核那份 manifest");
    assert.deepEqual(probeGateEntry(tree, "npm run --silent test:accept"), absent,
      "`--silent` 这种确定只影响输出的开关不改答案");
    assert.equal(probeGateEntry(tree, "npm --prefix nosuch run test:accept"), null,
      "那份 manifest 读不动就交白卷");
    assert.equal(probeGateEntry(tree, "npm --prefix ../outside run test:accept"), null,
      "踩出这棵树的目录一律不判");
    assert.equal(probeGateEntry(tree, "(./grouped.sh)"), null, "读不准的 shell 语义照旧白卷");
    assert.deepEqual(probeGateEntry(tree, "./missing.sh"),
      { ask: "./missing.sh", file: "missing.sh", resolved: false, by: "被测快照里的文件", certain: true },
      "路径那一档看文件在不在，而且核得准");
    assert.equal(entryCertainlyMissing(probeGateEntry(tree, "./missing.sh 2>/dev/null")), true, "重定向不改变入口");
    writeFileSync(join(tree, "kb.sh"), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(entryCertainlyMissing(probeGateEntry(tree, "CI=1 ./kb.sh test full")), false, "在树里就照常起跑");
    assert.equal(entryCertainlyMissing(absent), false, "脚本那一档不在也不拦：核不准");
    // 「没有」必须是内核对**原样那个字符串**给的答案（第 1 轮审查 F1）：alias 是目录软链时，
    // `./alias/../runner.sh` 里的 `..` 由内核从软链指向的目录退一级，跑的是 real/runner.sh；
    // 词法折叠会去核根目录下并不存在的 runner.sh，把一条能跑绿的命令挡在门外。
    mkdirSync(join(tree, "real/nested"), { recursive: true });
    writeFileSync(join(tree, "real/runner.sh"), "#!/bin/sh\necho ACTUALLY_RAN\n", { mode: 0o755 });
    symlinkSync("real/nested", join(tree, "alias"));
    symlinkSync("real", join(tree, "launcher"));
    for (const command of ["./alias/../runner.sh", "./launcher/runner.sh", "./real/nested/../runner.sh"]) {
      assert.equal(execFileSync("sh", ["-lc", command], { cwd: tree, encoding: "utf8" }).trim(), "ACTUALLY_RAN",
        `测试自己的前提：shell 真能跑 ${command}`);
      assert.equal(probeGateEntry(tree, command)?.resolved, true, `shell 跑得到的就不许说没有：${command}`);
      assert.equal(entryCertainlyMissing(probeGateEntry(tree, command)), false, `更不许拦下起跑：${command}`);
    }
    assert.equal(entryCertainlyMissing(probeGateEntry(tree, "./launcher/gone.sh")), true, "穿过软链也确实没有的，照样核得准");
    assert.equal(entryCertainlyMissing(probeGateEntry(tree, "./real/runner.sh/x")), true, "中间一级是文件（ENOTDIR）也算没有");
    // 读不出来（权限）不等于没有：交白卷，不拦。root 跑测试时权限挡不住，这条前提不成立就跳过。
    mkdirSync(join(tree, "locked"));
    chmodSync(join(tree, "locked"), 0o000);
    try {
      if (process.getuid?.() !== 0) assert.equal(probeGateEntry(tree, "./locked/x.sh"), null, "读不出来就交白卷，不说没有");
    } finally { chmodSync(join(tree, "locked"), 0o755); }

    // 目标分支那半句：在目标提交的树里逐级走，碰上软链 / `..` 就说读不出来，绝不把「没找到直接条目」
    // 说成「没有」（第 1 轮审查 F2：`./launcher/x.sh` 在 ls-tree 里是空的，shell 却跑得到）。
    const gitIn = (...args: string[]) => execFileSync("git", ["-C", tree, ...args], { encoding: "utf8" }).trim();
    gitIn("init", "-q", "-b", "main");
    gitIn("add", "-A");
    gitIn("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "fixture");
    for (const [file, expected] of [
      ["real/runner.sh", true],
      ["./real/runner.sh", true],
      ["launcher/runner.sh", null],
      ["alias/../runner.sh", null],
      ["real/gone.sh", false],
      ["gone/runner.sh", false],
      ["real/runner.sh/x", false],
      ["REAL/runner.sh", null],
      ["real", null],
      [":!real/runner.sh", false],
    ] as const) {
      assert.equal(await entryInCommit(tree, "HEAD", file), expected, `目标树里核 ${file}`);
    }
    // 落盘与读回：`file` 缺了就当没核过（去目标分支上核的就是它）；没有 `certain` 的旧行当核不准 ——
    // 那时还没有「不起跑」这一档，不能事后替它说「没起跑」。
    const probe = probeGateEntry(tree, "npm --prefix child run test:accept")!;
    assert.deepEqual(decodeGateEntryProbe(encodeGateEntryProbe(probe)), { ...probe, target: null }, "新形状原样读回");
    const blocked = { ...probeGateEntry(tree, "./missing.sh")!, target: { branch: "main", has: true } };
    assert.deepEqual(decodeGateEntryProbe(encodeGateEntryProbe(blocked)), blocked, "目标分支那一项跟着落盘");
    assert.equal(decodeGateEntryProbe(JSON.stringify({ ask: "test:accept", resolved: false, by: PROBE_BY })), null,
      "老形状（没有 file）一律当没核过");
    assert.equal(decodeGateEntryProbe(JSON.stringify({ ask: "./x.sh", file: "x.sh", resolved: false, by: "被测快照里的文件" }))?.certain,
      false, "没有 certain 的旧行当核不准");
    assert.equal(decodeGateEntryProbe("not json"), null, "读不动就当没核过");
    rmSync(tree, { recursive: true, force: true });
  }

  // 入口那句话：核得准的一档说确定的话（没起跑 + 目标分支上有没有），核不准的一档只陈述看到的。
  const pathMiss = { ask: "./kb.sh", file: "kb.sh", resolved: false, by: "被测快照里的文件", certain: true };
  assert.equal(gateEntryNote({ ...pathMiss, target: { branch: "main", has: true } }, "failed"),
    "被测的这棵树里没有 ./kb.sh，命令没有起跑。目标分支 main 上有它。");
  assert.match(gateEntryNote({ ...pathMiss, target: { branch: "main", has: false } }, "failed")!, /目标分支 main 上也没有。$/);
  assert.match(gateEntryNote({ ...pathMiss, target: { branch: "main", has: null } }, "failed")!, /这次没读出来。$/);
  assert.equal(gateEntryNote({ ...pathMiss, target: null }, "failed"), "被测的这棵树里没有 ./kb.sh，命令没有起跑。",
    "没有合并目标的任务不提目标分支");
  const scriptMiss = { ask: "test:accept", file: "package.json", resolved: false, by: PROBE_BY, certain: false };
  const seen = gateEntryNote(scriptMiss, "failed")!;
  assert.match(seen, /^起跑前看到：被测快照 package\.json 的 scripts 里没有 test:accept/, "核不准的一档只陈述起跑前看到的");
  assert.equal(/没有起跑|没跑起来|不用修/.test(seen), false, "核不准的一档不许下结论");
  assert.equal(gateEntryNote({ ...scriptMiss, resolved: true }, "failed"), null, "入口在树里就没有可说的");
  assert.equal(gateEntryNote(scriptMiss, "passed"), null, "绿了就没有可说的");
  assert.equal(gateEntryNote(null, "failed"), null, "没核过就没有可说的");
  for (const note of [gateEntryNote({ ...pathMiss, target: { branch: "main", has: true } }, "failed")!, seen]) {
    assert.equal(/\*\*|`/.test(note), false, "纯文本：日志和 MCP 回执都不渲染 markdown");
  }

  console.log("✅ 门禁起跑前入口（入口解析跟 runner 语义对齐 + 纯读 + 路径档核得准、脚本档核不准 + 入口那句话）通过");
} finally {
  for (const launch of launches) {
    assert.equal(await stopAcceptGate("process-test", launch.pid, launch.startedAt, launch.logPath), true);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
