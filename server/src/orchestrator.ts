import { mkdirSync, createWriteStream, existsSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { AgentType } from "@harness/shared";
import { db } from "./db/index.js";
import { tasks, projects, sessions } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now, attachmentsPrompt } from "./util.js";
import { setTaskStatus } from "./status.js";
import { trackRun, untrackRun, takeStopped, takeConfirmed, type StopSettle } from "./runs.js";
import { taskWorkspace } from "./task-workspace.js";
import { resolveExecutorFor } from "./executors/index.js";
import type { RunHandle } from "./executors/types.js";
import { RUNS_DIR } from "./paths.js";
import { writeTurn as writeTurnLine, writeTurnEnd, writeRunError, runTracePaths } from "./transcript.js";
import { startTeam, deliverToLead } from "./team/session.js";
import { workerPreambleFor } from "./team/dispatch.js";
import { notifyTeamLead } from "./team/inbox.js";

const running = new Set<string>(); // taskIds currently executing (single-flight)

// Single tasks run headless — nobody can answer a mid-run prompt. Tell the agent
// to act autonomously rather than stall waiting for confirmation; if it genuinely
// needs input it can still ask, and the user replies via continueTask (resume).
const AUTONOMY =
  "你在一个无人值守的自动化环境中运行，没有人能实时回复你。请尽量自主完成：遇到多个合理方案时，选最稳妥的一个并在结果中说明假设与取舍；不要停下来等待人工确认，除非信息确实不足以继续。\n\n";

// Prefix for an agent invited into an existing task via @-mention. It joins in
// the SAME working directory, so it should read the current state before acting.
const COLLAB_INVITE =
  "你被叫来加入这个任务的协作。当前工作目录里可能已经有其他 agent 的产出，请先了解现状再动手。\n\n";

// When a task that was interrupted (server restart → failed, manual stop →
// canceled, group pause → paused, or a non-zero exit) is (re)started, we RESUME
// its existing CLI session with this nudge instead of re-running from scratch —
// the agent already holds the full prior context via --resume, so no AUTONOMY
// preamble.
const RESUME_PROMPT =
  "继续：你上一次的运行被中断了（可能是服务重启、被手动停止或所在分组被暂停）。请从中断处接着完成这个任务，先简要说明你已做到哪一步、还差什么，然后继续推进直到完成。";
// Backend-initiated continue leaves this trace in the timeline (distinct from a
// user reply), shown identically live (SSE) and on reload (.md).
const SYS_MARKER = "〔系统〕继续（从中断处）";

// A non-text interjection in the run timeline is persisted as one sentinel line
// (see transcript.ts) so live and reloaded views read identically.
function writeTurn(out: NodeJS.WritableStream, turn: { t: "user" | "system"; agent: AgentType; text: string }): void {
  writeTurnLine(out, turn, now());
}

// 完成协议前言(严格 done):告诉 agent 它的 taskId 和「必须亲口确认完成」的
// 规则。fresh run 用长版(第一回合,完整交代);reply/resume 回合用短版追加在
// 消息尾部(每回合都提醒,上下文再长 agent 也不至于忘)。
const STAGE_PROTOCOL = (taskId: string, sharedTeamWorker: boolean) => sharedTeamWorker
  ? `【阶段自报】实现完成后立即调用 report_stage(taskId="${taskId}", stage="implemented")。开始真实运行验证时报 verifying；验证通过报 verified；未通过报 verify_failed 并说明原因。验证完报 verified/verify_failed 即止，不上报 awaiting_acceptance/merged/accepted；合并与验收由团队级处理。这里的「验证」必须实际运行产物：web 项目要启动服务并用浏览器/截图确认行为，只读代码或只过编译不算验证。\n\n`
  : `【阶段自报】实现完成后立即调用 report_stage(taskId="${taskId}", stage="implemented")。开始真实运行验证时报 verifying；验证通过报 verified；未通过报 verify_failed 并说明原因；准备交给人工验收前报 awaiting_acceptance。后续完成合并/最终验收时分别报 merged/accepted。这里的「验证」必须实际运行产物：web 项目要启动服务并用浏览器/截图确认行为，只读代码或只过编译不算验证。\n\n`;
