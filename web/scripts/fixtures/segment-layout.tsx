/* 分段布局:**空段就是高度**。跑法:npm -w web run test:segment-layout
 *
 * 这个夹具跟 stick-to-bottom.tsx 分工不同:那边刻意不渲染真实会话组件,钉的是「贴底逻辑
 * 认不认得出两类变化」;这边必须用**真实的 AgentTurnBody 和真实 CSS**,因为要钉的东西只
 * 在真实渲染结构里才存在 —— 子智能体的后台通知在正文后面被切成自己的一段,那一段一个
 * 字都画不出来,可 `.task-agent-segment + .task-agent-segment` 给它 7px 间距,scrollHeight
 * 就涨了 7px。前一版贴底判据看见底边下移就当「有新东西」,把停在离底 79px 的人拽到底
 * (审查第 6 轮 F1)。手工拼几个空 div 证明不了这件事,所以分段也走真实的 contentSegments。
 */
import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/global.css";
import { AgentTurnBody } from "../../src/components/AgentTurnBody.tsx";
import { contentSegments } from "../../src/task-detail/conversationSegments.ts";
import { conversationItemSize } from "../../src/task-detail/conversationContentSize.ts";
import type { SessionTraceEntry } from "../../src/lib/api.ts";
import { useStickToBottom } from "../../src/lib/useStickToBottom.ts";

const entry = (event: SessionTraceEntry["event"]): SessionTraceEntry => ({ at: "2026-10-14T09:00:00Z", event });

/** 子智能体往同一串 events 里塞的后台通知:这个表面一个字都不画。 */
const hiddenNotice = () => entry({
  kind: "tool", name: "Agent", detail: "子任务进展",
  nativeWork: { type: "activity", id: "child", event: { kind: "text", text: "子任务正文" } },
} as SessionTraceEntry["event"]);

/** 真工具调用:画得出来的那一类,照旧要切段、要跟随。 */
const visibleTool = () => entry({ kind: "tool", name: "Bash", detail: "ls -la" } as SessionTraceEntry["event"]);

const seed = (): SessionTraceEntry[] => [
  ...Array.from({ length: 24 }, (_, index) => entry({ kind: "text", text: `历史正文第 ${index + 1} 段,够长才会出现滚动条。\n\n` } as SessionTraceEntry["event"])),
  entry({ kind: "text", text: "最后一段已经说出口的正文" } as SessionTraceEntry["event"]),
];

function Feed() {
  const scroll = useRef<HTMLDivElement>(null);
  const [trace, setTrace] = useState<SessionTraceEntry[]>(seed);
  const [running, setRunning] = useState(true);

  const segments = useMemo(() => {
    // 正文的权威是 .md(见 contentSegments);夹具里就按 trace 里的 text 拼出来。
    const markdown = trace.map((item) => item.event.kind === "text" ? item.event.text : "").join("");
    return contentSegments(trace, markdown, "turn");
  }, [trace]);

  // 版本走产品自己的契约,不在测里另写一份。
  const tailKey = conversationItemSize({
    kind: "agent", id: "active", sessionId: "s", label: "agent",
    markdown: segments.map((segment) => segment.markdown).join(""), segments,
  });
  useStickToBottom(scroll, "fixture", tailKey);

  return <div>
    <div ref={scroll} id="feed" className="task-conversation" style={{ height: 320, overflowY: "auto", padding: 8 }}>
      <AgentTurnBody segments={segments} running={running} />
    </div>
    <button type="button" data-testid="hidden-notice" onClick={() => setTrace((list) => [...list, hiddenNotice()])}>
      来一条不渲染的子智能体通知
    </button>
    <button type="button" data-testid="visible-tool" onClick={() => setTrace((list) => [...list, visibleTool()])}>
      来一条真工具调用
    </button>
    <button type="button" data-testid="more-text" onClick={() => setTrace((list) => [
      ...list, entry({ kind: "text", text: "续写的新正文" } as SessionTraceEntry["event"]),
    ])}>
      继续写正文
    </button>
    <button type="button" data-testid="settle" onClick={() => setRunning(false)}>这一回合收口</button>
    <span data-testid="running-state">{running ? "running" : "settled"}</span>
  </div>;
}

createRoot(document.getElementById("root")!).render(<Feed />);
