// 常用命令回归:命令会话的生命周期(活着豁免闲置回收 / 退出落 exitCode / 退出后回到
// 普通回收轨道)+ parseProjectCommands 的校验。路由层只是这些原语的薄壳,不在这里起 HTTP。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectCommands } from "@ash/shared/project-commands";
import {
  fillCommandPlaceholders,
  missingCommandValues,
  parseCommandPlaceholders,
  parseCommandValues,
} from "@ash/shared/project-commands";
import { IS_WINDOWS } from "../src/platform.js";
import { TerminalSessionManager, terminalSessions } from "../src/terminal.js";
import { restartCommand, startCommand, stopCommand, type RunnableCommand } from "../src/terminal-commands.js";
import { powerShellCommandCases } from "./project-command-powershell-cases.js";
import { commandLaunch } from "../src/terminal-shell.js";

// ── parse ──────────────────────────────────────────────────────────────────
assert.equal(parseProjectCommands(null), null);
// 空配置归一成 null(= 清空),不落一份空壳对象。
assert.equal(parseProjectCommands({ service: null, commands: [] }), null);
const parsed = parseProjectCommands({
  service: { command: " npm run dev ", restartCommand: "  " },
  commands: [{ id: "dev", name: " web dev ", command: " npm test " }],
})!;
assert.equal(parsed.service?.command, "npm run dev");
// 空白重启命令归一成 null(= 杀掉再跑启动命令),不能存成 ""。
assert.equal(parsed.service?.restartCommand, null);
assert.equal(parsed.commands[0].name, "web dev");
assert.equal(parsed.commands[0].command, "npm test");
// 旧客户端发来的纯数组照收:当作普通命令,那一代的逐条 restartCommand 丢弃。
const legacy = parseProjectCommands([
  { id: "dev", name: "web dev", command: "npm run dev", restartCommand: "npm run dev -- --reset" },
])!;
assert.equal(legacy.service, null);
assert.deepEqual(legacy.commands, [{ id: "dev", name: "web dev", command: "npm run dev" }]);
// 只填重启不填启动没有意义:重启的前半段就是杀旧进程,起点必须有启动命令。
assert.throws(() => parseProjectCommands({ service: { command: " ", restartCommand: "x" }, commands: [] }));
assert.throws(() => parseProjectCommands({ commands: [{ id: "a b", name: "x", command: "y" }] }));
// "service" 是保留 id(项目级启动/重启的会话身份),普通命令不得占用。
assert.throws(() => parseProjectCommands({ commands: [{ id: "service", name: "x", command: "y" }] }));
assert.throws(() => parseProjectCommands({ commands: [
  { id: "a", name: "x", command: "y" },
  { id: "a", name: "z", command: "w" },
] }));
assert.throws(() => parseProjectCommands({ commands: [{ id: "a", name: "x", command: "   " }] }));
assert.throws(() => parseProjectCommands("nope"));
// 多行脚本是合法命令(编辑面是 CodeMirror,跑法是 shell -lc):只 trim 首尾,中间原样留着。
assert.equal(
  parseProjectCommands({ commands: [{ id: "m", name: "多行", command: "\ncd web\nnpm run dev\n" }] })!.commands[0].command,
  "cd web\nnpm run dev",
);

// ── 占位符 ─────────────────────────────────────────────────────────────────
assert.deepEqual(parseCommandPlaceholders("git checkout {{分支}}"), [{ name: "分支", defaultValue: null }]);
// 有 `=` 就是可选(默认值可以为空);同名只出现一次,谁写了默认值算谁的。
assert.deepEqual(parseCommandPlaceholders("echo {{a=1}} {{ a }} {{b=}}"), [
  { name: "a", defaultValue: "1" },
  { name: "b", defaultValue: "" },
]);
// 不是合法占位符的 `{{…}}` 当普通文本,不问也不替换。
assert.deepEqual(parseCommandPlaceholders("echo {{}} ${VAR}"), []);
assert.equal(fillCommandPlaceholders("echo {{}} ${VAR}", {}), "echo {{}} ${VAR}");
assert.equal(fillCommandPlaceholders("git checkout {{分支}}", { 分支: "main" }), "git checkout main");
// 留空 = 用默认值;没有默认值就是必填,填不上一律抛(绝不把 {{分支}} 交给 shell)。
assert.equal(fillCommandPlaceholders("npm run dev -- --port {{端口=5173}}", { 端口: "" }), "npm run dev -- --port 5173");
assert.deepEqual(missingCommandValues("git checkout {{分支}}", {}), ["分支"]);
assert.deepEqual(missingCommandValues("git checkout {{分支=main}}", {}), []);
assert.throws(() => fillCommandPlaceholders("git checkout {{分支}}", {}), /分支/);
// 替换是原样文本,但换行会把一条命令变成好几条 —— 那是意外不是意图,一律拒绝。
assert.throws(() => parseCommandValues({ a: "x\nrm -rf /" }), /换行/);
assert.throws(() => fillCommandPlaceholders("echo {{a}}", { a: "x\ny" }), /换行/);
assert.throws(() => parseCommandValues({ a: 1 }));
assert.throws(() => parseCommandValues([]));
assert.deepEqual(parseCommandValues(undefined), {});
// 替换出来的值本身带 `$&` 这类正则替换记号也必须原样(用的是函数式 replace)。
assert.equal(fillCommandPlaceholders("echo {{a}}", { a: "$& $1" }), "echo $& $1");

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ash-cmd-")));
const manager = new TerminalSessionManager();