const STAGE_REMINDER = (taskId: string, sharedTeamWorker: boolean) => sharedTeamWorker
  ? `阶段自报:taskId=${taskId}；实现完成报 implemented，真实运行验证开始/通过/失败报 verifying/verified/verify_failed（失败要说明），验证完即止，不报 awaiting_acceptance/merged/accepted；合并与验收由团队级处理；web 验证需起服务并用浏览器/截图确认。`
  : `阶段自报:taskId=${taskId}；实现完成报 implemented，真实运行验证开始/通过/失败报 verifying/verified/verify_failed（失败要说明），交人工前报 awaiting_acceptance，后续合并/验收完成报 merged/accepted；web 验证需起服务并用浏览器/截图确认。`;
const ACCEPTANCE_REMINDER = (taskId: string, sharedTeamWorker: boolean) => sharedTeamWorker
  ? "验收辅路:本共享执行者不适用 accept_task；合并与验收由团队级处理。"
  : `验收辅路:只有用户明确表示「验收通过/可以合并」时，调用 accept_task(taskId="${taskId}")，不要自行运行 git merge、worktree remove 或 branch -d。`;
const COMPLETION_PROTOCOL = (taskId: string, sharedTeamWorker: boolean) =>
  `【完成协议】本任务在 harness 的 taskId 是 ${taskId}。当且仅当你确定任务目标已经达成时,在结束前调用 harness MCP 的 complete_task(taskId="${taskId}")确认完成;未确认就结束,本回合会按未完成记为 failed。跑到需要等待外部条件的检查点时,改用 pause_task 写下续跑指令。\n\n${STAGE_PROTOCOL(taskId, sharedTeamWorker)}${ACCEPTANCE_REMINDER(taskId, sharedTeamWorker)}\n\n`;
const COMPLETION_REMINDER = (taskId: string, sharedTeamWorker: boolean) =>
  `\n\n(harness 完成协议:taskId=${taskId}。若本回合结束时任务目标已达成,先调用 complete_task 确认再结束,否则按未完成记 failed;到等待检查点则用 pause_task。${STAGE_REMINDER(taskId, sharedTeamWorker)}${ACCEPTANCE_REMINDER(taskId, sharedTeamWorker)})`;

// 续聊(follow-up)回合的尾巴:任务早就到终态了,这一轮是「完成之后的对话」,
// 不该拿严格完成协议吓唬 agent(不确认就 failed)—— 这一轮不确认,任务状态原样
// 不动。只有它真把任务推进到新的完成时才需要确认。
const FOLLOW_UP_LABEL: Record<string, string> = { done: "已完成", failed: "失败", canceled: "已取消" };
const FOLLOW_UP_REMINDER = (taskId: string, from: string, sharedTeamWorker: boolean) =>
  `\n\n(harness:这是任务在「${FOLLOW_UP_LABEL[from] ?? from}」之后的续聊,taskId=${taskId}。任务状态不会因为本回合而改变,本回合不需要 complete_task;只有当你在这一轮把任务推进到了新的完成状态时,才调用 complete_task(taskId="${taskId}")确认。${STAGE_REMINDER(taskId, sharedTeamWorker)}${ACCEPTANCE_REMINDER(taskId, sharedTeamWorker)})`;

// The task's worktree was gone AND its branch with it, so we rebuilt an empty one.
// The CLI conversation lives outside the worktree (~/.claude/projects/<escaped
// cwd>/), so `--resume` hands the agent a full memory of files that no longer
// exist — it would happily "finish the last bit" on top of nothing. Break that
// continuity explicitly: the agent must re-read reality before acting. Shown to
// the user too (its own timeline bubble), since a silently reset workspace is
// exactly the kind of thing you must not discover at review time.
const WORKSPACE_RESET = (path: string) =>
  `\n\n〔重要·工作目录已重建〕本任务原来的 worktree 和分支都已不存在(被删除了),harness 刚在 ${path} 建了一个空的工作目录:` +
  `你在上文里创建或修改过的文件**现在全都不在了**,git 历史也回到了基线。请不要相信上文中「我已经改过某某文件」的记忆——` +
  `动手之前先实际看一遍当前目录(ls / git status / git log),据此重新判断还要做什么。`;
const WORKSPACE_RESET_MARKER = "〔系统〕原工作目录(worktree 与分支)已不存在，已重建为空目录并提醒 agent 重新确认现状";

