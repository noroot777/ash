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
 * 保信息：已经拿到的东西不许被 null 抹回去。两条路径都与到达顺序无关。
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
 * - 都是对象（usage / context）→ 交给下面两个专门的比较。
 */
function pickField(left: unknown, right: unknown): unknown {
  if (left == null) return right;
  if (right == null) return left;
  if (typeof left === "number" && typeof right === "number") return Math.max(left, right);
  if (typeof left === "string" && typeof right === "string") return left >= right ? left : right;
  if (typeof left === "boolean" && typeof right === "boolean") return left || right;
  return undefined; // 交给调用方特判
}

function pickUsage(left: TokenUsage | null, right: TokenUsage | null): TokenUsage | null {
  if (!left) return right;
  if (!right) return left;
  return usageTotal(right) > usageTotal(left) || (usageTotal(right) === usageTotal(left) && right.turns > left.turns)
    ? right
    : left;
}

/**
 * 上下文水位是**覆盖**值不是流水：压缩之后它会掉下来，所以大小说明不了新旧。版本已经
 * 分不出高下了，这里只需要一个与顺序无关的确定结果——取水位高的那份，下一次刷新自会纠正。
 */
function pickContext(left: Session["context"], right: Session["context"]): Session["context"] {
  if (!left) return right;
  if (!right) return left;
  return right.used > left.used ? right : left;
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
      ? pickUsage(current.usage, incoming.usage)
      : key === "context"
        ? pickContext(current.context, incoming.context)
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