// SIGKILL 已生效、PID 1 还没 reap 的窗口里,kill(pid, 0) 对僵尸仍然成功 —— 只用它
// 立即断言「进程被收掉」会偶发误报(第 8 轮审查实测 4 跑 2 挂)。这里轮询判死,
// 且僵尸(ps stat 为 Z)也算死:它只剩进程表项,不跑代码不占端口,对「停止」语义就是死了。
async function assertProcessGone(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive) {
      const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)]).stdout?.toString().trim() ?? "";
      if (stat === "" || stat.startsWith("Z")) alive = false;
    }
    if (!alive) return;
    if (Date.now() > deadline) throw new Error(`${label}: PID ${pid} 仍然存活`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function waitExit(sessionId: string, projectId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("command session did not exit in time")), 8000);
    const unsubscribe = manager.subscribe(sessionId, projectId, (event) => {
      if (event.type !== "exit") return;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(event.exitCode);
    });
    if (!unsubscribe) { clearTimeout(timeout); reject(new Error("session not found")); }
  });
}

if (IS_WINDOWS) {
  // ── Windows:真 ConPTY + PowerShell 的生命周期 ──────────────────────────────
  // 下面那一大段 POSIX 探针(trap / disown / nohup / 独立 PGID / `ps -o pgid`)问的是
  // 「信号与进程组还能不能触达服务」,而 Windows 上这三个概念压根不存在:没有信号,
  // 停止走 ConPTY 的 `GetConsoleProcessList` + `taskkill /T`,确定性比那边还高。
  // 所以这边钉的是另外三件事 —— 方言(PowerShell 多行脚本真能跑)、退出码(收口把
  // 原生命令的 `$LASTEXITCODE` 透传出来)、以及停止/幂等这几条跨平台契约。
  try {
    // ① 多行脚本 + 工作目录:cmd.exe 的 `/c` 收不了多行,所以这一条同时是「选对了
    //    PowerShell」的证据。写一个文件出来证明它真的跑到了,且跑在 cwd 里。
    const marker = join(cwd, "win-ok.txt");
    const live = await manager.createAsync("p1", cwd, {
      command: {
        id: "dev",
        name: "web dev",
        script: `Set-Content -LiteralPath "${marker}" -Value ok -NoNewline\nStart-Sleep -Seconds 60`,
      },
    });
    assert.equal(live.commandId, "dev");
    assert.equal(live.exitCode, null);
    const markerDeadline = Date.now() + 15000;
    let wrote = "";
    while (wrote !== "ok") {
      try { wrote = readFileSync(marker, "utf8").trim(); } catch { /* 还没写 */ }
      if (wrote !== "ok" && Date.now() > markerDeadline) throw new Error(`多行 PowerShell 脚本没跑起来:${wrote}`);
      if (wrote !== "ok") await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // 活着的命令会话:找得到、闲置多久都不回收。
    assert.equal(manager.liveCommandSession("p1", "dev")?.id, live.id);
    assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 0);

    // ② 停止 = terminate:保留现场、打「用户停的」标(刷新后看得出「我停过」)。
    assert.deepEqual(await manager.terminate(live.id, "p1"), { ok: true });
    const stoppedInfo = manager.get(live.id, "p1");
    assert.notEqual(stoppedInfo?.exitCode, null, "停止后 exitCode 必须落下");
    assert.equal(stoppedInfo?.stoppedByUser, true);
    assert.equal(manager.liveCommandSession("p1", "dev"), null);

    // ③ 退出码两条路都要对:PowerShell 自己的 `exit`,和**原生命令**的 $LASTEXITCODE
    //    (后者正是 `-EncodedCommand` 要补那段收口的理由 —— 不补一律 0/1)。
    const direct = await manager.createAsync("p1", cwd, { command: { id: "rc", name: "rc", script: "exit 3" } });
    assert.equal(await waitExit(direct.id, "p1"), 3);
    const native = await manager.createAsync("p1", cwd, {
      command: { id: "rc2", name: "rc2", script: 'node -e "process.exit(7)"' },
    });
    assert.equal(await waitExit(native.id, "p1"), 7, "原生命令的退出码必须被收口透传出来");
    const listed = manager.listCommandSessions().find((session) => session.id === native.id);
    assert.equal(listed?.stoppedByUser, false, "自己退出的不算用户停的");

    // ③' 收口认的是**最后一条语句**,不是「这段脚本里有没有失败过」(第 1 轮审查 F3)。
    //    `$LASTEXITCODE` 对「最近一个原生命令」有粘性:中途失败之后,后面的 cmdlet 成功
    //    也不会清掉那个码。所以「先失败、随后补救成功」的脚本必须退 0 —— 这条只有在真
    //    PowerShell 上跑才算数(粘性是它的行为,文本断言证明不了),所以放在这里而不是
    //    test-win-launch.ts。
    const recovered = await manager.createAsync("p1", cwd, {
      command: { id: "rc3", name: "rc3", script: 'node -e "process.exit(7)"\nWrite-Output "RECOVERED"' },
    });
    assert.equal(await waitExit(recovered.id, "p1"), 0,
      "失败的原生命令之后又有语句成功 → 整段算成功(粘住的 $LASTEXITCODE 不得冒充最后一句)");
    const recoveredNative = await manager.createAsync("p1", cwd, {
      command: { id: "rc4", name: "rc4", script: 'node -e "process.exit(7)"\nnode -e "process.exit(0)"' },
    });
    assert.equal(await waitExit(recoveredNative.id, "p1"), 0, "最后一条原生命令成功 → 0");
    const cmdletFail = await manager.createAsync("p1", cwd, {
      command: { id: "rc5", name: "rc5", script: 'Get-Item -LiteralPath "' + join(cwd, "no-such-file-xyz") + '"' },
    });
    assert.notEqual(await waitExit(cmdletFail.id, "p1"), 0, "最后一条是失败的 cmdlet → 非零");

    const version = spawnSync(commandLaunch("").shell, ["-NoLogo", "-NoProfile", "-Command", "100 * $PSVersionTable.PSVersion.Major + $PSVersionTable.PSVersion.Minor"], {
      encoding: "utf8", timeout: 20_000, windowsHide: true,
    });
    assert.ifError(version.error);
    assert.equal(version.status, 0, version.stderr);
    const versionNumber = Number(version.stdout.trim());
    assert.ok(versionNumber >= 500, `unexpected PowerShell version: ${version.stdout}`);
    for (const testCase of powerShellCommandCases(process.execPath)) {
      if ((testCase.minimumVersion ?? 500) > versionNumber) continue;
      const session = await manager.createAsync("p1", cwd, {
        command: { id: "semantic", name: testCase.name, script: testCase.script },
      });
      assert.equal(await waitExit(session.id, "p1"), testCase.exitCode, testCase.name);
      if (testCase.output || testCase.absentOutput) {
        const output = manager.eventsAfter(session.id, "p1", 0)
          ?.map((event) => event.type === "data" ? event.data : "").join("") ?? "";
        if (testCase.output) assert.ok(output.includes(testCase.output), `${testCase.name}: ${output}`);
        if (testCase.absentOutput) assert.ok(!output.includes(testCase.absentOutput), `${testCase.name}: ${output}`);
      }
    }

    // ④ 跨平台契约:start 幂等、restart 先杀旧再起新、stop 落地。走的是真实服务函数
    //    (全局 terminalSessions),不是上面的 manager。
    const keep: RunnableCommand = { id: "keep", name: "keep alive", command: "Start-Sleep -Seconds 60", restartCommand: null };
    const liveKeep = () => terminalSessions.listCommandSessions()
      .filter((session) => session.projectId === "pcw" && session.commandId === "keep" && session.exitCode === null);
    const started = await startCommand("pcw", cwd, keep);
    assert.equal(started.status, 201);
    const startedId = (started.body as { session: { id: string } }).session.id;
    const again = await startCommand("pcw", cwd, keep);
    assert.equal((again.body as { session: { id: string } }).session.id, startedId, "在跑就幂等返回原会话");
    assert.equal(liveKeep().length, 1);
    const restarted = await restartCommand("pcw", cwd, keep);
    assert.equal(restarted.status, 201);
    assert.notEqual((restarted.body as { session: { id: string } }).session.id, startedId, "restart 换的是新会话");
    assert.equal(liveKeep().length, 1, "重启后同一条命令只能有一个活会话");
    assert.deepEqual((await stopCommand("pcw", "keep")).body, { stopped: true });
    assert.equal(liveKeep().length, 0);

    // ⑤ 占位符:取值由**服务端**填进脚本再跑;必填缺失原地 400 且不留会话。
    const holder: RunnableCommand = { id: "holder", name: "带参命令", command: "Start-Sleep -Seconds {{秒=60}}", restartCommand: null };
    const req: RunnableCommand = { ...holder, command: "Start-Sleep -Seconds {{秒}}" };
    const missing = await startCommand("pcw2", cwd, req);
    assert.equal(missing.status, 400, "必填占位符没填就该原地拒绝");
    assert.equal(terminalSessions.liveCommandSession("pcw2", "holder"), null, "拒绝时不得留下会话");
    const filled = await startCommand("pcw2", cwd, req, { 秒: "60" });
    assert.equal(filled.status, 201);
    assert.equal((filled.body as { session: { name: string } }).session.name, "带参命令 · 60");
    assert.deepEqual((await stopCommand("pcw2", "holder")).body, { stopped: true });

    console.log("project commands test passed (windows)");
  } finally {
    manager.shutdown();
    terminalSessions.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
  process.exit(0);
}

// ── 以下全是 POSIX 专属形状 ────────────────────────────────────────────────────
// trap / disown / nohup / `set -m` / `ps -o pgid` 这些都是信号与进程组的语义,Windows
// 上没有对应物(那边的停止判定是 ConPTY 的控制台进程表,见 terminal.ts 的 wrapper 注释)。

try {
  // 活着的命令会话:找得到、闲置多久都不回收。
  const live = manager.create("p1", cwd, { command: { id: "dev", name: "web dev", script: "sleep 60" } });
  assert.equal(live.commandId, "dev");
  assert.equal(live.name, "web dev");
  assert.equal(live.exitCode, null);
  assert.equal(manager.liveCommandSession("p1", "dev")?.id, live.id);
  assert.equal(manager.liveCommandSession("p2", "dev"), null);
  assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 0);
  assert.ok(manager.get(live.id, "p1"));

  // close 是「关 tab」语义:会话连日志一起消失。命令的「停止」不走这条,见下 terminate。
  assert.equal(manager.close(live.id, "p1"), true);
  assert.equal(manager.liveCommandSession("p1", "dev"), null);

  // 自己退出的命令会话:exitCode 落上、不再算 live、日志还在,闲置后回到普通回收轨道。
  const exiting = manager.create("p1", cwd, { command: { id: "dev", name: "web dev", script: "exit 3" } });
  assert.equal(await waitExit(exiting.id, "p1"), 3);
  assert.equal(manager.liveCommandSession("p1", "dev"), null);
  const listed = manager.listCommandSessions().find((session) => session.id === exiting.id);
  assert.equal(listed?.exitCode, 3);
  assert.equal(listed?.stoppedByUser, false);
  assert.ok(manager.listForProject("p1").some((session) => session.id === exiting.id));
  assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 1);
  assert.equal(manager.get(exiting.id, "p1"), null);

  // 停止 = terminate:**保留现场** —— 会话不删、exitCode 照落、打上「用户停的」标,
  // 刷新后 UI 才看得出「我停过」而不是「从没跑过」。
  const stopped = manager.create("p1", cwd, { command: { id: "dev", name: "web dev", script: "sleep 60" } });
  assert.deepEqual(await manager.terminate(stopped.id, "p1"), { ok: true });
  const stoppedInfo = manager.get(stopped.id, "p1");
  assert.notEqual(stoppedInfo?.exitCode, null);
  assert.equal(stoppedInfo?.stoppedByUser, true);
  assert.equal(manager.liveCommandSession("p1", "dev"), null);

  // 无视 SIGTERM 的进程(shell 自己 trap 掉):必须升级 SIGKILL 收干净,而不是假报已停。
  const stubborn = manager.create("p1", cwd, {
    command: { id: "resist", name: "resist", script: "trap '' TERM HUP INT; echo READY; while :; do sleep 0.2; done" },
  });
  const ready = Date.now() + 8000;
  while (!(manager.eventsAfter(stubborn.id, "p1", 0) ?? []).some((event) => event.type === "data" && event.data.includes("READY"))) {
    if (Date.now() > ready) throw new Error("stubborn process not ready");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(await manager.terminate(stubborn.id, "p1", { termMs: 600, killMs: 4000 }), { ok: true });
  assert.notEqual(manager.get(stubborn.id, "p1")?.exitCode, null);

  // 同一条命令再启动:没人盯着的旧退出记录顺手清掉,反复启停不吃会话名额。
  const fresh = manager.create("p1", cwd, { command: { id: "dev", name: "web dev", script: "sleep 60" } });
  assert.equal(manager.get(stopped.id, "p1"), null);
  assert.ok(manager.get(fresh.id, "p1"));
  assert.deepEqual(await manager.terminate(fresh.id, "p1"), { ok: true });

  // 组长先死、同组子进程还活着(`cmd & wait` 形状,子进程忽略 TERM):停止判定必须看
  // 「整组清空」,否则孤儿继续占端口、SIGKILL 永远不发(第 2 轮审查实锤)。
  const orphanScript = `node -e 'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});console.log("CHILD:"+process.pid);setInterval(()=>{},1000)' & wait`;
  const orphan = manager.create("p1", cwd, { command: { id: "orphan", name: "orphan", script: orphanScript } });
  let childPid = 0;
  const orphanReady = Date.now() + 8000;
  while (childPid === 0) {
    for (const event of manager.eventsAfter(orphan.id, "p1", 0) ?? []) {
      const match = event.type === "data" ? /CHILD:(\d+)/.exec(event.data) : null;
      if (match) childPid = Number(match[1]);
    }
    if (childPid === 0 && Date.now() > orphanReady) throw new Error("orphan child not ready");
    if (childPid === 0) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(await manager.terminate(orphan.id, "p1", { termMs: 800, killMs: 4000 }), { ok: true });
  await assertProcessGone(childPid, "忽略 SIGTERM 的同组子进程也必须被收掉");

  // 并发 restart / start 按 (projectId, commandId) 串行化:同一条命令绝不出现两个活会话。
  // 服务函数用的是全局单例 terminalSessions,不是上面的 manager。
  const keep: RunnableCommand = { id: "keep", name: "keep alive", command: "sleep 60", restartCommand: null };
  const [restart1, restart2] = await Promise.all([
    restartCommand("pc", cwd, keep),
    restartCommand("pc", cwd, keep),
  ]);
  assert.equal(restart1.status, 201);
  assert.equal(restart2.status, 201);
  const liveKeep = () => terminalSessions.listCommandSessions()
    .filter((session) => session.projectId === "pc" && session.commandId === "keep" && session.exitCode === null);
  assert.equal(liveKeep().length, 1, "并发重启后同一条命令只能有一个活会话");

  const [start1, start2] = await Promise.all([
    startCommand("pc", cwd, keep),
    startCommand("pc", cwd, keep),
  ]);
  // 已在跑:两边都拿到同一条会话(幂等),谁都不另起一份。
  assert.ok([start1, start2].every((result) => (result.body as { session: { id: string } }).session.id === liveKeep()[0].id));
  const stopKeep = await stopCommand("pc", "keep");
  assert.deepEqual(stopKeep.body, { stopped: true });
  assert.equal(liveKeep().length, 0);

  // 占位符命令的端到端:取值由服务端填进脚本再跑,必填缺失一律 400 且**不动现场**。
  const marker = join(cwd, "placeholder.txt");
  const holder: RunnableCommand = {
    id: "holder",
    name: "带参命令",
    command: `printf '%s' {{文本}} > ${marker}; sleep 60`,
    restartCommand: null,
  };
  const missing = await startCommand("pc4", cwd, holder);
  assert.equal(missing.status, 400, "必填占位符没填就该原地拒绝");
  assert.equal(terminalSessions.liveCommandSession("pc4", "holder"), null, "拒绝时不得留下会话");
  const filled = await startCommand("pc4", cwd, holder, { 文本: "alpha" });
  assert.equal(filled.status, 201);
  // 会话名缀上这次的取值,终端 tab 上看得出跑的是哪一次。
  assert.equal((filled.body as { session: { name: string } }).session.name, "带参命令 · alpha");
  const markerDeadline = Date.now() + 5000;
  let written = "";
  while (written !== "alpha") {
    try { written = readFileSync(marker, "utf8"); } catch { /* 还没写 */ }
    if (written !== "alpha" && Date.now() > markerDeadline) throw new Error(`占位符没有被替换:${written}`);
    if (written !== "alpha") await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // 取值非法时,重启必须在**杀旧进程之前**就拒绝 —— 「重启失败」不能落成「服务被停了」。
  const badRestart = await restartCommand("pc4", cwd, holder, { 文本: "a\nb" });
  assert.equal(badRestart.status, 400);
  assert.ok(terminalSessions.liveCommandSession("pc4", "holder"), "取值非法的重启不得把在跑的服务停掉");
  const reRun = await restartCommand("pc4", cwd, holder, { 文本: "beta" });
  assert.equal(reRun.status, 201);
  assert.deepEqual((await stopCommand("pc4", "holder")).body, { stopped: true });

  // daemonize 形状:组长自然退出(exit 0),忽略信号的子进程还握着 tty。命令会话包
  // TTY_COMMAND_WRAPPER(第 5 轮):wrapper 不杀合法保活的服务,但**持续拥有**它 ——
  // exitCode 不落、会话保持「运行中」,liveCommandSession 找得到、stop 能确定性触达,
  // 不再依赖一次采样命中原 PGID(第 4、5 轮审查实锤)。
  const daemonScript = (flag: string, tag: string) =>
    `node -e 'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});console.log("${tag}:"+process.pid);require("fs").writeFileSync("${flag}","1");setInterval(()=>{},1000)' & while [ ! -f ${flag} ]; do sleep 0.05; done; exit 0`;
  const readChild = (sessionId: string, tag: string): number => {
    for (const event of manager.eventsAfter(sessionId, "p1", 0) ?? []) {
      const match = event.type === "data" ? new RegExp(`${tag}:(\\d+)`).exec(event.data) : null;
      if (match) return Number(match[1]);
    }
    return 0;
  };
  const daemon = manager.create("p1", cwd, { command: { id: "daemon", name: "daemon", script: daemonScript("readyA", "DCHILD") } });
  let dchild = 0;
  const daemonReady = Date.now() + 8000;
  while ((dchild = readChild(daemon.id, "DCHILD")) === 0) {
    if (Date.now() > daemonReady) throw new Error("daemon child not ready");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // 组长写完 flag 就 exit 0;假如 wrapper 会误退,exit 事件毫秒级就落 —— 静置后 exitCode
  // 必须仍为 null(wrapper 守着 tty 持有者不退)。
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(manager.get(daemon.id, "p1")?.exitCode, null, "daemonize 下 wrapper 必须持续拥有会话,exitCode 不得落下");
  assert.equal(manager.get(daemon.id, "p1")?.groupAlive, true, "组里还有活人,groupAlive 必须为 true");
  assert.equal(manager.liveCommandSession("p1", "daemon")?.id, daemon.id, "daemonize 会话必须仍算活,否则 stop/restart 找不到它");
  assert.deepEqual(await manager.terminate(daemon.id, "p1", { termMs: 600, killMs: 4000 }), { ok: true });
  await assertProcessGone(dchild, "daemonize 的子进程也必须被停掉");
  assert.equal(manager.liveCommandSession("p1", "daemon"), null);
  assert.equal(manager.get(daemon.id, "p1")?.groupAlive, false);

  // 第 5 轮审查探针固化:命令 shell 自己 `set -m`,把服务挪进**独立 PGID** 再 disown、
  // 立即退出(原 PGID 探活彻底失效的形状)。服务还握着 tty ⇒ wrapper 持续拥有:会话
  // 必须仍算活(再点启动不得在旁边另起一份抢端口),停止必须真正杀到独立组。
  const rogue = manager.create("p1", cwd, {
    command: { id: "rogue", name: "rogue", script: "set -m; trap '' TERM HUP; sleep 300 & echo __CMD_$!__; disown; exit 0" },
  });
  let rchild = 0;
  const rogueReady = Date.now() + 8000;
  while (rchild === 0) {
    for (const event of manager.eventsAfter(rogue.id, "p1", 0) ?? []) {
      const match = event.type === "data" ? /__CMD_(\d+)__/.exec(event.data) : null;
      if (match) rchild = Number(match[1]);
    }
    if (rchild === 0 && Date.now() > rogueReady) throw new Error("rogue child not ready");
    if (rchild === 0) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const rpgid = Number(spawnSync("ps", ["-o", "pgid=", "-p", String(rchild)]).stdout?.toString().trim());
  assert.equal(rpgid, rchild, "探针前提:服务确实在自己的独立进程组里");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(manager.get(rogue.id, "p1")?.exitCode, null, "独立 PGID 服务还在,会话不得落「已结束」");
  assert.equal(manager.liveCommandSession("p1", "rogue")?.id, rogue.id, "独立 PGID 服务还在,liveCommandSession 必须找得到(否则会被重复启动)");
  assert.deepEqual(await manager.terminate(rogue.id, "p1", { termMs: 600, killMs: 4000 }), { ok: true });
  await assertProcessGone(rchild, "独立 PGID 的服务进程也必须被停止触达");
  assert.equal(manager.liveCommandSession("p1", "rogue"), null);

  // 第 6 轮审查探针固化:nohup + stdio 全重定向 + 独立 PGID + 立即退出 —— 服务不持有
  // 任何 pty fd,只看 fd 持有者会立刻误判「没人了」。ctty 是会话属性:leader(wrapper)
  // 活着时它仍是会话成员,会话必须保持「运行中」,stop 必须真正杀到它。
  const nohScript = "set -m; nohup sleep 300 </dev/null >/dev/null 2>&1 & echo NOHCHILD:$!; disown; exit 0";
  const noh = manager.create("p1", cwd, { command: { id: "noh", name: "noh", script: nohScript } });
  let nchild = 0;
  const nohReady = Date.now() + 8000;
  while ((nchild = readChild(noh.id, "NOHCHILD")) === 0) {
    if (Date.now() > nohReady) throw new Error("nohup child not ready");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const npgid = Number(spawnSync("ps", ["-o", "pgid=", "-p", String(nchild)]).stdout?.toString().trim());
  assert.equal(npgid, nchild, "探针前提:nohup 服务在自己的独立进程组里");
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(manager.get(noh.id, "p1")?.exitCode, null, "全重定向的 nohup 服务还活着,会话不得落「已结束」");
  assert.equal(manager.liveCommandSession("p1", "noh")?.id, noh.id, "全重定向的 nohup 服务必须仍算活(否则 stop 找不到、start 会另起一份)");
  assert.deepEqual(await manager.terminate(noh.id, "p1", { termMs: 600, killMs: 4000 }), { ok: true });
  await assertProcessGone(nchild, "全重定向的 nohup 服务必须被停止触达");
  assert.equal(manager.liveCommandSession("p1", "noh"), null);

  // 同一形状走真实 start/stop/restart 服务函数(全局 terminalSessions):运行中再点
  // 「启动」必须幂等返回原会话;restart 必须先真正杀掉旧服务再起新的。
  const nohCmd: RunnableCommand = { id: "noh2", name: "noh2", command: nohScript.replace("NOHCHILD", "NOH2CHILD"), restartCommand: null };
  const started = await startCommand("pc3", cwd, nohCmd);
  assert.equal(started.status, 201);
  const startedId = (started.body as { session: { id: string } }).session.id;
  let n2 = 0;
  const n2Ready = Date.now() + 8000;
  while (n2 === 0) {
    for (const event of terminalSessions.eventsAfter(startedId, "pc3", 0) ?? []) {
      const match = event.type === "data" ? /NOH2CHILD:(\d+)/.exec(event.data) : null;
      if (match) n2 = Number(match[1]);
    }
    if (n2 === 0 && Date.now() > n2Ready) throw new Error("noh2 child not ready");
    if (n2 === 0) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  const again = await startCommand("pc3", cwd, nohCmd);
  assert.equal(
    (again.body as { session: { id: string } }).session.id,
    startedId,
    "nohup 服务运行中,再次 start 必须幂等返回原会话,不得另起一份抢端口",
  );
  const restarted = await restartCommand("pc3", cwd, nohCmd);
  assert.equal(restarted.status, 201);
  await assertProcessGone(n2, "restart 必须先真正杀掉旧的 nohup 服务");
  assert.deepEqual((await stopCommand("pc3", "noh2")).body, { stopped: true });

  // 第 7 轮审查探针固化:TERM handler 在解冻窗口 fork 出新的独立 PGID。停止顺序是
  // 冻结→枚举→TERM→解冻(给收尾机会)→等待→升级 KILL;可捕获 TERM 的 shell 在解冻后
  // 跑 trap、创建首次快照里没有的新组。两重保障必须都在:wrapper(leader)用 no-op
  // 忽略 TERM 常驻(否则它被 TERM 杀 → revoke → 新组 ctty 变 ?? 枚举不到),且升级 KILL
  // 前**重新冻结 + 枚举到不动点**、判定基于最后一次完整枚举。pid 走文件不走 pty echo,
  // 避免受 pty 事件时序影响。
  const tfFlag = join(cwd, "tf.pid");
  const termForkScript =
    `set -m; trap 'nohup sleep 300 </dev/null >/dev/null 2>&1 & echo $! > ${tfFlag}; disown' TERM; echo TFREADY; while :; do sleep 0.1; done`;
  const tf = manager.create("p1", cwd, { command: { id: "tf", name: "tf", script: termForkScript } });
  const tfReady = Date.now() + 8000;
  while (!(manager.eventsAfter(tf.id, "p1", 0) ?? []).some((event) => event.type === "data" && event.data.includes("TFREADY"))) {
    if (Date.now() > tfReady) throw new Error("term-fork trap not ready");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // termMs 给足,让 handler 在解冻窗口跑完并 fork;killMs 给 KILL 轮重枚举 + 收割。
  assert.deepEqual(await manager.terminate(tf.id, "p1", { termMs: 1200, killMs: 4000 }), { ok: true });
  let tfChild = 0;
  const tfChildDeadline = Date.now() + 3000;
  while (tfChild === 0) {
    try { tfChild = Number(readFileSync(tfFlag, "utf8").trim()) || 0; } catch { /* handler 还没写 */ }
    if (tfChild === 0 && Date.now() > tfChildDeadline) throw new Error("TERM handler 未 fork —— 回归没打到缺陷路径");
    if (tfChild === 0) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await assertProcessGone(tfChild, "TERM handler 在解冻窗口 fork 的独立 PGID 也必须被停止触达(leader 常驻 + KILL 前重枚举)");
  assert.equal(manager.liveCommandSession("p1", "tf"), null);

  // 日志订阅不钉住退出记录:create 同命令新会话时,被订阅的死记录也照清 —— 否则反复
  // 「重启 + 开日志」把 16 个会话槽吃光后,restart 先杀旧再建新,建新失败落成服务中断
  // (第 1 轮审查实锤:第 16 次 restart 后 live null)。
  const pinned = manager.create("p1", cwd, { command: { id: "pin", name: "pin", script: "exit 0" } });
  await waitExit(pinned.id, "p1");
  manager.subscribe(pinned.id, "p1", () => {}); // 一直开着的日志 tab,不退订
  const replacing = manager.create("p1", cwd, { command: { id: "pin", name: "pin", script: "sleep 60" } });
  assert.equal(manager.get(pinned.id, "p1"), null, "被订阅的同命令退出记录也必须被新会话替换清掉");
  assert.deepEqual(await manager.terminate(replacing.id, "p1"), { ok: true });

  // audit 的完整场景:连环 restart、每次都订阅新会话的日志,槽不再被吃光,每次都成功。
  const churn: RunnableCommand = { id: "churn", name: "churn", command: "sleep 60", restartCommand: null };
  for (let i = 0; i < 18; i++) {
    const result = await restartCommand("pc2", cwd, churn);
    assert.equal(result.status, 201, `第 ${i + 1} 次 restart 必须成功(退出记录不被订阅钉住)`);
    terminalSessions.subscribe((result.body as { session: { id: string } }).session.id, "pc2", () => {});
  }
  const churnLive = terminalSessions.listCommandSessions()
    .filter((session) => session.projectId === "pc2" && session.commandId === "churn" && session.groupAlive);
  assert.equal(churnLive.length, 1, "连环重启后同一条命令只有一条活会话");
  assert.deepEqual((await stopCommand("pc2", "churn")).body, { stopped: true });

  // server 退出路径:shutdown() 必须整组收割,忽略信号的孤儿也不能漏 —— 否则 ash 重启后
  // 会话表清零(内存态),旧进程却被 PID 1 收养继续占端口。三种形状都要盖:组长还活着的
  // (orphan2,& wait)、组长已自然退出而 KEEPER wrapper 还守着 tty 持有者的(daemon2,
  // dchild2 已脱离 ppid 树,第 4 轮的漏杀形状)、以及 stdio 全重定向 + 独立 PGID 的
  // nohup 服务(noh3,连 fd 都不持,只有 ctty/sid 枚举能点到名,第 6 轮实锤)。
  const orphan2 = manager.create("p1", cwd, {
    command: { id: "orphan2", name: "orphan2", script: orphanScript.replace("CHILD:", "CHILD2:") },
  });
  const daemon2 = manager.create("p1", cwd, { command: { id: "daemon2", name: "daemon2", script: daemonScript("readyB", "DCHILD2") } });
  const noh3 = manager.create("p1", cwd, {
    command: { id: "noh3", name: "noh3", script: nohScript.replace("NOHCHILD", "NOH3CHILD") },
  });
  let child2 = 0;
  let dchild2 = 0;
  let nchild3 = 0;
  const shutdownReady = Date.now() + 8000;
  while ((child2 = readChild(orphan2.id, "CHILD2")) === 0
    || (dchild2 = readChild(daemon2.id, "DCHILD2")) === 0
    || (nchild3 = readChild(noh3.id, "NOH3CHILD")) === 0) {
    if (Date.now() > shutdownReady) throw new Error("shutdown fixtures not ready");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  manager.shutdown();
  await assertProcessGone(child2, "shutdown 必须收掉组长还活着的孤儿");
  await assertProcessGone(dchild2, "shutdown 必须收掉组长已退出的 daemonize 子进程");
  await assertProcessGone(nchild3, "shutdown 必须收掉全重定向 + 独立 PGID 的 nohup 服务");
  assert.equal(manager.listCommandSessions().length, 0);

  console.log("project commands test passed");
} finally {
  manager.shutdown();
  rmSync(cwd, { recursive: true, force: true });
}
