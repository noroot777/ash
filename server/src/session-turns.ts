import { dbClient } from "./db/index.js";
import { id } from "./util.js";
import { clearTurnActive, closedAlready, markTurnActive } from "./session-turn-registry.js";
// 对外的门面：登记层的公开函数在这里原样再导出一遍（理由见下面文件头的最后一段）。
export {
  activeRegistrySize,
  activeTurnStarts,
  clearTurnActive,
  closeSessionTurns,
  closeTaskTurns,
  markTurnActive,
  nextTurnStart,
  primeTurnStarts,
} from "./session-turn-registry.js";
// 回合区间的**写入端**。读取端在 `task-artifact-windows.ts`（产物归属按时间认人），表的语义写在
// `db/schema-sessions.ts` 的 `sessionTurns` 上，这里不复述。
//
// 为什么单独一个文件而不是直接在各执行路径里 insert：single / duet / team 三条路各自
// 收尾（`single-run.ts`、`duet/turn.ts`、`team/session-consumer.ts`），同一件事落三份
// 就会漂移——其中一条忘了写，那类任务的产物归属就静默退回「按 session 寿命认」，而那是
// 看不出来的（面板只是多列几个别人的东西）。
//
// 一个回合的生命周期是**两步**，别只做一半：
//   ① `openTurn` —— 开始那一刻，往表里落一行「开了，还没收口」，同一批里把计数加上。
//   ② `recordTurnSpan` —— 收尾那一刻，按同一身份把 `ended_at` 补上。
// 只做第二步（原来的样子）就等于「写失败 = 什么都没发生」：后来成功的一轮一落账，读端
// 再也看不出中间少过东西,那一轮做出来的图被静默滤掉（第 4 轮审查必须修 1）。
//
// 起跑入口有**八处**（task-run 的 fresh run、orchestrator 的新建与复用、team/session 的
// 新建与复用、team/session-consumer 的 beginTurn、duet/turn 的新建与复用），所以这里要的是
// **一个入口承担全部不变量**,而不是指望八处都手写对：
//   • 回合起点字段从下面两个 helper 取,别在调用处手写;
//   • **计数只在 `openTurn` 里加**,而且加数的条件是「这个身份还不存在」——于是同一个起点
//     被开两次（团队那边先 `openLead`、紧接着又用同一个 `turnStart` 调 `beginTurn`）只会
//     计一次。第 4 轮把加数放在字段 helper 里,那条路上重复调用凭空多出一轮,于是那条会话
//     永远报「缺一个回合记录」（第 5 轮审查必须修 2.1）。
//   • 整批写失败时**按身份**记一笔欠账：行和计数同批写之后两边同生共死,对账再也看不出缺口,
//     只有写端自己知道刚才漏了一轮（第 5 轮审查必须修 2.3）。欠的是**那一行开始记录**,库
//     一恢复就按同一个身份补上去——压成一个无身份的计数的话,同一个身份后来重试成功也消不掉
//     它,读端只能继续把整条会话寿命算成宽的（第 1 轮审查 F2,见 `unconfirmed`）。
//   • **回合起点在这里分配**（`nextTurnStart`）,起跑入口不许自己取 `now()`：墙钟毫秒不是身份。
//     同一条会话上两次投递撞在同一毫秒,时间字符串就是同一个值——所有权层的队列把两轮合成一个
//     位置、唯一键把两行合成一行,于是后开那一轮被前一轮的结束事件当场收口,它真正干活那段落进
//     空洞,做出来的东西永久漏在清单外（第 2 轮审查 F1）。
//   • **同一身份的那一行只能往前走**：无行 → 开了 → 收了。开始与结束哪个先到、重放几次都
//     不许丢掉已经拿到的结束事实,所以合并由**一个原子批**自己完成（`writeTurnRow`）,不是
//     「先查一眼有没有行再决定插还是改」——查和写之间一让出执行权,另一条路就把那一行插进去了,
//     补插被唯一键挡掉、已知的收尾时刻当场蒸发（第 1 轮审查 F1）。
//   • **起点真撞上历史身份时照实降级**：水位只活在进程内存里,重启之后那张表是空的。所以
//     复用历史会话之前先把库里用过的最晚起点接回来（`primeTurnStarts`）,万一还是撞上了
//     （没接、或者水位被淘汰过）,写端记一笔持久的 `turns_lost`,读端把那一段降成未知——
//     绝不把旧记录当成新一轮（第 1 轮审查 F2）。
//   • **结束不可逆**：`markTurnActive` 返回「收下了没有」,不晚于已关闭水位的开始信息一律拒掉。
//     迟到的开始回调只能**补持久记录**（`openTurn` 照写那一行）,不许把一个已经终结的身份重新
//     登记成活动——重新登记出来的那个幽灵会被下一次结束消耗掉,真正刚结束的身份则一直留在册上,
//     读端把区间开到无穷（第 2 轮审查 F2）。所有开始入口共用这一条,靠的就是都从这儿过。
//   • **行与计数同批、消账按身份**：开始、收尾补插、幂等重放三条路都走 `persistTurn`,落成了就
//     划掉**那一个**身份的欠账。少这一条,收尾补插出来的完整记录仍被当成缺口,读端照 `missing>0`
//     把整条会话寿命重新算进候选区间,停工期间别人做的东西又被收进来（第 2 轮审查 F3）。
//
// **登记那半截在 `session-turn-registry.ts`**（活动身份、两道水位、起点分配）：它是内存里的
// 册子,进程重启即清空,跟这里的落账不是一回事。对外仍然只有这一个入口 —— 下面把它的公开
// 函数原样再导出一遍,所以调用方只认 `session-turns.js`,拆文件纯粹是为了别顶破 700 行。

