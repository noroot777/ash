import { useEffect, useState } from "react";
import type { AgentExecutorProfile } from "@ash/shared";
import { api } from "../lib/api.ts";

/** 回复框要的执行器 profile 清单：读没读完、读没读成都要分得清（`@` 菜单据此说「正在读取 / 读取失败」）。 */
export function useExecutorProfiles() {
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setReady(false);
    setFailed(false);
    api.agents().then(
      (next) => { if (alive) setProfiles(next); },
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
