import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalSessionManager, terminalSessions } from "../src/terminal.js";
import { startCommand, stopCommand, restartCommand } from "../src/terminal-commands.js";
import { TerminalCapacity } from "../src/terminal-capacity.js";
import { processAlive } from "../src/terminal-process-tree.js";

const cwd = mkdtempSync(join(tmpdir(), "ash-stop-verification-"));
const manager = new TerminalSessionManager();
const pids: number[] = [];
const quote = (value: string) => process.platform === "win32" ? `"${value.replaceAll('"', '`"')}"` : `'${value.replaceAll("'", "'\\''")}'`;
const runNode = (...args: string[]) => `${process.platform === "win32" ? "& " : ""}${[process.execPath, ...args].map(quote).join(" ")}`;
const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > deadline) throw Error("stop verification fixture timeout");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
const noop = process.platform === "win32" ? "exit 0" : "true";
const launcher = join(cwd, "launcher.cjs");
const broker = join(cwd, "broker.cjs");
const daemon = join(cwd, "daemon.cjs");
writeFileSync(launcher, `const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(broker)},process.argv[2]],{detached:true,stdio:'ignore'});child.unref();`);
writeFileSync(broker, `const fs=require('node:fs'),prefix=process.argv[2];const timer=setInterval(()=>{if(!fs.existsSync(prefix+'.gate'))return;clearInterval(timer);const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(daemon)},prefix],{detached:true,stdio:'ignore'});child.unref();},20);`);
writeFileSync(daemon, `require('node:fs').writeFileSync(process.argv[2]+'.pid',String(process.pid));setInterval(()=>{},1000);`);

try {
  for (const action of ["stop", "restart"] as const) {
    const projectId = `no-port-${action}`;
    const prefix = join(cwd, action);
    const command = { id: "service", name: action, command: runNode(launcher, prefix), stopCommand: noop, restartCommand: null };
    assert.equal((await startCommand(projectId, cwd, command)).status, 201);
    await waitFor(() => terminalSessions.listForProject(projectId)[0]?.exitCode === 0);
    writeFileSync(prefix + ".gate", "go");
    await waitFor(() => existsSync(prefix + ".pid") && terminalSessions.listForProject(projectId)[0]?.groupAlive === false);
    const pid = Number(readFileSync(prefix + ".pid", "utf8"));
    pids.push(pid);
    const original = terminalSessions.listForProject(projectId)[0];
    assert.deepEqual(original.ports, []);
    const result = action === "stop"
      ? await stopCommand(projectId, "service", { script: noop, cwd })
      : await restartCommand(projectId, cwd, { ...command, restartCommand: "exit 0" });
    // 这个夹具正是必须修 2 的形状:前台启动器退了、中转双 fork 出一个自己 setsid 的守护,
    // 启动进程组随后整组消失。**不许**因此说「停了」—— 而且不能只说一句含糊的「确认不了」:
    // 守护进程的环境里继承着这次启动的记号,所以必须被点名(terminal-launch-survivors.ts)。
    // 重启走的是同一条判定,但多一层后果:旧账上还有确认活着的号,起第二份只会撞上去,
    // 所以那一侧原地落 502 并把同一句话交给用户(terminal-commands.ts 的 restartCommand)。
    assert.equal(result.status, action === "stop" ? 200 : 502);
    assert.equal(processAlive(pid), true);
    const text = String(action === "stop" ? result.body.notice : result.body.error);
    assert.match(text, /按这次启动的记号还点到/);
    assert.ok(text.includes(`pid ${pid}`), "那句话必须给出 pid,用户才有下手的地方");
    if (action === "stop") assert.deepEqual(result.body.unresolved, [pid]);
    const fact = terminalSessions.get(original.id)!.stop;
    assert.equal(fact.kind, "unresolved");
    // 这一档是**反证到手**,不是证据不全:清单齐全(complete),而且号留在账上 ——
    // 它们死了之后下一次停止能把这笔账核销掉。
    assert.ok(fact.kind === "unresolved" && fact.complete && fact.pids.includes(pid));
    terminalSessions.sweepIdleSessions(Date.now() + 31 * 60 * 1000);
    assert.ok(terminalSessions.get(original.id), "名下还有活物的记录不许被闲置回收:那是触达它的唯一把手");
  }

  const history = await manager.createAsync("history", cwd, { command: { id: "job", name: "history", script: "exit 0" } });
  await waitFor(() => manager.get(history.id)?.exitCode === 0);
  manager.markCommandStopped(history.id, "history", { kind: "unresolved", pids: [], complete: false, why: "enumeration incomplete" });
  assert.equal(manager.close(history.id), false);
  assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 0);
  const replacement = await manager.createAsync("history", cwd, { command: { id: "job", name: "new", script: "exit 0" } });
  await waitFor(() => manager.get(replacement.id)?.exitCode === 0);
  assert.ok(manager.get(history.id));
  assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 1);
  assert.ok(manager.get(history.id));
  assert.equal((await manager.destroy(history.id)).ok, true);
  assert.equal(manager.get(history.id), null);

  // 同一条命令只留**最新**那条「没能确认停净」的记录 —— 更早的那些 pids/端口都是空的,
  // 除了那句话之外不提供任何把手,留着只会占地方(第 2 轮审查必须修 1 的另一半)。
  const firstTry = await manager.createAsync("history", cwd, { command: { id: "job2", name: "first", script: "exit 0" } });
  await waitFor(() => manager.get(firstTry.id)?.exitCode === 0);
  manager.markCommandStopped(firstTry.id, "history", { kind: "unresolved", pids: [], complete: false, why: "enumeration incomplete" });
  const secondTry = await manager.createAsync("history", cwd, { command: { id: "job2", name: "second", script: "exit 0" } });
  await waitFor(() => manager.get(secondTry.id)?.exitCode === 0);
  assert.ok(manager.get(firstTry.id), "新会话起来时还不动它:此刻它仍是这条命令唯一的那句话");
  manager.markCommandStopped(secondTry.id, "history", { kind: "unresolved", pids: [], complete: false, why: "enumeration incomplete" });
  assert.equal(manager.get(firstTry.id), null, "有了更新的一条,旧的那条纯历史就该让位");
  assert.ok(manager.get(secondTry.id), "最新那条留着:刷新回来还要看得见「我停过」");

  // 容量账:**纯历史记录(保留 且 不活)整条不进账**,而且 reserve 与 validate 必须同一个
  // 口径 —— 否则 restart 会卡在「旧的已经如期停了、新的起不来」(必须修 1 实测:16 条
  // unresolved 占满全局 16 个槽,启动/重启/新建终端全报上限,闲置回收一条都收不走)。
  const sessions = [{ id: "old", projectId: "capacity", commandId: "job", retained: false, alive: false }];
  const capacity = new TerminalCapacity(1, () => sessions, session => session.alive, session => session.retained);
  const reservation = capacity.reserve("capacity", "job", true);
  capacity.begin(reservation);
  capacity.validate(reservation);
  sessions[0].retained = true;
  capacity.validate(reservation);
  capacity.release(reservation);
  assert.equal(capacity.hasSlot("capacity", "job", true), true, "纯历史记录不占活会话预算");
  capacity.release(capacity.reserve("capacity", "job", true));
  // 反过来一条也不许放过:**名下还有活物的保留记录照旧算占用** —— 那是触达残留进程的唯一
  // 把手,它在消耗真实资源。判据是「保留 且 不活」,不是「保留」。
  sessions[0].alive = true;
  assert.equal(capacity.hasSlot("capacity", "job", true), false, "保留且还活着 = 真占着一个槽");
  assert.throws(() => capacity.reserve("capacity", "job", true), /数量已达上限/);
  console.log("stop verification passed: no-port stop/restart uncertainty, retained history, newest-only history, capacity accounting");
} finally {
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  manager.shutdown();
  terminalSessions.shutdown();
  rmSync(cwd, { recursive: true, force: true });
}
