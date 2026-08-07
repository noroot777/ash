import type { Session, TokenUsage } from "@harness/shared";
import { TokenUsageChip } from "./TokenUsageChip.tsx";

function copy(value: string) {
  void navigator.clipboard.writeText(value);
}

export function SessionMeta({
  session,
  turnUsage,
  sessionUsage,
}: {
  session: Session;
  /** 这条气泡那一回合的用量；不传就只显示会话累计。 */
  turnUsage?: TokenUsage | null;
  /** 会话累计。默认取会话行上的账本，调用方算出了更新的值可以覆盖它。 */
  sessionUsage?: TokenUsage | null;
}) {
  const total = sessionUsage !== undefined ? sessionUsage : session.usage;
  if (!session.cliSessionId && !session.resumeCommand && !turnUsage && !total) return null;
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
      <TokenUsageChip turn={turnUsage} session={total} />
    </footer>
  );
}
