// 会话左侧输入导航的夹具：一条长会话，夹着几颗「我」的气泡，外加系统代写的那几种
// （哨兵投喂、审查打回）——它们也是 user 气泡，但不该出现在导航上。
// 跑法：npm -w web run test:conversation-input-rail-dom
//
// 会话外壳不用真的 ConversationFeed（它一挂就去拉接口），用的是同一套类名、同一个锚点助手、
// 同一个 ConversationScrollControls：导航条、贴底、Q 的分发全是产品代码。
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationScrollControls } from "../../src/components/ConversationScrollControls.tsx";
import { contentVersion } from "../../src/lib/useStickToBottom.ts";
import { conversationInputAnchor, conversationInputs } from "../../src/task-detail/conversationInputs.ts";
import { useWorkspaceShortcuts } from "../../src/workspace/useWorkspaceShortcuts.ts";
import "../../src/styles/global.css";

type Item = { kind: "user" | "agent"; id: string; text: string; at?: string; bySystem?: boolean; short?: boolean };

const REQUIREMENT = "原始需求：在会话左侧加一条输入导航\n指上去看全文，点一下跳过去";
const seed: Item[] = [
  { kind: "agent", id: "a0", text: "先摸一下现状。" },
  { kind: "user", id: "persisted:user:s1:2", text: "第一次追问：Q 摊开全部", at: "2026-11-03T01:00:00.000Z" },
  { kind: "agent", id: "a1", text: "好的。" },
  { kind: "user", id: "monitor", text: "【哨兵事件】回归跑完了", bySystem: true },
  { kind: "agent", id: "a2", text: "回归是绿的。" },
  { kind: "user", id: "persisted:user:s1:6", text: "第二次追问：点横线要跳到气泡", at: "2026-11-03T02:00:00.000Z" },
  { kind: "agent", id: "a3", text: "收到。" },
  { kind: "user", id: "review", text: "【自由工作流审查未通过 · 第 1 轮】按报告修", bySystem: true },
  { kind: "agent", id: "a4", text: "修好了。" },
  { kind: "user", id: "persisted:user:s2:1", text: "第三次追问：哨兵别算进去", at: "2026-11-03T03:00:00.000Z" },
  // 第三、四次追问之间只回了一句：两颗气泡挨得近，跳到第三次之后第四次那颗也在阅读线以上。
  { kind: "agent", id: "a5", text: "已排除。", short: true },
  { kind: "user", id: "persisted:user:s2:3", text: "第四次追问：读到哪一条要标出来", at: "2026-11-03T04:00:00.000Z" },
  { kind: "agent", id: "a6", text: "加上了。" },
];
const noop = () => {};

function Fixture() {
  const scroll = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState(seed);
  const [covered, setCovered] = useState(false);
  // 真工作区每来一条任务事件就重渲一遍，useWorkspaceShortcuts 拿到的回调是新的、监听会重挂；
  // 这里给一个能从外面戳一下的重渲，回调也照真工作区那样每次现造。
  const [, setRenders] = useState(0);
  useEffect(() => {
    const bump = () => setRenders((count) => count + 1);
    window.addEventListener("fixture-rerender", bump);
    return () => window.removeEventListener("fixture-rerender", bump);
  }, []);
  const inputs = useMemo(() => conversationInputs({ text: REQUIREMENT, at: "2026-11-03T00:00:00.000Z" }, items), [items]);
  const tailKey = contentVersion(items, (item) => item.text.length, (item) => item.id);

  useWorkspaceShortcuts({
    enabled: true,
    paletteOpen: false,
    composerOpen: false,
    spreadOpen: false,
    onNavigate: () => noop(),
    onTogglePalette: () => noop(),
    onCreate: () => noop(),
    onToggleSpread: () => noop(),
    onCloseSpread: () => noop(),
    onToggleTaskMode: () => noop(),
    onOpenSettings: () => noop(),
    onToggleCommands: () => noop(),
    onToggleTerminal: () => noop(),
  });

  return (
    <main style={{ display: "flex", flexDirection: "column", width: 760, height: 520 }}>
      <input data-testid="text-entry" aria-label="文本输入" />
      <button type="button" data-testid="append" onClick={() => setItems((list) => [
        ...list,
        { kind: "agent", id: `tail-${list.length}`, text: "又来了一段新回复。" },
      ])}>来一段新回复</button>
      <button type="button" data-testid="cover" onClick={() => setCovered(true)}>拉出抽屉</button>
      <div className="conversation-scroll-region" data-testid="region">
        <div className="task-conversation" ref={scroll} data-testid="feed">
          {items.map((item) => item.kind === "user" ? (
            <article key={item.id} className={`task-message task-message--user${item.bySystem ? " is-system-authored" : ""}`}>
              <div className="task-user-bubble" {...conversationInputAnchor(item.id)}><p>{item.text}</p></div>
            </article>
          ) : (
            // 回复大多撑出 320px，让我的气泡之间隔着大半屏。
            <article key={item.id} className="task-message" style={{ minHeight: item.short ? undefined : 320 }}>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
        <ConversationScrollControls scrollRef={scroll} resetKey="fixture" tailKey={tailKey} inputs={inputs} />
      </div>
      {/* 跟 SideDrawer 一样：普通的 aside，不是模态，只是从左边盖住会话。 */}
      {covered && (
        <aside style={{ position: "fixed", top: 0, left: 0, bottom: 0, width: 600, zIndex: 95, background: "white" }}>
          <button type="button" data-testid="uncover" onClick={() => setCovered(false)}>收起抽屉</button>
        </aside>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
