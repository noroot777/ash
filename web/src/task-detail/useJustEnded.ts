import { useEffect, useRef, useState } from "react";

/**
 * 这一回合是不是**刚刚**在眼前收口（docs/ui-ux-audit run-5）：从「在说」变成「说完」的那一刻
 * 起为真，`ms` 之后回到假。页面一打开就已经说完的历史回合永远是假——只有看着它收口才算。
 */
export function useJustEnded(live: boolean, ms = 2000): boolean {
  const was = useRef(live);
  const [just, setJust] = useState(false);
  useEffect(() => {
    const ended = was.current && !live;
    was.current = live;
    if (!ended) {
      if (live) setJust(false);
      return;
    }
    setJust(true);
    const timer = window.setTimeout(() => setJust(false), ms);
    return () => window.clearTimeout(timer);
  }, [live, ms]);
  return just;
}
