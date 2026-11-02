// **「有过进展」在协议层读到就算数,而且落盘之前水位不许越过它。**
// 跑:npm -w server run test:undriven-turn(同一条命令里接着跑)
//
// 第 1 轮自由审查(ycH7vQQep_4A)F1,实测:真实 detached 读取器 + codex 适配器 + 单飞消费链,
// 喂一条不到 240 字的思考增量(`working`)后保持安静 ——
//   · 那段思考压在合并缓冲里,下游一条进展都没看到,静默档照「从头到尾没有输出」熔断;
//   · 原始水位已经越过它(offset=114)、进展记号却还是 none —— 这时重启,新进程从 114 读起,
//     那段思考再也重放不到,又是「证明在、记号不在」= 确证零进展。
// 同一条的第三处:接管时进展历史读不出来,上一版借「整轮零产出」那一档,到时限照样判失败终止。
// 第 2 轮 F1 是它的反面:读不出之后证明又恢复、读出「确证零进展」,上一版那条只警告的观察不再转回,
// 零输出回合从此永远「进行中」—— 两种结论都得有出边。
if (process.platform === "win32") {
  console.log("test:progress-boundary 跳过：真实 detached 读取器夹具只在 POSIX 上跑过（根 AGENTS.md）");
  process.exit(0);
}

import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "ash-progress-boundary-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_UPLOADS_DIR = join(root, "uploads");
process.env.CODEX_HOME = join(root, "codex-home");
process.env.ASH_LAX_DONE = "1";

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { makeDetachedChild } = await import("../src/executors/detached-child.js");
const { openCodexAppServer } = await import("../src/executors/codex-app-server.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
const { eventQueue } = await import("../src/executors/event-queue.js");
const { consumeSingleRun } = await import("../src/single-run.js");
const { openTurnProgress, turnProgress } = await import("../src/turn-progress-mark.js");
const { clearTurnStall, confirmTurnSilence, trackTurnStall, watchAdoptedSilence } = await import("../src/turn-stall.js");
const { configure, spy, sleep } = await import("./stall-fixtures.js");
const { eq } = await import("drizzle-orm");
await ensureSchema();

let failures = 0;
const ok = (line: string) => console.log(`   ✓ ${line}`);
const fail = (line: string) => { failures += 1; console.error(`   ✗ ${line}`); };
const check = (cond: boolean, line: string) => (cond ? ok(line) : fail(line));

/**
 * 接管回来的一轮:真实 detached 读取器 + codex 适配器 + 单飞消费链(`adopted`),参与证明在。
 * `hideProof` = 接管那一刻进展证明读不到(挪走 `.watch`),返回的 `restoreProof` 把它放回去。
 */
let projectSeeded = false;
async function adoptCase(taskId: string, sessId: string, opts: { hideProof?: boolean } = {}) {
  const stamp = new Date().toISOString();
  if (!projectSeeded) {
    await db.insert(projects).values({ id: "p-boundary", name: "boundary", repoPath: root, createdAt: stamp } as never);
    projectSeeded = true;
  }
  await db.insert(tasks).values({
    id: taskId, projectId: "p-boundary", title: taskId, body: "", mode: "single",
    status: "running", agentType: "codex", useWorktree: false, createdAt: stamp, updatedAt: stamp,
  } as never);
  const dir = join(root, "runs", taskId);
  mkdirSync(dir, { recursive: true });
  const turnStart = new Date().toISOString();
  const output = join(dir, "raw-out.jsonl");
  writeFileSync(output, "");
  writeFileSync(join(dir, "raw-err.jsonl"), "");
  const idle = spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], { stdio: ["pipe", "ignore", "ignore"] });
  const detached = makeDetachedChild({
    pid: idle.pid!, paths: { out: output, err: join(dir, "raw-err.jsonl"), rc: join(dir, "rc") }, startOffset: 0,
    stdin: idle.stdin!, kill: () => idle.kill("SIGKILL"), onExit: (callback: (code: number) => void) => idle.once("close", (code) => callback(code ?? 1)),
  } as never);
  await db.insert(sessions).values({
    id: sessId, taskId, role: "single", agentType: "codex", executor: "codex", cwd: root,
    startedAt: turnStart, turnStartedAt: turnStart, cliSessionId: `th-${taskId}`, agentOffset: 0,
  } as never);
  openTurnProgress(taskId, sessId, turnStart); // 参与证明在 = 记号不在就是「确证零进展」
  const watch = join(dir, "progressed", `${sessId}-${turnStart.replace(/[^0-9]/g, "")}.watch`);
  if (opts.hideProof) renameSync(watch, `${watch}.hidden`);
  const handle = openCodexAppServer({
    bin: "codex", args: [], cwd: root, prompt: "", sessionId: `th-${taskId}`,
    reattach: { threadId: `th-${taskId}`, turnId: `turn-${taskId}`, evidence: "started" }, startProcess: () => detached,
  } as never);
  const consuming = consumeSingleRun({
    taskId, sessId, agentType: "codex", ex: new CodexExecutor(), cwd: root, handle,
    out: createWriteStream(join(dir, `${sessId}.md`)), turnStart,
    cliSessionId: `th-${taskId}`, autoTitle: false, adopted: true,
  } as never);
  const trace = () => {
    const path = join(dir, `${sessId}.trace.jsonl`);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  return { turnStart, output, idle, consuming, trace, restoreProof: () => renameSync(`${watch}.hidden`, watch) };
}

