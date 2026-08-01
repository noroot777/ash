// 单飞任务「跑一回合」的两件核心事：**消费事件流** 与 **结算落位**。
//
// 从 orchestrator.ts 拆出来（那边已经超过 700 行的单文件上限）。依赖方向是
// 单向的：orchestrator / reattach 都 import 这里，这里不回头 import 它们 ——
// 结算规则是全局单点，谁也不该另造一份。
import type { WriteStream } from "node:fs";
import { eq, sql } from "drizzle-orm";
import type { AgentEvent, AgentType } from "@harness/shared";
import { db } from "./db/index.js";
import { tasks, sessions } from "./db/schema.js";
import { bus } from "./bus.js";
import { now } from "./util.js";
import { setTaskStatus } from "./status.js";
import { takeStopped, takeConfirmed, type StopSettle } from "./runs.js";
import type { AgentExecutor, RunHandle } from "./executors/types.js";
import { appendSessionTrace, writeTurnEnd, writeRunError } from "./transcript.js";
import { notifyTeamLead } from "./team/inbox.js";
import { handleTaskSettlement } from "./review.js";
import { FOLLOW_UP_LABEL } from "./labels.js";


async function setStatus(taskId: string, status: Parameters<typeof setTaskStatus>[1]) {
  await setTaskStatus(taskId, status);
}

export async function afterSettlement(taskId: string, status: "canceled" | "paused" | "done" | "failed", confirmedDone: boolean) {
  try {
    await handleTaskSettlement(taskId, status, confirmedDone);
  } catch (error) {
    // Review orchestration is a post-settlement side effect. A failure here must
    // never rewrite an already-settled worker/reviewer status.
    console.error(`[harness] review settlement hook failed for ${taskId}:`, error);
  }
}

// 任务跑完一回合时的状态落位：续聊回合(followUpFrom 非空) → 除非确认完成,否则
// 回到续聊前的终态；手停 → canceled；分组暂停停 → paused（恢复分组时
// 队列 head 还是它，从原 CLI 会话续跑，而不是被当 canceled 跳过去启动下一个）；
// agent 在本回合内调过 ask_question（留下 question） → paused 且队列挂起等答复；
// 调过 pause_task（写下 resumePrompt） → paused，等依赖满足或用户手动 resume；
// 退出码非 0 → failed。exit 0 走严格 done
// 协议：agent 必须在回合内调过 complete_task 确认
// 「目标真的达成了」才落 done —— exit 0 只证明 CLI 进程正常退出,agent 报错后
// 退出照样 exit 0,假 done 会误推进队列、错误唤醒下游。未确认 → failed(重试
// 会 resume 续跑,代价低)。逃生口:HARNESS_LAX_DONE=1 退回「exit 0 即 done」
// (接没配 harness MCP 的 agent 时用)。一处算清楚,run / continue 共用。
// 队列推进：done / canceled / failed / paused 进 setTaskStatus 后会触发同 queue 推进。
// 返回落位状态 + note(未确认降级的说明,调用方写进时间线让用户知道为什么)。
const STRICT_DONE = !process.env.HARNESS_LAX_DONE;
const UNCONFIRMED_NOTE =
  "回合正常结束,但本回合内没有收到 complete_task 的完成确认 —— 按严格完成协议记为 failed。可能是 agent 没调用;也可能它调了但被拒(409,如任务状态在运行中被外部改动)。若任务其实已完成,可手动把状态改成已完成;重试则会从中断处续跑。";
const GROUP_PAUSED_NOTE =
  "分组被暂停,本回合被中止 —— 任务落为已暂停;点「运行/继续」恢复分组时会从当前会话接着跑。";
