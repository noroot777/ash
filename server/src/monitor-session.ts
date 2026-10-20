// 「这个哨兵是哪条会话起的」——哨兵醒来时该叫谁。
//
// 一个任务同时可以有两条会话:执行者那条(`single`)和审查者那条(`reviewer`,审查是**旁路
// 回合**,跑在自己的会话上)。而哨兵唯一的出口是「唤醒这个任务」——唤醒哪一条,由
// `scheduled_messages.session_role` 决定,缺省是 `single`。
//
// 所以审查者挂的哨兵如果不记来源,醒来时叫的是执行者:那一轮既续不上审查(审查链还停在
// reviewing 等它续跑,见 free-workflow.ts 的 `task.question || task.resumePrompt` 守卫),
// 又凭空让执行者跑了一轮。用户 2026-10-16 问的「审查应该停在这等唤醒」的后半截就是它。
//
// ── 判据:**调用方自报、服务端核验过的那一份身份** ──────────────────────────────
//
// 曾经的判据是「此刻还活着的那条会话」:`start_monitor` 是 agent 在自己回合里调的,所以把
// `sessions.agent_pid` 逐条问一遍活死,活着那条的 role 就当成调用者。它错在**「有哪个活进程」
// 证明不了「现在是谁在调」**,而失手的代价是静默的:
//   · 进程查询这一刻不可用(ps 抽一下)⇒ 一条都判不出活 ⇒ 角色为空 ⇒ 按默认叫**执行者**,
//     审查那条会话继续等不到人,执行者凭空烧一个回合(第 7 轮审查 F2 实测 role 与轮次全丢);
//   · 审查者按提示 pause 了一轮等外部结果 ⇒ 一个 agent 进程都没有 ⇒ 同上;
//   · 两条会话都查得到活 ⇒ 分不清 ⇒ 同上。
//
// 现在的判据有两截,都不猜:
//   ① **这次调用是不是本任务当前这一回合**——`x-ash-source-task-id` + `x-ash-turn-token`
//      对上 `tasks.active_turn_token`(agent 回连那条既有通道,`auth/middleware.ts`),由创建
//      入口核验后以 `MonitorCaller` 交上来;
//   ② **这一回合是什么角色**——`turnRole()`,`claimTurn` 落下的**运行时事实**(审查结论的
//      归属检查 `report_stage` 读的也是它);
//   ③ **它属于哪一次、哪一轮审查**——核验那一刻这个任务上正在进行的那次 run 与 round。
// 三截都**绑在被核验的那一轮上**(`VerifiedTurn`),并在落库处再核对一遍它仍然有效:创建要
// 排队,而「核验过」不等于「排到它的时候还是那一轮」(第 8 轮审查 F2)。**第 ③ 截是第 9 轮
// 审查 F1 加的**:前一版只带 token 和角色,审查代次留到落库处**现查** —— 于是一份来自第 1
// 轮的请求在队列里等到第 2 轮开始,落库时被绑上 `round=2`,上一轮的结果就这样成了下一轮的
// 输入(实测 `originalRequest.reviewRound=1` → `monitor.source_review_round=2`)。
// 三截都答不出来时**一律不静默当执行者**:要么由调用方显式指定唤醒目标,要么拒绝这次创建。
import { and, eq, exists, isNull, ne, sql } from "drizzle-orm";
import { MONITOR_WAKE_TARGETS, monitorBlockedReason, monitorIdFromOrigin } from "@ash/shared/monitor";
import { isTaskRevoked } from "./claude-monitor-revoked.js";
import { db, dbClient } from "./db/index.js";
import { freeReviewRuns, monitors, scheduledMessages, tasks } from "./db/schema.js";
import { turnIdentity } from "./runs.js";
import type { TurnSource } from "./runs.js";
import { announceResumePrompt } from "./task-resume-prompt.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

/** 能带进 `continueTask` 的那两种角色(两端共用一份,见 shared)。别的(团队、duet)不表达,退回默认。 */
const WAKEABLE_ROLES = new Set<string>(MONITOR_WAKE_TARGETS);

/**
 * 核验通过的那一轮**本身**,不是「核验过」这个布尔。
 *
 * 创建会排队(`task:<id>`,前面可能有另一次创建、一次停止、一次删除),所以「入口核验」和
 * 「落库」之间隔着真实的等待。只带一个 `kind:"turn"` 过去,落库时就只能现读「现在是谁」——
 * 那是**另一轮**的答案:第 8 轮审查 F2 实测一份审查者提交的请求在队列里等到审查回合结束、
 * 实现者回合接上,于是哨兵被换绑成 `single`,通知连那次审查的执行器都没带上。
 *
 * 所以把被核验的那几样一起带下去,到落库处再核对一遍它们仍然有效。
 *
 * **`review` 这一样不是可选项**(第 9 轮审查 F1):光有 token 和角色时,「属于哪一次审查的
 * 哪一轮」只能在落库处现查,而那一问的答案是**那一刻**的审查,不是发请求那一刻的 —— 两者
 * 不同的时候,一份旧请求就被绑成了新一轮的输入。所以来源在入口一次抓全,之后**只核验、
 * 不重算**:核验失败就拒,拒绝有出路(在新的那一轮里重挂一次),换绑没有任何人能发现。
 */
