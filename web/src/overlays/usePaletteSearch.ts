import { useEffect, useState } from "react";
import type { SearchHit } from "@ash/shared";
import { compareSearchHits, isSearchQueryReady, SEARCH_MAX_HITS, type SearchSort } from "@ash/shared/search";
import { api } from "../lib/api.ts";

type SearchState = {
  key: string;
  hits: SearchHit[];
  searching: boolean;
  phase: "local" | "others" | null;
  error: string | null;
};

export function usePaletteSearch({ open, query, projectId, type, prefer, sort }: {
  open: boolean;
  query: string;
  projectId?: string;
  type?: "tasks" | "notes";
  prefer: string | null;
  sort: SearchSort;
}) {
  const [attempt, setAttempt] = useState(0);
  const value = query.trim();
  const enabled = open && isSearchQueryReady(value);
  const key = JSON.stringify([enabled, value, projectId, type, prefer, sort, attempt]);
  const [state, setState] = useState<SearchState>({ key: "", hits: [], searching: false, phase: null, error: null });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const collected = new Map<string, SearchHit>();
    let phase: SearchState["phase"] = "local";
    let flush = 0;
    let alive = true;
    const ordered = () => [...collected.values()].sort((left, right) => compareSearchHits(left, right, prefer, sort)).slice(0, SEARCH_MAX_HITS);
    const paint = () => {
      if (alive) setState({ key, hits: ordered(), searching: true, phase, error: null });
    };
    paint();
    const timer = window.setTimeout(() => {
      void api.searchStream(value, { projectId, type, prefer, sort }, {
        onHit: (hit) => {
          if (!alive) return;
          collected.set(`${hit.kind}:${hit.id}`, hit);
          if (!flush) flush = window.setTimeout(() => { flush = 0; paint(); }, 60);
        },
        onLocalDone: () => { phase = "others"; paint(); },
      }, controller.signal).then(() => {
        if (alive) setState({ key, hits: ordered(), searching: false, phase: null, error: null });
      }).catch((error: unknown) => {
        if (alive && !controller.signal.aborted) setState({
          key, hits: ordered(), searching: false, phase: null,
          error: error instanceof Error ? error.message : "搜索未完成，请重试",
        });
      }).finally(() => { if (flush) { window.clearTimeout(flush); flush = 0; } });
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearTimeout(flush);
      controller.abort();
    };
  }, [enabled, key, prefer, projectId, sort, type, value]);

  const current = enabled && state.key === key ? state : {
    key, hits: [], searching: enabled, phase: enabled ? "local" as const : null, error: null,
  };
  return { ...current, retry: () => setAttempt((value) => value + 1) };
}