console.log("① 合并缓冲有最长滞留:攒不够阈值的增量也会自己收口");
{
  const queue = eventQueue({ coalesce: { thinking: 240 }, maxHoldMs: 150 });
  queue.delta("thinking", "working");
  const seen: string[] = [];
  const draining = (async () => { for await (const event of queue.drain()) if (event.kind === "thinking") seen.push(event.text); })();
  await sleep(400);
  check(seen.join("") === "working", `不到 240 字的思考 400ms 内就交给了下游(${JSON.stringify(seen)});上一版一直压着`);
  queue.close();
  await draining;
}

console.log("② 单飞消费链:进展记号落盘之前水位不动,落盘之后才追上;不误判成零输出");
{
  configure({ silentWarnMs: 0, silentTripMs: 2_500, pollMs: 100 });
  const taskId = "t-boundary";
  const sessId = "s-boundary";
  const { turnStart, output, idle, consuming, trace } = await adoptCase(taskId, sessId);
  const offset = async () => (await db.select().from(sessions).where(eq(sessions.id, sessId))).at(0)!.agentOffset;

  // 先只有一行**不算进展**的协议输出:字节有了,进展没有。
  appendFileSync(output, JSON.stringify({ method: "thread/status/changed", params: { threadId: `th-${taskId}` } }) + "\n");
  await sleep(1_300);
  check(statSync(output).size > 0 && (await offset()) === 0,
    `进展记号落盘之前水位一个字节都不动(offset=${await offset()},原始 ${statSync(output).size} 字节);上一版按读到的换行推进`);

  // 一段不到 240 字的思考,然后安静。
  appendFileSync(output, JSON.stringify({ method: "item/reasoning/textDelta", params: { threadId: `th-${taskId}`, itemId: "r-1", delta: "working" } }) + "\n");
  for (let i = 0; i < 60 && turnProgress(taskId, sessId, turnStart) !== "seen"; i += 1) await sleep(50);
  check(turnProgress(taskId, sessId, turnStart) === "seen",
    "那段思考在协议层读到之后很快就落成了进程外的进展记号(上一版压在缓冲里,一直是 none)");
  await sleep(1_300);
  check((await offset()) === statSync(output).size,
    `记号落盘之后水位追上(offset=${await offset()} / ${statSync(output).size})`);
  await sleep(700); // 合计已过静默熔断时限(2.5 秒)
  const traceText = trace();
  check(!traceText.includes("自动终止") && !traceText.includes("没真正跑起来"),
    "说过话的回合没有被当成「从头到尾没有输出」熔断");
  idle.kill("SIGKILL");
  await Promise.race([consuming, sleep(5_000)]);
}

