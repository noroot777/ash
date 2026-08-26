// 单飞任务「跑一回合」的两件核心事：**消费事件流** 与 **结算落位**。
//
// 从 orchestrator.ts 拆出来（那边已经超过 700 行的单文件上限）。依赖方向是
// 单向的：orchestrator / reattach 都 import 这里，这里不回头 import 它们 ——
// 结算规则是全局单点，谁也不该另造一份。
import type { WriteStream } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import type { AgentEvent, AgentType, SessionRole, TaskStatus } from "@ash/shared";
import { db } from "./db/index.js";
import { tasks, sessions } from "./db/schema.js";
import { bus } from "./bus.js";
import { scanForTitle } from "./auto-title.js";
import { now } from "./util.js";
import { setTaskStatus } from "./status.js";
import { bindNativeSteer, takeSteered, takeStopped, takeConfirmed, type StopSettle } from "./runs.js";
import type { AgentExecutor, RunHandle } from "./executors/types.js";
import {
  LOST_SESSION_PATCH,
  mergeSessionResumeFault,
  sessionResumeFaultNote,
  shouldDropSession,
  type SessionResumeFault,
} from "./executors/session-lost.js";
import { appendSessionTrace, writeTurn, writeTurnEnd, writeRunError } from "./transcript.js";
import { isSessionScopeNotice } from "./session-notice.js";
import { notifyTeamLead } from "./team/inbox.js";
import { handleTaskSettlement } from "./review.js";
import { handleFreeWorkflowSettlement } from "./free-workflow.js";
import { createExecutionCloser, recordFreeTaskExecutionStartIfFree } from "./free-workflow-events.js";
import { FOLLOW_UP_LABEL } from "./labels.js";
import { reconcileTurnBaseline } from "./turn-baseline.js";
import { clearTurnStart, turnOutputHint } from "./turn-output.js";
import { replayUndeliveredMcpCalls } from "./mcp-handoff.js";
import { recordSessionUsageEvent, setSessionContext } from "./usage.js";


async function setStatus(taskId: string, status: Parameters<typeof setTaskStatus>[1]) {
  await setTaskStatus(taskId, status);
}

