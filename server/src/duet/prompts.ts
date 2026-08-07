// 讨论(duet)prompts(DESIGN.md §7):两个地位平等的「声音」共同打磨一个方案,
// 用户拍板。目标函数是**合出更完善的方案**,不是驳倒对方:每一轮先吸收对方的
// 好点子、再补强对方的疏漏,然后给出自己此刻的最新完整方案。盲态开局与严格
// 串行回合保证两种声音真实独立——那是「两种不同的声音让方案更完善」的机制
// 保障,改目标函数不改机制。
// 收敛协议(程序解析,勿改格式):[可收敛] 单独一行表示「我认为可以停了」;
// 收敛 = 双方都举手,或一方举手且声明与对方一致。收敛后另有一轮合稿
// (synthesize)把成果整理成共同方案文档,那才是 /duet 的正式产出。

export const RAISE_MARK = "[可收敛]";

// Cheap one-shot title prompt — summarize the topic into a short list-friendly
// title (the duet equivalent of a single task's auto-title). The agent must
// answer immediately without touching the repo or using tools.
export function title(topic: string): string {
  return `请用不超过 14 个汉字，为下面这个议题/任务起一个简短标题，用于在任务列表里显示。只输出标题本身：不要加引号、不要加「标题：」前缀、不要解释、不要读文件、不要使用任何工具。

议题/任务：
${topic}`;
}

// When a voice is ready to stop, it must close with this exact 3-line block so
// the program can tell consensus (both confirmed, or one declared agreement)
// from a clarified disagreement (the human then breaks the tie). [可收敛] only
// means "I'm ready to stop", NOT "we agree".
const CONVERGE_BLOCK = `${RAISE_MARK}
结论：<一句话概括你此刻的方案要点>
与对方一致：是 或 否（你此刻的方案是否与对方最新方案一致）`;

export function opening(topic: string, cwd: string): string {
  return `你和另一位 AI 讨论伙伴要共同为一个难以抉择的问题打磨出方案。你们地位平等，没有谁是审查者或实现者；最终由用户拍板。现在是盲态开局——你看不到对方，请完全独立地给出你自己的方案。

议题：${topic}
工作目录：${cwd}（可读取文件做独立判断，但本阶段不要修改任何文件）

要求：
- 给出你的完整方案，并说明依据：读了哪些代码、发现了什么、为什么这样设计。
- 独立思考，不要揣测对方会说什么。两份真正独立的方案，是后面讨论质量的原料。
- 主动写明你方案的风险、代价与不确定的假设——它们会在接下来的讨论中被对方帮你补强。

这是盲态开局，看不到对方，不要写 ${RAISE_MARK}。全程中文。`;
}

export function evolve(opponentLatest: string, round: number): string {
  return `=== 对方第 ${round - 1} 轮的方案 ===

${opponentLatest}

=== 你的第 ${round} 轮 ===
你们的目标是合出一个比任何一方独自想出的都更完善的方案，不是说服对方。按三步走：
1. **先吸收**：对方哪些点比你的好？直接采纳进你的方案，并明说采纳了什么、为什么。
2. **再补强**：对方方案里你看到的风险、遗漏或误判，指出来并给出补法——目的是让最终方案更扎实，不是赢。必要时读文件验证。
3. **给出你此刻的最新完整方案**：融合两边之后的完整版本，不要只写差异。

不要无原则附和，也不要为不同而不同：真实的分歧要保留，并写清双方的取舍。

只有当你认为"方案已经稳定、再聊只是重复"时，才在回复**最后严格按如下三行收尾（缺一不可，顺序固定）**：
${CONVERGE_BLOCK}
否则不要写这三行，继续推进讨论。注意：${RAISE_MARK} 表示"我认为可以停了"，并不代表你必须同意对方——若你的方案与对方仍有实质分歧，请如实写"与对方一致：否"。若你确认双方方案已一致，写下 ${RAISE_MARK} 且"与对方一致：是"后讨论将立即收敛，无需等待对方再确认；不要把关键内容留到下一轮。全程中文。`;
}

