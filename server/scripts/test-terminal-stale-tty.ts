// 退了的会话不许再拿它当年的 pty 设备号去点人。
//
// pty 的设备号（/dev/ttysNNN、/dev/pts/N）只在会话的 leader 活着时指着这条会话：leader 一退内核就收回
// 那个号，下一个开 pty 的 —— 另一条会话、另一份 ash、用户自己的终端 app —— 马上领到同一个号。退了以后
// 还按那个号枚举「会话成员」，点到的是别人，连同它整个进程组一起被 TERM+KILL。
//
// 这里不去赌「真的凑出一次复用」：直接造一条「已退、手里还留着某个设备号」的记录，而那个号此刻属于另一条
// 活着的会话（复用之后的现场就是这个样子），然后把关服、关标签、停止三个击杀入口都走一遍。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IS_WINDOWS } from "../src/platform.js";
import { TerminalSessionManager } from "../src/terminal.js";
import { killAllSessionTrees, killSessionTree, terminateSession, type KillTarget } from "../src/terminal-session-kill.js";

if (IS_WINDOWS) {
  console.log("~ Windows 没有 pty 设备号这回事（ConPTY 按句柄收），跳过");
  process.exit(0);
}

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ash-stale-tty-")));
const manager = new TerminalSessionManager();
const PROJECT = "project-stale-tty";

try {
  // 别人的活会话：一个交互 shell，问出它的设备号和自己的 pid。
  const victim = await manager.createAsync(PROJECT, cwd, { shell: "/bin/sh", shellArgs: [], cols: 80, rows: 20 });
  let output = "";
  const stop = manager.subscribe(victim.id, PROJECT, (event) => { if (event.type === "data") output += event.data; });
  assert.ok(stop);
  const said = async (pattern: RegExp, what: string): Promise<RegExpExecArray> => {
    for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
      const hit = pattern.exec(output);
      if (hit) return hit;
    }
    throw new Error(`${what}：等不到输出 ${JSON.stringify(output.slice(-300))}`);
  };
  manager.write(victim.id, PROJECT, "echo __TTY_$(tty)__ __PID_$$__\n");
  const [, ttyPath, shellPid] = await said(/__TTY_(\/dev\/[^\s_]+)__ __PID_(\d+)__/, "活会话报设备号");
  const alive = async (round: string) => {
    output = "";
    manager.write(victim.id, PROJECT, `echo __STILL_${round}__\n`);
    await said(new RegExp(`__STILL_${round}__\\r?\\n`), `${round} 之后那条活会话还得应声`);
    assert.doesNotThrow(() => process.kill(Number(shellPid), 0), `${round}：那条活会话的 shell 不许被碰`);
  };

  // 一条早就退了的会话：进程没了、退出码落了，手里却还留着那个（如今归别人的）设备号。
  const gone = spawnSync("/usr/bin/true").pid;
  assert.ok(gone, "前提：拿得到一个确定已经退场的 pid");
  const stale = (): KillTarget => ({
    process: { pid: gone, kill: () => {} },
    ttyPath,
    descendantPgids: new Set(),
    commandId: null,
    exitCode: 0,
    stop: { kind: "none" },
  });

  killAllSessionTrees([stale()]);
  await alive("SHUTDOWN");
  console.log("✓ 关服清场：退了的会话不按它当年的设备号点人");

  killSessionTree(stale());
  await alive("CLOSE");
  console.log("✓ 关标签：同上");

  const verdict = await terminateSession(stale(), { termMs: 200, killMs: 200 });
  assert.equal(verdict.ok, true, "它自己早就没了，停止照常算停净");
  await alive("STOP");
  console.log("✓ 停止：同上");
  stop();
} finally {
  manager.shutdown();
  rmSync(cwd, { recursive: true, force: true });
}
