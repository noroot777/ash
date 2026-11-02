// **协议证据只许按它真说了什么下结论** —— 坏行不是否证,明确的 error 应答不是「说不上来」。
// 跑:npm -w server run test:undriven-turn(同一条命令里接着跑)
//
// 第 1 轮自由审查(ycH7vQQep_4A)的两条,方向相反、判据同源:
//   ① F2:恢复读取器把解析不了的行静默跳过,扫完没找到开始凭据就说 `never-started` —— 坏掉的
//     那一行里可能正是凭据。账本据此落 refused(确证一个字没进去),原文随即重投。
//   ② F3:`turn/start` 被服务端明确答了 error(-32602),适配器却把它抹成普通异常;账本只看
//     「写出去过」,落 unknown —— 租约永远留在在途,任务已经失败、再扫也领不走(实测)。
if (process.platform === "win32") {
  console.log("test:protocol-evidence 跳过：夹具是 #!/bin/sh 的假 codex，Windows 覆盖要上真机（根 AGENTS.md）");
  process.exit(0);
}

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-protocol-evidence-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_UPLOADS_DIR = join(root, "uploads");
process.env.CODEX_HOME = join(root, "codex-home");
process.env.ASH_ALLOW_REAL_AGENT = "1"; // 跑的是自己装在 PATH 上的假 codex(executors/spawn.ts)
process.env.ASH_LAX_DONE = "1";
process.env.ASH_TURN_INPUT_ACK_MS = "5000";
process.env.ASH_DELIVERY_RETRY_MS = "200";
const originalPath = process.env.PATH;

const { installFakeCodexAppServer, codexMode, turnStarts, resetTurnStarts } = await import("./undriven-turn-fixture.js");
const fakeBin = installFakeCodexAppServer(root);
process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, scheduledMessages, sessions, tasks } = await import("../src/db/schema.js");
const { readCodexAppServerState } = await import("../src/executors/codex-app-server-state.js");
const { CodexRpcRefusal, createTurnInputLedger } = await import("../src/executors/codex-app-server-adopt.js");
const { deliverPendingMessages, pendingMessageRow, cancelPendingMessage } = await import("../src/pending-messages.js");
const runs = await import("../src/runs.js");
const { sleep } = await import("./stall-fixtures.js");
const { eq } = await import("drizzle-orm");
await ensureSchema();

let failures = 0;
const ok = (line: string) => console.log(`   ✓ ${line}`);
const fail = (line: string) => { failures += 1; console.error(`   ✗ ${line}`); };
const check = (cond: boolean, line: string) => (cond ? ok(line) : fail(line));

console.log("① 恢复读取器:读到了但有坏行、又没找到凭据 → 说不上来,不是「确证没启动」(F2)");
{
  const write = (name: string, lines: string[]) => {
    const path = join(root, name);
    writeFileSync(path, lines.join("\n"));
    return path;
  };
  const resumed = JSON.stringify({ id: 2, result: { thread: { id: "th" } } });
  const started = JSON.stringify({ method: "turn/started", params: { threadId: "th", turn: { id: "t1" } } });
  check(readCodexAppServerState(write("clean.jsonl", [resumed, ""]), "th").evidence === "never-started",
    "整份都解析得了、确实没有凭据 → never-started(否证照旧成立)");
  check(readCodexAppServerState(write("corrupt.jsonl", [resumed, "{\"method\":\"turn/sta\u0000rted", ""]), "th").evidence === "unreadable",
    "中间一行坏了、没有凭据 → unreadable(上一版:never-started → 账本落 refused → 重投)");
  check(readCodexAppServerState(write("partial.jsonl", [resumed, "{\"method\":\"turn/started\",\"par"]), "th").evidence === "unreadable",
    "最后一行还没写完 → unreadable(那半行可能正是开始凭据)");
  check(readCodexAppServerState(write("mixed.jsonl", [resumed, "garbage", started, ""]), "th").evidence === "started",
    "坏行旁边找到了凭据 → started(肯定凭据优先,坏行不翻盘)");
}