export type VerifiedTurn = {
  /** 核验通过的那条任务(请求头 `x-ash-source-task-id`)。 */
  taskId: string;
  /** 那一轮的令牌(`tasks.active_turn_token`,每起一轮换一个,见 orchestrator.ts)。 */
  token: string;
  /** 这一轮的角色(来自回合身份本身)。null = 没认出这一轮,或这一轮没表达角色。 */
  role: string | null;
  /** 这一轮**为哪一次审查的哪一轮**而起(同一份回合身份里的那一项)。 */
  review: { run: string; round: number } | null;
  /**
   * **内存里这一轮认得这个令牌** —— 也就是说令牌、角色、审查代次出自同一份回合身份
   * (runs.ts 的 `TurnIdentity`),不是拼起来的。
   *
   * false 有且只有一种解释:这个令牌代表的那一轮**此刻已经不是这个任务正在跑的那一轮**
   * (它已经结束,或者派审占位已经接手)。那就必须拒 —— 第 10 轮审查 F1 实测过「按现在是
   * 哪次审查」顺下去的后果:旧审查者提交的哨兵落在新派的审查者名下,原审查没有任何后续。
   */
  bound: boolean;
};

/**
 * 创建入口必须交上来的那一份:**这次调用是谁发起的**。核验在入口做(那里才有请求头),
 * 这里只按已核验的结论判归属 —— 两件事分开是为了让「怎么证明身份」只有一处实现。
 */
export type MonitorCaller =
  /** agent 在**这个任务**自己的回合里调的,带着被核验的那一轮(见 `VerifiedTurn`)。 */
  | ({ kind: "turn" } & VerifiedTurn)
  /** 不是这个任务的任何一条会话:人在界面上点的,或另一个任务的 agent。`wake` = 显式指定的唤醒目标。 */
  | { kind: "external"; wake?: string | null }
  /** 自报了回合身份、核验没过(token 过期 / 对不上 / 指的是别的任务)。**不许当作任何人**。 */
  | { kind: "unverified" };

/**
 * 入口核验通过之后,把「是哪一轮」整份取下来。
 *
 * **一次同步读,一份对象**(`turnIdentity`):令牌、角色、审查代次都出自回合身份本身,
 * 这里一个 await 都没有,也就没有任何可以插进来的窗口。
 *
 * 上一版是「同步读角色 + `await` 现查『现在是哪次审查』」。那不是「一次抓全」,是把两份
 * 不同时刻的事实拼成一份来源:第 10 轮审查 F1 实测,旧审查结束、新审查(换了审查者)刚写
 * 进库而新令牌还没落下的那一瞬,一条由**原审查者**提交的请求被绑到了**新审查**上 ——
 * HTTP 200、命令照跑、投递参数从 codex 变成 claude,原审查者等不到任何结果。
 * 审查代次现在由派审那一侧在占位时交代(见 free-review-round.ts 的 `reviewSource`),
 * 查不查「现在是哪一次」都不再影响这次创建的来源。
 */
export function verifiedTurn(taskId: string, token: string): VerifiedTurn {
  const held = turnIdentity(taskId);
  const bound = !!held && held.token === token;
  return {
    taskId,
    token,
    bound,
    role: bound ? held!.role : null,
    review: bound ? held!.review : null,
  };
}

/** 同上,直接给创建入口用的那一层。 */
export const turnCaller = (turn: VerifiedTurn): MonitorCaller => ({ kind: "turn", ...turn });

/** 回合凭据对不上。不能退回默认 —— 那等于让一次失败的核验生成一条会叫醒执行者的通知。 */
const CALLER_UNVERIFIED =
  "这次创建带的回合凭据对不上（任务或令牌已经不是当前这一轮），说不清是谁要挂这个哨兵，所以不挂";

/**
 * 核验是真的、但**排到它的时候那一轮已经不在了**。
 *
 * 这一档必须单独拒,不能顺势按「现在这一轮」办:那就是把一个旧审查的请求换绑到新的实现者
 * 回合上(第 8 轮审查 F2)。拒绝是有出路的 —— 新回合里重挂一次就是了,而换绑没有任何人能发现。
 */
export const CALLER_EXPIRED =
  "这次创建获准代表的那一轮已经结束了（排到它的时候任务已经换了一轮），不把旧请求换绑到当前回合——"
  + "在现在这一轮里重挂一次";

/**
 * 回合是审查者,但**它那一次审查已经不在进行了**(收尾了,或者已经进到下一轮)。
 *
 * 必须单独拒,不能像上一版那样绑成「reviewer + 空来源」(第 9 轮审查 F1 第 4 条):空来源在
 * 事件出口会按**普通任务**判资格、唤醒时 `monitorWakeExecutor` 返回 null,于是原审查者的
 * 执行器配置整份丢掉 —— 一条属于已结束审查的哨兵,要么把一条没人要的通知投给实现者,要么
 * 用任务自己的执行器另起一条 reviewer 会话。外部显式指定 reviewer 那一档本来就是拒的
 * (下面 ③),权威角色这一档没有理由比它宽松。
 */
export const REVIEW_SOURCE_GONE =
  "起这次创建的那一轮审查已经不在进行了（已经收尾，或者已经进到下一轮）——"
  + "这个哨兵绑不到它上面，它醒来也没有人该被叫起；在现在这一轮审查里重挂一次";

