// 贴底逻辑的夹具:一个长会话 + 几颗按钮,分别制造「真来了新内容」和「只是界面闪一下」
// 两类 DOM 变化。跑法:npm -w web run test:stick-to-bottom
//
// 夹具刻意**不**渲染真实的会话组件:要钉的是 useStickToBottom 认不认得出这两类变化,
// 混进真实气泡只会把失败原因摊到一堆不相干的渲染里。消息形状照搬群聊那一种(id/body/
// status),指纹也走产品自己的 chatTailKey —— 测的是产品算的那个数,不是测里另写一份。
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { chatTailKey } from "../../src/lib/chatTailKey.ts";
import { isVisibleExecutionEvent } from "@ash/shared/native-work";
import type { ExecutionEvent } from "../../src/lib/executionTrace.ts";
import { appendExecutionEvent } from "../../src/lib/executionTrace.ts";
import { conversationItemSize } from "../../src/task-detail/conversationContentSize.ts";
import type { AgentContentSegment } from "../../src/task-detail/conversationSegments.ts";
import { useStickToBottom } from "../../src/lib/useStickToBottom.ts";

type Message = { id: string; body: string; status: string };

/* 末尾那条旁注(「审查已预约」那类)不是回复,它只是压在最后。正在飞的那一轮在它**前面**,
   新文字由会话合并追加回前面那条气泡 —— 夹具要还原的就是这个形状。 */
const ASIDE: Message = { id: "aside", body: "审查已预约", status: "note" };

const seed = (count: number): Message[] => Array.from({ length: count }, (_, index) => ({
  id: `m${index + 1}`,
  body: `第 ${index + 1} 条消息`,
  status: "ok",
}));

function Feed() {
  const scroll = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState(() => seed(60));
  const [thinking, setThinking] = useState<ExecutionEvent[]>(() => [{ kind: "thinking", label: "思考过程", detail: "开始想" }]);
  // 复制按钮那一类反馈:正文一个字没变,只有这颗按钮的文字/图标在换。
  const [copied, setCopied] = useState(false);
  /* 版本 = 消息那一路 + 这一段执行过程的可读规模。后者走产品自己的
     `conversationItemSize`,测的是产品的契约,不是测里另写一份。 */
  const segment: AgentContentSegment = { id: "seg", markdown: "", events: thinking, attachments: [] };
  const thinkingSize = conversationItemSize({
    kind: "agent", id: "active", sessionId: "s", label: "agent", markdown: "", segments: [segment],
  });
  const { resume } = useStickToBottom(scroll, "fixture", `${chatTailKey(messages)}:${thinkingSize}`);

  return <div>
    <div
      ref={scroll}
      id="feed"
      style={{ height: 300, overflowY: "auto", border: "1px solid #ccc", padding: 8 }}
    >
      {messages.map((message) => <p key={message.id} style={{ height: 40, margin: 0 }}>
        {message.body}
        {/* 最后一条尾巴上挂着反馈按钮 —— 它的变化落在最后一屏内,正是误判过的位置。 */}
        {message.id === messages.at(-1)?.id && <span data-testid="feedback">
          {copied ? "已复制" : "复制这条回复"}
          {copied ? <svg data-testid="feedback-icon" width="12" height="12" /> : null}
        </span>}
      </p>)}
      {/* 正在飞的那一轮的「执行过程」,压在最后:固定高度、字在同一行里接着写,
          所以内容变了而外框不长高 —— 还原「等高更新」这个形状。 */}
      <pre data-testid="thinking-block" style={{ height: 40, margin: 0, overflow: "hidden" }}>
        {thinking.filter(isVisibleExecutionEvent).map((event) => event.detail).join("")}
      </pre>
    </div>

    <button type="button" data-testid="copy-feedback" onClick={() => setCopied((value) => !value)}>
      翻转复制反馈
    </button>
    <button type="button" data-testid="append" onClick={() => setMessages((list) => [
      ...list,
      { id: `m${list.length + 1}`, body: `第 ${list.length + 1} 条消息`, status: "ok" },
    ])}>
      来一条新消息
    </button>
    {/* 最近 N 条轮换:追加一条的同时把最老那条挤掉,条数和总高都不变。 */}
    <button type="button" data-testid="rollover" onClick={() => setMessages((list) => [
      ...list.slice(1),
      { id: `m${Number(list.at(-1)!.id.slice(1)) + 1}`, body: `第 ${list.length + 1} 条消息`, status: "ok" },
    ])}>
      轮换一条
    </button>
    {/* 流式输出:同一条消息在逐字变长,条数不变。 */}
    <button type="button" data-testid="stream" onClick={() => setMessages((list) => [
      ...list.slice(0, -1),
      { ...list.at(-1)!, body: `${list.at(-1)!.body}续` },
    ])}>
      最后一条续写
    </button>
    {/* 末尾压一条旁注,然后给**它前面**那条回复追加文字:屏幕上确实多了东西,
        但最后一行一个字没动,总高也可以不变(同一行里接着写)。 */}
    <button type="button" data-testid="pin-aside" onClick={() => setMessages((list) => (
      list.at(-1)?.id === ASIDE.id ? list : [...list, ASIDE]
    ))}>
      末尾压一条旁注
    </button>
    <button type="button" data-testid="stream-behind-aside" onClick={() => setMessages((list) => {
      const target = list.findLastIndex((message) => message.id !== ASIDE.id);
      if (target < 0) return list;
      const next = [...list];
      next[target] = { ...next[target]!, body: `${next[target]!.body}续` };
      return next;
    })}>
      给旁注前面那条续写
    </button>
    {/* 展开的「执行过程」里思考在逐字长 —— 真实 producer 把增量拼进**已有那条** event
        的 detail(appendExecutionEvent),条数、正文长度、段落个数全都一动不动。 */}
    <button type="button" data-testid="stream-thinking" onClick={() => setThinking((events) =>
      appendExecutionEvent(events, { kind: "thinking", label: "思考过程", detail: "续" }))}>
      收到下一段思考
    </button>
    {/* 子智能体往同一串 events 里塞的通知:主对话一个字都不画出来
        (ExecutionTrace 先 filter 一道 isVisibleExecutionEvent)。 */}
    <button type="button" data-testid="hidden-notice" onClick={() => setThinking((events) => [...events,
      { kind: "tool" as const, label: "Agent", detail: "子任务进展",
        nativeWork: { type: "activity" as const, id: "child", event: { kind: "text" as const, text: "子任务正文" } } }])}>
      来一条不渲染的子智能体通知
    </button>
    <button type="button" data-testid="resume" onClick={() => resume()}>恢复跟随</button>
  </div>;
}

createRoot(document.getElementById("root")!).render(<Feed />);
