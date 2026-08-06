import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Task, TaskLastMessage } from "@harness/shared";
import { parseAttachmentText } from "@harness/shared/attachments";
import { Image as ImageIcon } from "@phosphor-icons/react";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import type { SidebarSpread } from "./useSidebarSpread.ts";

// 悬停多久才弹（扫列表时鼠标横穿一片行，立刻弹会一路闪），移开多久才收（留一段
// 时间让鼠标从格子挪到卡片上，否则卡片里的图点不到）。
const PEEK_DELAY = 160;
const PEEK_GRACE = 140;
const PEEK_MARGIN = 8;

type PeekKind = "body" | "last";
type Peek = { task: Task; kind: PeekKind; rect: DOMRect };

export type SpreadRowContext = {
  spread: SidebarSpread;
  peekAt: (task: Task, kind: PeekKind, cell: HTMLElement) => void;
  peekOut: () => void;
};

const SpreadRowCtx = createContext<SpreadRowContext | null>(null);
export const SpreadRowProvider = SpreadRowCtx.Provider;
export function useSpreadRow(): SpreadRowContext | null {
  return useContext(SpreadRowCtx);
}

// 76px 一格，只够放个约数：跟旁边两列比，这一列回答的是「这事儿凉了多久」，
// 不是「几点几分」——要精确时间去详情页看。
export function compactAge(at?: string | null): string {
  const ms = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(ms)) return "—";
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

type Speaker = { label: string; tone: "" | "ask" | "you" };

// 删掉了「走到哪一步」那一列，所以列的含义只能靠内容自己认：最后一条消息前面
// 永远挂着说话人，原始需求是更淡的那一列。
function speakerOf(task: Task, last: TaskLastMessage | undefined): Speaker {
  if (task.question) return { label: "它问你", tone: "ask" };
  if (!last) return { label: "", tone: "" };
  if (last.who === "user") return { label: "你说", tone: "you" };
  if (last.who === "system") return { label: "系统", tone: "" };
  return { label: "它说", tone: "" };
}

type Peeked = { title: string; subtitle: string; text: string; paths: string[] };

function peekContent(task: Task, kind: PeekKind, last: TaskLastMessage | undefined): Peeked {
  if (kind === "body") {
    const { body, paths } = parseAttachmentText(task.body ?? "");
    return { title: "原始需求", subtitle: task.title || "未命名任务", text: body || "这个任务没有写需求。", paths };
  }
  const speaker = speakerOf(task, last);
  const text = task.question || last?.text || "";
  return {
    title: "最后一条消息",
    subtitle: `${speaker.label || "还没有消息"} · ${compactAge(task.question ? task.updatedAt : last?.at ?? task.updatedAt)}`,
    text: text || "这个任务还没有任何消息。",
    paths: task.question ? [] : last?.attachments ?? [],
  };
}

function ClipMark({ count }: { count: number }) {
  if (!count) return null;
  return (
    <i className="workspace-spread-clip" aria-label={`${count} 个附件`}>
      <ImageIcon size={10} weight="bold" aria-hidden="true" />
      {count}
    </i>
  );
}

// 铺开后每一行右边多出来的三格。窄态不渲染，宽态由 CSS 的列模板给出宽度；
// 行高仍然是 34px，上方也不新增任何一行 —— 铺开是「露出右边」，不是「重排」。
export function SpreadRowCells({ task, ctx, onOpen }: { task: Task; ctx: SpreadRowContext; onOpen: () => void }) {
  const last = ctx.spread.lastMessages.get(task.id);
  // 没问过后端的行（比如别的项目）只留一个破折号，不能写「还没有消息」——那是在编。
  const known = ctx.spread.loaded.has(task.id) || Boolean(task.question);
  const { body, paths } = parseAttachmentText(task.body ?? "");
  const speaker = speakerOf(task, last);
  const lastText = task.question || last?.text || "";
  const lastPaths = task.question ? [] : last?.attachments ?? [];
  const cell = (kind: PeekKind) => ({
    onClick: onOpen,
    onMouseEnter: (event: MouseEvent<HTMLSpanElement>) => ctx.peekAt(task, kind, event.currentTarget),
    onMouseLeave: ctx.peekOut,
  });
  return (
    <>
      <span className="workspace-spread-cell workspace-spread-cell--body" {...cell("body")}>
        <p>{firstLine(body) || "—"}</p>
        <ClipMark count={paths.length} />
      </span>
      <span className="workspace-spread-cell workspace-spread-cell--last" {...cell("last")}>
        {speaker.label && <em className={`workspace-spread-who${speaker.tone ? ` is-${speaker.tone}` : ""}`}>{speaker.label}</em>}
        <p className={lastText ? "" : "is-empty"}>{firstLine(lastText) || (known ? "还没有消息" : "—")}</p>
        <ClipMark count={lastPaths.length} />
      </span>
      <span className="workspace-spread-cell workspace-spread-cell--time" onClick={onOpen}>{compactAge(task.updatedAt)}</span>
    </>
  );
}