/**
 * 说不清要唤醒谁。**这一档必须拒**:猜错的两种后果都不便宜 —— 猜执行者会凭空烧一个回合、
 * 审查那条会话继续等不到人;猜审查者会把一条本该叫实现者的通知投进一条正在收尾的审查。
 */
const WAKE_AMBIGUOUS =
  "这个任务上有一次审查正在进行，而这次创建没说清哨兵醒来该叫谁（实现者还是那次审查）——"
  + "指定一个再挂，或者在起它的那个回合里挂";

/** 显式指定的唤醒目标。只认能带进 `continueTask` 的那两种,别的一律当没说。 */
const normalizeWake = (wake: string | null | undefined): string | null => {
  const value = (wake ?? "").trim();
  return WAKEABLE_ROLES.has(value) ? value : null;
};

/** 整个任务正在被删掉。措辞跟终态/审查那两条分开:这一条没有任何出路。 */
const TASK_REVOKED = "这个任务正在被删除，不能再挂哨兵、也不再唤醒它";

/** 起它的那次审查已经收尾了。措辞跟终态那条分开:原因不同,出路也不同。 */
const REVIEW_FINISHED = "起这个哨兵的那次审查已经结束，它的事件不再唤醒任务";

/**
 * 「这个哨兵能不能挂上、它是谁挂的」——创建入口要的两件事，一次算完。
 *
 * 合成一个函数而不是两个，是因为它们本来就是同一个问题的两面：**终态任务上一个哨兵能挂
 * 上，唯一的理由就是某一次审查还在进行**（见下面的豁免），那么它当然属于那一次审查。分开
 * 算就会出现「靠审查豁免挂上、却没记住是哪次审查」——而后面三处都要那条身份(F1/F2)。
 *
 * ── 豁免：任务跑完了，但审查这件事还没完 ──────────────────────────────────────
 *
 * 自由工作流的审查跑在一个已经 done 的任务上（旁路回合，终态原样不动），光看状态会把
 * 审查者要挂的哨兵全拒掉 —— 而那恰恰是最需要哨兵的场景（见 shared 里 `activeReview`）。
 *
 * ── 归属：权威的那一份优先,剩下的宁拒不猜 ─────────────────────────────────────
 *
 * 判据见文件头。按确定性从高到低:
 *   ① 本任务当前回合的角色(`turnRole`)—— 运行时事实,直接用;
 *   ② 回合角色不在可唤醒的两种里(团队、duet、SCM 预占)—— 这是**确定的**「不表达」,照老样子
 *      退回默认,它跟「不知道」是两件事;
 *   ③ 调用方显式指定(`wake`)—— 人在界面上点的那一路,由他说清;
 *   ④ 这个任务上没有审查在进行 —— 唯一一条线就是执行者,不存在歧义;
 *   ⑤ 任务已经落终态而审查还在跑 —— 它能挂上来本身就说明是那次审查豁免放它进来的,
 *      唯一有出路的归属就是那次审查(第 1 轮审查 F2 第 3 条:审查者 pause 一轮等外部结果,
 *      这会儿用户在面板上补挂一个);
 *   ⑥ 都不是 ⇒ **拒**(`WAKE_AMBIGUOUS`),并让入口把「要你指定」这件事回给调用方。
 */
