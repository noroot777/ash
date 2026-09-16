import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CornersIn, CornersOut } from "@phosphor-icons/react";
import { useDismissable } from "./useDismissable.ts";

// 「把中间这块内容铺开来看」的放大层，三处共用：审查里的分支 diff、文件全文、单文件 diff。
// 它们摆的是同一个位置（中间那一栏），放大的语义也该是同一个——铺满窗口、盖掉左边的任务
// 栏、右边让开 inspector（文件树/改动列表还要接着点）、Esc 退出。
//
// 放大层必须 portal 到 body：主工作区自己开了一个堆叠上下文（`sidebar-spread.css`），留在
// 原地的 z-index 只在它家里排座次，再大也盖不住左边的任务栏。层高从 92 起：压过所有页面
// 内容（≤90），但低于抽屉(95/96)、大图预览(220)、确认框(230)这些后开的浮层——放大着的
// 时候再弹什么，那个仍在最上面。
const ZOOM_BASE_Z = 92;

// 放大时要让开的，是贴着窗口右缘的那条 inspector——审查记录、文件树、改动列表都在里面，
// 盖住它等于把这一屏唯一的旁证也收走了。按「最靠右」找而不是顺着自己的 DOM 往上找：内容
// 有时长在团队的执行者抽屉里，那里面还嵌着一条自己的 inspector，让开它会在窗口中间掏个洞。
// 留 24px 的容差是必须的：`.workspace-shell` 右边有 8px 内边距，要求严丝合缝贴住窗口右缘
// 就一条都找不到，放大又会盖回 inspector 上去（第一版就是这么漏的）。
const RIGHT_EDGE_SLACK = 24;

function rightEdgeInspector(): HTMLElement | null {
  const hosts = [...document.querySelectorAll<HTMLElement>(".inspector-host")]
    .map((host) => ({ host, rect: host.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && window.innerWidth - rect.right <= RIGHT_EDGE_SLACK)
    .sort((a, b) => b.rect.right - a.rect.right);
  return hosts[0]?.host ?? null;
}

// 自己所在那一层有多高。执行者抽屉是 z-index 95，放大层固定 92 就会被它盖住，按钮看着
// 像坏了。只抬一档：抬过头会越过之后才打开的浮层，破坏「后开的在最上面」。
function enclosingLayerZ(from: Element): number {
  let top = 0;
  for (let node = from.parentElement; node; node = node.parentElement) {
    const z = Number.parseInt(window.getComputedStyle(node).zIndex, 10);
    if (Number.isFinite(z)) top = Math.max(top, z);
  }
  return top;
}

/**
 * 放大层的外壳。`render(content)` 在没放大时原样返回内容，放大时把它 portal 到 body。
 *
 * 开关状态由调用方持有：文件全文和单文件 diff 是同一块内容的两种读法，互切时放大不该掉，
 * 所以那两处的状态挂在 `useFileView` 上，而不是各自组件里。
 */
export function useZoomLayer({
  zoomed,
  onExit,
  label,
  className,
}: {
  zoomed: boolean;
  onExit: () => void;
  /** 读屏用的层名，写清楚放大的是哪一份东西。 */
  label: string;
  /** 各表面自己的样式钩子，用来让内容在放大层里撑满。 */
  className?: string;
}): { render: (content: ReactNode) => ReactNode } {
  // 留在原地的锚点：放大之后内容整棵被 portal 走了，没有它就再也问不到自己原本长在哪一
  // 层里（抽屉里那份必须抬到抽屉之上）。`hidden` 不占布局，只借它的祖先链。
  const anchor = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [gutter, setGutter] = useState(0);
  const [zoomZ, setZoomZ] = useState(ZOOM_BASE_Z);

  useLayoutEffect(() => {
    if (!zoomed || !anchor.current) return;
    setZoomZ(Math.max(ZOOM_BASE_Z, enclosingLayerZ(anchor.current) + 1));
  }, [zoomed]);

  // 右边的 inspector 不靠 z-index 而靠让地方：放大是「把内容铺开来看」，文件树、审查记录
  // 得留在旁边继续点。层宽只到它的左缘，拖宽 inspector 时跟着变。
  useLayoutEffect(() => {
    const host = zoomed ? rightEdgeInspector() : null;
    if (!host) {
      setGutter(0);
      return;
    }
    // 量左缘而不是宽度：右边留白、边框怎么算都不用管，让开的正好是它占的那块。
    const sync = () => setGutter(Math.max(0, window.innerWidth - host.getBoundingClientRect().left));
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [zoomed]);

  // 关闭交给 useDismissable：它按打开顺序记一摞，Esc 一次只退最上面那一层，所以放大态下
  // 开的确认框先吃 Esc，再按一次才退出放大。不吃「点外面」——放大态下点得到的外面只有
  // inspector，那是留着给人用的，点一下就把放大收了才是意外。
  useDismissable({ enabled: zoomed, containerRef: box, onClose: onExit, closeOnOutside: false });

  const render = (content: ReactNode) => (
    <>
      <span ref={anchor} hidden />
      {zoomed
        ? createPortal(
          // 不是 aria-modal：右边的 inspector 仍然可读可点，声明成模态会让读屏把它当成不存在。
          <div
            className={className ? `zoom-layer ${className}` : "zoom-layer"}
            ref={box}
            style={{ right: gutter, zIndex: zoomZ }}
            role="dialog"
            aria-label={label}
          >
            {content}
          </div>,
          document.body,
        )
        : content}
    </>
  );

  return { render };
}

/** 放大 / 退出放大的那颗按钮。样式跟着所在标题栏走，文案和图标三处保持一致。 */
export function ZoomToggle({
  zoomed,
  onToggle,
  className,
}: {
  zoomed: boolean;
  onToggle: () => void;
  className: string;
}) {
  return (
    <button type="button" className={className} aria-pressed={zoomed} onClick={onToggle}>
      {zoomed
        ? <><CornersIn size={13} aria-hidden="true" />退出放大 · Esc</>
        : <><CornersOut size={13} aria-hidden="true" />放大</>}
    </button>
  );
}
