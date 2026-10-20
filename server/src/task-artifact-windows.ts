import { asc, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { monitors } from "./db/schema-monitors.js";
import { sessionTurns, sessions } from "./db/schema.js";
import type { WorkspaceRoot } from "./file-browser.js";
import type { PathLens } from "./task-artifact-paths.js";
import { activeTurnStarts, unconfirmedTurns } from "./session-turns.js";
import { isDiagnosticSession } from "./turn-failure.js";

// 「它什么时候在写这个目录」——共享工作区上唯一能把任务分开的线索。归属证据的另一档
// （目录独占）和入口在 `task-artifact-scope.ts`。
//
// 区间从哪来，三处，一处都不能少：
//   • `session_turns` —— 每个回合一行，精确。**首选**。
//   • 没有回合记录的会话（这张表之前的老行）—— 只能退回整条会话寿命。这是本表出现前
//     的老行为：宽，但不漏。
//   • `monitors` —— 哨兵的生命周期。回合结束不等于它所属的后台工作结束。
//
// 为什么不能拿 `sessions` 那一行当区间：它跨回合复用（续聊只刷新 `turn_started_at`、清
// `ended_at`），所以「第一次建立」到「最后一次收尾」之间可能空了四个钟头——那期间别的
// 任务在同一个目录里做出来的东西会全被收进它名下（第 1 轮审查 F1）。`active_ms` 也救不
// 了：它给得出各回合的总时长，给不出位置。

/**
 * 一段「它在写这个目录」的时间（毫秒时间戳，闭区间；end 可以是 Infinity = 还在写）。
 *
 * `approx` 是**这一段的来路**：落账过的回合是精确的（false），从会话行推断出来的是宽的
 * （true）。推断出来的区间里可能横着别人的产出，所以每一段 approx 都要在面板上说出来——
 * 「记录缺了」既不能当成「这段时间它一直在跑」（串台），也不能当成「它没跑过」（漏报），
 * 只能当成「这段算不准」（第 2 轮审查 F1）。
 */
export interface RunWindow {
  start: number;
  end: number;
  approx?: boolean;
}

/**
 * `runWindows` 认人只要一个 id，不必是整行 task。
 *
 * **刻意不要 `status`**：「这一刻还在写吗」只由写端的活动身份登记回答（`session-turns.ts` 的
 * 内存册子，进程重启即清空）。任务状态是**二手的**——团队调度台的 `running` 要等一次写库，
 * 失败还要重试，那个窗口里拿它当否决条件就会把一个已经登记在册、确实在写的回合判成不活动
 * （第 1 轮审查 F3 的同类位置）。
 */
export interface RunOwner {
  id: string;
}

/**
 * 回合收尾之后还可能继续落盘的一点宽限。**只用在没有回合记录的老会话上**：有记录的回合
 * 用自己的区间，独占目录根本不设上限。
 *
 * 这个十分钟**只给推断出来的那几档**（没有逐回合记录的老会话、缺了的那几段）：它们本来就
 * 是宽的、也照实标了 `approx`。落账过的回合和哨兵自己的区间是**实测**的，末端只给
 * `SETTLE_MS`——共享目录上，窗口每放宽一分钟就多吃一分钟别人的产出。
 */
const TURN_GRACE_MS = 10 * 60 * 1000;
/**
 * 精确区间（落账过的回合、哨兵自己的生命周期）末端的落定余量。
 *
 * 这一档**不给十分钟**：那是「结束之后可能还有输出」的推测，而推测不该冒充运行时间——
 * 前一个任务 T+10 收工、后一个 T+11 开工，十分钟宽限会让前者把后者 T+12 做的图认成自己的
 * （第 3 轮审查必须修 1，两个任务压根没有并发）。真有回合之后才落盘的后台产出，证据是
 * **哨兵自己的区间**（`monitors`，它的进程由 ash 拉起、活得过回合），那一档本来就单独并进来；
 * 独占目录更是压根不吃时间。这里只需要盖住「收尾那一刻正在写的那个文件」——写盘、mtime
 * 取整、两次时钟读数之间的差，秒级够了。
 */
const SETTLE_MS = 2000;
/**
 * `ended_at` 是空的、任务却早已不在飞：那是**结算没留下收尾时刻**的老会话行（库里集中在
 * 2026-06，81/2355 条）。这种行按「从最后一个回合起算这么长」兜底。宁可宽一点多认几个，
 * 也不能当成「开放到现在」——那等于把这一档打回原形。
 */
const UNSETTLED_RUN_MS = 6 * 60 * 60 * 1000;
/**
 * 比对两个时刻时允许的抖动。回合起点和会话行上的 `turn_started_at` 来自两次不同的写，差
 * 几百毫秒是正常的；超过这个数才算「是另一个回合」。
 */
const TURN_SKEW_MS = 1000;

/**
 * 合并重叠的区间（升序、互不相交）。
 *
 * **两类分开合并**：推断出来的那一段通常把精确的几段整个套住，混在一起合完只剩一个大区间，
 * `approx` 这一维就此消失——于是靠推断认进来的产物会被当成实测证据，那句「这几个是候选」
 * 永远不会出现（第 3 轮审查必须修 1）。`windowHit` 据此先问精确、再问推断。
 */
function mergeWindows(spans: RunWindow[]): RunWindow[] {
  const mergeSame = (group: RunWindow[], approx: boolean): RunWindow[] => {
    group.sort((a, b) => a.start - b.start);
    const merged: RunWindow[] = [];
    for (const span of group) {
      const last = merged.at(-1);
      if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
      else merged.push({ start: span.start, end: span.end, approx });
    }
    return merged;
  };
  return [
    ...mergeSame(spans.filter((span) => !span.approx), false),
    ...mergeSame(spans.filter((span) => span.approx), true),
  ];
}

/**
 * 「它在写这个目录」的那几段。
 *
 * 每条会话按三种精度取值，顺序是**先精确后兜底**：
 *   1. 这条会话落账过的回合 → 各自的区间（+宽限）；
 *   2. 回合记录没覆盖到的早期（这张表建立之前就已经跑过的回合）→ 补 `[会话起点, 最早
 *      那条回合记录的起点]`。宽，但那段里真有它的产出，不能漏；
 *   3. 一条记录都没有 → 整条会话寿命（本表出现前的老行为）。
 * 还在飞的回合（写端登记在册的那些身份）一律**开到无穷**：它正在写，之后
 * 出现的东西只会是它写的；拿 `Date.now()` 当硬上限反而会漏掉刚落盘的文件（mtime 是亚毫秒
 * 浮点、`Date.now()` 是整毫秒，同一毫秒内读就判在窗口外）。
 *
 * **每条区间都要过 cwd 核对**：记下来的目录跟现在看的这个目录对不上，那段时间它在别处
 * 干活，跟这个目录里的东西无关。cwd 为空的（极老的行）只能接受。
 */
export async function runWindows(
  owners: readonly RunOwner[],
  root: WorkspaceRoot,
  lens: PathLens,
): Promise<{ windows: RunWindow[]; gaps: string[] }> {
  const ids = owners.map((row) => row.id);

  const [sessionRows, turnRows, monitorRows] = await Promise.all([
    db.select({
      id: sessions.id,
      cwd: sessions.cwd,
      worktreePath: sessions.worktreePath,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      turnStartedAt: sessions.turnStartedAt,
      // 下面三列只为**认出诊断会话**（`isDiagnosticSession`）：少一列就认不出来,于是一个
      // 压根没跑起来的任务也会拿到运行区间（第 1 轮审查 F4）。
      cliSessionId: sessions.cliSessionId,
      commandLine: sessions.commandLine,
      exitStatus: sessions.exitStatus,
      turnsStarted: sessions.turnsStarted,
      turnsLost: sessions.turnsLost,
      turnsBase: sessions.turnsBase,
      turnsBaseApprox: sessions.turnsBaseApprox,
      activeMs: sessions.activeMs,
    }).from(sessions).where(inArray(sessions.taskId, ids)),
    db.select().from(sessionTurns).where(inArray(sessionTurns.taskId, ids)).orderBy(asc(sessionTurns.startedAt)),
    // 哨兵：回合结束不等于它所属的后台工作结束（第 1 轮审查 F3）。
    db.select({
      taskId: monitors.taskId,
      cwd: monitors.cwd,
      startedAt: monitors.startedAt,
      endedAt: monitors.endedAt,
      expiresAt: monitors.expiresAt,
      status: monitors.status,
    }).from(monitors).where(inArray(monitors.taskId, ids)),
  ]);

  /**
   * 这条记录说的目录，跟我们正在看的这个**算不算同一摊活**。三档，别只留两档：
   *
   *   `exact`     —— 就是这个目录。
   *   `stale`     —— 记录下来的目录**已经不在了**（worktree 被删，面板因此降级到主仓展示），
   *                  或者那条老行压根没记目录。谁也无从查证它当时往哪儿写，而这个降级后的
   *                  目录是唯一还能展示的地方：接受，但算**宽的**（approx）。
   *   `elsewhere` —— 目录还在，只是不是这个。那它当时在那儿干活，产物就该在那儿看：排除。
   *                  跨仓的一律落这一档。
   *
   * 为什么不是「同仓就算」（第 1 轮 N4 之后我一度放宽到这一步）：那等于认了「它可能往主仓
   * 写过」就把那段时间主仓里所有东西都判给它，同组里各开 worktree 的执行者、主仓上并行的
   * 别的任务会互相串（第 2 轮审查 F2）。也不能收紧回「同目录才算」：写死绝对路径的流水线
   * cwd 在 worktree、产物落主仓，worktree 事后被删时更是必然对不上——那才有 `stale` 这一档。
   */
  const dirVerdict = async (
    cwd: string | null | undefined,
    fallback?: string | null,
  ): Promise<"exact" | "stale" | "elsewhere"> => {
    const recorded = (cwd ?? fallback ?? "").trim();
    if (!recorded) return "stale";
    if (await lens.sameDir(recorded, root.path)) return "exact";
    if (!root.repo || !(await lens.underDir(recorded, root.repo))) return "elsewhere";
    return (await lens.dirExists(recorded)) ? "elsewhere" : "stale";
  };

  const spans: RunWindow[] = [];
  /** 各类缺口各记一次数：面板上要说清楚「哪一段算不准」，但不能一条会话刷一行。 */
  const counts = {
    stale: 0, legacy: 0, early: 0, lastTurn: 0, missing: 0, unsettled: 0,
    upgraded: 0, unmigrated: 0, monitor: 0,
  };

  /**
   * 回合记录分两份收：
   *
   *   `coverage`       —— **不过目录核对**的全部回合（条数、最早、最晚）。只用来判「这条
   *                        会话的记录全不全」：缺了几条、前面缺不缺、末尾缺不缺。
   *   `turnsBySession` —— 过了核对、确实落在这个目录上的那些。只用来出区间。
   *
   * 两份必须分开，否则同一条会话换过工作目录（旧目录还在）时，被核对筛掉的那些回合会被
   * 读成「这个目录上缺的历史」，于是凭空放宽一整段清单——完整性是会话自己的属性，跟我们
   * 正在看哪个目录无关（第 3 轮审查必须修 2 的同类位置）。
   */
  const coverage = new Map<string, {
    /** 回合身份（起点字符串）去重后的集合。**不是行数**：重复行不能当成「多跑了一轮」，
     *  那正好能抵掉另一轮的真缺口（第 4 轮审查对 COUNT 口径的提醒）。 */
    starts: Set<string>;
    earliest: number;
    latest: number;
  }>();
  const turnsBySession = new Map<string, typeof turnRows>();
  for (const turn of turnRows) {
    const at = Date.parse(turn.startedAt);
    const seen = coverage.get(turn.sessionId);
    const slot = seen ?? { starts: new Set<string>(), earliest: at, latest: at };
    if (!seen) coverage.set(turn.sessionId, slot);
    slot.starts.add(turn.startedAt);
    // 「开了没收口」那一档不在这里攒：下面按 `recorded`（过了目录核对的那些行）逐行算,
    // 要的是整行而不只是起点。这儿曾经留着一个没人读的 `open: number[]`（本轮审查不拦项）。
    if (Number.isFinite(at)) {
      slot.earliest = Math.min(slot.earliest, at);
      slot.latest = Math.max(slot.latest, at);
    }
    const verdict = await dirVerdict(turn.cwd);
    if (verdict === "elsewhere") continue;
    const list = turnsBySession.get(turn.sessionId);
    if (list) list.push(turn);
    else turnsBySession.set(turn.sessionId, [turn]);
    const start = Date.parse(turn.startedAt);
    const end = Date.parse(turn.endedAt ?? "");
    // 没收口的那些在这里**不出区间**：它们要么正在跑（会话那一层已经开到无穷），要么是
    // 真缺口（末端得看下一个回合从哪开始），两种都只有拿到整条会话才算得出来。
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (verdict === "stale") counts.stale += 1;
    // 落账过的回合是实测区间：末端只给落定余量，不给那十分钟的推测（必须修 1）。
    spans.push({
      start,
      end: Math.max(end + (verdict === "stale" ? TURN_GRACE_MS : SETTLE_MS), start),
      approx: verdict === "stale",
    });
  }

  for (const row of sessionRows) {
    // **只为「把启动错误显示出来」而建的那条诊断会话不是运行证据**（`turn-failure.ts` 的
    // `freshRunFailureTarget`:没有 CLI 会话、没有命令行、没有回合起点,`active_ms=0`、
    // `exit_status=1`、`ended_at` 就等于 `started_at`）。照常往下走的话它没有逐回合记录,
    // 于是退回 `lifespan()`——一个**压根没跑起来**的任务因此拿到 [报错时刻, +10 分钟] 的
    // 候选区间,把那十分钟里别人在同一个目录做的东西全列成它的产物（第 1 轮审查 F4）。
    // 判据**复用已有那一个**,不在这里另写一份:导入、快照、跨机导入都可能带进这种行,
    // 所以要挡在这条公共的证据解析上,而不是挡在某个起跑入口或某一个界面里。
    if (isDiagnosticSession(row)) continue;
    const verdict = await dirVerdict(row.cwd, row.worktreePath);
    if (verdict === "elsewhere") continue;
    const start = Date.parse(row.startedAt ?? "");
    if (!Number.isFinite(start)) continue;
    const recorded = turnsBySession.get(row.id) ?? [];
    // **「还在写」要按回合身份认，不能按任务状态推**。库里「开始了没收口」下面压着两种
    // 完全相反的情况：正在写，和当初崩了没来得及收口。任务后来又跑起来时 `running` 对两者
    // 都成立——于是一条崩过的老会话会从它那个老起点一路开到无穷，把中间歇着的这段时间里
    // 别人做的东西全认成自己的，连那句「算不准」都一起消失（第 5 轮审查必须修 1）。
    // 活动身份只有写端知道（`session-turns.ts` 的内存登记，进程重启即清空），重启后接回
    // 仍在跑的 agent 会重新登记。同一任务名下没登记的未收口身份一律留在「未知」那一档。
    const activeStarts = activeTurnStarts(row.id);
    // **活动身份是一手事实,不许被二手的持久状态否决**。原先这一行还要求会话行上
    // `ended_at` 为空、任务在 running/queued —— 两样都是「写进去过」的快照：上一轮收尾写了
    // `ended_at`,本轮 `beginTurn` 要把它清回 null（`resumedTurnFields`）,那一次 UPDATE 一
    // 失败（库忙、触发器、权限）陈旧的收尾时刻就留在行上,于是正在写的这一轮被判成不活动、
    // 还被算成「开了没收口」,上界夹到上一轮的收尾时刻附近——此后落盘的图当场从清单里消失,
    // 面板反过来说「这次运行没有正常结束」（第 1 轮审查 F3）。登记在册则相反：它只在写端的
    // 内存里,登记与注销成对且覆盖全部出口,进程一没了全部清空。所以这一刻谁在写,只问它。
    const live = activeStarts.size > 0;
    const liveFrom = [...activeStarts]
      .map((at) => Date.parse(at))
      .filter((at) => Number.isFinite(at))
      .sort((a, b) => a - b)[0];
    const ended = Date.parse(row.endedAt ?? "");
    const turnStart = Date.parse(row.turnStartedAt ?? "");
    if (verdict === "stale") counts.stale += 1;

    /** 整条会话寿命那一段——推断档的兜底，宽，照实标 approx。 */
    const lifespan = (): RunWindow => {
      if (Number.isFinite(ended)) return { start, end: Math.max(ended + TURN_GRACE_MS, start), approx: true };
      const from = Number.isFinite(turnStart) ? Math.max(start, turnStart) : start;
      return { start, end: from + Math.max(row.activeMs ?? 0, UNSETTLED_RUN_MS) + TURN_GRACE_MS, approx: true };
    };

    if (live) {
      // 还在飞：从**正在跑的那个回合**的起点开到无穷（多角色的 duet 各有自己的会话行，所以
      // 这里取它自己登记在册的最早那个起点）。它正在写，之后出现的东西只会是它写的。
      const from = Number.isFinite(liveFrom) ? liveFrom : (Number.isFinite(turnStart) ? turnStart : start);
      spans.push({ start: from, end: Number.POSITIVE_INFINITY });
    }
    if (!recorded.length) {
      // 一条回合记录都没有。**不能**把这解释成「它一直在跑」（中间歇的几个钟头里别人做的
      // 东西会全算进来），也不能解释成「它没跑过」（那就整页都看不见）——只能认成一整段
      // 宽的区间并明说算不准（第 2 轮审查 F1）。在飞的那一支已经开到无穷，不用再补。
      if (!live) spans.push(lifespan());
      counts.legacy += 1;
      continue;
    }

    // **回合记录全不全**，两道判据,一手一二手：
    //
    //   第一手是**逐行事实**：回合一开始就落行、收尾补 `ended_at`,所以「开了没收口」在库里
    //   明摆着,而且后来成功的那一轮抵消不掉它（第 4 轮审查必须修 1——原先只在收尾时插行,
    //   写失败就什么痕迹都没有,下一轮一落账读端就再也看不出中间少过东西）。
    //
    //   第二道是**计数对账**,专管连开始那一行都没写进去的情形（库挂了、或者哪个起跑入口
    //   漏了调 openTurn）：`turns_base + turns_started` 是开过几个回合,拿它跟去重后的回合
    //   身份数比。比的是**不过目录核对**的那一份：完整性是会话自己的属性,跟我们正在看哪个
    //   目录无关。`turns_started` 为 null = 升级前就在的老行,基数本来就不知道,**不对账**——
    //   拿 0 去减它名下的历史行数会得出负数,把真缺口白白抵扣掉（第 4 轮审查「升级历史也会
    //   抵消后续缺口」）,那种行只走 legacy 披露。
    const seen = coverage.get(row.id);
    const allStarts = [...(seen?.starts ?? [])].map((at) => Date.parse(at)).filter(Number.isFinite);
    for (const turn of recorded) {
      if (turn.endedAt) continue;
      const openAt = Date.parse(turn.startedAt);
      if (!Number.isFinite(openAt)) continue;
      // 正在跑的那一轮：它本来就还没收口,不是「写失败」。live 那一支已经把区间开到无穷,
      // 这里只要别把它数成缺口（第 4 轮审查 N1：健康的在飞回合被当成写入失败）。
      // **按身份比,不按时刻比**：登记在册的才是正在跑的那个,同一条会话上别的未收口身份
      // （上一次崩掉留下的）照样要算缺口（第 5 轮审查必须修 1）。
      // 还要**同时要求 live**：任务都不在飞了,再怎么登记在册也不可能还在写——那只能是注销
      // 漏了某个出口留下的残影。少这个前缀的后果是异常收尾之后那一轮既不出区间（这里 continue
      // 了）、也不报未知,它刚做出来的图当场从清单里消失（第 6 轮审查必须修 1 的前半）。
      if (live && activeStarts.has(turn.startedAt)) continue;
      // 开了没收口,又不是在飞：收尾那一下没写成。末端取**下一个回合的起点**（那一刻它
      // 肯定已经停了）,没有下一轮就按会话收尾时刻、再不行才兜底。这一段是估的,标 approx。
      // 这里比的两个数**同源**（都来自 `session_turns.started_at`,而且已经按身份去重）,所以
      // 「确实是另一个身份」只要 `>` 就够,不该再吃那 1 秒抖动容差 —— 那个容差是给「两个来源
      // 的时间可能差几百毫秒」用的（会话行的 `turn_started_at` 对回合起点,见 TURN_SKEW_MS）。
      // 混用的后果：未收口那一轮 t 和紧接着正常跑完的 t+200ms 之间,已知的下一份生命周期被
      // 跳过,区间一路估到很久以后的第三轮,把第二轮的产出连停工时间一起收进来（第 1 轮审查 N2）。
      const next = allStarts.filter((at) => at > openAt).sort((a, b) => a - b)[0];
      const end = Number.isFinite(next)
        ? next
        : (Number.isFinite(ended) ? Math.max(ended + SETTLE_MS, openAt) : openAt + UNSETTLED_RUN_MS + TURN_GRACE_MS);
      spans.push({ start: openAt, end: Math.max(end, openAt), approx: true });
      counts.unsettled += 1;
    }
    // 升级前的那段历史：`turns_base` 是**下界**（迁移那一刻数得出来的行数）,升级前写失败的
    // 回合没留下行、谁也数不出来。所以它照实说一句「那之前缺没缺不知道」,而不是假装完整。
    // 判据是 `turns_base_approx` 而不是「base 大于 0」：迁移那一刻一行记录都没有的老会话
    // 回填出来的下界正好是 0,跟「升级后新建、确定没有历史」长得一模一样,照 base 判就把
    // 那种会话的未知历史说成了「确定没有」（第 5 轮审查必须修 2.2）。
    // **迁移确认过没有,是这一档的前提**：`turns_base_approx` 有值才算确认过（0 = 升级之后
    // 新建的、1 = 回填过）。NULL = 既没经过本版写端、也没被回填成功 —— 而那条迁移自己 catch
    // 掉一切只 warn（抛出去 = 整台 ash 起不来,见 db/migrate-session-turns.ts）,所以「这一列
    // 还是 NULL」就是**迁移没跑完**留在库里的那份可核验证据。那种行上的 `turns_started` 是
    // 上一版口径（会漏起跑入口、又会重复加数）,拿它做精确减法就会出现「两条偏小的旧计数正好
    // 抵掉两条已存行」,中间真缺的那一轮一句话都不说（第 1 轮审查 F3）。
    const migrated = row.turnsBaseApprox != null;
    if (migrated && row.turnsBaseApprox) counts.upgraded += 1;
    if (!migrated) counts.unmigrated += 1;
    // 在飞那一轮不必在这里另行扣除：它的开始行早就落了,`starts` 和 `expected` 两边都含它。
    const expected = !migrated || row.turnsStarted == null
      ? null
      : (row.turnsBase ?? 0) + row.turnsStarted;
    // 两种缺口加在一起：
    //   • 对账差 —— 计数说开过 N 轮,表里只有 M 个身份（有人绕过写入端改表,或者唯一索引
    //     没建上时的重复行被去重后反而少了）；
    //   • `turns_lost` —— 开回合那一批整个没写成。行和计数同批写之后两边同生共死,对账在
    //     这种情形下一点痕迹都看不出来,只有写端自己记的这一笔算得上证据（必须修 2.3）。
    //   • 还没确认落账的开始意图 —— 开始那一批整个回滚、补 `turns_lost` 那一笔**也**失败时,
    //     库里两个数仍然相等,缺口一点痕迹都没有。那一刻唯一还记得的是写端自己的内存
    //     （`unconfirmedTurns`）,所以这里把它一起算进来：库恢复后那笔会被补成持久的
    //     `turns_lost`（补成功才从内存划掉,不会两边各算一次),库一直不可写就一直按未知
    //     披露（第 6 轮审查必须修 2）。
    const missing = (expected == null ? 0 : Math.max(0, expected - (seen?.starts.size ?? 0)))
      + (row.turnsLost ?? 0) + unconfirmedTurns(row.id);
    if (missing > 0) counts.missing += missing;
    // 缺的是哪几段无从得知，只能把整条寿命算成宽的那一档并说出来。**未确认迁移的那一档同样
    // 走这里**：它的旧计数不参与对账,所以「缺没缺」在它身上压根算不出来——照未知披露就得连
    // 区间一起放宽,否则中间那一轮做出来的图照旧静默漏列（第 1 轮审查 F3）。
    if ((missing > 0 || !migrated) && !live) spans.push(lifespan());

    // 有记录，但最早那条明显晚于会话起点：中间这一段是本表建立之前跑的回合，补上——同样是宽的。
    // 这一档**在飞时照样要查**：续聊一进来就跳过它，历史上的不确定会凭空消失一阵
    //（第 3 轮审查必须修 2 的同类位置）。「最早」「最晚」都按**全部**回合算，不按本目录上
    // 剩下的那几条：换过工作目录的会话，本目录上最早那条当然晚，那不是缺口。
    const earliest = seen?.earliest ?? Number.NaN;
    if (Number.isFinite(earliest) && earliest - start > TURN_SKEW_MS) {
      spans.push({ start, end: earliest, approx: true });
      counts.early += 1;
    }
    // **末回合没落账**：`turn_started_at` 是最新那个回合的起点，它比所有落账记录都晚，就说明
    // 最后一个回合没留下行（异常收尾、停止、写库失败都会这样）。「没有行」在这里绝不能读成
    // 「没跑过」：那一回合真做出来的东西会被静默滤掉（第 2 轮审查 F1）。这一条给的是缺口的
    // **位置**，比上面那个计数窄，所以两条都留着：有位置就按位置补，没有才整条寿命兜。
    const lastRecorded = seen?.latest ?? Number.NaN;
    if (!live && Number.isFinite(turnStart) && Number.isFinite(lastRecorded)
      && turnStart - lastRecorded > TURN_SKEW_MS) {
      const end = Number.isFinite(ended)
        ? Math.max(ended + TURN_GRACE_MS, turnStart)
        : turnStart + UNSETTLED_RUN_MS + TURN_GRACE_MS;
      spans.push({ start: turnStart, end, approx: true });
      counts.lastTurn += 1;
    }
  }

  const now = Date.now();
  for (const row of monitorRows) {
    const verdict = await dirVerdict(row.cwd);
    if (verdict === "elsewhere") continue;
    const start = Date.parse(row.startedAt ?? "");
    if (!Number.isFinite(start)) continue;
    if (verdict === "stale") counts.stale += 1;
    // 还在盯着的哨兵开到无穷；停了的按它自己的收尾时刻，取不到就按到期时刻。
    const ended = Date.parse(row.endedAt ?? "");
    const expires = Date.parse(row.expiresAt ?? "");
    // 还在盯着的开到无穷；停了的按它**自己记下来的**收尾时刻——那就是实测证据，不必再往后
    // 推十分钟（必须修 1）。连收尾时刻都没有的（进程没了没来得及写）才退回到期时刻，那一段
    // 是估的，照实标宽。
    const settled = Number.isFinite(ended);
    // 还在盯着：区间开到无穷是**事实**（它这一刻确实在跑），不是估的。原先一律按「没有收尾
    // 时刻」标 approx，于是正常运行中的后台产物被说成算不准，而这条路又没给出对应的提示，
    // 面板上就出现「见上面那几条」却找不到上面那几条（第 4 轮审查 N2 的对称面）。
    const watching = row.status === "running" && !row.endedAt;
    const end = watching
      ? Number.POSITIVE_INFINITY
      : (settled ? ended + SETTLE_MS : (Number.isFinite(expires) ? expires : now) + TURN_GRACE_MS);
    // 终态了却没留下收尾时刻（进程没了、没来得及写）：那一段是按到期时刻估的，得说出来。
    if (!watching && !settled) counts.monitor += 1;
    spans.push({ start, end: Math.max(end, start), approx: verdict === "stale" || (!settled && !watching) });
  }

  const gaps: string[] = [];
  if (counts.legacy) {
    gaps.push(`有 ${counts.legacy} 段运行只记下了会话的起止、没有逐回合记录，那几段里别人做的东西可能混进来`);
  }
  if (counts.early) {
    gaps.push(`有 ${counts.early} 段早期运行在逐回合记录之前，只能按整段会话算`);
  }
  if (counts.missing) {
    gaps.push(`有 ${counts.missing} 次运行连开始都没在库里留下记录（写入失败或异常重启），只能把整段会话算进来`);
  }
  if (counts.unsettled) {
    gaps.push(`有 ${counts.unsettled} 次运行开始了却没留下收尾时刻（异常退出或写入失败），那一段只能估到下一次运行开始`);
  }
  if (counts.upgraded) {
    gaps.push(`有 ${counts.upgraded} 段会话在逐回合记录升级之前就跑过，升级前那部分缺没缺记录无从得知`);
  }
  if (counts.unmigrated) {
    gaps.push(`有 ${counts.unmigrated} 段会话还没完成逐回合记录的升级（升级那一步没跑成），它这部分缺没缺记录无从得知，只能按整段会话算`);
  }
  if (counts.monitor) {
    gaps.push(`有 ${counts.monitor} 个后台任务（哨兵）没留下收尾时刻，那一段只能按它的到期时刻估`);
  }
  if (counts.lastTurn) {
    gaps.push(`有 ${counts.lastTurn} 次运行的最后一个回合没留下记录（异常收尾），那一段只能按会话收尾时刻估`);
  }
  if (counts.stale) {
    // 量词刻意跟上面几条不一样：这一条数的是**记录条数**（会话、回合、哨兵各算一条），跟
    // 「几段运行」不是一个维度，同一批会话会同时出现在两条提示里。
    gaps.push(`有 ${counts.stale} 处运行记录指向的工作目录已经不在了（独立工作区被删），只能按这个目录算`);
  }

  return { windows: mergeWindows(spans), gaps };
}

/**
 * 这个时刻落在哪一类区间里：`exact` = 落账过的回合／哨兵自己的生命周期（实测）；
 * `approx` = 只落在推断出来的那几段里（没有逐回合记录的老会话、缺了的那几轮、工作目录
 * 已经不在的那些）；`null` = 哪一段都不在。
 *
 * 分这两档是因为推断出来的区间**不能冒充运行时间**：靠它认进来的产物只是候选，面板得单独
 * 说一句（第 3 轮审查必须修 1）。精确命中优先——两类区间重叠时，有实测证据就是实测。
 */
export const windowHit = (
  ms: number | null,
  windows: readonly RunWindow[],
): "exact" | "approx" | null => {
  if (ms === null || !Number.isFinite(ms)) return null;
  let hit: "exact" | "approx" | null = null;
  for (const window of windows) {
    if (ms < window.start || ms > window.end) continue;
    if (!window.approx) return "exact";
    hit = "approx";
  }
  return hit;
};

export const withinWindows = (ms: number | null, windows: readonly RunWindow[]) =>
  windowHit(ms, windows) !== null;
