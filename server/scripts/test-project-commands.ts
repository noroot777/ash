// 常用命令回归:命令会话的生命周期(活着豁免闲置回收 / 退出落 exitCode / 退出后回到
// 普通回收轨道)+ parseProjectCommands 的校验。路由层只是这些原语的薄壳,不在这里起 HTTP。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectCommands } from "@ash/shared/project-commands";
import { IS_WINDOWS } from "../src/platform.js";
import { TerminalSessionManager, terminalSessions } from "../src/terminal.js";
import { restartCommand, startCommand, stopCommand, type RunnableCommand } from "../src/terminal-commands.js";

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
  // 会话表清零(内存态),旧进程却被 PID 1 收养继续占端口。两种形状都要盖:组长还活着的
  // (orphan2,& wait)和组长已自然退出、KEEPER wrapper 还守着的(daemon2 —— 它的 dchild2
  // 已脱离 ppid 树,只有 tty 持有者清单能点到名,正是第 4 轮审查的漏杀形状)。
  const orphan2 = manager.create("p1", cwd, {
    command: { id: "orphan2", name: "orphan2", script: orphanScript.replace("CHILD:", "CHILD2:") },
  });
  const daemon2 = manager.create("p1", cwd, { command: { id: "daemon2", name: "daemon2", script: daemonScript("readyB", "DCHILD2") } });
  let child2 = 0;
  let dchild2 = 0;
  const shutdownReady = Date.now() + 8000;
  while ((child2 = readChild(orphan2.id, "CHILD2")) === 0
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
