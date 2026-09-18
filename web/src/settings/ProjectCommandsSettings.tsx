import { useEffect, useRef, useState } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import type { ProjectView } from "@ash/shared";
import {
  MAX_PROJECT_COMMANDS,
  parseProjectCommands,
  type ProjectCommandConfig,
  type ProjectCommandsConfig,
} from "@ash/shared/project-commands";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { createClientId } from "../lib/clientId.ts";
import "./project-commands.css";

// 项目「常用命令」配置节。操作面在全局状态栏(workspace/StatusBar.tsx):
//   启动/重启 —— 项目级一对命令,对应弹层头部的 ▶/⟳ 图标按钮(没配置就置灰);
//   常用命令 —— 名称 + 命令的普通条目,重启一律「杀掉进程再跑一遍」,所以**不逐条**
//   配重启命令(用户点名去掉那个输入框)。
// 跟预览的分界见 shared/src/project-commands.ts 顶部。
export function ProjectCommandsSettings({ project, onUpdated, notify }: {
  project: ProjectView;
  onUpdated: (project: ProjectView) => void;
  notify: (message: string) => void;
}) {
  const canManage = project.myRole === "admin";
  const stored = project.commandsConfig ?? null;
  const [service, setService] = useState(() => ({
    command: stored?.service?.command ?? "",
    restartCommand: stored?.service?.restartCommand ?? "",
  }));
  const [commands, setCommands] = useState<ProjectCommandConfig[]>(() => stored?.commands ?? []);
  const [saved, setSaved] = useState(() => JSON.stringify(stored));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const draft = (): unknown => ({
    service: service.command.trim() || service.restartCommand.trim()
      ? { command: service.command, restartCommand: service.restartCommand || null }
      : null,
    commands,
  });
  // dirty 用「解析后的形状」比,输入框里的空白/空壳不算改动;解析不过一律算 dirty,
  // 让保存按钮可按、把错误说出来。
  const dirty = (() => {
    try { return saved !== JSON.stringify(parseProjectCommands(draft())); }
    catch { return true; }
  })();
  const patch = (id: string, part: Partial<ProjectCommandConfig>) =>
    setCommands((current) => current.map((command) => command.id === id ? { ...command, ...part } : command));

  const save = async () => {
    setError(null);
    let validated: ProjectCommandsConfig | null;
    try { validated = parseProjectCommands(draft()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "配置无效"); return; }
    setBusy(true);
    try {
      const result = await api.updateProject(project.id, { commandsConfig: validated });
      if (!active.current) return;
      const next = result.commandsConfig ?? null;
      setService({ command: next?.service?.command ?? "", restartCommand: next?.service?.restartCommand ?? "" });
      setCommands(next?.commands ?? []);
      setSaved(JSON.stringify(next));
      onUpdated(result);
      notify("常用命令已保存，状态栏里立即可用");
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : "保存失败");
    } finally { if (active.current) setBusy(false); }
  };

  return <section className="settings-section project-commands" data-settings-anchor="commands"><h2>常用命令</h2><div className="settings-card settings-card--pad">
    <div className="project-commands__intro">
      <small>命令都在项目目录（主仓当前检出的分支）用你的 shell 执行，端口按项目自己的配置来 —— 要「借端口在任务分支上看效果」用预览，不用这里。</small>
    </div>

    <div className="project-commands__service">
      <div className="project-commands__service-head">
        <b>启动 / 重启</b>
        <small>项目的 dev server：配置后，状态栏「常用命令」弹层顶部的启动 / 重启按钮即可一键启停（G C 快速打开）。</small>
      </div>
      <div className="project-commands__service-fields">
        <input
          value={service.command}
          placeholder="启动命令（如 npm -w web run dev）"
          aria-label="启动命令"
          spellCheck={false}
          disabled={!canManage || busy}
          onChange={(event) => setService((current) => ({ ...current, command: event.target.value }))}
        />
        <input
          value={service.restartCommand}
          placeholder="重启命令，留空 = 杀掉进程再跑一遍启动命令"
          aria-label="重启命令"
          spellCheck={false}
          disabled={!canManage || busy}
          onChange={(event) => setService((current) => ({ ...current, restartCommand: event.target.value }))}
        />
      </div>
    </div>

    <div className="project-commands__list-head">
      <b>命令列表</b>
      <small>watch、tunnel、构建脚本这些常驻/常用的，在弹层里逐条启停；重启 = 杀掉进程再跑一遍。</small>
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
            placeholder="命令（如 npm -w web run dev）"
            aria-label="命令"
            spellCheck={false}
            disabled={!canManage || busy}
            onChange={(event) => patch(command.id, { command: event.target.value })}
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
        onClick={() => setCommands((current) => [...current, { id: createClientId(), name: "", command: "" }])}
      ><Plus size={13} aria-hidden="true" />添加命令</Button>
      <span className="project-commands__count">{commands.length} / {MAX_PROJECT_COMMANDS} 条</span>
      <Button variant="primary" disabled={!canManage || busy || !dirty} onClick={() => void save()}>
        {busy ? "保存中…" : "保存"}
      </Button>
    </div>
    {error && <p className="project-commands__error" role="alert">{error}</p>}
  </div></section>;
}
