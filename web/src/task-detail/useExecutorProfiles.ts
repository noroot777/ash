import { useEffect, useState } from "react";
import type { AgentExecutorProfile } from "@ash/shared";
import { api } from "../lib/api.ts";

/**
 * 回复框要的执行器 profile：胶囊、`@` 召唤、选模型浮层都取它。从 ReplyBox.tsx 搬出来（那份顶到
 * 700 行上限），读法一字未改：读失败是空表 + `failed`，`ready` 说「读过了」（成没成都算）。
 */
export function useExecutorProfiles() {
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setReady(false);
    setFailed(false);
    api.agents().then(
      (nextProfiles) => { if (alive) setProfiles(nextProfiles); },
      () => {
        if (!alive) return;
        setProfiles([]);
        setFailed(true);
      },
    ).finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, []);
  return { profiles, ready, failed };
}
