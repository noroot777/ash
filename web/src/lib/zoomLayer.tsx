import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CornersIn, CornersOut } from "@phosphor-icons/react";
import { useDismissable } from "./useDismissable.ts";

// 「把中间这块内容铺开来看」的放大层，三处共用：审查里的分支 diff、文件全文、单文件 diff。
// 它们摆的是同一个位置（中间那一栏），放大的语义也该是同一个——铺满工作区、盖掉左边的任务
// 栏、右边让开 inspector（文件树/改动列表还要接着点）、底下让开终端和全局状态栏、Esc 退出。
//
// 放大层必须 portal 到 body：主工作区自己开了一个堆叠上下文（`sidebar-spread.css`），留在
// 原地的 z-index 只在它家里排座次，再大也盖不住左边的任务栏。层高从 92 起：压过所有页面
// 内容（≤90），但低于抽屉(95/96)、大图预览(220)、确认框(230)这些后开的浮层——放大着的
// 时候再弹什么，那个仍在最上面。
const ZOOM_BASE_Z = 92;

// 放大时要让开的，是贴着窗口右缘的那条 inspector——审查记录、文件树、改动列表都在里面，
// 盖住它等于把这一屏唯一的旁证也收走了。按「最靠右」找而不是顺着自己的 DOM 往上找：内容
// 有时长在团队的执行者抽屉里，那里面还嵌着一条自己的 inspector，让开它会在窗口中间掏个洞。
// 一条都没有（面板被一个个关光了）就不让位，铺满整块可用宽度。
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

// inspector 整条是条件渲染的（`InspectorHost.tsx`：最后一个页签关掉 → `activeDescriptor`
// 为空 → 整个 `<aside>` 不渲染），它的来去只有 DOM 结构看得见，没有尺寸事件可听。所以除了
// 盯尺寸，还得盯结构——但页面上绝大多数增删（终端刷行、任务列表更新）跟它无关，为那些白量
// 一次布局会让放大着的大份 diff 跟着卡，先筛一遍再说。
function touchesInspector(record: MutationRecord): boolean {
  const changed = [...record.addedNodes, ...record.removedNodes];
  return changed.some((node) => (
    node instanceof HTMLElement
    && (node.classList.contains("inspector-host") || node.querySelector(".inspector-host") !== null)
  ));
}

// 底下那条横贯窗口的坞（终端 + 全局状态栏）是 app 级的东西，放大一份文件不该把它们收走：
// 状态栏上的项目、终端开关和连接灯照样要看得见、点得到。它们跟工作区同在
// `.workspace-system-layout` 的网格里、排在工作区下面，所以层的下缘就是工作区那一行的下缘
// ——终端开合、拖高都只是把这一行挤矮，量它一处就全跟上了。
function workspaceRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".workspace-system-layout > .workspace-shell");
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
  const [inset, setInset] = useState({ right: 0, bottom: 0 });
  const [zoomZ, setZoomZ] = useState(ZOOM_BASE_Z);

  useLayoutEffect(() => {
    if (!zoomed || !anchor.current) return;
    setZoomZ(Math.max(ZOOM_BASE_Z, enclosingLayerZ(anchor.current) + 1));
  }, [zoomed]);

  // 右边的 inspector、底下的坞都不靠 z-index 而靠让地方：放大是「把内容铺开来看」，文件树、
  // 审查记录得留在旁边继续点，状态栏和终端也还在原地。层宽只到 inspector 的左缘、层底只到
  // 工作区那一行的下缘，拖宽 inspector、开合终端时跟着变。
  useLayoutEffect(() => {
    if (!zoomed) {
      setInset({ right: 0, bottom: 0 });
      return;
    }
    // 每次测量都重新问一遍「现在贴着右缘的 inspector 是谁」，而不是进放大态时捕获一次：
    // 面板是一个个关掉的，关掉最后一个时整条 `.inspector-host` 从 DOM 里消失。捕获节点再
    // 反复量它，卸载后 `getBoundingClientRect()` 全是 0——left 读成 0，右缘就被算成整个
    // 视口宽，放大层当场挤成左缘一条细条（只剩 padding，文字一字一行竖排）。重新查询拿回
    // 来的必然是此刻仍连在文档里的那个，没有就是真没有，right 归 0 铺满可用宽度。
    let watched: HTMLElement[] = [];
    let sizes: ResizeObserver | null = null;

    // 量边缘而不是宽高：右边留白、边框怎么算都不用管，让开的正好是它们占的那块。
    const sync = () => {
      const host = rightEdgeInspector();
      const row = workspaceRow();
      const right = host ? Math.max(0, window.innerWidth - host.getBoundingClientRect().left) : 0;
      const bottom = row ? Math.max(0, window.innerHeight - row.getBoundingClientRect().bottom) : 0;
      // 没变就交还原来那个对象：下面盯着结构的那个观察器会因为页面别处的增删也走到这儿，
      // 每次都换新对象等于让放大着的那份内容陪着重渲染一遍。
      setInset((current) => (current.right === right && current.bottom === bottom ? current : { right, bottom }));
      // 换人了才重绑：ResizeObserver 盯的是具体节点，inspector 关掉重开是新的一个，不重绑
      // 就只剩「关掉那一瞬」那一发回调，之后拖宽它放大层再也跟不上。反过来无条件重绑会被
      // `observe()` 自带的首发回调打成死循环。
      const next = [host, row].filter((node): node is HTMLElement => node !== null);
      if (next.length !== watched.length || next.some((node, at) => node !== watched[at])) {
        sizes?.disconnect();
        for (const node of next) sizes?.observe(node);
        watched = next;
      }
    };

    sizes = new ResizeObserver(sync);
    sync();
    // 盯 body 整棵而不是某个容器：不预设 inspector 长在哪棵子树下。工作区、团队的执行者
    // 抽屉、以后别的外壳都可能挂一条，收窄观察根等于把「它只会在这儿」钉死，漏一处就是又
    // 一次「关光面板挤成细条」。代价由上面那道筛选兜着。
    const structure = new MutationObserver((records) => {
      if (records.some(touchesInspector)) sync();
    });
    structure.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", sync);
    return () => {
      sizes?.disconnect();
      structure.disconnect();
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
            style={{ right: inset.right, bottom: inset.bottom, zIndex: zoomZ }}
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