export async function monitorSourceGate(
  /** **必须是落库处(锁里)读到的那一份**:`activeTurnToken` 要跟排队结束后的事实一致。 */
  task: { id: string; status: string; archived?: boolean | null; activeTurnToken?: string | null },
  caller: MonitorCaller,
): Promise<{
  blocked: string | null;
  role: string | null;
  reviewRun: string | null;
  reviewRound: number | null;
  /** 真为「拒绝的理由是说不清叫谁」:入口据此告诉调用方「指定一个再来」。 */
  needsWake?: true;
}> {
  // **撤销期一律拒,而且不吃审查豁免**(第 3 轮审查 F1)。删除不是一个瞬间:从关闸到任务行
  // 真的没了之间有十几条语句,而「停完一遍哨兵」只证明那一刻扫干净了。这中间放一个新哨兵
  // 进来,它会被紧随其后的删除批次连行带 pid 一起抹掉 —— 进程却还在后台跑着,谁都再找不到
  // 它(实测 `lateCreationAccepted=true` + `aliveAfterDelete=true`)。
  //   判据跟内置 Monitor 那四个 writer 共用同一份(claude-monitor-revoked.ts):撤销的是
  // **这个任务的整个生命周期**,跟是谁要写、写哪张表无关。
  if (isTaskRevoked(task.id)) {
    return { blocked: TASK_REVOKED, role: null, reviewRun: null, reviewRound: null };
  }
  const blocked = monitorBlockedReason(task);
  // 归档不吃审查豁免(任务都收柜子了,审查链也没有续下去的地方),也就不必查任何东西。
  if (task.archived) return { blocked, role: null, reviewRun: null, reviewRound: null };
  // 核验没过 ⇒ 这次调用不属于任何人。**不许退回默认**:那正是「未知静默变成执行者」。
  if (caller.kind === "unverified") {
    return { blocked: CALLER_UNVERIFIED, role: null, reviewRun: null, reviewRound: null };
  }
  // **先核对「那一轮此刻还在不在」,然后用那一轮的角色,而不是「现在是谁」。**
  //
  // 判据只有一条:令牌还是当初那一个。令牌每起一轮换一个(orchestrator.ts),所以令牌相等
  // ⇔ 还是同一轮 ⇔ 还是同一条会话 —— 换代一发生令牌必然不同,这一问就拒掉了,不存在
  // 「被解释成另一轮」的余地(第 8 轮审查 F2)。
  //
  // 对上之后用的是**被核验那一刻的角色**,不回头再问一次 `turnRole`:同一轮的回合锁可能已经
  // 放了(审查者挂完哨兵就按提示 pause 收尾这一轮,而哨兵本来就是为了以后叫醒它才挂的),
  // 这时现读会得到 null、把一个明明知道是谁提交的请求退回「说不清叫谁」。
  //
  // 两问都要:
  //  · `bound` —— 抓来源那一刻,**内存里这一轮认不认这个令牌**(runs.ts `TurnIdentity`)。
  //    不认就是「这个令牌代表的那一轮已经不是现在这一轮」:它已经收尾,或者派审占位接手了
  //    (第 10 轮审查 F1 那个窗口);
  //  · 库里那个令牌 —— 排队期间任务换了一轮的话,这一问才看得见(创建要在 `task:<id>`
  //    队列里排,排到它时事实可能已经变了)。
  if (caller.kind === "turn"
    && (!caller.bound || caller.taskId !== task.id
      || !task.activeTurnToken || task.activeTurnToken !== caller.token)) {
    return { blocked: CALLER_EXPIRED, role: null, reviewRun: null, reviewRound: null };
  }
  const turn = caller.kind === "turn" ? caller.role : null;
  // 被状态拦下来时一定要问(那是豁免的唯一依据);回合是审查者时也要问(要记住是哪次);
  // 没有权威角色时也要问 —— 「有没有审查在进行」正是歧义判定的依据。
  const asksReview = !!blocked || turn === "reviewer" || turn === null;
  // **核验过的那一路只核验、不重查**(第 9 轮审查 F1)。两边问的是不同的问题:
  //  · `turn` ——「入口抓下的那一次、那一轮,**现在还在进行吗**」。不在了就拒,不换成新的
  //    那一次 —— 换绑就是把上一轮的结果送进下一轮,而且没有任何人能发现;
  //  · `external` —— 人在界面上点的那一下代表的就是**现在**,所以现查才是对的。它绑下来的
  //    那一轮随后还会在落库那一刻被原子复核一遍(见 monitor-create.ts 的 arm CAS)。
  const review = caller.kind === "turn"
    ? (asksReview && caller.review
      && await isReviewSourceActive(caller.review.run, caller.review.round)
        ? { id: caller.review.run, round: caller.review.round }
        : null)
    : (asksReview ? await reviewingRun(task.id) : null);
  const reviewRun = review?.id ?? null;
  // 权威角色是审查者,而那一次审查已经不在了 ⇒ 拒(见 `REVIEW_SOURCE_GONE`)。
  if (turn === "reviewer" && !reviewRun) {
    return { blocked: REVIEW_SOURCE_GONE, role: null, reviewRun: null, reviewRound: null };
  }
  // 审查豁免:它放行的是「挂得上」,不是「叫谁」。
  const unblocked = blocked && reviewRun ? null : blocked;
  const bind = (role: string | null) => ({
    blocked: unblocked,
    role,
    // 执行者自己挂的哨兵不绑审查:它的命跟着任务走,审查结束与它无关。
    reviewRun: role === "reviewer" ? reviewRun : null,
    // 轮次一起记:run.id 跨轮复用,只有它认不出「这是上一轮遗留的」(见 schema 注释)。
    reviewRound: role === "reviewer" ? review?.round ?? null : null,
  });

  // ①② 当前回合的角色是运行时事实。不在可唤醒的两种里 = 确定地不表达,退回默认。
  if (turn) return bind(WAKEABLE_ROLES.has(turn) ? turn : null);

  // ③ 调用方说清了要叫谁。
  const wake = caller.kind === "external" ? normalizeWake(caller.wake) : null;
  if (wake === "reviewer" && !reviewRun) {
    return {
      blocked: "这个任务上没有正在进行的审查，这个哨兵绑不到审查上",
      role: null, reviewRun: null, reviewRound: null,
    };
  }
  // 终态任务上指定「叫实现者」没有出路:事件到了出口照样会被终态拦掉(`monitorWakeGate`),
  // 等于挂一个注定不会唤醒任何人的哨兵。审查豁免只对绑到审查上的那一种成立。
  if (wake === "single" && blocked) return { blocked, role: null, reviewRun: null, reviewRound: null };
  if (wake) return bind(wake);

  // ④ 没有审查在进行:这个任务只有执行者一条线,按默认走不构成猜测。
  if (!reviewRun) return bind(null);
  // ⑤ 终态 + 审查在跑:能挂上来就是那次审查放它进来的,唯一有出路的归属就是它。
  if (blocked) return bind("reviewer");
  // ⑥ 非终态 + 审查在跑 + 没人说清 ⇒ 拒。
  return { blocked: WAKE_AMBIGUOUS, role: null, reviewRun: null, reviewRound: null, needsWake: true };
}

