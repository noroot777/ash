import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { ProjectView } from "@ash/shared";
import { api } from "../lib/api.ts";
import { catchUpAbortKind } from "../lib/catchUp.ts";
import { useServerEvents } from "../lib/events.ts";
import { useCatchUp, useCatchUpLink } from "../lib/useCatchUp.ts";

// 工作区壳那一份项目列表：**唯一一个读取者**。首次加载、服务端说「项目改了」（project.updated）、
// 断线重连后的对账，全走同一个追平实例（lib/useCatchUp.ts：同一时刻至多一发在途、失败按节奏
// 重试、挂住到点作废）。从前首次加载和事件更新是两条各自写列表的路：首次那一发还在途时另一页
// 改了门禁基准，后发先至的新读数被丢掉、旧的首次读数随后落地，页面就停在改之前（第 2 轮审查
// F4）；事件触发的那一发失败一次也没人再读（F3）。
//
// 本页自己写项目（保存设置、新建、删除）走 `apply`：照写，然后补排一趟读取。写入那一刻还在途的
// 那一发不再作数（它可能早于这次写入），由补排的那一趟接上。`setLocal` 只给不该触发重读的
// 派生字段（项目体检）用。
export function useProjects(onFirstLoad: (rows: ProjectView[]) => void) {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // 读到过一次之后又没读到：页面上那份可能不是最新的。界面要说出来（项目设置页的提示）。
  const [lagging, setLagging] = useState(false);
  const loaded = useRef(false);
  const writes = useRef(0);
  const onFirstLoadRef = useRef(onFirstLoad);
  onFirstLoadRef.current = onFirstLoad;

  const read = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    const writesAtStart = writes.current;
    try {
      const rows = await api.projects(signal);
      if (writes.current !== writesAtStart) return true;
      setProjects(rows);
      setError(null);
      setLagging(false);
      if (!loaded.current) {
        loaded.current = true;
        onFirstLoadRef.current(rows);
      }
      setReady(true);
      return true;
    } catch (reason) {
      if (catchUpAbortKind(signal, reason) === "stale") return false;
      if (loaded.current) setLagging(true);
      else {
        setError(reason instanceof Error ? reason : new Error("项目列表读取失败"));
        setReady(true);
      }
      return false;
    }
  }, []);
  const catchUp = useCatchUp(read);
  useEffect(() => { void catchUp.run(); }, [catchUp]);
  const connected = useServerEvents((event) => { if (event.type === "project.updated") void catchUp.run(); });
  useCatchUpLink(catchUp, connected);

  const apply = useCallback((update: SetStateAction<ProjectView[]>) => {
    writes.current += 1;
    setProjects(update);
    void catchUp.run();
  }, [catchUp]);
  return { projects, ready, error, lagging, apply, setLocal: setProjects };
}
