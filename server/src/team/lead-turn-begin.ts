// 常驻调度台**一个回合开始**那一半的库侧动作。
//
// 从 `session-consumer.ts` 拆出来的理由同 `lead-voice.ts` / `lead-status.ts`:那份又顶到了单文件
// 上限(根 CLAUDE.md 的 700 行),而这一件事自成一块 —— 它只回答「这个回合身份现在还该不该
// 被当成正在跑」,然后照答案决定写哪几笔。消费循环、关台收尾、待送消息都不在这里。
//
// 闭包里只缺一样:`setLeadStatus`(那组「这台说了算吗」的判据住在 lead-status.ts),所以照同一个
// 模式做成工厂,别把状态层整个搬过来。
import type { Lead } from "./session-types.js";
import { closedAlready, nextTurnStart, openTurn, resumedTurnFields } from "../session-turns.js";
import { holdTurn } from "./lead-turns.js";
import { updateOwnSession } from "./lead-session-writes.js";
import { traceLead } from "./lead-voice.js";

interface Deps {
  setLeadStatus: (lead: Lead, status: "running" | "idle", at?: string) => Promise<void>;
}

export function createLeadTurnStart({ setLeadStatus }: Deps) {
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
    // **投入 ≠ 切换正在执行的那一轮。** 队首(`lead.turnStart`,见 lead-turns.ts 的 adoptFront)
    // 才是执行器此刻在跑的那个;用户插话时这里开的 T2 排在 T1 后面,而 T1 要等它自己的 turnEnd。
    // 行上的 `turn_started_at` 照旧刷成 T2(那一列记的是**最近一次投入**,产物归属不靠它,
    // 见这个函数顶部),但「上游停滞」那个标记不能跟着清 —— T1 可能正卡在重连上、警告已经亮着,
    // 而补一句话既不是恢复也不是回合结束(第 3 轮审查 F2,已实测:补一句话红环当场消失、刷新
    // 也不回来)。
    const queuedBehind = lead.turnStart !== null && lead.turnStart !== at;
    const stamped = await updateOwnSession(lead, "回合开始状态", { ...resumedTurnFields(at, { queuedBehind }) }, at);
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
  return beginTurn;
}
