import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ProjectGitResult, type ProjectGitState } from "../lib/api.ts";

// 项目主仓 git 面板的数据层。侧栏那颗分支胶囊和命令面板 `/git` 共用它——同一份状态、
// 同一套报错措辞，不该因为入口不同而说法不同。
//
// 两条约定：
// ① **只在面板开着时拉。** 关着的时候胶囊显示的是 `ProjectHealth` 里那份轻量分支名
//    （WorkspaceShell 已经在拉了），不值得为了它再打一趟 git。
// ② **失败不清空已有状态。** 网络抖一下就把分支清单抹掉，用户看到的是「仓库没了」。
//    错误单独放一格，清单留在原地。

export type ProjectGitHandle = {
  state: ProjectGitState | null;
  loading: boolean;
  /** 正在跑的操作名（`checkout` / `fetch` / `pull` / `push`），空闲时为 null。 */
  busy: string | null;
  /** 最近一次操作的结果：成功给 message，失败给 error。两者互斥。 */
  message: string | null;
  error: string | null;
  refresh: () => void;
  run: (kind: string, action: () => Promise<ProjectGitResult>) => Promise<boolean>;
};

export function useProjectGit(projectId: string | null, enabled: boolean): ProjectGitHandle {
  const [state, setState] = useState<ProjectGitState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // 换项目就把上一份状态和上一条消息一起丢掉：别让 A 项目的分支清单在 B 项目底下多显示
  // 一帧，那一帧足够让人点错分支。
  useEffect(() => { setState(null); setMessage(null); setError(null); }, [projectId]);

  useEffect(() => {
    if (!enabled || !projectId) return;
    let current = true;
    setLoading(true);
    api.projectGit(projectId)
      .then((next) => { if (current) setState(next); })
      .catch((reason) => {
        if (current) setError(reason instanceof Error ? reason.message : "读取 Git 状态失败");
      })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [enabled, projectId, version]);

  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  const run = useCallback(async (kind: string, action: () => Promise<ProjectGitResult>) => {
    if (!projectId) return false;
    setBusy(kind);
    setMessage(null);
    setError(null);
    try {
      const result = await action();
      if (!alive.current) return true;
      setState(result.state);
      setMessage(result.message);
      return true;
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : "操作失败");
      return false;
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [projectId]);

  return { state, loading, busy, message, error, refresh, run };
}