/**
 * 事件出口（`pushToTask`）与唤醒前最后一道闸（`monitorWakeGuard`）共用的那一份：
 * **这一条**哨兵现在还能不能唤醒任务。
 *
 * ── 来源资格**无条件**先问，跟任务此刻什么状态无关 ──────────────────────────────
 *
 * 「起它的那次审查还在不在」是**这条事件自己的资格**，不是只在任务终态时才需要的一条额外
 * 豁免。按状态短路（非终态就直接放行）会漏掉一整条可触发路径：在一个 paused 任务上派审
 * （入口允许）→ 审查期间哨兵输出并退出、通知排队 → 审查给出结论、旁路回合把任务恢复成
 * paused → 任务没进终态，终态清理压根不跑 → 那条属于**已结束审查**的通知照旧投递，又
 * 启动一轮 reviewer 回合（第 2 轮审查 F5）。
 *
 * 轮次一起核：`run.id` 跨轮复用（`nextRound` 把同一个 run 推回 reviewing 并把轮次加 1），
 * 只有 runId 认不出「这是上一轮遗留的结果」。
 *
 * 归档是唯一一条压过来源资格的：任务都被收走了，审查链也没有续下去的地方。
 */
export async function monitorWakeGate(
  task: { id: string; status: string; archived?: boolean | null },
  // `null` = 这条哨兵没有记下来源(执行者自己挂的,或行已经不在了):照终态老规矩。
  source: { reviewRun: string | null; reviewRound?: number | null } | null,
): Promise<string | null> {
  // 同一份撤销资格(见创建那一侧)。任务正在被删,它的事件已经没有出口可言 —— 推出去只会
  // 变成一条紧接着被删掉的待发消息,或者把一个马上就不存在的任务叫起来。
  if (isTaskRevoked(task.id)) return TASK_REVOKED;
  if (task.archived) return monitorBlockedReason({ ...task, archived: true });
  if (source?.reviewRun) {
    return await isReviewSourceActive(source.reviewRun, source.reviewRound ?? null)
      ? null
      : REVIEW_FINISHED;
  }
  return monitorBlockedReason(task);                 // 执行者挂的:照终态老规矩
}

/** 这个任务上**正在进行**的那次自由工作流审查（`reviewing` 是持久状态）与它的轮次。 */
async function reviewingRun(taskId: string): Promise<{ id: string; round: number } | null> {
  if (dbClient.closed) return null;
  const rows = await db
    .select({ id: freeReviewRuns.id, round: freeReviewRuns.currentRound })
    .from(freeReviewRuns)
    .where(and(eq(freeReviewRuns.taskId, taskId), eq(freeReviewRuns.status, "reviewing")));
  return rows.at(0) ?? null;
}

/**
 * **这一次、这一轮**审查还在进行吗。
 *
 * `round` 为 null（存量行）时只按 run 判 —— 那是这一列加上之前的行为。给了轮次就必须
 * 对上：同一个 run 续到下一轮时，上一轮遗留的结果不再是有效输入（见 schema 的
 * `source_review_round`）。
 */
export async function isReviewSourceActive(runId: string, round: number | null): Promise<boolean> {
  if (dbClient.closed) return false;
  const run = (await db
    .select({ status: freeReviewRuns.status, round: freeReviewRuns.currentRound })
    .from(freeReviewRuns)
    .where(eq(freeReviewRuns.id, runId))).at(0);
  if (run?.status !== "reviewing") return false;
  return round === null || run.round === round;
}

/** 一条哨兵事件的来源资格。`none` = 执行者自己挂的（按任务状态老规矩）。 */
export type MonitorSourceState = "live" | "stale" | "none";

/**
 * 这条**哨兵事件**的来源审查现在是什么状态（投递扫描那一层问的那一句）。
 *
 * 投递判定本体是纯函数（`deliveryVerdict`，单测直接喂字面量），不碰库；所以这件事由扫描侧
 * 查好了填进去。查的是**这条事件所属哨兵**记下的那次 run 与那一轮，不是「这个任务上有没有
 * 任意一条 reviewing」——后者会把上一轮遗留的事件当成新一轮的输入。
 *
 * **无条件查，不按任务状态短路**：来源失效是这条消息自己的资格问题，`paused` 任务上派的
 * 审查收了尾同样要作废它的遗留结果（第 2 轮审查 F5）。
 */
export async function monitorEventSourceState(origin: string | null): Promise<MonitorSourceState> {
  const source = await monitorEventSource(origin);
  if (!source?.reviewRun) return "none";
  return await isReviewSourceActive(source.reviewRun, source.reviewRound) ? "live" : "stale";
}

/** 这条哨兵事件所属哨兵记下的来源审查与轮次（`null` = 执行者自己挂的，或哨兵行已经没了）。 */
export async function monitorEventSource(
  origin: string | null,
): Promise<{ reviewRun: string | null; reviewRound: number | null } | null> {
  const monitorId = monitorIdFromOrigin(origin);
  if (!monitorId || dbClient.closed) return null;
  const row = (await db
    .select({ reviewRun: monitors.sourceReviewRun, reviewRound: monitors.sourceReviewRound })
    .from(monitors)
    .where(eq(monitors.id, monitorId))).at(0);
  return row ?? null;
}