// 悬浮全文卡片。position:fixed，跟列表布局互不相干 —— 弹出来一行都不会动。
export function useSpreadPeek(enabled: boolean) {
  const [peek, setPeek] = useState<Peek | null>(null);
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const clear = () => {
    if (showTimer.current) window.clearTimeout(showTimer.current);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    showTimer.current = hideTimer.current = null;
  };

  const peekAt = useCallback((task: Task, kind: PeekKind, cell: HTMLElement) => {
    if (!enabled) return;
    // 大图开着的时候不弹：卡片会藏在遮罩背后偷偷占着焦点。
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    clear();
    showTimer.current = window.setTimeout(() => setPeek({ task, kind, rect: cell.getBoundingClientRect() }), PEEK_DELAY);
  }, [enabled]);

  const peekOut = useCallback(() => {
    if (showTimer.current) window.clearTimeout(showTimer.current);
    showTimer.current = null;
    hideTimer.current = window.setTimeout(() => setPeek(null), PEEK_GRACE);
  }, []);

  const hold = useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }, []);

  const hide = useCallback(() => { clear(); setPeek(null); }, []);
  useEffect(() => { if (!enabled) hide(); }, [enabled, hide]);
  useEffect(() => clear, []);
  return { peek, peekAt, peekOut, hold, hide };
}

export function SpreadPeekCard({
  peek,
  last,
  onHold,
  onLeave,
}: {
  peek: Peek;
  last: TaskLastMessage | undefined;
  onHold: () => void;
  onLeave: () => void;
}) {
  const card = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  const { title, subtitle, text, paths } = peekContent(peek.task, peek.kind, last);

  // 先落地再量：卡片多高取决于文字多长，量不到就没法决定往下弹还是往上弹。
  useEffect(() => {
    const node = card.current;
    if (!node) return;
    const size = node.getBoundingClientRect();
    const maxLeft = Math.max(PEEK_MARGIN, window.innerWidth - size.width - PEEK_MARGIN);
    const left = Math.min(Math.max(peek.rect.left - 12, PEEK_MARGIN), maxLeft);
    const below = peek.rect.bottom + 8;
    const top = below + size.height > window.innerHeight - PEEK_MARGIN
      ? Math.max(PEEK_MARGIN, peek.rect.top - size.height - 8)
      : below;
    setPlaced({ left: Math.round(left), top: Math.round(top) });
  }, [peek]);

  return createPortal(
    <div
      ref={card}
      className="workspace-spread-peek"
      role="tooltip"
      style={{ left: placed?.left ?? peek.rect.left, top: placed?.top ?? peek.rect.bottom + 8, visibility: placed ? "visible" : "hidden" }}
      onMouseEnter={onHold}
      onMouseLeave={onLeave}
    >
      <div className="workspace-spread-peek-head">
        <b>{title}</b>
        <span>{subtitle}</span>
      </div>
      <p>{text}</p>
      {paths.length > 0 && (
        <>
          <MessageAttachments paths={paths} />
          <div className="workspace-spread-peek-tip">点图看大图 · <kbd>←</kbd><kbd>→</kbd> 翻页 · <kbd>Esc</kbd> 关</div>
        </>
      )}
    </div>,
    document.body,
  );
}

export function SpreadPeekLayer({ peek, spread, onHold, onLeave }: {
  peek: Peek | null;
  spread: SidebarSpread;
  onHold: () => void;
  onLeave: () => void;
}): ReactNode {
  if (!peek) return null;
  return <SpreadPeekCard peek={peek} last={spread.lastMessages.get(peek.task.id)} onHold={onHold} onLeave={onLeave} />;
}
