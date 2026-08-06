import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Task, TaskFollowUp } from "@harness/shared";
import { parseAttachmentText } from "@harness/shared/attachments";
import { Image as ImageIcon } from "@phosphor-icons/react";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import type { SidebarSpread } from "./useSidebarSpread.ts";

// 悬停多久才弹（扫列表时鼠标横穿一片行，立刻弹会一路闪），移开多久才收（留一段
// 时间让鼠标从格子挪到卡片上，否则卡片里的图点不到）。
const PEEK_DELAY = 160;
const PEEK_GRACE = 140;
const PEEK_MARGIN = 8;

type PeekKind = "body" | "last";
type Peek = { task: Task; kind: PeekKind; rect: DOMRect };

// 大图是盖在卡片上面的一层。它开着的时候卡片既不能被 Esc 收掉，也不能因为鼠标挪到
// 大图上（卡片会收到 mouseleave）就自己消失 —— 大图是卡片这棵子树里渲染的，卡片一卸载
// 它跟着一起没。
function lightboxOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

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

type Peeked = { title: string; subtitle: string; text: string; paths: string[] };

// 这一列只放**我自己**发的话（判据是 shared 的 isUserFollowUp，跟详情页 Inspector
// 那个「后续追问」列表同一份）：agent 说了什么、系统代发的继续提示，都不进来。
const NO_FOLLOW_UP = "还没追问过";

function peekContent(task: Task, kind: PeekKind, last: TaskFollowUp | undefined, known: boolean): Peeked {
  if (kind === "body") {
    const { body, paths } = parseAttachmentText(task.body ?? "");
    return { title: "原始需求", subtitle: task.title || "未命名任务", text: body || "这个任务没有写需求。", paths };
  }
  return {
    title: "后续追问",
    subtitle: last ? `我发的最新一条 · ${compactAge(last.at ?? task.updatedAt)}` : (known ? NO_FOLLOW_UP : "还没读到"),
    text: last?.text || (known ? "这个任务你还没有追问过 —— 只有原始需求。" : "还没读到这个任务的追问。"),
    paths: last?.attachments ?? [],
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
  const last = ctx.spread.followUps.get(task.id);
  // 没问过后端的行（比如别的项目）只留一个破折号，不能写「还没追问过」——那是在编。
  const known = ctx.spread.loaded.has(task.id);
  const { body, paths } = parseAttachmentText(task.body ?? "");
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
        {/* 没有列名行，列的含义只能靠内容自己认：这一格开头永远挂着「你说」，
            对面那一列（原始需求）是更淡的那一列。 */}
        {last && <em className="workspace-spread-who is-you">你说</em>}
        <p className={last ? "" : "is-empty"}>{last ? firstLine(last.text) : (known ? NO_FOLLOW_UP : "—")}</p>
        <ClipMark count={last?.attachments.length ?? 0} />
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
    if (lightboxOpen()) return;
    clear();
    showTimer.current = window.setTimeout(() => setPeek({ task, kind, rect: cell.getBoundingClientRect() }), PEEK_DELAY);
  }, [enabled]);

  const peekOut = useCallback(() => {
    if (showTimer.current) window.clearTimeout(showTimer.current);
    showTimer.current = null;
    const armHide = () => {
      hideTimer.current = window.setTimeout(() => {
        // 大图还开着就接着等 —— 此刻收卡片等于把用户正在看的那张图一起卸载掉。
        if (lightboxOpen()) { armHide(); return; }
        setPeek(null);
      }, PEEK_GRACE);
    };
    armHide();
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
  known,
  onHold,
  onLeave,
  onDismiss,
}: {
  peek: Peek;
  last: TaskFollowUp | undefined;
  known: boolean;
  onHold: () => void;
  onLeave: () => void;
  onDismiss: () => void;
}) {
  const card = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  const { title, subtitle, text, paths } = peekContent(peek.task, peek.kind, last, known);

  // 排进全局的浮层栈：Esc 一次只退一层，所以这张卡片开着时那一下 Esc 归它，
  // 收起铺开得再按一次。大图开着时让给大图 —— 它是压在卡片上面的那一层。
  useDismissable({ enabled: true, containerRef: card, onClose: () => { if (!lightboxOpen()) onDismiss(); } });

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

export function SpreadPeekLayer({ peek, spread, onHold, onLeave, onDismiss }: {
  peek: Peek | null;
  spread: SidebarSpread;
  onHold: () => void;
  onLeave: () => void;
  onDismiss: () => void;
}): ReactNode {
  if (!peek) return null;
  return (
    <SpreadPeekCard
      peek={peek}
      last={spread.followUps.get(peek.task.id)}
      known={spread.loaded.has(peek.task.id)}
      onHold={onHold}
      onLeave={onLeave}
      onDismiss={onDismiss}
    />
  );
}
