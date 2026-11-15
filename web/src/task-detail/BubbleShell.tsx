import type { ReactNode } from "react";

/**
 * 会话右边那两颗气泡（审查者那颗 ReviewBubble、辩论那颗 DebateBubble）共用的骨架：靠右、一圈细边、
 * 字是次级灰；指到气泡（键盘走进来）才在它上方右侧浮出「谁 · …」那一行，右端几颗图标键；触屏上那一行
 * 常显在气泡里（reviewer-turn.css）。两颗用同一副骨架，画法不会各自漂走。
 *
 * `children` 是气泡正文（整颗气泡就是那颗键，撑满它的是 `.review-verdict-text`）；`below` 是气泡下面
 * 那几样：就地摊开的那一层、靠右一行小灰字。
 */
export function BubbleShell({ className = "", role, name, meta, keys, children, below }: {
  className?: string;
  role?: "status";
  name: string;
  meta?: string | null;
  keys?: ReactNode;
  children: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className={`review-verdict${className ? ` ${className}` : ""}`} role={role}>
      <div className="review-verdict-bubble">
        <header>
          <b>{name}</b>
          {meta && <span className="review-verdict-meta">{` · ${meta}`}</span>}
          {keys}
        </header>
        {children}
      </div>
      {below}
    </div>
  );
}

/** 浮出那一行右端的一颗图标键。 */
export function BubbleKey({ label, onClick, expanded, pressed, controls, children }: {
  label: string;
  onClick: () => void;
  expanded?: boolean;
  pressed?: boolean;
  controls?: string;
  children: ReactNode;
}) {
  return (
    <button type="button" aria-label={label} aria-expanded={expanded} aria-pressed={pressed} aria-controls={controls} onClick={onClick}>
      {children}
    </button>
  );
}
