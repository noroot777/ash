import type { Session } from "@ash/shared";

/**
 * 两份 sessions 快照怎么合。
 *
 * 一句话：**采用 incoming**。它读得更晚——这不是猜的，是调用方
 * （lib/useConversation.ts）保证的：同一个任务的 sessions 请求排成一条链，一发落地才发
 * 下一发，应用时还按出门序号让位，读得早却落地晚的那份会被直接丢掉。
 *
 * 所以这里没有「合并」可做，也不该做。服务端的 `toSession()` 每次都从会话行现算整行，
 * 那份就是此刻的事实：CLI 凭据会在跑的过程中原地轮换（server/src/single-run.ts 收到新
 * session 事件就改 cliSessionId 和 resume 字段），会话失效时凭据会被明确清空，上下文水位
 * 压缩后会降下来、采不到时会变成 null，接力导入还会让会话行本身消失。这些都不推进时间戳
 * 或用量，逐字段去「保住已经拿到的东西」只会把作废的凭据、陈旧的水位一直留在屏幕上，
 * 而用户复制走的恰恰是那份已经没用的 resume 命令。
 *
 * 这里唯一做的事情是**引用稳定**：内容一样就把原来的数组/对象还回去。sessions 是下游
 * 一长串 useMemo 的依赖，每次刷新都造新对象会让整条会话白重算一遍。
 */
export function mergeSessions(current: Session[], incoming: Session[]): Session[] {
  const byId = new Map(current.map((session) => [session.id, session]));
  const next = incoming
    .map((session) => {
      const existing = byId.get(session.id);
      return existing && sameSession(existing, session) ? existing : session;
    })
    // 服务端那条查询没写 ORDER BY，排序在这里兜住，免得列表顺序跟着 rowid 的实现细节走。
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
  const unchanged = next.length === current.length && next.every((session, i) => session === current[i]);
  return unchanged ? current : next;
}

/** 逐字段比一遍值。只为决定「要不要换一个新对象出去」，不参与取舍。 */
function sameSession(left: Session, right: Session): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const a = (left as unknown as Record<string, unknown>)[key];
    const b = (right as unknown as Record<string, unknown>)[key];
    if (a === b) continue;
    if (key === "usage" || key === "context") {
      if (sameRecord(a as Record<string, unknown> | null, b as Record<string, unknown> | null)) continue;
    }
    return false;
  }
  return true;
}

function sameRecord(left: Record<string, unknown> | null, right: Record<string, unknown> | null): boolean {
  if (!left || !right) return left === right;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (left[key] !== right[key]) return false;
  return true;
}
