import { useEffect, useRef, type RefObject } from "react";

/**
 * 打开中的可关闭层，按打开先后排成一摞。
 *
 * 浮层里可以再开浮层——工作流站点的编辑器里点「执行器 · 模型」那颗胶囊，弹出来的
 * 两步选择器是 portal 到 body 的：DOM 上它不在外层容器里，只按 `contains` 判断会把
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

export function useDismissable<
  Container extends HTMLElement,
  RestoreFocus extends HTMLElement = HTMLElement,
>({
  enabled,
  containerRef,
  onClose,
  restoreFocusRef,
}: {
  enabled: boolean;
  containerRef: RefObject<Container | null>;
  onClose: () => void;
  restoreFocusRef?: RefObject<RestoreFocus | null>;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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

    const closeOnOutside = (event: Event) => {
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
    document.addEventListener("pointerdown", closeOnOutside, true);
    document.addEventListener("click", closeOnOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      const at = layers.indexOf(layer);
      if (at >= 0) layers.splice(at, 1);
      document.removeEventListener("pointerdown", closeOnOutside, true);
      document.removeEventListener("click", closeOnOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [containerRef, enabled, restoreFocusRef]);
}
