// 一回合跑完之后的**状态落位**:这一笔该写成 done / failed / paused / canceled 里的哪一个。
//
// 从 single-run.ts 拆出来(全局约定:单文件不超过 700 行)。那边剩下的是「消费事件流」,
// 两件事的依赖是单向的:consumeSingleRun 调这里,这里不回头 import 它。
//
// **落位规则是全局单点**,谁也不该另造一份:续聊、原生命令、手停、组暂停、提问、检查点、
// 严格完成协议、以及那条「挂着哨兵不许落终态」的不变量,全都在下面这一个函数里算清楚。
import { and, desc, eq, isNull } from "drizzle-orm";
import type { SessionRole, TaskStatus } from "@ash/shared";
import { monitorSweepingStatus } from "@ash/shared/monitor";
import { db } from "./db/index.js";
import { tasks, sessions } from "./db/schema.js";
import { now } from "./util.js";
import { setTaskStatus } from "./status.js";
import { takeConfirmed, type StopSettle } from "./runs.js";
import { notifyTeamLead } from "./team/inbox.js";
import { FOLLOW_UP_LABEL } from "./labels.js";
import { announceResumePrompt } from "./task-resume-prompt.js";
import { turnOutputHint } from "./turn-output.js";
import { beginTerminalLanding } from "./task-complete.js";
import { readCliState } from "./task-cli-state.js";
import { handleTaskSettlement } from "./review.js";
import { handleFreeWorkflowSettlement } from "./free-workflow.js";