/**
 * **没能落账的开始意图**：`session_id` → 那几个连一行都没写进去的回合**身份**（起点 → 它
 * 当时的 task / cwd）。
 *
 * 为什么光靠库里那一笔标记不够：开始那一批整个回滚之后,补标记的目标**还是刚刚写失败的那个
 * 库**,它很可能一起失败——那就只剩一句日志。而下一轮一落账,成功计数和成功身份数又重新
 * 相等,读端于是宣称完整,中间那一轮做出来的图被静默滤掉（第 6 轮审查必须修 2）。所以未确认
 * 的意图先留在内存里：读端把它直接算进缺口（哪怕库里一个字都没有）,下一次开回合时再试着
 * 持久化。进程同时被杀且库从未写成那一笔才会真丢——那一档物理上没有别的办法,不装作记住了。
 *
 * **为什么连 task / cwd 一起记下来**：要补的是**那一行开始记录本身**,不是一个「少了一轮」
 * 的数字。原先 `flushUnconfirmed` 把这些意图压成 `sessions.turns_lost` 上的一个计数,身份就
 * 此丢了——同一个身份后来重试成功（库恢复后的重试、团队那边先开台再 `beginTurn` 用的都是
 * **同一个** `turnStart`）,那个计数还挂在那儿,读端照它把整条会话寿命算成宽的,两轮之间歇
 * 着的那段时间里别人做的图又被收进来,面板还谎称「有一次连开始都没留下记录」（第 1 轮审查
 * F2）。按身份补行,所以「消账」这个动作也必须**按身份**（`confirmTurn`）：补上的那一行就
 * 是那一轮的记录,它和后来的重试、以及收尾那下发现开始行不在时的补插,走的是同一个幂等批
 * （`persistTurn`）——谁先成功都只留一行、只加一次数,成功的那一个把它自己那笔欠账划掉。整条
 * 会话一把清是错的:清的那一刻另一个身份可能刚欠上账,它会被连带抹掉（第 2 轮审查 F3 的同类
 * 并发位置 C4）。补上之后那一轮从「整段会话都算不准」升级成「开了没收口」——末端估到下一个
 * 回合起点,窄得多,照实标 approx;而走**补插**那条路补齐的是一行完整记录,连那一句「算不准」
 * 都不必再说。
 */
const unconfirmed = new Map<string, Map<string, { taskId: string; cwd: string | null }>>();

/** 这条会话有几个开始意图还没被确认落账（读端把它算进缺口）。 */
export function unconfirmedTurns(sessionId: string): number {
  return unconfirmed.get(sessionId)?.size ?? 0;
}

function rememberUnconfirmed(input: TurnStartInput): void {
  const { sessionId, taskId, cwd, startedAt } = input;
  const who = { taskId, cwd: cwd ?? null };
  const seen = unconfirmed.get(sessionId);
  if (seen) seen.set(startedAt, who);
  else unconfirmed.set(sessionId, new Map([[startedAt, who]]));
}

