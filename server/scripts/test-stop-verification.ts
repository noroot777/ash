import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalSessionManager, terminalSessions } from "../src/terminal.js";
import { startCommand, stopCommand, restartCommand } from "../src/terminal-commands.js";
import { launchClosureSealed, portStopVerdict, processStopVerdict } from "../src/terminal-stop-notices.js";
import { candidateBounds, launchSurvivors } from "../src/terminal-launch-survivors.js";
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
// **现搭环境**那一份:中转给工人塞一份自己拼的环境(有变量、没有 ash 的记号)。macOS 的
// `ps -E` 把它打得明明白白 —— 早先的判据因此判成「带着别人的环境 = 不是这次的」,停止报
// 「已停止」而它还在跑(第 2 轮自由审查 F2 真实复现)。
const freshBroker = join(cwd, "fresh-broker.cjs");
writeFileSync(freshBroker, `const fs=require('node:fs'),prefix=process.argv[2];`
  + `const timer=setInterval(()=>{if(!fs.existsSync(prefix+'.gate'))return;clearInterval(timer);`
  + `const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(daemon)},prefix],`
  + `{detached:true,stdio:'ignore',env:{PATH:process.env.PATH,WORKER_KIND:'explicit-fresh-environment'}});`
  + `child.unref();},20);`);
const freshLauncher = join(cwd, "fresh-launcher.cjs");
writeFileSync(freshLauncher, `const child=require('node:child_process').spawn(process.execPath,`
  + `[${JSON.stringify(freshBroker)},process.argv[2]],{detached:true,stdio:'ignore'});child.unref();`);
// **换了工作目录**的两份(第 3 轮自由审查 F1)。第 2 轮曾拿「cwd 跟启动目录不一样就跳过」
// 当第三道筛子,于是这两个号在读环境之前就被丢掉、剩下的问全了就报「问全了」——
// 审查用同一个工人、只把 cwd 换成 `/` 实测到 stop 200、`stop={"kind":"verified"}`、页面显示
// 「已停止」,而 `WORKER_ALIVE_AFTER_STOP true`。两份分别钉住那个筛子的两种后果:
//
//  · `moved-marked` —— 工人**带着这次启动的记号**,只是换了目录:它本该被**点名**,
//    却被目录筛子先丢掉了,于是整条线索彻底消失(审查当时记为代码推断,这里补上实测);
//  · `moved-fresh`  —— 工人既换了目录又现搭了环境:这一档点不到名,但必须如实报「证不出来」。
const movedBroker = join(cwd, "moved-broker.cjs");
writeFileSync(movedBroker, `const fs=require('node:fs'),prefix=process.argv[2];`
  + `const timer=setInterval(()=>{if(!fs.existsSync(prefix+'.gate'))return;clearInterval(timer);`
  + `const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(daemon)},prefix],`
  + `{detached:true,stdio:'ignore',cwd:'/'});child.unref();},20);`);
const movedLauncher = join(cwd, "moved-launcher.cjs");
writeFileSync(movedLauncher, `const child=require('node:child_process').spawn(process.execPath,`
  + `[${JSON.stringify(movedBroker)},process.argv[2]],{detached:true,stdio:'ignore'});child.unref();`);
const movedFreshBroker = join(cwd, "moved-fresh-broker.cjs");
writeFileSync(movedFreshBroker, `const fs=require('node:fs'),prefix=process.argv[2];`
  + `const timer=setInterval(()=>{if(!fs.existsSync(prefix+'.gate'))return;clearInterval(timer);`
  + `const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(daemon)},prefix],`
  + `{detached:true,stdio:'ignore',cwd:'/',env:{PATH:process.env.PATH,WORKER_KIND:'moved-fresh-environment'}});`
  + `child.unref();},20);`);
const movedFreshLauncher = join(cwd, "moved-fresh-launcher.cjs");
writeFileSync(movedFreshLauncher, `const child=require('node:child_process').spawn(process.execPath,`
  + `[${JSON.stringify(movedFreshBroker)},process.argv[2]],{detached:true,stdio:'ignore'});child.unref();`);
