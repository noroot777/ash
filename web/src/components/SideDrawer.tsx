import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
// 样式在 styles/side-drawer.css，由 global.css 统一 @import：夹具里直接手写这套类名也得有样式。

/**
 * 从左侧推出来的详情抽屉：团队模式的执行者详情和任务里的子智能体执行详情共用它。
 *
 * 关闭动画得等 animationend 才真卸载，所以这里自己记一个 `closing`；
 * `prefers-reduced-motion` 下动画被整个关掉、animationend 永远不来，那一路靠定时器收尾。
 *
 * 进 useDismissable 那一摞但**不**把「点外面」当关闭意图：scrim 只盖住中间那一栏，右边的
 * Inspector 仍然要能点（列表就在那儿，点下一个直接换人）。进这摞图的是 Esc 的层序——
 * 抽屉里还开着菜单时，Esc 先关菜单而不是把整个抽屉端走。
 */
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
  variant: "worker" | "subagent";
  /** 抽屉里装的是谁。换人时把正在播的关闭动画取消掉 —— 否则关到一半点开下一个，
      那次点击会被动画尾声吞掉（抽屉照旧滑走，新选的那个一起没了）。 */
  contentKey: string;
  kind: string;
  title: string;
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
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) closeTimer.current = window.setTimeout(onClose, 0);
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
      <div className={`side-drawer-scrim${closing ? " is-closing" : ""}`} onClick={requestClose} />
      <aside
        ref={drawerRef}
        className={`side-drawer side-drawer--${variant}${closing ? " is-closing" : ""}`}
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