/**
 * 把欠着的那几个身份补成真正的开始行。开回合时先试一次：库恢复了就不再依赖内存。
 *
 * **逐个身份各自成败**：一个补成了就由 `persistTurn` 按身份划掉,剩下的留着下次再试。补成功
 * 才移除,所以同一笔账不会两边各算一次（读端 = 库里的行 + 内存未确认）。
 *
 * **迭代的是快照,消的是那一个身份**：下面每一笔都要 await,这期间另一条路完全可以往同一张
 * Map 里加一个新身份（它自己的开始批刚失败）。照「这一轮 flush 完了就把整条会话清掉」做,
 * 那个刚欠上的身份会被连带抹掉——读端从此看不见它,而库里也确实没有那一行（C4）。
 */
async function flushUnconfirmed(sessionId: string): Promise<void> {
  const owed = unconfirmed.get(sessionId);
  if (!owed?.size) return;
  for (const [startedAt, who] of [...owed]) {
    try {
      await persistTurn({ sessionId, taskId: who.taskId, cwd: who.cwd, startedAt });
    } catch (error) {
      // 还是写不进去：这一笔和它后面那些都留在内存里,读端照样看得见缺口。
      console.warn(`[ash] 欠着的 ${owed.size} 笔「漏了一个回合」还没补进库（这一段按未知披露）: ${String(error)}`);
      return;
    }
  }
}

/**
 * 这个身份在库里**确实有记录了**：划掉它那一笔欠账（只划这一个）。
 *
 * 三条路都要调：开始行写成了、收尾时补插了一行完整记录、以及发现库里早就有完整行的那次重放。
 * 漏掉后两条的后果不是少说一句提示,而是**假缺口**：读端 = 库里的行 + 内存未确认,于是一笔已经
 * 恢复的事实继续被算成缺口,整条会话寿命被重新算进候选区间,停工期间别人在同一个目录里做的东西
 * 又被收进来,面板还说「有一次连开始都没留下记录」（第 2 轮审查 F3）。
 */
function confirmTurn(sessionId: string, startedAt: string): void {
  const owed = unconfirmed.get(sessionId);
  if (!owed) return;
  owed.delete(startedAt);
  // 真空了才摘掉整条会话的条目 —— 判据是**当下**这张 Map,不是进来时的那个快照。
  if (!owed.size) unconfirmed.delete(sessionId);
}

/**
 * 这个任务真的被删了：把它名下那几笔「没落账的开始意图」一起扔掉。
 *
 * 为什么要有这个出口：`unconfirmed` 只在「同一条会话又开一个回合」时才有人去补、去划掉
 * （`flushUnconfirmed`）。任务连会话带行一起删之后再也不会有那一下,这几笔就成了无主条目,
 * 长命进程里只增不减（第 1 轮审查 N3）。
 *
 * **只在确实删除时调**：普通的暂停、失败、停止一律不清——那几笔还是有效证据,读端要靠它说
 * 「有一次运行连开始都没留下记录」。
 */
export function forgetTaskUnconfirmed(taskId: string): void {
  for (const [sessionId, owed] of [...unconfirmed]) {
    for (const [startedAt, who] of [...owed]) {
      if (who.taskId === taskId) owed.delete(startedAt);
    }
    if (!owed.size) unconfirmed.delete(sessionId);
  }
}

/**
 * 新建会话行时的回合字段。
 *
 * **不含计数**：那是 `openTurn` 的事（同一批里加，条件是身份还不存在）。这里只声明
 * 「这条会话没有升级前的未知历史」——`turns_base_approx = 0` 同时兼作迁移的幂等标记，
 * 回填只认 `turns_base_approx IS NULL`（**不是** `turns_base IS NULL`：上一版就已经会写
 * `turns_base: 0` 了,照 base 判会把那一版不可信的计数当成已回填过,理由写在
 * `db/migrate-session-turns.ts` 的回填 SQL 上）。
 */
export const freshTurnFields = (at: string) => ({
  turnStartedAt: at,
  turnsBase: 0,
  turnsBaseApprox: false,
});

/**
 * 复用同一行会话、又开一个回合时要刷的字段。
 *
 * `endedAt: null` 也在这里：会话重新开跑就不再是「已收尾」,漏掉它的那一处会让读端把这条
 * 会话当成结束了的（区间按老的收尾时刻截断）。计数同样不在这里加，理由见文件头。
 */
export const resumedTurnFields = (_at: string) => ({
  turnStartedAt: _at,
  endedAt: null as string | null,
});

