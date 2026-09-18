import { useEffect, useRef, useState } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import type { ProjectView } from "@ash/shared";
import { MAX_PROJECT_COMMANDS, parseProjectCommands, type ProjectCommandConfig } from "@ash/shared/project-commands";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { createClientId } from "../lib/clientId.ts";
import "./project-commands.css";

// 项目「常用命令」配置节。启停/重启的操作面在全局状态栏(workspace/StatusBar.tsx),
// 这里只管配置 —— 跟预览的分界见 shared/src/project-commands.ts 顶部。
export function ProjectCommandsSettings({ project, onUpdated, notify }: {
  project: ProjectView;
  onUpdated: (project: ProjectView) => void;
  notify: (message: string) => void;
}) {
  const canManage = project.myRole === "admin";
  const [commands, setCommands] = useState<ProjectCommandConfig[]>(() => project.commandsConfig ?? []);
  const [saved, setSaved] = useState(() => JSON.stringify(project.commandsConfig ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const dirty = saved !== JSON.stringify(commands);
  const patch = (id: string, part: Partial<ProjectCommandConfig>) =>
    setCommands((current) => current.map((command) => command.id === id ? { ...command, ...part } : command));

  const save = async () => {
    setError(null);
    let validated: ProjectCommandConfig[] | null;
    try { validated = parseProjectCommands(commands); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "配置无效"); return; }
    setBusy(true);
    try {
      const result = await api.updateProject(project.id, { commandsConfig: validated?.length ? validated : null });
      if (!active.current) return;
      const next = result.commandsConfig ?? [];
      setCommands(next);
      setSaved(JSON.stringify(next));
      onUpdated(result);
      notify("常用命令已保存，状态栏里立即可用");
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : "保存失败");
    } finally { if (active.current) setBusy(false); }
  };

  return <section className="settings-section project-commands" data-settings-anchor="commands"><h2>常用命令</h2><div className="settings-card settings-card--pad">
    <div className="project-commands__intro">
      <small>dev server、watch 这类常驻服务：配置一次，在底部状态栏一键启动/停止/重启，日志落在终端抽屉的专属 tab 里。</small>
      <small>命令在项目目录（主仓当前检出的分支）用你的 shell 执行，端口按项目自己的配置来 —— 要「借端口在任务分支上看效果」用预览，不用这里。</small>
    </div>
    {commands.map((command) => (
      <div className="project-commands__row" key={command.id}>
        <input
          className="project-commands__name"
          value={command.name}
          placeholder="名称（如 web dev）"
          aria-label="命令名称"
          disabled={!canManage || busy}
          onChange={(event) => patch(command.id, { name: event.target.value })}
        />
        <div className="project-commands__scripts">
          <input
            value={command.command}
            placeholder="启动命令（如 npm -w web run dev）"
            aria-label="启动命令"
            spellCheck={false}
            disabled={!canManage || busy}
            onChange={(event) => patch(command.id, { command: event.target.value })}
          />
          <input
            value={command.restartCommand ?? ""}
            placeholder="重启命令，留空 = 杀掉进程再跑一遍启动命令"
            aria-label="重启命令"
            spellCheck={false}
            disabled={!canManage || busy}
            onChange={(event) => patch(command.id, { restartCommand: event.target.value || null })}
          />
        </div>
        <button
          type="button"
          className="project-commands__remove"
          aria-label={`删除 ${command.name || "这条命令"}`}
          disabled={!canManage || busy}
          onClick={() => setCommands((current) => current.filter((item) => item.id !== command.id))}
        ><Trash size={14} /></button>
      </div>
    ))}
    {commands.length === 0 && <p className="project-commands__empty">还没有常用命令。</p>}
    <div className="project-commands__actions">
      <Button
        disabled={!canManage || busy || commands.length >= MAX_PROJECT_COMMANDS}
        onClick={() => setCommands((current) => [...current, { id: createClientId(), name: "", command: "", restartCommand: null }])}
      ><Plus size={13} aria-hidden="true" />添加命令</Button>
      <span className="project-commands__count">{commands.length} / {MAX_PROJECT_COMMANDS} 条</span>
      <Button variant="primary" disabled={!canManage || busy || !dirty} onClick={() => void save()}>
        {busy ? "保存中…" : "保存"}
      </Button>
    </div>
    {error && <p className="project-commands__error" role="alert">{error}</p>}
  </div></section>;
}
