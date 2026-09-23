import type { Session } from "@ash/shared";
import type { TokenUsage } from "@ash/shared/usage";

/**
 * 两份 sessions 快照的合并规则。
 *
 * 为什么需要它：`sessions` 有两个写者——`load()` 的全量重读，和直播事件顺手补的那一发
 * 轻量刷新。两者可以同时在途，而**客户端判不出谁的快照更新**：请求发起早不代表服务端
 * 读得早（连接池、代理都会打乱到达顺序），先回来也不代表更旧。所以这里一律不看顺序，
 * 只看数据本身。
 *
 * 服务端没有给会话行发版本号（`sessions` 表没有 updatedAt / revision 列），能拿来当版本
 * 的只有会话自己那几个**单调不减**的量：回合起止时刻、累计回合数、累计 token。它们够
 * 覆盖真实的更新路径——起新回合推进 turnStartedAt，收口落 endedAt，用量事件推进 usage。
 * 版本分得出高下就按版本取；分不出（两份对应同一状态，或这家 CLI 压根不报账）就逐字段
 * 保信息：已经拿到的东西不许被 null 抹回去。两条路径都与到达顺序无关。唯一的例外是
 * `context`——它是覆盖值，服务端会合法地把它调低甚至清空，见 takeContext。
 */

/** 这条会话行最近一次被写过的时刻。三个字段都只会往后走。 */
function sessionStamp(session: Session): string {
  return [session.startedAt, session.turnStartedAt ?? "", session.endedAt ?? ""]
    .reduce((latest, value) => (value > latest ? value : latest), "");
}

/** 累计 token：会话级用量是跨回合累加的，只增不减，正好当版本用（见 shared/src/usage.ts）。 */
function usageTotal(usage: TokenUsage | null | undefined): number {
  if (!usage) return -1;
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** 同一条会话行的版本，按单调量组成，逐项比较。 */
function sessionVersion(session: Session): [string, number, number] {
  return [sessionStamp(session), session.usage?.turns ?? -1, usageTotal(session.usage)];
}

function compareVersions(left: [string, number, number], right: [string, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! > right[index]!) return 1;
    if (left[index]! < right[index]!) return -1;
  }
  return 0;
}

/**
 * 版本分不出高下时的字段取舍。规则对调换左右**必须给出同一个结果**，否则合并又变回
 * 「谁后到谁说了算」：
 * - 一边为空 → 取非空那边（`cliSessionId`、恢复命令这类一旦写入就不会变回 null 的字段
 *   最怕被旧快照抹掉）；
 * - 都是数字/字符串 → 取较大的那个（时间戳、退出码天然如此）；
 * - 都是对象（usage / context）→ 交给下面两个专门的函数。
 */
function pickField(left: unknown, right: unknown): unknown {
  if (left == null) return right;
  if (right == null) return left;
  if (typeof left === "number" && typeof right === "number") return Math.max(left, right);
  if (typeof left === "string" && typeof right === "string") return left >= right ? left : right;
  if (typeof left === "boolean" && typeof right === "boolean") return left || right;
  return undefined; // 交给调用方特判
}

/** 两个可空数字里那个「更靠后」的：一边为空取另一边，都在取大。 */
function maxNullable(left: number | null | undefined, right: number | null | undefined): number | null {
  if (left == null) return right ?? null;
  if (right == null) return left;
  return Math.max(left, right);
}

/**
 * usage 整对象取一边就会丢字段：`reasoning`、`costUsd` 这类不参与版本比较的量，可能
 * 只在其中一份里有（enrichment 补上的、或那一发正好带上了）。所以这里逐字段取大——
 * 会话级用量的每一项都是跨回合累加的单调量（见 shared/src/usage.ts 的 addUsage），
 * 取大既与顺序无关，又不会把已经拿到的数抹回 0/null。
 */
