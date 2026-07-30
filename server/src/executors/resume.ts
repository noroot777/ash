import type { AgentType, ExecTarget } from "@harness/shared";
import { CLI_SPEC_BY_KEY } from "./catalog/index.js";
import { resumeFor } from "./spawn.js";
import { unknownResumeNote } from "./generic.js";

// 会话详情里那条「复制去终端接着聊」的命令。**每次读取时重算**(不用 executor 当初
// 写进 DB 的那份),所以格式变了、供应商前缀变了都不会留下过期字符串。
//
// 模板的真相来源是目录里各 spec 的 `exec.session.interactive`。没有声明的 CLI 一律
// 给一句诚实说明 —— 旧实现在这里回落到 claude 的模板,那会拿一条「跑到别家 CLI 上」
// 的命令骗用户去执行。
//
// 放在独立文件而不是 spawn.ts:spawn.ts 被目录里的 spec 间接 import(专用执行器
// 用它 spawn),再让它反过来 import 目录就成环了。
export function resumeCommandFor(
  agentType: string,
  targetStr: string | null | undefined,
  cwd: string,
  cliSessionId: string,
  relayEnv?: string | null,
): string {
  const spec = CLI_SPEC_BY_KEY[agentType as AgentType];
  const inner = spec?.exec.session?.interactive?.(cliSessionId);
  if (!inner) return unknownResumeNote({ name: spec?.name ?? agentType }, cliSessionId);
  const target: ExecTarget = targetStr?.startsWith("ssh:")
    ? { kind: "ssh", host: targetStr.slice(4) }
    : { kind: "local" };
  return resumeFor(target, cwd, inner, relayEnv ?? "");
}