/**
 * 回合**开始**：落一行「从 X 开始、还没收口」，同一批里把 `turns_started` 加上。
 *
 * **绝不抛**，理由同 `recordTurnSpan`：这一行只影响产物面板的归属精度,而调用它的地方正在
 * 起跑。写不进去就记一笔 `turns_lost`,读端据此照实说「有一次运行连开始都没留下记录」。
 *
 * **幂等**：同一 (session_id, started_at) 再调一次既不插行也不加数（唯一索引挡插入、
 * `NOT EXISTS` 挡加数）。接回、重试、团队那边同起点再开一次台都会重放同一个身份。
 */
export async function openTurn(input: {
  sessionId: string;
  taskId: string;
  cwd: string | null | undefined;
  startedAt: string | null | undefined;
}): Promise<void> {
  if (!input.startedAt) return;
  const startedAt = input.startedAt;
  // 先登记活动身份：登记得比写库早一点没有坏处,反过来晚一点就有——那个窗口里面板会把
  // 正在写的这一轮算成「崩了没收口」。
  markTurnActive({ sessionId: input.sessionId, taskId: input.taskId, startedAt });
  // 上一轮欠着的身份在这里补：那时库正坏着,现在也许好了。放在新回合落账**之前**,这样
  // 「后来成功的一轮」永远不会先把两个数凑相等再让欠账无声无息（第 6 轮审查必须修 2）。
  // 补的恰好是同一个身份时（库恢复后用同一个 `startedAt` 重试）这一步就把它落完了,下面
  // 那个批成了空操作——两条路共用一个幂等批,所以谁先成功都只留一行、只加一次数。
  await flushUnconfirmed(input.sessionId);
  try {
    // **撞号判据在落批之前这一刻问,而且这一问到落批之间不许有 await**：上面那句 await 期间
    // 同一个身份完全可能已经被收口了（收尾与迟到的开始本来就交错),那时库里那条收过口的行
    // 恰恰是它自己的,不是撞号。中间一让出执行权,F1 那个并发收尾就会被错报成撞号。
    // `persistTurn` → `writeTurnRow` → `dbClient.batch` 之间全同步,所以这个判据跟批是同序的。
    const wrote = await persistTurn({ ...input, startedAt }, null, !closedAlready(input.sessionId, startedAt));
    if (wrote === "collided") {
      console.warn(
        `[ash] 回合起点撞上一条已结束的历史记录（重启 + 墙钟回拨?）,这一轮按未知披露: ${input.sessionId} @ ${startedAt}`,
      );
    }
  } catch (error) {
    await noteTurnLost({ ...input, startedAt }, error);
  }
}

/** 一个回合的身份,加上落这一行所需要的其余事实。 */
type TurnStartInput = {
  sessionId: string;
  taskId: string;
  cwd: string | null | undefined;
  startedAt: string;
};

/** 这一批**实际**对那一行做了什么。两件判断都靠它,所以它只能来自批里语句的影响行数。 */
type TurnWrite =
  /** 这一行是我插的（开始行,或者收尾那下一次落下的完整行）。 */
  | "inserted"
  /** 行早就在,是我把已知的收尾时刻补上去的。 */
  | "merged"
  /** 这个起点在库里**已经是一条收过口的记录**,而它应该是新的一轮：撞上了历史身份。 */
  | "collided"
  /** 行在,这一批没有新事实可加（重放）。 */
  | "present";

/**
 * 「开过这一轮」的那一批写入：加计数 + 落回合行 + **把已知的收尾时刻合并上去**。
 * **会抛**（调用方决定是记欠账还是重试）。
 *
 * `endedAt` 为 null = 只知道起点（`openTurn`、补欠账）；给了值 = 这一下同时知道起止
 * （`recordTurnSpan`）。**两种都要加计数**：计数和行是同一件事的两面,只插行不加数等于把一笔
 * 已经恢复的事实继续记成缺口（第 2 轮审查 F3）。
 *
 * **一个原子批,四条语句,顺序都不能换**：
 *   ① 加数在前,它的 `NOT EXISTS` 问的是插入**之前**的状态；插在前就永远加不上数了。
 *   ② 插行。被唯一键挡掉只说明「这个身份已经有行了」,不说明那一行已经收过口。
 *   ③ **收尾合并**——②被挡掉时把 `ended_at` 补到现存那一行上。这条就是「同一身份的那一行只能
 *      往前走」这条不变量的实现：先查一眼再决定插还是改的那一版,在查与写之间让出执行权,
 *      另一条路插进去的空行会把补插挡掉,已知的收尾时刻当场蒸发,而函数照样正常返回
 *      （第 1 轮审查 F1）。
 *   ④ **撞号降级**——这个起点在库里已经是一条收过口的记录,而调用方说它该是新的一轮：那是
 *      重启 + 墙钟回拨之后重发了历史身份（见 `primeTurnStarts`）。这一轮永远不可能再补出
 *      属于自己的行（那个身份在库里已经是别人的了）,没有任何重试能消掉它,所以它恰好就是
 *      `turns_lost` 的语义；记在库里而不是内存里,重启之后那句披露还在（第 1 轮审查 F2）。
 *
 * 四条同生共死,所以不存在「行写上了计数没加」「收尾合并成了但账没记」这种中间态——那些中间态
 * 在这里全是错的方向（计数偏小正好抵掉真缺口）。
 *
 * **幂等**：同一 (session_id, started_at) 再跑一次既不插行也不加数,已经收过口的也不会被改晚
 * （③ 的 `ended_at IS NULL`,认第一次）。补欠账、团队那边同起点再开一次台、接回重试、收尾补插,
 * 走的都是这一个批。
 */
