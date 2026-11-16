import type { ReactNode } from "react";

/**
 * 竖轨上那颗图标右上角带一个数（「子任务」有几条）。数是给眼睛看的，读屏从格名里读。
 * `warn`：名下有要你处理的（在等答复、失败），数变琥珀色，同侧栏那一行行尾的数。
 */
export function CountedIcon({ icon, count, warn = false }: { icon: ReactNode; count: number; warn?: boolean }) {
  return (
    <span className={`insp-counted-icon${warn ? " is-warn" : ""}`}>
      {icon}
      <i aria-hidden="true">{count > 99 ? "99+" : count}</i>
    </span>
  );
}
