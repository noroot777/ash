import { isPlanImplementation, type CliCommand } from "@navi/shared/cli-commands";

/** `/plan implement` 换进 prompt 的那句（codex 那一路在 codex-native-commands.ts 里拼同一句）。 */
export const PLAN_IMPLEMENT_TEXT = "用户已确认最新计划，现在按此计划开始实施。";

/**
 * 这句话交给模型的正文，以及它是不是「带着问题进计划回合」。
 *
 * codex 的 `/plan` 是原生命令，原文交给 app-server 的协作模式去认（codex-native-commands.ts）。
 * claude 在 headless 下没有可透传的 `/plan`（2.1.283 的 init `slash_commands` 里没有它），计划模式
 * 只能由 Navi 起跑时切权限参数（executors/claude-plan-gate.ts），所以前缀在这里摘掉：
 * `/plan 问题` → 计划回合里的「问题」；`/plan implement` → 让它按刚批准的计划动手的那句。
 * 裸 `/plan`、`/plan off` 不起进程，在 task-cli-command.ts 当场改状态。
 */
export function planTurnInput(agent: string, slash: CliCommand | null, userText: string): { question: boolean; text: string } {
  if (agent !== "claude" || slash?.name !== "plan") return { question: false, text: userText };
  if (isPlanImplementation(slash)) return { question: false, text: PLAN_IMPLEMENT_TEXT };
  if (slash.args && slash.args !== "off") return { question: true, text: slash.args };
  return { question: false, text: userText };
}
