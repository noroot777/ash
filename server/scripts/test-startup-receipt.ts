// **spawn 之后本地记账失败,输入事实照样交给调用方** —— 不多执行一次,也不丢一段交代。
// 跑:npm -w server run test:undriven-turn(同一条命令里接着跑)
//
// 第 2 轮自由审查 F1(真实协议进程实测):起跑流程先 run(),再等会话持久化、清交接提示、
// 登记回合,**最后**才把协议回执交给调用方。中间任何一步抛了,catch 就把这份事实绕过去:
//   ① 排队消息:codex 已经收下了 turn/start,租约却拿不到定论 → 按「回执没来」归还重投,
//     同一句话进了两次 turn/start;
//   ② 续跑交代:codex 在 initialize 就拒收,`onInputReceipt` 却从没被调到,`undefined` 被读成
//     「执行器没有回执」→ accepted → 交代被消费掉。
// 两条都只对**第一笔** sessions INSERT 注入一次写失败,其余持久化照常。
if (process.platform === "win32") {
  console.log("test:startup-receipt 跳过：夹具是 #!/bin/sh 的假 codex，Windows 覆盖要上真机（根 AGENTS.md）");
  process.exit(0);
}

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-startup-receipt-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_UPLOADS_DIR = join(root, "uploads");
process.env.CODEX_HOME = join(root, "codex-home");
process.env.ASH_ALLOW_REAL_AGENT = "1"; // 跑的是自己装在 PATH 上的假 codex(executors/spawn.ts)
process.env.ASH_LAX_DONE = "1";
process.env.ASH_TURN_INPUT_ACK_MS = "1000";
process.env.ASH_CODEX_TURN_START_ACK_MS = "1000";
process.env.ASH_DELIVERY_RETRY_MS = "200";
const originalPath = process.env.PATH;

