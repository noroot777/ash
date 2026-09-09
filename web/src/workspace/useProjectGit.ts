import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api, type ProjectGitResult } from "../lib/api.ts";
import {
  putProjectGitState,
  readProjectGitRun,
  runProjectGit,
  subscribeProjectGitRun,
  type ProjectGitRun,
} from "./projectGitRuns.ts";

// 项目主仓 git 面板的数据层，供侧栏那颗分支胶囊点开的浮层用。
//
// 三条约定：
// ① **只在面板开着时拉。** 关着的时候胶囊显示的是 `ProjectHealth` 里那份轻量分支名
//    （WorkspaceShell 已经在拉了），不值得为了它再打一趟 git。
// ② **失败不清空已有状态。** 网络抖一下就把分支清单抹掉，用户看到的是「仓库没了」。
//    读取错误单独放一格，清单留在原地。
// ③ **写操作的状态不归这个 hook 管。** 它住在 `projectGitRuns.ts` 那本账里，浮层被点没了
//    也还在——那正是「操作跑一半浮层消失就像被打断」那件事的根。

export type ProjectGitHandle = ProjectGitRun & {
  /** 这份 handle 是谁的。跟着 handle 走，调用点就不可能拿 A 的状态发 B 的请求。 */
  projectId: string | null;
  loading: boolean;
  refresh: () => void;
  run: (kind: string, action: () => Promise<ProjectGitResult>) => Promise<boolean>;
};

export function useProjectGit(projectId: string | null, enabled: boolean): ProjectGitHandle {
  const current = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeProjectGitRun(projectId, listener), [projectId]),
    useCallback(() => readProjectGitRun(projectId), [projectId]),
  );
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => setLoadError(null), [projectId]);

  useEffect(() => {
    if (!enabled || !projectId) return;
    // 写操作在途时不拉：这趟 GET 只会读到 git 干到一半的样子，回来还可能盖掉操作结果
    // （`putProjectGitState` 也拦了一道）。操作落定时结果自带一份新状态。
    if (readProjectGitRun(projectId).busy) return;
    let alive = true;
    setLoading(true);
    api.projectGit(projectId)
      .then((next) => {
        if (!alive) return;
        putProjectGitState(projectId, next);
        setLoadError(null);
      })
      .catch((reason) => {
        if (alive) setLoadError(reason instanceof Error ? reason.message : "读取 Git 状态失败");
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [enabled, projectId, version]);

  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  const run = useCallback(
    (kind: string, action: () => Promise<ProjectGitResult>) =>
      (projectId ? runProjectGit(projectId, kind, action) : Promise.resolve(false)),
    [projectId],
  );

  return { ...current, error: current.error ?? loadError, projectId, loading, refresh, run };
}
