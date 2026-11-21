import { useEffect, useState } from "react";
import type { ComputerUseFrame } from "@navi/shared/task-runtime";

type PreviewMessage = { action: string; id: string; taskId?: string; sessionId?: string; turnStartedAt?: string };
type PreviewWindow = Window & { webkit?: { messageHandlers?: { naviComputerPreview?: { postMessage: (message: PreviewMessage) => void } } } };
type LiveState = { source?: string; error?: string; permission?: boolean; ended?: boolean };

export function useComputerLivePreview(taskId: string, frame: ComputerUseFrame) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<LiveState>({});
  const [request, setRequest] = useState<PreviewMessage | null>(null);
  const bridge = (window as PreviewWindow).webkit?.messageHandlers?.naviComputerPreview;
  const identity = `${taskId}:${frame.sessionId}:${frame.turnStartedAt}:${frame.target?.application}:${frame.target?.windowTitle}`;
  const [owner, setOwner] = useState(identity);
  const visible = owner === identity ? state : {};
  useEffect(() => {
    setOwner(identity); setState({}); setRequest(null);
    if (!bridge || !frame.target) return;
    const current = { id: crypto.randomUUID(), taskId, sessionId: frame.sessionId, turnStartedAt: frame.turnStartedAt };
    const post = (action: string) => bridge.postMessage({ ...current, action });
    const receive = (event: Event) => {
      const payload = (event as CustomEvent<Record<string, unknown>>).detail;
      if (!payload || payload.id !== current.id) return;
      if (payload.state === "frame" && typeof payload.image === "string" && /^data:image\/jpeg;base64,/.test(payload.image)) {
        setState({ source: payload.image });
      } else if (payload.state === "ended") {
        setState({ ended: true });
      } else if (payload.state === "error" || payload.state === "permission") {
        setState({ error: typeof payload.error === "string" ? payload.error : "实时画面暂时不可用", permission: payload.state === "permission" });
      }
    };
    const resume = () => setRetry((value) => value + 1);
    window.addEventListener("navi:computer-preview", receive);
    window.addEventListener("focus", resume);
    setRequest({ ...current, action: "start" });
    post("start");
    const heartbeat = window.setInterval(() => post("heartbeat"), 1000);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("navi:computer-preview", receive);
      window.removeEventListener("focus", resume);
      post("stop");
    };
  }, [identity, retry]);
  return {
    ...visible,
    error: visible.error || (!bridge ? "实时画面需要新版 macOS 桌面版" : !frame.target ? "未取得目标应用，无法连接实时画面" : ""),
    requestPermission: () => { if (request) bridge?.postMessage({ ...request, action: "permission" }); },
    retry: () => setRetry((value) => value + 1),
  };
}
