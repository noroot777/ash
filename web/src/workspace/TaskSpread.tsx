import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { TaskFollowUp, TaskListItem } from "@ash/shared";
import type { TaskMemoDigest } from "@ash/shared/task-memo";
import { memoIsNewer } from "@ash/shared/task-memo";
import { parseAttachmentText } from "@ash/shared/attachments";
import { Image as ImageIcon, NotePencil } from "@phosphor-icons/react";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import type { SidebarSpread } from "./useSidebarSpread.ts";

// 悬停多久才弹（扫列表时鼠标横穿一片行，立刻弹会一路闪），移开多久才收（留一段
// 时间让鼠标从格子挪到卡片上，否则卡片里的图点不到）。
const PEEK_DELAY = 160;
const PEEK_GRACE = 140;
const PEEK_MARGIN = 8;

type PeekKind = "body" | "last";
type Peek = { task: TaskListItem; kind: PeekKind; rect: DOMRect };

// 大图是盖在卡片上面的一层。它开着的时候卡片既不能被 Esc 收掉，也不能因为鼠标挪到
// 大图上（卡片会收到 mouseleave）就自己消失 —— 大图是卡片这棵子树里渲染的，卡片一卸载
// 它跟着一起没。
function lightboxOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

export type SpreadRowContext = {
  spread: SidebarSpread;
  peekAt: (task: TaskListItem, kind: PeekKind, cell: HTMLElement) => void;
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

/**
 * 追问那一格此刻该显示哪一样（用户 2026-10-28：「哪个的日期新就显示哪个」）。
 *
 * 追问的时间可能缺（老会话没写围栏），显示上一直是拿任务的 updatedAt 兜底的，比新旧也用
 * 同一份兜底——否则一条没时间戳的追问会被任何一条备忘无条件顶掉。
 */
function followUpInstant(task: TaskListItem, last: TaskFollowUp | undefined): string | null {
  return last ? last.at ?? task.updatedAt : null;
}

/**
 * `known` = 这个任务的追问**问过后端**。追问那一列只读头一批（每条都要摸一次盘），所以
 * 第 TASK_BATCH_LIMIT 行之后的行里 `last === undefined` 的含义是「不知道」而不是「没有」。
 * 那种行上比不出新旧：有备忘就显示备忘（取到了却画一个破折号更差），但那一格**不等于
 * 「备忘比追问新」** —— 悬浮卡里会把这个限定说出来（第 2 轮审查 N2）。
 */
function memoWins(
  task: TaskListItem,
  last: TaskFollowUp | undefined,
  memo: TaskMemoDigest | undefined,
  known: boolean,
): boolean {
  if (!memo) return false;
  if (!known) return true;
  return memoIsNewer(memo.at, followUpInstant(task, last));
}

// 这一列只放**我自己**发的话（判据是 shared 的 isUserFollowUp，跟详情页 Inspector
// 那个「后续追问」列表同一份）：agent 说了什么、系统代发的继续提示，都不进来。
const NO_FOLLOW_UP = "还没追问过";

// raw 是这个任务的正文，undefined = 还没从后端读到（列表接口不带正文）。跟追问那一列
// 同一条规矩：没读到就说没读到，不能写成「这个任务没有写需求」——那是在编。
function peekContent(
  task: TaskListItem,
  kind: PeekKind,
  last: TaskFollowUp | undefined,
  known: boolean,
  raw: string | undefined,
): Peeked {
  if (kind === "body") {
    const { body, paths } = parseAttachmentText(raw ?? "");
    const text = raw === undefined ? "还没读到这个任务的需求。" : (body || "这个任务没有写需求。");
    return { title: "原始需求", subtitle: task.title || "未命名任务", text, paths };
  }
  return {
    title: "后续追问",
    subtitle: last ? `我发的最新一条 · ${compactAge(last.at ?? task.updatedAt)}` : (known ? NO_FOLLOW_UP : "还没读到"),
    text: last?.text || (known ? "这个任务你还没有追问过 —— 只有原始需求。" : "还没读到这个任务的追问。"),
    paths: last?.attachments ?? [],
  };
}

// 备忘不止一条时在右端标一下：这一格只放得下最新那条，不标的话「还有别的」这件事
// 只有把鼠标停上去才知道。
function MemoMark({ count }: { count: number }) {
  if (count < 2) return null;
  return (
    <i className="workspace-spread-clip" aria-label={`共 ${count} 条备忘`}>
      <NotePencil size={10} weight="bold" aria-hidden="true" />
      {count}
    </i>
  );
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
export function SpreadRowCells({ task, ctx, onOpen }: { task: TaskListItem; ctx: SpreadRowContext; onOpen: () => void }) {
  const last = ctx.spread.followUps.get(task.id);
  const memo = ctx.spread.memos.get(task.id);
  // 没问过后端的行（比如别的项目）只留一个破折号，不能写「还没追问过」——那是在编。
  const known = ctx.spread.loaded.has(task.id);
  // 存成「要显示的那条备忘」而不是一个布尔：JSX 里直接用它，省掉一次非空断言。
  const showMemo = memoWins(task, last, memo, known) ? memo : undefined;
  const { body, paths } = parseAttachmentText(ctx.spread.bodies.get(task.id) ?? "");
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
        {/* 没有列名行，列的含义只能靠内容自己认：这一格开头挂着一个来源标，
            「你说」= 我发的追问，「备忘」= 我自己记的那条；对面那一列（原始需求）是更淡的那一列。
            两样都有时**显示新的那条**，另一样仍在悬浮卡里（用户 2026-10-28）。 */}
        {showMemo
          ? <em className="workspace-spread-who is-memo">备忘</em>
          : last && <em className="workspace-spread-who is-you">你说</em>}
        {showMemo
          ? <p>{firstLine(showMemo.text)}</p>
          : <p className={last ? "" : "is-empty"}>{last ? firstLine(last.text) : (known ? NO_FOLLOW_UP : "—")}</p>}
        {showMemo ? <MemoMark count={showMemo.count} /> : <ClipMark count={last?.attachments.length ?? 0} />}
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

  const peekAt = useCallback((task: TaskListItem, kind: PeekKind, cell: HTMLElement) => {
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
  memo,
  known,
  body,
  onHold,
  onLeave,
  onDismiss,
}: {
  peek: Peek;
  last: TaskFollowUp | undefined;
  /** 最近更新的那条备忘；undefined = 这个任务没有备忘（或者这一批没问过）。 */
  memo: TaskMemoDigest | undefined;
  known: boolean;
  /** 正文；undefined = 还没读到。 */
  body: string | undefined;
  onHold: () => void;
  onLeave: () => void;
  onDismiss: () => void;
}) {
  const card = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  const { title, subtitle, text, paths } = peekContent(peek.task, peek.kind, last, known, body);

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
      {/* 备忘排在追问**下面**（用户 2026-10-28 指定的位置）：两样都在这一张卡里，谁新
          只决定外面那一格显示哪条，不决定这里的先后 —— 先后固定，读起来才不会每次都变。 */}
      {peek.kind === "last" && memo && (
        <div className="workspace-spread-peek-memo">
          <div className="workspace-spread-peek-head">
            <b>备忘</b>
            <span>{memo.count > 1 ? `共 ${memo.count} 条 · 最近 ${compactAge(memo.at)}` : `只有这一条 · ${compactAge(memo.at)}`}</span>
          </div>
          <p>{memo.text}</p>
          {/* 追问还没读到的那些行（只读头一批）：外面那一格显示的是备忘，但那不是
              「它更新」的结论 —— 没读到的东西不能拿来比（第 2 轮审查 N2）。 */}
          {!known && <p className="workspace-spread-peek-caveat">这个任务的追问还没读到，所以不确定哪一条更新。</p>}
        </div>
      )}
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
      memo={spread.memos.get(peek.task.id)}
      known={spread.loaded.has(peek.task.id)}
      body={spread.bodies.get(peek.task.id)}
      onHold={onHold}
      onLeave={onLeave}
      onDismiss={onDismiss}
    />
  );
}
