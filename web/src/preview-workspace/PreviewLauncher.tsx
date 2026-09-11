import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { FreeWorkflowPreviewState } from "@ash/shared/free-workflow";
import { MAX_PREVIEW_SCRIPT_LENGTH, type WorkspacePreviewInput } from "@ash/shared/preview";
import { request } from "../lib/apiClient.ts";
import { createPreviewLaunchController, type PreviewLaunchState } from "./previewLaunchController.ts";

export function PreviewLauncher({ taskId, preview, refresh, hint }: {
  taskId: string; preview: FreeWorkflowPreviewState | null; refresh: () => Promise<void>; hint?: string;
}) {
  const controller = useMemo(() => createPreviewLaunchController(taskId, refresh), [taskId, refresh]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [logs, setLogs] = useState(false);
  useEffect(() => {
    controller.activate();
    const timer = window.setInterval(() => void controller.load(), 5000);
    return () => { controller.dispose(); window.clearInterval(timer); };
  }, [controller]);
  const starting = !!preview?.starting || state.action === "opening";
  return <section className="preview-launcher" aria-label="启动页面预览">
    <PreviewLaunchOptions state={preview ? state : { ...state, loading: true }} starting={starting} stopped={preview?.services?.some((s) => s.status === "stopped") ?? false}
      failed={preview?.services?.some((s) => s.status === "failed") ?? false}
      hint={hint} restarting={!!preview?.running && !preview.starting}
      onStart={(input) => void controller.start(input, preview)} onCancel={() => void controller.cancel()} onRetry={() => void controller.load()} />
    {(preview?.hasLog || starting || state.error) && <button type="button" aria-expanded={logs} onClick={() => setLogs(!logs)}>{logs ? "收起预览日志" : "查看预览日志"}</button>}
    {logs && <PreviewLaunchLog taskId={taskId} />}
  </section>;
}

export function PreviewLaunchOptions({ state, starting, stopped, failed = false, hint, restarting = false, onStart, onCancel, onRetry }: {
  state: PreviewLaunchState; starting: boolean; stopped: boolean; failed?: boolean; hint?: string; restarting?: boolean;
  onStart: (input: Omit<WorkspacePreviewInput, "workspace">) => void; onCancel: () => void; onRetry: () => void;
}) {
  const [command, setCommand] = useState("");
  const [stepId, setStepId] = useState("");
  const { info, action } = state;
  const selectedStep = info?.steps.find((s) => s.id === stepId) ?? info?.steps[0];
  const busy = starting || !!action;
  const blocked = busy || state.loading || !info || !!info.reason;
  const start = (input: Omit<WorkspacePreviewInput, "workspace">) => onStart({ ...input, stepId: selectedStep?.id });
  return <>
    <h3>{starting ? "正在启动页面预览…" : info?.directory === null ? "无法启动页面预览" : restarting ? "以代理方式在工作区重启" : "在工作区启动预览"}</h3>
    <p role="status">{state.loading ? "正在检查任务工作目录与预览候选…" : starting
      ? "正在准备依赖并等待服务就绪，就绪后会自动接入页面。可以查看日志或取消启动。"
      : info?.reason || state.notice || (failed ? "上次预览未能启动或已退出，请查看预览日志后重试。"
        : stopped ? "上次预览已停止，可重新启动，或使用右侧截图批注。" : hint || "选择本次要看的页面，启动后即可浏览和标注。")}</p>
    {state.error && <pre className="preview-launch-error" role="alert">{state.error}</pre>}
    {busy && <button type="button" disabled={action === "canceling"} onClick={onCancel}>{action === "canceling" ? "取消中…" : "取消启动"}</button>}
    {!state.loading && !info && <button type="button" onClick={onRetry}>重新读取候选</button>}
    {info?.directory && !info.reason && <>
      <small className="preview-launch-directory">任务目录：{info.directory}</small>
      {info.kind === "workflow" && info.steps.length > 1 && <label>预览步骤<select aria-label="预览步骤" value={selectedStep?.id} disabled={busy} onChange={(e) => setStepId(e.target.value)}>
        {info.steps.map((step, index) => <option key={step.id} value={step.id}>预览 {index + 1} · {step.command}</option>)}
      </select></label>}
      {selectedStep && <div className="preview-launch-candidate"><strong>工作流预览命令</strong><pre>{selectedStep.command}</pre>
        <button type="button" disabled={blocked} onClick={() => start({})}>{restarting ? "重启工作流预览" : "启动工作流预览"}</button></div>}
      {info.configured && <div className="preview-launch-candidate"><strong>已保存的项目预览配置</strong><pre>{info.configured.command}</pre>
        <button type="button" disabled={blocked} onClick={() => start(info.configured!)}>{restarting ? "按已保存配置重启" : "按已保存配置启动"}</button></div>}
      <div className="preview-launch-candidates" aria-label="可用预览候选">{info.candidates.map((candidate) => <div className="preview-launch-candidate" key={candidate.id}>
        <strong>{candidate.name}</strong><pre>{candidate.command}</pre>
        {candidate.requiresSelection && <small>静态 HTML 不经过构建，已有产物可能过期；请确认这是本次页面。启动需要 Python 3，没有 index.html 时会显示文件列表。</small>}
        <button type="button" disabled={blocked} onClick={() => start({ command: candidate.command })}>启动 {candidate.name}</button>
      </div>)}</div>
      {!info.candidates.length && <p>未识别出常见服务或静态页面，可填写启动命令。</p>}
      {info.truncated && <small>仅显示前 40 个候选。</small>}
      <details className="preview-launch-custom" open={!info.candidates.length && !info.configured && !selectedStep}>
        <summary>自填启动命令</summary>
        <label>本次预览命令<textarea aria-label="本次预览命令" value={command} maxLength={MAX_PREVIEW_SCRIPT_LENGTH} disabled={busy}
          rows={4} spellCheck={false} onChange={(e) => setCommand(e.target.value)} placeholder="输入在任务目录执行的启动脚本，可包含 cd 和多行命令" /></label>
        <small>仅用于本次预览。脚本从任务目录运行，端口使用 ash 提供的 PORT 环境变量。</small>
        <button type="button" disabled={blocked || !command.trim()} onClick={() => start({ command: command.trim() })}>启动自填命令</button>
      </details>
    </>}
    {!starting && <p className="preview-launch-fallback">无法启动或页面不支持内嵌预览时，可使用右侧「改用截图批注」。</p>}
  </>;
}

function PreviewLaunchLog({ taskId }: { taskId: string }) {
  const [text, setText] = useState("正在读取预览日志…");
  useEffect(() => {
    let active = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const log = await request<{ text: string; exists: boolean }>(`/tasks/${encodeURIComponent(taskId)}/preview?log=1`);
        if (active) setText(log.exists ? log.text : "尚无预览日志，服务启动后会自动显示。");
      } catch (error) { if (active) setText(error instanceof Error ? error.message : String(error)); }
      finally { pending = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [taskId]);
  return <pre className="preview-launch-log" aria-label="预览启动日志">{text}</pre>;
}
