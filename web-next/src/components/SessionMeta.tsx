import type { Session } from "@harness/shared";

function copy(value: string) {
  void navigator.clipboard.writeText(value);
}

export function SessionMeta({ session }: { session: Session }) {
  if (!session.cliSessionId && !session.resumeCommand) return null;
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
    </footer>
  );
}