async function writeTurnRow(
  input: TurnStartInput,
  endedAt: string | null,
  fresh: boolean,
): Promise<TurnWrite> {
  const args = {
    row: id(),
    sid: input.sessionId,
    task: input.taskId,
    cwd: input.cwd ?? null,
    at: input.startedAt,
    end: endedAt,
  };
  const [, inserted, merged, collided] = await dbClient.batch([
    {
      sql: `UPDATE sessions SET turns_started = COALESCE(turns_started, 0) + 1
              WHERE id = :sid
                AND NOT EXISTS (
                  SELECT 1 FROM session_turns WHERE session_id = :sid AND started_at = :at
                )`,
      args: { sid: args.sid, at: args.at },
    },
    {
      sql: `INSERT OR IGNORE INTO session_turns (id, session_id, task_id, cwd, started_at, ended_at)
              VALUES (:row, :sid, :task, :cwd, :at, :end)`,
      args,
    },
    {
      // `ended_at IS NULL` = 只收**还开着**的那一行（已经收过口的认第一次：团队那边旧调度台
      // 也可能来收一次,改晚了就是个假区间）。`:end IS NULL` 时整条是空操作——开始行的重放
      // 没有结束事实可加。cwd 用 COALESCE：收尾那下没带目录,不该把开始时记下的那个抹掉。
      sql: `UPDATE session_turns SET ended_at = :end, cwd = COALESCE(:cwd, cwd)
              WHERE session_id = :sid AND started_at = :at
                AND ended_at IS NULL AND :end IS NOT NULL`,
      args: { sid: args.sid, at: args.at, end: args.end, cwd: args.cwd },
    },
    {
      // 只在**开始**那一下查（`:end IS NULL`）、且调用方说这是新的一轮（`:fresh`）时才算撞号。
      // ② 真插进去了的话这里的 EXISTS 必然为假（那说明压根没有旧行）,所以不会把自己刚落的
      // 完整记录当成撞号。会话行不在（夹具只插回合行）时这条影响 0 行：没有会话行可披露,
      // 判据照常落回 `present`。
      sql: `UPDATE sessions SET turns_lost = COALESCE(turns_lost, 0) + 1
              WHERE id = :sid AND :fresh = 1 AND :end IS NULL
                AND EXISTS (
                  SELECT 1 FROM session_turns
                    WHERE session_id = :sid AND started_at = :at AND ended_at IS NOT NULL
                )`,
      args: { sid: args.sid, at: args.at, end: args.end, fresh: fresh ? 1 : 0 },
    },
  ]);
  if (inserted.rowsAffected > 0) return "inserted";
  if (merged.rowsAffected > 0) return "merged";
  if (collided.rowsAffected > 0) return "collided";
  return "present";
}

/**
 * **按身份落账的唯一写入口**：落行 + 加数 + 合并收尾（同一个原子批）,之后划掉这个身份的欠账。
 *
 * 开始、收尾、幂等重放三条路共用它。分成「开始走这个、补插走那个」的那一版,补插出来的
 * 完整记录既不进计数也不消欠账,于是读端继续按缺口把整条会话寿命算宽（第 2 轮审查 F3）。
 *
 * **撞号那一档也要划掉内存欠账**：缺口已经换成库里那一笔 `turns_lost`,两边各算一次就等于
 * 把一轮缺口说成两轮。
 */
async function persistTurn(
  input: TurnStartInput,
  endedAt: string | null = null,
  fresh = false,
): Promise<TurnWrite> {
  const wrote = await writeTurnRow(input, endedAt, fresh);
  confirmTurn(input.sessionId, input.startedAt);
  return wrote;
}

