import { useEffect, useState } from "react";
import type { Note } from "@navi/shared";
import { api } from "./api.ts";

/**
 * `@` 菜单里随手记那一半的取数：这个项目的随手记，**每次菜单打开时拉一遍**。
 *
 * 不边打边搜：一个项目的随手记就那么几十条，整张拿回来在本地过滤（noteMention.ts 的
 * matchNotes），比每个字一趟网络快，也不会有「旧 token 的结果晚到」那类串台。每次打开都
 * 重拉，是因为随手记随时在别处被改（面板开着、另一台设备）；重拉期间先用上一次的那份，
 * 不让菜单闪一下空的。**数据和这一次读的结果分开记**：手上有旧的不代表这次读成了，刷新
 * 失败要说出来，否则用户拿着可能已被改掉、删掉的旧内容当最新的选（第 1 轮审查）。
 */
export type NoteMentionStatus = "loading" | "ready" | "failed";

export function useNoteMention({ projectId, active }: { projectId: string; active: boolean }) {
  const [state, setState] = useState<{ projectId: string; notes: Note[]; status: NoteMentionStatus }>(
    { projectId, notes: [], status: "loading" },
  );
  useEffect(() => {
    if (!active) return;
    let alive = true;
    // 换了项目，手上那份是别人家的：清掉重来；同一个项目留着旧的，状态记成「正在读」。
    setState((current) => ({ projectId, notes: current.projectId === projectId ? current.notes : [], status: "loading" }));
    api.notes(projectId).then(
      (notes) => { if (alive) setState({ projectId, notes, status: "ready" }); },
      () => { if (alive) setState((current) => ({ ...current, status: "failed" })); },
    );
    return () => { alive = false; };
  }, [active, projectId]);
  const own = state.projectId === projectId;
  return { notes: own ? state.notes : [], status: own ? state.status : "loading" as NoteMentionStatus };
}
