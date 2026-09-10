import { useEffect, useRef, useState } from "react";
import { MagnifyingGlass, Plus, TerminalWindow, Trash } from "@phosphor-icons/react";
import type { ProjectView } from "@ash/shared";
import { MAX_PREVIEW_SCRIPT_LENGTH, MAX_PREVIEW_SERVICES, parsePreviewConfig, previewProxyEnabled, withoutBlankServices, type ProjectPreviewConfig, type PreviewServiceConfig } from "@ash/shared/preview";
import { Button } from "../components/ui.tsx";
import { useAuth } from "../auth/authContext.ts";
import { useHostInfo } from "../lib/useHostInfo.ts";
import { api } from "../lib/api.ts";
import { createClientId } from "../lib/clientId.ts";
import { ProjectPreviewHelp } from "./ProjectPreviewHelp.tsx";
import "./project-preview.css";

const emptyConfig = (): ProjectPreviewConfig => ({ mode: "script", proxy: "auto", services: [], primaryServiceId: null });
// 存量配置里可能留着以前没填完的空壳服务，进来先丢掉：它不该被展示成一条已有配置。
const loadConfig = (stored: ProjectPreviewConfig | null | undefined): ProjectPreviewConfig => stored ? withoutBlankServices(stored) : emptyConfig();

