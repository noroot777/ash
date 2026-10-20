import { eq, sql } from "drizzle-orm";
import type { AgentEvent } from "@ash/shared";
import { NO_RESUMABLE_SESSION_NOTE, ROTATION_ALREADY_ANNOUNCED } from "@ash/shared/session-notes";
import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";
import { closedAlready, nextTurnStart, openTurn, recordTurnSpan, resumedTurnFields } from "../session-turns.js";
import { closeLeadTurns, heldTurns, holdTurn, releaseHeldTurn } from "./lead-turns.js";
import { IDLE_MS, createLeadStatus } from "./lead-status.js";
import { now } from "../util.js";
import { setTaskStatus } from "../status.js";
import { untrackRun, takeStopped } from "../runs.js";
import { resolveExecutorFor } from "../executors/index.js";
import {
  LOST_SESSION_PATCH,
  SESSION_DROP_PERSISTENCE_FAILED_NOTE,
  sessionResumeFaultNote,
  shouldDropSession,
} from "../executors/session-lost.js";
import { writeRunError, writeTurnEnd } from "../transcript.js";
import { isSessionScopeNotice } from "../session-notice.js";
import { recordSessionUsageEvent, setSessionContext } from "../usage.js";
import { consumeInbound } from "./inbound-queue.js";
import { sendToLead } from "./lead-delivery.js";
// 会话行的写入口(摘牌闸、失败只上报)住在 lead-session-writes.ts,见那份顶部。
import { persistOrReport, updateOwnSession } from "./lead-session-writes.js";
import type { PendingInbound } from "./inbound-queue.js";
import {
  idleRotation,
  onFreshSession,
  onRotationError,
  onRotationNotPersisted,
  onRotationPersisted,
  type RotationState,
} from "./rotation-state.js";
import type { Lead } from "./session-types.js";
// 说话的三个出口（SSE / trace / .md）住在 lead-voice.ts,见那份顶部。
import {
  flushSessionNotices,
  noteSessionNotice,
  publish,
  recordSystemTurn,
  reportLeadFailure,
  traceLead,
} from "./lead-voice.js";

// 待命中的常驻会话冒出这几种事件 = CLI 自己又开工了(见 consume 里的补开回合)。
//
// 认的是 agent **这一轮的产出**:正文、思考、工具、附件、执行报错。不认 usage / context
// —— 那两样是上一轮的收尾统计,拿它们开回合只会凭空多一颗空气泡。error 要认:后台回调
// 回来第一件事就是报错(工具炸了、API 拒了)完全正常,不认的话这一轮会从第二条事件才开
// 始算,回合照样被拆成两半,而且报错这段时间里空闲回收仍按「待命」在倒计时。
// 唯一的例外是 scope:"session" 那种 —— 它说的是「这条会话作废了」,不是这一轮的产出。
const SELF_STARTED_TURN_EVENTS: ReadonlySet<AgentEvent["kind"]> = new Set(["text", "thinking", "tool", "attachment", "error"]);
const startsSelfTurn = (event: AgentEvent): boolean =>
  SELF_STARTED_TURN_EVENTS.has(event.kind) && !isSessionScopeNotice(event);
const RECYCLE_NOTE = (min: number, resumable: boolean) =>
  `〔系统〕调度台空闲超过 ${min} 分钟,进程已回收(待命)。`
  + (resumable
    ? "你或执行者再说话时会自动接回同一会话,上下文不丢。"
    : "调度者这条 CLI 会话已经作废,再说话会开一条全新会话(之前的上下文不带过去)。");

interface ConsumerDeps {
  leads: Map<string, Lead>;
  adoptInbound: (lead: Lead) => Promise<void>;
  flushUnqueued: (lead: Lead) => Promise<void>;
  releasePending: (lead: Lead) => void;
}

