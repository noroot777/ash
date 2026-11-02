// **「有过进展」在协议层读到就算数,而且落盘之前水位不许越过它。**
// 跑:npm -w server run test:undriven-turn(同一条命令里接着跑)
//
// 第 1 轮自由审查(ycH7vQQep_4A)F1,实测:真实 detached 读取器 + codex 适配器 + 单飞消费链,
// 喂一条不到 240 字的思考增量(`working`)后保持安静 ——
//   · 那段思考压在合并缓冲里,下游一条进展都没看到,静默档照「从头到尾没有输出」熔断;
//   · 原始水位已经越过它(offset=114)、进展记号却还是 none —— 这时重启,新进程从 114 读起,
//     那段思考再也重放不到,又是「证明在、记号不在」= 确证零进展。
// 同一条的第三处:接管时进展历史读不出来,上一版借「整轮零产出」那一档,到时限照样判失败终止。
if (process.platform === "win32") {
  console.log("test:progress-boundary 跳过：真实 detached 读取器夹具只在 POSIX 上跑过（根 AGENTS.md）");
  process.exit(0);
}

import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const { clearTurnStall, trackTurnStall, watchAdoptedSilence } = await import("../src/turn-stall.js");
const { configure, spy, sleep } = await import("./stall-fixtures.js");
const { eq } = await import("drizzle-orm");
await ensureSchema();

let failures = 0;
const ok = (line: string) => console.log(`   ✓ ${line}`);
const fail = (line: string) => { failures += 1; console.error(`   ✗ ${line}`); };
const check = (cond: boolean, line: string) => (cond ? ok(line) : fail(line));

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
  const stamp = new Date().toISOString();
  await db.insert(projects).values({ id: "p-boundary", name: "boundary", repoPath: root, createdAt: stamp } as never);
  await db.insert(tasks).values({
    id: taskId, projectId: "p-boundary", title: taskId, body: "", mode: "single",
    status: "running", agentType: "codex", useWorktree: false, createdAt: stamp, updatedAt: stamp,
  } as never);
  mkdirSync(join(root, "runs", taskId), { recursive: true });
  const turnStart = new Date().toISOString();
  const output = join(root, "raw-out.jsonl");
  writeFileSync(output, "");
  writeFileSync(join(root, "raw-err.jsonl"), "");
  const idle = spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], { stdio: ["pipe", "ignore", "ignore"] });
  const detached = makeDetachedChild({
    pid: idle.pid!, paths: { out: output, err: join(root, "raw-err.jsonl"), rc: join(root, "rc") }, startOffset: 0,
    stdin: idle.stdin!, kill: () => idle.kill("SIGKILL"), onExit: (callback: (code: number) => void) => idle.once("close", (code) => callback(code ?? 1)),
  } as never);
  await db.insert(sessions).values({
    id: sessId, taskId, role: "single", agentType: "codex", executor: "codex", cwd: root,
    startedAt: turnStart, turnStartedAt: turnStart, cliSessionId: "th-b", agentOffset: 0,
  } as never);
  openTurnProgress(taskId, sessId, turnStart); // 参与证明在 = 记号不在就是「确证零进展」
  const handle = openCodexAppServer({
    bin: "codex", args: [], cwd: root, prompt: "", sessionId: "th-b",
    reattach: { threadId: "th-b", turnId: "turn-b", evidence: "started" }, startProcess: () => detached,
  } as never);
  const consuming = consumeSingleRun({
    taskId, sessId, agentType: "codex", ex: new CodexExecutor(), cwd: root, handle,
    out: createWriteStream(join(root, "runs", taskId, `${sessId}.md`)), turnStart,
    cliSessionId: "th-b", autoTitle: false, adopted: true,
  } as never);
  const offset = async () => (await db.select().from(sessions).where(eq(sessions.id, sessId))).at(0)!.agentOffset;

  // 先只有一行**不算进展**的协议输出:字节有了,进展没有。
  appendFileSync(output, JSON.stringify({ method: "thread/status/changed", params: { threadId: "th-b" } }) + "\n");
  await sleep(1_300);
  check(statSync(output).size > 0 && (await offset()) === 0,
    `进展记号落盘之前水位一个字节都不动(offset=${await offset()},原始 ${statSync(output).size} 字节);上一版按读到的换行推进`);

  // 一段不到 240 字的思考,然后安静。
  appendFileSync(output, JSON.stringify({ method: "item/reasoning/textDelta", params: { threadId: "th-b", itemId: "r-1", delta: "working" } }) + "\n");
  for (let i = 0; i < 60 && turnProgress(taskId, sessId, turnStart) !== "seen"; i += 1) await sleep(50);
  check(turnProgress(taskId, sessId, turnStart) === "seen",
    "那段思考在协议层读到之后很快就落成了进程外的进展记号(上一版压在缓冲里,一直是 none)");
  await sleep(1_300);
  check((await offset()) === statSync(output).size,
    `记号落盘之后水位追上(offset=${await offset()} / ${statSync(output).size})`);
  await sleep(700); // 合计已过静默熔断时限(2.5 秒)
  const trace = join(root, "runs", taskId, `${sessId}.trace.jsonl`);
  const traceText = existsSync(trace) ? readFileSync(trace, "utf8") : "";
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

if (failures) {
  console.error(`\n✗ ${failures} 项未通过`);
  process.exit(1);
}
console.log("\n✓ 进展边界全部通过");
process.exit(0);
