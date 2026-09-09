import { useEffect, useRef } from "react";
import type { Notify } from "../lib/notify.ts";
import { gitOpLabel } from "./projectGitModel.ts";
import { isProjectGitPanelOpen, onProjectGitSettled } from "./projectGitRuns.ts";

/**
 * 项目主仓 git 操作落定时的**唯一播报口**，挂在 WorkspaceShell 上。
 *
 * 为什么不放在那颗分支胶囊里：胶囊只跟着当前项目挂载。而「操作跑到一半手滑点了别处」里
 * 最常见的那个别处，恰恰是**切到另一个项目**——那一刻胶囊连同它的订阅一起卸载，旧项目
 * 的 pull 跑完了就没人认领了。挂在这一层，谁的操作落定都听得见。
 *
 * 两件事：外面那份 `ProjectHealth` 得重拉（胶囊上的分支名从它来，不刷就停在操作之前），
 * 以及浮层没开着时补一句话——成功失败都不许无声无息。
 */
export function useProjectGitAnnouncer(notify: Notify, onChanged: () => void): void {
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  useEffect(() => onProjectGitSettled(({ projectId, kind, message, error }) => {
    const silent = isProjectGitPanelOpen(projectId);
    if (error) {
      // 失败原因常常是 git 自己那几行输出，两秒多看不完，钉住让用户自己收。
      if (!silent) notifyRef.current(`${gitOpLabel(kind)}失败：${error}`, { sticky: true });
      return;
    }
    changedRef.current();
    if (!silent) notifyRef.current(message ?? `${gitOpLabel(kind)}完成`);
  }), []);
}
