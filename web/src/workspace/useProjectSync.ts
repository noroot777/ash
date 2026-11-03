import { useCallback, useEffect, useRef } from "react";
import type { ProjectView } from "@ash/shared";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

// 项目设置被别处改了之后，把手里那份项目列表对上。
//
// 项目列表只在工作区壳那一层拉一次，设置页读的就是那份；而同一份项目设置可能从别的入口改
// （验收台门禁卡上的门禁基准）、从别的标签页改、被别的人改。服务端每次 PATCH 都发
// project.updated（只是信号，载荷按身份裁剪，所以要重拉），断线期间漏掉的那些靠重连后对一次账补上。
export function useProjectSync(apply: (rows: ProjectView[]) => void): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const generation = useRef(0);
  const refetch = useCallback(() => {
    const mine = ++generation.current;
    // 连着改两次时，只认最后一次发出去的那份读数，免得先发后到的旧读数盖掉新的。
    api.projects().then((rows) => { if (mine === generation.current) applyRef.current(rows); }).catch(() => {});
  }, []);
  const connected = useServerEvents((event) => { if (event.type === "project.updated") refetch(); });
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) refetch();
    wasConnected.current = connected;
  }, [connected, refetch]);
}