console.log("② 输入账本:只有承载输入的那个请求被明确答 error 才算拒收(F3)");
{
  const settleWith = async (prep: (ledger: ReturnType<typeof createTurnInputLedger>) => void) => {
    const ledger = createTurnInputLedger();
    prep(ledger);
    return ledger.acceptance;
  };
  check(await settleWith((l) => { l.wrote(); l.failed(new CodexRpcRefusal("turn/start", "invalid")); }) === "refused",
    "turn/start 被明确答 error → refused(上一版:写出去过 → unknown,永久在途)");
  check(await settleWith((l) => { l.wrote(); l.failed(new Error("Codex turn/start 超时")); }) === "unknown",
    "超时/断链仍是 unknown(写出去了、不知道对面怎么样)");
  check(await settleWith((l) => { l.wrote(); l.failed(new CodexRpcRefusal("thread/goal/set", "boom")); }) === "unknown",
    "原生命令里别的请求报错不算拒收(那时输入可能已经开跑)");
  check(await settleWith((l) => { l.wrote(); l.reached(); l.failed(new CodexRpcRefusal("turn/start", "late")); }) === "accepted",
    "开始凭据已经到了 → accepted 单调,迟到的 error 不翻盘");
}

console.log("③ 真实投递链:turn/start 被明确拒绝 → 原文退回待发送、能被再次投出去(F3,实测形状)");
{
  const taskId = "t-rejected-turn";
  const stamp = new Date().toISOString();
  await db.insert(projects).values({ id: "p-evidence", name: "evidence", repoPath: root, createdAt: stamp } as never);
  mkdirSync(join(root, "runs", taskId), { recursive: true });
  await db.insert(tasks).values({
    id: taskId, projectId: "p-evidence", title: taskId, body: "", mode: "single",
    status: "paused", agentType: "codex", useWorktree: false, createdAt: stamp, updatedAt: stamp,
  } as never);
  codexMode(fakeBin, "reject-turn");
  resetTurnStarts(fakeBin);
  const row = pendingMessageRow({ taskId, text: "run exactly once", mode: "queued" } as never);
  await db.insert(scheduledMessages).values(row as never);
  await deliverPendingMessages(taskId);
  const spawned = async () => (await db.select().from(sessions).where(eq(sessions.taskId, taskId))).length > 0;
  for (let i = 0; i < 200 && !(await spawned()); i += 1) await sleep(25);
  check(await spawned(), "前提:真的起过一次 CLI");
  for (let i = 0; i < 200 && runs.isRunning(taskId); i += 1) await sleep(25);
  const read = async () => (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, row.id))).at(0)!;
  const refused = await read();
  check(refused.status === "pending" && !refused.sentAt, `被拒那一次没有落已送达(status=${refused.status})`);
  check(turnStarts(fakeBin) === 0, "被拒那一次不算执行");
  // 执行器恢复正常之后,这条消息必须还能被投出去 —— 上一版租约永远卡在在途,怎么扫都领不走。
  codexMode(fakeBin, "accept");
  let after = await read();
  for (let i = 0; i < 300 && after.status !== "sent"; i += 1) {
    if (!runs.isRunning(taskId)) await deliverPendingMessages(taskId);
    await sleep(50);
    after = await read();
  }
  check(after.status === "sent" && !!after.sentAt,
    `执行器恢复后原文被重新投出并落已送达(status=${after.status});上一版租约卡死在在途`);
  check(turnStarts(fakeBin) === 1, `只执行了一次(${turnStarts(fakeBin)} 次)`);
  if (after.status === "pending") await cancelPendingMessage(after, "回归脚本收场").catch(() => undefined);
  for (let i = 0; i < 200 && runs.isRunning(taskId); i += 1) await sleep(25);
}

if (originalPath === undefined) delete process.env.PATH;
else process.env.PATH = originalPath;
if (failures) {
  console.error(`\n✗ ${failures} 项未通过`);
  process.exit(1);
}
console.log("\n✓ 协议证据分类全部通过");
process.exit(0);
