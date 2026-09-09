import { useEffect, useRef, type RefObject } from "react";

/**
 * 打开中的可关闭层，按打开先后排成一摞。
 *
 * 浮层里可以再开浮层——工作流站点的编辑器里点那颗三段胶囊，弹出来的选择器是 portal
 * 到 body 的：DOM 上它不在外层容器里，只按 `contains` 判断会把
 * 「点里层」读成「点了外面」，里层刚开就被连根拔掉（外层一关，里层跟着卸载）。
 *
 * 所以按打开顺序记一摞，两条规则都只看这摞：
 * ① 点击落在比自己更晚打开的某一层里，就不算「点了外面」；
 * ② Esc 只关最上面那一层，一次退一层而不是全端了。
 */
type Layer = {
  containerRef: RefObject<HTMLElement | null>;
  restoreFocusRef?: RefObject<HTMLElement | null>;
};
const layers: Layer[] = [];

/**
 * 此刻有没有可关闭的浮层开着。给「Esc 一次退一层」的外圈用：铺开的侧边栏、全屏视图
 * 这类最外层收到 Esc 前先问一句，有浮层就让给它，由上面那摞自己关最上面那一层。
 */
export function hasOpenLayer(): boolean {
  return layers.length > 0;
}

export function useDismissable<
  Container extends HTMLElement,
  RestoreFocus extends HTMLElement = HTMLElement,
>({
  enabled,
  containerRef,
  onClose,
  restoreFocusRef,
  closeOnOutside = true,
}: {
  enabled: boolean;
  containerRef: RefObject<Container | null>;
  onClose: () => void;
  restoreFocusRef?: RefObject<RestoreFocus | null>;
  /**
   * 菜单、气泡这类「点别处就该收起来」的浮层保持默认 true。放大视图那种「铺开一块地方
   * 长期看着、旁边的 inspector 还要接着点」的层传 false：它照样进这摞（Esc 仍按顺序一次
   * 退一层、里层的点击仍不算点外面），只是不再把「点外面」当成关闭意图。
   *
   * 允许**开着的时候改**：项目 Git 浮层在 fetch / pull / push 跑着的那几秒把它压成 false，
   * 免得手一滑点到别处就把正在进行的操作从视野里抹掉。
   */
  closeOnOutside?: boolean;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // 从 ref 读而不是进 effect 依赖：依赖一变就是「退出这摞再重新 push」，层序被改写成最新
  // 打开的那个——外层浮层会跑到里层前面去，`insideInnerLayer` 和「Esc 只关最上面一层」
  // 两条规则同时失灵。开关本身跟层序无关，不该动这摞。
  const closeOnOutsideRef = useRef(closeOnOutside);
  closeOnOutsideRef.current = closeOnOutside;

  useEffect(() => {
    if (!enabled) return;

    const layer: Layer = {
      containerRef: containerRef as RefObject<HTMLElement | null>,
      restoreFocusRef: restoreFocusRef as RefObject<HTMLElement | null> | undefined,
    };
    layers.push(layer);

    const insideInnerLayer = (target: Node) => {
      const at = layers.indexOf(layer);
      return layers.slice(at + 1).some((inner) =>
        inner.containerRef.current?.contains(target)
        || inner.restoreFocusRef?.current?.contains(target));
    };

    const dismissOnOutside = (event: Event) => {
      if (!closeOnOutsideRef.current) return;
      const target = event.target;
      if (
        !(target instanceof Node)
        || containerRef.current?.contains(target)
        || restoreFocusRef?.current?.contains(target)
        || insideInnerLayer(target)
      ) return;
      onCloseRef.current();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 只有最上面那层吃这一下 Esc：里层还开着时，外层不该跟着一起消失。
      if (layers[layers.length - 1] !== layer) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      restoreFocusRef?.current?.focus();
    };

    // Capture keeps dismissal reliable when the destination stops bubbling.
    // Click covers keyboard and assistive activation paths without pointerdown.
    document.addEventListener("pointerdown", dismissOnOutside, true);
    document.addEventListener("click", dismissOnOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      const at = layers.indexOf(layer);
      if (at >= 0) layers.splice(at, 1);
      document.removeEventListener("pointerdown", dismissOnOutside, true);
      document.removeEventListener("click", dismissOnOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [containerRef, enabled, restoreFocusRef]);
}
