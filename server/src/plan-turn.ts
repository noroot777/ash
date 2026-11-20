import { isPlanImplementation, isPlanToggle, type CliCommand } from "@navi/shared/cli-commands";
import { assertPlanReady } from "./task-plan.js";

/** `/plan implement` 换进 prompt 的那句（codex 那一路在 executors/codex-native-commands.ts 里接在原文后面）。 */
export const PLAN_IMPLEMENT_TEXT = "用户已确认最新计划，现在按此计划开始实施。";

/**
 * 实施回合交给模型的正文：用户批准的那张卡的原文。卡是交计划那一刻的快照，计划文件之后被改过也以
 * 卡上这份为准（executors/claude-plan-gate.ts）。
 */
export const planImplementText = (approved: string) =>
  `用户已确认下面这份计划，现在按它开始实施。以这份原文为准：计划文件在交出之后若被改过，不按改过的做。\n\n<approved-plan>\n${approved}\n</approved-plan>`;

/**
 * 这句话交给模型的正文，以及它是不是「带着问题进计划回合」。
 *
 * codex 的 `/plan` 是原生命令，原文交给 app-server 的协作模式去认（codex-native-commands.ts）。
 * claude 在 headless 下没有可透传的 `/plan`（2.1.283 的 init `slash_commands` 里没有它），计划模式
 * 只能由 Navi 起跑时切权限参数（executors/claude-plan-gate.ts），所以前缀在这里摘掉：
 * `/plan 问题` → 计划回合里的「问题」；`/plan implement` → 让它按刚批准的计划动手，`approved` 是那张卡的
 * 原文（调用方经 task-plan.ts `assertPlanReady` 取出；没给只会出现在马上要被拒的起跑里）。
 * 裸 `/plan`、`/plan off` 不起进程（`isPlanToggle`）：回复框里在 task-cli-command.ts 当场改状态，
 * 起智能体的入口（首次运行、重试、队列推进）在 prepareCliInvocation 一律拒掉。
 */
export function planTurnInput(agent: string, slash: CliCommand | null, userText: string, approved?: string): { question: boolean; text: string } {
  if (agent !== "claude" || slash?.name !== "plan") return { question: false, text: userText };
  if (isPlanImplementation(slash)) return { question: false, text: approved ? planImplementText(approved) : PLAN_IMPLEMENT_TEXT };
  if (isPlanToggle(agent, slash)) return { question: false, text: userText };
  return { question: true, text: slash.args };
}

/**
 * 续聊回合用：`/plan implement` 先取出用户批准的那张卡（同时就是「能不能实施」的预检），再按卡上原文
 * 拼实施正文；其余同 `planTurnInput`。
 */
export async function resolvePlanTurn(taskId: string, agent: string, slash: CliCommand | null, userText: string, profileId: string | null, ownerId: string | null): Promise<{ question: boolean; text: string }> {
  const approved = agent === "claude" && isPlanImplementation(slash)
    ? (await assertPlanReady(taskId, agent, profileId, ownerId, slash!.args.split(/\s+/)[1])).text : undefined;
  return planTurnInput(agent, slash, userText, approved);
}
