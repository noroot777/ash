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
  const reload = useRef<{ projectId: string | null; run: () => Promise<void> }>({ projectId: null, run: async () => {} });
  const fetchRequest = useRef(0);

  useEffect(() => {
    setSelection({ projectId, base: "" });
  }, [projectId]);

  useFocusEffect(useCallback(() => {
    if (!enabled || !projectId) return;
    let alive = true;
    let sequence = 0;
    // 后台那几趟（进页面、回到前台）读不到就安静地留着旧清单；刷新远端那一趟要知道成没成（见下）。
    const refresh = async () => {
      const request = ++sequence;
      const { branches, remoteBranches, remotes } = await api.projectBranches(projectId);
      if (alive && request === sequence) setRefs({ projectId, branches, remoteBranches: remoteBranches ?? [], remotes: remotes ?? [] });
    };
    reload.current = { projectId, run: refresh };
    refresh().catch(() => {});
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh().catch(() => {});
    });
    return () => {
      alive = false;
      reload.current = { projectId: null, run: async () => {} };
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
        const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
        // 拉取和重读算一趟：重读完才结束等待，重读失败也说出来（旧清单留着）。
        api.projectGitFetch(projectId).then(
          () => (reload.current.projectId === projectId ? reload.current.run() : Promise.resolve()).then(
            () => settle(null),
            (error: unknown) => settle(`远端已经拉到，但重读分支清单失败：${message(error)}`),
          ),
          (error: unknown) => settle(message(error)),
        );
      }
      : null,
    fetchingRemotes: busy,
    fetchError: fetching?.projectId === projectId ? fetching.error : null,
    setBase: (base: string) => setSelection({ projectId, base }),
  };
}