console.log("③ 接管时进展历史读不出来:只警告、亮红环,不借「整轮零产出」熔断");
{
  configure({ silentWarnMs: 200, silentTripMs: 400, pollMs: 50 });
  const turn = new Date(Date.now() - 90 * 60_000).toISOString(); // 升级前就开始的一轮
  const owner = {};
  const watch = spy("t-unverified");
  watchAdoptedSilence("s-unverified", owner, turn, watch.actions, new Date().toISOString());
  await sleep(900);
  check(watch.log.warns.length === 1 && /接管/.test(watch.log.warns[0]!.text) && !/没真正跑起来/.test(watch.log.warns[0]!.text),
    "到阈值警告一次,措辞只说「接管以来」那段亲眼所见");
  check(watch.log.projects.length >= 1, "红环投影出去了(刷新后仍能看出)");
  check(watch.log.trips.length === 0, `过了熔断时限也不终止(trips=${watch.log.trips.length});上一版按零产出判失败`);
  trackTurnStall("s-unverified", owner, turn, { kind: "thinking", text: "still here" }, watch.actions);
  check(watch.log.resolves.length === 1, "一有进展就撤掉");
  clearTurnStall("s-unverified", owner);
}

console.log("④ 接管时读不出、恢复后读出「确证零进展」→ 换回正常静默档并按时熔断(第 2 轮自由审查 F1)");
{
  // 状态机那一层:只警告的观察被确认之后,钟回到回合真实起点、熔断责任恢复。
  configure({ silentWarnMs: 200, silentTripMs: 400, pollMs: 50 });
  const turn = new Date(Date.now() - 90 * 60_000).toISOString();
  const owner = {};
  const watch = spy("t-confirmed");
  watchAdoptedSilence("s-confirmed", owner, turn, watch.actions, new Date().toISOString());
  await sleep(300);
  check(watch.log.warns.length === 1 && watch.log.trips.length === 0, "前提:核实不了期间只警告");
  check(confirmTurnSilence("s-confirmed", owner, turn), "读出 none → 就地换档");
  await sleep(150);
  check(watch.log.trips.length === 1 && /没真正跑起来/.test(watch.log.trips[0]!),
    `换档后按整轮静默算,当场熔断(trips=${watch.log.trips.length});上一版永远只警告`);
  check(watch.log.warns.length === 2 && /回合无输出/.test(watch.log.warns[1]!.text), "警告按确证零输出的措辞重报一次");
  check(!confirmTurnSilence("s-confirmed", owner, turn), "只换一次(已经不背未知豁免了)");
  clearTurnStall("s-confirmed", owner);

  // 真实消费链:接管那一刻证明被挪走,随后放回(完整、无记号 = 确证零进展),回合始终无输出。
  configure({ silentWarnMs: 600, silentTripMs: 1_600, pollMs: 100 });
  const blind = await adoptCase("t-restored-none", "s-restored-none", { hideProof: true });
  await sleep(200);
  check(turnProgress("t-restored-none", "s-restored-none", blind.turnStart) === "unreadable", "前提:接管时证明读不到");
  blind.restoreProof();
  check(turnProgress("t-restored-none", "s-restored-none", blind.turnStart) === "none", "前提:证明恢复后读出确证零进展");
  // 消费链自己按默认 2 秒重读;读出 none 之后换档,已过 1.6 秒熔断时限 → 下一拍就终止。
  for (let i = 0; i < 100 && !blind.trace().includes("已自动终止"); i += 1) await sleep(50);
  check(blind.trace().includes("已自动终止"), "零输出回合被自动终止(上一版:恢复后仍永远进行中,只能手动停)");
  for (let i = 0; i < 60 && blind.idle.exitCode === null && blind.idle.signalCode === null; i += 1) await sleep(50);
  check(blind.idle.exitCode !== null || blind.idle.signalCode !== null, "进程真的被收掉了");
  blind.idle.kill("SIGKILL");
  await Promise.race([blind.consuming, sleep(5_000)]);
}

if (failures) {
  console.error(`\n✗ ${failures} 项未通过`);
  process.exit(1);
}
console.log("\n✓ 进展边界全部通过");
process.exit(0);