export function injectFeedback(text: string, round: number): string {
  return `=== 用户的补充意见 ===

${text}

请认真对待这条意见，重新审视你的方案并据此调整（这是第 ${round} 轮）。说明你如何采纳，或为何保留原判断。本阶段仍不要修改文件。

如调整后你认为可以停了，就在回复**最后严格按如下三行收尾**：
${CONVERGE_BLOCK}
否则继续讨论。全程中文。`;
}

export function question(text: string, round: number): string {
  return `=== 用户的提问 ===

${text}

请直接、简洁地回答这个问题（第 ${round} 轮）。回答后讨论继续。本轮不要写 ${RAISE_MARK} 除非你确实认为可以收敛了。全程中文。`;
}

// 收敛后(或讨论停下来后)的合稿轮:把讨论成果整理成一份完整的共同方案文档。它是
// /duet 的正式产出——gate 上那两行 140 字的结论只够扫一眼,拍板与交接执行需要的
// 是这份全文。停止原因有三种,措辞必须如实,不许把分歧包装成共识:
//   consensus    双方结论一致 → 共同方案
//   agreedToStop 双方同意停止但各自保留结论 → 决策文档(这不是轮数耗尽!)
//   roundCap     到达轮数上限仍未收敛 → 决策文档
//   midway       用户介入回炉后刚更新了一轮、尚未重新收敛,先开门给用户看 → 决策文档
// userNote 是用户最近一次 gate 介入的原文——合稿由 A 执行,定向提问 B 时 A 没
// 见过问题,只看 B 的回答会不知所云。
export type SynthesizeStop = "consensus" | "agreedToStop" | "roundCap" | "midway";

export function synthesize(args: {
  opponentLatest: string;
  stop: SynthesizeStop;
  userNote?: { text: string; target?: "A" | "B" };
}): string {
  const consensus = args.stop === "consensus";
  const head = consensus
    ? "讨论已收敛。"
    : args.stop === "agreedToStop"
      ? "双方一致认为讨论可以停止，但**各自保留了不同结论**，没有达成共识。"
      : args.stop === "midway"
        ? "用户介入后双方各自更新了一轮方案，**尚未重新走到收敛**；现在把当前状态整理出来供用户裁决。"
        : "讨论到达轮数上限，双方**没有达成收敛**，仍存在实质分歧。";
  const goal = consensus
    ? "现在请你把这场讨论的成果整理成一份**共同方案**——它是这场讨论的正式产出：用户拿它拍板，后续团队拿它拆解执行。"
    : "现在请你把这场讨论整理成一份**决策文档**供用户拍板：双方已有的共同点整理成方案基础，真实分歧如实列进「残留分歧」——**绝不要把没达成的共识写成已达成**。";
  const noteBlock = args.userNote
    ? `

=== 用户最近的介入${args.userNote.target ? `（当时只发给了讨论者 ${args.userNote.target}）` : ""} ===
${args.userNote.text}`
    : "";
  return `${head}${noteBlock}

下面是对方（讨论者 B）的最后一轮发言——你可能还没见过它的最新版本，合稿前先读完并把它纳入：

=== 讨论者 B 的最后发言 ===
${args.opponentLatest}

${goal}只输出方案文档本身，不要开场白和客套。

结构要求（markdown）：
# 方案
<方案本体：完整、自洽、可执行。写双方融合后的${consensus ? "最终共识" : "共同点基础"}，不是你单方的最后一版。>

## 关键决策与理由
<双方一致同意的关键选择及理由，包括讨论中被放弃的备选和放弃原因。>

## 双方贡献
<各自被采纳进最终方案的要点，各一两行即可。>

## 风险与待验证假设
<方案里仍不确定、需要在执行中验证的部分。>

## 残留分歧
<仍未合意的点，如实列出双方立场留给用户拍板；没有就写"无"。>

本轮不要写 ${RAISE_MARK}，不要修改任何文件。全程中文。`;
}
