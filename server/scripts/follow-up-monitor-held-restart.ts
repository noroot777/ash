// test-follow-up-monitor-held.ts ⑦ 的后半段:**一个全新的进程**接着同一个库,模拟 ash 在任务暂停等
// 哨兵期间重启。进程级的东西(内存里的回合锁、队列占位前的状态表、投递账本)一律从零开始,
// 「续聊前是哪个状态」只能从库里读回来。
//
// 照开机顺序跑对账和哨兵接回,再把那条哨兵的结束通知送出去,由真实投递把任务叫醒;起 CLI 那一步
// 换成假执行器(醒来那一回合什么都不做、正常结束)。最后一行打印结果给父进程断言。
//
// 用法(父进程替你传):node --import tsx follow-up-monitor-held-restart.ts <taskId> <monitorId>,
// ASH_DB / ASH_RUNS_DIR 指向父进程那份临时库。
import { eq } from "drizzle-orm";
import type { AgentEvent } from "@ash/shared";
import type { RunHandle, RunOpts } from "../src/executors/types.js";
import { requireTmpDb } from "./tmp-db.js";

const [taskId, monitorId] = process.argv.slice(2);
if (!taskId || !monitorId) throw new Error("用法:follow-up-monitor-held-restart.ts <taskId> <monitorId>");
requireTmpDb("follow-up-held-restart");
delete process.env.ASH_LAX_DONE;
delete process.env.ASH_ALLOW_REAL_AGENT;

const { db, ensureSchema } = await import("../src/db/index.js");
const { tasks } = await import("../src/db/schema.js");
const { ClaudeExecutor } = await import("../src/executors/claude.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
const { reconcileInterrupted } = await import("../src/task-reconcile.js");
const { reattachMonitors, detachAllMonitors } = await import("../src/monitors.js");
const { deliverResultHandoff } = await import("../src/monitor-events.js");
const runs = await import("../src/runs.js");

const inputs: string[] = [];
const run = (opts: RunOpts): RunHandle => {
  inputs.push(opts.prompt);
  return {
    sessionId: `native-${taskId}`, commandLine: "follow-up held restart fixture; no CLI", kill() {},
    events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { kind: "session", cliSessionId: `native-${taskId}` };
      yield { kind: "done", exitStatus: 0 };
    })(),
  };
};
for (const executor of [ClaudeExecutor.prototype, CodexExecutor.prototype]) {
  executor.run = run;
  executor.runSteerable = run;
}

await ensureSchema();
await reconcileInterrupted();
await reattachMonitors();
await deliverResultHandoff(monitorId);

const status = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.status;
const deadline = Date.now() + 30_000;
while (!(inputs.length && !runs.isTurnClaimed(taskId) && !runs.isRunning(taskId) && await status() !== "running")) {
  if (Date.now() > deadline) throw new Error(`重启后一直没被叫醒或没结算:${await status()} ${JSON.stringify(inputs)}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
}
detachAllMonitors();
console.log(JSON.stringify({ status: await status(), inputs }));
process.exit(0);
