import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import type { RemoteBranch } from "@navi/shared/task-branch";
import { api } from "./api";

type Refs = { projectId: string; branches: string[]; remoteBranches: RemoteBranch[]; remotes: string[] };

export function useTaskBranches(projectId: string | null, enabled: boolean) {
  const [selection, setSelection] = useState({ projectId, base: "" });
  const [refs, setRefs] = useState<Refs | null>(null);
  const [fetching, setFetching] = useState<{ projectId: string; error: string | null } | null>(null);
  const reload = useRef<() => void>(() => {});

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
    reload.current = refresh;
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      alive = false;
      reload.current = () => {};
      subscription.remove();
    };
  }, [projectId, enabled]));

  const current = refs?.projectId === projectId ? refs : null;
  const busy = fetching?.projectId === projectId && fetching.error === null;
  return {
    base: selection.projectId === projectId ? selection.base : "",
    branches: current?.branches ?? [],
    remoteBranches: current?.remoteBranches ?? [],
    /** 有远端才给：先 fetch 再重读清单。失败的原因留在 fetchError 里给页面说。 */
    refreshRemotes: current?.remotes.length && projectId && !busy
      ? () => {
        setFetching({ projectId, error: null });
        api.projectGitFetch(projectId).then(
          () => { setFetching(null); reload.current(); },
          (error: unknown) => setFetching({ projectId, error: error instanceof Error ? error.message : String(error) }),
        );
      }
      : null,
    fetchingRemotes: busy,
    fetchError: fetching?.projectId === projectId ? fetching.error : null,
    setBase: (base: string) => setSelection({ projectId, base }),
  };
}
