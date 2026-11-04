import type { InputAcceptance } from "./executors/types.js";
import type { ReviewStartReceipt } from "./review-start-withdrawal.js";
import type { AgentType } from "@ash/shared";
import type { MonitorWakeData } from "@ash/shared/monitor-wake";
import type { TurnIdentity, TurnSource } from "./runs.js";

// Why a task is being (re)started — only used to label the resume; all reasons
// behave the same (resume if there's a resumable session, else fresh). Note: a
// scheduled cron fire is NOT here — it always starts a fresh run via runTask
// (schedules.ts), so it never resumes. `wake` = an upstream task just settled
// done and the settle hook is auto-resuming this paused dependent.
export type ResumeReason = "group" | "run" | "retry" | "wake" | "queue";

/**
 * **这一轮没能起跑,是哪一种**(`continueTask` 返回 false 时必定带一个)。
 *
 * 为什么非得分开:那个 false 原先把四件完全不同的事压成一个布尔 —— 于是**确证一个字节都没动
 * 的瞬时抢占**和「用户撤回」在调用方眼里长得一模一样,只能一视同仁地落终态。第 1 轮审查问题 2
 * 实测:外层占到 reviewer 锁之后、交接到内层之前,这把锁被合法放开、另一回合占上,内层
 * `reclaimTurn` 正确地拒绝接管 —— 而这一轮审查就此 run=failed / round=error,只尝试过 1 次。
 * 「所有 false 都重试」是反过来的错:撤回被磨掉,拒绝理由被原地再撞一遍。
 *
 *  · `turn-taken` —— 锁此刻在**别的执行**手上(入口占位已被拔走,或这一刻正跑着另一轮)。
 *    瞬时,而且这一侧到这一刻一个字节都没动;锁总会被还回来(持有者自己的 finally、人工放开、
 *    幽灵锁巡检都走 `endOwnTurn`),所以「排到下一个空闲窗口」一定还有下一次机会 —— **唯一
 *    一种重排是安全的**。
 *  · `withdrawn`  —— 用户的动作把这一轮撤了(起跑前的冻结闸、spawn 之前的审查撤回)。重排只会
 *    把他的决定磨掉。
 *  · `backoff`    —— 其它退避:接力出去的存档、验收互斥、检查点待恢复、唤醒资格不再成立、
 *    历史审查退役、读不到状态、团队插话没送达。**确证没送出去**,但重排是原地再撞同一个
 *    拒绝理由,该让调用方自己交代。
 *  · `uncertain`  —— 这个任务上挂着一次**说不清有没有投喂**的交付(`waitOwnership.start`
 *    停在 `uncertain`:服务死在交付期,原输入按「不会自动重发」保留着)。这一档一个字都不许
 *    重投,而且**不许声称「一个字都没送出去」**。
 */
export type TurnStartDecline = "turn-taken" | "withdrawn" | "backoff" | "uncertain";

/**
 * `continueTask` 的**调用契约**:这一回合由谁发起、代谁跑、能不能被撤回、落盘之后要回调谁。
 *
 * 单独一个文件,不是因为代码放不下,而是因为这一份是**给调用方读的**:排队消息、哨兵事件、
 * 让位交接、派审投递、重跑上一回合各自该传哪几个标记,判据全在下面这些说明里,跟
 * `continueTask` 内部「怎么起跑、怎么结算」那六百行不是同一件事,混在一个文件里谁都读不动
 * （第 7 轮审查 N3:那个文件越过了仓库的 700 行上限）。字段只增删在这里,语义说明也只有
 * 这一份——`runs.ts` 那种按 `Parameters<typeof continueTask>[2]` 取类型的调用方照旧成立。
 */
