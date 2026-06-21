// Symmetric debate prompts (DESIGN.md §7): two EQUAL debaters, human is judge.
// No hardcoded implementer/reviewer roles (the key fix vs. the cxc prototype).
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

// 协作版收敛块：协作是往一份统一方案合并，没有"分歧"，所以固定「与对方一致：是」。
const COLLAB_CONVERGE = `${RAISE_MARK}
结论：<一句话写出合并后的统一方案>
与对方一致：是`;

export function opening(topic: string, cwd: string, style: "debate" | "collaborate" = "debate"): string {
  if (style === "collaborate") {
    return `你和另一位 AI 是平等的协作者，要一起完成同一个任务。你们地位平等，没有谁高谁低。现在请你独立给出初步方案与依据。

任务：${topic}
工作目录：${cwd}（可读取文件做判断，本阶段不要修改任何文件）

要求：
- 给出你的方案/思路，并说明依据：读了哪些代码、发现了什么、打算怎么做。
- 这是盲态开局，你看不到对方的方案——请独立思考。稍后你们会互相查缺补漏，合并成一份统一方案。
- 主动说明你方案的不确定处与风险，方便对方补充。

这是盲态开局，看不到对方，不要写 ${RAISE_MARK}。全程中文。`;
  }
  return `你正在与另一位 AI 辩手就一个技术议题展开对抗式讨论。你们地位平等，没有谁是审查者或实现者。最终由人类裁判判定，但现在请你独立、深入地给出你的立场。

议题：${topic}
工作目录：${cwd}（可读取文件做独立判断，但本阶段不要修改任何文件）

要求：
- 给出你的方案/判断，并说明依据：读了哪些代码、发现了什么、为什么这样想。
- 这是盲态开局，你看不到对方的观点——请完全独立思考，不要揣测附和。
- 主动暴露你方案的风险与边界。

这是盲态开局，看不到对方，不要写 ${RAISE_MARK}。全程中文。`;
}

export function rebuttal(opponentLatest: string, round: number, style: "debate" | "collaborate" = "debate"): string {
  if (style === "collaborate") {
    return `=== 对方协作者第 ${round - 1} 轮的方案 ===

${opponentLatest}

=== 你的第 ${round} 轮（查缺补漏 → 合并）===
你们是合作关系，目标是合出一份**最好的统一方案**，不是分输赢。请：
- 指出对方遗漏、可改进或有风险的地方，并补上你的部分。
- 吸收对方比你强的点，主动向一份统一方案靠拢。
- 必要时读文件验证。

当你认为方案已合并完善、可以定稿时，在回复**最后严格按如下三行收尾（缺一不可，顺序固定）**：
${COLLAB_CONVERGE}
否则不要写这三行，继续完善方案。全程中文。`;
  }
  return `=== 对方辩手第 ${round - 1} 轮的观点 ===

${opponentLatest}

=== 你的第 ${round} 轮 ===
认真回应对方刚才的每一个关键论点：哪里同意、哪里不同意，给出具体理由。如发现对方遗漏、误判或风险，直接指出。必要时读文件验证。不要无原则附和，也不要为反对而反对。

只有当你认为"再辩也只是重复、可以停了"时，才在回复**最后严格按如下三行收尾（缺一不可，顺序固定）**：
${CONVERGE_BLOCK}
否则不要写这三行，继续推进讨论。注意：${RAISE_MARK} 表示"我认为可以停了"，并不代表你必须同意对方——若你最终结论与对方不同，请如实写"与对方一致：否"。全程中文。`;
}

export function injectFeedback(text: string, round: number, style: "debate" | "collaborate" = "debate"): string {
  if (style === "collaborate") {
    return `=== 人类的补充意见 ===

${text}

请作为协作者认真对待这条意见，据此调整并完善你们的统一方案（这是第 ${round} 轮）。说明你如何采纳。本阶段仍不要修改文件。

如调整后方案已可定稿，就在回复**最后严格按如下三行收尾**：
${COLLAB_CONVERGE}
否则继续完善方案。全程中文。`;
  }
  return `=== 人类裁判的补充意见 ===

${text}

请作为辩手认真对待这条意见，重新审视并据此调整你的立场（这是第 ${round} 轮）。说明你如何采纳或回应。本阶段仍不要修改文件。

如调整后你认为可以停了，就在回复**最后严格按如下三行收尾**：
${CONVERGE_BLOCK}
否则继续讨论。全程中文。`;
}

export function question(text: string, round: number, style: "debate" | "collaborate" = "debate"): string {
  if (style === "collaborate") {
    return `=== 人类的提问 ===

${text}

请直接、简洁地回答这个问题（第 ${round} 轮）。回答后协作继续。本轮不要写 ${RAISE_MARK}，除非方案确实已可定稿。全程中文。`;
  }
  return `=== 人类裁判的提问 ===

${text}

请直接、简洁地回答这个问题（第 ${round} 轮）。回答后讨论继续。本轮不要写 ${RAISE_MARK} 除非你确实认为可以收敛了。全程中文。`;
}

// Code review by the OTHER debater after the implementer writes code. It runs in
// the implementer's working dir, so it can inspect the actual diff with git.
export function review(topic: string, cwd: string): string {
  return `=== 代码审查 ===

议题：${topic}

实现方刚在当前工作目录（${cwd}）按你们讨论的方案实现了代码改动。现在请你作为**代码审查方**做一次 code review：
- 先用 git 看实际改动：\`git -C . diff\`、\`git -C . status\`、必要时读相关文件。
- 审查要点：是否有 bug / 边界遗漏 / 安全或健壮性问题 / 与方案不符之处 / 明显坏味道。
- 简明扼要、列要点；指出问题时给出具体位置和修法建议。
- 如果改动没问题，明确写一行结论「通过」。
本阶段只读不改。全程中文。`;
}
// that writes code in the project's working dir. `directive` is computed by
// the orchestrator — it states honestly whether this is a real consensus or a
// human-/config-chosen side, so the implementer never acts on a fake "consensus".
export function implement(topic: string, finalDiscussion: string, directive: string, cwd: string): string {
  return `=== 讨论完成，进入实现阶段 ===

议题：${topic}

以下是双方最终的讨论内容：

${finalDiscussion}

=== 实现指令（必须遵循）===
${directive}

现在请你作为实现者，在当前工作目录（${cwd}）中，严格按上面的实现指令落地代码改动。
- 确保能通过编译与现有测试。
- 如发现指令中有遗漏或需调整的细节，在回复中说明原因。
- 实现完成后，总结你做了哪些改动。全程中文。`;
}
