import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalSessionManager, terminalSessions } from "../src/terminal.js";
import { startCommand, stopCommand, restartCommand } from "../src/terminal-commands.js";
import { launchClosureSealed, portStopVerdict, processStopVerdict } from "../src/terminal-stop-notices.js";
import { launchSurvivors } from "../src/terminal-launch-survivors.js";
import type { TerminalSessionInfo } from "../src/terminal-session-facts.js";
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
// **空环境**那一份:中转用 `env:{}` 把守护进程起出来 —— 同一个用户、PPID=1、自成一组,但
// `ps -E` 一个变量都不打。macOS 分不出「环境本来是空的」和「环境不给看」,早先的判据因此把
// 它当成「别人家的号」跳过,停止报了「已停止」而它还在跑(第 2 轮自由审查 F2 真实复现)。
const envBroker = join(cwd, "env-broker.cjs");
writeFileSync(envBroker, `const fs=require('node:fs'),prefix=process.argv[2];`
  + `const timer=setInterval(()=>{if(!fs.existsSync(prefix+'.gate'))return;clearInterval(timer);`
  + `const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(daemon)},prefix],`
  + `{detached:true,stdio:'ignore',env:{}});child.unref();},20);`);
const envLauncher = join(cwd, "env-launcher.cjs");
writeFileSync(envLauncher, `const child=require('node:child_process').spawn(process.execPath,`
  + `[${JSON.stringify(envBroker)},process.argv[2]],{detached:true,stdio:'ignore'});child.unref();`);
