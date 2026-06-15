// Symmetric debate prompts (DESIGN.md §7): two EQUAL debaters, human is judge.
// No hardcoded implementer/reviewer roles (the key fix vs. the cxc prototype).
// Raise-hand marker: a debater puts [可收敛] on its own line when it believes
// consensus is reached. Convergence = BOTH raised in their latest turns.

export const RAISE_MARK = "[可收敛]";

export function opening(topic: string, cwd: string): string {
  return `你正在与另一位 AI 辩手就一个技术议题展开对抗式讨论。你们地位平等，没有谁是审查者或实现者。最终由人类裁判判定，但现在请你独立、深入地给出你的立场。

议题：${topic}
工作目录：${cwd}（可读取文件做独立判断，但本阶段不要修改任何文件）

要求：
- 给出你的方案/判断，并说明依据：读了哪些代码、发现了什么、为什么这样想。
- 这是盲态开局，你看不到对方的观点——请完全独立思考，不要揣测附和。
- 主动暴露你方案的风险与边界。

只有当你真心认为"讨论已充分、可以收敛"时，才在回复最后单起一行写 ${RAISE_MARK}。开局阶段通常不应收敛。全程中文。`;
}

export function rebuttal(opponentLatest: string, round: number): string {
  return `=== 对方辩手第 ${round - 1} 轮的观点 ===

${opponentLatest}

=== 你的第 ${round} 轮 ===
认真回应对方刚才的每一个关键论点：哪里同意、哪里不同意，给出具体理由。如发现对方遗漏、误判或风险，直接指出。必要时读文件验证。不要无原则附和，也不要为反对而反对。

如果你认为双方分歧已澄清、方案已明确、可以收敛了，就在回复最后单起一行写 ${RAISE_MARK}；否则继续推进讨论。全程中文。`;
}

export function injectFeedback(text: string, round: number): string {
  return `=== 人类裁判的补充意见 ===

${text}

请作为辩手认真对待这条意见，重新审视并据此调整你的立场（这是第 ${round} 轮）。说明你如何采纳或回应。如调整后你认为可收敛，最后单起一行写 ${RAISE_MARK}。本阶段仍不要修改文件。全程中文。`;
}

export function question(text: string, round: number): string {
  return `=== 人类裁判的提问 ===

${text}

请直接、简洁地回答这个问题（第 ${round} 轮）。回答后讨论继续。本轮不要写 ${RAISE_MARK} 除非你确实认为可以收敛了。全程中文。`;
}

// Given to the chosen implementer after consensus. This is the ONLY stage that
// writes code; it runs in an isolated worktree.
export function implement(topic: string, consensus: string, note: string, cwd: string): string {
  const extra = note ? `\n\n=== 人类在放行时补充的要求（必须遵循）===\n${note}\n` : "";
  return `=== 辩论已收敛，进入实现阶段 ===

议题：${topic}

你和另一位辩手已就方案达成共识。以下是收敛时的最终讨论内容：

${consensus}
${extra}
现在请你作为实现者，在当前工作目录（${cwd}，这是为本任务隔离出的 git worktree）中，严格按共识方案实现代码改动。
- 确保能通过编译与现有测试。
- 如发现共识中有遗漏或需调整的细节，在回复中说明原因。
- 实现完成后，总结你做了哪些改动。全程中文。`;
}
