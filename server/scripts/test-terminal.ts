import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { IS_WINDOWS } from "../src/platform.js";
import { resolveTerminalDirectory, TerminalSessionManager } from "../src/terminal.js";

// realpath 一次:Windows 的 %TEMP% 常常是 8.3 短名(`C:\Users\RUNNER~1\…`),而
// cmd 的 `cd` 回的是长名 —— 不展开的话下面那句 output.includes(cwd) 永远不成立。
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ash-terminal-")));
const manager = new TerminalSessionManager();

// 起一个**确定的** shell(不走 shellCommand() 的回退链):这条测试要验的是会话管理
// 与 ConPTY/pty 的收发,不是「这台机器上默认该用哪个 shell」。探针命令跟着 shell 走 ——
// cmd 里 `printf`/`pwd` 都不存在,得换成 `echo` 和 `cd`(cmd 的 `cd` 不带参数就是打印当前目录)。
const shell = IS_WINDOWS ? "cmd.exe" : "/bin/sh";
const probeCommand = IS_WINDOWS
  ? "echo __ASH_TERMINAL_OK__& cd\r\n"
  : "printf '__ASH_TERMINAL_OK__\\n'; pwd\n";

try {
  assert.equal(resolveTerminalDirectory("~"), homedir());
  const session = manager.create("project-test", cwd, {
    shell,
    shellArgs: [],
    cols: 80,
    rows: 20,
  });
  let output = "";
  let unsubscribe: (() => void) | null = null;
  const received = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`terminal output timed out: ${JSON.stringify(output)}`));
    }, 5000);
    unsubscribe = manager.subscribe(session.id, "project-test", (event) => {
      if (event.type !== "data") return;
      output += event.data;
      if (output.includes("__ASH_TERMINAL_OK__") && output.includes(cwd)) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  assert.ok(unsubscribe);
  assert.equal(manager.get(session.id, "wrong-project"), null);
  assert.equal(manager.resize(session.id, "project-test", 110, 32), true);
  assert.equal(manager.write(session.id, "project-test", probeCommand), true);
  await received;
  assert.ok(manager.eventsAfter(session.id, "project-test", 0)?.length);
  assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 0);
  assert.ok(manager.get(session.id, "project-test"));
  unsubscribe();
  // 交互 shell 是持久终端:没人订阅(抽屉收起)也不回收,活着就一直在。
  assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 0);
  assert.ok(manager.get(session.id, "project-test"));
  // shell 自己退出(整组死透)后,退出记录才回到闲置回收轨道。
  const exited = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("shell did not exit in time")), 8000);
    const stop = manager.subscribe(session.id, "project-test", (event) => {
      if (event.type !== "exit") return;
      clearTimeout(timeout);
      stop?.();
      resolve();
    });
    if (!stop) { clearTimeout(timeout); reject(new Error("session not found")); }
  });
  manager.write(session.id, "project-test", IS_WINDOWS ? "exit\r\n" : "exit\n");
  await exited;
  assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 1);
  assert.equal(manager.get(session.id), null);

  // destroy = tab ✕「结束会话」:进程组级确认杀净才移除。探针是 shell 里 fork 一个
  // **忽略 TERM/HUP** 的后台作业 —— close() 只对组长单发一次信号,它会被 PID 1 收养
  // 继续跑(第 1 轮自由审查实锤);destroy 必须整组清掉。Windows 没有进程组,只跑 POSIX。
  if (!IS_WINDOWS) {
    const victim = manager.create("project-destroy", cwd, { shell, shellArgs: [], cols: 80, rows: 20 });
    let pidOutput = "";
    const orphanPid = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`orphan pid output timed out: ${JSON.stringify(pidOutput)}`));
      }, 5000);
      const stop = manager.subscribe(victim.id, "project-destroy", (event) => {
        if (event.type !== "data") return;
        pidOutput += event.data;
        const match = pidOutput.match(/__ASH_PID_(\d+)__/);
        if (match) {
          clearTimeout(timeout);
          stop?.();
          resolve(Number(match[1]));
        }
      });
      // 先关掉 history expansion(交互态 bash 会把双引号里的 `$!__` 当历史引用炸掉;
      // 必须单独一行 —— 展开发生在整行执行之前,同一行里 set +H 救不了自己)。
      manager.write(victim.id, "project-destroy", "set +H 2>/dev/null\n");
      manager.write(victim.id, "project-destroy", "trap '' TERM HUP; sleep 300 & echo \"__ASH_PID_$!__\"\n");
    });
    const destroyed = await manager.destroy(victim.id, "project-destroy", { termMs: 250, killMs: 2000 });
    assert.equal(destroyed.ok, true, "destroy 应确认整组清空");
    assert.equal(manager.get(victim.id), null, "destroy 成功后会话应被移除");
    // 后台作业可能短暂停留在僵尸态等 PID 1 收尸,轮询到 ESRCH 为止。
    const deadline = Date.now() + 3000;
    for (;;) {
      try { process.kill(orphanPid, 0); } catch { break; }
      assert.ok(Date.now() < deadline, "忽略 TERM/HUP 的后台作业应随 destroy 一起被杀掉");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // destroyProject = 删项目前的清场:该项目全部会话(交互 shell + 常用命令)一把清掉,
    // 别的项目一个不动。
    const keep = manager.create("project-keep", cwd, { shell, shellArgs: [], cols: 80, rows: 20 });
    manager.create("project-doomed", cwd, { shell, shellArgs: [], cols: 80, rows: 20 });
    manager.create("project-doomed", cwd, { shell, command: { id: "dev", name: "dev", script: "sleep 300" } });
    assert.equal(manager.listForProject("project-doomed").length, 2);
    const cleared = await manager.destroyProject("project-doomed");
    assert.equal(cleared.ok, true, "destroyProject 应确认全部清空");
    assert.equal(manager.listForProject("project-doomed").length, 0, "项目的会话应全部移除");
    assert.ok(manager.get(keep.id, "project-keep"), "别的项目的会话不能被殃及");
    const keptCleared = await manager.destroy(keep.id, "project-keep");
    assert.equal(keptCleared.ok, true);
  }
  console.log("terminal session test passed");
} finally {
  manager.shutdown();
  rmSync(cwd, { recursive: true, force: true });
}
