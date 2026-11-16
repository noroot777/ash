// 回合指纹：ash 注入自己的 MCP 时，在登记里写上「这一回合的身份长什么样」，MCP 启动时只认
// 对得上它的那份身份。
//
// 为什么要它：回合身份走环境变量（`ASH_TURN_IDENTITY_ENV`）和 `PATH` 上的身份文件，而 CLI 的
// 配置能在 ash 设好之后把同名变量换掉 —— claude 的 `settings.env` 会改写 claude 自己的环境、
// MCP 子进程照单继承；codex 登记里写死的 `mcp_servers.ash.env` 压过 `env_vars` 从父进程透传的
// 同名值（2026-11-16 实测 claude 2.1.283、codex 0.153.4）。结果是 ash 连上了、工具一样不少，
// 带的却是上一回合的令牌，交卷时才被拒。指纹写在注入的登记**本身**里（claude 的
// `--mcp-config` 文件、codex 的 `-c` 内联表都排在最后、压得过用户配置），所以它一定是这一回合
// 的；MCP 拿它在几条通道的候选里挑，一份都对不上就拒绝启动，让 CLI 当场报「ash 没接上」。
//
// 指纹是令牌的单向摘要，不涉密：它会出现在 codex 的 argv 里，从它推不回令牌。
// 写的一侧是 `server/src/executors/ash-mcp-inject.ts`，认的一侧是 `mcp/src/turn-identity.ts`。
//
// 不放进 `./mcp`：那份 web 也在读，这里要用 node:crypto。
import { createHash } from "node:crypto";

/** 指纹进 MCP 子进程用的变量名。只出现在注入的那份登记里，不进 agent 进程的环境。 */
export const ASH_TURN_FINGERPRINT_ENV = "ASH_TURN_FINGERPRINT";

/**
 * 「这一回合没有身份」（侧聊、预览助手、duet 讨论者）：MCP 一律不带身份，哪条通道里有都不认 ——
 * 那只可能是 CLI 配置里写死的、或从 ash 自己的环境里继承来的别的任务的身份。
 */
export const ASH_TURN_FINGERPRINT_NONE = "none";

export interface TurnFingerprintIdentity {
  taskId: string;
  turnToken: string;
  directionToken: string;
}

export function turnFingerprint(id: TurnFingerprintIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify([id.taskId, id.turnToken, id.directionToken]))
    .digest("hex")
    .slice(0, 32);
}