/**
 * 「这一轮整个没记上」记一笔 —— **按身份记,不是记一个数**。
 *
 * 这是唯一还知道刚才漏了一轮的地方：行和计数同批写,都失败时库里两个数仍然相等,对账一点
 * 痕迹都看不出来（第 5 轮审查必须修 2.3）。而补这一笔的目标还是刚刚写失败的那个库,所以
 * **先把身份记在内存里**（`unconfirmed`）再试持久化,写成了才把内存那笔划掉；没写成就留着,
 * 读端照样把它算进缺口,下一次开回合时再试（第 6 轮审查必须修 2）。
 *
 * 持久化的形式是**补那一行开始记录**,不是往 `sessions.turns_lost` 上加一个数：数字欠账没有
 * 身份,同一个身份后来重试成功也消不掉它,读端只能继续把整条会话寿命算成宽的（第 1 轮审查
 * F2,机制见 `unconfirmed` 的注释）。`turns_lost` 从此只是**旧版留下的只读历史**。
 */
async function noteTurnLost(input: TurnStartInput, cause: unknown): Promise<void> {
  console.warn(`[ash] 回合开始没落盘（这一轮按缺口披露）: ${String(cause)}`);
  // **先记内存,再试库**。顺序反过来就又回到「补写也失败 = 只剩日志」那一步：那一笔账从此
  // 没人记得,下一轮一落账两个数就重新相等（第 6 轮审查必须修 2）。
  rememberUnconfirmed(input);
  await flushUnconfirmed(input.sessionId);
}

/**
 * 记下「这一回合从 X 跑到 Y，干活的目录是 Z」。
 *
 * **绝不抛**：这一行只影响产物面板的归属精度，而调用它的地方正在做回合结算——那条路上
 * 任何意外都会变成「任务状态结算不下去」。写不进去就降级回老行为（按 session 寿命认），
 * 代价是面板可能多列几个同目录别的任务的东西，不是数据错乱。
 *
 * **按身份收口,一个原子批把三种情形一次办完**（`writeTurnRow`）：没有行就落一条完整的、
 * 有开着的行就把 `ended_at` 合并上去、已经收过口的不动（认第一次——团队那边旧调度台也可能
 * 来收一次,改晚了就是假区间）。
 *
 * **这里不许先查一眼再决定插还是改**：查到无行之后到补插之间要让出执行权,而迟到的
 * `openTurn` 正好在那个窗口里插进同一身份的空行,补插被唯一键挡掉、函数照样正常返回,于是
 * 已经拿到的收尾时刻凭空蒸发——读端把那一轮估到下一轮起点,停工期间别人做的图被收进来,
 * 面板还反过来说「这次运行没有正常结束」（第 1 轮审查 F1,实测只需 `Promise.all` 并发调用,
 * 不需要任何写库故障）。
 *
 * **三条情形都要按身份确认那笔欠账**（`persistTurn`）：补插和重放同样是「这个身份在库里确实
 * 有记录了」的证据。原先只有「再开一次回合」那条路消账,于是「开始一直失败、库恢复后直接正常
 * 收尾」这条恢复路线留下一笔永远消不掉的假缺口（第 2 轮审查 F3）。
 */
export async function recordTurnSpan(input: {
  sessionId: string;
  taskId: string;
  cwd: string | null | undefined;
  startedAt: string | null | undefined;
  endedAt: string;
}): Promise<void> {
  // 起点取不到就没有区间可言（宁可不记，也不要记一条起点是「现在」的假区间：那会把
  // 这一回合真正写出来的东西全判到区间之外）。
  if (!input.startedAt) return;
  const startedAt = input.startedAt;
  // 收尾了就不再是活动身份。放在写库**之前**：这一行只影响「还在写吗」的判断,写库失败时
  // 更要让它回到「未知」那一档,而不是继续被当成正在跑（区间会一直开到无穷）。顺带也把
  // 「这个身份是本进程自己关的」这件事记进水位,撞号判据靠它分得出自己和别人（`closedAlready`）。
  clearTurnActive(input.sessionId, startedAt);
  try {
    await persistTurn(
      { sessionId: input.sessionId, taskId: input.taskId, cwd: input.cwd, startedAt },
      input.endedAt,
    );
  } catch (error) {
    console.warn(`[ash] 回合区间没落盘（产物归属降级为按会话寿命认）: ${String(error)}`);
  }
}
