// 常用命令回归:命令会话的生命周期(活着豁免闲置回收 / 退出落 exitCode / 退出后回到
// 普通回收轨道)+ parseProjectCommands 的校验。路由层只是这些原语的薄壳,不在这里起 HTTP。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectCommands } from "@ash/shared/project-commands";
import type { ProjectCommandConfig } from "@ash/shared/project-commands";
import { IS_WINDOWS } from "../src/platform.js";
import { TerminalSessionManager, terminalSessions } from "../src/terminal.js";
import { restartCommand, startCommand, stopCommand } from "../src/terminal-commands.js";

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
  const keep: ProjectCommandConfig = { id: "keep", name: "keep alive", command: "sleep 60", restartCommand: null };
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

  // daemonize 形状:组长自然退出(exit 0),忽略信号的子进程留在原进程组 —— 判「活」必须
  // 看整组而不是 exitCode:liveCommandSession 要找得到它、stop 要能停(第 4 轮审查实锤)。
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
  while (manager.get(daemon.id, "p1")?.exitCode === null || (dchild = readChild(daemon.id, "DCHILD")) === 0) {
    if (Date.now() > daemonReady) throw new Error("daemon leader did not exit in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(manager.get(daemon.id, "p1")?.groupAlive, true, "组长退了但组里还有活人,groupAlive 必须为 true");
  assert.equal(manager.liveCommandSession("p1", "daemon")?.id, daemon.id, "daemonize 会话必须仍算活,否则 stop/restart 找不到它");
  assert.deepEqual(await manager.terminate(daemon.id, "p1", { termMs: 600, killMs: 4000 }), { ok: true });
  await assertProcessGone(dchild, "daemonize 的子进程也必须被停掉");
  assert.equal(manager.liveCommandSession("p1", "daemon"), null);
  assert.equal(manager.get(daemon.id, "p1")?.groupAlive, false);

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
  const churn: ProjectCommandConfig = { id: "churn", name: "churn", command: "sleep 60", restartCommand: null };
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
  // 会话表清零(内存态),旧进程却被 PID 1 收养继续占端口。两种形状都要盖:组长还活着的
  // (orphan2,& wait)和组长已自然退出的(daemon2,exitCode 已落 —— 只筛 exitCode===null
  // 就会跳过它,正是第 4 轮审查的漏杀)。
  const orphan2 = manager.create("p1", cwd, {
    command: { id: "orphan2", name: "orphan2", script: orphanScript.replace("CHILD:", "CHILD2:") },
  });
  const daemon2 = manager.create("p1", cwd, { command: { id: "daemon2", name: "daemon2", script: daemonScript("readyB", "DCHILD2") } });
  let child2 = 0;
  let dchild2 = 0;
  const shutdownReady = Date.now() + 8000;
  while ((child2 = readChild(orphan2.id, "CHILD2")) === 0
    || manager.get(daemon2.id, "p1")?.exitCode === null
    || (dchild2 = readChild(daemon2.id, "DCHILD2")) === 0) {
    if (Date.now() > shutdownReady) throw new Error("shutdown fixtures not ready");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  manager.shutdown();
  await assertProcessGone(child2, "shutdown 必须收掉组长还活着的孤儿");
  await assertProcessGone(dchild2, "shutdown 必须收掉组长已退出的 daemonize 子进程");
  assert.equal(manager.listCommandSessions().length, 0);

  console.log("project commands test passed");
} finally {
  manager.shutdown();
  rmSync(cwd, { recursive: true, force: true });
}