export function createSessionConsumer({ leads, adoptInbound, flushUnqueued, releasePending }: ConsumerDeps) {
// 「这台说了算吗」那一组（状态重试、摘牌、空闲回收）住在 lead-status.ts,见那份顶部。
const { armIdle, armStatusRetry, clearIdle, clearStatusRetry, retireLead, setLeadStatus } =
  createLeadStatus({ leads, releasePending });
async function consume(lead: Lead): Promise<void> {
  await adoptInbound(lead); // 上一台/上一个进程没送出去的消息,先接回来
  let exitStatus = 0;
  // 事件流被掀翻了吗 —— 跟「进程报了个非零退出码」是两回事,收尾那句话的措辞不一样。
  let aborted = false;
  // CLI 否认过这条会话，或 Codex stderr 证明 thread 已 poisoned 吗（见
  // executors/session-lost.ts）。调度台是常驻会话，踩这个坑比一次性任务更死：
  // 每次说话都 --resume 同一个坏 id，而收尾那句话还在告诉
  // 用户「会话还在,再说一句就能接回」—— 他会照做,然后一次次撞同一堵墙。
  //
  // Codex 常驻在同一条 events 流里跑很多回合，所以这不是一个布尔而是一台小状态机：
  // 「坏没坏 / 等不等新 id / 那句『已作废』说没说过且属不属实」三件事必须一起翻篇，
  // 漏复位其中一个就会把上一条会话的结论串到下一条上（rotation-state.ts 顶部有现场）。
  let rotation = idleRotation();
  let pendingTraceText = "";
  const flushTraceText = () => {
    if (!pendingTraceText) return;
    traceLead(lead, lead.turnStart ?? now(), { kind: "text", text: pendingTraceText });
    pendingTraceText = "";
  };
  // 兜底:上面每个写库点都已经各自把失败咽下了(persistOrReport),这里管的是**剩下**
  // 那些没预料到的抛出 —— 执行器解析、用量记账、乃至 events 流自己炸掉。掀翻循环本身
  // 不致命,**跳过 closeLead 才致命**(理由见 reportLeadFailure 顶部),所以这里只如实说
  // 一句、收掉这台已经没人消费事件的进程,然后照常往下走那段收尾。
  try {
    for await (const event of lead.handle.events) {
      if (event.kind === "turnEnd") {
        flushTraceText();
        await endTurn(lead);
        // 上一回合欠着的新会话凭据在这儿补:补上了,轮换事宜这才算真翻篇。
        if (await flushPendingCredential(lead)) rotation = onFreshSession(rotation);
        continue;
      }
      if (event.kind === "session") {
        if (event.cliSessionId !== lead.cliSessionId) {
          lead.cliSessionId = event.cliSessionId;
          const ex = await resolveExecutorFor({
            executorId: lead.executorId,
            type: lead.agentType,
            model: lead.model,
            reasoningEffort: lead.reasoningEffort,
          });
          lead.pendingCredential = {
            cliSessionId: event.cliSessionId,
            ...ex.resumeFields(lead.cwd, event.cliSessionId),
          };
        }
        // CLI 报上新的 thread id：上一条会话的轮换事宜就此翻篇（fault / 等新 id /
        // 那句「已作废」说没说过，三个一起归零）—— 但**只有凭据真写进库了才算数**。
        // 没写进去还翻篇的话,收尾会按「一切正常」处理:既不补写凭据也不再作废旧的,
        // 库里就永远不知道这条会话(见 flushPendingCredential)。
        if (await flushPendingCredential(lead)) rotation = onFreshSession(rotation);
        publish(lead, event);
        continue;
      }
      // CLI 自己开的新一轮:常驻会话里挂了后台监控/子任务的 agent,通知一到就接着干活,
      // 而 harness 一条消息都没 send 过 —— 上一个 turnEnd 已经把这台落成待命、turnStart
      // 也清空了。不在这儿补一个回合起点,后果有两层:trace 的 turnStartedAt 只能兜底成
      // 各自的 now(),一个回合在页面上碎成一串「1 工具」的空气泡(每条都没正文,用时还全
      // 按会话结束时刻倒推);空闲回收计时也还在跑,一台正在干活的调度台会被当成闲置收掉。
      // 起点只能取**这一刻**(第一条输出)：自发回合没有投递口可问,上一轮收尾之后这个进程
      // 压根没有回合在跑,也就不可能有它写出来的东西落在中间那段空档里 —— 所以「不早于真实
      // 起点」的保守值在这里是安全的那个方向(漏一点,而不是把别人做的东西算进来)。有投入的
      // 那几条路一律用投入那一刻的真实起点,见 beginTurn 的注释。
      if (!lead.busy && startsSelfTurn(event)) {
        clearIdle(lead);
        await beginTurn(lead);
      }
      if (event.kind === "text") {
        lead.out.write(event.text);
        pendingTraceText += event.text;
      }
      else {
        const emittedEvent = event.kind === "usage"
          ? await recordSessionUsageEvent(lead.sessId, event, lead.agentType, lead.cliSessionId)
          : event;
        flushTraceText();
        if (emittedEvent.kind === "system") {
          noteSessionNotice(lead, emittedEvent.text, emittedEvent.at, emittedEvent.level);
          continue;
        }
        // scope:"session" 说的是「这条恢复会话作废了」，不是「本回合失败了」（见
        // executors/codex.ts）。当成普通 error 会让一个正常收尾的回合在执行过程里记一笔
        // 异常；跟 duet、single-run 一样按 scope 分流,降成 system 旁注 —— 判据共用
        // ../session-notice.ts 那一个,三条链各内联一份就会改一处漏一处。
        const sessionNotice = isSessionScopeNotice(emittedEvent);
        if (!sessionNotice
          && (emittedEvent.kind === "thinking" || emittedEvent.kind === "tool" || emittedEvent.kind === "error" || emittedEvent.kind === "usage" || emittedEvent.kind === "attachment")) {
          traceLead(lead, lead.turnStart ?? now(), emittedEvent);
        }
        // 水位相反：**覆盖**。常驻会话尤其需要它——流水一路加到几百万，只有水位能回答
        // 「这个调度台离上下文塞满还有多远」。正因为是覆盖,摘牌后就不能再写:那一行现在
        // 归接管的那台,旧进程的水位盖上去就是错的(用量是累加的真实开销,照记不误)。
        if (emittedEvent.kind === "context" && !lead.retired) await setSessionContext(lead.sessId, emittedEvent.context);
        if (emittedEvent.kind === "error") {
          const previousFault = rotation.fault;
          if (sessionNotice) noteSessionNotice(lead, emittedEvent.message);
          else writeRunError(lead.out, emittedEvent.message);
          rotation = onRotationError(rotation, emittedEvent.message);
          if (rotation.fault === "poisoned" && previousFault !== "poisoned" && lead.handle.dropSession) {
            // 不能等整条常驻 events 流关闭：pending 消息会在 turnEnd 后立刻开下一回合。
            // 这里先作废闭包里的 id 与持久恢复字段，所以下一个 startTurn 必然 fresh。
            lead.handle.dropSession();
            lead.cliSessionId = "";
            // 这条会话行可能已经被新进程接管了（工作目录被抽走那条路会复用同一行）。跟
            // closeLead 里那道闸同一个理由：晚到的旧进程不能抹掉新进程刚报上来的有效 id。
            // 内存里的 id 照样作废——那只影响这个已经出局的 handle；但一个字都不写进时间线：
            // 那条会话现在归新进程管，说「已作废」既不属实也没人该照做。
            if (leads.get(lead.taskId) === lead) {
              let note = sessionResumeFaultNote("poisoned");
              try {
                await db.update(sessions).set(LOST_SESSION_PATCH).where(eq(sessions.id, lead.sessId));
                // 只有真清成了才算「已经说过且属实」：收尾那两句据此不再重复整段。
                rotation = onRotationPersisted(rotation);
              } catch (error) {
                // 内存里的恢复 id 已经作废，不能让一次持久化故障杀掉常驻消费循环；同时明确
                // 告知用户重启前数据库里可能还留着旧 id。没清成就**不算说过** —— 宁可让收尾
                // 把完整那句再说一遍，也不能留下一句报喜的短话。
                const message = `已停止续跑损坏的 Codex 会话，但清理数据库恢复字段失败：${error instanceof Error ? error.message : String(error)}`;
                writeRunError(lead.out, message);
                traceLead(lead, lead.turnStart ?? now(), { kind: "error", message });
                publish(lead, { kind: "error", message });
                note = SESSION_DROP_PERSISTENCE_FAILED_NOTE;
                rotation = onRotationNotPersisted(rotation);
              }
              noteSessionNotice(lead, note);
            } else {
              // superseded：库里那份归新进程管，我们没清也不该说清了。
              rotation = onRotationNotPersisted(rotation);
            }
          }
        }
        if (emittedEvent.kind === "done") exitStatus = emittedEvent.exitStatus;
        if (!sessionNotice) publish(lead, emittedEvent);
        continue;
      }
      publish(lead, event);
    }
  } catch (error) {
    console.error(`[ash] team consume(${lead.taskId}) aborted:`, error);
    aborted = true;
    // 事件流被掀翻时我们从没拿到过 done —— 那个初值 0 是「还没人报过退出码」,不是
    // 「正常收尾」。照原样落库就是把异常中断记成成功退出(第 3 轮审查)。
    if (exitStatus === 0) exitStatus = ABORTED_EXIT_STATUS;
    // 这句只说发生了什么。「会话还接不接得回」由 closeLead 按 rotation 统一给 ——
    // 在这儿写死「用同一条 CLI 会话接回」,碰上刚判过 poisoned 的会话就是自相矛盾的指路。
    reportLeadFailure(lead, `调度台事件流异常中断：${error instanceof Error ? error.message : String(error)}`);
    try {
      lead.handle.kill();
    } catch {
      // 多半是它自己先没的,收尾照走。
    }
  }
  flushTraceText();
  // 关台前最后一次补欠账:补上了就不该再按「这条会话作废了」收尾。
  if (await flushPendingCredential(lead)) rotation = onFreshSession(rotation);
  await closeLead(lead, exitStatus, rotation, aborted);
}



/**
 * 把 CLI 报上来的新会话凭据补进库,**返回「这一次真的补上了」**。
 *
 * 为什么不是写一次就算完:`lead.cliSessionId` 是内存里当场换掉的,库里那笔靠这次写入。
 * 写失败还当它成了的话,后面三层会一起替它兜底失效 —— 内存 id 已是新值,同一个 id 再报
 * 一次会被「变了才写」挡掉;轮换状态机已经翻篇,不再记得欠着账;closeLead 的正常收尾只
 * 写退出码/用时,不补凭据。于是一次瞬时故障就永久留下「进程还能跑、数据库不知道这条
 * 会话」的分叉:一旦空闲回收或重启,下一次只能 fresh,刚建立的上下文无提示丢失,库里要是
 * 还留着更老的 id 甚至会去续跑旧会话(2026-08-25 第 3 轮审查)。
 *
 * 所以欠账留在 lead 上,由 consume 在**每个回合收尾和关台前**再试;调用点都在 consume
 * 里,是因为补上之后必须连带把 rotation 翻篇 —— 那个状态是 consume 的局部变量,而且
 * 「凭据立住了」和「不必再按作废收尾」本来就是同一件事。
 */
async function flushPendingCredential(lead: Lead): Promise<boolean> {
  const patch = lead.pendingCredential;
  if (!patch) return false;
  // 只补写**当前这一代**凭据。中途判过 poisoned 的话,内存 id 已经被清成空串、库里的恢复
  // 字段也刚清掉 —— 这时候把欠账补回去等于把刚判死的 thread 复活:用户看到的持久说明是
  // 「下次开全新会话」,库里却又指回同一条坏 thread,而且补写成功还会顺手把 rotation 翻篇,
  // 让 closeLead 也不再清它(2026-08-25 第 4 轮审查)。同代校验顺带挡住其它过代的路子。
  if (!lead.cliSessionId || patch.cliSessionId !== lead.cliSessionId) {
    lead.pendingCredential = null;
    return false;
  }
  // 这条会话行可能已经被新进程接管了(工作目录被抽走那条路会复用同一行)。晚到的旧消费者
  // 不能拿自己攒的这笔凭据盖掉新进程刚报上来的有效 id —— 跟 closeLead 里那道闸同一个理由。
  // 欠账就此作废:那条行现在归新进程管,补不补轮不到这个已经出局的 handle 决定。
  if (leads.get(lead.taskId) !== lead) {
    lead.pendingCredential = null;
    return false;
  }
  const ok = await updateOwnSession(lead, "新会话凭据", patch);
  if (ok) lead.pendingCredential = null;
  return ok;
}




/**
 * 回合**开始**那一半的库侧动作。
 *
 * `at` 必须是**这一轮真正的身份**：走投递口那几条路（用户插话、执行者汇报、回合收尾的合并
 * 汇报）要原样传 `sendToLead` 回来的 `at` —— 那一刻 `holdTurn` 已经把这个身份持有住了,这里
 * 再要一个新起点就等于同一轮登记两个,其中一个谁都不会来收。CLI 自发的那一轮没有投递口可问,
 * 只能以第一条输出的时刻为起点（见 consume 里的补开回合）—— 但那个起点也得从身份层的分配器
 * 拿：同一条会话上两个起点撞了毫秒,队列和唯一键会把两轮合成一轮（第 2 轮审查 F1）。
 */
async function beginTurn(lead: Lead, at = nextTurnStart(lead.sessId)): Promise<void> {
  // 状态与活动身份在同一个同步段里绑定;同一个身份重复持有是幂等的（openLead 先在
  // attachLead 里持有首轮,紧接着这里又用同一个 turnStart 调一次）—— 判据与机制都在
  // lead-turns.ts。
  const owned = holdTurn(lead, at);
  if (!owned) {
    // **迟到的开始信息**：这个身份在所有权层已经终结（刚被 `turnEnd` 关掉,或者整台已经关了/
    // 摘了牌）。开台那条路天生有这个窗口 —— 先持有首轮身份,再隔着两次写库才轮到这里,中间
    // 完全可能已经收到首轮的结束事件。这时只补持久记录:那一行记录照落（开过就是开过,而且
    // 按身份幂等）,但「这条会话正在跑」那组状态一个字都不许改 —— 重开一个已经终结的所有权
    // 就是 F2:凭空多出来的队首会被下一次结束消耗,真正在跑的那一轮永远注销不掉。
    //
    // `register: false` 是这一档的**要害**,不是顺手：`openTurn` 默认会把身份登进活动册,而
    // 这条路上已经没有任何所有者会来注销它了（`holdTurn` 答 false 就意味着队列不收,
    // `releaseHeldTurn` 此后永远碰不到它）。留下的那个活动身份让读端判「这条会话一直在写」,
    // 区间从那个起点开到无穷、而且算**精确**,停工之后别人在同一目录里做的东西全归到这个
    // 任务名下,面板一个字都不披露（本轮审查第 1 条,已实测）。
    //
    // 判据也不能只看 `retired`：**正常关台**（非换台）走的是 `closeLeadTurns`,它不摘牌,
    // 于是 `retired` 一直是假,这一句照样放行 —— 实测的那条路正是它。
    if (!lead.retired) {
      await openTurn(
        { sessionId: lead.sessId, taskId: lead.taskId, cwd: lead.cwd, startedAt: at },
        { register: false },
      );
    }
    return;
  }
  // **每一次写库前都重问一次「这个身份还在跑吗」**,不能只信进函数时那一问。
  //
  // `holdTurn` 答 true 之后这里还有两次 await,而事件消费是并发的：被持有的这一轮完全可能
  // 在这两次之间就被 `turnEnd` 关掉（打断后立刻结束的那一轮就这样）、或者整台被关掉。
  // 那之后这两笔写各自会造成：`resumedTurnFields` 把刚写上的 `ended_at` 又抹成 null
  // （会话行变成「还在跑」,产物区间跟着开到无穷）、`setLeadStatus` 把任务状态从已收尾改回
  // `running`。老判据只挡 `retired`,而这两条路都不摘牌（本轮审查第 2 条）。
  //
  // 已关就只补那一行持久记录——它是「开过这一轮」的第一手证据,而且按身份幂等（撞上已收口
  // 的行只会合并,不会多记一轮,见 session-turns.ts 的四语句批）——其余一个字都不写。
  if (closedAlready(lead.sessId, at)) {
    if (!lead.retired) {
      await openTurn(
        { sessionId: lead.sessId, taskId: lead.taskId, cwd: lead.cwd, startedAt: at },
        { register: false },
      );
    }
    return;
  }
  // **返回值不能丢**：这一路的 session 写入是被捕获后继续的（`updateOwnSession` 不抛），
  // 丢掉它就等于把「写成功」当默认（第 5 轮审查必须修 2.3）。
  const stamped = await updateOwnSession(lead, "回合开始状态", { ...resumedTurnFields(at) }, at);
  if (!stamped && !lead.retired) {
    // 会话行上的回合起点没刷上。第一手证据是下面那行回合记录,所以照落;产物面板判「还在
    // 写」用的是内存里登记的活动身份、区间起点也从那儿取,都不靠这一列,所以这里只报一句。
    console.warn(`[ash] 团队 ${lead.taskId} 的回合起点没写进会话行（产物区间按逐回合记录算）`);
  }
  // 摘牌的台一个字都不写（同 `updateOwnSession` 顶部那道闸）：旧台晚到的事件要是落下一行
  // 回合记录,接管那条会话的新台名下就凭空多出一段运行区间,把那期间别人的产出收进来。
  // 上面那次 await 之后身份可能已经被关掉了（同上一段）：行照落,但不再登记活动身份,
  // 也不再往后写状态。
  const stillOpen = !closedAlready(lead.sessId, at);
  if (!lead.retired) {
    // 开始行照样要落：它是「开过这一轮」的第一手证据,计数那一道跟它同批写（见 session-turns.ts）。
    await openTurn(
      { sessionId: lead.sessId, taskId: lead.taskId, cwd: lead.cwd, startedAt: at },
      stillOpen ? {} : { register: false },
    );
  }
  // trace 照写：它是**事实记录**（这一轮由哪个模型跑的）,按自己的 turnStart 归组,不是
  // 「现在在跑」那种状态。状态那一笔到此为止。
  traceLead(lead, at, {
    kind: "run",
    model: lead.model,
    reasoningEffort: lead.reasoningEffort,
  });
  if (!stillOpen) return;
  await setLeadStatus(lead, "running", at);
}

// 一个回合说完了(进程还活着)。有攒下的执行者消息就立刻合并成一条继续跑,
// 否则落 idle(待命)并起空闲回收计时。
async function endTurn(lead: Lead): Promise<void> {
  const endIso = now();
  // 执行器报的「一个回合说完了」关掉的是**队首**那一轮,不是 `lead.turnStart` 此刻写着的那个
  // —— 用户插话会在上一轮还开着时就把下一轮投进去,照那个字段结算等于用旧回合的结束事件把
  // 新回合提前收口（机制与后果见 lead-turns.ts 顶部,第 1 轮审查 F1）。注销排在写库之前：
  // 下面那两次写都可能失败,失败时照样不能留一个「还在跑」的身份给读端（第 6 轮必须修 1）。
  const turnStart = releaseHeldTurn(lead);
  const spent = turnStart ? Math.max(0, Date.parse(endIso) - Date.parse(turnStart)) : 0;
  // 手上还攥着别的回合 = 插话那一轮还排着/跑着,这台**并没有空下来**。
  const idleNow = !lead.busy;
  // 写库失败绝不能把下面整段收尾一起带走 —— writeTurnEnd、旁注落盘、待送消息、落 idle
  // 全在后面(理由见 persistOrReport)。丢的只是这一行用时统计。
  await updateOwnSession(
    lead,
    "回合收尾状态",
    {
      // `ended_at` 说的是「这条会话此刻没有回合在跑」。手上还有回合时写上它,读端判「还在
      // 写」的那一道就会被这个陈旧快照否决,正在跑的这一轮被算成「开了没收口」、区间夹到
      // 旧起点附近,之后落盘的东西全被排除（同一条链的另一头是第 1 轮审查 F3）。
      ...(idleNow ? { endedAt: endIso } : {}),
      activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${spent}`,
    },
    endIso,
  );
  // 这一回合的区间（产物归属按它认人，不按会话寿命——常驻调度台那一行从开台活到收工）。
  await recordTurnSpan({ sessionId: lead.sessId, taskId: lead.taskId, cwd: lead.cwd, startedAt: turnStart, endedAt: endIso });
  writeTurnEnd(lead.out, endIso);
  flushSessionNotices(lead);
  // 还有回合在手：攒着的执行者汇报等它真正空下来再合并送（省一轮模型调用本来就是这么来的）,
  // 更不能落 idle 或起空闲回收计时 —— 一台正在干活的调度台会被当成闲置收掉。
  if (!idleNow) return;
  if (lead.pending.length) {
    await flushUnqueued(lead); // 上次写库被拒的那几条,趁这会儿补进队列
    // **快照,不是引用**。`sendToLead` 要 await(投递前现读浏览器授权),这期间调度台可能
    // 又忙起来(用户插话)并收下新的执行者汇报,它们会追加进同一个 `lead.pending`。拿引用的
    // 话,下面 `lead.pending = []` 把新来的一起清掉、`batch` 里的 seq 也把它们的行一并销账
    // —— 一份从没交给调度者的执行结果就此永久消失,刷新、续聊、换台都找不回来
    // (第 7 链第 1 轮审查 P1)。
    const batch = [...lead.pending];
    const merged = batch.map((m) => m.text).join("\n\n---\n\n");
    const at = now();
    // 顺序是刻意的:**收下了才算送出去**。先销账、先落盘再 send 的话,send 一拒收
    // (进程正在收尾)这批汇报就再也没人送得出去了 —— 下一台健康调度台永远等不到
    // (2026-08-26 第 11 轮审查)。落盘同样要等收下之后:没送成还记一条「已投递」的
    // system turn,下一台真送成时同一份汇报在 .md 里就是两条。
    const delivery = await sendToLead(lead, merged);
    if (delivery.sent) {
      // 只摘走这一批(按对象身份)。await 期间新来的留在队列里,下一次回合收尾照常送。
      const sent = new Set<PendingInbound>(batch);
      lead.pending = lead.pending.filter((m) => !sent.has(m));
      // 销账失败宁可重送不可丢:行还在就是下一台会再送一遍(.md 里会多一条),而删早了
      // 是永久消失。所以这里只上报,不回滚也不掀掉这台调度台。
      // seq=null 的压根没进过队列(写库被拒),没有账可销。
      const seqs = batch.map((m) => m.seq).filter((seq): seq is number => seq !== null);
      await persistOrReport(lead, "待送消息销账", () => consumeInbound(seqs), at);
      recordSystemTurn(lead, merged, at);
      // 身份用投递口那一刻的（`delivery.at`）：holdTurn 已经按它持有住了,另要一个起点会让
      // 同一轮在活动册上留下两个。取不到时交给 beginTurn 的默认值（身份层分配器),别回退到
      // 上面那个 `at` —— 它是直接 `now()` 来的,不保证在这条会话上唯一。
      await beginTurn(lead, delivery.at ?? undefined);
      return;
    }
    reportLeadFailure(lead, "攒着的执行者汇报没能送进调度台进程(它正在收尾),先留在待送队列里交给下一台接手的调度台。", at);
  }
  await setLeadStatus(lead, "idle", endIso);
  armIdle(lead);
}

// 中途已经播过完整轮换说明后,收尾那两句只补一个指路,不重复整段。文案与前端判色的
// 共同真相源在 @ash/shared/session-notes(见那份文件顶部)。
// 事件流被掀翻时,没有任何进程报过退出码。落 0 等于把异常中断记成成功收尾;落 null 又会
// 让这条会话看起来还在跑(openLead 就是拿 null 表示「进行中」)。所以记一个明确的非零码,
// 真正的原因写在时间线和 trace 里。
const ABORTED_EXIT_STATUS = 1;

async function closeLead(
  lead: Lead,
  exitStatus: number,
  rotation: RotationState = idleRotation(),
  aborted = false,
): Promise<void> {
  clearIdle(lead);
  untrackRun(lead.taskId, lead.handle);
  // 工作目录被抽走时我们会主动收掉旧进程、立刻开新的,旧进程的 close 事件晚一步
  // 才到 —— 它不能把已经接管的新会话摘掉,更不能把新回合的 running 改回 idle。
  // 停止标记同理:那是任务级的共享状态,被接管的一方吞掉它,真正在跑的那台收尾时
  // 就当没被停过。
  const superseded = leads.get(lead.taskId) !== lead;
  if (!superseded) {
    leads.delete(lead.taskId);
    takeStopped(lead.taskId); // 消费停止标记:团队不走 settleTaskStatus,别漏给下一次
  } else {
    retireLead(lead); // 被接管的一方从此不写任何共享产物(状态/.md/trace/SSE),见 retireLead
  }
  // 进程没了,手上还没送出去的消息交出去:有 seq 的库里等着,没 seq 的进内存最后一档。
  // superseded 那一路 retireLead 已经交过,这里是空转。
  releasePending(lead);
  const endIso = now();
  // 手上可能攥着**好几个**回合：用户插话会在上一轮还开着时就起新一轮,而进程这会儿整个没了
  // —— 每一个都得补上自己的区间,否则缺的那几轮只剩「会话结束了、最后一个回合没有记录」
  // 那一个笼统缺口（第 1 轮审查 F1 的同一条链）。
  // 注销排在枚举**之后**,而且 `closeLeadTurns` 把放掉的身份交回来 —— 两条分支于是共用同
  // 一份「这台手上曾经攥过什么」:
  //   • 正常关台：身份现在还在 `held` 里,这一句就是放手的那一次,交回来的就是它们;
  //   • 换台（superseded）：`retireLead` 在 `attachLead` 那一瞬就放过手了,`held` 早空了,
  //     交回来的是它**当时**攥着的那一份（记在 `lead.releasedTurns` 上）。
  // 从前这里只读 `held`,于是换台那一路恒等于空、退化成 `lead.turnStart` 一个单值,被打断
  // 和还排着的那几轮永远 `ended_at = NULL`（本轮审查第 3 条,已实测;机制见 closeLeadTurns）。
  // 进程都没了,这些回合当然不在写了——撤登记排在补区间**之前**,补不进去也不留假活动身份。
  // 同 retireLead：按持有的那一份集合放,并且从此不再接受新的持有（第 8 轮审查必须修 1）。
  const closing = [...new Set([
    ...heldTurns(lead),
    ...closeLeadTurns(lead),
    // `turnStart` 也并进来而不是当退路:作用域关掉之后迟到的那次开始只落了行、没人持有
    // （`holdTurn` 的 closedScopes 分支只写这个字段）,不收它那一行就一直缺着收口。
    ...(lead.turnStart ? [lead.turnStart] : []),
  ])];
  // 墙钟按**最早**那个起点算 —— 它就是执行器真正在跑的那一轮（队首）。退化成 `turnStart`
  // 的老写法在换台那一路取到的是最新那个起点,用时被算少一大截。
  const spent = closing.length
    ? Math.max(0, Date.parse(endIso) - Math.min(...closing.map((at) => Date.parse(at))))
    : 0;
  // 进程没走 `endTurn` 就没了（异常退出、被停、被回收），手上这个回合还开着：它的区间得
  // 在这儿补一行。不补就只剩「会话结束了、最后一个回合没有记录」，产物归属读到那个缺口
  // 只能按会话寿命估，那一回合真做出来的东西要么被滤掉要么混进别人的（第 2 轮审查 F1）。
  for (const startedAt of closing) {
    await recordTurnSpan({ sessionId: lead.sessId, taskId: lead.taskId, cwd: lead.cwd, startedAt, endedAt: endIso });
  }
  // CLI 否认了这条会话:把失效的 id 连同由它派生的三件套恢复命令一起清掉,下一次说话
  // 就会开一条全新会话(openResident 的判据就是「这行上有没有 cli_session_id」)。
  // 退出码 0 也要求上:正常收尾的回合不该因为正文里出现过这句话就丢掉会话。
  // superseded 也要排除:这条会话行已经被新进程接管了(工作目录被抽走那条路会复用同一
  // 行),晚到的旧收尾要是把新进程刚报上来的有效 id 抹掉,新常驻会话的 id 就永久丢了
  // —— 内存里 lead.cliSessionId 已是新值,那条「id 变了才写库」的分支不会再补写一次。
  const dropSession = shouldDropSession(rotation.fault, exitStatus) && !superseded;
  let dropNote = dropSession ? sessionResumeFaultNote(rotation.fault!) : null;
  // 被接管的一方连这条会话行也不许再 finalize:接管那条路会**复用同一行**(openLead 的
  // resuming 分支),新进程刚把 endedAt/exitStatus 清成 null 表示「这一段正在跑」。晚到的
  // 旧收尾一写,页面就同时看到「调度台在线」和「这条会话已退出」;activeMs 还会把两段
  // 重叠的墙钟时间重复计一遍(2026-08-26 第 7 轮审查)。这道闸现在住在 updateOwnSession
  // 里(第 9 轮审查:只在这儿挡,beginTurn/endTurn 就漏了),这里只管别把收尾停在半路 ——
  // 事件流、写流与内存 lead 仍须正常释放。
  const persisted = await updateOwnSession(
    lead,
    "调度台收尾状态",
    {
      exitStatus,
      endedAt: endIso,
      activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${spent}`,
      ...(dropSession ? LOST_SESSION_PATCH : {}),
    },
    endIso,
  );
  // 没写进去就不能沿用「恢复字段已清掉」的文案:库里那个坏 id 还在,下一次照样撞它。
  // (superseded 那一路 dropSession 恒为 false,所以「摘牌导致没写」不会走进这句。)
  if (!persisted && dropSession) dropNote = SESSION_DROP_PERSISTENCE_FAILED_NOTE;
  // 「再说一句话就能接回」成立要两个条件:手上真有一个 CLI 会话 id,而且它**已经落进库**
  // —— openResident 的判据就是会话行上那一列。fresh 调度台在拿到 thread id 之前就异常,
  // 或者凭据到最后一次补写也没写进去,照着那句话去点「继续」只会开一条全新会话,上下文
  // 一个字都回不来(2026-08-25 第 4 轮审查)。
  const resumable = !!lead.cliSessionId && !lead.pendingCredential;
  // 收尾的每一句指路都按它写:这条 CLI 会话到底还接不接得回。
  const canResume = resumable && !dropSession;
  if (lead.closing === "recycle") {
    // 回收就发生在这里,dropSession 已经算得出来 —— 当场照实写,不留需要更正的话。
    recordSystemTurn(lead, RECYCLE_NOTE(Math.round(IDLE_MS / 60_000), canResume));
    lead.closingSaidRotated = true;
  } else if (!lead.closing && (aborted || exitStatus !== 0 || (dropSession && !rotation.announced))) {
    // 既不是回收也不是手停 —— 进程自己没了。会话还在,说句话就能接回;除非 CLI 刚
    // 否认过或判定 poisoned，那句「会话还在」就成了把用户推回同一堵墙的错误指路。
    // rotation.announced:中途已经播过同一条轮换说明**且属实**了,这里只补「进程意外
    // 退出」那半句,别把整段话重复第二遍。
    const rotationNote = dropSession ? (rotation.announced ? ROTATION_ALREADY_ANNOUNCED : dropNote) : null;
    // 「它是怎么没的」这半句要如实:事件流被掀翻时我们从没收到过退出码,不能编一个
    // 「exit N」冒充进程自报;dropSession 独自成立那一路(exit 0、正常收尾)则一个字都不加。
    const how = aborted
      ? "调度台事件流异常中断,进程已收掉。"
      : exitStatus !== 0
        ? `调度台进程意外退出(exit ${exitStatus})。`
        : "";
    const msg = `${how}${rotationNote ?? (resumable ? "CLI 会话还在,再说一句话会自动接回;需要的话也可以点「继续」。" : NO_RESUMABLE_SESSION_NOTE)}`;
    // 「进程自己没了」是真失败,红着走 error;剩下那一路(exit 0、没被掀翻,只是这条会话
    // 不能再续)跟中途 scope:"session" 的旁注同一档 —— 一个正常交卷的回合不该在执行过程
    // 里记一笔异常。
    if (aborted || exitStatus !== 0) {
      writeRunError(lead.out, msg);
      traceLead(lead, lead.turnStart ?? endIso, { kind: "error", message: msg }, endIso);
      publish(lead, { kind: "error", message: msg });
    } else {
      noteSessionNotice(lead, msg);
    }
  }
  // 「停止全组」和工作目录那两句是**按下按钮时**写的,那时会话可能还在,而它到这一步才
  // 作废 —— 不当场更正,用户刷新后看到的指引与真实状态正好相反,照做一次再撞一次墙。
  // 按下按钮时就已经照实说了(haltTeam 的 closingSaidRotated)、或者上面回收那句刚写过
  // 的,就没有「上面那条」需要更正,只补一句**为什么**接不回;中途已经完整播过同一段
  // 轮换说明的话,连这句也不必再说。
  //
  // 这是**用户自己点的停止/自然回收**,本回合没有任何失败:所以是 system 旁注,不是
  // 红色执行诊断(2026-08-26 第 7 轮审查)。真失败仍然红 —— 恢复字段没清成那一路,
  // persistOrReport 已经把写库失败如实报过一笔,`why` 里那句也带着「失败」二字,前端
  // 摘掉中性文案后照样判红(见 @ash/shared/session-notes)。
  if (lead.closing && !canResume) {
    // dropNote 与 dropSession 同生同灭(见上面它的声明),所以这一支里它一定有值。
    const why = dropSession ? (rotation.announced ? ROTATION_ALREADY_ANNOUNCED : dropNote!) : NO_RESUMABLE_SESSION_NOTE;
    if (!lead.closingSaidRotated) noteSessionNotice(lead, `更正上面那条:CLI 会话接不回了。${why}`);
    else if (!(dropSession && rotation.announced)) noteSessionNotice(lead, why);
  }
  writeTurnEnd(lead.out, endIso);
  flushSessionNotices(lead); // 回合中途攒下的轮换旁注:流关掉之前必须落盘
  lead.out.end();
  // 团队没有终态,进程没了就是待命。注意 lead.out 已经 end 了 —— 这一步失败只能走日志
  // 和 SSE,再往那条流里写一个字会当场 ERR_STREAM_WRITE_AFTER_END 打崩整个 server。
  // 失败同样要重试:这里写不进去,任务就永久停在 running(跟 setLeadStatus 同一个理由)。
  if (!superseded) {
    clearStatusRetry(lead);
    lead.wantedStatus = "idle";
    try {
      await setTaskStatus(lead.taskId, "idle");
      lead.wantedStatus = null;
    } catch (error) {
      console.error(`[ash] closeLead(${lead.taskId}) idle status failed:`, error);
      publish(lead, {
        kind: "error",
        message: `调度台待命状态写入数据库失败：${error instanceof Error ? error.message : String(error)}`,
      });
      armStatusRetry(lead);
    }
  }
}

  return {
    beginTurn,
    clearIdle,
    consume,
    recordSystemTurn,
    reportLeadFailure,
    retireLead,
  };
}
