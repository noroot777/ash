/**
 * 「停止命令留空 = 杀掉启动起来的东西」最后一档的回归:**端口兜底**(server/src/service-ports.ts)。
 *
 * 前三档(ppid 树 / ctty 会话成员 / 累积 pgid)由 test-project-commands.ts 盯着,那套能覆盖
 * `cmd &`、nohup、disown。这里专钉它们都够不着的那一种:**真·守护化** —— 子进程 setsid 自成
 * 会话、父进程随即退出让它挂到 PID 1 名下、stdio 全部重定向。knowledge-base 的 kb.sh 就是这个
 * 形状(用户 2026-10-26 报的「启动了按钮却没变成停止」),ash 按进程归属一个线索都找不到,
 * 只剩服务自己打印的那句 `http://127.0.0.1:<port>`。
 *
 * 下面这些都必须成立 —— 除了 ① 之外,每一条背后都有一次自由审查的实锤:
 *   ① 那句话被记下来、端口还听着就等于「服务开着」(按钮该是停止),点停止真能杀掉它;
 *   ② **端口只是「上哪儿找」,不是「可以杀」** —— 授权靠环境里那枚启动记号(ASH_LAUNCH_ID)。
 *      没记号的住户一根汗毛都不许动,哪怕它就坐在同一个进程组里(E1:pgid 不是血缘证据);
 *   ③ **停止结果必须与终态一致** —— 杀掉了一部分不算停止,脚本 exit 0 也不算停止(E2);
 *   ④⑤ 认端口(含流式切块等价)和探测三态**不需要真进程**,按行数拆去
 *      test-service-ports-scan.ts 了(全局约定:单文件不超过 700 行),断言一字未改;
 *   ⑥ **「端口都让出来了」不等于「这次启动起来的东西都停了」**:同组里核不上归属的号、
 *      以及超过记录额度没能收进来的端口,都要如实留在账上,不许被静默核销(发现 2);
 *   ⑦ 生命周期只有**一个**判据:启动幂等、停止、重启、容量、回收全认它。不打印网址的
 *      守护服务 + 配了停止命令,是「停止接口认为它开着、启动接口认为它没开」的那一刀
 *      (发现 1:实测两个独立 PID 同时活着);
 *   ⑧ 没核销的责任是**单调**的:一次范围更窄的核验(「我记下的这几个端口空了」)不许核销
 *      一笔范围更宽的责任 —— 再点一次停止还得说「没停净」(第 3 轮审查发现 1);
 *   ⑨ 生命周期认的是**归属**而不是「有没有人听」:端口上坐着的核实是别人,这次启动就是
 *      不在了。混成一件,一条只打印了网址的命令会被邻居的服务永久钉在「运行中」,既起不动
 *      也停不掉(发现 3);
 *   ⑩ **关 tab / 删项目 / 关服也要收端口这一档**:会话记录是它唯一的把手(启动记号只活在
 *      记录里),删掉就等于把一个还听着端口的守护进程变成永久孤儿(发现 2)。
 *   ⑪ 而且销毁认的是**完整责任集合**,不是只认端口:账上还有活号时删记录,等于把那笔账
 *      连同唯一的把手一起扔掉 —— 单调性保住了对象、对象却被整个删掉(第 4 轮审查发现 1);
 *   ⑫ **ps 问不出话时不许塌成「端口空了」**:缺那一行有两种成因,「它还活着」只能读成
 *      核不上(第 4 轮审查发现 2 实测:只让 `ps -E` 退非零,服务活着却被报成已停止)。
 *   ⑬ **发现即落账**:这一趟发现的责任不许跟着失败分支一起消失。下一遍监听者已经死了,
 *      同组那个工人再也不会被发现,端口一空就判停净(第 5 轮审查发现 1 实测);
 *   ⑭ **停止命令只收掉监听者也不算停净**:端口空了只说明监听者走了,脚本这条路我们不插手,
 *      所以要拿停止**之前**照的成员相去比(同上)。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { SERVICE_COMMAND_ID } from "@ash/shared/project-commands";
import { IS_WINDOWS } from "../src/platform.js";
import { listeningPids, probeOwnedPorts, probePorts, stopByPorts } from "../src/service-ports.js";
import { HAS_PROC } from "../src/terminal-process-tree.js";
import { terminalSessions } from "../src/terminal.js";
import { TerminalWatcher } from "../src/terminal-session-watch.js";
import { restartCommand, startCommand, stopCommand, type RunnableCommand } from "../src/terminal-commands.js";

if (IS_WINDOWS) {
  // 端口这一档在 Windows 上整档不启用(断言在 test-service-ports-scan.ts),所以下面这些
  // 要真起守护进程的用例在这台机器上没有可验的东西。
  console.log("service ports test passed (windows: 端口兜底不启用)");
  process.exit(0);
}

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ash-ports-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "ash-outside-")));
/** 整场跑完都要确认没留下任何活口。 */
const strays = new Set<number>();

/** 一个只管听端口、把自己 pid 写进文件的小服务。 */
writeFileSync(join(cwd, "serve.js"), `
const http = require("node:http");
const fs = require("node:fs");
const [port, pidfile, worker, workerPort] = process.argv.slice(2);
// worker:再 fork 一个**同进程组**的工人,但用 env -i 洗掉环境 —— 它是记号断掉的那一类
// (service-ports.ts 顶部写明的已知空洞)。回归要钉住:这种成员宁可停不掉,也不许连坐。
// workerPort 给了的话它**自己也听一个端口**:那样回头核端口时它核不上归属,整次停止落在
// 「没法确认」那一档 —— ⑬ 要的就是这个失败分支。
if (worker) {
  const { spawn } = require("node:child_process");
  const body = workerPort
    ? "const h=require('node:http'),f=require('node:fs');const a=process.argv.slice(1);h.createServer((_,r)=>r.end('w')).listen(Number(a[1]),'127.0.0.1',()=>f.writeFileSync(a[0],String(process.pid)));"
    : "fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
  const args = workerPort ? [worker, workerPort] : [worker];
  const child = spawn("/usr/bin/env", ["-i", process.argv[0], "-e", body, ...args], { stdio: "ignore" });
  child.unref();
}
http.createServer((_, res) => res.end("ok")).listen(Number(port), "127.0.0.1", () => {
  fs.writeFileSync(pidfile, String(process.pid));
});
`);

