import { useEffect, useState } from "react";

/** 每秒（或 `intervalMs`）走一格的「此刻」。`enabled` 为假时停表，返回值停在最后一格。 */
export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}
