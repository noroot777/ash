// 右侧「服务」那一格：智能体用 start_dev_service 托管起来的那个服务。上面一块是它是什么、在哪、
// 怎么起的，下面整块是它的输出；打开、在浏览器里看、停止 / 重启挂在面板头上。
import { useEffect, useRef, useState } from "react";
import { ArrowSquareOut, Globe, Play, Stop } from "@phosphor-icons/react";
import { id, request } from "../lib/apiClient.ts";
import { InspectorHeadActions, useInspectorNav } from "../inspector/index.ts";
import { InspNone, InspTool } from "../inspector/parts.tsx";
import { runtimeApi } from "./runtimeApi.ts";
import { runtimeErrorText, type TaskRuntime } from "./useTaskRuntime.ts";
import "./task-runtime.css";

export function serviceStatus(runtime: TaskRuntime) {
  const service = runtime.state.service;
  if (!service) return null;
  if (service.starting) return { tone: "starting", text: "启动中" } as const;
  if (runtime.serviceReady) return { tone: "ready", text: "运行中" } as const;
  return service.services?.[0]?.status === "failed" ? { tone: "failed", text: "启动失败" } as const : { tone: "stopped", text: "已停止" } as const;
}

export function ServiceInspector({ runtime }: { runtime: TaskRuntime }) {
  const { state, serviceReady, busy, perform, taskId } = runtime;
  const service = state.service;
  const nav = useInspectorNav();
  const log = useServiceLog(taskId, !!service);
  const logRef = useRef<HTMLPreElement>(null);
  const stuck = useRef(true);
  useEffect(() => {
    const node = logRef.current;
    if (node && stuck.current) node.scrollTop = node.scrollHeight;
  }, [log]);
  if (!service) {
    return <div className="insp-pane"><InspNone>智能体用托管工具启动的服务会出现在这里，任务结束后仍可继续体验。</InspNone></div>;
  }
  const status = serviceStatus(runtime)!;
  const name = service.services?.[0]?.name || "服务";
  const openBrowser = () => {
    nav?.openTab("browser");
    if (state.browser?.status !== "ready") void perform(() => runtimeApi.action(taskId, undefined, { action: "open" }));
  };
  return (
    <div className="runtime-service">
      <InspectorHeadActions>
        {serviceReady && <InspTool label="在共享浏览器里查看" onClick={openBrowser}><Globe size={14} /></InspTool>}
        {serviceReady && <a className="insp-tool" href={service.url!} target="_blank" rel="noreferrer" aria-label="打开"><ArrowSquareOut size={14} /></a>}
        {service.running
          ? <InspTool label="停止" disabled={busy} onClick={() => void perform(() => runtimeApi.stop(taskId))}><Stop size={14} /></InspTool>
          : service.command && <InspTool label="重启" disabled={busy} onClick={() => void perform(() => runtimeApi.start(taskId, service.command!))}><Play size={14} /></InspTool>}
      </InspectorHeadActions>
      <header className="runtime-service-head">
        <div className="runtime-service-name">
          <span className={`runtime-status is-${status.tone}`} aria-hidden="true" />
          <strong>{name}</strong>
          <span className="runtime-service-state">{status.text}</span>
        </div>
        {/* 链接走 ash 的代理地址（别的设备也打得开）；写出来的是人认得的本机端口。 */}
        {serviceReady && <a className="runtime-service-url" href={service.url!} target="_blank" rel="noreferrer">
          {service.port ? `localhost:${service.port}` : service.url}
        </a>}
        {service.command && <code className="runtime-service-command">{service.command}</code>}
      </header>
      {runtime.error && <p className="runtime-error" role="alert">{runtime.error}</p>}
      <pre ref={logRef} className="runtime-log" role="region" aria-label="服务日志"
        onScroll={(event) => {
          const node = event.currentTarget;
          stuck.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        }}>{log || <span className="runtime-log-empty">等待服务输出…</span>}</pre>
    </div>
  );
}

function useServiceLog(taskId: string, enabled: boolean) {
  const [log, setLog] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await request<{ text: string }>(`/tasks/${id(taskId)}/preview?log=1`);
        if (!canceled) setLog(result.text);
      } catch (reason) { if (!canceled) setLog(runtimeErrorText(reason)); }
      if (!canceled) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { canceled = true; clearTimeout(timer); };
  }, [taskId, enabled]);
  return log;
}