/**
 * 一个什么都不打印、也不听端口的常驻进程:detached + stdio ignore,父进程立刻退出。
 * ash 手里**一条线索都没有** —— 进程归属断了、端口也没有。这一类只能靠「配了停止命令 +
 * 上次正常退出又没被停过」认它还开着(openSession 的第四档)。
 */
writeFileSync(join(cwd, "quiet.js"), `
const { spawn } = require("node:child_process");
const [pidfile] = process.argv.slice(2);
const child = spawn(process.argv[0], [
  "-e",
  "const fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",
  pidfile,
], { detached: true, stdio: "ignore" });
child.unref();
`);

/** 没人用的端口:先听一下再让开,拿到号码。 */
async function freePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(label: string, check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`等不到:${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidIn = (file: string) => Number(readFileSync(file, "utf8").trim());
const listening = async (port: number) => {
  const found = await listeningPids(port);
  return found.ok ? found.pids : [];
};
/**
 * 账上还活着的号。**返回 null 表示这笔账根本不是 unresolved** —— 跟「号都退了、但那句
 * 「没能确认停净」还得留着」是两回事(第 3 轮审查发现 1:空列表以前被读成「干净」)。
 */
const leftoversOf = (projectId: string): number[] | null => {
  const stop = serviceSession(projectId)?.stop;
  return stop && stop.kind === "unresolved" ? stop.pids : null;
};

const serviceSession = (projectId: string) => terminalSessions.listCommandSessions()
  .filter((session) => session.projectId === projectId && session.commandId === SERVICE_COMMAND_ID)
  .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;

/**
 * 一条守护化的启动脚本:双 fork(detached = setsid)+ stdio 全丢掉,父进程立刻退出,
 * 服务挂到 PID 1 名下 —— 与 kb.sh 的 daemonize() 同形。最后自报端口,那是唯一的线索。
 */
function daemonScript(port: number, pidfile: string, extra: string[] = [], worker?: string, workerPort?: number): string {
  const tail = worker ? [worker, ...(workerPort ? [String(workerPort)] : [])] : [];
  const args = ["serve.js", String(port), pidfile, ...tail].map((arg) => `"${arg}"`).join(",");
  return [
    `node -e 'const {spawn}=require("node:child_process");`
    + `const c=spawn(process.argv[1],[${args}],{detached:true,stdio:"ignore"});c.unref();'`
    + ` ${process.execPath}`,
    ...extra,
    `echo "[svc] 已启动 http://127.0.0.1:${port}"`,
  ].join("\n");
}

const service = (command: string, stopScript: string | null = null): RunnableCommand =>
  ({ id: SERVICE_COMMAND_ID, name: "服务", command, restartCommand: null, stopCommand: stopScript });