// **带着另一次启动的记号**那一份(第 4 轮自由审查 F1)。中转给工人塞的环境里有一枚**真的**
// ash 启动记号,只不过是**上一次**启动那一枚 —— 启动脚本把上次存下的环境原样拿来派工人,
// 现实里这就是一行 `env` 文件。早先这一档被当成唯一的「否证」直接跳过候选集,于是剩下的问全
// 了就报「问全了」:审查用真实 API + 真实进程实测到 stop 报 `{"kind":"verified"}`、页面
// 「已停止」,`WORKER_ALIVE_AFTER_STOP true`。环境是**可复制**的,记号指向别处推不出它不是
// 这次创造的。记号从哪儿来由 argv 传进来,这样夹具里那枚是真 ash 生成的、不是手编的。
const cachedBroker = join(cwd, "cached-broker.cjs");
writeFileSync(cachedBroker, `const fs=require('node:fs'),prefix=process.argv[2],mark=process.argv[3];`
  + `const timer=setInterval(()=>{if(!fs.existsSync(prefix+'.gate'))return;clearInterval(timer);`
  + `const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(daemon)},prefix],`
  + `{detached:true,stdio:'ignore',env:{PATH:process.env.PATH,ASH_LAUNCH_ID:mark}});child.unref();},20);`);