export async function settleTaskStatus(
  taskId: string,
  exitStatus: number,
  stopped: StopSettle | null,
): Promise<{
  status: "canceled" | "paused" | "done" | "failed";
  note?: string;
  confirmedDone: boolean;
}> {
  const memConfirmed = takeConfirmed(taskId); // 无条件消费,别让标记漏到下一回合
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  // 完成确认有两条道:同进程的内存标记,和落库的时间戳(complete_confirmed_at)。
  // 任一命中即算确认 —— 确认与结算未必在同一个进程里(历史事故:僵尸实例在跑这
  // 个回合,agent 的 complete_task 走 HTTP 打到了监听进程,内存标记落在别人家,
  // 结算这边什么都没看见,于是 agent 明明确认了却记 failed)。DB 那份无条件清掉。
  const confirmed = memConfirmed || !!t?.completeConfirmedAt;
  if (t?.completeConfirmedAt) {
    await db.update(tasks).set({ completeConfirmedAt: null, updatedAt: now() }).where(eq(tasks.id, taskId));
  }
  // 执行者结算 → 按需唤醒团队调度者(§Team)。只有提问、失败、以及 reportBack 的
  // done 会投递;普通 done 静默(UI 自己会更新,不花一轮模型调用)。非团队任务
  // (parentId 空)里 notifyTeamLead 直接返回。
  const notify = (kind: Parameters<typeof notifyTeamLead>[1], q?: string) => {
    if (!t) return;
    void notifyTeamLead(t, kind, q).catch((err) =>
      console.error(`[harness] notifyTeamLead(${taskId}) failed:`, err),
    );
  };
  // 续聊(follow-up)回合:任务早就是终态,这一轮是终态之后的对话,不是任务的执行。
  // 规则一句话:**续聊只能把任务变成 done(本回合亲口确认),不会让它变差** ——
  // 其余情况(没确认、异常退出、手停、组暂停)一律回到续聊前的那个终态。理由:
  // 用户给一个已完成的任务发条消息(「再发布一下」),不该因为 agent 这一轮没调
  // complete_task 就把 done 打成 failed;手停一轮闲聊也不该把它抹成 canceled。
  if (t?.followUpFrom) {
    const back = t.followUpFrom as "done" | "failed" | "canceled";
    await db.update(tasks).set({ followUpFrom: null, updatedAt: now() }).where(eq(tasks.id, taskId));
    if (confirmed) {
      await setStatus(taskId, "done");
      notify("done");
      return { status: "done", confirmedDone: true };
    }
    await setStatus(taskId, back);
    const label = FOLLOW_UP_LABEL[back] ?? back;
    if (t.question) {
      // 提问照常通知/展示(问题卡片不看状态),但不把终态改成 paused —— 那会让它
      // 重新占住队列位置。答复走 /answer,又是一个续聊回合。
      notify("question", t.question);
      return { status: back, note: `续聊回合以提问结束,等待答复:「${t.question}」(任务状态仍为「${label}」)`, confirmedDone: false };
    }
    if (stopped) {
      const why = stopped === "paused" ? "分组被暂停" : "被手动停止";
      return { status: back, note: `续聊回合${why},任务状态保持「${label}」不变。`, confirmedDone: false };
    }
    if (exitStatus !== 0) {
      return { status: back, note: `续聊回合异常结束(退出码 ${exitStatus}),任务状态保持「${label}」不变。`, confirmedDone: false };
    }
    return { status: back, confirmedDone: false };
  }
  if (stopped === "canceled") {
    await setStatus(taskId, "canceled");
    return { status: "canceled", confirmedDone: false };
  }
  if (stopped === "paused") {
    // 组暂停打断:落 paused 占住队列位置(组是 paused 的,推进钩子不会动)。
    // 恢复分组 → advanceQueue 选中它 → resumeOrRunTask 无 resumePrompt 走
    // RESUME_PROMPT 续原会话。若它被杀前调过 ask_question,question 仍在,
    // pickNextLaunchable 会继续挡住等答复——提问通知照发(团队调度者那边该
    // 知道它在等什么),不因组暂停而丢。
    await setStatus(taskId, "paused");
    if (t?.question) {
      notify("question", t.question);
      return { status: "paused", note: `本回合以提问暂停,等待答复:「${t.question}」`, confirmedDone: false };
    }
    return { status: "paused", note: GROUP_PAUSED_NOTE, confirmedDone: false };
  }
  // 提问优先于检查点:question 非空 → paused,但队列不推进、不自动续跑
  // (pickNextLaunchable 会挡住),等 answer_question 带答复唤醒。
  if (t?.question) {
    await setStatus(taskId, "paused");
    notify("question", t.question);
    return { status: "paused", note: `本回合以提问暂停,等待答复:「${t.question}」`, confirmedDone: false };
  }
  if (t?.resumePrompt) {
    await setStatus(taskId, "paused");
    return { status: "paused", confirmedDone: false };
  }
  if (exitStatus !== 0) {
    await setStatus(taskId, "failed");
    notify("failed");
    return { status: "failed", confirmedDone: false };
  }
  if (confirmed || !STRICT_DONE) {
    await setStatus(taskId, "done");
    notify("done");
    return { status: "done", confirmedDone: confirmed };
  }
  await setStatus(taskId, "failed");
  notify("failed_unconfirmed");
  return { status: "failed", note: UNCONFIRMED_NOTE, confirmedDone: false };
}

