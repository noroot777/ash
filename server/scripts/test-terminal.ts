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
  assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 1);
  assert.equal(manager.get(session.id), null);
  console.log("terminal session test passed");
} finally {
  manager.shutdown();
  rmSync(cwd, { recursive: true, force: true });
}