export type ContinueTaskOptions = {
  reviewDelivery?: import("./review-ownership.js").ReviewDelivery;
  /** 这一回合交进去的是哪一轮的**手动**修复交接（自动修复从 `reviewDelivery` 反查）；熔断提问闸从它起算（review-recurrence-gate.ts）。 */
  recurrenceRound?: { runId: string; round: number };
  agent?: AgentType;
  executorId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  attachments?: string[];
  system?: ResumeReason;
  /**
   * 「执行意图」与「输入来源」分开表示(第 xNb655YqYzcA 链第 4 轮):这一回合是
   * **任务的执行**(让位交接/手动运行/重试把到期的用户回复当启动输入),所以终态
   * 任务不走续聊语义(followUpFrom 不护旧终态,队列照常占位)——这一点与 system
   * 同口径;但输入是**真实用户消息**,落盘记录、工作目录基线、检查点消费、失败时
   * 的未送达交代全按用户消息走——这一点与 system 相反。只给 system 一个标记时,
   * 二者绑死:让位交接只能二选一,要么用户原文不进会话记录,要么终态重试被误当续聊。
   */
  executionTurn?: boolean;
  /** 旁路回合结束后恢复进入旁路前的任务状态。 */
  sideTurn?: boolean;
  /**
   * 这一回合的身份:**谁起的 + 为哪一次审查的哪一轮而起,一个对象**(见 runs.ts 的
   * `TurnSource`)。缺省 = `{ role: "single" }`。
   *
   * 两样绑在一起是因为它们分开过一次就出过事:上一版是 `sessionRole?` 与 `reviewSource?`
   * 两个各自可缺的字段,于是「reviewer 但没带审查代次」在类型上完全合法 —— 首次派审带了,
   * 自动投递/手动恢复/答复提问三条恢复入口各自漏了,活着的审查者从此挂不上哨兵
   * (第 18 轮审查 F2 实测 HTTP 409)。现在漏传在编译期就过不去。
   */
  turnSource?: TurnSource;
  freshSession?: boolean;
  /** 内部旁路回合可钉在一个准确工作目录（例如验收快照的 detached worktree）。 */
  cwd?: string;
  /**
   * 指名续**这一条**会话行（而不是按 agentType+role 现挑）。给「重跑上一回合」用：
   * 那条路的硬要求就是落回崩掉的那一条会话，挑错人 = 换个人重说一遍。
   * 行已不存在时退回新开会话（读它的调用方刚读过库，正常不会发生）。
   */
  resumeSessionId?: string;
  /**
   * 这一轮的字是**后端代写**的（验证打回的报告、验收冲突的交接说明），但它必须占一个
   * 真人回合 —— 带 system 会被当成「系统续跑」，followUpFrom 就护不住任务原来的终态。
   * 于是落盘时标一位 by:"system"，让读端（Inspector 的「后续追问」、侧边栏铺开那一列）
   * 能把它跟我自己打的字分开。默认 false = 真人发的。
   */
  byBackend?: boolean;
  monitorWake?: MonitorWakeData;
  /**
   * 这一轮输入的**投递凭据**:原样落进会话里那条用户回合的 `eventKey`(只在原话落盘的那一处写)。
   * 给「进程死在原话落盘与回执记账之间」的调用方事后核对用 —— 认的是这个键,不是正文里有什么
   * 字:真人追问、别的系统输入都可能提到同一个路径(验收门禁交接,accept-gate-handoff.ts)。
   */
  deliveryKey?: string;
  /**
   * 这一轮输入承载的问答答复（任务问答历史里那几条记录的 id）。原样落进会话里那条用户回合，
   * 删除消息时按它清问答历史、问答卡按它认记录（shared/questions.ts `pairAnswerMessages`）。
   */
  answerIds?: readonly string[];
  pendingMessageIds?: readonly string[];
  /**
   * 这几条输入的**越线记号是必要凭据**,不是尽力而为的记账。
   *
   * 续跑交代走这一档:它的恢复策略是「没有可靠的未投喂证明就不得归还」,所以记号写不下来时
   * 必须在 spawn 之前原地撤回 —— 凭据缺失 + 照常投喂 = 恢复侧必然误判成「没送出去」并重放
   * (delivery-crossing.ts 的文件头)。普通待发送消息不传这一位:它们的既有策略是「宁可重发
   * 一次也不丢一句话」,为记号缺失把用户的「继续」整个拦掉反而更伤人。
   */
  crossingRequired?: boolean;
  /**
   * **这一回合是谁点的**(多人模式)。共享项目里 B 可以在 A 的任务上回复/重跑/派审,
   * 而那一轮烧的是 B 自己的 key —— 所以执行器、供应商、个人 CLI 环境与 git 署名
   * 全部按 B 解析,而不是按 `tasks.ownerUserId`(§八「共享项目里的跨人操作」)。
   *
   * **只有真人发起的路径传它**:调度器、队列推进、上游唤醒、团队派活这些后端路径
   * 不传,它们照旧按任务归属人跑 —— 那才是「这个任务是谁的活」。
   */
  actingUserId?: string | null;
  /**
   * 调用方已在入口**原子占住** turn（传 `claimOwnTurn` 交回来的那份身份）：这里不再抢锁，用
   * sessionRole 接管（reclaimTurn）并照常在 finally 释放。入口占位是并发双 202 谎报
   * 的唯一解——只读预检查后的任何 await 间隙都可能被另一次启动抢先。
   *
   * **为什么是身份不是 true**(本轮审查 F1):交接与释放之间隔着整整一回合,人工放开可以在
   * 那段间隙里把锁拔走、让下一轮占上;按任务 id 还锁撤掉的就是后来者那把互斥。接管与释放
   * 都按这份身份核(理由整段在 turn-lock.ts 的 `endOwnTurn`)。
   */
  turnHeld?: TurnIdentity | null;
  /**
   * 起跑前再查一遍冻结事实（分组暂停 / 任务被删或归档），命中就在 spawn 之前撤回。
   *
   * 给「预检查离 spawn 很远」的启动路径开：重试按钮、自由审查重跑 —— 它们从只读预检查
   * 到真正拉起 CLI 之间隔着权威重读、执行器解析、工作目录准备、上一条输入的读取，中途
   * 还会把回合锁交接一次。普通续聊不开：在一个排队中/分组暂停的任务上发消息本来就允许，
   * 那不是被冻结的启动（说明见 turn-freeze.ts）。
   */
  freezeGuard?: boolean;
  /**
   * 「这一轮的输入**到底有没有进 agent 手里**」的回执回调 —— 在原话作为一个真人回合写进会话、
   * 并且问过协议层之后立刻调,不等这一轮跑完（`continueTask` 要等整轮结束才 resolve,那时早过了）。
   *
   * 给排队/定时消息和续跑凭证用:它们要在这一刻、而不是更早,才决定那条库行怎么处置。早一步标
   * `sent`,进程死在中间就是「托盘里没了、会话里也没有」——用户那句话凭空蒸发
   * （见 docs/incidents.md「排队消息凭空消失」）。
   *
   * **三档都会调到,调用方必须三档都处置**（第 1 轮自由审查 F2/F3:上一版只在「不是 refused」
   * 时调,于是续跑那一路的 finally 和开机对账压根看不到「明确拒收」这个事实,照旧拿本地回合行
   * 反推出「已送达」并补写 sent —— 日志里先打印「输入没能送进 agent」紧接着打印「原文已送达,
   * 补记这一笔确认」）：
   *   · `accepted` → 落 `sent` / 确认消费;
   *   · `refused`  → 确证没送出去,归还原文、立刻可重投;
   *   · `unknown`  → **留在在途**:不写 `sent`、也不归还（还了就重投,那才是重复执行）。语义与
   *     两个出口见 ../turn-input-acceptance.ts 文件头。
   *
   * 从前叫 `onDelivered`。改名是刻意的:那个名字把「回调被调到」读成了「已送达」,而这正是
   * F2/F3 两条的共同根因 —— 新名字让每个调用点在编译期被迫重新想一遍三档各自该干什么。
   */
  onInputSettled?: (acceptance: InputAcceptance, reviewInput?: ReviewStartReceipt) => void | Promise<unknown>;
  /**
   * 第二个参数 `reviewInput`:这一轮若是审查回合,就是**这一次输入**的起跑收据(目录、代次、
   * turnToken/directionToken/directionEpoch)。回执只属于产生它的那一次输入 —— 同一轮审查的答复、
   * 检查点续跑共用目录与代次,只有这份身份分得清「这句迟到的定论说的是哪一次」(用法见
   * free-review-round.ts 的 `failReviewStart`)。
   */
  /**
   * **同一个回调会被调第二次** —— 初次给的是有界等待的结果,迟到那一次才是终局。
   *
   * 初次 `unknown` 之后回执还在落定:落成 `accepted` 就是补记账,落成 `refused` 就是归还重投。
   * 上一版只把迟到的 accepted 转回来,于是迟到的拒收没人管 —— 那张租约永远留在「在途」,消息
   * 停在待发送、任务已经失败、再扫一遍也领不走它,只有重启能解(第 2 轮自由审查 F3,已实测)。
   *
   * 所以调用方的三档处置**必须幂等**,而且别假设只会被调一次。排队/定时/真人回合三条路共用
   * `../delivery-lease.ts` 那一份(它就是为了不让三个入口各漏一处而存在的)。
   */
  /**
   * 这一轮输入回执**本体**,run() 一返回就交出来 —— 排在任何可失败的本地记账之前(第 2 轮自由
   * 审查 F1:排在末尾时,记账一抛它就没被调到,调用方把「还没交接」读成了「执行器没有回执」)。
   * 没有这条缝的执行器给一个显式的 accepted 承诺,所以调用方手上没拿到 = 只有「还没交接」一个意思。
   *
   * 给**结算方**用:结算发生在回合结束之后,那时回执早就落定了,而初次那一档是几十秒前有界
   * 等待的结果。拿过期的 `unknown` 去结算,会把一段明确被拒收的交代结成「交付不明」,而它本该
   * 原样归还(第 2 轮自由审查 F1 的那一半)。问法见 ../turn-input-acceptance.ts 的 lastWordOnInput。
   */
  onInputReceipt?: (receipt: Promise<InputAcceptance>) => void;
  /**
   * 「这个任务此刻还能不能被**这条消息**叫醒」——**占住回合之后**再问一次，返回理由
   * 字符串就撤回这一轮（返回 false，一个字都不送）。
   *
   * 给哨兵事件用。它的资格判定原本只发生在投递扫描那一层，可抢到投递租约与真正起这
   * 一轮之间还隔着「等当前回合退干净」：那段时间里用户完全可以把任务标成完成，而租约
   * 不是送达 —— 于是一条尚未进会话的事件照样把一个已经 done 的任务拉回 running、多烧
   * 一轮会话（第 4 轮审查实测：总线真的走了 paused → done → running → done）。
   *
   * 只在这条路上开：真人排的队列消息在终态上走的是相反语义（「下次醒来处理」就是他排
   * 它的意思），给它挂这道闸等于把他的话吞了。
   */
  wakeGuard?: () => Promise<string | null>;
  /**
   * **这一轮没起跑的原因** —— 返回 false 时必定叫一次,而且只叫一次(见 `TurnStartDecline`)。
   *
   * 为什么是回调而不是把返回值换成联合类型:`continueTask` 的 `Promise<boolean>` 有十几个
   * 调用方,而它们里面只有一个(审查派发)需要按原因分路;换返回值会把那十几处全改一遍,而每
   * 一处的收尾语义都不一样 —— 收益全在这一处,风险摊到所有人。回调是加法:不传的照旧只看
   * 布尔,行为与改之前逐字一致。
   *
   * **原因本身不是尽力而为的**:`enterTurn` 那一侧的每条拒绝出路都由类型强制带上原因
   * (见 turn-entry-guard.ts 的 `decideTurnEntry`),所以新加一道闸漏报在编译期就过不去。
   */
  onDecline?: (reason: TurnStartDecline) => void;
  throwOnTeamUnavailable?: boolean;
};