// Why a task is being (re)started — only used to label the resume; all reasons
// behave the same (resume if there's a resumable session, else fresh). Note: a
// scheduled cron fire is NOT here — it always starts a fresh run via runTask
// (schedules.ts), so it never resumes. `wake` = an upstream task just settled
// done and the settle hook is auto-resuming this paused dependent.
export type ResumeReason = "group" | "run" | "retry" | "wake" | "queue";

async function setStatus(taskId: string, status: Parameters<typeof setTaskStatus>[1]) {
  await setTaskStatus(taskId, status);
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
async function settleTaskStatus(
  taskId: string,
  exitStatus: number,
  stopped: StopSettle | null,
): Promise<{ status: "canceled" | "paused" | "done" | "failed"; note?: string }> {
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
      return { status: "done" };
    }
    await setStatus(taskId, back);
    const label = FOLLOW_UP_LABEL[back] ?? back;
    if (t.question) {
      // 提问照常通知/展示(问题卡片不看状态),但不把终态改成 paused —— 那会让它
      // 重新占住队列位置。答复走 /answer,又是一个续聊回合。
      notify("question", t.question);
      return { status: back, note: `续聊回合以提问结束,等待答复:「${t.question}」(任务状态仍为「${label}」)` };
    }
    if (stopped) {
      const why = stopped === "paused" ? "分组被暂停" : "被手动停止";
      return { status: back, note: `续聊回合${why},任务状态保持「${label}」不变。` };
    }
    if (exitStatus !== 0) {
      return { status: back, note: `续聊回合异常结束(退出码 ${exitStatus}),任务状态保持「${label}」不变。` };
    }
    return { status: back };
  }
  if (stopped === "canceled") {
    await setStatus(taskId, "canceled");
    return { status: "canceled" };
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
      return { status: "paused", note: `本回合以提问暂停,等待答复:「${t.question}」` };
    }
    return { status: "paused", note: GROUP_PAUSED_NOTE };
  }
  // 提问优先于检查点:question 非空 → paused,但队列不推进、不自动续跑
  // (pickNextLaunchable 会挡住),等 answer_question 带答复唤醒。
  if (t?.question) {
    await setStatus(taskId, "paused");
    notify("question", t.question);
    return { status: "paused", note: `本回合以提问暂停,等待答复:「${t.question}」` };
  }
  if (t?.resumePrompt) {
    await setStatus(taskId, "paused");
    return { status: "paused" };
  }
  if (exitStatus !== 0) {
    await setStatus(taskId, "failed");
    notify("failed");
    return { status: "failed" };
  }
  if (confirmed || !STRICT_DONE) {
    await setStatus(taskId, "done");
    notify("done");
    return { status: "done" };
  }
  await setStatus(taskId, "failed");
  notify("failed_unconfirmed");
  return { status: "failed", note: UNCONFIRMED_NOTE };
}

// On (re)start nothing is actually running, so any task still in an in-flight
// status was interrupted (e.g. the server restarted mid-run). Mark those failed
// so they're recoverable via retry/reply instead of being stuck forever.
// awaiting_review is left alone — its gate can still be resolved after a restart.
// 例外一:团队任务(mode:"team")没有「失败」这回事 —— 调度台进程随 server 一起
// 死了,但 CLI 会话还在,下次有人说话就 --resume 接回。落 idle(待命)。
// 例外二:被打断的是续聊回合(followUpFrom 非空)→ 回到续聊前的终态,别把一个
// 早就完成的任务记成 failed。
// **逐个走 setTaskStatus 单点**(而不是一条 UPDATE 批量改):它维护
// startedAt/endedAt、广播 task.status,并且触发队列推进 —— 否则重启把队列 head
// 打成 failed 之后没有任何人去推,整条串行队列就一直停在那等(实测:重启后
// 后面的任务再也不会自动开始,得手点一次「运行分组」)。
export async function reconcileInterrupted(): Promise<void> {
  const orphaned = await db.select().from(tasks).where(inArray(tasks.status, ["running", "queued"]));
  if (!orphaned.length) return;
  const teamIds = orphaned.filter((t) => t.mode === "team").map((t) => t.id);
  const others = orphaned.filter((t) => t.mode !== "team");
  for (const t of others) {
    const back = (t.followUpFrom as "done" | "failed" | "canceled" | null) ?? "failed";
    if (t.followUpFrom || t.completeConfirmedAt) {
      await db
        .update(tasks)
        .set({ followUpFrom: null, completeConfirmedAt: null, updatedAt: now() })
        .where(eq(tasks.id, t.id));
    }
    await setTaskStatus(t.id, back);
  }
  for (const teamId of teamIds) await setTaskStatus(teamId, "idle");
  const followUps = others.filter((t) => t.followUpFrom).length;
  console.log(
    `[harness] reconciled ${others.length - followUps} interrupted task(s) → failed` +
      (followUps ? `, ${followUps} follow-up turn(s) → 原终态` : "") +
      (teamIds.length ? `, ${teamIds.length} team task(s) → idle` : ""),
  );
}

