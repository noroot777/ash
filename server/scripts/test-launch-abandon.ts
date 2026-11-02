import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";

// 「我自己处理了」这个显式出口的回归(server/src/terminal-abandon.ts)。
//
// 钉的是两件事,一件都不能少:
//   ① **死局真的存在**,而且放弃之后真的解开了 —— 账上挂着一个核不上归属、没敢动的活号时,
//      启动被幂等门顶回、删记录被拒,界面上没有任何出路(第 1 轮审查发现 1 的形状);
//   ② 放弃**不是核销** —— `stop` 账原样留着 `unresolved`,只是 ash 不再把它当「还在跑」的
//      东西管。两者混成一格就会凭空多出一句「已停止」,那是停止语义里最不许出现的谎。
//
// 残留事实用一个**外部的**活进程扮演(不是这次启动起来的),于是不依赖 lsof、也不依赖
// 守护化形状,在 CI 和 Windows 上都是确定性的。

const temporary = realpathSync(mkdtempSync(join(tmpdir(), "ash-launch-abandon-")));
process.env.ASH_DB = join(temporary, "test.db");
const { terminalSessions } = await import("../src/terminal.js");
const { startCommand } = await import("../src/terminal-commands.js");
const { launchResidue, mountLaunchAbandonRoutes, residueNotice } = await import("../src/terminal-abandon.js");
const { dbClient } = await import("../src/db/index.js");

const windows = process.platform === "win32";
const projectId = "abandon-project";
const command = {
  id: "service", name: "service",
  command: windows ? "Write-Output started" : "echo started",
  restartCommand: null, stopCommand: null,
};
const api = new Hono();
mountLaunchAbandonRoutes(api);
const call = (path: string, init?: RequestInit) =>
  api.request(`/projects/${projectId}/commands/${command.id}${path}`, init);
const post = (path: string, body: unknown) =>
  call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

/** 扮演「核不上归属、没敢动」的那个号:一个跟这次启动无关的真进程。 */
const stray = spawn(windows ? "powershell" : "sh",
  windows ? ["-NoProfile", "-Command", "Start-Sleep -Seconds 120"] : ["-c", "sleep 120"],
  { stdio: "ignore" });
const strayPid = stray.pid!;

