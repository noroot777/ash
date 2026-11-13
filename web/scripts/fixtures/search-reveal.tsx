// ⌘K 打开命中后「会话落到命中处、关键词闪几下」的夹具（断言在 test-search-reveal-dom.mjs）。
//
// 会话外壳不用真的 ConversationFeed（它一挂就去拉接口），用的是同一套类名和同一个
// ConversationScrollControls：贴底、待办、找词、落点、闪烁全是产品代码。
// 外面用 `window.fixture` 驱动：挂上 / 卸下会话、正文读完没有、来一段新回复、从 ⌘K 发一张待办。
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationScrollControls } from "../../src/components/ConversationScrollControls.tsx";
import { contentVersion } from "../../src/lib/useStickToBottom.ts";
import { requestSearchReveal } from "../../src/search/searchReveal.ts";
import "../../src/styles/global.css";

type Item = { id: string; text: string; fold?: string };

// 「编辑器」出现三次：原始需求里一次、中间一段里一次（上下文跟 ⌘K 给的 snippet 对得上）、
// 尾部一次。「旁路通道」只出现在一块折好的执行过程里。
const seed: Item[] = [
  { id: "requirement", text: "原始需求：设置页里的执行模式编辑器要压成一行。" },
  ...Array.from({ length: 6 }, (_, index) => ({ id: `filler-${index}`, text: `第 ${index + 1} 段：先读代码，摸清现状。` })),
  { id: "middle", text: "改为：列表项每行前面加上对应角色的 icon——与右侧编辑器一致：调度者、执行者、审查者。" },
  { id: "process", text: "过程收起来了。", fold: "这里排查了一下旁路通道的残留进程。" },
  ...Array.from({ length: 6 }, (_, index) => ({ id: `tail-${index}`, text: `第 ${index + 7} 段：接着干活。` })),
  { id: "last", text: "最后：编辑器那一块已经改好。" },
];

declare global {
  interface Window {
    fixture: {
      mount: (taskId: string | null) => void;
      ready: (value: boolean) => void;
      append: () => void;
      request: (taskId: string, query: string, hint: string) => void;
    };
  }
}

function Feed({ taskId, ready, items }: { taskId: string; ready: boolean; items: Item[] }) {
  const scroll = useRef<HTMLDivElement>(null);
  const tailKey = contentVersion(items, (item) => item.text.length, (item) => item.id);
  return (
    <div className="conversation-scroll-region" data-testid="region">
      <div className="task-conversation" ref={scroll} data-testid="feed">
        {items.map((item) => (
          <article key={item.id} data-item={item.id} className="task-message" style={{ minHeight: 220 }}>
            <p>{item.text}</p>
            {item.fold && (
              <details data-testid="fold">
                <summary>执行过程</summary>
                <p>{item.fold}</p>
              </details>
            )}
          </article>
        ))}
      </div>
      <ConversationScrollControls scrollRef={scroll} resetKey={taskId} tailKey={tailKey} revealReady={ready} />
    </div>
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
