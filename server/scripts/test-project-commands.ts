// 常用命令回归:命令会话的生命周期(活着豁免闲置回收 / 退出落 exitCode / 退出后回到
// 普通回收轨道)+ parseProjectCommands 的校验。路由层只是这些原语的薄壳,不在这里起 HTTP。
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectCommands } from "@ash/shared/project-commands";
import { IS_WINDOWS } from "../src/platform.js";
import { TerminalSessionManager } from "../src/terminal.js";

// ── parse ──────────────────────────────────────────────────────────────────
assert.equal(parseProjectCommands(null), null);
assert.deepEqual(parseProjectCommands([]), []);
const parsed = parseProjectCommands([
  { id: "dev", name: " web dev ", command: " npm run dev ", restartCommand: "  " },
])!;
assert.equal(parsed[0].name, "web dev");
assert.equal(parsed[0].command, "npm run dev");
// 空白重启命令归一成 null(= 杀掉再跑启动命令),不能存成 ""。
assert.equal(parsed[0].restartCommand, null);
assert.throws(() => parseProjectCommands([{ id: "a b", name: "x", command: "y", restartCommand: null }]));
assert.throws(() => parseProjectCommands([
  { id: "a", name: "x", command: "y", restartCommand: null },
  { id: "a", name: "z", command: "w", restartCommand: null },
]));
assert.throws(() => parseProjectCommands([{ id: "a", name: "x", command: "   ", restartCommand: null }]));
assert.throws(() => parseProjectCommands("nope"));

if (IS_WINDOWS) {
  // 命令会话在 Windows 上明确拒绝(未真机验证的分支不留静默陷阱),没有可测的生命周期。
  console.log("project commands test passed (windows: parse only)");
  process.exit(0);
}

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ash-cmd-")));
const manager = new TerminalSessionManager();

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

  console.log("project commands test passed");
} finally {
  manager.shutdown();
  rmSync(cwd, { recursive: true, force: true });
}
