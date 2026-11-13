// ⌘K 打开命中后「会话落到命中处、关键词闪几下」的夹具（断言在 test-search-reveal-dom.mjs）。
//
// 会话外壳不用真的 ConversationFeed（它一挂就去拉接口），用的是同一套类名和同一个
// ConversationScrollControls：贴底、待办、找词、落点、闪烁全是产品代码。
// 外面用 `window.fixture` 驱动：挂上 / 卸下会话、正文读完没有、来一段新回复、从 ⌘K 发一张待办。
// 会话流上面照 duet 那样摆一块折起来的议题：任务正文画在滚动容器外面，靠 revealRoots 交给查找器。
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationScrollControls } from "../../src/components/ConversationScrollControls.tsx";
import { contentVersion } from "../../src/lib/useStickToBottom.ts";
import { pendingSearchReveal, requestSearchReveal } from "../../src/search/searchReveal.ts";
import "../../src/styles/global.css";

type Item = { id: string; text: string; fold?: string; box?: "nested" | "wide"; boxText?: string };

// 「编辑器」出现三次：原始需求里一次、中间一段里一次（上下文跟 ⌘K 给的 snippet 对得上）、
// 尾部一次。「旁路通道」只出现在一块折好的执行过程里。
const seed: Item[] = [
  { id: "requirement", text: "原始需求：设置页里的执行模式编辑器要压成一行。" },
  ...Array.from({ length: 6 }, (_, index) => ({ id: `filler-${index}`, text: `第 ${index + 1} 段：先读代码，摸清现状。` })),
  { id: "middle", text: "改为：列表项每行前面加上对应角色的 icon——与右侧编辑器一致：调度者、执行者、审查者。" },
  { id: "process", text: "过程收起来了。", fold: "这里排查了一下旁路通道的残留进程。" },
  ...Array.from({ length: 6 }, (_, index) => ({ id: `tail-${index}`, text: `第 ${index + 7} 段：接着干活。` })),
  { id: "last", text: "最后：编辑器那一块已经改好。" },
  // 会话里套着的小滚动框：限高往下滚的（工具参数那种）、横向滚的（长代码行）。词都在框里看不到的那一头。
  { id: "nested", text: "跑了一条命令。", box: "nested", boxText: `${Array.from({ length: 30 }, (_, index) => `输出第 ${index + 1} 行`).join("\n")}\n限高框末尾词` },
  { id: "wide", text: "一段很长的代码。", box: "wide", boxText: `${"x".repeat(600)} 横向尽头词` },
  // İ 小写后长度会变、Σ 在词尾词中折法不同：会话里有它们，大小写照样不分。
  { id: "unicode", text: "İstanbul 那台机器上的 MixedCase 配置，还有 ΚΟΣΜΟΣ 这个词。" },
];

declare global {
  interface Window {
    fixture: {
      mount: (taskId: string | null) => void;
      ready: (value: boolean) => void;
      append: () => void;
      request: (taskId: string, query: string, hint: string) => void;
      pending: (taskId: string) => boolean;
    };
  }
}

// 议题很长、词在最后：照 duet 那样，完整议题放在一个限高能滚的框里。
const TOPIC = `${Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 段：这是议题的前置说明。`).join("\n")}\n议题：讨论一下议题专用词该怎么落地。`;

function Feed({ taskId, ready, items }: { taskId: string; ready: boolean; items: Item[] }) {
  const scroll = useRef<HTMLDivElement>(null);
  const topic = useRef<HTMLDivElement>(null);
  const tailKey = contentVersion(items, (item) => item.text.length, (item) => item.id);
  return (
    <>
    <details data-testid="topic">
      <summary><b data-search-skip="" style={{ display: "inline-block", maxWidth: 400, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", verticalAlign: "bottom" }}>{TOPIC}</b></summary>
      <div ref={topic} data-testid="topic-full" style={{ maxHeight: 120, overflowY: "auto", whiteSpace: "pre-wrap" }}>{TOPIC}</div>
    </details>
    <div className="conversation-scroll-region" data-testid="region" style={{ minHeight: 0, flex: 1 }}>
      <div className="task-conversation" ref={scroll} data-testid="feed">
        {items.map((item) => (
          <article key={item.id} data-item={item.id} className="task-message" style={{ minHeight: 220 }}>
            <p>{item.text}</p>
            {item.box && (
              <pre
                data-testid={`box-${item.box}`}
                style={item.box === "nested"
                  ? { maxHeight: 80, overflow: "auto", whiteSpace: "pre-wrap" }
                  : { overflowX: "auto", whiteSpace: "pre" }}
              >{item.boxText}</pre>
            )}
            {item.fold && (
              <details data-testid="fold">
                <summary>执行过程</summary>
                <p>{item.fold}</p>
              </details>
            )}
          </article>
        ))}
      </div>
      <ConversationScrollControls scrollRef={scroll} resetKey={taskId} tailKey={tailKey} revealReady={ready} revealRoots={[topic]} />
    </div>
    </>
  );
}

function Fixture() {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [items, setItems] = useState(seed);
  useEffect(() => {
    window.fixture = {
      mount: setTaskId,
      ready: setReady,
      append: () => setItems((list) => [...list, { id: `new-${list.length}`, text: "又来了一段新回复。" }]),
      request: requestSearchReveal,
      pending: (taskId) => !!pendingSearchReveal(taskId),
    };
  }, []);
  return (
    <main style={{ display: "flex", flexDirection: "column", width: 760, height: 520 }}>
      {taskId && <Feed key={taskId} taskId={taskId} ready={ready} items={items} />}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