/**
 * **这条哨兵醒来时该以什么身份续跑**:角色 + 它当初绑的那一次审查的那一轮。
 *
 * 两样都在哨兵行上(`source_role` / `source_review_run` / `source_review_round`),所以这里
 * 只是把它们拼成回合身份那一个对象(runs.ts 的 `TurnSource`),**不现查**「现在是哪一次审查」
 * —— 投递可能发生在几分钟之后,那一查在派审交接期会把旧哨兵的事件绑到新审查上
 * (第 10 轮审查 F1)。
 *
 * 审查者挂的哨兵却没记下代次(存量行)⇒ 显式的 `"unbound"`:它续起来的那一轮不代表任何
 * 一轮审查。这跟「按最新那一轮算」是两件事,后者正是上面那条错投(本轮审查 F2)。
 */
export function monitorTurnSource(
  row: { sourceRole: string | null; sourceReviewRun: string | null; sourceReviewRound: number | null },
): TurnSource | null {
  if (row.sourceRole !== "reviewer") return row.sourceRole ? { role: "single" } : null;
  return {
    role: "reviewer",
    review: row.sourceReviewRun
      ? { run: row.sourceReviewRun, round: row.sourceReviewRound ?? 1 }
      : "unbound",
  };
}

/**
 * 唤醒这一轮该用谁的执行配置跑 —— **按哨兵自己记下的那次审查**取，不是按任务的常设配置。
 *
 * 审查者完全可以是另一个执行器、另一个模型（典型：codex 审 claude 写的代码）。只带一个
 * `reviewer` 角色过去的话，`continueTask` 会按任务自己的 agentType 解析，于是**新建一条
 * claude 的 reviewer 会话**，原审查者那条上下文一个字都接不上（第 1 轮审查 F2 实测：
 * 任务 agent=claude、审查 agent=codex，唤醒后多出一条 claude reviewer）。
 *
 * `null` = 这条哨兵不属于任何审查（执行者自己挂的），按老规矩走任务配置。
 * run 已经不在 reviewing = 来源过期，调用方按「不再唤醒」处理（出口闸会先拦下来）。
 */
export async function monitorWakeExecutor(
  sourceReviewRun: string | null,
  sourceReviewRound: number | null = null,
): Promise<{ agent: string; executorId: string | null; model: string | null; reasoningEffort: string | null } | null> {
  if (!sourceReviewRun || dbClient.closed) return null;
  const run = (await db
    .select({
      status: freeReviewRuns.status,
      round: freeReviewRuns.currentRound,
      agentType: freeReviewRuns.agentType,
      executorId: freeReviewRuns.executorId,
      model: freeReviewRuns.model,
      reasoningEffort: freeReviewRuns.reasoningEffort,
    })
    .from(freeReviewRuns)
    .where(eq(freeReviewRuns.id, sourceReviewRun))).at(0);
  if (!run || run.status !== "reviewing") return null;
  if (sourceReviewRound !== null && run.round !== sourceReviewRound) return null;
  return {
    agent: run.agentType,
    executorId: run.executorId,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
  };
}

/**
 * 哨兵把任务叫醒的那一轮，要把 agent 当初**留给自己**的那段续跑交代一起喂回去。
 *
 * `start_monitor` 的说明就是这么许诺 agent 的：「起了哨兵的那一轮用 pause_task 收尾，
 * resumePrompt 写清被哨兵叫醒后该干什么」。但哨兵事件走的是投递链路（`byBackend`），而
 * 消费检查点那一条只认真人消息（见 orchestrator 里 `takeResumePrompt` 那一处的条件），
 * 于是两件事都落空了：
 * - agent 收到的只有一行事件，自己写的交代一个字都看不到；
 * - 那段交代**永远留在库里**，任务从此显示「在等续跑」，派审 / 预约 / 修复 / 预览整排
 *   按钮被那条门禁灰掉，`startFreeReview` 也一直 409（见 task-resume-prompt.ts 顶部）。
 *   审查者按说明 pause 一轮等套件，结论给完了任务还是卡着。
 *
 * ── 为什么是「先取走，没送出去再回填」而不是「送达后再取走」────────────────────
 *
 * 跟既有的检查点续跑同一套（`task-resume.ts`：`takeResumePrompt` → 起跑失败
 * `restoreResumePrompt`）。送达后才取走的写法有一个修不掉的窗口：`markSent` 已经落库、
 * 取走那一步却失败（库忙、进程正好被换掉），于是消息是 sent、交代还在 —— 没有任何人会
 * 再来清它，任务做完了仍被结算判成 paused，工具条整排按钮继续灰着（第 1 轮审查 F4 第 3
 * 种）。而那一步的失败又被 `onDelivered` 的 catch 当作记账错误吞掉，连日志都没有。
 *
 * 反过来「先取走」留下的窗口是「取走了但一个字没送出去」，那一种**有补偿**：`restore` 的
 * CAS 只填回自己腾出的那个空，agent 中途写了新的一段就不动它。所以这里只提供 `take` 和
 * `restore`，没有 `consume` —— 调用方必须在未送达的每条出路上回填（见两处投递点）。
 */
