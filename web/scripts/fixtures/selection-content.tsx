/* 会话里选中一段 → 三颗按钮拿到的那段文本。跑法:npm -w web run test:selection-content
 *
 * 必须用**真实的 ConversationFeed**:要钉的东西只存在于真实渲染结构里 —— 气泡头上的
 * 身份与时间、折起来的「执行过程 · N 工具」、尾栏的账目胶囊,它们和正文在 DOM 里是
 * 混排的,跨消息拖选必然扫过。手搓几个 div 证明不了选区会不会把它们一起捞走。
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { ConversationSelection } from "../../src/side-chat/ConversationSelection.tsx";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import type { ConversationItem } from "../../src/task-detail/conversationModel.ts";
import type { QuestionRecord } from "@ash/shared/questions";
import "../../src/styles/global.css";

const usage = { input: 1200, output: 340, cacheRead: 9000, cacheWrite: 0, reasoning: 0, costUsd: 0.12, turns: 1 };

/**
 * 一条收了口的 agent 回合，按线上那种形状拼：每一段是「若干工具调用 + 紧随其后说的
 * 话」（contentSegments 的 pushCurrent），折叠切在**最后一次动手**那一段里——事件归
 * 过程、那段正文归结论。于是折叠块里装着前半截工具和过程中说的话，外面只剩结论那
 * 一句，跟用户截图里的会话长得一样。
 */
function turn(index: number, process: string, conclusion: string, [early, late]: [number, number]): ConversationItem {
  const tools = (from: number, count: number) => Array.from({ length: count }, (_, step) => ({
    kind: "tool" as const,
    label: "Bash",
    detail: `npm run test -- case-${index}-${from + step}`,
  }));
  return {
    kind: "agent",
    id: `agent-${index}`,
    sessionId: `session-${index}`,
    label: `Claude ${index}`,
    at: `2026-10-30T0${index}:00:00.000Z`,
    endedAt: `2026-10-30T0${index}:04:00.000Z`,
    usage,
    markdown: `${process}\n\n${conclusion}`,
    // 段尾那个空行是产品分段自带的（只切在顶层块边界上）。手搓时漏掉它，两段正文会
    // 被当成同一个段落拼起来，折叠位置就跟线上不一样了。
    segments: [
      { id: `agent-${index}-did`, markdown: `${process}\n\n`, attachments: [], events: tools(1, early) },
      { id: `agent-${index}-said`, markdown: conclusion, attachments: [], events: tools(early + 1, late) },
    ],
  };
}

const items: ConversationItem[] = [
  { kind: "user", id: "user-1", text: "第 2 条改完就接着做第 3 条。", attachments: [], at: "2026-10-30T00:30:00.000Z" },
  // 结论两段:段内的换行得由排版说了算(Range.toString() 会把它们挤成一行)。
  turn(1, "先把启动自检那一段读了一遍。", "第 2 条改完，测试也过了。\n\n接下来做第 3 条。", [4, 2]),
  turn(2, "把旧的跳过条件放回去又跑了一轮。", "第 3 条改完了。", [1, 1]),
  // 多行用户消息:气泡的 `white-space: pre-wrap` 来自祖先限定的 CSS
  // (`.task-user-bubble > p`),取文必须在原页面上量,离屏克隆会把它折成一行。
  { kind: "user", id: "user-2", text: "用户首行\n    缩进内容\n用户尾行", attachments: [], at: "2026-10-30T02:30:00.000Z" },
  // 以代码块开头的结论:切口两边只能削换行,首行那四个空格是正文自己的缩进。
  turn(3, "顺手把示例补上。", '```python\n    print("缩进不能丢")\n    print("第二行")\n```', [1, 1]),
];

/* 一条没跟任何用户消息配对的问答记录 —— 走 QuestionHistoryRemainder 那条路，渲染出真实的
   `AnsweredQuestionCard`。折起来时整张卡**可见的只有 `<summary>` 那一行**：答复预览就在
   里头，而完整问答藏在闭合的 `<details>` 里。两件要钉的事都只在这个真结构上成立 ——
   摘要行不能被当装置整块删掉，藏着的那半截一个字都不许漏出来。 */
const answered: QuestionRecord = {
  id: "q-1",
  answeredAt: "2026-10-30T03:30:00.000Z",
  question: "隐藏的问题正文",
  answer: "按第二个方案做，先把开关关掉。",
  reply: "按第二个方案做，先把开关关掉。",
};

/* 流式续写把块类型换掉的那一下：结论从一个段落变成列表，原来那个 `<p>` 当场卸载，选区
   里的文本节点脱离文档。存 Range 的实现在这一刻取文只能得到空串（而浮条还在）。 */
const streamed = items.map((item) => item.id === "agent-1"
  ? turn(1, "先把启动自检那一段读了一遍。", "- 第 2 条改完，测试也过了。\n- 接下来做第 3 条。", [4, 2])
  : item);

const task = { id: "selection", projectId: "p", title: "选文取正文", mode: "single", agentType: "claude", status: "done" } as Task;

function Fixture() {
  const [taken, setTaken] = useState<{ from: string; text: string } | null>(null);
  const [list, setList] = useState(items);
  // 用全局钩子触发而不是摆一颗按钮：点按钮会把选区清掉，那就测不到「选着的时候正文被
  // 换掉」这一幕了。
  useEffect(() => {
    (window as unknown as { __restream: () => void }).__restream = () => setList(streamed);
  }, []);
  return <main style={{ padding: 24 }}>
    {/* 读数摆在会话**上面**:会话区自己会铺满给它的那块高度,摆在下面会被它盖住点不着。 */}
    <button type="button" data-testid="clear" onClick={() => setTaken(null)}>清空</button>
    <pre data-testid="taken-from">{taken?.from ?? ""}</pre>
    <pre data-testid="taken">{taken?.text ?? ""}</pre>
    <ConversationSelection
      taskId={task.id}
      onAddToReply={(text) => setTaken({ from: "reply", text })}
      onAddToMemo={(text) => setTaken({ from: "memo", text })}
    >
      <div style={{ height: 520 }}>
        <ConversationFeed task={task} items={list} sessions={[]} questionHistory={[answered]} loading={false} error={null} />
      </div>
      {/* 一张**没有任何选文标记**的卡,照审查泳道/辩论卡那种写法摆:头尾用的就是
          header / time / button / aria-hidden 这些语义标签。钉住「新写的卡片不必记得
          加标记」—— 审查第 1 轮不拦项里那四处现成的,靠的正是这条。摆在会话区旁边而
          不是它的 footer 里:那块高度是固定的,卡会被裁掉,rect 为 0 就连浮条都不出。 */}
      <article className="verify-lane" data-testid="unmarked-card">
        <header className="verify-lane-head">
          <span aria-hidden="true">🛡</span>
          <b>第 1 轮独立验证</b>
          <span>Codex 在审</span>
          <time>10/30 12:00</time>
          <button type="button">收起</button>
        </header>
        <p>审查卡自己的正文该留下。</p>
        <footer><button type="button">查看报告</button>已通过</footer>
      </article>
    </ConversationSelection>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
