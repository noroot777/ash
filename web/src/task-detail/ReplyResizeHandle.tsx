import { useRef, type RefObject } from "react";
import { readRenamedStorage } from "../lib/renamedStorage.ts";

const REPLY_HEIGHT_KEY = "ash:reply-pin-height";
// 自动撑高上线前那把旧钥匙:里面存的高度会把「跟着行数长」整个盖住(拖过的高度优先),
// 所以只清不读——想固定高度再拖一次就是了,代价比「新功能看着像没生效」小得多。
const LEGACY_HEIGHT_KEY = "ash:reply-height";
const MIN_HEIGHT = 58;

/** 上限跟着窗口走:再怎么拖也要给上面的会话留出地方。 */
function maximumHeight(): number {
  return Math.max(MIN_HEIGHT, Math.min(560, window.innerHeight - 260));
}

export function clampReplyHeight(value: number): number {
  return Math.max(MIN_HEIGHT, Math.min(maximumHeight(), Math.round(value)));
}

/** null = 没拖过,跟着输入的行数自动撑高。别在这里塞一个写死的默认值。 */
export function readStoredReplyHeight(): number | null {
  window.localStorage.removeItem(LEGACY_HEIGHT_KEY);
  window.localStorage.removeItem(`harness-next:${LEGACY_HEIGHT_KEY.slice("ash:".length)}`);
  const stored = Number(readRenamedStorage(REPLY_HEIGHT_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampReplyHeight(stored) : null;
}

export function storeReplyHeight(height: number | null): void {
  if (height === null) window.localStorage.removeItem(REPLY_HEIGHT_KEY);
  else window.localStorage.setItem(REPLY_HEIGHT_KEY, String(height));
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
  onChange,
}: {
  targetRef: RefObject<HTMLTextAreaElement | null>;
  height: number | null;
  onChange: (height: number | null) => void;
}) {
  const dragging = useRef(false);

  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // 起始高度按实测取:没拖过时 height 是 null,只有 DOM 知道 rows 撑出来多高。
    const startHeight = targetRef.current?.offsetHeight ?? MIN_HEIGHT;
    const startY = event.clientY;
    dragging.current = true;
    document.body.classList.add("task-reply-resizing");
    const move = (next: PointerEvent) => onChange(clampReplyHeight(startHeight + startY - next.clientY));
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
    const from = height ?? targetRef.current?.offsetHeight ?? MIN_HEIGHT;
    onChange(clampReplyHeight(from + delta));
  };

  return (
    <div
      className="task-reply-resize"
      role="separator"
      tabIndex={0}
      aria-label="拖动调整回复框高度，双击恢复按输入行数自动撑高"
      aria-orientation="horizontal"
      aria-valuemin={MIN_HEIGHT}
      aria-valuemax={maximumHeight()}
      {...(height === null ? {} : { "aria-valuenow": height })}
      onPointerDown={begin}
      onDoubleClick={() => onChange(null)}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") nudge(10);
        else if (event.key === "ArrowDown") nudge(-10);
        else if (event.key === "Home") onChange(MIN_HEIGHT);
        else if (event.key === "End") onChange(maximumHeight());
        else return;
        event.preventDefault();
      }}
    />
  );
}