export async function monitorWakeCheckpoint(
  message: { id: string; taskId: string; origin: string | null; text: string; checkpointTaken: string | null },
): Promise<{ text: string; restore: () => Promise<void> } | null> {
  if (dbClient.closed || monitorIdFromOrigin(message.origin) === null) return null;
  // **重投**(上一次取走了交代、却一个字没送出去:进程正好没了、送达报错):账本列记着是
  // 哪一段,不再取第二次。拼接在内存里当场做,所以这一次带上的是**此刻**的事件正文——
  // 期间合并进来的新事件一并带走,而不是上一次那一份快照。
  if (message.checkpointTaken) {
    const taken = message.checkpointTaken;
    // 重投(进程换过一次,首次调用的内存闭包早没了):**来源不必跟着账本走**。取走那一笔
    // 没碰来源列,所以任务行上那一格还休眠着这段文字的来源,退回去就自动对上（见
    // task-resume-prompt.ts 文件头）。上一版在这里硬写 false,于是持久重投一趟就把系统
    // 等待洗成「agent 自己写的」,此后永不自动清理（第 1 轮审查 F2 实测）。
    return { text: withCheckpoint(message.text, taken), restore: () => restoreCheckpoint(message, taken) };
  }
  const checkpoint = (await db
    .select({ resumePrompt: tasks.resumePrompt })
    .from(tasks)
    .where(eq(tasks.id, message.taskId))).at(0)?.resumePrompt;
  if (!checkpoint) return null;
  // ── 取走:**两条语句互为对方的生效条件** ──────────────────────────────────────
  //
  // 一笔交代的转手是「任务行上腾空」+「这条消息认下这笔账」两半,少任何一半都是错的:
  // - 只腾空不落账:那段话只活在返回值这个内存字符串里,进程一没就两边都查不到它(第 2 轮 F4);
  // - 只落账不腾空:同一段交代会被喂两遍(任务行上它还在,下一条消息、真人续跑都会再取一次)。
  //
  // `db.batch` 是一个 BEGIN…COMMIT、中间没有 await,但**同批提交并不等于两条都命中**——
  // 各自的 CAS 是各自判的,一条命中一条落空照样整批提交(第 3 轮审查 F3)。所以条件不能各写
  // 各的,要互相引用:① 认账的前提是「任务行上那一段还在」,② 腾空的前提是「账已经认在这条
  // 消息上」。①先跑,于是只有两种结局——都中(真的转手成功),或者都不中(库里一个字没动)。
  // 不对称的回滚因此不在提交之后发生,而是**压根提交不出来**,下面那条只是个会出声的兜底。
  const checkpointStillHere = exists(db.select({ one: sql`1` }).from(tasks)
    .where(and(eq(tasks.id, message.taskId), eq(tasks.resumePrompt, checkpoint))));
  const ledgerOurs = exists(db.select({ one: sql`1` }).from(scheduledMessages)
    .where(and(eq(scheduledMessages.id, message.id), eq(scheduledMessages.checkpointTaken, checkpoint))));
  const [logged, taken] = await db.batch([
    db.update(scheduledMessages).set({ checkpointTaken: checkpoint })
      .where(and(
        eq(scheduledMessages.id, message.id),
        isNull(scheduledMessages.checkpointTaken),
        checkpointStillHere,
      ))
      .returning({ id: scheduledMessages.id }),
    // 来源列不碰(见 task-resume-prompt.ts 文件头):这一格休眠着,等这段文字被退回来。
    db.update(tasks).set({ resumePrompt: null, updatedAt: now() })
      .where(and(eq(tasks.id, message.taskId), eq(tasks.resumePrompt, checkpoint), ledgerOurs))
      .returning({ id: tasks.id }),
  ]);
  if (!logged.length || !taken.length) {
    // 都不中 = 读到之后、批跑到之前另一路(真人续跑、手点运行)先取走了同一段,或者这条消息
    // 已经不是那个样子了。什么都没变,直接不带交代走。
    // 单侧命中按上面的条件推不出来,真出现就是条件被改坏了:出声,并把那一侧退回去。
    if (logged.length !== taken.length) await unwindHalfTake(message, checkpoint, logged.length > 0);
    return null;
  }
  await announceResumePrompt(message.taskId);
  return {
    text: withCheckpoint(message.text, checkpoint),
    restore: () => restoreCheckpoint(message, checkpoint),
  };
}

/**
 * 交代**只持久在 `scheduled_messages.checkpoint_taken` 这一列**,喂出去的样子是送达前在内存
 * 里拼的(第 3 轮审查 F2)。
 *
 * 曾经是反过来的——取走时把它拼进 `text` 落库,回填时按后缀把它剥掉。两个毛病:
 * ① 剥的依据是「正文以这个后缀结尾」,而投递那一程里新事件会被合并追加到正文末尾,后缀就
 *    不在末尾了,于是剥不掉(交代留在正文里)或者连带新事件一起被切掉;
 * ② 回填整条 `text` 覆写,期间合并进来的事件直接没了。
 * 现在正文归事件、交代归账本列,两者互不覆盖,拼接是纯函数。
 */
const withCheckpoint = (text: string, checkpoint: string) =>
  `${text}\n\n【你当初留下的续跑交代】${checkpoint}`;

