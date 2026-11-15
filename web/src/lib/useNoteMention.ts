import { useEffect, useState } from "react";
import type { Note } from "@ash/shared";
import { api } from "./api.ts";

/**
 * `@` 菜单里随手记那一半的取数：这个项目的随手记，**每次菜单打开时拉一遍**。
 *
 * 不边打边搜：一个项目的随手记就那么几十条，整张拿回来在本地过滤（noteMention.ts 的
 * matchNotes），比每个字一趟网络快，也不会有「旧 token 的结果晚到」那类串台。每次打开都
 * 重拉，是因为随手记随时在别处被改（面板开着、另一台设备）；重拉期间先用上一次的那份，
 * 不让菜单闪一下空的。
 */
export type NoteMentionStatus = "loading" | "ready" | "failed";

export function useNoteMention({ projectId, active }: { projectId: string; active: boolean }) {
  const [state, setState] = useState<{ projectId: string; notes: Note[]; status: NoteMentionStatus }>(
    { projectId, notes: [], status: "loading" },
  );
  useEffect(() => {
    if (!active) return;
    let alive = true;
    // 换了项目，手上那份是别人家的：清掉重来；同一个项目就留着旧的边用边刷新。
    setState((current) => (current.projectId === projectId
      ? current
      : { projectId, notes: [], status: "loading" }));
    api.notes(projectId).then(
      (notes) => { if (alive) setState({ projectId, notes, status: "ready" }); },
      () => {
        if (!alive) return;
        // 刷新失败但手上有这个项目的旧数据：照旧用，不必吓人。
        setState((current) => (current.projectId === projectId && current.status === "ready"
          ? current
          : { projectId, notes: [], status: "failed" }));
      },
    );
    return () => { alive = false; };
  }, [active, projectId]);
  const own = state.projectId === projectId;
  return { notes: own ? state.notes : [], status: own ? state.status : "loading" as NoteMentionStatus };
}