// 消费一次单飞运行的事件流，直到它结束，然后结算。
//
// **fresh run 与「重启后接管」共用这一份**——两条路只有前半段不同（一个是刚
// spawn 出来的 handle，一个是按 pid+offset 接回来的），从「读事件」这一步往后
// 完全一样。抄成两份的话，结算优先级、标题解析、.md 落盘这些迟早会漂。
// autoTitle=false 时跳过标题解析（接管路径必然已经解析过了）。
export async function consumeSingleRun(a: {
  taskId: string;
  sessId: string;
  agentType: AgentType;
  ex: AgentExecutor;
  cwd: string;
  handle: RunHandle;
  out: WriteStream;
  turnStart: string;
  cliSessionId: string;
  autoTitle: boolean;
}): Promise<void> {
  const { taskId, sessId, agentType, ex, out } = a;
  let cliSessionId = a.cliSessionId;
  let exitStatus = 0;
  let titleDone = !a.autoTitle; // when autoTitle, swallow text until the title line is parsed
  let head = "";
  const emitText = (text: string) => {
    if (!text) return;
    out.write(text);
    bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event: { kind: "text", text } });
  };
  const persistTrace = (event: AgentEvent, at?: string) => {
    if (event.kind === "thinking" || event.kind === "tool" || event.kind === "error") {
      appendSessionTrace(taskId, sessId, a.turnStart, event, at);
    }
  };

  // 定期把「已消费到哪个字节」写进库。真正重要的是**崩溃/被杀时**那一份——
  // 正常收尾会在下面再写一次终值。1s 一次：最坏情况重启后重放不到 1 秒的输出，
  // 而 offset 永远落在换行边界，所以重放只会重复整行、不会劈坏一行 JSON。
  const detached = a.handle.detached;
  const offsetTimer = detached
    ? setInterval(() => {
        void db
          .update(sessions)
          .set({ agentOffset: detached.committed() })
          .where(eq(sessions.id, sessId))
          .catch(() => {});
      }, 1000)
    : null;
  (offsetTimer as { unref?: () => void } | null)?.unref?.();

  try {
    for await (const event of a.handle.events) {
      if (event.kind === "session") {
        if (event.cliSessionId !== cliSessionId) {
          cliSessionId = event.cliSessionId;
          await db
            .update(sessions)
            .set({ cliSessionId, resumeCommand: ex.resumeCommand(a.cwd, cliSessionId) })
            .where(eq(sessions.id, sessId));
        }
        bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event });
        continue;
      }
      if (event.kind === "text" && !titleDone) {
        head += event.text;
        const nl = head.indexOf("\n");
        if (nl < 0) continue; // still buffering the first line
        const firstLine = head.slice(0, nl);
        const rest = head.slice(nl + 1);
        const m = firstLine.match(/标题[:：]\s*(.+)/);
        if (m) {
          const newTitle = m[1].trim().replace(/[`*"]/g, "").slice(0, 30);
          if (newTitle) {
            await db.update(tasks).set({ title: newTitle, autoTitle: false, updatedAt: now() }).where(eq(tasks.id, taskId));
            bus.publish({ type: "task.title", taskId, title: newTitle });
          }
        }
        titleDone = true;
        emitText(m ? rest : head); // matched: drop the title line; else flush buffer
        continue;
      }
      if (event.kind === "text") {
        out.write(event.text);
        bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event });
      } else {
        persistTrace(event);
        if (event.kind === "error") writeRunError(out, event.message);
        bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event });
        if (event.kind === "done") exitStatus = event.exitStatus;
      }
    }
  } finally {
    if (offsetTimer) clearInterval(offsetTimer);
  }
  if (!titleDone && head) emitText(head); // agent never produced a newline

  // A stop kills the subprocess → the stream ends like a normal exit; settle
  // by the stop kind (manual → canceled, group pause → paused) so it can be
  // re-run / continued.
  const stopped = takeStopped(taskId);
  const endIso = now();
  await db
    .update(sessions)
    .set({
      exitStatus,
      endedAt: endIso,
      activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${Math.max(0, Date.parse(endIso) - Date.parse(a.turnStart))}`,
      // 这一轮结束了，pid 不再有意义——留着会让下次重启去接一个早就没了的
      // 进程（或者更糟：pid 被复用后接到别人身上）。offset 留着供排查。
      agentPid: null,
      agentOffset: detached ? detached.committed() : null,
    })
    .where(eq(sessions.id, sessId));
  const settled = await settleTaskStatus(taskId, exitStatus, stopped);
  await afterSettlement(taskId, settled.status, settled.confirmedDone);
  if (settled.note) {
    // 诊断正文留在 .md 原始产物里；trace 负责刷新后的折叠块，SSE 负责实时显示。
    out.write(`\n> ${settled.note}\n`);
    persistTrace({ kind: "error", message: settled.note }, endIso);
    bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event: { kind: "error", message: settled.note } });
  }
  writeTurnEnd(out, endIso); // fence this turn's real end before closing the .md
  out.end();
}
