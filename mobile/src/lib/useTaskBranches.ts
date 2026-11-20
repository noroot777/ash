import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import type { RemoteBranch } from "@navi/shared/task-branch";
import { api } from "./api";

type Refs = { projectId: string; branches: string[]; remoteBranches: RemoteBranch[]; remotes: string[] };

export function useTaskBranches(projectId: string | null, enabled: boolean) {
  const [selection, setSelection] = useState({ projectId, base: "" });
  const [refs, setRefs] = useState<Refs | null>(null);
  const [fetching, setFetching] = useState<{ projectId: string; request: number; error: string | null } | null>(null);
  const reload = useRef<{ projectId: string | null; run: () => void }>({ projectId: null, run: () => {} });
  const fetchRequest = useRef(0);

  useEffect(() => {
    setSelection({ projectId, base: "" });
  }, [projectId]);

  useFocusEffect(useCallback(() => {
    if (!enabled || !projectId) return;
    let alive = true;
    let sequence = 0;
    const refresh = () => {
      const request = ++sequence;
      api.projectBranches(projectId).then(({ branches, remoteBranches, remotes }) => {
        if (alive && request === sequence) setRefs({ projectId, branches, remoteBranches: remoteBranches ?? [], remotes: remotes ?? [] });
      }).catch(() => {});
    };
    reload.current = { projectId, run: refresh };
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      alive = false;
      reload.current = { projectId: null, run: () => {} };
      subscription.remove();
    };
  }, [projectId, enabled]));

  const current = refs?.projectId === projectId ? refs : null;
  const busy = fetching?.projectId === projectId && fetching.error === null;
  return {
    base: selection.projectId === projectId ? selection.base : "",
    branches: current?.branches ?? [],
    remoteBranches: current?.remoteBranches ?? [],
    /**
     * 有远端才给：先 fetch 再重读清单。失败的原因留在 fetchError 里给页面说。结果只落在发起它的那一趟上：
     * 切过项目、又刷新过一次之后，早先那趟回来既不清掉新的等待/报错，也不去重读别的项目。
     */
    refreshRemotes: current?.remotes.length && projectId && !busy
      ? () => {
        const request = ++fetchRequest.current;
        const settle = (error: string | null) => setFetching((now) => (now?.request === request ? (error === null ? null : { ...now, error }) : now));
        setFetching({ projectId, request, error: null });
        api.projectGitFetch(projectId).then(
          () => {
            settle(null);
            if (reload.current.projectId === projectId) reload.current.run();
          },
          (error: unknown) => settle(error instanceof Error ? error.message : String(error)),
        );
      }
      : null,
    fetchingRemotes: busy,
    fetchError: fetching?.projectId === projectId ? fetching.error : null,
    setBase: (base: string) => setSelection({ projectId, base }),
  };
}
