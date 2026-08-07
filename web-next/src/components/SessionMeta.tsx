import type { ContextUsage, Session, TokenUsage } from "@harness/shared";
import { ContextMeterChip } from "./ContextMeterChip.tsx";
import { TokenUsageChip } from "./TokenUsageChip.tsx";

function copy(value: string) {
  void navigator.clipboard.writeText(value);
}

export function SessionMeta({
  session,
  sessionUsage,
  sessionContext,
}: {
  session: Session;
  /** 会话累计。默认取会话行上的账本，调用方算出了更新的值可以覆盖它。 */
  sessionUsage?: TokenUsage | null;
  /** 会话此刻的上下文水位。同上，默认取会话行、调用方可覆盖成直播里更新的那份。 */
  sessionContext?: ContextUsage | null;
}) {
  const total = sessionUsage !== undefined ? sessionUsage : session.usage;
  const water = sessionContext !== undefined ? sessionContext : session.context;
  if (!session.cliSessionId && !session.resumeCommand && !total && !water) return null;
  return (
    <footer className="task-session-meta">
      {session.cliSessionId && (
        <button type="button" title={session.cliSessionId} onClick={() => copy(session.cliSessionId!)}>
          会话 {session.cliSessionId.slice(0, 12)}{session.cliSessionId.length > 12 ? "…" : ""}
        </button>
      )}
      {session.resumeCommand && (
        <button type="button" title={session.resumeCommand} onClick={() => copy(session.resumeCommand!)}>
          复制 resume 命令
        </button>
      )}
      <TokenUsageChip session={total} />
      {/* 水位跟在流水后面，各是各的一颗：一个答「烧了多少」，一个答「还能聊多久」。 */}
      <ContextMeterChip context={water} />
    </footer>
  );
}