try {
  assert.equal((await startCommand(projectId, temporary, command)).status, 201);
  const sessionId = terminalSessions.listCommandSessions()
    .find((session) => session.projectId === projectId)!.id;
  // 等启动脚本自己退掉:死局的典型形状是「脚本早退了,账上还挂着没核销的号」。
  for (let i = 0; i < 200 && terminalSessions.get(sessionId, projectId)?.exitCode === null; i++) await delay(25);
  terminalSessions.oweCommandLeftovers(sessionId, projectId, [strayPid],
    `pid ${strayPid} 核不上归属，一个字都没敢动`);

  // ① 死局:启动被顶回,删记录被拒。
  const blocked = await startCommand(projectId, temporary, command);
  assert.equal(blocked.status, 200);
  assert.equal((blocked.body as { alreadyRunning?: boolean }).alreadyRunning, true);
  const refused = await terminalSessions.destroy(sessionId, projectId);
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.reason : "", /没敢把会话记录删掉/);
  assert.equal(terminalSessions.get(sessionId, projectId)!.running, true);
  console.log("PASS: 核不上归属的活号让这条命令既起不动、也删不掉（出口之前的死局）");

  // ② 残留事实是**只读**的,而且必须把那个号说出来 —— 看不见就不该让人签字。
  const residue = await call("/residue");
  assert.equal(residue.status, 200);
  const view = await residue.json() as {
    sessionId: string; scope: string[]; abandoned: unknown;
    residue: { owedPids: number[]; notice: string };
  };
  assert.equal(view.sessionId, sessionId);
  assert.deepEqual(view.residue.owedPids, [strayPid]);
  assert.match(view.residue.notice, new RegExp(`pid ${strayPid}`));
  assert.ok(view.scope.length >= 3, "解除范围要逐条写出来");
  assert.equal(view.abandoned, null);
  assert.equal(terminalSessions.get(sessionId, projectId)!.abandoned, null, "看一眼不许改状态");
  console.log("PASS: 残留事实只读可查，那个没核销的号和解除范围都摆在签字之前");

  // ②b 两类事实分开说:确定是这次留下的才叫「得你自己处理」,分不清来路的只交代、不让人替它签字。
  assert.match(view.residue.notice, /得你自己处理/, "账上没核销的号是这次留下的那一类");
  assert.equal((view.residue as { left?: string }).left, "owned", "界面据这一格挑说法，不认措辞");
  const mixed = residueNotice(["pid 1 还活着"], ["pid 2 分不清是不是这次启动的"]);
  assert.match(mixed, /^下面这些是这次启动留下的.*得你自己处理：pid 1 还活着。另外，pid 2 分不清/);
  const onlyUnsure = residueNotice([], ["pid 2 分不清是不是这次启动的"]);
  assert.doesNotMatch(onlyUnsure, /得你自己处理|残留/, "只剩分不清来路的那类时不许说成残留");
  assert.match(onlyUnsure, /没找到能确认是这次启动留下的进程.*pid 2.*一个都没动过/);
  assert.match(residueNotice([], []), /探不到任何残留/);
  console.log("PASS: 确定留下的和分不清来路的分开交代，后者不被说成残留");

  // ③ 签字必须针对**刚看过的那一条**。
  assert.equal((await post("/abandon", {})).status, 400);
  assert.equal((await post("/abandon", { sessionId: "nope" })).status, 404);
  console.log("PASS: 没带会话 id / 带了个不存在的都签不下去");

  // ④ 放弃本体:ash 不再管它,但账一个字都不改。
  const signed = await post("/abandon", { sessionId });
  assert.equal(signed.status, 200);
  const after = terminalSessions.get(sessionId, projectId)!;
  assert.ok(after.abandoned, "放弃那一刻的快照要落在会话事实上");
  assert.deepEqual(after.abandoned!.owedPids, [strayPid]);
  assert.equal(after.stop.kind, "unresolved", "放弃不是核销：停没停净的结论原样留着");
  assert.equal(after.running, false, "ash 不再把它当还在跑的东西管");
  assert.ok(await processAlive(strayPid), "放弃不杀任何进程");
  console.log("PASS: 放弃落成一格快照，stop 账仍是 unresolved、进程一个没杀");

  // ⑤ 幂等:再按一次不覆盖第一次那份快照(残留在那之后只会变)。
  const again = await post("/abandon", { sessionId });
  assert.equal(again.status, 200);
  const twice = await again.json() as { alreadyAbandoned?: boolean; abandoned: { at: number } };
  assert.equal(twice.alreadyAbandoned, true);
  assert.equal(twice.abandoned.at, after.abandoned!.at);
  console.log("PASS: 再按一次只回那份原始快照，不改写签字时看到的事实");

  // ⑥ 死局解开了:起得来新的一份,而旧记录也不再被保护着赖在会话表里 —— 新启动那一趟的
  // 旧记录清理顺手把它收走了(它既不算「还在跑」、也不再需要留着当把手)。于是拿旧弹层上的
  // 「是」去签字只会得到 404:那条记录已经不在了。
  const restarted = await startCommand(projectId, temporary, command);
  assert.equal(restarted.status, 201, "幂等门不再拿放弃过的记录顶回启动");
  assert.notEqual((restarted.body as { session: { id: string } }).session.id, sessionId);
  assert.equal(terminalSessions.get(sessionId, projectId), null, "删除保护随放弃一并解除");
  assert.equal((await post("/abandon", { sessionId })).status, 404);
  assert.ok(await processAlive(strayPid), "全程一个进程都没被杀");
  console.log("PASS: 放弃之后起得来新的一份，旧记录不再受保护、也不能再被签一次");

  // ⑦ 期间这条命令又起了一份:**旧弹层上的「是」一律 409**。形状取「没能确认停净、却一个
  // 活号都举不出来」那种(端口超额),它按设计永远核销不掉、因此一直留在会话表里,但不算
  // 「还在跑」—— 于是新的一份起得来,两条记录同时在,签字必须对着用户刚看过的那一条。
  const watch = { id: "watch", name: "watch", command: command.command, restartCommand: null, stopCommand: null };
  assert.equal((await startCommand(projectId, temporary, watch)).status, 201);
  const olderId = terminalSessions.listCommandSessions()
    .find((session) => session.projectId === projectId && session.commandId === watch.id)!.id;
  for (let i = 0; i < 200 && terminalSessions.get(olderId, projectId)?.exitCode === null; i++) await delay(25);
  terminalSessions.markCommandStopped(olderId, projectId, {
    kind: "unresolved", pids: [], complete: false,
    why: "这次启动打印的本机端口超过了记录额度，多出来的端口没能核验",
  });
  assert.equal(terminalSessions.get(olderId, projectId)!.running, false);
  const newer = await startCommand(projectId, temporary, watch);
  assert.equal(newer.status, 201);
  assert.ok(terminalSessions.get(olderId, projectId), "按设计核销不掉的那条记录要留着");
  const conflict = await api.request(`/projects/${projectId}/commands/${watch.id}/abandon`, {
    method: "POST", body: JSON.stringify({ sessionId: olderId }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(conflict.status, 409);
  assert.equal(terminalSessions.get(olderId, projectId)!.abandoned, null, "409 的那一次什么都不许改");
  console.log("PASS: 期间又起了一份时，旧弹层的签字被 409 拦下、并指回新的那条");
  // ⑧ 删除保护那道闸本体:它的全部内容就是「名下还有活物,不敢删记录」,而用户已经显式
  // 接手了这笔责任 —— 再拦一遍只会让这个出口自己走不通(关日志标签、删项目都走这条路)。
  const worker = { id: "worker", name: "worker", command: command.command, restartCommand: null, stopCommand: null };
  assert.equal((await startCommand(projectId, temporary, worker)).status, 201);
  const workerId = terminalSessions.listCommandSessions()
    .find((session) => session.projectId === projectId && session.commandId === worker.id)!.id;
  for (let i = 0; i < 200 && terminalSessions.get(workerId, projectId)?.exitCode === null; i++) await delay(25);
  terminalSessions.oweCommandLeftovers(workerId, projectId, [strayPid], `pid ${strayPid} 核不上归属，一个字都没敢动`);
  assert.equal((await terminalSessions.destroy(workerId, projectId)).ok, false);
  const handed = await launchResidue(terminalSessions.get(workerId, projectId)!);
  assert.ok(await terminalSessions.abandonLaunch(workerId, projectId, handed));
  assert.equal((await terminalSessions.destroy(workerId, projectId)).ok, true, "放弃过的记录不再被删除保护拦下");
  assert.equal(terminalSessions.get(workerId, projectId), null);
  assert.ok(await processAlive(strayPid), "删掉记录也不等于杀进程：那个号仍然活着，只是从此由用户自己处理");
  console.log("PASS: 同一条闸在放弃之后放行，而它名下那个活号一个字都没动");

  // ⑨ 签过字的活物,ash 之后**哪条路都不杀**(第 1 轮自由审查必须修 1:闲置回收把放弃过的读成
  // 「死透了」,半小时后连树 SIGKILL、连「我放过手」的记录一起抹掉)。形状取守护化启动真正
  // 有用的那一种:组里还活着东西,用户签字接手。
  const pidFile = join(temporary, "daemon.pid");
  const daemon = {
    id: "daemon", name: "daemon", restartCommand: null, stopCommand: null,
    command: windows
      ? `Set-Content -Path '${pidFile}' -Value $PID; Start-Sleep -Seconds 120`
      : `echo $$ > '${pidFile}'; exec sleep 120`,
  };
  assert.equal((await startCommand(projectId, temporary, daemon)).status, 201);
  const daemonId = terminalSessions.listCommandSessions()
    .find((session) => session.projectId === projectId && session.commandId === daemon.id)!.id;
  let daemonPid = 0;
  for (let i = 0; i < 200 && !daemonPid; i++) {
    try { daemonPid = Number(readFileSync(pidFile, "utf8").trim()); } catch { await delay(25); }
  }
  try {
    assert.ok(daemonPid > 0 && await processAlive(daemonPid), "这次启动起来的那个进程要先活着");
    const adopted = await launchResidue(terminalSessions.get(daemonId, projectId)!);
    assert.ok(await terminalSessions.abandonLaunch(daemonId, projectId, adopted));
    // 计数不能拿来断言:前面几步留下的纯退出日志本来就该被这一趟收走。
    terminalSessions.sweepIdleSessions(Date.now() + 31 * 60_000);
    await delay(300);
    assert.ok(await processAlive(daemonPid), "闲置回收不许杀用户签字接手的进程");
    assert.ok(terminalSessions.get(daemonId, projectId)?.abandoned, "「已放弃管理」这条记录要一直看得见");
    assert.equal((await terminalSessions.destroy(daemonId, projectId)).ok, true);
    assert.equal(terminalSessions.get(daemonId, projectId), null, "关日志标签照样删得掉记录");
    await delay(300);
    assert.ok(await processAlive(daemonPid), "删记录也只删记录：签过字的进程一个不杀");
    console.log("PASS: 放弃之后闲置回收不杀进程、不抹记录；关标签只删记录，进程照旧活着");
  } finally {
    if (daemonPid) try { process.kill(daemonPid, "SIGKILL"); } catch { /* 已经没了 */ }
  }
} finally {
  try { stray.kill("SIGKILL"); } catch { /* 已经没了 */ }
  terminalSessions.shutdown();
  dbClient.close();
  rmSync(temporary, { recursive: true, force: true });
}

async function processAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

console.log("test-launch-abandon: all assertions passed");
