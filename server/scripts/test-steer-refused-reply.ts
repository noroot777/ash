// **引导请求必须有终局答复** —— 即使新方向被协议层拒收、租约也已经被别人还掉了。
// 跑:npm -w server run test:undriven-turn(同一条命令里接着跑)
//
// 第 1 轮自由审查 F3(真实 HTTP 实测):给运行中的任务发一条要换模型的新方向,新执行器在
// initialize 就退出 —— 协议层确证拒收,租约那一条路自己把租约还掉了。而引导那一侧拿
// `callerMustReturn()`(「这张租约该不该由我归还」)兼任「请求答复了没有」:拒收且已经还成
// 也答假,于是正常返回那一支直接退出,那句 409 一次都没走到;回执那一支对拒收又不答复。任务
// 早已显示失败,引导按钮却一直等下去。
//
// 这一份只钉那一个出口:**拒收无论由谁归还,请求都要答失败**。
if (process.platform === "win32") {
  console.log("test:steer-refused-reply 跳过：夹具是 #!/bin/sh 的假 codex，Windows 覆盖要上真机（根 AGENTS.md）");
  process.exit(0);
}

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-steer-refused-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_UPLOADS_DIR = join(root, "uploads");
process.env.CODEX_HOME = join(root, "codex-home");
// 设了 ASH_RUNS_DIR 会触发 guardAgentSpawn 的测试隔离闸;本文件跑的是自己装在 PATH 上的
// 假 codex,显式放行(executors/spawn.ts)。
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.env.ASH_LAX_DONE = "1";
process.env.ASH_TURN_INPUT_ACK_MS = "1000";
process.env.ASH_CODEX_TURN_START_ACK_MS = "1000";
const originalPath = process.env.PATH;

// 假 codex:mode 文件决定这一次起跑怎么走。`hold` = 照常起跑并挂着一个长工具(等新方向),
// `refuse` = 读到第一行就退出(initialize 被拒,回合输入一个字都没出去)。
const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });
const modeFile = join(bin, "mode");
const shim = join(bin, "app-server.mjs");
writeFileSync(shim, `
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const mode = readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const THREAD = "th-steer", TURN = "turn-steer";
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (mode === "refuse") process.exit(7);
  if (message.id === undefined) return;
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: THREAD } } }); return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: TURN } } });
    send({ method: "turn/started", params: { threadId: THREAD, turn: { id: TURN } } });
    send({ method: "item/started", params: { threadId: THREAD, turnId: TURN,
      item: { type: "commandExecution", id: "long", command: "wait-for-new-direction" } } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "interrupted" } } });
    return;
  }
  send({ id: message.id, result: {} });
});
setInterval(() => {}, 1000);
`);
writeFileSync(join(bin, "codex"),
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(shim)} "$@"\n`, { mode: 0o755 });
writeFileSync(modeFile, "hold");
process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, scheduledMessages, tasks } = await import("../src/db/schema.js");
const { continueTask } = await import("../src/orchestrator.js");
const { pendingMessageRow, cancelPendingMessage } = await import("../src/pending-messages.js");
const { steerQueuedMessage } = await import("../src/task-steer.js");
const runs = await import("../src/runs.js");
const { sleep } = await import("./stall-fixtures.js");
const { eq } = await import("drizzle-orm");
await ensureSchema();

let failures = 0;
const ok = (line: string) => console.log(`   ✓ ${line}`);
const fail = (line: string) => { failures += 1; console.error(`   ✗ ${line}`); };
const check = (cond: boolean, line: string) => (cond ? ok(line) : fail(line));

const taskId = "t-steer-refused";
const stamp = new Date().toISOString();
await db.insert(projects).values({ id: "p-steer", name: "steer", repoPath: root, createdAt: stamp } as never);
mkdirSync(join(root, "runs", taskId), { recursive: true });
await db.insert(tasks).values({
  id: taskId, projectId: "p-steer", title: taskId, body: "initial work", mode: "single",
  status: "paused", agentType: "codex", useWorktree: false, createdAt: stamp, updatedAt: stamp,
} as never);

console.log("① 换模型的新方向被协议层拒收 → 引导请求照样答复失败(第 1 轮自由审查 F3)");
const initial = continueTask(taskId, "initial work").catch(() => undefined);
for (let i = 0; i < 200 && !runs.isRunning(taskId); i += 1) await sleep(20);
check(runs.isRunning(taskId), "前提:原回合真的在跑(挂着一个长工具)");
await sleep(300);

writeFileSync(modeFile, "refuse"); // 替换回合的新进程在 initialize 就退出 → 确证拒收
// 换模型 = 换进程才生效,走「停旧回合、开新回合」那条路,而不是原生 steer。
const row = pendingMessageRow({ taskId, text: "新方向:换个模型接着做", mode: "queued", model: "other-model" } as never);
await db.insert(scheduledMessages).values(row as never);
let reply: Awaited<ReturnType<typeof steerQueuedMessage>> | "pending" = "pending";
const request = steerQueuedMessage(row.id).then((result) => { reply = result; });
for (let i = 0; i < 300 && reply === "pending"; i += 1) await sleep(20);
const message = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, row.id))).at(0)!;
check(reply !== "pending",
  `请求有了终局答复(6 秒内);上一版:拒收且租约已还 → 直接返回,按钮一直等下去`);
const answered = reply as Exclude<typeof reply, "pending">;
check(answered !== "pending" && answered.ok === false && answered.status === 409,
  `答的是失败(${answered === "pending" ? "没答" : JSON.stringify(answered)}),不是「已送达」`);
check(answered !== "pending" && !answered.ok && /拒收/.test(answered.error),
  "措辞如实说是协议层拒收、消息仍在排队");
// 不比租约:引导一失败任务就空了,周期扫描会立刻把这条重新领走开下一次投递 —— 那张租约是
// 新的一次,不是这一次没还(「旧的那次还没还」在 test-delivery-receipt.ts §⑤ 按身份钉)。
check(message.status === "pending" && !message.sentAt,
  `消息仍在待发送、没有被标成已送达(status=${message.status}, sentAt=${message.sentAt ?? "无"})`);

// 收场:取消这条(挡回那条路会自排重投,留着会再起一轮真 CLI),等替换回合彻底结束。
await cancelPendingMessage(message, "回归脚本收场").catch(() => undefined);
for (let i = 0; i < 250 && runs.isRunning(taskId); i += 1) await sleep(20);
await Promise.race([request, sleep(500)]);
await Promise.race([initial, sleep(2_000)]);

if (originalPath === undefined) delete process.env.PATH;
else process.env.PATH = originalPath;
if (failures) {
  console.error(`\n✗ ${failures} 项未通过`);
  process.exit(1);
}
console.log("\n✓ 引导请求终局答复全部通过");
process.exit(0);
