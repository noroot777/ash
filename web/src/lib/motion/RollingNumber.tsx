import { useLayoutEffect, useRef } from "react";
import { animate } from "animejs";
import { motionReduced } from "../useSwapText.ts";

const ROLL_MS = 400;

/**
 * 数字滚到新值（用量、用时、改动行数）：对一个普通对象补间，每帧把格式化后的字写进 span。
 * 字由这里直接写，React 不往里放子节点，两边不抢。等宽数字（tabular-nums）免得滚的时候左右抖。
 * 挂上那一刻、减少动效时、或者值认不出是数的时候直接写终值。
 */
export function RollingNumber({ value, format = String, className }: {
  value: number;
  format?: (value: number) => string;
  className?: string;
}) {
  const span = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  const formatRef = useRef(format);
  formatRef.current = format;
  useLayoutEffect(() => {
    const el = span.current;
    if (!el) return;
    const from = shown.current;
    const write = (n: number) => { el.textContent = formatRef.current(n); };
    if (from === null || from === value || !Number.isFinite(value) || !Number.isFinite(from) || motionReduced()) {
      shown.current = value;
      write(value);
      return;
    }
    const state = { n: from };
    const run = animate(state, {
      n: value,
      duration: ROLL_MS,
      ease: "outQuad",
      onUpdate: () => { shown.current = state.n; write(Number.isInteger(value) ? Math.round(state.n) : state.n); },
      onComplete: () => { shown.current = value; write(value); },
    });
    return () => { run.pause(); };
  }, [value]);
  return <span ref={span} className={className} style={{ fontVariantNumeric: "tabular-nums" }} />;
}
