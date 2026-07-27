// Symmetric debate prompts (DESIGN.md §7): two EQUAL debaters, human is judge.
// Raise-hand marker: a debater puts [可收敛] on its own line when it believes
// consensus is reached. Convergence = BOTH raised in their latest turns.

export const RAISE_MARK = "[可收敛]";

// Cheap one-shot title prompt — summarize the topic into a short list-friendly
// title (the debate equivalent of a single task's auto-title). The agent must
// answer immediately without touching the repo or using tools.
export function title(topic: string): string {
  return `请用不超过 14 个汉字，为下面这个议题/任务起一个简短标题，用于在任务列表里显示。只输出标题本身：不要加引号、不要加「标题：」前缀、不要解释、不要读文件、不要使用任何工具。

议题/任务：
${topic}`;
}

// When a debater is ready to stop, it must close with this exact 3-line block so
// the program can tell consensus (both 与对方一致：是) from a clarified
// disagreement (the human then breaks the tie). [可收敛] only means "I'm ready to
// stop", NOT "we agree".
const CONVERGE_BLOCK = `${RAISE_MARK}
结论：<一句话写出你的最终结论>
与对方一致：是 或 否（你的最终结论是否与对方最新结论一致）`;

export function opening(topic: string, cwd: string): string {
  return `你正在与另一位 AI 辩手就一个技术议题展开对抗式讨论。你们地位平等，没有谁是审查者或实现者。最终由人类裁判判定，但现在请你独立、深入地给出你的立场。

议题：${topic}
工作目录：${cwd}（可读取文件做独立判断，但本阶段不要修改任何文件）

要求：
- 给出你的方案/判断，并说明依据：读了哪些代码、发现了什么、为什么这样想。
- 这是盲态开局，你看不到对方的观点——请完全独立思考，不要揣测附和。
- 主动暴露你方案的风险与边界。

这是盲态开局，看不到对方，不要写 ${RAISE_MARK}。全程中文。`;
}

export function rebuttal(opponentLatest: string, round: number): string {
  return `=== 对方辩手第 ${round - 1} 轮的观点 ===

${opponentLatest}

=== 你的第 ${round} 轮 ===
认真回应对方刚才的每一个关键论点：哪里同意、哪里不同意，给出具体理由。如发现对方遗漏、误判或风险，直接指出。必要时读文件验证。不要无原则附和，也不要为反对而反对。

只有当你认为"再辩也只是重复、可以停了"时，才在回复**最后严格按如下三行收尾（缺一不可，顺序固定）**：
${CONVERGE_BLOCK}
否则不要写这三行，继续推进讨论。注意：${RAISE_MARK} 表示"我认为可以停了"，并不代表你必须同意对方——若你最终结论与对方不同，请如实写"与对方一致：否"。全程中文。`;
}

export function injectFeedback(text: string, round: number): string {
  return `=== 人类裁判的补充意见 ===

${text}

请作为辩手认真对待这条意见，重新审视并据此调整你的立场（这是第 ${round} 轮）。说明你如何采纳或回应。本阶段仍不要修改文件。

如调整后你认为可以停了，就在回复**最后严格按如下三行收尾**：
${CONVERGE_BLOCK}
否则继续讨论。全程中文。`;
}

export function question(text: string, round: number): string {
  return `=== 人类裁判的提问 ===

${text}

请直接、简洁地回答这个问题（第 ${round} 轮）。回答后讨论继续。本轮不要写 ${RAISE_MARK} 除非你确实认为可以收敛了。全程中文。`;
}
