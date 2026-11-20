import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { X } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { motionReduced } from "../lib/useSwapText.ts";
// 样式在 styles/side-drawer.css，由 global.css 统一 @import：夹具里直接手写这套类名也得有样式。

/**
 * 从左侧推出来的详情抽屉：团队模式的执行者详情、任务里的子智能体执行详情，和读全文的那一屉
 * （审查报告、辩论的完整记录，经 LeftDrawer.tsx 的槽开）共用它。
 *
 * 关闭动画得等 animationend 才真卸载，所以这里自己记一个 `closing`；
 * 减少动效时（`motionReduced()`，side-drawer.css 同一口径）动画被整个关掉、animationend 永远不来，那一路靠定时器收尾。
 *
 * 读全文那一屉（reading）在哪种宽度下都不盖会话：不画遮罩，主区把抽屉那一块让出来（side-drawer.css），
 * 一边读报告一边还能看会话、在回复框里说话。主区够宽就并排（会话往右挤），不够宽就上下摆
 * （`is-stacked`）；量的是主区自己，不是窗口——右侧面板开着宽格时，宽窗口里的主区也可能很窄。
 *
 * 进 useDismissable 那一摞但**不**把「点外面」当关闭意图：scrim 只盖住中间那一栏，右边的
 * Inspector 仍然要能点（列表就在那儿，点下一个直接换人）。进这摞图的是 Esc 的层序——
 * 抽屉里还开着菜单时，Esc 先关菜单而不是把整个抽屉端走。
 */
/** 主区至少这么宽才并排：两边各分到一半，再窄报告和会话都没法读。 */
const READING_SIDE_BY_SIDE_MIN = 560;

/** 读全文那一屉该不该改成上下摆：盯着定位基准（主区）的宽度，绘制前就量好，免得先盖一下再挪。 */
function useStackedReading(enabled: boolean, drawerRef: RefObject<HTMLElement | null>) {
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const host = enabled ? drawerRef.current?.parentElement : null;
    if (!host) return;
    const measure = () => setStacked(host.clientWidth < READING_SIDE_BY_SIDE_MIN);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [enabled, drawerRef]);
  return enabled && stacked;
}

export function SideDrawer({
  variant,
  contentKey,
  kind,
  title,
  ariaLabel,
  closeLabel,
  actions,
  children,
  onClose,
}: {
  variant: "worker" | "subagent" | "reading";
  /** 抽屉里装的是谁。换人时把正在播的关闭动画取消掉 —— 否则关到一半点开下一个，
      那次点击会被动画尾声吞掉（抽屉照旧滑走，新选的那个一起没了）。 */
  contentKey: string;
  kind: ReactNode;
  title: ReactNode;
  ariaLabel: string;
  closeLabel: string;
  actions?: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const closingRef = useRef(false);
  const closeTimer = useRef<number | null>(null);
  const stacked = useStackedReading(variant === "reading", drawerRef);
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    if (motionReduced()) closeTimer.current = window.setTimeout(onClose, 0);
  }, [onClose]);
  useDismissable({
    enabled: true,
    containerRef: drawerRef,
    onClose: requestClose,
    closeOnOutside: false,
  });
  useEffect(() => {
    closingRef.current = false;
    setClosing(false);
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, [contentKey]);
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);
  return (
    <>
      <div className={`side-drawer-scrim side-drawer-scrim--${variant}${closing ? " is-closing" : ""}`} onClick={requestClose} />
      <aside
        ref={drawerRef}
        className={`side-drawer side-drawer--${variant}${stacked ? " is-stacked" : ""}${closing ? " is-closing" : ""}`}
        aria-label={ariaLabel}
        onAnimationEnd={(event) => {
          if (closing && event.animationName === "side-drawer-out") onClose();
        }}
      >
        <header>
          <span className="side-drawer__kind">{kind}</span><b>{title}</b>
          {actions}
          <button type="button" aria-label={closeLabel} onClick={requestClose}><X size={14} weight="bold" /></button>
        </header>
        {children}
      </aside>
    </>
  );
}
