import { useCallback, useEffect, useRef, useState } from "react";
import { useServerEvents } from "../lib/events.ts";
import { api } from "../lib/api.ts";

// 「这一次合并完要不要替我提交」——确认层里「提交」那一勾（单任务、统一验收、重新合一次共用）。
//
// 它的默认值是**项目设置**（项目设置 → 验收 → 「验收合并后提交代码」）的当前值。验收确认层里
// 点了确认，层里那一勾就写回这份设置（AcceptanceControls → api.rememberAccept，要项目管理权限；
// 没有权限时层里写明只管这一次）——「上次怎么勾的」和「项目默认」是同一个值，不另存一份互相打架。
// 「重新合一次」只读它、不写它：那不是一次验收确认。
//
// 读默认值走的是项目资源本身（GET /projects 里挑出这一个）而不是搭在验收检查上：这一勾
// 对**任何会合并的任务**都要显示，而验收检查只在有验证站时才有活干。两者搅在一起的后果
// 实测过一次——没有验证站的任务打开确认框，默认值还没到手，框里已经写着「会提交」，按下去
// 后端却按项目设置走了「不提交」，git 语义跟用户看见的那句话正相反（第 1 轮审查 P1）。
// 所以现在：**没读到默认值之前不让按**（confirmDisabled 由调用方按 `pending` 接上）。
// 用列表接口而不是 `/projects/:id`：后者根本不存在（无头点检实测：框里当场显示「接口不
// 存在」），而列表本来就带着每个项目的全部设置，还顺带走了同一套可见性过滤。

export type AcceptCommitDefault = {
  /**
   * 项目设置最近读到的值；null = 还没读到或这一次读失败（读到之前一律不许确认）。重读期间留着上一份
   * 给勾画出来，但 `pending` 为真，没手动改过这一勾的那一按不许确认。
   */
  value: boolean | null;
  error: string | null;
  /** 还在读、正在重读、或读失败 —— 都不能拿 value 当这一按的默认去确认 */
  pending: boolean;
  reload: () => void;
};

// 打开着的这一层也要追平：别处（设置页、另一个页面的确认层）改了这个项目的默认，没手动动过这一勾的
// 确认层得跟着变，不能拿打开那一刻的旧值去验收、还把旧值写回去（第 1 轮审查 F1）。所以收到这个项目的
// project.updated、或者断线重连之后，打开着的那几处（验收确认层、重新合一次）都重读一次。
export function useAcceptCommitDefault(projectId: string, enabled: boolean): AcceptCommitDefault {
  const [state, setState] = useState<{ key: string; value: boolean | null; error: string | null }>(
    { key: "", value: null, error: null },
  );
  const [attempt, setAttempt] = useState(0);
  const key = `${projectId}:${enabled}:${attempt}`;
  const bump = useCallback(() => setAttempt((n) => n + 1), []);
  const connected = useServerEvents((event) => {
    if (enabled && event.type === "project.updated" && event.projectId === projectId) bump();
  });
  const wasConnected = useRef(connected);
  useEffect(() => {
    // 断线期间漏掉的变化没有事件可等：连回来就当它变过。
    if (connected && !wasConnected.current && enabled) bump();
    wasConnected.current = connected;
  }, [connected, enabled, bump]);
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
  // 关掉就作废手上那份：确认时可能刚把它写回了项目设置（或者别处改了），下一次打开必须重读，
  // 不能先拿上一次读到的值放开确认键 —— key 在两次打开之间是同一个，光靠它分不出新旧。
  useEffect(() => { if (!enabled) setState({ key: "", value: null, error: null }); }, [enabled]);
  const fresh = state.key === key;
  return {
    value: enabled ? state.value : null,
    error: fresh ? state.error : null,
    pending: enabled && (!fresh || state.value === null),
    reload: bump,
  };
}