// M1: execute a single-agent task in the project's working dir, stream output over
// SSE, and persist a session credential (DESIGN.md §1/§4/§12/§13).
export async function runTask(taskId: string): Promise<void> {
  // 团队任务(§Team)走常驻调度台,不占单飞锁 —— 它的「一次运行」是整段常驻,
  // 不是一个回合。放在最前面,于是 /tasks/:id/run、retry、queue 推进都自动生效。
  const mode = (await db.select({ mode: tasks.mode }).from(tasks).where(eq(tasks.id, taskId))).at(0)?.mode;
  if (mode === "team") return startTeam(taskId);
  if (running.has(taskId)) return;
  running.add(taskId);
  let handle: RunHandle | undefined;
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) throw new Error("task not found");
    if (task.mode !== "single") throw new Error("debate mode runs in M4");

    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!project) throw new Error("project not found");

    // 新回合起点:清掉上一轮可能残留的完成确认/续聊标记(fresh run 从来不是续聊)。
    await db
      .update(tasks)
      .set({ followUpFrom: null, completeConfirmedAt: null, updatedAt: now() })
      .where(eq(tasks.id, taskId));
    await setStatus(taskId, "running");

    // Ordinary tasks resolve exactly as before. Team workers additionally inherit
    // their lead's shared workspace unless they explicitly request another worktree.
    const ws = await taskWorkspace(task, project.repoPath);
    const agentType = (task.agentType as AgentType) ?? "claude";
    const ex = await resolveExecutorFor({
      executorId: task.executorId,
      type: agentType,
      model: task.model,
      reasoningEffort: task.reasoningEffort,
    });

    const autoTitle = !!task.autoTitle;
    const TITLE_HINT =
      "请在正式开始前，第一行只输出：标题：<不超过14字、概括本次任务的简短标题>，然后换行，再正常完成下面的任务。\n\n任务：\n";
    const objective = task.body?.trim() || task.title;
    // 团队执行者多一段前言(卡住走 ask_question 直达调度者、别自己扩张边界)。
    // 只拼进 prompt,不写进 tasks.body —— body 是调度者给的需求正文,界面展示那份。
    const teamPreamble = await workerPreambleFor(task);
    const sharedTeamWorker = !task.useWorktree && teamPreamble.length > 0;
    const prompt =
      AUTONOMY + COMPLETION_PROTOCOL(taskId, sharedTeamWorker) + teamPreamble + (autoTitle ? TITLE_HINT + objective : objective);
    const turnStart = now();
    const sessId = id();
    const runDir = join(RUNS_DIR, taskId);
    mkdirSync(runDir, { recursive: true });
    handle = ex.run({ prompt, cwd: ws.path, trace: runTracePaths(runDir, sessId, turnStart) });
    trackRun(taskId, handle);

    let cliSessionId = handle.sessionId;
    const sessRow = {
      id: sessId,
      taskId,
      role: "single",
      agentType,
      executor: ex.label,
      target: "local",
      worktreePath: ws.isWorktree ? ws.path : null,
      branch: ws.branch,
      cwd: ws.path,
      cliSessionId,
      resumeCommand: ex.resumeCommand(ws.path, cliSessionId),
      relayEnv: ex.relayEnvHint ?? null,
      commandLine: handle.commandLine,
      startedAt: turnStart,
      turnStartedAt: turnStart,
      activeMs: 0,
      exitStatus: null as number | null,
    };
    await db.insert(sessions).values(sessRow);

    const out = createWriteStream(join(runDir, `${sessId}.md`), { flags: "a" });

    let exitStatus = 0;
    let titleDone = !autoTitle; // when autoTitle, swallow text until the title line is parsed
    let head = "";
    const emitText = (text: string) => {
      if (!text) return;
      out.write(text);
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event: { kind: "text", text } });
    };

    for await (const event of handle.events) {
      if (event.kind === "session") {
        if (event.cliSessionId !== cliSessionId) {
          cliSessionId = event.cliSessionId;
          await db
            .update(sessions)
            .set({ cliSessionId, resumeCommand: ex.resumeCommand(ws.path, cliSessionId) })
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
      if (event.kind === "text" || event.kind === "thinking") {
        out.write(event.text);
        bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event });
      } else {
        if (event.kind === "error") writeRunError(out, event.message);
        bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event });
        if (event.kind === "done") exitStatus = event.exitStatus;
      }
    }
    if (!titleDone && head) emitText(head); // agent never produced a newline

    // A stop kills the subprocess → the stream ends like a normal exit; settle
    // by the stop kind (manual → canceled, group pause → paused) so it can be
    // re-run / continued.
    const stopped = takeStopped(taskId);
    const endIso = now();
    await db
      .update(sessions)
      .set({ exitStatus, endedAt: endIso, activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${Math.max(0, Date.parse(endIso) - Date.parse(turnStart))}` })
      .where(eq(sessions.id, sessId));
    const settled = await settleTaskStatus(taskId, exitStatus, stopped);
    if (settled.note) {
      // 未确认降级为 failed:写进 .md(reload 可见)+ 广播(live 可见)
      out.write(`\n> ${settled.note}\n`);
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event: { kind: "error", message: settled.note } });
    }
    writeTurnEnd(out, endIso); // fence this turn's real end before closing the .md
    out.end();
  } catch (err) {
    bus.publish({
      type: "agent.event",
      taskId,
      sessionId: "",
      role: "single",
      event: { kind: "error", message: String(err instanceof Error ? err.message : err) },
    });
    await setStatus(taskId, takeStopped(taskId) ?? "failed");
  } finally {
    if (handle) untrackRun(taskId, handle);
    running.delete(taskId);
  }
}

// Decide between a fresh run and a resume when (re)starting a single task. A task
// that was interrupted keeps a session row with a cliSessionId (server restart
// leaves exitStatus null; manual stop / non-zero exit keep the id too) — resume
// THAT session so the agent continues from where it stopped, like the user typing
// 继续. A never-started task (no resumable session) runs fresh. paused 任务带着
// agent 写下的 resumePrompt 进来 —— 把它当作 user 输入回灌给 CLI 会话再清空，所以
// 不会反复触发同一段 prompt。Tail-returns the delegate so callers (esp. the
// scheduler) keep chaining on the same promise.
export async function resumeOrRunTask(
  taskId: string,
  opts: { reason?: ResumeReason } = {},
): Promise<void> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || task.mode !== "single") return runTask(taskId); // debates/missing → unchanged path
  // 检查点续跑：把 agent 写好的 resumePrompt 当作 user 消息丢回 continueTask，
  // 跑同一会话同一目录；先清空字段避免回合内再次 settle 时又被认成 paused。
  // 调度器会先把可启动任务标成 queued，因此这里不能只看 status === "paused"。
  if (task.resumePrompt) {
    const rp = task.resumePrompt;
    await db.update(tasks).set({ resumePrompt: null, updatedAt: now() }).where(eq(tasks.id, taskId));
    return continueTask(taskId, rp, { system: opts.reason ?? "run" });
  }
  const agent = (task.agentType as AgentType) ?? "claude";
  const prev = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
    .filter((s) => s.agentType === agent)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .at(0);
  if (prev?.cliSessionId) return continueTask(taskId, RESUME_PROMPT, { system: opts.reason ?? "run" });
  return runTask(taskId); // no resumable session → fresh
}

// Continue a single task. By default this resumes the task's own agent (answer
// an agent that stopped to ask). With opts.agent it targets another agent: if
// that agent already has a session here, resume it; otherwise invite it fresh
// into the SAME working directory (same-dir collaboration). Single-flight by
// taskId keeps invitees from running concurrently with the main agent.
export async function continueTask(
  taskId: string,
  userText: string,
  opts: { agent?: AgentType; attachments?: string[]; system?: ResumeReason } = {},
): Promise<void> {
  // 团队任务(§Team):插话直接写进常驻调度台的 stdin —— 即时、同一会话、用户侧
  // 感觉不断线。不占这里的单飞锁(那把锁是给「一次运行 = 一个回合」的单任务用的,
  // 调度台的一次运行是整段常驻)。于是 /reply、/answer、@提及全都自动生效。
  const teamMode = (await db.select({ mode: tasks.mode }).from(tasks).where(eq(tasks.id, taskId))).at(0)?.mode;
  if (teamMode === "team") return deliverToLead(taskId, userText, { attachments: opts.attachments });
  if (running.has(taskId)) return;
  running.add(taskId);
  const agentType = opts.agent ?? "claude"; // re-derived below once the task loads; kept for the catch handler
  let handle: RunHandle | undefined;
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) throw new Error("task not found");
    if (task.mode !== "single") throw new Error("reply is for single tasks");

    const agent = opts.agent ?? (task.agentType as AgentType) ?? "claude";
    const ex = await resolveExecutorFor({
      executorId: opts.agent ? null : task.executorId,
      type: agent,
      model: task.model,
      reasoningEffort: task.reasoningEffort,
    });
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);

    // A single task can now host several agents — one session line per agentType,
    // each invited via @-mention. Newest first.
    const all = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const prev = all.find((s) => s.agentType === agent); // this agent's own session, if any
    const resuming = !!prev?.cliSessionId;
    // 续聊(follow-up):任务已经到终态了,用户又发来一条消息 —— 这一轮是「任务
    // 之后的对话」,不是任务的执行。把续聊前的终态记下来:队列一律按它看待这个
    // 成员(既不算「有人在跑」冻住整条线,也不会被当成可启动项拉起来),结算时
    // 再回到它(见 settleTaskStatus 的续聊分支)。
    // 只认真人消息:后端发起的续跑(retry / 手点运行 / 队列推进 / 上游唤醒)带
    // opts.system,那是真的在执行这个任务,照旧占住队列位置。
    // 先落库再解析工作目录:后者可能抛错(worktree 建不出来),catch 那边要靠这个
    // 字段把任务放回原来的终态,而不是把一个 done 打成 failed。
    const followUpFrom =
      !opts.system && ["done", "failed", "canceled"].includes(task.status) ? task.status : null;
    // 新回合起点:顺手清掉上一轮残留的完成确认(确认只在本回合内有效)。
    await db
      .update(tasks)
      .set({ followUpFrom, completeConfirmedAt: null, updatedAt: now() })
      .where(eq(tasks.id, taskId));

    // Where the work lives: the agent's own cwd, else any session's cwd (so the
    // invitee sees prior output), else materialize the task workdir.
    const recorded = prev?.cwd || prev?.worktreePath || all[0]?.cwd || all[0]?.worktreePath || "";
    // A recorded cwd that has since vanished (worktree cleaned up, project moved)
    // used to be handed to spawn as-is — which stuck the task in 'running' forever.
    // Re-resolve through the same path a fresh run takes: it RESTORES the worktree
    // when the branch outlived the directory, and only rebuilds an empty one when
    // the branch is gone too.
    let cwd = recorded;
    let workspaceReset = false;
    if (!existsSync(cwd)) {
      if (project) {
        const ws = await taskWorkspace(task, project.repoPath);
        cwd = ws.path;
        // Only a resumed session carries stale memory worth correcting; a fresh
        // session starts empty-handed and needs no warning.
        workspaceReset = !!ws.fresh && resuming;
      } else if (!cwd) {
        cwd = ".";
      }
    }

    await setStatus(taskId, "running");

    const invited = !prev; // first time this agent is pulled into the task
    const userTurnText = userText + attachmentsPrompt(opts.attachments);
    const sharedTeamWorker = !task.useWorktree && (await workerPreambleFor(task)).length > 0;
    const prompt =
      (invited ? COLLAB_INVITE : "") +
      userTurnText +
      (workspaceReset ? WORKSPACE_RESET(cwd) : "") +
      (followUpFrom
        ? FOLLOW_UP_REMINDER(taskId, followUpFrom, sharedTeamWorker)
        : COMPLETION_REMINDER(taskId, sharedTeamWorker));
    const turnStart = now();
    const sessId = resuming ? prev!.id : id();
    const runDir = join(RUNS_DIR, taskId);
    mkdirSync(runDir, { recursive: true });
    handle = ex.run({
      prompt,
      cwd,
      sessionId: resuming ? prev!.cliSessionId! : undefined,
      trace: runTracePaths(runDir, sessId, turnStart),
    });
    trackRun(taskId, handle);

    // Reuse the agent's session row when resuming; otherwise open a fresh line,
    // inheriting the task's worktree/branch from its first session.
    let cliSessionId = resuming ? prev!.cliSessionId! : handle.sessionId;
    if (resuming) {
      // New turn on the same session row: mark it live (clear the prior turn's
      // end) and stamp this turn's start, so execution-time accounting and the
      // live 用时 both track the turn actually running now. commandLine must also
      // reflect this invocation because task-level model/effort can change between turns.
      await db
        .update(sessions)
        .set({
          turnStartedAt: turnStart,
          endedAt: null,
          commandLine: handle.commandLine,
          executor: ex.label,
          relayEnv: ex.relayEnvHint ?? null,
        })
        .where(eq(sessions.id, sessId));
    } else {
      const base = all[0];
      await db.insert(sessions).values({
        id: sessId,
        taskId,
        role: "single",
        agentType: agent,
        executor: ex.label,
        target: "local",
        worktreePath: base?.worktreePath ?? null,
        branch: base?.branch ?? null,
        cwd,
        cliSessionId,
        resumeCommand: ex.resumeCommand(cwd, cliSessionId),
        relayEnv: ex.relayEnvHint ?? null,
        commandLine: handle.commandLine,
        startedAt: turnStart,
        turnStartedAt: turnStart,
        activeMs: 0,
        exitStatus: null,
      });
    }

    const out = createWriteStream(join(runDir, `${sessId}.md`), { flags: "a" });
    if (opts.system) {
      // Backend-initiated 继续: a 〔系统〕 trace (its own bubble), NOT a 你→ reply.
      // Persist as a structured turn (reload) and emit a matching system event (live).
      writeTurn(out, { t: "system", agent, text: SYS_MARKER });
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType: agent, event: { kind: "system", text: SYS_MARKER } });
    } else {
      // 你→@agent reply, persisted as a structured turn so a reloaded thread shows
      // the human turn as its own bubble (live, the client already shows it).
      writeTurn(out, { t: "user", agent, text: userTurnText });
    }
    if (workspaceReset) {
      // 让用户也看见:agent 这一轮是在一个空目录上重新开始的。只发 toast 不算数,
      // 刷新后仍要能看出来(见 CLAUDE.md 关于持久可见状态的约定)。
      writeTurn(out, { t: "system", agent, text: WORKSPACE_RESET_MARKER });
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType: agent, event: { kind: "system", text: WORKSPACE_RESET_MARKER } });
    }

    let exitStatus = 0;
    for await (const event of handle.events) {
      if (event.kind === "session") {
        if (event.cliSessionId !== cliSessionId) {
          cliSessionId = event.cliSessionId;
          await db
            .update(sessions)
            .set({ cliSessionId, resumeCommand: ex.resumeCommand(cwd, cliSessionId) })
            .where(eq(sessions.id, sessId));
        }
        bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType: agent, event });
        continue;
      }
      if (event.kind === "text" || event.kind === "thinking") out.write(event.text);
      else if (event.kind === "error") writeRunError(out, event.message);
      if (event.kind === "done") exitStatus = event.exitStatus;
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType: agent, event });
    }
    const stopped = takeStopped(taskId);
    const endIso = now();
    await db
      .update(sessions)
      .set({ exitStatus, endedAt: endIso, activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${Math.max(0, Date.parse(endIso) - Date.parse(turnStart))}` })
      .where(eq(sessions.id, sessId));
    const settled = await settleTaskStatus(taskId, exitStatus, stopped);
    if (settled.note) {
      out.write(`\n> ${settled.note}\n`);
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType: agent, event: { kind: "error", message: settled.note } });
    }
    writeTurnEnd(out, endIso); // fence this turn's real end before closing the .md
    out.end();
  } catch (err) {
    bus.publish({
      type: "agent.event", taskId, sessionId: "", role: "single", agentType,
      event: { kind: "error", message: String(err instanceof Error ? err.message : err) },
    });
    // 续聊回合里出的岔子(典型:worktree 建不出来)不该把任务状态打差 —— 同
    // settleTaskStatus 的约定:续聊只能让任务变好,不能让它变坏。
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    const back = row?.followUpFrom as "done" | "failed" | "canceled" | null | undefined;
    if (back) await db.update(tasks).set({ followUpFrom: null, updatedAt: now() }).where(eq(tasks.id, taskId));
    await setStatus(taskId, takeStopped(taskId) ?? back ?? "failed");
  } finally {
    if (handle) untrackRun(taskId, handle);
    running.delete(taskId);
  }
}
