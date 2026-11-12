import { useEffect, useRef, useState } from "react";

/**
 * 「减少动效」此刻生不生效。两路都认:系统偏好(prefers-reduced-motion),以及根上的
 * data-motion —— "reduce" 强制减少,"full" 强制照常(压过系统偏好)。CSS 那侧同一口径,
 * 见 styles/motion-text.css。
 */
export function motionReduced(): boolean {
  if (typeof document === "undefined") return true;
  const forced = document.documentElement.dataset.motion;
  if (forced === "reduce") return true;
  if (forced === "full") return false;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 换字那一拍有多长:读 CSS 里的 --swap-dur,两边只写一处。 */
function swapDuration(): number {
  if (typeof document === "undefined") return 150;
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--swap-dur")) || 150;
}

export type SwapPhase = "" | "is-out" | "is-pre";

/**
 * 一行会换字的标签:旧的上去、新的上来(配 `.swap` 类,见 styles/motion-text.css)。
 *
 * `dwellMs`:每一句至少停这么久才让下一句顶上。来得比这快的不排长队 —— 积压时只留最新的
 * 那一句,轮到它时直接换成它。否则工具一秒来五条,标题要么闪成一片,要么落后真实进度好几秒。
 * `dwellMs` 随时可以改:传 0 就是「下一句立刻上」(做完落定成过去式那一下就是这么用的)。
 *
 * 首次渲染直接显示,不演;减少动效时一律直接换字(仍然守着 dwell,不然字照样闪)。
 * 返回值:`shown` 是此刻该画的字,`phase` 挂到同一个元素的类名上。
 */
export function useSwapText(text: string, { dwellMs = 0 }: { dwellMs?: number } = {}): { shown: string; phase: SwapPhase } {
  const [shown, setShown] = useState(text);
  const [phase, setPhase] = useState<SwapPhase>("");
  const target = useRef(text);
  const showing = useRef(text);
  const shownAt = useRef(typeof performance === "undefined" ? 0 : performance.now());
  const dwell = useRef(dwellMs);
  const busy = useRef(false);
  const waitTimer = useRef<number | undefined>(undefined);
  const swapTimer = useRef<number | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const pump = useRef<() => void>(() => {});

  dwell.current = dwellMs;
  pump.current = () => {
    if (busy.current) return; // 正在换的那一拍收尾时会再叫一次
    const next = target.current;
    if (next === showing.current) return;
    const wait = shownAt.current + dwell.current - performance.now();
    if (wait > 0) {
      window.clearTimeout(waitTimer.current);
      waitTimer.current = window.setTimeout(() => pump.current(), wait);
      return;
    }
    if (motionReduced()) {
      showing.current = next;
      shownAt.current = performance.now();
      setShown(next);
      return;
    }
    busy.current = true;
    setPhase("is-out");
    swapTimer.current = window.setTimeout(() => {
      // 旧字退场的这 150ms 里目标可能又变了:上来的是**此刻**最新的那一句。
      const latest = target.current;
      showing.current = latest;
      setShown(latest);
      setPhase("is-pre");
      // 两帧:第一帧让「在下面、透明」那个起点真的画出来,第二帧撤掉它,过渡才有起点。
      frame.current = window.requestAnimationFrame(() => {
        frame.current = window.requestAnimationFrame(() => {
          setPhase("");
          busy.current = false;
          shownAt.current = performance.now();
          pump.current();
        });
      });
    }, swapDuration());
  };

  useEffect(() => {
    target.current = text;
    window.clearTimeout(waitTimer.current);
    pump.current();
  }, [text, dwellMs]);

  useEffect(() => () => {
    window.clearTimeout(waitTimer.current);
    window.clearTimeout(swapTimer.current);
    if (frame.current !== undefined) window.cancelAnimationFrame(frame.current);
  }, []);

  return { shown, phase };
}
