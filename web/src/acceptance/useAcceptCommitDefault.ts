import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";

// 「这一次合并完要不要替我提交」——确认层里「提交」那一勾（单任务、统一验收、重新合一次共用）。
//
// 它的默认值是**项目设置**（项目设置 → 验收 → 「验收合并后提交代码」）的当前值，在这儿
// 改只管这一次，不回写设置。所以两件事必须同时说清：改了什么、改的是不是只有这次。
//
// 读默认值走的是项目资源本身（GET /projects 里挑出这一个）而不是搭在验收检查上：这一勾
// 对**任何会合并的任务**都要显示，而验收检查只在有验证站时才有活干。两者搅在一起的后果
// 实测过一次——没有验证站的任务打开确认框，默认值还没到手，框里已经写着「会提交」，按下去
// 后端却按项目设置走了「不提交」，git 语义跟用户看见的那句话正相反（第 1 轮审查 P1）。
// 所以现在：**没读到默认值之前不让按**（confirmDisabled 由调用方按 `pending` 接上）。
// 用列表接口而不是 `/projects/:id`：后者根本不存在（无头点检实测：框里当场显示「接口不
// 存在」），而列表本来就带着每个项目的全部设置，还顺带走了同一套可见性过滤。

export type AcceptCommitDefault = {
  /** 项目设置的当前值；null = 还没读到（读到之前一律不许确认） */
  value: boolean | null;
  error: string | null;
  /** 还在读、或读失败 —— 两种都不能按确认 */
  pending: boolean;
  reload: () => void;
};

export function useAcceptCommitDefault(projectId: string, enabled: boolean): AcceptCommitDefault {
  const [state, setState] = useState<{ key: string; value: boolean | null; error: string | null }>(
    { key: "", value: null, error: null },
  );
  const [attempt, setAttempt] = useState(0);
  const key = `${projectId}:${enabled}:${attempt}`;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api.projects().then(
      (list) => {
        const project = list.find((row) => row.id === projectId);
        if (!alive) return;
        setState(project
          ? { key, value: project.acceptCommit !== false, error: null }
          : { key, value: null, error: "读不到这个项目的设置（它可能刚被删除或你没有权限）" });
      },
      (error: unknown) => { if (alive) setState({ key, value: null, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { alive = false; };
  }, [key, enabled, projectId]);
  const current = state.key === key ? state : { value: null, error: null };
  return {
    value: current.value,
    error: current.error,
    pending: enabled && current.value === null,
    reload: useCallback(() => setAttempt((n) => n + 1), []),
  };
}
