import { useEffect, useState } from "react";
import type { AcceptClean } from "@ash/shared/workflow";
import { ACCEPT_CLEAN, ACCEPT_CLEAN_LABELS } from "@ash/shared/workflow";
import type { AppSettings, ProjectView, Task, TaskListItem } from "@ash/shared";
import { DEFAULT_APP_SETTINGS } from "@ash/shared";
import { ArrowCounterClockwise, Archive } from "@phosphor-icons/react";
import { useIsInstanceAdmin, useIsMultiUser } from "../auth/authContext.ts";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { toggleArchive } from "../lib/archive.ts";

// 归档那一下会不会连磁盘一起收。实例面的设置（不是一人一份）：它改的是这台机器上
// 归档的行为，多人模式下只有实例管理员能动 —— 真正的闸在服务端，这里只是别把改不动
// 的东西显示成能改。
const CLEAN_HINTS: Record<AcceptClean, string> = {
  all: "分支只用 git branch -d：还有未合并提交的分支一定留下来，不会强删",
  worktree: "只删工作目录，分支一律保留（取回后重新运行会按分支重建工作区）",
  none: "归档只是从列表里收起来，磁盘上原样不动",
};

export function ArchiveSettings({ project, tasks, onTaskUpdated, notify }: {
  project: ProjectView;
  tasks: TaskListItem[];
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  // 两个 hook 都要无条件调用（`||` 短路会让调用顺序随模式变化，React 直接报错）
  const isMulti = useIsMultiUser();
  const isInstanceAdmin = useIsInstanceAdmin();
  const canManageInstance = !isMulti || isInstanceAdmin;
  useEffect(() => {
    api.settings()
      .then(setSettings)
      .catch((error) => notify(error instanceof Error ? error.message : "归档设置读取失败"))
      .finally(() => setLoading(false));
  }, [notify]);

  const archived = tasks.filter((task) => task.projectId === project.id && task.parentId === null && task.archived).sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
  const restore = async (task: TaskListItem) => {
    try { onTaskUpdated(await toggleArchive(task, notify)); }
    catch (error) { notify(error instanceof Error ? error.message : "任务取回失败"); }
  };
  const patchClean = async (archiveClean: AcceptClean) => {
    try { setSettings(await api.patchSettings({ archiveClean })); notify("归档清理方式已更新"); }
    catch (error) { notify(error instanceof Error ? error.message : "归档设置保存失败"); }
  };
  return (
    <>
      <header className="settings-heading"><div><h1>已归档</h1><p>归档会结束任务在主工作区的生命周期；历史内容仍可查看并取回。</p></div></header>
      <section className="settings-section">
        <h2>归档时怎么处理工作区</h2>
        <div className="settings-card">
          <div className="settings-row">
            <div>
              <b>归档一并清理 worktree 和分支</b>
              <small>{CLEAN_HINTS[settings.archiveClean]}</small>
            </div>
            <select
              value={settings.archiveClean}
              disabled={loading || !canManageInstance}
              onChange={(event) => void patchClean(event.target.value as AcceptClean)}
            >
              {ACCEPT_CLEAN.map((clean) => <option key={clean} value={clean}>{ACCEPT_CLEAN_LABELS[clean]}</option>)}
            </select>
          </div>
        </div>
        {!canManageInstance && <p className="settings-note">这一项对整台机器生效，只有实例管理员能改。</p>}
      </section>
      <section className="settings-section"><h2>{archived.length} 个归档任务</h2><div className="settings-card settings-archive-card">
        {!archived.length && <div className="settings-empty"><Archive size={22} /><span>这里还没有归档任务。</span></div>}
        {archived.map((task) => <article key={task.id}><span className="settings-archive-icon"><Archive size={14} /></span><div><b>{task.title}</b><small>{task.mode === "team" ? "团队" : task.mode === "duet" ? "讨论" : "任务"} · {task.archivedAt ? new Date(task.archivedAt).toLocaleString("zh-CN") : "归档时间未知"}</small></div><Button onClick={() => void restore(task)}><ArrowCounterClockwise size={13} />取回</Button></article>)}
      </div></section>
    </>
  );
}
