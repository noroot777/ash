import type { AgentType, SessionRole } from "@ash/shared";
import { readCodexCliVersion } from "./executors/codex-rollout.js";
import { affectedCodexSessionReplacementNote, isAffectedCodexVersion } from "./executors/version-policy.js";
import { announceSessionNote } from "./session-notice.js";

/**
 * 无法读取 rollout 或无法证明版本受影响时保留原会话。这里刻意 fail-open：误删一条
 * 健康会话会直接丢上下文，而漏拦只会维持升级守卫加入前的恢复行为。
 */
export async function affectedCodexResumeVersion(
  agentType: AgentType,
  cliSessionId: string | null | undefined,
): Promise<string | undefined> {
  if (agentType !== "codex" || !cliSessionId) return undefined;
  const version = await readCodexCliVersion(cliSessionId);
  return isAffectedCodexVersion(version) ? version! : undefined;
}

/**
 * 先把替换原因写进旧会话并等文件真正落盘，再由调用方清凭据。这样后续工作目录解析、
 * 暂停闸或 spawn 抛错时，用户刷新页面仍能知道为什么这条会话不再被续用。
 * (落盘与广播的机制在 `session-notice.ts`,这里只负责「说什么」。)
 */
export async function announceAffectedSessionReplacement(args: {
  taskId: string;
  sessionId: string;
  role: SessionRole;
  agentType: AgentType;
  version: string;
  publish?: boolean;
}): Promise<string> {
  const text = affectedCodexSessionReplacementNote(args.version);
  if (!text) throw new Error(`unsupported Codex replacement version: ${args.version}`);
  return announceSessionNote({ ...args, text });
}