// 带端口的那一份:自己在前台听一个端口并把网址打出来(ash 据此记端口),同时经中转双 fork
// 出一个**不听任何端口**的守护。端口那条道永远点不到它 —— 发现 1 的实测形状。
const portLauncher = join(cwd, "port-launcher.cjs");
writeFileSync(portLauncher, `const fs=require('node:fs'),prefix=process.argv[2];`
  + `const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(broker)},prefix],{detached:true,stdio:'ignore'});child.unref();`
  + `const server=require('node:http').createServer((_,res)=>res.end('ok'));`
  + `server.listen(0,'127.0.0.1',()=>{const port=server.address().port;fs.writeFileSync(prefix+'.port',String(port));`
  + `process.stdout.write('listening on http://127.0.0.1:'+port+' \\n')});`);

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

  {
    // **有端口记录也必须扫记号**。第 1 轮审查发现 1 在真实页面上实测:前台监听者停了、
    // 端口让出来了,界面报「已停止」、停止按钮消失、刷新仍然如此 —— 而那个双 fork 出去、
    // 自成一组、不听任何端口的工人还在跑。端口空只能证明**监听**停了。
    const projectId = "with-port";
    const prefix = join(cwd, "with-port");
    const command = { id: "service", name: "with port", command: runNode(portLauncher, prefix), stopCommand: null, restartCommand: null };
    assert.equal((await startCommand(projectId, cwd, command)).status, 201);
    await waitFor(() => existsSync(prefix + ".port") && terminalSessions.listForProject(projectId)[0]?.ports.length === 1);
    const port = Number(readFileSync(prefix + ".port", "utf8"));
    assert.deepEqual(terminalSessions.listForProject(projectId)[0]?.ports, [port],
      "端口得真被记下来,否则这个用例会退化成无端口那条道");
    writeFileSync(prefix + ".gate", "go");
    await waitFor(() => existsSync(prefix + ".pid"));
    const pid = Number(readFileSync(prefix + ".pid", "utf8"));
    pids.push(pid);
    const original = terminalSessions.listForProject(projectId)[0];
    const result = await stopCommand(projectId, "service", null, { portGraceMs: 50 });
    assert.equal(result.status, 200);
    assert.equal(processAlive(pid), true, "夹具前提:那个工人还活着");
    assert.match(String(result.body.notice), /按这次启动的记号还点到/,
      "端口空了不等于停净 —— 记号点到名的那个必须被报出来");
    assert.ok(String(result.body.notice).includes(`pid ${pid}`));
    assert.deepEqual(result.body.unresolved, [pid]);
    const fact = terminalSessions.get(original.id)!.stop;
    assert.ok(fact.kind === "unresolved" && fact.complete && fact.pids.includes(pid),
      "反证到手:号留在账上,它死了之后下一次停止才核销得掉");
  }

  // 空环境那一位(POSIX 专有:Windows 上记号这一问整档 unavailable,见 LaunchScan 的注释)。
  // 这里钉的是「读不到环境」**不等于**「不是这次启动的」:那个工人跟 ash 同一个用户、出生在
  // 这次启动之后,凭据上就是「可能是这次的」,环境读不出来只说明这一问没答上来。所以停止
  // 这一趟必须如实报未确认 —— 不许因为「记号一个都没命中」就升级成停净。
  if (process.platform !== "win32") {
    const projectId = "silent-env";
    const prefix = join(cwd, "silent-env");
    const command = { id: "service", name: "silent env", command: runNode(envLauncher, prefix), stopCommand: noop, restartCommand: null };
    assert.equal((await startCommand(projectId, cwd, command)).status, 201);
    await waitFor(() => terminalSessions.listForProject(projectId)[0]?.exitCode === 0);
    writeFileSync(prefix + ".gate", "go");
    await waitFor(() => existsSync(prefix + ".pid") && terminalSessions.listForProject(projectId)[0]?.groupAlive === false);
    const pid = Number(readFileSync(prefix + ".pid", "utf8"));
    pids.push(pid);
    const original = terminalSessions.listForProject(projectId)[0];
    assert.deepEqual(original.ports, [], "夹具前提:这条命令一个端口都没打印,只剩记号这一条线索");
    // 扫描这一层先单独问一遍:那个空环境的号必须落进「没问出答案」,而不是被当成陌生人跳过。
    const scan = await launchSurvivors(terminalSessions.launchTokenOf(original.id), original.startedAt);
    assert.equal(scan.evidence, "incomplete", "同用户、这次启动之后出生、环境读不出来 = 这一问没答上来");
    assert.equal(launchClosureSealed(scan), false, "没答上来就不算封口");
    assert.ok(String(scan.why).includes(`pid ${pid}`), `那句话要点出是哪个号（实得：${scan.why}）`);
    const result = await stopCommand(projectId, "service", { script: noop, cwd });
    assert.equal(result.status, 200);
    assert.equal(processAlive(pid), true, "夹具前提:那个工人还活着");
    // 这一档点不到名(记号本来就读不出来),所以它交的是「证据不全」那句固定措辞,而不是
    // 「点到了谁」—— 关键是**不许**沉默地判停净。
    assert.deepEqual(result.body.unresolved, [], "读不出环境只是没答上来,不构成点名");
    assert.match(String(result.body.notice), /没问出答案/);
    assert.match(String(result.body.notice), /所以没法说这次启动起来的东西都停了/);
    assert.ok(String(result.body.notice).includes(`pid ${pid}`), "那句话要点出是哪个号没答上来");
    const fact = terminalSessions.get(original.id)!.stop;
    assert.ok(fact.kind === "unresolved" && !fact.complete,
      "证据不全那一档:刷新回来仍然看得出「这次没能确认停净」,而且这笔账核销不掉");
  }

  // 裁定层本身的不变量(纯函数,直接问):**任何必要证据未知都只能保留未知**。
  {
    const open = { id: "x", projectId: "p", ports: [41234], portsTruncated: false, groupAlive: true } as TerminalSessionInfo;
    const answered = { pids: [], evidence: "answered" as const, why: null };
    const silent = { pids: [], evidence: "incomplete" as const, why: "ps 没答上话" };
    assert.equal(portStopVerdict(open, false, { complete: true, groupGone: true }, answered, [], true).kind, "stopped");
    // ① 端口让出来了,但 ash 这一趟连成员清单都没列全 —— 收掉的只是问出来的那些。
    assert.equal(portStopVerdict(open, false, { complete: false, groupGone: true }, answered, [], true).kind, "unresolved");
    // ② 端口让出来了,但记号那一问没答上话 —— 端口那趟成功证明不了它遗漏的部分。
    assert.equal(portStopVerdict(open, false, { complete: true, groupGone: true }, silent, [], true).kind, "unresolved");
    // ③ 无端口那条道上同一条:`complete === null`(这一趟压根没枚举)不许跟「扫描没答上来」
    //    组成停净的证明。
    assert.equal(processStopVerdict(open, false, { complete: null, groupGone: true }, silent).kind, "unresolved");
    assert.equal(processStopVerdict(open, false, { complete: null, groupGone: true }, answered).kind, "stopped");
    // ④ 记号点到名、同时这一问又没答全:号照旧报出来,但这笔账核销不掉(还可能漏别人)。
    const partial = processStopVerdict(open, false, { complete: true, groupGone: true },
      { pids: [999999], evidence: "incomplete", why: "ps 没答上话" });
    assert.ok(partial.kind === "unresolved" && partial.leftovers.includes(999999) && !partial.complete);
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
  console.log("stop verification passed: no-port stop/restart uncertainty, port-path mark scan, empty-env candidate stays unanswered, unified verdict completeness, retained history, newest-only history, capacity accounting");
} finally {
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  manager.shutdown();
  terminalSessions.shutdown();
  rmSync(cwd, { recursive: true, force: true });
}
