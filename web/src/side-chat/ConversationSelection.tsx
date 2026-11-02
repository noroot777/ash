import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Chats, NotePencil, Quotes } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { selectionContentText } from "./selectionContent.ts";
import { stageSideChatQuote } from "./sideChatQuote.ts";
import "./conversation-selection.css";

/* 存的是**当场取好的文本**而不是选区：选区是活的，正文还在流式刷新的那一下文本节点会被
   整个换掉，留下来的 `cloneRange()` 当场塌成空的 —— 浮条还在，按下去却什么都没有。 */
type Selected = { text: string; left: number; top: number };
const controls = "button, input, textarea, select, [contenteditable]:not([contenteditable=false])";
const elementOf = (node: Node) => node instanceof Element ? node : node.parentElement;

/** 两段选区首尾完全重合。用来认「这一段算过了」，比存一份序列化便宜。 */
function sameBounds(range: Range, bounds: Range): boolean {
  try {
    return range.compareBoundaryPoints(Range.START_TO_START, bounds) === 0
      && range.compareBoundaryPoints(Range.END_TO_END, bounds) === 0;
  } catch {
    // 边界节点已经被换掉了（流式刷新），两段没法比 —— 当成变了，重算一次。
    return false;
  }
}

export function ConversationSelection({ taskId, onAsk, onAddToReply, onAddToMemo, children }: {
  taskId: string;
  /** 不传 = 这一页没有侧聊那一格（团队调度台就没有），浮条上就不出现「在侧聊中提问」。 */
  onAsk?: () => void;
  /** 不传 = 这个任务没有可用的对话框（比如已交接出去），浮条上就不出现「添加到对话」。 */
  onAddToReply?: (text: string) => void;
  /**
   * 选中这段存进任务备忘（不传就不出这颗按钮）。跟前两颗的分界：那两颗都是「把这段话
   * 再说给某个 agent 听」，这颗是「留给我自己回头看」，不进任何 prompt。
   */
  onAddToMemo?: (text: string) => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  // 按钮按下去要兑现的那段文本。state 之外另记一份：onClick 读它时等不了 state 提交。
  const picked = useRef<Selected | null>(null);
  const commit = (next: Selected | null) => {
    picked.current = next;
    setSelected(next);
  };
  /**
   * **已经算过的那一段选区**，只用来认「这一段算过了」—— 跟浮条该不该显示是两件事，不能
   * 共用一份状态。取文要借用当前选区读排版（见 selectionContent.ts），还原的那一下又是
   * 一次 selectionchange；算出来没有正文时浮条确实撤掉了，但边界要是跟着一起忘掉，那次
   * 还原回来就认不出「算过了」，于是每一帧都重算同一段选区 —— 浮条没出来，底下却一直在
   * 转（审查实测 1.1 秒 66 次）。所以记边界这件事不看算出来有没有正文。
   */
  const seen = useRef<Range | null>(null);
  /** 放弃这一段：浮条撤掉，边界也忘掉（下次再选中它要能重新算一遍）。 */
  const forget = () => {
    seen.current = null;
    commit(null);
  };
  // 浮条实际有多宽取决于按钮个数和文案，量出来再贴边，别拿常数猜（猜小了会被右边缘切掉）。
  const [left, setLeft] = useState(8);
  useDismissable({ enabled: !!selected, containerRef: toolbar, onClose: forget });

  useEffect(() => {
    forget();
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (toolbar.current?.contains(document.activeElement)) return;
        if (document.activeElement?.matches("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return forget();
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return forget();
        const range = selection.getRangeAt(0);
        // 这一段算过了就收手 —— 底下取文会借用选区再还原，还原本身又触发一次事件。
        if (seen.current && sameBounds(range, seen.current)) return;
        const scope = root.current;
        if (!scope?.contains(range.startContainer) || !scope.contains(range.endContainer)
          || elementOf(range.startContainer)?.closest(controls) || elementOf(range.endContainer)?.closest(controls)
          || range.cloneContents().querySelector("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return forget();
        const rect = range.getBoundingClientRect();
        if ((!rect.width && !rect.height) || rect.bottom < 0 || rect.top > innerHeight) return forget();
        // 下面这一下会借用当前选区（上面那些早退都不借，所以只有到这儿才需要记）。边界先
        // 记下来，取出来有没有正文都认它 —— 还原触发的那次事件靠它收口。
        seen.current = range.cloneRange();
        // 浮条只问「剔掉界面装置之后还剩不剩正文」—— 扫过的装置不算内容，光选中一条
        // 「执行过程 · 6 工具」不该出按钮。全是空白也算没有：存进备忘的时候才说「内容不能
        // 为空」太晚了（取到的文本仍原样留着，行内缩进是正文自己的）。
        const text = selectionContentText(range, scope);
        if (!text.trim()) return commit(null);
        const last = Array.from(range.getClientRects()).filter((box) => box.width && box.height).at(-1) ?? rect;
        commit({
          text,
          left: Math.max(8, last.left),
          top: Math.max(8, Math.min(last.bottom + 8, innerHeight - 48)),
        });
      });
    };
    const dismiss = () => { cancelAnimationFrame(frame); forget(); };
    const afterPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) update();
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerup", afterPointer);
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerup", afterPointer);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, [taskId]);

  // 量宽度要在浏览器画之前做完（useLayoutEffect），否则第一帧会先闪一下没贴边的位置。
  useLayoutEffect(() => {
    if (!selected) return;
    const width = toolbar.current?.offsetWidth ?? 0;
    setLeft(Math.max(8, Math.min(selected.left, innerWidth - width - 8)));
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const focusAction = (event: KeyboardEvent) => {
      if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
        && !toolbar.current?.contains(document.activeElement)) {
        event.preventDefault();
        toolbar.current?.querySelector("button")?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", focusAction);
    return () => document.removeEventListener("keydown", focusAction);
  }, [selected]);

  const take = (use: (text: string) => void) => () => {
    const text = picked.current?.text ?? "";
    // forget 而不是 commit(null)：这一段用掉了，边界也别留着 —— 不然用户紧接着重新选中
    // **同一段**时会被当成「算过了」，浮条再也不出来。
    forget();
    window.getSelection()?.removeAllRanges();
    if (text) use(text);
  };

  return <div className="conversation-selection-scope" ref={root}>
    {children}
    {selected && createPortal(<div className="conversation-selection-action" ref={toolbar} style={{ left, top: selected.top }}>
      {onAddToReply && <button type="button" onPointerDown={(event) => event.preventDefault()}
        onClick={take(onAddToReply)}><Quotes size={13} />添加到对话</button>}
      {onAsk && <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={take((text) => {
        stageSideChatQuote(taskId, text);
        onAsk();
      })}><Chats size={13} />在侧聊中提问</button>}
      {onAddToMemo && <button type="button" onPointerDown={(event) => event.preventDefault()}
        onClick={take(onAddToMemo)}><NotePencil size={13} />添加到备忘</button>}
    </div>, document.body)}
  </div>;
}
