import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { api } from "./api";

export function useTaskBranches(projectId: string | null, enabled: boolean) {
  const [selection, setSelection] = useState({ projectId, base: "" });
  const [refs, setRefs] = useState<{ projectId: string; branches: string[] } | null>(null);

  useEffect(() => {
    setSelection({ projectId, base: "" });
  }, [projectId]);

  useFocusEffect(useCallback(() => {
    if (!enabled || !projectId) return;
    let alive = true;
    let sequence = 0;
    const refresh = () => {
      const request = ++sequence;
      api.projectBranches(projectId).then(({ branches }) => {
        if (alive && request === sequence) setRefs({ projectId, branches });
      }).catch(() => {});
    };
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, [projectId, enabled]));

  return {
    base: selection.projectId === projectId ? selection.base : "",
    branches: refs?.projectId === projectId ? refs.branches : [],
    setBase: (base: string) => setSelection({ projectId, base }),
  };
}