/** 不该发生的单侧命中(见上)。退回那一侧,并且一定要出声。 */
async function unwindHalfTake(
  message: { id: string; taskId: string },
  checkpoint: string,
  loggedOnly: boolean,
): Promise<void> {
  console.error(
    `[ash] 续跑交代转手出现单侧命中 ${message.taskId}/${message.id}(${loggedOnly ? "只落账" : "只腾空"}),`
    + "这说明两条语句的互相引用被改坏了",
  );
  try {
    if (loggedOnly) {
      await db.update(scheduledMessages).set({ checkpointTaken: null })
        .where(and(eq(scheduledMessages.id, message.id), eq(scheduledMessages.checkpointTaken, checkpoint)));
    } else {
      // 来源列不碰：取走时也没碰，那一格还休眠着这段文字的来源（见 task-resume-prompt.ts）。
      await db.update(tasks).set({ resumePrompt: checkpoint, updatedAt: now() })
        .where(and(eq(tasks.id, message.taskId), isNull(tasks.resumePrompt)));
    }
  } catch (error) {
    console.error(`[ash] 单侧命中退回也失败 ${message.taskId}:`, error);
  }
}

/**
 * 一个字都没送出去 ⇒ 那段交代白取了,**账本清空、任务行上填回**,于是下一次投递重新取一次。
 *
 * 回退**不碰正文**(交代从来没写进去),所以这一程里合并进来的新事件不可能被它覆盖。
 *
 * 另一半的资格是「这笔账此刻还归我们管」:账本列还指着这一段、而且**没有别人正在送它**
 * (租约空着、还没 sent)。投递失败时租约已经由 `abortDelivery` 让出去了,期间被别人抢走就
 * 轮不到我们退——那一位走的是上面的重投分支,它自己没送出去时会再退一次(第 3 轮审查 F2:
 * 别在失去写入所有权之后回退)。
 *
 * 退不动也不丢:账本列还指着它,下一次投递照旧走重投分支带着它走。所以这里失败的唯一后果是
 * 「任务行上那一格暂时空着」—— 静默吞掉就等于谁也不知道(第 2 轮审查 F4),所以留一条时间线。
 */
async function restoreCheckpoint(
  message: { id: string; taskId: string },
  checkpoint: string,
): Promise<void> {
  // **归属判据只有一条,两条语句共用它**:这笔账此刻还记在这条消息上、而且没有别人正在送它。
  //
  // 原来填回任务行问的是「账本现在空着」。那句话在「另一份更新的 restore 已经归还、那一段又
  // 已经被真人续跑消费掉」之后同样成立 —— 于是一个过期的 restore 能把它凭空复活
  // (第 4 轮审查 N3 函数层实测 `N3_FUNCTION_STALE_RESTORE_RESURRECTS`)。「账本空着」证明
  // 不了「是我清的」,只有「账本还写着我这一段」才是归属本体。
  const ledgerOurs = and(
    eq(scheduledMessages.id, message.id),
    eq(scheduledMessages.checkpointTaken, checkpoint),
    isNull(scheduledMessages.deliveringSince),
    ne(scheduledMessages.status, "sent"),
  );
  try {
    const [restored, cleared] = await db.batch([
      // 先填回(此刻账本还写着我们这一段),再清账 —— 顺序反过来,下面那个 EXISTS 就只能看到
      // 被自己清空的账本,又退回「空着 = 是我清的」那个推不出来的结论。
      // CAS:只填回自己腾出的那个空。agent 中途写了新的一段就不动它——那一段才是最新交代,
      // 下一次投递会取它。
      db.update(tasks).set({ resumePrompt: checkpoint, updatedAt: now() })
        .where(and(
          eq(tasks.id, message.taskId),
          isNull(tasks.resumePrompt),
          exists(db.select({ one: sql`1` }).from(scheduledMessages).where(ledgerOurs)),
        ))
        .returning({ id: tasks.id }),
      db.update(scheduledMessages).set({ checkpointTaken: null }).where(ledgerOurs)
        .returning({ id: scheduledMessages.id }),
    ]);
    if (!cleared.length) return; // 这笔账已经不归我们了(别人接手/已送出),什么都不做
    if (restored.length) await announceResumePrompt(message.taskId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[ash] 续跑交代回填失败 ${message.taskId}:`, error);
    await appendTaskTimeline(
      message.taskId,
      `续跑交代没能放回任务行（${detail}）。它仍记在那条待发送的哨兵事件的账本列上，下一次投递会带着它走。`,
    ).catch(() => {});
  }
}

export async function liveMonitorSummary(
  taskId: string,
): Promise<{ count: number; labels: string[] }> {
  if (dbClient.closed) return { count: 0, labels: [] };
  const rows = await db
    .select({ description: monitors.description, command: monitors.command })
    .from(monitors)
    .where(and(
      eq(monitors.taskId, taskId),
      eq(monitors.status, "running"),
      eq(monitors.kind, "ash"),
    ));
  return {
    count: rows.length,
    // 描述是 agent 自己写的「我在盯什么」,没写就退回命令原文 —— 两个都空的行不该存在,
    // 但真遇上也不要在时间线里留一个空括号。
    labels: rows.map((r) => (r.description ?? "").trim() || r.command.trim()).filter(Boolean).slice(0, 3),
  };
}