// status 是 TaskStatus 而不是四个终态：**旁路回合（就地验证）结算时恢复的是进这一轮
// 之前的原状态**，可能是 paused、backlog 一类非终态。收窄在这里没有任何保护作用，只会
// 逼调用方 as 一下。
// role 是**这一回合自己的身份**（session 行里那份），自由工作流结算靠它分流「审查回合
// 的结算」与「普通回合的结算」——不能靠查库猜（并发插入的 reviewing run 会把普通回合
// 冒充成审查回合，审查实测复现）。
export async function afterSettlement(
  taskId: string,
  status: TaskStatus,
  confirmedDone: boolean,
  turnOk = true,
  role: SessionRole = "single",
) {
  try {
    if (await handleFreeWorkflowSettlement(taskId, status, confirmedDone, turnOk, role)) return;
    await handleTaskSettlement(taskId, status, confirmedDone, turnOk);
  } catch (error) {
    // Review orchestration is a post-settlement side effect. A failure here must
    // never rewrite an already-settled worker/reviewer status.
    console.error(`[ash] review settlement hook failed for ${taskId}:`, error);
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
// 会 resume 续跑,代价低)。逃生口:ASH_LAX_DONE=1 退回「exit 0 即 done」
// (接没配 ash MCP 的 agent 时用)。一处算清楚,run / continue 共用。
// 队列推进：done / canceled / failed / paused 进 setTaskStatus 后会触发同 queue 推进。
// 返回落位状态 + note(未确认降级的说明,调用方写进时间线让用户知道为什么)。
const STRICT_DONE = !process.env.ASH_LAX_DONE;
/**
 * 导出给 orchestrator：宽松模式下**连前言也别发**。
 *
 * 这个逃生口的适用场景是「对面的 agent 根本够不着这台 ash 的 MCP」——预览实例就是
 * 现成一例（claude 只把配置文件里写死的 env 交给 MCP 子进程，不传父进程的环境变量，
 * 所以预览里跑的 agent 的 `complete_task` 一定打去主实例、拿一个 404）。这种时候还照旧
 * 交代「不确认就记 failed」，agent 会认真去调、失败、再花半个回合解释它没能确认——
 * 一条它压根做不到的指令，不如不说。
 */
export const STRICT_DONE_PROTOCOL = STRICT_DONE;
const UNCONFIRMED_NOTE =
  "回合正常结束,但本回合内没有收到 complete_task 的完成确认 —— 按严格完成协议记为 failed。可能是 agent 没调用;也可能执行器/MCP 过滤了 ASH_TURN_TOKEN、或任务状态已变化，导致调用被 409 拒绝。若任务其实已完成,可手动把状态改成已完成;重试则会从中断处续跑。";
const GROUP_PAUSED_NOTE =
  "分组被暂停,本回合被中止 —— 任务落为已暂停;点「运行/继续」恢复分组时会从当前会话接着跑。";
const STEERED_NOTE = "〔系统〕当前回合已由“引导会话”结束。";
export async function settleTaskStatus(
  taskId: string,
  exitStatus: number,
  stopped: StopSettle | null,
): Promise<{
  status: TaskStatus;
  note?: string;
  confirmedDone: boolean;
  /** 这一轮是 CLI 原生命令（`/compact`）—— 调用方据此整段跳过结算钩子。 */
  nativeTurn: boolean;
}> {
  const memConfirmed = takeConfirmed(taskId); // 无条件消费,别让标记漏到下一回合
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  // 原生命令回合(`/compact`)的标记跟完成确认一样:读出来就清掉,只在本回合内有效。
  const nativeTurn = !!t?.nativeTurn;
  if (nativeTurn) {
    await db.update(tasks).set({ nativeTurn: false, updatedAt: now() }).where(eq(tasks.id, taskId));
  }
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
  const notify = (kind: Parameters<typeof notifyTeamLead>[1], q?: string, extra?: string) => {
    if (!t) return;
    void notifyTeamLead(t, kind, q, extra).catch((err) =>
      console.error(`[ash] notifyTeamLead(${taskId}) failed:`, err),
    );
  };
  // 续聊(follow-up)回合:任务早就是终态,这一轮是终态之后的对话,不是任务的执行。
  // 规则一句话:**续聊只能把任务变成 done(本回合亲口确认),不会让它变差** ——
  // 其余情况(没确认、异常退出、手停、组暂停)一律回到续聊前的那个终态。理由:
  // 用户给一个已完成的任务发条消息(「再发布一下」),不该因为 agent 这一轮没调
  // complete_task 就把 done 打成 failed;手停一轮闲聊也不该把它抹成 canceled。
  if (t?.followUpFrom) {
    // 旁路回合(就地验证)恢复的可能是 paused/backlog 一类的原状态,不止三个终态。
    const back = t.followUpFrom as Parameters<typeof setStatus>[1];
    await db.update(tasks).set({
      followUpFrom: null,
      // checkpoint-paused 上的真人消息先保留旧检查点，避免一句普通追问把恢复指令吞掉；
      // 本轮明确交卷才证明这句话确实接管了检查点，此时完成优先并清掉当前指令。
      ...(confirmed && t.resumePrompt ? { resumePrompt: null } : {}),
      updatedAt: now(),
    }).where(eq(tasks.id, taskId));
    if (confirmed) {
      await setStatus(taskId, "done");
      notify("done");
      return { status: "done", confirmedDone: true, nativeTurn };
    }
    await setStatus(taskId, back);
    const label = FOLLOW_UP_LABEL[back] ?? back;
    if (t.question) {
      // 提问照常通知/展示(问题卡片不看状态),但不把终态改成 paused —— 那会让它
      // 重新占住队列位置。答复走 /answer,又是一个续聊回合。
      notify("question", t.question);
      return { status: back, note: `续聊回合以提问结束,等待答复:「${t.question}」(任务状态仍为「${label}」)`, confirmedDone: false, nativeTurn };
    }
    if (stopped) {
      const why = stopped === "paused" ? "分组被暂停" : "被手动停止";
      return { status: back, note: `续聊回合${why},任务状态保持「${label}」不变。`, confirmedDone: false, nativeTurn };
    }
    if (exitStatus !== 0) {
      return { status: back, note: `续聊回合异常结束(退出码 ${exitStatus}),任务状态保持「${label}」不变。`, confirmedDone: false, nativeTurn };
    }
    return { status: back, confirmedDone: false, nativeTurn };
  }
  if (stopped === "canceled") {
    await setStatus(taskId, "canceled");
    return { status: "canceled", confirmedDone: false, nativeTurn };
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
      return { status: "paused", note: `本回合以提问暂停,等待答复:「${t.question}」`, confirmedDone: false, nativeTurn };
    }
    return { status: "paused", note: GROUP_PAUSED_NOTE, confirmedDone: false, nativeTurn };
  }
  // 提问优先于检查点:question 非空 → paused,但队列不推进、不自动续跑
  // (pickNextLaunchable 会挡住),等 answer_question 带答复唤醒。
  if (t?.question) {
    await setStatus(taskId, "paused");
    notify("question", t.question);
    return { status: "paused", note: `本回合以提问暂停,等待答复:「${t.question}」`, confirmedDone: false, nativeTurn };
  }
  if (t?.resumePrompt) {
    await setStatus(taskId, "paused");
    return { status: "paused", confirmedDone: false, nativeTurn };
  }
  if (exitStatus !== 0) {
    await setStatus(taskId, "failed");
    notify("failed");
    return { status: "failed", confirmedDone: false, nativeTurn };
  }
  if (confirmed || !STRICT_DONE) {
    await setStatus(taskId, "done");
    notify("done");
    return { status: "done", confirmedDone: confirmed, nativeTurn };
  }
  // 记 failed 之前先看一眼这一轮到底有没有产出:有就在通知里直说「你有 N 个新提交」,
  // 比通用文案快得多地指到病灶(多半只是漏了交卷)。**只影响措辞,不改落位**。
  const hint = await turnOutputHint(taskId);
  await setStatus(taskId, "failed");
  notify("failed_unconfirmed", undefined, hint);
  return { status: "failed", note: UNCONFIRMED_NOTE + hint, confirmedDone: false, nativeTurn };
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
  role?: SessionRole;
  nativeSteer?: {
    prepare?(text: string): string;
    record(text: string, at: string): void;
  };
}): Promise<void> {
  const { taskId, sessId, agentType, ex, out } = a;
  const role = a.role ?? "single";
  // 原生 CLI 命令回合(`/compact` 一类)不记「任务执行」:那一轮压根没在推进任务,记下来
  // 自由工作流时间线上就多出一条凭空的「任务执行 · 已完成」(第 2 轮审查 finding 7)。
  // 读的是 tasks.native_turn 而不是新加一个入参:结算那边(settleTaskStatus)看的就是
  // 这一列,同一个真相来源,重启后被接管的那一轮也照样认得出来。
  // verify_round 同理**从库里读**而不是让调用方传:三条起跑路径(fresh run / continueTask /
  // 重启接回)都汇到这儿,由库来答就不会漏标其中一条。验证中途提问、答复回来续跑的那一
  // 回合库里仍挂着轮次号,于是它照样归这一轮验证——跟 orchestrator 的 sideTurn 判据同源。
  const taskRow = (await db.select({ nativeTurn: tasks.nativeTurn, verifyRound: tasks.verifyRound })
    .from(tasks).where(eq(tasks.id, taskId))).at(0);
  const nativeTurn = !!taskRow?.nativeTurn;
  const verifyRound = taskRow?.verifyRound ?? null;
  const executionEventId = role === "single" && !nativeTurn
    ? await recordFreeTaskExecutionStartIfFree(taskId, a.turnStart).catch((error) => {
        console.warn(`[ash] failed to record free workflow execution start for ${taskId}:`, error);
        return null;
      })
    : null;
  // 终态只认第一次请求的那个,finally 那次兜底只准重试它 —— 理由见 createExecutionCloser。
  const closeExecution = createExecutionCloser(executionEventId, taskId);
  // 会话轮换旁注的缓冲与落盘。**必须声明在 try 外面**：异常路径的兜底 flush 挂在
  // finally 上，声明进 try 里它就不在作用域内了。
  // 先取空再写：正常尾部（agentEnd 之后）跑一次，finally 再跑一次也只是空转 —— 既不会
  // 把同一条写两遍，也不会往已经 end 掉的流上再写（写已 end 的流会当场打崩 server）。
  const sessionNotices: { text: string; at: string }[] = [];
  const flushSessionNotices = () => {
    const notices = sessionNotices.splice(0);
    for (const notice of notices) {
      writeTurn(out, { t: "system", agent: agentType, text: notice.text }, notice.at);
    }
  };
  try {
  let cliSessionId = a.cliSessionId;
  let exitStatus = 0;
  let doneEvent: AgentEvent | null = null;
  let streamError: unknown = null;
  // CLI 否认过这条会话，或 Codex stderr 证明 thread 已 poisoned 吗（见
  // executors/session-lost.ts）。认下来的话这一轮收尾时要把失效 id 从库里清掉，
  // 否则每一次重试都在 --resume 同一条坏会话。
  let sessionFault: SessionResumeFault | null = null;
  let titleDone = !a.autoTitle; // when autoTitle, swallow text until the title line is parsed
  let head = "";
  let pendingTraceText = "";
  const runMeta = {
    model: ex.model ?? null,
    reasoningEffort: ex.reasoningEffort ?? null,
    ...(verifyRound ? { verifyRound } : {}),
  };
  appendSessionTrace(taskId, sessId, a.turnStart, { kind: "run", ...runMeta });
  const publishEvent = (event: AgentEvent) => bus.publish({
    type: "agent.event", taskId, sessionId: sessId, role, agentType, ...runMeta, event,
  });
  for (const notice of a.handle.notices ?? []) {
    writeTurn(out, { t: "system", agent: agentType, text: notice }, a.turnStart);
    publishEvent({ kind: "system", text: notice, at: a.turnStart });
  }
  const flushTraceText = (at?: string) => {
    if (!pendingTraceText) return;
    appendSessionTrace(taskId, sessId, a.turnStart, { kind: "text", text: pendingTraceText }, at);
    pendingTraceText = "";
  };
  // 会话轮换旁注：实时立刻播（用户正看着），落盘攒到 writeTurnEnd 之后再补 —— 见
  // 事件循环里那段注释，夹在正文和 agentEnd 之间会让重建出来的回合用时失准。
  const noteSessionNotice = (text: string, at = now()) => {
    sessionNotices.push({ text, at });
    publishEvent({ kind: "system", text, at });
  };
  const emitText = (text: string) => {
    if (!text) return;
    out.write(text);
    pendingTraceText += text;
    publishEvent({ kind: "text", text });
  };
  // 智能体自己起的标题（见 auto-title.ts）。没解析到就什么也不做：任务留着建它时那个
  // 临时名（body 首行），下一次 fresh run 还会再试一次——autoTitle 只在真的改成时才关。
  const applyAutoTitle = async (newTitle: string | null) => {
    if (!newTitle) return;
    const updatedAt = now();
    // 条件里带上 auto_title=1:**这一轮跑到一半时任务可能已经被显式改过名了** —— 用户在
    // 界面上改，或者 agent 自己调 patch_task 改。那句改名的语义是「这就是标题」，不该被
    // 随后吐出来的 `标题：xxx` 盖回去。titleDone 是回合开头读的快照，答不了「此刻库里
    // 还允不允许自动命名」，只有库自己答得了。没更新到行就当什么都没发生，连事件也不发。
    const hit = await db
      .update(tasks)
      .set({ title: newTitle, autoTitle: false, updatedAt })
      .where(and(eq(tasks.id, taskId), eq(tasks.autoTitle, true)))
      .returning({ id: tasks.id });
    if (!hit.length) return;
    bus.publish({ type: "task.title", taskId, title: newTitle, updatedAt });
  };
  // 给标题窗口一个结论：命中就改名并把标题行摘掉，没命中就把攒下的正文原样放出去。
  // 返回 false = 还没有结论（窗口没走完），继续攒。
  const resolveTitle = async (flush: boolean) => {
    const scan = scanForTitle(head, flush);
    if (scan.kind === "buffer") return false;
    await applyAutoTitle(scan.title);
    titleDone = true;
    head = "";
    emitText(scan.text); // 命中的话标题行已被摘掉，其余原样放行
    return true;
  };
  const persistTrace = (event: AgentEvent, at?: string) => {
    // `context` 刻意不进 trace：trace 是「按回合回放各自的气泡」，而水位属于整条会话的
    // 此刻、只有最后一个值有意义，它的家在 sessions 行上（setSessionContext）。
    if (event.kind === "thinking" || event.kind === "tool" || event.kind === "error" || event.kind === "usage" || event.kind === "attachment") {
      flushTraceText();
      appendSessionTrace(taskId, sessId, a.turnStart, event, at);
    } else if (event.kind === "done" || event.kind === "turnEnd") {
      flushTraceText();
    }
  };

  if (a.nativeSteer) {
    bindNativeSteer(taskId, a.handle, {
      agentType,
      prepare: a.nativeSteer.prepare,
      beforeDeliver: async (at) => {
        if (!titleDone && head) await resolveTitle(true);
        const boundary = Date.parse(at);
        flushTraceText(Number.isFinite(boundary) ? new Date(boundary - 1).toISOString() : undefined);
      },
      record: a.nativeSteer.record,
    });
  }

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
            .set({ cliSessionId, ...ex.resumeFields(a.cwd, cliSessionId) })
            .where(eq(sessions.id, sessId));
        }
        publishEvent(event);
        continue;
      }
      if (event.kind === "text" && !titleDone) {
        head += event.text;
        await resolveTitle(false); // 还没结论就是继续攒，正文暂不放行
        continue;
      }
      if (event.kind === "text") {
        emitText(event.text);
      } else {
        // 标题窗口正扣着正文，而这条事件（tool/thinking/error/usage/done…）马上就要落盘、
        // 上屏。让它先走，攒着的正文就会排到它后面 —— live 和 trace 里的先后顺序都跟真实
        // 输出对不上（`error` 更明显：writeRunError 会先写进 .md）。所以先给标题窗口一个
        // 结论、把正文放出去，再处理这条事件。
        //
        // head 为空时不收窗口：没有正文被扣着，这条事件本来就该排在前面，顺序天生正确。
        // 开场先读个文件、之后才写标题的那种（库里 XQWuZZwlG_KA 就是），全靠这一条才救
        // 得回来。窗口就此关掉的代价是「tool 之后才出现的标题」认不出来——翻了那 15 个
        // 现场，没有一例长这样（两例「先寒暄一句」的寒暄和标题同在一个 text 事件里），
        // 拿这个换顺序永远正确，划算。
        if (!titleDone && head) await resolveTitle(true);
        // scope:"session" 说的是「这条恢复会话作废了」，不是「本回合失败了」（见
        // executors/codex.ts 推它的地方）。当成普通 error 会把一个 exit 0、正常交卷的回合
        // 记成「执行过程里有异常」；跟 duet/team 一样按 scope 分流（判据共用
        // session-notice.ts 那一个，别再各自内联一份），降成 system 旁注。
        // **落盘要等到 writeTurnEnd 之后**：重建时 agentEnd 只往「最后一段是 agent」的
        // 气泡上盖时间戳（shared/src/index.ts），夹在正文和 agentEnd 之间会让本回合用时失准。
        const emittedEvent = event.kind === "usage"
          ? await recordSessionUsageEvent(sessId, event, agentType, cliSessionId)
          : event;
        if (emittedEvent.kind === "done") {
          exitStatus = emittedEvent.exitStatus;
          doneEvent = emittedEvent;
          continue;
        }
        if (emittedEvent.kind === "error" && isSessionScopeNotice(emittedEvent)) {
          sessionFault = mergeSessionResumeFault(sessionFault, emittedEvent.message);
          noteSessionNotice(emittedEvent.message);
          continue;
        }
        persistTrace(emittedEvent);
        if (emittedEvent.kind === "error") {
          writeRunError(out, emittedEvent.message);
          sessionFault = mergeSessionResumeFault(sessionFault, emittedEvent.message);
        }
        // 水位相反：**覆盖**。它属于整条会话的此刻，不属于某一个回合，所以也不进 trace。
        if (emittedEvent.kind === "context") await setSessionContext(sessId, emittedEvent.context);
        publishEvent(emittedEvent);
      }
    }
  } catch (error) {
    // 先保留异常，等 steering 的两阶段决定：已提交的引导是受控结束，不该冒成 parser
    // 崩溃；预约若撤销，再把原异常交回原来的失败路径。
    streamError = error;
  } finally {
    if (offsetTimer) clearInterval(offsetTimer);
    await a.handle.cleanup?.().catch((error) => {
      console.warn(`[ash] failed to clean descendants after task ${taskId}:`, error);
    });
  }
  // 一个换行都没等到就收流了（整轮只吐了一行的那种）。这里补一次 flush 扫描：
  // 老实现直接把缓冲原样吐出去，那一行哪怕就是标准的 `标题：xxx` 也白瞎。
  if (!titleDone && head) await resolveTitle(true);
  flushTraceText();

  // A stop kills the subprocess → the stream ends like a normal exit; settle
  // by the stop kind (manual → canceled, group pause → paused) so it can be
  // re-run / continued.
  const requestedSteer = await takeSteered(taskId);
  const stopped = takeStopped(taskId);
  const steered = requestedSteer && !stopped;
  if (streamError && !steered && !stopped) throw streamError;
  const endIso = now();
  // CLI 否认了这条会话：把失效的 id 连同由它派生的三件套恢复命令一起清掉。清了之后
  // orchestrator 的 `resuming`（判据就是「这条会话行上有没有 cli_session_id」）自然为
  // 假，下一次运行走全新会话那条路 —— 不必在别处再加一个「要不要续」的开关。
  // 普通 lost 仍要求非零退出，防止正文碰巧出现原话；poisoned 是 stderr 诊断生成的
  // error，即使 exit 0 / turn.completed 也必须清掉。
  const dropSession = !steered && shouldDropSession(sessionFault, exitStatus);
  await closeExecution(steered ? "canceled" : stopped ?? (exitStatus === 0 ? "completed" : "failed"), endIso);
  await db
    .update(sessions)
    .set({
      exitStatus,
      // **这一轮是被停的，不是它自己崩的**。CLI 吃 SIGTERM 后按 signal 写非零退出，
      // 光看 exitStatus 分不出「我停的」和「它崩了」，而停止事实只在内存里活一次
      // （takeStopped 消费即清）。不落这一列，续聊被手动停止之后，那颗「上一回合崩了
      // 快重试」的按钮就会稳定地把用户刚停下的指令再跑一遍（第 2 轮审查 finding 2）。
      stoppedAs: steered ? "steered" : stopped ?? null,
      endedAt: endIso,
      activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${Math.max(0, Date.parse(endIso) - Date.parse(a.turnStart))}`,
      // 这一轮结束了，pid 不再有意义——留着会让下次重启去接一个早就没了的
      // 进程（或者更糟：pid 被复用后接到别人身上）。offset 留着供排查。
      agentPid: null,
      agentOffset: detached ? detached.committed() : null,
      ...(dropSession ? LOST_SESSION_PATCH : {}),
    })
    .where(eq(sessions.id, sessId));
  if (steered) {
    // 「引导会话」只截断旧回合：任务仍是 running，新消息已持有 scheduled_messages
    // 投递租约，并排在 releaseTurn 后用同一 cliSessionId 续送。这里若走普通 settle，
    // 会把旧方向误记 failed/canceled、推进队列，还可能触发工作流/审查；若补放旧回合
    // 的 complete_task，又会让新方向一开始就继承一张错误的完成票。
    clearTurnStart(taskId);
    writeTurn(out, { t: "system", agent: agentType, text: STEERED_NOTE }, endIso);
    publishEvent({ kind: "system", text: STEERED_NOTE, at: endIso });
    writeTurnEnd(out, endIso);
    out.end();
    return;
  }
  if (doneEvent) {
    persistTrace(doneEvent, endIso);
    publishEvent(doneEvent);
  }
  if (dropSession) {
    const note = sessionResumeFaultNote(sessionFault!);
    // 只弹一句话不算数：用户看不出 ash 已经替他把坏 id 清了、也看不出重试会丢上下文。
    // 落成持久 system 旁注（.md 原始产物 + SSE），刷新后还在；**不落 error** —— 换会话
    // 不等于这一轮失败，真正的失败自有它自己的 error 和退出码（见 session-notice.ts）。
    // 落盘仍走缓冲：这里已经在收尾链上，正文早写完了，夹在 writeTurnEnd 前面会让重建
    // 出来的回合用时失准（见 noteSessionNotice）。
    noteSessionNotice(note, endIso);
  }
  // 这一轮有没有「交卷时通道断了」的调用：有就替它补录。**必须排在 settleTaskStatus
  // 之前** —— complete_task 的补录要赶在结算读确认标记之前落库，晚一步，一个干完活的
  // 任务就已经被记成 failed 了（详见 mcp-handoff.ts）。
  await replayUndeliveredMcpCalls({
    taskId,
    sessId,
    turnStart: a.turnStart,
    agentType,
  }).catch(() => 0);
  const settled = await settleTaskStatus(taskId, exitStatus, stopped);
  clearTurnStart(taskId); // 只有「未确认 failed」那一支会读它,别的支路在这儿扔掉残页
  // 这一轮到底改没改东西:账在回合开头就清过了,这里只管「白清了要放回去」——
  // 一个字节没改就把游标/轮数/验收阶段原样放回,屋子是临时搭的还顺手拆掉。
  // 只看照片,confirmedDone 只挑那行时间线的措辞(理由见 turn-baseline.ts)。
  // **必须排在 afterSettlement 之前** —— 那一步会拿着游标把这条线往下推,放回晚一步
  // 就会把纯询问回合的游标推乱(详见 turn-baseline.ts)。
  await reconcileTurnBaseline(taskId, settled.confirmedDone);
  // turnOk = 这一回合本身干净收尾了(没被停、退出码 0)。跟落位状态不是一回事:旁路
  // 回合(就地验证)的落位是任务原来的终态,只有它说得清这一轮跑成没跑成。
  //
  // 原生命令回合(`/compact`)整段跳过:它是 CLI 本地的一次压缩,没有模型输出、没有
  // 结论 —— 交给结算钩子的话,正在跑的那一轮就地验证会被当成「验完了」收掉(清轮次、
  // 涨轮数、却给不出 verified/verify_failed),自由工作流那边同理。
  if (!settled.nativeTurn) {
    await afterSettlement(taskId, settled.status, settled.confirmedDone, !stopped && exitStatus === 0, role);
  }
  if (settled.note) {
    // 诊断正文留在 .md 原始产物里；trace 负责刷新后的折叠块，SSE 负责实时显示。
    out.write(`\n> ${settled.note}\n`);
    persistTrace({ kind: "error", message: settled.note }, endIso);
    publishEvent({ kind: "error", message: settled.note });
  }
  writeTurnEnd(out, endIso); // fence this turn's real end before closing the .md
  flushSessionNotices();
  out.end();
  } finally {
    // 正常路径上上面那句已经把旁注清空了，这里是**异常路径**的保险：清库、重放、结算
    // 任何一步抛错，都不能让「这条会话作废了、下次会丢上下文」只活在实时 SSE 里 ——
    // 用户一刷新就什么都看不到，还会去重试同一条坏会话。flushSessionNotices 先取空再写，
    // 所以正常路径走到这里必然是空的，绝不会往已经 end 掉的流上再写一次（写已 end 的
    // 流会当场打崩 server，见 duet/turn.ts 里同样的告诫）。
    flushSessionNotices();
    await closeExecution("failed", now());
  }
}
