// 重启后把还活着的 agent 接管回来。
//
// 单独成文件（而不是塞回 orchestrator）有两个理由：一是那边已超 700 行上限；
// 二是依赖方向能保持单向 —— 这里 import single-run 的消费循环，orchestrator
// 不 import 这里（它靠 runs.ts 的 isRunning 就能知道谁被接管了，不需要回引）。
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { AgentType } from "@harness/shared";
import { db } from "./db/index.js";
import { tasks, sessions } from "./db/schema.js";
import { trackRun, untrackRun } from "./runs.js";
import { resolveExecutorFor } from "./executors/index.js";
import { reattachDetachedAgent } from "./executors/detached.js";
import { RUNS_DIR } from "./paths.js";
import { consumeSingleRun } from "./single-run.js";

// 重启后接管那些**还活着**的 agent。必须在 reconcileInterrupted 之前跑：
// 接管成功的任务不该被当成「被打断」判 failed。返回已接管的 taskId 集合。
//
// 这就是整套解绑的收口：agent 的输出走文件（executors/detached.ts），所以它
// 压根没随 server 一起死；这里按 pid + 启动时间认回它，从上次消费到的字节位置
// 接着读，网页上输出继续往下滚，agent 自己全程不知道发生过重启。
//
// 认不回来的（进程真没了 / pid 被复用 / 这一轮本来就没走 detached）一律返回不
// 接管，交给 reconcileInterrupted 按老语义处理 —— 这是安全方向：宁可多判一次
// 中断（用户重试即可），也不能误接一个不是它的进程。
export async function reattachRunningTasks(): Promise<Set<string>> {
  const adopted = new Set<string>();
  const candidates = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ["running", "queued"]));
  for (const task of candidates) {
    if (task.mode !== "single") continue; // 团队调度台走 --resume 自动接回，不在这条路上
    const sess = (await db.select().from(sessions).where(eq(sessions.taskId, task.id)))
      .filter((s) => s.role === "single" && s.agentPid && s.agentOutPath && !s.endedAt)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .at(0);
    if (!sess?.agentPid || !sess.agentOutPath || !sess.agentErrPath || !sess.agentRcPath) continue;

    const child = reattachDetachedAgent({
      pid: sess.agentPid,
      startedAt: sess.agentStartedAt,
      paths: { out: sess.agentOutPath, err: sess.agentErrPath, rc: sess.agentRcPath },
      offset: sess.agentOffset ?? 0,
    });
    if (!child) continue; // 它已经不在了 → 交给 reconcileInterrupted

    try {
      const ex = await resolveExecutorFor({
        executorId: task.executorId,
        type: task.agentType as AgentType,
        model: task.model,
        reasoningEffort: task.reasoningEffort,
      });
      if (!ex.attach) {
        child.kill();
        continue; // 该执行器不支持接管：别让进程失联地跑着，停掉按中断处理
      }
      const handle = ex.attach(child, {
        sessionId: sess.cliSessionId ?? "",
        commandLine: sess.commandLine ?? "",
      });
      trackRun(task.id, handle);
      adopted.add(task.id);
      const out = createWriteStream(join(RUNS_DIR, task.id, `${sess.id}.md`), { flags: "a" });
      // 不 await：多个任务并行接管，各自跑各自的（跟正常运行时一样）。
      void consumeSingleRun({
        taskId: task.id,
        sessId: sess.id,
        agentType: task.agentType as AgentType,
        ex,
        cwd: sess.cwd ?? "",
        handle,
        out,
        turnStart: sess.turnStartedAt ?? sess.startedAt,
        cliSessionId: sess.cliSessionId ?? "",
        autoTitle: false, // 标题在被打断之前那一段就已经解析过了
      })
        .catch((err) => console.error(`[harness] 接管 ${task.id} 的消费循环出错:`, err))
        .finally(() => {
          untrackRun(task.id, handle);
        });
      console.log(`[harness] 接管仍在运行的 agent:任务 ${task.id} pid=${sess.agentPid}(从字节 ${sess.agentOffset ?? 0} 继续)`);
    } catch (err) {
      console.error(`[harness] 接管 ${task.id} 失败:`, err);
      adopted.delete(task.id);
    }
  }
  return adopted;
}