try {
  // ── ① 守护化的服务:启动脚本退了,端口还听着 = 开着,而且真能停掉 ───────────────
  const port = await freePort();
  const pidfile = join(cwd, "service.pid");
  const workerPidfile = join(cwd, "worker.pid");
  assert.equal((await startCommand("ports1", cwd, service(daemonScript(port, pidfile, [], workerPidfile)))).status, 201);
  await waitFor("启动脚本自己退出(守护化形状)", () => serviceSession("ports1")?.exitCode !== null);
  await waitFor("服务真的听上了端口", async () => (await listening(port)).length > 0);
  const servicePid = pidIn(pidfile);
  strays.add(servicePid);
  assert.ok(servicePid > 0 && alive(servicePid), "守护进程应当活着");
  await waitFor("洗掉环境的那个工人也起来了", () => { try { return pidIn(workerPidfile) > 0; } catch { return false; } });
  const washedPid = pidIn(workerPidfile);
  strays.add(washedPid);

  const session = serviceSession("ports1")!;
  assert.deepEqual(session.ports, [port], "启动脚本打印的端口要被记下来");
  assert.equal(session.groupAlive, false, "进程归属那条线索确实断了 —— 这正是本回归要盯的形状");
  await waitFor("端口探测那一拍把 portsAlive 翻成 true", () => serviceSession("ports1")?.portsAlive === true);

  const stopped = await stopCommand("ports1", SERVICE_COMMAND_ID, null, { portGraceMs: 500 });
  assert.equal(stopped.status, 200);
  await waitFor("守护进程被杀掉", () => !alive(servicePid));
  assert.equal(await probePorts([port]), "free", "端口要真的让出来");
  assert.equal(serviceSession("ports1")?.portsAlive, false, "核实过端口空了,运行事实要同步落回去");
  assert.equal(serviceSession("ports1")?.stoppedByUser, true, "「我点过停止」要留下来,刷新后还看得见");
  // ② 同组但记号被洗掉的那个工人:**不许连坐**。进程组只是调度单位,不是血缘证据。
  assert.ok(alive(washedPid), "env -i 洗掉记号的同组成员核不上归属,宁可停不掉也不能杀");
  // ⑥ 不许连坐的**另一半**:它既然还活着,就不能被静默核销。早先 filter 一丢,
  //    「这几个端口让出来了」当场升级成「这次启动起来的东西都停了」(第 2 轮审查发现 2)。
  const washedBody = stopped.body as { stopped: boolean; unresolved?: number[]; notice?: string };
  assert.equal(washedBody.stopped, true, "端口确实让出来了,这不是失败");
  assert.deepEqual(washedBody.unresolved, [washedPid], "核不上归属、没敢杀的号要留在账上");
  assert.match(washedBody.notice ?? "", /还活着/, "必须有一句给用户看的交代");
  assert.match(washedBody.notice ?? "", /停止命令/, "并且给出路");
  assert.deepEqual(leftoversOf("ports1"), [washedPid], "刷新回来还看得见它没停净");
  // ⑧ 账是**单调**的:再点一次停止,这一次只核了端口(范围更窄),核销不了上一次留下的
  //    责任。早先 markCommandStopped 是整条覆盖写,于是第二次停止一句「干净」把它抹平 ——
  //    用户点两下就能让「还没停完」消失,而那个号还在跑(第 3 轮审查发现 1)。
  const twice = await stopCommand("ports1", SERVICE_COMMAND_ID, null, { portGraceMs: 300 });
  assert.equal(twice.status, 200);
  const twiceBody = twice.body as { stopped: boolean; unresolved?: number[]; notice?: string };
  assert.deepEqual(twiceBody.unresolved, [washedPid], "第二次停止不许拿「端口空了」核销掉上一次的责任");
  assert.match(twiceBody.notice ?? "", /还活着/, "还得再说一次没停净");
  assert.deepEqual(leftoversOf("ports1"), [washedPid], "账还在");
  process.kill(washedPid, "SIGKILL");
  await waitFor("它走了之后,活号跟着销", () => (leftoversOf("ports1")?.length ?? 1) === 0);
  assert.deepEqual(leftoversOf("ports1"), [], "号退完了,但「这次停止没能核验干净」这件事不许跟着消失");
  assert.equal(serviceSession("ports1")?.portsAlive, false);
  assert.equal(
    ((await stopCommand("ports1", SERVICE_COMMAND_ID, null, { portGraceMs: 300 })).body as { stopped: boolean }).stopped,
    false,
    "一个活号都没有了,这笔核销不掉的账不该再把停止按钮钉在那儿",
  );
  strays.delete(washedPid);
  strays.delete(servicePid);

  // ── ② 身份闸:端口上坐着的不是这次起来的,一根汗毛都不许动,并且不许谎报已停止 ────
  const strayPort = await freePort();
  const strayPidfile = join(outside, "stray.pid");
  // 这个服务由**测试进程**起(它的环境里没有 ASH_LAUNCH_ID),模拟「端口被别人占着」。
  spawn(process.execPath, [join(cwd, "serve.js"), String(strayPort), strayPidfile], {
    cwd: outside, detached: true, stdio: "ignore",
  }).unref();
  await waitFor("旁人把端口占上", async () => (await listening(strayPort)).length > 0);
  const strayPid = pidIn(strayPidfile);
  strays.add(strayPid);

  // 直接问 stopByPorts:记号核不上就只能进 spared,并且说清为什么。
  const spared = await stopByPorts([strayPort], { launchToken: "a-token-nobody-has", graceMs: 300 });
  assert.deepEqual(spared.killed, [], "记号对不上的住户不许杀");
  assert.deepEqual(spared.unknown, []);
  assert.equal(spared.spared.length, 1);
  assert.equal(spared.spared[0].holder.pid, strayPid);
  assert.match(spared.spared[0].reason, /没有这次启动的记号/);
  assert.ok(alive(strayPid), "它必须还好好活着");
  // 「工作目录在项目里 + 比这次启动晚」这组旧判据对它全部成立 —— 旧实现正是据此误杀
  // (E1)。换成环境记号之后,它不再有任何授权作用。
  assert.equal(
    (await stopByPorts([strayPort], { launchToken: "", graceMs: 300 })).killed.length, 0,
    "连记号都没有的那次启动(ash 重启前起的)更不该拿到授权",
  );
  assert.ok(alive(strayPid));

  // ── ③ 部分停止 ≠ 停止:一次启动打印了两个端口,**两份都得收掉**才叫停了 ────────────
  //    E2 原来的反面现场是「第二个端口上坐着旁人」,那一版要求报 502。F3 推翻了这个读法:
  //    旁人核实了不是这次起来的,这次启动在端口这条线索上就是不在了 —— 继续报 502 等于拿
  //    一个一个字都不许动的进程把这条命令永久钉死(第 3 轮审查发现 3,那一幕现在是 ⑨)。
  //    E2 真正要钉的是**「判成功的依据是终态,不是我杀掉了几个」**,所以现场换成两份都是
  //    自己的:只收第一个就报成功的实现会在这里被抓住 —— 第二份还是 ours,核验当场 502,
  //    而且那个 pid 还活着。
  const minePort = await freePort();
  const mine2Port = await freePort();
  const minePidfile = join(cwd, "mine.pid");
  const mine2Pidfile = join(cwd, "mine2.pid");
  assert.equal(
    (await startCommand("ports2", cwd, service(
      `${daemonScript(minePort, minePidfile)}\n${daemonScript(mine2Port, mine2Pidfile)}`,
    ))).status,
    201,
  );
  await waitFor("两个端口都记上了", () => (serviceSession("ports2")?.ports.length ?? 0) === 2);
  await waitFor("两份都听上了", async () =>
    (await listening(minePort)).length > 0 && (await listening(mine2Port)).length > 0);
  const minePid = pidIn(minePidfile);
  const mine2Pid = pidIn(mine2Pidfile);
  strays.add(minePid);
  strays.add(mine2Pid);
  await waitFor("启动脚本退出", () => serviceSession("ports2")?.exitCode !== null);
  await waitFor("它认为服务开着", () => serviceSession("ports2")?.portsAlive === true);

  const both = await stopCommand("ports2", SERVICE_COMMAND_ID, null, { portGraceMs: 500 });
  assert.equal(both.status, 200, `两个端口上坐的都是这次起来的,全收掉才算停了:${JSON.stringify(both.body)}`);
  await waitFor("第一份收掉了", () => !alive(minePid));
  await waitFor("第二份也收掉了 —— 只腾空一个就报成功,正是 E2 那条", () => !alive(mine2Pid));
  strays.delete(minePid);
  strays.delete(mine2Pid);
  assert.equal(await probePorts([minePort, mine2Port]), "free", "两个端口都要真的让出来");
  assert.equal(serviceSession("ports2")?.stoppedByUser, true);
  assert.ok(alive(strayPid), "别人的进程一根汗毛都不许动");

  // ── ③ 停止脚本 exit 0 也不算停止:终态说话 ─────────────────────────────────────
  const scriptPort = await freePort();
  const scriptPidfile = join(cwd, "script.pid");
  // `true` 返回零但什么都不做 —— 旧实现据此报「已停止」、按钮消失,服务还在听。
  assert.equal((await startCommand("ports3", cwd, service(daemonScript(scriptPort, scriptPidfile), "true"))).status, 201);
  await waitFor("服务听上了端口", async () => (await listening(scriptPort)).length > 0);
  const scriptPid = pidIn(scriptPidfile);
  strays.add(scriptPid);
  await waitFor("启动脚本退出", () => serviceSession("ports3")?.exitCode !== null);
  await waitFor("它认为服务开着", () => serviceSession("ports3")?.portsAlive === true);
  const lied = await stopCommand("ports3", SERVICE_COMMAND_ID, { script: "true", cwd, timeoutMs: 5_000 }, { portGraceMs: 300 });
  assert.equal(lied.status, 502, "脚本说自己成功了,端口说服务还在 —— 听终态的");
  assert.match((lied.body as { error: string }).error, /服务没停下来/);
  // 没停成功的那一路**什么都不许落账**:标了「已停止」刷新回来按钮就退回 ▶、服务还在跑;
  // 把 portsAlive 抹掉同样是谎报(这两条原先挂在 ③ 的旁人现场上,那一幕已按 F3 改掉)。
  assert.notEqual(serviceSession("ports3")?.stoppedByUser, true);
  assert.equal(serviceSession("ports3")?.portsAlive, true, "更不许把还在运行的事实抹掉");
  assert.ok(alive(scriptPid), "ash 不替用户强杀:他写那段脚本正是不想让 ash 直接 kill");

  // 换一条真能停的脚本,这时才允许报成功 —— 顺手把现场清掉。
  // 真正的停止脚本会**等它走掉**才返回 —— `kill` 只是把信号递出去,端口未必立刻让开。
  const realStop = `kill ${scriptPid}\nwhile kill -0 ${scriptPid} 2>/dev/null; do sleep 0.1; done`;
  const honest = await stopCommand("ports3", SERVICE_COMMAND_ID, { script: realStop, cwd, timeoutMs: 15_000 }, { portGraceMs: 500 });
  assert.equal(honest.status, 200, "脚本真把端口腾出来了,这才叫停止");
  assert.equal(serviceSession("ports3")?.stoppedByUser, true);
  await waitFor("它真的走了", () => !alive(scriptPid));
  strays.delete(scriptPid);

  // ── ⑥ 这套存活判据要**贯穿生命周期**:启动幂等、闲置回收、重启都认同一件事 ──────
  //    报告发现 3:停止接口和弹层头部认它开着,启动幂等却只认进程组存活 —— 于是同一个
  //    服务被起第二份,两个实例抢一个端口。而且端口不是 service 那一行的特权:普通常用
  //    命令照样会守护化。
  const livePort = await freePort();
  const livePidfile = join(cwd, "live.pid");
  const worker: RunnableCommand = {
    id: "worker", name: "工人", command: daemonScript(livePort, livePidfile), restartCommand: null, stopCommand: null,
  };
  const workerSession = () => terminalSessions.listCommandSessions()
    .filter((session) => session.projectId === "ports4" && session.commandId === "worker")
    .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  assert.equal((await startCommand("ports4", cwd, worker)).status, 201);
  await waitFor("工人守护起来了", async () => (await listening(livePort)).length > 0);
  const livePid = pidIn(livePidfile);
  strays.add(livePid);
  await waitFor("启动脚本退出", () => workerSession()?.exitCode !== null);
  await waitFor("端口那一拍认出它还在跑", () => workerSession()?.portsAlive === true);

  // 闲置回收:半小时没人看的退出记录本该被收掉,但它名下还有东西在跑 —— 收了就再没人
  // 能停那个守护进程了(sessionRunning 把这一档拦住)。
  const kept = workerSession()!.id;
  terminalSessions.sweepIdleSessions(Date.now() + 31 * 60 * 1000);
  assert.equal(workerSession()?.id, kept, "端口还有人听的会话不许被闲置回收顺手收掉");

  // 启动幂等:再点一次启动,拿回同一条会话,而不是起第二份。
  const again = await startCommand("ports4", cwd, worker);
  assert.equal(again.status, 200, "按进程组判会得出「没在跑」,于是起第二份去抢同一个端口");
  assert.equal((again.body as { alreadyRunning?: boolean }).alreadyRunning, true);
  assert.equal((again.body as { session: { id: string } }).session.id, kept);
  assert.equal(pidIn(livePidfile), livePid, "没有第二个守护进程被起来");

  // 重启:现场必须在**动手之前**取。旧守护进程不先收掉,新的一起来就撞上被占的端口 ——
  // 那种失败看起来像「重启按钮坏了」。
  const restarted = await restartCommand("ports4", cwd, worker);
  assert.equal(restarted.status, 201, `重启应当成功,实际 ${JSON.stringify(restarted.body)}`);
  await waitFor("旧的守护进程被收掉了", () => !alive(livePid));
  strays.delete(livePid);
  await waitFor("新的守护进程接上了同一个端口", () => { const pid = pidIn(livePidfile); return pid !== livePid && alive(pid); });
  const freshPid = pidIn(livePidfile);
  strays.add(freshPid);
  assert.equal((await listening(livePort))[0], freshPid, "端口上坐着的应当是新起的那一份");

  const cleaned = await stopCommand("ports4", "worker", null, { portGraceMs: 500 });
  assert.equal(cleaned.status, 200);
  await waitFor("收尾:新的那份也停掉", () => !alive(freshPid));
  strays.delete(freshPid);

  // ── ⑥ 线索不全也不许核销:打印的端口超过记录额度,剩下的压根没进账 ───────────────
  const truncPort = await freePort();
  const truncPidfile = join(cwd, "trunc.pid");
  const spare = new Set<number>();
  while (spare.size < 8) { const extra = await freePort(); if (extra !== truncPort) spare.add(extra); }
  const truncScript = [
    daemonScript(truncPort, truncPidfile),
    ...[...spare].map((one) => `echo "[svc] 另一个入口 http://127.0.0.1:${one}"`),
  ].join("\n");
  assert.equal((await startCommand("ports6", cwd, service(truncScript))).status, 201);
  await waitFor("服务听上了它那个端口", async () => (await listening(truncPort)).length > 0);
  const truncPid = pidIn(truncPidfile);
  strays.add(truncPid);
  await waitFor("启动脚本退出", () => serviceSession("ports6")?.exitCode !== null);
  const truncated = serviceSession("ports6")!;
  assert.equal(truncated.ports.length, 8, "记录额度就是 8 个 —— 一条疯狂刷端口的输出不该吃光预算");
  assert.equal(truncated.portsTruncated, true, "超额丢掉的是「没收进来的线索」,不是「不存在的线索」");
  await waitFor("它认为服务开着", () => serviceSession("ports6")?.portsAlive === true);

  const partialEvidence = await stopCommand("ports6", SERVICE_COMMAND_ID, null, { portGraceMs: 500 });
  assert.equal(partialEvidence.status, 200, "记下的端口确实都让出来了");
  const evidenceBody = partialEvidence.body as { unresolved?: number[]; notice?: string };
  await waitFor("它那份该杀的照样杀掉了", () => !alive(truncPid));
  strays.delete(truncPid);
  assert.deepEqual(evidenceBody.unresolved, [], "没有具体的号可报 —— 缺的是线索,不是归属");
  assert.deepEqual(leftoversOf("ports6"), [], "但这笔账必须落下来:空列表不是「干净」,是「连该问谁都没问全」");
  assert.match(
    evidenceBody.notice ?? "", /多出来的没能记下来/,
    "记下的端口都空了也证明不到「全停了」:只听没记下那些端口的守护进程压根没被问过",
  );

  // ── ⑦ 唯一判据:ash 手里一条线索都没有时,靠「配了停止命令」认它还开着 ────────────
  //    第 2 轮审查发现 1 的实测反例:不打印网址的守护服务 + 配了停止命令 —— 停止接口和
  //    界面都认它开着,启动接口另问一个只认缓存的同义函数,认它没开,于是起了第二份。
  const quietPidfile = join(cwd, "quiet.pid");
  const quietStop = `kill "$(cat ${quietPidfile})"\n`
    + `while kill -0 "$(cat ${quietPidfile})" 2>/dev/null; do sleep 0.1; done`;
  const quiet = service(`${process.execPath} quiet.js "${quietPidfile}"`, quietStop);
  assert.equal((await startCommand("ports7", cwd, quiet)).status, 201);
  await waitFor("常驻进程起来了", () => { try { return alive(pidIn(quietPidfile)); } catch { return false; } });
  const quietPid = pidIn(quietPidfile);
  strays.add(quietPid);
  await waitFor("启动脚本自己退出", () => serviceSession("ports7")?.exitCode !== null);
  const quietSession = serviceSession("ports7")!;
  assert.deepEqual(quietSession.ports, [], "它什么都没打印 —— 端口这条线索也没有");
  assert.equal(quietSession.groupAlive, false, "进程归属那条线索断了");
  // 多等一拍再点:排除「只差第一拍端口扫描」这种解释,反例必须是判据本身的问题。
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  const second = await startCommand("ports7", cwd, quiet);
  assert.equal(second.status, 200, `再点启动必须拿回同一条会话,实际 ${JSON.stringify(second.body)}`);
  assert.equal((second.body as { alreadyRunning?: boolean }).alreadyRunning, true);
  assert.equal((second.body as { session: { id: string } }).session.id, quietSession.id);
  assert.equal(pidIn(quietPidfile), quietPid, "没有第二份被起来");
  const quietStopped = await stopCommand("ports7", SERVICE_COMMAND_ID, { script: quietStop, cwd, timeoutMs: 15_000 });
  assert.equal(quietStopped.status, 200);
  await waitFor("停止脚本把它收掉了", () => !alive(quietPid));
  strays.delete(quietPid);
  assert.equal(serviceSession("ports7")?.stoppedByUser, true, "停过的事实要留下");
  assert.equal(
    (await startCommand("ports7", cwd, quiet)).status, 201,
    "停过之后再点启动,该起新的那一份(第四档认的是「没被停过」)",
  );
  await waitFor("新的那份起来了", () => { const pid = pidIn(quietPidfile); return pid !== quietPid && alive(pid); });
  const quietFresh = pidIn(quietPidfile);
  strays.add(quietFresh);
  await stopCommand("ports7", SERVICE_COMMAND_ID, { script: quietStop, cwd, timeoutMs: 15_000 });
  await waitFor("收尾:新的那份也停掉", () => !alive(quietFresh));
  strays.delete(quietFresh);

  // ── ⑨ 认归属,不认「有没有人听」:端口上坐着的核实是别人,这次启动就是不在了 ────────
  //    发现 3 的实测形状:一条命令只打印了一行网址(`echo http://127.0.0.1:<port>`),而那个
  //    端口上恰好坐着别人的服务。把「有人听」读成「我还在跑」,这条命令就被钉死 —— 启动按钮
  //    不给起(幂等门认它开着),停止按钮也停不掉(那个监听者核不上归属,一个字都不许动)。
  const echoOnly = service(`echo "[svc] 外面那个 http://127.0.0.1:${strayPort}"`);
  assert.equal((await startCommand("ports9", cwd, echoOnly)).status, 201);
  await waitFor("它打印完就退了", () => serviceSession("ports9")?.exitCode === 0);
  assert.deepEqual(serviceSession("ports9")?.ports, [strayPort], "那行网址照旧被记下来 —— 线索该记,结论另算");
  assert.ok(alive(strayPid), "端口上坐着的是别人的服务");
  // 多等两拍:让观测层真的问过一遍,排除「只差第一拍扫描」这种解释。
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  assert.equal(serviceSession("ports9")?.portsAlive, false, "别人的监听不是「这次启动还在跑」");
  const strangerStop = await stopCommand("ports9", SERVICE_COMMAND_ID, null, { portGraceMs: 300 });
  assert.equal(strangerStop.status, 200, `不该 502 把这条命令永久卡住,实际 ${JSON.stringify(strangerStop.body)}`);
  assert.equal((strangerStop.body as { stopped: boolean }).stopped, false, "压根没有东西可停");
  assert.ok(alive(strayPid), "别人的进程一根汗毛都不许动");
  const echoAgain = await startCommand("ports9", cwd, echoOnly);
  assert.equal(echoAgain.status, 201, "它从没被认成在跑,再点启动就该真起一次");
  assert.notEqual((echoAgain.body as { alreadyRunning?: boolean }).alreadyRunning, true);
  await waitFor("第二次也退了", () => serviceSession("ports9")?.exitCode === 0);

  // ── ⑩ 关 tab / 关服也要收端口这一档 ───────────────────────────────────────────
  //    会话记录是端口这一档唯一的把手:这次启动的记号只活在记录里,记录一删,守护进程既
  //    核不上归属、也没人再去问它那个端口 —— 于是它成了永久孤儿(发现 2)。
  const closePort = await freePort();
  const closePidfile = join(cwd, "close.pid");
  assert.equal((await startCommand("ports10", cwd, service(daemonScript(closePort, closePidfile)))).status, 201);
  await waitFor("守护进程听上了端口", async () => (await listening(closePort)).length > 0);
  const closePid = pidIn(closePidfile);
  strays.add(closePid);
  await waitFor("启动脚本退出", () => serviceSession("ports10")?.exitCode !== null);
  const closeId = serviceSession("ports10")!.id;
  const destroyed = await terminalSessions.destroy(closeId, "ports10");
  assert.equal(destroyed.ok, true, `关 tab 应当成功,实际 ${JSON.stringify(destroyed)}`);
  await waitFor("删记录之前它被收掉了", () => !alive(closePid));
  assert.equal(await probePorts([closePort]), "free", "端口要真的让出来");
  assert.equal(serviceSession("ports10"), null, "收干净了才允许把记录删掉");
  strays.delete(closePid);

  // ── ⑧ 代次闸:飞行中的端口探测不许覆盖「刚刚核验过的停止」 ──────────────────────
  {
    const guardPort = await freePort();
    const guardPidfile = join(cwd, "guard.pid");
    const guardToken = "watch-token-0123456789";
    // 监听者必须是**带着记号的真进程**:观测层问的是归属,不是「有没有人听」。(ash 自己
    // 持的监听一律不算 —— probeOwnedPorts 把 process.pid 过滤掉,所以这里不能用同进程的
    // net.createServer 顶替。)
    const guard = spawn(process.execPath, [join(cwd, "serve.js"), String(guardPort), guardPidfile], {
      cwd, detached: true, stdio: "ignore", env: { ...process.env, ASH_LAUNCH_ID: guardToken },
    });
    guard.unref();
    await waitFor("带记号的监听者起来了", async () => (await listening(guardPort)).length > 0);
    const guardPid = pidIn(guardPidfile);
    strays.add(guardPid);
    const watched = {
      process: { pid: process.pid },
      commandId: "guard",
      descendantPgids: new Set<number>(),
      launchPorts: new Set([guardPort]),
      launchToken: guardToken,
      exitCode: 0,
      portsAlive: false,
      factsGeneration: 0,
    };
    const watcher = new TerminalWatcher(() => [watched], { scanMs: 10 * 60_000 });
    try {
      const inFlight = watcher.scanPorts();
      // 探测还在飞,停止路径这会儿核验完并推进了代次(markCommandStopped 做的事)。
      watched.factsGeneration = 1;
      await inFlight;
      assert.equal(watched.portsAlive, false, "取样早于这次停止的那一拍必须丢掉 —— 否则「我点过停止」当场被覆盖");
      // 代次没变的那一拍照常写回,否则守护化的服务永远认不出来。
      await watcher.scanPorts();
      assert.equal(watched.portsAlive, true, "没有并发停止时,带记号的监听者就该如实翻成 true");
      // ⑨ 的观测层那一半:同一个端口换成**核实不是这次起来的**住户,不许写成「我还在跑」。
      const stranger = { ...watched, launchToken: "another-launch-entirely", factsGeneration: 0, portsAlive: false };
      const strangerWatcher = new TerminalWatcher(() => [stranger], { scanMs: 10 * 60_000 });
      try {
        await strangerWatcher.scanPorts();
        assert.equal(stranger.portsAlive, false, "端口上坐着的核实是别人,这次启动就是不在了");
      } finally { strangerWatcher.stop(); }
    } finally {
      watcher.stop();
      process.kill(guardPid, "SIGKILL");
      strays.delete(guardPid);
    }
  }

  // ── ⑪ 销毁认的是**完整责任集合**,不是只认端口 ─────────────────────────────────
  //    第 4 轮审查发现 1 的实测路径:默认停止已经如实报了「还剩一个核不上归属的号」,紧接着
  //    关 tab / 删项目返回 ok、记录清空,那个号还在跑。账本的单调性保住了对象,对象却被整个
  //    删掉 —— 记号、端口、这笔账一起没了,它从此既核不上归属也没人去问,成了永久孤儿。
  const owedPort = await freePort();
  const owedPidfile = join(cwd, "owed.pid");
  const owedWorkerPidfile = join(cwd, "owed-worker.pid");
  assert.equal(
    (await startCommand("ports12", cwd, service(daemonScript(owedPort, owedPidfile, [], owedWorkerPidfile)))).status,
    201,
  );
  await waitFor("守护进程听上了端口", async () => (await listening(owedPort)).length > 0);
  const owedPid = pidIn(owedPidfile);
  strays.add(owedPid);
  await waitFor("洗掉环境的工人也起来了", () => { try { return pidIn(owedWorkerPidfile) > 0; } catch { return false; } });
  const owedWorker = pidIn(owedWorkerPidfile);
  strays.add(owedWorker);
  await waitFor("启动脚本退出", () => serviceSession("ports12")?.exitCode !== null);
  assert.equal((await stopCommand("ports12", SERVICE_COMMAND_ID, null, { portGraceMs: 500 })).status, 200);
  await waitFor("监听者被收掉", () => !alive(owedPid));
  assert.deepEqual(leftoversOf("ports12"), [owedWorker], "核不上归属、没敢动的号要留在账上");
  const owedId = serviceSession("ports12")!.id;
  const refused = await terminalSessions.destroy(owedId, "ports12");
  assert.equal(refused.ok, false, "账上还有活号,不许删掉它唯一的把手");
  assert.match((refused as { ok: false; reason: string }).reason, new RegExp(String(owedWorker)), "要指名道姓说是哪个号");
  assert.ok(serviceSession("ports12"), "拒绝删除就得把记录留下,否则提示和停止入口一起消失");
  assert.deepEqual(leftoversOf("ports12"), [owedWorker], "这笔账也要原样留着");
  assert.ok(alive(owedWorker), "更不许为了能把记录删掉就去杀一个核不上归属的进程");
  process.kill(owedWorker, "SIGKILL");
  await waitFor("它自己走了", () => !alive(owedWorker));
  const owedAfter = await terminalSessions.destroy(owedId, "ports12");
  assert.equal(owedAfter.ok, true, `责任清完了就该放行,实际 ${JSON.stringify(owedAfter)}`);
  assert.equal(serviceSession("ports12"), null, "放行之后记录才允许消失");
  strays.delete(owedPid);
  strays.delete(owedWorker);

  // ── ⑫ ps 问不出话 ≠ 端口空了 ───────────────────────────────────────────────────
  //    lsof 那边的三态早就钉住了,归属这边还留着同一个坑:`ps -E` 没打出某个号的那一行,
  //    被当成「它已经退了」,于是整张归属表是空的、probeOwnedPorts 答 free、默认停止对着
  //    一个还在听端口的服务返回「已停止」并落 verified(第 4 轮审查发现 2 实测)。
  //    Linux 不走这条路:/proc 是权威档,ENOENT 与 EACCES 本来就分得开,所以只在没有
  //    /proc 的平台(macOS/BSD)上注入故障。
  if (!HAS_PROC && existsSync("/bin/ps")) {
    const failPort = await freePort();
    const failPidfile = join(cwd, "psfail.pid");
    const failToken = "ps-failure-token-0123456789";
    const failing = spawn(process.execPath, [join(cwd, "serve.js"), String(failPort), failPidfile], {
      cwd, detached: true, stdio: "ignore", env: { ...process.env, ASH_LAUNCH_ID: failToken },
    });
    failing.unref();
    await waitFor("带记号的监听者起来了", async () => (await listening(failPort)).length > 0);
    const failPid = pidIn(failPidfile);
    strays.add(failPid);
    // 对照组:ps 正常时答案必须是 ours,否则下面那半个断言什么都没证明。
    const healthy = await probeOwnedPorts([failPort], failToken);
    assert.equal(healthy.state, "ours", `对照组应当核得上归属,实际 ${JSON.stringify(healthy)}`);

    // 故障注入:只让 `ps -E` 退非零(stdout 一个字都没有),其余参数原样透传给真 ps。
    const fakeDir = mkdtempSync(join(cwd, "psfail-"));
    writeFileSync(join(fakeDir, "ps"), [
      "#!/bin/sh",
      'for arg in "$@"; do',
      '  if [ "$arg" = "-E" ]; then echo "ps: fault injected" >&2; exit 1; fi',
      "done",
      'exec /bin/ps "$@"',
    ].join("\n"), { mode: 0o755 });
    const tsx = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");
    const probeChild = spawn(existsSync(tsx) ? tsx : "tsx", [
      join(import.meta.dirname, "ps-failure-probe.ts"), String(failPort), failToken,
    ], { env: { ...process.env, PATH: `${fakeDir}${delimiter}${process.env.PATH ?? ""}` }, stdio: ["ignore", "pipe", "pipe"] });
    let childOut = "";
    probeChild.stdout.on("data", (chunk) => { childOut += String(chunk); });
    probeChild.stderr.on("data", (chunk) => { childOut += String(chunk); });
    const childCode = await new Promise<number>((resolve) => probeChild.on("close", (code) => resolve(code ?? 1)));
    assert.equal(childCode, 0, `ps 失灵时归属探测塌成了别的答案:\n${childOut}`);
    assert.match(childOut, /PS_FAILURE_PROBE_OK/);
    assert.ok(alive(failPid), "服务全程都活着 —— 这正是「被报成已停止」时的真实状态");
    process.kill(failPid, "SIGKILL");
    strays.delete(failPid);
  }

  // ── ⑬ 发现即落账:责任不许跟着失败分支一起消失 ──────────────────────────────────
  //    现场:守护进程听 A,它 fork 的、env -i 洗掉环境的工人听 B,两个端口都被打印出来。点停止
  //    → A 的监听者(带记号)被收掉、同组那个工人被发现但一个字都不敢动;回头核端口时 B 上还
  //    坐着它、核不上归属 ⇒ 报失败。失败分支早先直接 return,这一趟的发现原地丢掉:下一遍
  //    监听者已经死了,工人再也不会被枚举到,端口一空就判 verified(发现 1 实测)。
  const pairPort = await freePort();
  const pairWorkerPort = await freePort();
  const pairPidfile = join(cwd, "pair.pid");
  const pairWorkerPidfile = join(cwd, "pair-worker.pid");
  {
    const hint = [`echo "[svc] 工人在 http://127.0.0.1:${pairWorkerPort}"`];
    const start = daemonScript(pairPort, pairPidfile, hint, pairWorkerPidfile, pairWorkerPort);
    assert.equal((await startCommand("ports13", cwd, service(start))).status, 201);
    await waitFor("两个端口都听上了", async () =>
      (await listening(pairPort)).length > 0 && (await listening(pairWorkerPort)).length > 0);
    const pairPid = pidIn(pairPidfile);
    const pairWorker = pidIn(pairWorkerPidfile);
    strays.add(pairPid);
    strays.add(pairWorker);
    await waitFor("启动脚本退出", () => serviceSession("ports13")?.exitCode !== null);
    // 记录顺序跟的是**打印顺序**(工人那句 echo 排在「已启动」之前),所以这里只核集合。
    assert.deepEqual(
      [...(serviceSession("ports13")?.ports ?? [])].sort((a, b) => a - b),
      [pairPort, pairWorkerPort].sort((a, b) => a - b),
      "两个端口都要记下来",
    );

    const failed = await stopCommand("ports13", SERVICE_COMMAND_ID, null, { portGraceMs: 500 });
    assert.equal(failed.status, 502, "工人占着的那个端口核不上归属 —— 这次停止不许宣称成功");
    await waitFor("带记号的监听者确实被收掉了", () => !alive(pairPid));
    assert.ok(alive(pairWorker), "核不上归属的那个一个字都不许动");
    assert.deepEqual(
      leftoversOf("ports13"),
      [pairWorker],
      "**这一条就是本轮的修复**:发现的那一刻就要落账,不能等到成功分支才交 —— 失败分支一 return,下一遍就再也发现不了它",
    );
    process.kill(pairWorker, "SIGKILL");
    await waitFor("工人走了", () => !alive(pairWorker));
    const settled = await stopCommand("ports13", SERVICE_COMMAND_ID, null, { portGraceMs: 300 });
    assert.equal(settled.status, 200, "两个端口都空了,这次才算核到终态");
    strays.delete(pairPid);
    strays.delete(pairWorker);
  }

  // ── ⑭ 停止命令只收掉监听者,也不算这次启动停净了 ────────────────────────────────
  //    脚本这条路 ash 不替用户强杀(他写那段脚本正是不想让 ash 直接 kill),于是默认停止那边
  //    「枚举同组成员」的覆盖拿不到 —— 必须拿停止**之前**照的成员相来比:端口空了只说明
  //    监听者走了,它 fork 的工人从来没进过账(发现 1)。
  {
    const scriptPort2 = await freePort();
    const litePidfile = join(cwd, "lite.pid");
    const liteWorker = join(cwd, "lite-worker.pid");
    assert.equal(
      (await startCommand("ports14", cwd, service(daemonScript(scriptPort2, litePidfile, [], liteWorker)))).status,
      201,
    );
    await waitFor("守护进程听上了端口", async () => (await listening(scriptPort2)).length > 0);
    const litePid = pidIn(litePidfile);
    strays.add(litePid);
    await waitFor("洗掉环境的工人也起来了", () => { try { return pidIn(liteWorker) > 0; } catch { return false; } });
    const liteWorkerPid = pidIn(liteWorker);
    strays.add(liteWorkerPid);
    await waitFor("启动脚本退出", () => serviceSession("ports14")?.exitCode !== null);
    // 一条**只收监听者**的停止命令:它 exit 0,端口也真的让出来了。
    const partial = await stopCommand("ports14", SERVICE_COMMAND_ID, {
      script: `kill -9 ${litePid}`, cwd, timeoutMs: 5_000,
    }, { portGraceMs: 300 });
    assert.equal(partial.status, 200);
    await waitFor("监听者被脚本收掉了", () => !alive(litePid));
    const partialBody = partial.body as { stopped: boolean; unresolved?: number[]; notice?: string };
    assert.deepEqual(partialBody.unresolved, [liteWorkerPid], "停止前在跑、现在还活着的成员要落进账");
    assert.match(partialBody.notice ?? "", /停止命令跑完了/, "要跟用户说清是他那条脚本没收干净");
    assert.deepEqual(leftoversOf("ports14"), [liteWorkerPid], "刷新回来还看得见");
    process.kill(liteWorkerPid, "SIGKILL");
    strays.delete(litePid);
    strays.delete(liteWorkerPid);
  }

  // ── ⑩-关服 那一拍的同步收口也要盖到端口这一档 ─────────────────────────────────────
  //    `process.once("exit")` 里没有 await 可用(信号处理器直接 process.exit),所以这一步
  //    必须是同步的。漏掉它,ash 重启后那个服务还听着端口、却再没有任何把手能停它。
  //    **放在最后**:shutdown() 会把整个会话管理器停掉。
  const exitPort = await freePort();
  const exitPidfile = join(cwd, "exit.pid");
  assert.equal((await startCommand("ports11", cwd, service(daemonScript(exitPort, exitPidfile)))).status, 201);
  await waitFor("守护进程听上了端口", async () => (await listening(exitPort)).length > 0);
  const exitPid = pidIn(exitPidfile);
  strays.add(exitPid);
  await waitFor("启动脚本退出", () => serviceSession("ports11")?.exitCode !== null);
  terminalSessions.shutdown();
  await waitFor("关服那一拍把它一起收掉了", () => !alive(exitPid));
  assert.equal(await probePorts([exitPort]), "free", "端口要真的让出来");
  strays.delete(exitPid);

  console.log("service ports test passed");
} finally {
  terminalSessions.shutdown();
  for (const pid of strays) { try { process.kill(pid, "SIGKILL"); } catch { /* 已经走了 */ } }
  rmSync(cwd, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