// 假 codex:`accept` = 收下 turn/start(记一笔)并很快收尾;`refuse` = 读到第一行就退出。
const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });
const modeFile = join(bin, "mode");
const startsFile = join(bin, "starts");
const shim = join(bin, "app-server.mjs");
writeFileSync(shim, `
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const mode = readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const THREAD = "th-startup", TURN = "turn-startup";
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (mode === "refuse") process.exit(7);
  if (message.id === undefined) return;
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: THREAD } } }); return;
  }
  if (message.method === "turn/start") {
    appendFileSync(${JSON.stringify(startsFile)}, "start\\n");
    send({ id: message.id, result: { turn: { id: TURN } } });
    send({ method: "turn/started", params: { threadId: THREAD, turn: { id: TURN } } });
    setTimeout(() => send({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "completed" } } }), 300);
    return;
  }
  send({ id: message.id, result: {} });
});
`);
writeFileSync(join(bin, "codex"),
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(shim)} "$@"\n`, { mode: 0o755 });
writeFileSync(startsFile, "");
process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, scheduledMessages, tasks } = await import("../src/db/schema.js");
const { pendingMessageRow, deliverPendingMessages, cancelPendingMessage } = await import("../src/pending-messages.js");
const { dispatchPendingMessage } = await import("../src/pending-dispatch.js");
const { resumeOrRunTask } = await import("../src/task-resume.js");
const runs = await import("../src/runs.js");
const { sleep } = await import("./stall-fixtures.js");
const { eq } = await import("drizzle-orm");
await ensureSchema();

let failures = 0;
const ok = (line: string) => console.log(`   ✓ ${line}`);
const fail = (line: string) => { failures += 1; console.error(`   ✗ ${line}`); };
const check = (cond: boolean, line: string) => (cond ? ok(line) : fail(line));
const starts = () => readFileSync(startsFile, "utf8").split("\n").filter(Boolean).length;

// 只让下一笔 sessions INSERT 失败一次(spawn 之后的第一件本地记账),其余照常。
const execute = dbClient.execute.bind(dbClient) as typeof dbClient.execute;
let armed = false;
let injected = 0;
dbClient.execute = (async (statement: unknown, ...rest: unknown[]) => {
  const sql = typeof statement === "string" ? statement : (statement as { sql?: string }).sql ?? "";
  if (armed && /^insert into "sessions"/i.test(sql)) {
    armed = false;
    injected += 1;
    await sleep(600); // 让协议那一侧先把 turn/start 应答完(实测的窗口)
    throw new Error("TEST_LOCAL_SESSION_PERSIST_UNAVAILABLE");
  }
  return (execute as (...args: unknown[]) => unknown)(statement, ...rest);
}) as typeof dbClient.execute;

const stamp = new Date().toISOString();
await db.insert(projects).values({ id: "p-startup", name: "startup", repoPath: root, createdAt: stamp } as never);
const makeTask = async (id: string) => {
  mkdirSync(join(root, "runs", id), { recursive: true });
  await db.insert(tasks).values({
    id, projectId: "p-startup", title: id, body: "", mode: "single",
    status: "paused", agentType: "codex", useWorktree: false, createdAt: stamp, updatedAt: stamp,
  } as never);
};
const settle = async (taskId: string) => {
  for (let i = 0; i < 250 && runs.isRunning(taskId); i += 1) await sleep(20);
};

console.log("① 排队消息:协议已收下、会话记账失败 → 记成已送达,不重投第二次");
{
  const taskId = "t-startup-queued";
  await makeTask(taskId);
  writeFileSync(modeFile, "accept");
  const row = pendingMessageRow({ taskId, text: "perform-operation-once", mode: "queued" } as never);
  await db.insert(scheduledMessages).values(row as never);
  armed = true;
  const at = Date.now();
  await dispatchPendingMessage(row as never, { spans: { dueAt: at, queuedAt: at, busyMs: 0 }, onClaim() {} } as never);
  check(injected === 1, "前提:spawn 之后那一笔会话记账真的失败了");
  check(starts() === 1, `前提:协议层收下了第一次 turn/start(${starts()} 次)`);
  await settle(taskId);
  // 给周期扫描几次机会:上一版在这里把消息领走、再起一轮。
  for (let i = 0; i < 6; i += 1) { await deliverPendingMessages(taskId); await sleep(150); await settle(taskId); }
  const message = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, row.id))).at(0)!;
  check(starts() === 1, `同一句话只进了一次 turn/start(实际 ${starts()} 次);上一版第二次投递又执行一遍`);
  check(message.status === "sent" && !!message.sentAt,
    `消息按协议事实记成已送达(status=${message.status}, sentAt=${message.sentAt ?? "无"})`);
  if (message.status === "pending") await cancelPendingMessage(message, "回归脚本收场").catch(() => undefined);
  await settle(taskId);
}

console.log("② 续跑交代:协议层拒收、会话记账失败 → 交代原样留在任务上,不被消费");
{
  const taskId = "t-startup-checkpoint";
  await makeTask(taskId);
  const prompt = "keep-this-checkpoint-after-refusal";
  await db.update(tasks).set({ resumePrompt: prompt } as never).where(eq(tasks.id, taskId));
  writeFileSync(modeFile, "refuse");
  const before = starts();
  armed = true;
  await resumeOrRunTask(taskId);
  await settle(taskId);
  check(injected === 2, "前提:spawn 之后那一笔会话记账真的失败了");
  check(starts() === before, "前提:回合输入一个字都没出去(协议层拒收)");
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  const consumed = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, taskId)))
    .filter((message) => message.status === "sent");
  check(task.resumePrompt === prompt,
    `交代还在任务上(resumePrompt=${JSON.stringify(task.resumePrompt)});上一版被当成已送达清空`);
  check(consumed.length === 0, `没有一张续跑凭证被记成已送达(${consumed.length} 张)`);
}

dbClient.execute = execute;
if (originalPath === undefined) delete process.env.PATH;
else process.env.PATH = originalPath;
if (failures) {
  console.error(`\n✗ ${failures} 项未通过`);
  process.exit(1);
}
console.log("\n✓ 起跑后记账失败的输入事实交接全部通过");
process.exit(0);