async function setStatus(
  taskId: string,
  status: Parameters<typeof setTaskStatus>[1],
  opts?: Parameters<typeof setTaskStatus>[2],
) {
  await setTaskStatus(taskId, status, opts);
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
  exitObserved = true,
  executionFailed = false,
) {
  try {
    if (await handleFreeWorkflowSettlement(taskId, status, confirmedDone, turnOk, role, exitObserved, executionFailed)) return;
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
// 结算说明写给**第一次用 ash 的人**看:他这一刻眼里只有一条红字,而红字里全是内部
// 黑话(严格完成协议、方向身份、409),读完只会得出「它崩了」。所以顺序是「发生了什么 →
// 这不是崩溃 → 你现在能做什么 → 常见原因」,内部原因排最后。落位仍是 failed,措辞不改
// 规则。**这类说明一律以 level:"notice" 发出**,别跟执行器报的真故障挤在同一格红里。
const UNCONFIRMED_NOTE =
  "本回合没有交卷:agent 结束前没有调用 complete_task 确认目标已达成,按 ash 的完成协议记为未完成。" +
  "这不是崩溃 —— 进程正常退出(exit 0)只证明 CLI 没挂,报错后退出也是 exit 0,所以「干完了」只认 agent 亲口确认。" +
  "产物都还在:核对后可直接把状态改成已完成;点重试会从中断处接着跑,不用从头再来。" +
  "常见原因:agent 漏调了这一步;执行器/MCP 丢了回合或方向身份;任务状态中途变了,调用被 409 拒绝。";
const GROUP_PAUSED_NOTE =
  "分组被暂停,本回合被中止 —— 任务落为已暂停;点「运行/继续」恢复分组时会从当前会话接着跑。";
export async function settleTaskStatus(
  taskId: string,
  exitStatus: number,
  stopped: StopSettle | null,
  sessionId?: string,
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
  const goalTurn = !!t?.goalTurn;
  if (goalTurn) await db.update(tasks).set({ goalTurn: false }).where(eq(tasks.id, taskId));
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
  // **确认在手 ≠ 可以落 done**(第 1 轮审查 F1)。确认那一刻过的那道哨兵闸只证明「那一刻」:
  // 之后还可以挂新哨兵、断线补录还能从旁路写进来一份确认。所以终态落位之前再问一次同一份
  // 判据 —— 这是那条不变量的最后一关,而且不依赖任何人调接口。拦下来不是失败,是**检查点
  // 暂停**:哨兵醒来会把这条会话重新叫起来,预约的审查也跟着等(见 task-complete.ts 文件头)。
  //
  // 它同时**置上那把闩**:核完阻塞物到终态行落库之间原本还有一条缝,那一瞬插进来的创建会被
  // 紧接着的终态清理当场停掉(第 2 轮审查 R2-1 实测 `OLD_F1_FINAL_SETTLEMENT_RACE`)。闩由
  // `setTaskStatus` 在状态落库之后撤(status.ts),期间 `startMonitor` 一律 409。
  //
  // **按需问、问一次**:它有副作用(落检查点 + 时间线 + 置闩),而这一轮可能根本不往终态走
  // (提问、组暂停、恢复一个非终态的原状态)—— 那些落位本来就留着哨兵,不该被这一段碰。
  // 每个落位各自判「我这一笔会不会收走哨兵」,判据是 shared 里那一份(`monitorSweepingStatus`,
  // 跟终态清理、唤醒闸同源),不是「交了卷没有」:`ASH_LAX_DONE` 下没交卷也会落 done,一样连坐。
  let landing: string | null | undefined;
  const monitorGate = async (): Promise<string | null> => {
    if (landing === undefined) landing = await beginTerminalLanding(taskId);
    return landing ?? null;
  };
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
    // **未确认那一支也要过闸**(第 2 轮审查 R2-1):没交卷就恢复原状态,而那个原状态本身多半
    // 是 done/failed —— 恢复它跟落一个新终态对哨兵是同一件事,这一轮新挂的哨兵照样被收走。
    // 原状态是 paused/backlog 一类时不问:那些落位不碰哨兵,问了只会白写一段系统等待。
    const hold = confirmed || monitorSweepingStatus(back) ? await monitorGate() : null;
    const consumedCheckpoint = !!(confirmed && !hold && t.resumePrompt);
    if (confirmed && !hold) {
      await db.update(tasks).set({
        followUpFrom: null,
        // checkpoint-paused 上的真人消息先保留旧检查点,避免一句普通追问把恢复指令吞掉;
        // 本轮明确交卷才证明这句话确实接管了检查点,此时完成优先并清掉当前指令。
        // 来源列跟着一起归 false(见 task-resume-prompt.ts 文件头:同写同清)。
        ...(consumedCheckpoint ? { resumePrompt: null } : {}),
        updatedAt: now(),
      }).where(eq(tasks.id, taskId));
      // 检查点被这一轮消费掉了:随后的 setStatus 只广播 task.status,带不动 resume_prompt,
      // 页面会继续把任务读成「在等续跑」(见 task-resume-prompt.ts 顶部)。
      if (consumedCheckpoint) await announceResumePrompt(taskId);
      await setStatus(taskId, "done"); // done 的终态钩子自会推进队列
      notify("done");
      return { status: "done", confirmedDone: true, nativeTurn };
    }
    if (hold) {
      // 续聊回合名下还有没了结的哨兵:**不能回那个终态**(回去 = 终态连坐当场把哨兵停掉、
      // 排着的结果作废,正是这条不变量要拦的),落 paused 让它醒得过来。交了卷与没交卷都走
      // 这一支 —— 对哨兵来说两者的落位后果一样。旁路身份要一起清掉,否则队列会继续把它
      // 当成一个「旁路回合」记账。
      const { serializeQueueClaims } = await import("./queue-seat.js");
      await serializeQueueClaims(async () => {
        await db.update(tasks).set({ followUpFrom: null, updatedAt: now() }).where(eq(tasks.id, taskId));
        await setStatus(taskId, "paused");
      });
      await announceResumePrompt(taskId);
      return { status: "paused", note: hold, confirmedDone: false, nativeTurn };
    }
    // 「清旁路身份」与「恢复原状态」必须对队列推进原子:分开写的话,两次 UPDATE 之间
    // 任务是 running + followUpFrom=null —— 前项此刻让位,推进看到的是一个「真执行」,
    // 既冻结又不记账,交接就漏了(第 4 轮审查问题 2)。包进认领临界区后,推进要么读到
    // 完整的旁路身份(冻结 + 记账),要么读到恢复完的 paused(挑中;旧回合锁还占着则
    // 由 advanceQueue 记账),两边都由 whenTurnIdle 回调补办,账本见 queue-seat.ts。
    // 恢复 paused 用 quietAdvance:回到原样不是新的检查点落位(setTaskStatus 的注释)。
    const { serializeQueueClaims } = await import("./queue-seat.js");
    await serializeQueueClaims(async () => {
      await db.update(tasks).set({ followUpFrom: null, updatedAt: now() }).where(eq(tasks.id, taskId));
      await setStatus(taskId, back, back === "paused" ? { quietAdvance: true } : undefined);
    });
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
    if (goalTurn) {
      const [session] = await db.select().from(sessions).where(and(
        eq(sessions.taskId, taskId), eq(sessions.role, "single"),
        sessionId ? eq(sessions.id, sessionId) : isNull(sessions.endedAt),
      )).orderBy(desc(sessions.turnStartedAt), desc(sessions.startedAt)).limit(1);
      const goal = readCliState(t?.cliState, session?.agentType ?? t?.agentType ?? "claude", session?.executorId, session?.runOwnerUserId).goal;
      const note = goal?.objective?.trim()
        ? "持续目标已暂停；任务和历史保留，使用 /goal resume 续跑。"
        : "持续目标已清除；任务和历史保留，使用 /goal 描述 设置新目标。";
      await setStatus(taskId, "paused");
      return { status: "paused", note, confirmedDone: false, nativeTurn };
    }
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
  if (goalTurn && !confirmed) {
    await setStatus(taskId, "paused");
    return { status: "paused", note: "持续目标已停止，尚未收到完成确认。停止原因与目标状态见会话记录；使用 /goal 查看、/goal resume 续跑。", confirmedDone: false, nativeTurn };
  }
  if (nativeTurn) {
    // 原生命令(`/compact`)正常收尾也是一次 done:**它一样会把哨兵收走**(第 2 轮审查 R2-1)。
    // 压缩一下上下文不该顺手把上一轮挂着的哨兵停掉,所以这一支也过闸。异常退出那一支不问:
    // 进程真的崩了就是崩了,不拿检查点把它粉饰成「在等」。
    if (exitStatus === 0) {
      const hold = await monitorGate();
      if (hold) {
        await setStatus(taskId, "paused");
        return { status: "paused", note: hold, confirmedDone: false, nativeTurn };
      }
    }
    const status = exitStatus === 0 ? "done" : "failed";
    await setStatus(taskId, status);
    return { status, confirmedDone: false, nativeTurn };
  }
  if (exitStatus !== 0) {
    await setStatus(taskId, "failed");
    notify("failed");
    return { status: "failed", confirmedDone: false, nativeTurn };
  }
  const held = confirmed || !STRICT_DONE ? await monitorGate() : null;
  if (held) {
    // 交了卷,但名下还有会被 done 毁掉的哨兵/哨兵结果 ⇒ 检查点暂停。排在 `exitStatus !== 0`
    // 之后:进程异常退出是另一回事,崩了就是崩了。
    await setStatus(taskId, "paused");
    await announceResumePrompt(taskId);
    return { status: "paused", note: held, confirmedDone: false, nativeTurn };
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
