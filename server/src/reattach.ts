// 重启后把还活着的 agent 接管回来。
//
// 单独成文件（而不是塞回 orchestrator）有两个理由：一是那边已超 700 行上限；
// 二是依赖方向能保持单向 —— 这里 import single-run 的消费循环，orchestrator
// 不 import 这里（它靠 runs.ts 的 isRunning 就能知道谁被接管了，不需要回引）。
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { AgentType, SessionRole } from "@harness/shared";
import { db } from "./db/index.js";
import { agents, tasks, sessions } from "./db/schema.js";
import { claimTurn, releaseTurn, trackRun, untrackRun } from "./runs.js";
import { resolveExecutorFor } from "./executors/index.js";
import { reattachDetachedAgent } from "./executors/detached.js";
import { RUNS_DIR } from "./paths.js";
import { consumeSingleRun } from "./single-run.js";
import { isSameProcess } from "./proc.js";
import { IS_WINDOWS } from "./platform.js";
import { findMcpChannelHolders } from "./mcp-holders.js";

// 「现在重启会打断谁」——给 scripts/restart.mjs 的安全闸用。
//
// 闸原来只数 running/queued 的**个数**，这个判据现在过时了：agent 输出走文件
// 之后大部分单飞任务重启根本不会断，闸却照样拦着不让重启，FORCE 的提示还在说
// 「判为 failed」——一句现在是假的话。判据要从「有几个在跑」改成
// 「**有几个是重启会真断的**」。
//
// 分四类，各自的依据都摆出来，别让调用方再猜：
//  · survives    单飞 + 有活着的 detached 进程 → 重启后按 pid+offset 接管，无感
//  · resumes     团队调度台 → 进程会断，但下次有人说话就 --resume 接回；
//                丢的是当前这一轮，不是整个任务
//  · interrupted 真会被判 failed 的：老代码起的（没 agent_pid）、queued 还没起
//                进程的、进程已经不在的
//  · mcpDisrupted survives 里**手上还握着 harness MCP 子进程**的那几个。重启
//                :4317 伤不到它们，但 restart.mjs 第 3 步杀旧 MCP 子进程时会当场掐断
//                它们的交卷通道（2026-08-06 那次验证白跑就是这么来的）。这一类
//                跟 survives 是**包含关系不是并列**：它们仍然活得过重启。
export type RestartImpact = {
  survives: { id: string; title: string; pid: number }[];
  resumes: { id: string; title: string }[];
  interrupted: { id: string; title: string; reason: string }[];
  mcpDisrupted: { id: string; title: string; pid: number }[];
};

export async function restartImpact(): Promise<RestartImpact> {
  const out: RestartImpact = { survives: [], resumes: [], interrupted: [], mcpDisrupted: [] };
  for (const t of await db.select().from(tasks).where(inArray(tasks.status, ["running", "queued"]))) {
    const label = { id: t.id, title: t.title || t.id };
    if (t.mode === "team") {
      out.resumes.push(label);
      continue;
    }
    if (t.status === "queued") {
      out.interrupted.push({ ...label, reason: "排队中，还没有进程可接管" });
      continue;
    }
    // Windows 没有 detached 跑法(见 reattachRunningTasks),所以这里一条都不会
    // survives。闸和真正接管必须用同一条判据 —— 少了这段,闸会说「无感」,重启完
    // 用户却发现任务全挂了。
    if (IS_WINDOWS) {
      out.interrupted.push({ ...label, reason: "Windows 上 agent 不走 detached 跑法，重启必断" });
      continue;
    }
    const sess = (await db.select().from(sessions).where(eq(sessions.taskId, t.id)))
      .filter((s) => (s.role === "single" || s.role === "reviewer") && !s.endedAt)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .at(0);
    if (!sess?.agentPid) {
      out.interrupted.push({ ...label, reason: "没有 agent_pid（旧代码起的，或走的不是 detached 跑法）" });
      continue;
    }
    // 跟真正接管时用**同一条**判据（pid + ps 启动时间）。用两套的话，闸说能接、
    // 接的时候又不认，用户放心重启完却发现任务挂了 —— 比不报还坏。
    if (!isSameProcess(sess.agentPid, sess.agentStartedAt)) {
      out.interrupted.push({ ...label, reason: `进程 ${sess.agentPid} 已不在` });
      continue;
    }
    out.survives.push({ ...label, pid: sess.agentPid });
  }
  const holders = await findMcpChannelHolders(out.survives.map((s) => s.pid));
  out.mcpDisrupted = out.survives.filter((s) => holders.has(s.pid));
  return out;
}

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
  // Windows 上 agent 从来不走 detached 跑法(executors/detached.ts 的 spawnForRun),
  // 没有一个进程是「输出走文件、活得过重启」的。这里必须**整段短路**而不是靠下面
  // 的字段判空兜住:session 上的 agent_pid / agent_out_path 照样有值(tee 那条路也
  // 记),接下去就会拿一个早已随 server 一起死掉的 pid 去认亲 —— pid 复用时甚至可
  // 能认到别人头上。宁可全部交给 reconcileInterrupted 判 failed。
  if (IS_WINDOWS) return adopted;
  const candidates = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ["running", "queued"]));
  for (const task of candidates) {
    if (task.mode !== "single") continue; // 团队调度台走 --resume 自动接回，不在这条路上
    const sess = (await db.select().from(sessions).where(eq(sessions.taskId, task.id)))
      .filter((s) => (s.role === "single" || s.role === "reviewer") && s.agentPid && s.agentOutPath && !s.endedAt)
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
      const profile = (await db.select({ id: agents.id }).from(agents).where(eq(agents.name, sess.executor))).at(0);
      const ex = await resolveExecutorFor({
        executorId: profile?.id ?? task.executorId,
        type: sess.agentType as AgentType,
        model: null,
        reasoningEffort: null,
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
      // 接管也要恢复 turn 的运行时身份：report_stage 只认 turnRole（claimTurn 落下的），
      // 不恢复的话接回的 reviewer 交卷必被拒，一条本可有结论的审查被错杀成异常失败。
      const claimedTurn = claimTurn(task.id, sess.role);
      const out = createWriteStream(join(RUNS_DIR, task.id, `${sess.id}.md`), { flags: "a" });
      // 不 await：多个任务并行接管，各自跑各自的（跟正常运行时一样）。
      void consumeSingleRun({
        taskId: task.id,
        sessId: sess.id,
        agentType: sess.agentType as AgentType,
        ex,
        cwd: sess.cwd ?? "",
        handle,
        out,
        turnStart: sess.turnStartedAt ?? sess.startedAt,
        cliSessionId: sess.cliSessionId ?? "",
        autoTitle: false, role: sess.role as SessionRole, // 标题在被打断之前那一段就已经解析过了
      })
        .catch((err) => console.error(`[harness] 接管 ${task.id} 的消费循环出错:`, err))
        .finally(() => {
          untrackRun(task.id, handle);
          if (claimedTurn) releaseTurn(task.id);
        });
      console.log(`[harness] 接管仍在运行的 agent:任务 ${task.id} pid=${sess.agentPid}(从字节 ${sess.agentOffset ?? 0} 继续)`);
    } catch (err) {
      console.error(`[harness] 接管 ${task.id} 失败:`, err);
      adopted.delete(task.id);
    }
  }
  return adopted;
}
