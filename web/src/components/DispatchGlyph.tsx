import { TreeView } from "@phosphor-icons/react";
import type { BelowSignal } from "../lib/taskLook.ts";

// 名下子任务的那颗图标。颜色说名下最该被看见的那一条（taskLook 的 below）：在动主色、会跳，轮到你
// 琥珀，出事了红，做完没验收主色不跳，都验收了留灰。有颜色时画实心：12px 的细线只换颜色几乎看不出来，
// 灰的那颗留细线，对比才够。数字不跟着变色，颜色只上图标。侧栏父任务行尾、右侧「子任务」格的
// 折叠键共用这一颗，样式在 styles/task-status-dot.css（跟圆点同一套读法，减少动效时一起停）。
export function DispatchGlyph({ below }: { below: BelowSignal | null }) {
  return <TreeView size={12} weight={below ? "fill" : "regular"} className={`dispatch-glyph${below ? ` is-${below.tone}` : ""}`} aria-hidden="true" />;
}

/** 那个数念出来的那句（图标和数只给眼睛看）。 */
export function dispatchGlyphSaid(count: number, below: BelowSignal | null): string {
  return below ? `${count} 个子任务，${below.tip}` : `${count} 个子任务`;
}
