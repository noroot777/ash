import type { AgentType } from "@harness/shared";
import { CLI_SPEC_BY_KEY } from "./catalog/index.js";
import { resumeFor } from "./spawn.js";
import { interactiveResumeInner, unknownResumeNote } from "./generic.js";

// 会话详情里那条「复制去终端接着聊」的命令。**每次读取时重算**(不用 executor 当初
// 写进 DB 的那份),所以格式变了、供应商前缀变了都不会留下过期字符串。
//
// 模板的真相来源是目录里各 spec 的 `exec.session.interactive`,能不能展示则由
// `interactiveResumeInner` 统一判定(要求 sessionId 是 CLI 真认得的 id)。两条口子
// 共用同一个判定:这里和 GenericCliExecutor.resumeCommand。
//
// 旧实现在这里回落到 claude 的模板,那会拿一条「跑到别家 CLI 上」的命令骗用户去执行。
//
// 放在独立文件而不是 spawn.ts:spawn.ts 被目录里的 spec 间接 import(专用执行器
// 用它 spawn),再让它反过来 import 目录就成环了。
export function resumeCommandFor(
  agentType: string,
  cwd: string,
  cliSessionId: string,
  resumeEnv?: string | null,
  resumeArgs?: string | null,
): string {
  const spec = CLI_SPEC_BY_KEY[agentType as AgentType];
  if (!spec) return `# 未知的执行器类型 ${agentType}（sessionId ${cliSessionId || "未记录"} 仅供追溯）`;
  const inner = interactiveResumeInner(spec, cliSessionId);
  if (!inner) return unknownResumeNote(spec, cliSessionId);
  // resumeArgs 是执行器当初拼好的那截参数(claude 的 `--settings '{…}'`)。它必须跟着
  // 恢复命令走:harness 每一轮都带着它跑,不带就等于让用户手跑的那次退回自己的
  // settings.json —— 压缩行为跟他在 harness 里看到的不是一回事(第 2 轮审查 finding 2)。
  return resumeFor(cwd, resumeArgs ? `${inner} ${resumeArgs}` : inner, resumeEnv ?? "");
}
