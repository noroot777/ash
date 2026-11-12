// 提问卡停靠的那一格（docs/ui-ux-audit run-7）：它不在滚动区里，可以动——来的时候从下面滑进来，
// 答完原路收回去。收回去那 200ms 里卡片还是答完那一刻的样子，但点不动（inert）。
import { useEffect, useState, type ReactNode } from "react";

const LEAVE_MS = 200;
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function QuestionDock({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<ReactNode>(children);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (children) {
      setShown(children);
      setLeaving(false);
      return;
    }
    if (reduced()) {
      setShown(null);
      return;
    }
    setLeaving(true);
    const timer = window.setTimeout(() => { setShown(null); setLeaving(false); }, LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [children]);
  const content = children || shown;
  if (!content) return null;
  return (
    <div className={`task-question-dock${leaving && !children ? " is-leaving" : ""}`} inert={leaving && !children ? true : undefined}>
      {content}
    </div>
  );
}