export function ProjectPreviewSettings({ project, onUpdated, notify }: {
  project: ProjectView;
  onUpdated: (project: ProjectView) => void;
  notify: (message: string) => void;
}) {
  const { state } = useAuth();
  const host = useHostInfo();
  const canManage = project.myRole === "admin";
  const [config, setConfig] = useState<ProjectPreviewConfig>(() => loadConfig(project.previewConfig));
  const [script, setScript] = useState(project.previewCommand ?? "");
  const [saved, setSaved] = useState(() => JSON.stringify({ config: loadConfig(project.previewConfig), script: project.previewCommand ?? "" }));
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detection, setDetection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const variable = (name: string) => host?.platform === "win32" ? `%${name}%` : `$${name}`;
  const selected = config.services.filter((s) => s.enabled);
  const dirty = saved !== JSON.stringify({ config, script });
  const proxied = previewProxyEnabled(config.proxy, state.mode === "multi");
  const patchService = (id: string, patch: Partial<PreviewServiceConfig>) => setConfig((current) => {
    const services = current.services.map((s) => s.id === id ? { ...s, ...patch } : s);
    const primaryServiceId = services.some((s) => s.id === current.primaryServiceId && s.enabled)
      ? current.primaryServiceId : services.find((s) => s.enabled && s.kind === "web")?.id ?? services.find((s) => s.enabled)?.id ?? null;
    return { ...current, services, primaryServiceId };
  });
  const detect = async () => {
    setDetecting(true);
    setError(null);
    try {
      const result = await api.detectPreviewServices(project.id);
      if (!active.current) return;
      setConfig((current) => {
        const existing = new Set(current.services.map((s) => s.id));
        const commands = new Set(current.services.map((s) => s.command));
        const added = result.services.filter((s) => !existing.has(s.id) && !commands.has(s.command));
        return { ...current, services: [...current.services, ...added].slice(0, 40) };
      });
      setDetection(result.services.length
        ? `检测到 ${result.services.length} 个候选${result.truncated ? "（仅列出前 40 个）" : ""}。请勾选需要启动的服务；已有编辑和选择会保留。`
        : "没有识别出常见服务。可以手动添加，或使用自定义脚本。");
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : "检测失败");
    } finally { if (active.current) setDetecting(false); }
  };
  const save = async () => {
    setError(null);
    let validated: ProjectPreviewConfig;
    try { validated = parsePreviewConfig(config)!; }
    catch (failure) { setError(failure instanceof Error ? failure.message : "配置无效"); return; }
    setBusy(true);
    try {
      const result = await api.updateProject(project.id, { previewCommand: script.trim() || null, previewConfig: validated });
      if (!active.current) return;
      const next = loadConfig(result.previewConfig);
      const command = result.previewCommand ?? "";
      setConfig(next); setScript(command); setSaved(JSON.stringify({ config: next, script: command }));
      onUpdated(result); notify("预览设置已保存，下次打开预览时生效");
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : "保存失败");
    } finally { if (active.current) setBusy(false); }
  };
  // data-settings-anchor：报错文案里的「设置 → 项目设置 → 预览」照着它落点（见 sections.ts）。
  return <section className="settings-section project-preview" data-settings-anchor="preview"><h2>预览</h2><div className="settings-card">
    <div className="settings-row preview-launch-row"><div><b>启动方式</b><small>在这里配置一次，任务里的「打开预览」按保存的方案启动。</small></div>
      <div className="preview-mode-choice" role="group" aria-label="预览启动方式">
        {([ ["script", "自定义脚本"], ["services", "选择服务"] ] as const).map(([value, label]) => <label key={value}>
          <input type="radio" name={`preview-mode-${project.id}`} checked={config.mode === value} disabled={!canManage || busy} onChange={() => setConfig({ ...config, mode: value })} />{label}
        </label>)}
      </div>
    </div>
    {config.mode === "script" ? <>
      <label className="settings-field preview-script-field"><span>启动脚本</span><ScriptEditor label="启动脚本" value={script} onChange={setScript} readOnly={!canManage || busy} rows={9} placeholder={`例如：\ncd web\nnpm run dev -- --port ${variable("PORT")}`} /></label>
      <div className="preview-help preview-script-help">
        <small>支持多行、缩进和完整脚本，也可以调用仓库里的脚本文件。留空延续原来的行为：只在恰好识别出一个服务时自动使用。</small>
        <small>脚本在任务工作区根目录执行。主服务使用 <code>{variable("PORT")}</code>；脚本内的其它服务可使用 <code>{variable("PORT2")}</code>～<code>{variable("PORT5")}</code> 和对应的 <code>{variable("URL2")}</code>～<code>{variable("URL5")}</code>。</small>
      </div>
    </> : <div className="preview-services-panel">
      <div className="preview-detect-actions">
        <Button disabled={!canManage || busy || detecting} onClick={() => void detect()}><MagnifyingGlass size={13} aria-hidden="true" />{detecting ? "检测中…" : "检测服务"}</Button>
        <Button disabled={!canManage || busy || config.services.length >= 40} onClick={() => setConfig({ ...config, services: [...config.services, { id: createClientId(), name: "新服务", command: "", enabled: false, kind: "web" }] })}><Plus size={13} aria-hidden="true" />手动添加</Button>
        {/* 「已选 0 / 8」曾被读成「检测到 8 个候选、选中 0 个」——分数写法天然承诺分母是
            候选数。8 是一次能同时启动的上限，跟检测结果无关，所以把它说完整。 */}
        <span>已选 {selected.length} 个 · 最多同时启动 {MAX_PREVIEW_SERVICES} 个</span>
      </div>
      <div className="preview-help"><small>检测读取已保存的项目目录中的常见启动配置，不运行命令。总启动脚本和子服务可能同时出现，请避免重复勾选。</small></div>
      {detection && <p className="preview-detection-result" role="status">{detection}</p>}
      {!config.services.length && <p className="preview-services-empty">点击「检测服务」列出候选，也可以手动添加。</p>}
      <div className="preview-service-list">{config.services.map((service) => <div className={`preview-service-card${service.enabled ? " is-selected" : ""}`} key={service.id} role="group" aria-label={`预览服务 ${service.name}`}>
        <div className="preview-service-heading">
          <label className="preview-service-toggle">
            <input type="checkbox" aria-label={`启动 ${service.name}`} checked={service.enabled} disabled={!canManage || busy || (!service.enabled && selected.length >= MAX_PREVIEW_SERVICES)} onChange={(e) => patchService(service.id, { enabled: e.target.checked })} />
          </label>
          <input className="preview-service-name" aria-label={`服务名称 ${service.name}`} value={service.name} maxLength={160} readOnly={!canManage || busy} onChange={(e) => patchService(service.id, { name: e.target.value })} />
          <div className="preview-service-options">
            <label className="preview-service-kind">用途 <select aria-label={`${service.name} 用途`} value={service.kind} disabled={!canManage || busy} onChange={(e) => patchService(service.id, { kind: e.target.value as PreviewServiceConfig["kind"] })}><option value="web">网页</option><option value="service">接口服务</option></select></label>
            <label className="preview-service-primary"><input type="radio" name={`preview-primary-${project.id}`} checked={config.primaryServiceId === service.id} disabled={!canManage || busy || !service.enabled} onChange={() => setConfig({ ...config, primaryServiceId: service.id })} />默认打开</label>
          </div>
          <Button className="preview-service-remove" variant="ghost" disabled={!canManage || busy} aria-label={`移除 ${service.name}`} onClick={() => setConfig((current) => ({ ...current, services: current.services.filter((s) => s.id !== service.id), primaryServiceId: current.primaryServiceId === service.id ? null : current.primaryServiceId }))}><Trash size={14} aria-hidden="true" /></Button>
        </div>
        <div className="preview-service-command">
          <TerminalWindow size={15} aria-hidden="true" />
          <ScriptEditor label={`${service.name} 启动脚本`} value={service.command} onChange={(command) => patchService(service.id, { command })} readOnly={!canManage || busy} rows={Math.min(8, Math.max(1, service.command.split("\n").length))} placeholder="输入启动命令…" />
        </div>
      </div>)}</div>
      <div className="preview-help"><small>每条脚本都从任务工作区根目录独立执行，使用自己的 <code>{variable("PORT")}</code>。已选服务按列表顺序对应 <code>{variable("URL1")}</code>、<code>{variable("URL2")}</code>…，可传给前端开发服务器的接口代理配置。它们是服务端内部地址。</small></div>
    </div>}
    <label className="settings-field preview-proxy-field"><span>通过 ash 反向代理访问</span>
      <select aria-label="通过 ash 反向代理访问" value={config.proxy} disabled={!canManage || busy} onChange={(e) => setConfig({ ...config, proxy: e.target.value as ProjectPreviewConfig["proxy"] })}>
        <option value="auto">跟随模式默认（{state.mode === "multi" ? "多人模式：开启" : "单人模式：关闭"}）</option>
        <option value="on">开启</option><option value="off">关闭</option>
      </select>
    </label>
    <div className="preview-help preview-proxy-help">
      <small>{proxied ? "当前使用反代：浏览器复用 ash 入口，无需开放每个服务的端口。预览页面跑在独立沙箱里，与 ash 的登录态隔离，只有一个例外——被预览的仓库就是这台 ash 自己、而且启动命令自己声明了「我的 /api 打到这台 ash 上」（ash 自带的「只起前端」启动方式会声明，多服务和自定义整栈脚本不会）时，/api 会由代理单独接回这台 ash 并替你带上当前这条会话，打开即登录态；否则你只会看到一个登录框，而在预览页里粘 key 比这危险得多（key 是长期凭证，会落到被预览的应用手上）。这条会话只出现在 /api 那一跳上，被预览的 dev server 一个字都收不到，页面本身也读不出来；代价是页面能借这条路以你的身份调 ash 的接口。你一登出它就失效，链接被别人拿去打开也不会继承。预览页面自己发出的请求所带的 Authorization（Bearer 等）会照常转发，从 ash 页面或命令行带进来的鉴权头不会（否则你的 ash key 会落到被预览的应用手上）；Basic/Digest 一律不转发，需要它们的应用请改用直连。localStorage、sessionStorage 和 document.cookie 由 ash 在页面内模拟——读写正常，但只活在当前这个页面：刷新或跳转即清空，页面写的 Cookie 也不会随请求发出，所以把登录态存在本地存储的应用每次刷新都要重新登录。IndexedDB、Service Worker 和站外接口在沙箱里用不了，依赖它们的应用请改用直连。" : "当前使用直连：浏览器直接访问服务端口。远程访问时，服务需监听可访问的网卡地址，并开放相应端口。"}</small>
      {proxied && <small>服务需要配置资源前缀时，可读取 <code>{variable("ASH_PREVIEW_BASE")}</code>。例如 Vite 可在启动参数中使用 <code>--base {variable("ASH_PREVIEW_BASE")}</code>。</small>}
    </div>
    <ProjectPreviewHelp isWindows={host?.platform === "win32"} />
    {error && <p className="preview-settings-error" role="alert">{error}</p>}
    {canManage && <div className="settings-card-foot"><span>保存后对下次打开的预览生效。运行状态和输出可在任务的预览日志里查看。</span><Button variant="primary" disabled={!dirty || busy || detecting} onClick={() => void save()}>{busy ? "保存中…" : "保存预览设置"}</Button></div>}
  </div></section>;
}

function ScriptEditor({ label, value, onChange, readOnly, rows, placeholder }: {
  label: string; value: string; onChange: (value: string) => void; readOnly: boolean; rows: number; placeholder?: string;
}) {
  return <textarea className="preview-script-editor mono" aria-label={label} value={value} rows={rows} readOnly={readOnly} placeholder={placeholder} spellCheck={false} wrap="off" maxLength={MAX_PREVIEW_SCRIPT_LENGTH} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => {
    if (e.key !== "Tab" || e.shiftKey || readOnly) return;
    e.preventDefault();
    const field = e.currentTarget;
    const start = field.selectionStart;
    onChange(value.slice(0, start) + "  " + value.slice(field.selectionEnd));
    requestAnimationFrame(() => field.setSelectionRange(start + 2, start + 2));
  }} />;
}