function mergeUsage(left: TokenUsage | null, right: TokenUsage | null): TokenUsage | null {
  if (!left) return right;
  if (!right) return left;
  const merged: TokenUsage = {
    input: Math.max(left.input, right.input),
    output: Math.max(left.output, right.output),
    cacheRead: Math.max(left.cacheRead, right.cacheRead),
    cacheWrite: Math.max(left.cacheWrite, right.cacheWrite),
    reasoning: Math.max(left.reasoning, right.reasoning),
    costUsd: maxNullable(left.costUsd, right.costUsd),
    turns: Math.max(left.turns, right.turns),
  };
  return sameUsage(merged, left) ? left : merged;
}

function sameUsage(left: TokenUsage, right: TokenUsage): boolean {
  return left.input === right.input && left.output === right.output
    && left.cacheRead === right.cacheRead && left.cacheWrite === right.cacheWrite
    && left.reasoning === right.reasoning && left.costUsd === right.costUsd
    && left.turns === right.turns;
}

/**
 * 上下文水位是**覆盖**值，而且服务端把「没采到」也当成一个真值：执行器读不到可信水位
 * 时会发 `used=0` 哨兵，`setSessionContext()` 收到后把库里那几列清空，sessions API 随后
 * 就返回 `context: null`——目的正是别再拿上一轮的陈旧数字冒充当前值（server/src/usage.ts）。
 *
 * 所以这一项不能合并：取大会把压缩后的低水位顶回去，「谁有取谁」会把明确的清空吃掉，
 * 两种都让客户端永远收敛不到服务端真值。这里跟随 `incoming`——它是**读得更晚**的那份，
 * 不是「后到」的那份：调用方 useConversation 把 sessions 请求排成一条链（一发落地才发
 * 下一发），并用出门序号挡掉读得更早的响应，所以到这儿时顺序已经是确定的。
 *
 * 换句话说 context 这一项的正确性依赖那条链。合并层自己给不出这个保证——没有服务端
 * revision 时，左偏、右偏、按大小取都至少破坏「合法下降」「明确清空」「乱序保护」中的
 * 一条。真要拿掉那条链，就得先让 sessions API 发版本号。
 */
function takeContext(current: Session["context"], incoming: Session["context"]): Session["context"] {
  if (current && incoming && sameContext(current, incoming)) return current;
  return incoming;
}

function sameContext(left: NonNullable<Session["context"]>, right: NonNullable<Session["context"]>): boolean {
  return left.used === right.used && left.window === right.window
    && left.compactWindow === right.compactWindow && left.windowEstimated === right.windowEstimated;
}

function mergeSessionRow(current: Session, incoming: Session): Session {
  const order = compareVersions(sessionVersion(incoming), sessionVersion(current));
  if (order > 0) return incoming;
  if (order < 0) return current;
  const merged: Record<string, unknown> = { ...current };
  let changed = false;
  for (const key of new Set([...Object.keys(current), ...Object.keys(incoming)])) {
    const left = (current as unknown as Record<string, unknown>)[key];
    const right = (incoming as unknown as Record<string, unknown>)[key];
    const picked = key === "usage"
      ? mergeUsage(current.usage, incoming.usage)
      : key === "context"
        ? takeContext(current.context, incoming.context)
        : pickField(left, right) ?? right;
    if (picked !== left) changed = true;
    merged[key] = picked;
  }
  return changed ? (merged as unknown as Session) : current;
}

/**
 * 取两份快照的并集，同一条会话按上面的规则取舍。结果与到达顺序无关。
 *
 * 合并不删会话：任务活着的时候 sessions 只增不减——服务端只有「删任务」
 * （server/src/task-routes.ts）和「接力导入」（server/src/handoff-import.ts）会删它们，
 * 前者任务都没了，后者随之而来的刷新/切任务会把基线清掉重读。
 */
export function mergeSessions(current: Session[], incoming: Session[]): Session[] {
  const byId = new Map(current.map((session) => [session.id, session]));
  let changed = false;
  for (const session of incoming) {
    const existing = byId.get(session.id);
    const next = existing ? mergeSessionRow(existing, session) : session;
    if (next !== existing) changed = true;
    byId.set(session.id, next);
  }
  // 没有任何实际变化就把原数组还回去：sessions 是下游一长串 useMemo 的依赖，
  // 每次刷新都造一个新数组会让整条会话白重算一遍。
  if (!changed && byId.size === current.length) return current;
  return [...byId.values()].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
}
