/* 会话里选中一段 → 三颗按钮拿到的那段文本。跑法:npm -w web run test:selection-content
 *
 * 必须用**真实的 ConversationFeed**:要钉的东西只存在于真实渲染结构里 —— 气泡头上的
 * 身份与时间、折起来的「执行过程 · N 工具」、尾栏的账目胶囊,它们和正文在 DOM 里是
 * 混排的,跨消息拖选必然扫过。手搓几个 div 证明不了选区会不会把它们一起捞走。
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Task } from "@ash/shared";
import { ConversationSelection } from "../../src/side-chat/ConversationSelection.tsx";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import type { ConversationItem } from "../../src/task-detail/conversationModel.ts";
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
];

const task = { id: "selection", projectId: "p", title: "选文取正文", mode: "single", agentType: "claude", status: "done" } as Task;

function Fixture() {
  const [taken, setTaken] = useState<{ from: string; text: string } | null>(null);
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
        <ConversationFeed task={task} items={items} sessions={[]} questionHistory={[]} loading={false} error={null} />
      </div>
    </ConversationSelection>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
