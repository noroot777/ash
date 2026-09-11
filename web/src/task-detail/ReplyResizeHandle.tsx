import { useCallback, useRef, useState, type RefObject } from "react";
import { readRenamedStorage } from "../lib/renamedStorage.ts";

/**
 * 一个回复框一套:拖出来的高度存在哪、这个框最矮能到多少(跟各自 CSS 里的
 * `min-height` 对齐)。普通任务和团队调度台各记各的——两个框本来就不一样高,
 * 共用一个值会让其中一边一打开就是另一边拖出来的样子。
 */
export type ReplyPin = { storageKey: string; minHeight: number };
export const SINGLE_REPLY_PIN: ReplyPin = { storageKey: "ash:reply-pin-height", minHeight: 58 };
export const TEAM_REPLY_PIN: ReplyPin = { storageKey: "ash:team-reply-pin-height", minHeight: 44 };
// 自动撑高上线前那把旧钥匙:里面存的高度会把「跟着行数长」整个盖住(拖过的高度优先),
// 所以只清不读——想固定高度再拖一次就是了,代价比「新功能看着像没生效」小得多。
const LEGACY_HEIGHT_KEY = "ash:reply-height";
const DEFAULT_MIN_HEIGHT = SINGLE_REPLY_PIN.minHeight;

/** 上限跟着窗口走:再怎么拖也要给上面的会话留出地方。 */
function maximumHeight(minHeight: number): number {
  return Math.max(minHeight, Math.min(560, window.innerHeight - 260));
}

export function clampReplyHeight(value: number, minHeight = DEFAULT_MIN_HEIGHT): number {
  return Math.max(minHeight, Math.min(maximumHeight(minHeight), Math.round(value)));
}

/** null = 没拖过,跟着输入的行数自动撑高。别在这里塞一个写死的默认值。 */
function readStoredHeight({ storageKey, minHeight }: ReplyPin): number | null {
  if (storageKey === SINGLE_REPLY_PIN.storageKey) {
    window.localStorage.removeItem(LEGACY_HEIGHT_KEY);
    window.localStorage.removeItem(`harness-next:${LEGACY_HEIGHT_KEY.slice("ash:".length)}`);
  }
  const stored = Number(readRenamedStorage(storageKey));
  return Number.isFinite(stored) && stored > 0 ? clampReplyHeight(stored, minHeight) : null;
}

/**
 * 「这个回复框拖到多高」这件事的全部状态:读盘、写盘,以及喂给
 * `useAutoGrowTextarea` 的 `pinned`。返回值原样摊给 `ReplyResizeHandle` 即可。
 */
export function useReplyHeight(pin: ReplyPin): {
  height: number | null;
  minHeight: number;
  onChange: (height: number | null) => void;
} {
  const [height, setHeight] = useState<number | null>(() => readStoredHeight(pin));
  const { storageKey, minHeight } = pin;
  const onChange = useCallback((next: number | null) => {
    setHeight(next);
    if (next === null) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, String(next));
  }, [storageKey]);
  return { height, minHeight, onChange };
}

/**
 * 对话框顶边的拖动条:往上拖把回复框拉高,双击回到「跟着输入行数自动撑高」。
 * 拖出来的高度不受自动撑高那个上限约束(那条只管自动长到多高),这里只受窗口留白的约束。
 * 交互沿用工作区里已有的那套(侧边栏、CLI 抽屉):指针按下后把监听挂到 window 上,
 * 拖出元素范围也不断线。
 */
export function ReplyResizeHandle({
  targetRef,
  height,
  minHeight = DEFAULT_MIN_HEIGHT,
  onChange,
}: {
  targetRef: RefObject<HTMLTextAreaElement | null>;
  height: number | null;
  minHeight?: number;
  onChange: (height: number | null) => void;
}) {
  const dragging = useRef(false);

  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // 起始高度按实测取:没拖过时 height 是 null,只有 DOM 知道 rows 撑出来多高。
    const startHeight = targetRef.current?.offsetHeight ?? minHeight;
    const startY = event.clientY;
    dragging.current = true;
    document.body.classList.add("task-reply-resizing");
    const move = (next: PointerEvent) => onChange(clampReplyHeight(startHeight + startY - next.clientY, minHeight));
    const finish = () => {
      dragging.current = false;
      document.body.classList.remove("task-reply-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  const nudge = (delta: number) => {
    const from = height ?? targetRef.current?.offsetHeight ?? minHeight;
    onChange(clampReplyHeight(from + delta, minHeight));
  };

  return (
    <div
      className="task-reply-resize"
      role="separator"
      tabIndex={0}
      aria-label="拖动调整回复框高度，双击恢复按输入行数自动撑高"
      aria-orientation="horizontal"
      aria-valuemin={minHeight}
      aria-valuemax={maximumHeight(minHeight)}
      {...(height === null ? {} : { "aria-valuenow": height })}
      onPointerDown={begin}
      onDoubleClick={() => onChange(null)}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") nudge(10);
        else if (event.key === "ArrowDown") nudge(-10);
        else if (event.key === "Home") onChange(minHeight);
        else if (event.key === "End") onChange(maximumHeight(minHeight));
        else return;
        event.preventDefault();
      }}
    />
  );
}