const cachedLauncher = join(cwd, "cached-launcher.cjs");
writeFileSync(cachedLauncher, `const child=require('node:child_process').spawn(process.execPath,`
  + `[${JSON.stringify(cachedBroker)},process.argv[2],process.argv[3]],{detached:true,stdio:'ignore'});child.unref();`);
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
    // 这一档是**反证到手**:号留在账上,刷新回来还看得见,用户有下手的地方。
    //
    // 这里**不断言 `complete`**:封不封口要看「这台机器此刻还有没有问不出归属的孤儿」,而那
    // 取决于 macOS 这一刻恰好起了几个 mdworker,不是本用例要钉的不变量(第 3 轮 F1 之后
    // 候选集只按属主和出生时刻收窄,不再拿工作目录把它们筛掉)。`complete` 那条不变量由
    // 下面「裁定层本身的不变量」那段用合成 LaunchScan 直接问。
    assert.ok(fact.kind === "unresolved" && fact.pids.includes(pid));
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
    assert.ok(fact.kind === "unresolved" && fact.pids.includes(pid),
      "反证到手:号留在账上,刷新回来仍然看得见(封不封口见上一段的说明)");
  }

  // 记号没命中的两个现场(POSIX 专有:Windows 上记号这一问整档 unavailable,见 LaunchScan
  // 的注释)。两边钉的是同一条:**记号只提供正面归属,没命中不构成否证**。
  //
  //  · `silent-env` —— 工人的环境是空的,`ps -E` 一个变量都不打(macOS 分不出「本来是空的」
  //    和「不给看」);
  //  · `fresh-env`  —— 工人的环境是中转现搭的:读得出来、有变量、就是没有 ash 的记号。
  //    第一轮修复只把前者纳进来,后者仍被当成「别人家的号」跳过,于是真实页面照旧显示
  //    「已停止」而它还在跑(第 2 轮自由审查 F2)。
  //
  //  · `moved-fresh` —— 再加一道:工人**换了工作目录**(cwd 换成 `/`)。第 2 轮拿 cwd 当第三道
  //    筛子,于是它在读环境之前就被丢掉、剩下的问全了就报「问全了」(第 3 轮自由审查 F1
  //    实测:stop 200、stop={"kind":"verified"}、页面「已停止」,工人还活着)。
  //
  // 三个工人都跟 ash 同属主、出生在这次启动之后 —— 两道**否证**筛子都对不上它们,所以停止
  // 这一趟必须如实报未确认。工作目录从此不参与筛选(它可变),只决定先点谁的名。
  for (const [mode, script] of [["silent-env", envLauncher], ["fresh-env", freshLauncher],
    ["moved-fresh", movedFreshLauncher]] as const) {
    if (process.platform === "win32") break;
    const projectId = mode;
    const prefix = join(cwd, mode);
    const home = join(cwd, `${mode}-home`);
    mkdirSync(home, { recursive: true });
    const command = { id: "service", name: mode, command: runNode(script, prefix), stopCommand: noop, restartCommand: null };
    assert.equal((await startCommand(projectId, home, command)).status, 201);
    await waitFor(() => terminalSessions.listForProject(projectId)[0]?.exitCode === 0);
    writeFileSync(prefix + ".gate", "go");
    await waitFor(() => existsSync(prefix + ".pid") && terminalSessions.listForProject(projectId)[0]?.groupAlive === false);
    const pid = Number(readFileSync(prefix + ".pid", "utf8"));
    pids.push(pid);
    const original = terminalSessions.listForProject(projectId)[0];
    assert.deepEqual(original.ports, [], "夹具前提:这条命令一个端口都没打印,只剩记号这一条线索");
    // 扫描这一层先单独问一遍:那个空环境的号必须落进「没问出答案」,而不是被当成陌生人跳过。
    const scan = await launchSurvivors(terminalSessions.launchTokenOf(original.id), original);
    assert.equal(scan.evidence, "incomplete",
      "同用户、这次启动之后出生、工作目录也对得上,而记号没命中 = 这一问没答上来");
    assert.equal(launchClosureSealed(scan), false, "没答上来就不算封口");
    assert.ok(scan.unanswered.includes(pid),
      `那个工人必须被算进「问不出归属」的集合（实得：${scan.unanswered.join("、")}）`);
    assert.equal(scan.pids.length, 0, "记号没命中就点不到名,这一档交的是「证据不全」而不是点名");
    // 同目录那两档:工人的工作目录是从启动那一刻继承下来的,所以它是最可疑的那几个之一,
    // 必须被点进措辞里。换了目录的那一档不要求(它排在同目录的嫌疑之后,前三名可能排不上),
    // 但上面 `unanswered` 那一问已经把它钉死了。
    if (mode !== "moved-fresh") {
      assert.ok(String(scan.why).includes(`pid ${pid}`), `那句话要点出是哪个号（实得：${scan.why}）`);
    }
    const result = await stopCommand(projectId, "service", { script: noop, cwd: home });
    assert.equal(result.status, 200);
    assert.equal(processAlive(pid), true, "夹具前提:那个工人还活着");
    // 这一档点不到名(记号本来就读不出来),所以它交的是「证据不全」那句固定措辞,而不是
    // 「点到了谁」—— 关键是**不许**沉默地判停净。
    assert.deepEqual(result.body.unresolved, [], "读不出环境只是没答上来,不构成点名");
    assert.match(String(result.body.notice), /核不上/);
    assert.match(String(result.body.notice), /所以没法说这次启动起来的东西都停了/);
    if (mode !== "moved-fresh") {
      assert.ok(String(result.body.notice).includes(`pid ${pid}`), "那句话要点出是哪个号没答上来");
    }
    const fact = terminalSessions.get(original.id)!.stop;
    assert.ok(fact.kind === "unresolved" && !fact.complete,
      "证据不全那一档:刷新回来仍然看得出「这次没能确认停净」,而且这笔账核销不掉");
  }

  // **换了工作目录、但记号还在**(第 3 轮自由审查 F1 的另一半)。第 2 轮那道 cwd 筛子排在读
  // 环境**之前**,所以这个号连被问的机会都没有:它明明带着这次启动的记号、本该被点名,结果
  // 整条线索彻底消失、停止干净地报「已停止」。审查当时把这半边记为代码推断,这里补成实测。
  // 筛子撤掉之后它该回到第一条道上 —— 被点名,并给出 pid。
  if (process.platform !== "win32") {
    const projectId = "moved-marked";
    const prefix = join(cwd, "moved-marked");
    const home = join(cwd, "moved-marked-home");
    mkdirSync(home, { recursive: true });
    const command = { id: "service", name: "moved-marked", command: runNode(movedLauncher, prefix), stopCommand: noop, restartCommand: null };
    assert.equal((await startCommand(projectId, home, command)).status, 201);
    await waitFor(() => terminalSessions.listForProject(projectId)[0]?.exitCode === 0);
    writeFileSync(prefix + ".gate", "go");
    await waitFor(() => existsSync(prefix + ".pid") && terminalSessions.listForProject(projectId)[0]?.groupAlive === false);
    const pid = Number(readFileSync(prefix + ".pid", "utf8"));
    pids.push(pid);
    const original = terminalSessions.listForProject(projectId)[0];
    assert.deepEqual(original.ports, [], "夹具前提:只剩记号这一条线索");
    const scan = await launchSurvivors(terminalSessions.launchTokenOf(original.id), original);
    assert.ok(scan.pids.includes(pid),
      `带着这次记号的号必须被点名,换没换工作目录都一样（实得：${scan.pids.join("、")}）`);
    const result = await stopCommand(projectId, "service", { script: noop, cwd: home });
    assert.equal(result.status, 200);
    assert.equal(processAlive(pid), true, "夹具前提:那个工人还活着");
    assert.match(String(result.body.notice), /按这次启动的记号还点到/);
    assert.ok(String(result.body.notice).includes(`pid ${pid}`), "那句话必须给出 pid");
    assert.ok((result.body.unresolved as number[]).includes(pid), "账上要留着这个号");
    const fact = terminalSessions.get(original.id)!.stop;
    assert.ok(fact.kind === "unresolved" && fact.pids.includes(pid), "刷新回来仍然看得见这个号");
  }

  // **工人带着上一次启动的记号**(第 4 轮自由审查 F1)。这是「可复制属性不能当否证」的最后
  // 一件外衣:前三轮分别拿空环境、现搭环境、工作目录试过,这一轮换成「环境里确实有一枚 ash
  // 记号,只是不是这次的」。它曾是候选集里唯一保留的那道归属筛子,于是这个号连被算进「没问
  // 出来」的机会都没有,停止干净地报停净。
  if (process.platform !== "win32") {
    const projectId = "cached-marker";
    const prefix = join(cwd, "cached-marker");
    const home = join(cwd, "cached-marker-home");
    mkdirSync(home, { recursive: true });
    // 真·上一次启动的那枚记号:夹具不手编 token,拿本文件最前面那次(已经停过的)启动的。
    const earlier = terminalSessions.listForProject("no-port-stop")[0];
    const foreign = terminalSessions.launchTokenOf(earlier.id);
    assert.ok(foreign, "夹具前提:上一次启动真的留下了记号,工人带的才是一枚真 ash 记号");
    const command = { id: "service", name: "cached-marker", command: runNode(cachedLauncher, prefix, foreign!), stopCommand: noop, restartCommand: null };
    assert.equal((await startCommand(projectId, home, command)).status, 201);
    await waitFor(() => terminalSessions.listForProject(projectId)[0]?.exitCode === 0);
    writeFileSync(prefix + ".gate", "go");
    await waitFor(() => existsSync(prefix + ".pid") && terminalSessions.listForProject(projectId)[0]?.groupAlive === false);
    const pid = Number(readFileSync(prefix + ".pid", "utf8"));
    pids.push(pid);
    const original = terminalSessions.listForProject(projectId)[0];
    assert.deepEqual(original.ports, [], "夹具前提:只剩记号这一条线索");
    const token = terminalSessions.launchTokenOf(original.id);
    assert.notEqual(token, foreign, "夹具前提:这次启动的记号跟工人带着的那枚不是同一个");
    const scan = await launchSurvivors(token, original);
    assert.ok(scan.unanswered.includes(pid),
      `带着别次记号的号也只是「没问出来」，必须留在这个集合里（实得：${scan.unanswered.join("、")}）`);
    assert.equal(scan.evidence, "incomplete", "记号指向别处不是否证 —— 这一趟没问全");
    assert.equal(launchClosureSealed(scan), false, "没问全就不算封口");
    assert.ok(!scan.pids.includes(pid), "也点不到它的名:正面归属一样要凭这次的记号");
    const result = await stopCommand(projectId, "service", { script: noop, cwd: home });
    assert.equal(result.status, 200);
    assert.equal(processAlive(pid), true, "夹具前提:那个工人还活着");
    assert.match(String(result.body.notice), /核不上/);
    assert.match(String(result.body.notice), /所以没法说这次启动起来的东西都停了/);
    const fact = terminalSessions.get(original.id)!.stop;
    assert.ok(fact.kind === "unresolved" && !fact.complete,
      "刷新回来仍然看得出「这次没能确认停净」,而且这笔账核销不掉");
  }

  // **收窄规则的前提立不住时,一个核不上的号都没有也不许封口**。候选集只能按属主和出生时刻
  // 收窄,而这两条各自有前提(ash 不是 root、墙上钟没被改过)。前提不成立时照样收窄 —— 否则
  // 候选集会膨胀到读不动 —— 但那一趟**说不出漏没漏**,所以 `unanswered` 可以是空的而结论仍
  // 然是 `incomplete`。这里用「这次启动的时刻记在未来」把这条路走通(钟被改过的等价形状)。
  {
    // 两条前提直接问(整趟扫描的结论受这台机器此刻还跑着什么影响,这条不变量不能靠那种现场
    // 去钉):时刻正常 = 前提立得住;记在未来 = 两端的钟对不上,这一趟的收窄不可靠。
    assert.equal(candidateBounds({ startedAt: Date.now() - 1000, cwd }).proven, true);
    const broken = candidateBounds({ startedAt: Date.now() + 60 * 60 * 1000, cwd });
    assert.notEqual(broken.proven, true, "前提立不住就得记下来,不能照常当「问全了」");
    assert.match(String(broken.proven), /记在未来/, "那句话要说出是哪个前提没立住");
    // 收窄本身照旧发生(否则候选集会膨胀到读不动),只是这一趟不许封口。
    assert.equal(broken.oldest, 5000, "前提立不住不等于不收窄:上界照常给出");
  }
  if (process.platform !== "win32") {
    const earlier = terminalSessions.listForProject("no-port-stop")[0];
    const future = await launchSurvivors(terminalSessions.launchTokenOf(earlier.id),
      { ...earlier, startedAt: Date.now() + 60 * 60 * 1000 });
    assert.equal(future.evidence, "incomplete", "前提立不住的那一趟,扫描这一层也必须如实交代");
    assert.equal(launchClosureSealed(future), false);
    assert.match(String(future.why), /记在未来/, "理由要带到措辞里");
  }

  // 裁定层本身的不变量(纯函数,直接问):**任何必要证据未知都只能保留未知**。
  {
    const open = { id: "x", projectId: "p", ports: [41234], portsTruncated: false, groupAlive: true } as TerminalSessionInfo;
    const answered = { pids: [], unanswered: [], evidence: "answered" as const, why: null };
    const silent = { pids: [], unanswered: [4242], evidence: "incomplete" as const, why: "ps 没答上话" };
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
      { pids: [999999], unanswered: [4242], evidence: "incomplete", why: "ps 没答上话" });
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
  console.log("stop verification passed: no-port stop/restart uncertainty, port-path mark scan, empty-env/rebuilt-env/moved-cwd/foreign-marker candidates stay unanswered, a moved-but-marked worker is still named, an unprovable narrowing bound blocks sealing, unified verdict completeness, retained history, newest-only history, capacity accounting");
} finally {
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  manager.shutdown();
  terminalSessions.shutdown();
  rmSync(cwd, { recursive: true, force: true });
}
