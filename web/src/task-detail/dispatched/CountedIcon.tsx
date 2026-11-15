import type { ReactNode } from "react";

/** 竖轨上那颗图标右上角带一个数（「派出的任务」有几条）。数是给眼睛看的，读屏从格名里读。 */
export function CountedIcon({ icon, count }: { icon: ReactNode; count: number }) {
  return (
    <span className="insp-counted-icon">
      {icon}
      <i aria-hidden="true">{count > 99 ? "99+" : count}</i>
    </span>
  );
}
