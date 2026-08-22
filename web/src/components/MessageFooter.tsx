import type { ContextUsage, Session, TokenUsage } from "@ash/shared";
import { ContextMeterChip } from "./ContextMeterChip.tsx";
import { TokenUsageChip } from "./TokenUsageChip.tsx";

function copy(value: string) {
  void navigator.clipboard.writeText(value);
}

/**
 * 一条 agent 气泡的尾栏：账目元信息都在这一行，气泡头部保留执行器、模型、智能水平、时间与用时。
 *
 * 三颗账目胶囊并排（用户 2026-08-07 定的位置）：
 *   🪙 本轮 —— 每条气泡都有，这一轮烧了多少
 *   🪙 会话 —— 只有本会话最后一条气泡有，整条会话至今累计
 *   ◔ 上下文 —— 同上，此刻还剩多少窗口
 * 前两颗是**流水**（可加），第三颗是**水位**（只能覆盖），并排放是因为用户要一眼看全，
 * 不是因为它们同类 —— 别顺手把它们加到一起。
 *
 * `session` 缺席时这就是一行只有「本轮」的尾栏，非最后一条气泡走的正是这条路。
 */
export function MessageFooter({
  turnUsage,
  session,
  sessionUsage,
  sessionContext,
  actions,
}: {
  /** 这一轮的账。每条气泡都该给。 */
  turnUsage?: TokenUsage | null;
  /** 会话身份信息。只有本会话最后一条气泡给，给了才显示会话 id / resume / 累计 / 水位。 */
  session?: Session | null;
  /** 会话累计。默认取会话行上的账本，调用方算出了更新的值可以覆盖它。 */
  sessionUsage?: TokenUsage | null;
  /** 会话此刻的上下文水位。同上，默认取会话行、调用方可覆盖成直播里更新的那份。 */
  sessionContext?: ContextUsage | null;
  /** 尾栏右侧的动作位。给了就一定渲染，不受账目有无影响。 */
  actions?: React.ReactNode;
}) {
  const total = session ? (sessionUsage !== undefined ? sessionUsage : session.usage) : null;
  const water = session ? (sessionContext !== undefined ? sessionContext : session.context) : null;
  if (!actions && !session?.cliSessionId && !session?.resumeCommand && !turnUsage && !total && !water) return null;
  return (
    <footer className="task-message-footer">
      {session?.cliSessionId && (
        <button type="button" title={session.cliSessionId} onClick={() => copy(session.cliSessionId!)}>
          会话 {session.cliSessionId.slice(0, 12)}{session.cliSessionId.length > 12 ? "…" : ""}
        </button>
      )}
      {session?.resumeCommand && (
        <button type="button" title={session.resumeCommand} onClick={() => copy(session.resumeCommand!)}>
          复制 resume 命令
        </button>
      )}
      <TokenUsageChip turn={turnUsage} />
      <TokenUsageChip session={total} />
      <ContextMeterChip context={water} />
      {actions}
    </footer>
  );
}
