import { useLayoutEffect, type RefObject } from "react";

/** 自动撑高最多撑到几行,再多就在框内滚动。 */
const DEFAULT_MAX_LINES = 12;
/** 自动撑高再怎么撑也不占满窗口:上面的会话得留得下地方。 */
const VIEWPORT_SHARE = 0.4;

type Metrics = {
  lineHeight: number;
  /** 内边距 + 边框:内容之外那圈占的高度。 */
  chrome: number;
  /** scrollHeight 含 padding 不含 border,border-box 下要补的就是这一截。 */
  border: number;
  cssMin: number;
  cssMax: number;
};

/**
 * 量一次这个 textarea 的排版参数。行高、内边距都从计算样式读,别写死像素:
 * 各处对话框字号不一样,写死了换个地方就差半行。
 */
function measure(el: HTMLTextAreaElement): Metrics {
  const style = window.getComputedStyle(el);
  const fontSize = Number.parseFloat(style.fontSize) || 13;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.5;
  const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  const border = style.boxSizing === "border-box"
    ? (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0)
    : 0;
  const cssMax = Number.parseFloat(style.maxHeight);
  return {
    lineHeight,
    chrome: padding + border,
    border,
    cssMin: Number.parseFloat(style.minHeight) || 0,
    cssMax: Number.isFinite(cssMax) ? cssMax : Number.POSITIVE_INFINITY,
  };
}

/**
 * 让对话框跟着输入的行数长高,长到上限为止(再多就在框内滚)。
 *
 * `floor` 是外部拖动条(task-detail/ReplyResizeHandle.tsx)拖出来的高度,它只抬**下限**:
 * 框至少这么高,内容更多照样往上长,上限取「自动撑高的上限」和 floor 里大的那个。
 * 别把它当成固定高度——拖动条的值是跨任务、跨刷新记着的,当固定高度用时,哪怕一次
 * 无意的几像素拖动都会让所有框从此不再长高,而且界面上看不出原因。
 *
 * 高度只由这一个地方写。别在同一个 textarea 上再挂第二套写 style.height 的机制,
 * 两套会互相打架(见 styles/task-reply.css 里那条注释)。
 */
export function useAutoGrowTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  {
    value,
    floor = null,
    maxLines = DEFAULT_MAX_LINES,
  }: { value: string; floor?: number | null; maxLines?: number },
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const apply = () => {
      const { lineHeight, chrome, border, cssMin, cssMax } = measure(el);
      const min = Math.max(cssMin, Math.ceil(chrome + lineHeight * (el.rows || 1)), Math.round(floor ?? 0));
      // 拖出来的下限自己 clamp 过,可以比自动撑高的上限高;此时框就停在下限,内容在框内滚。
      const max = Math.max(min, Math.min(
        Math.ceil(chrome + lineHeight * maxLines),
        Math.round(window.innerHeight * VIEWPORT_SHARE),
        cssMax,
      ));
      // 先归零再量:否则 scrollHeight 只会报「当前高度」,删掉几行也缩不回去。
      el.style.height = "auto";
      const natural = el.scrollHeight + border;
      const next = Math.max(min, Math.min(natural, max));
      el.style.height = `${next}px`;
      el.style.overflowY = natural > next ? "auto" : "hidden";
    };

    apply();
    // 上限跟着窗口走,窗口一变就重算。
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [ref, value, floor, maxLines]);
}
