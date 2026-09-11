import { useCallback, useEffect, useRef, useState } from "react";
import { PREVIEW_ANNOTATION_PROTOCOL } from "@ash/shared/page-annotation";
import type { PreviewAnnotationCommand, PreviewAnnotationHandshake, PreviewAnnotationMode, PreviewAnnotationTool } from "@ash/shared/page-annotation";
import { createClientId } from "../lib/clientId.ts";
import { parsePreviewMessage, type WorkspaceAnnotationEvent } from "./previewMessages.ts";

type Phase = "connecting" | "ready" | "switching" | "failed";
export function usePreviewChannel(source: string | null, nextNumber: number, receive: (event: WorkspaceAnnotationEvent, documentId: string) => void) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const receiveRef = useRef(receive);
  const numberRef = useRef(nextNumber);
  receiveRef.current = receive;
  numberRef.current = nextNumber;
  const [phase, setPhase] = useState<Phase>("connecting");
  const [documentId, setDocumentId] = useState("");
  const [mode, setMode] = useState<PreviewAnnotationMode>("browse");
  const [tool, setTool] = useState<PreviewAnnotationTool>("element");
  const pending = useRef(0);
  const heartbeat = useRef(0);
  const epoch = useRef("");

  const close = useCallback(() => {
    const port = portRef.current;
    if (port) {
      port.postMessage({ type: "disconnect" } satisfies PreviewAnnotationCommand);
      port.close();
    }
    portRef.current = null;
    epoch.current = "";
  }, []);
  useEffect(() => {
    close(); setPhase("connecting"); setMode("browse"); setDocumentId("");
    pending.current = Date.now(); heartbeat.current = Date.now();
    const timer = window.setInterval(() => {
      if ((pending.current && Date.now() - pending.current > 8000) || Date.now() - heartbeat.current > 8000) {
        setPhase("failed");
      }
    }, 1000);
    return () => { window.clearInterval(timer); close(); };
  }, [close, source]);

  const connect = useCallback(() => {
    close();
    const target = iframeRef.current?.contentWindow;
    if (!target || !source) return;
    const channel = new MessageChannel();
    const id = createClientId();
    epoch.current = id;
    portRef.current = channel.port1;
    setDocumentId(id); setPhase("connecting"); setMode("browse"); setTool("element");
    pending.current = Date.now(); heartbeat.current = Date.now();
    channel.port1.onmessage = (message: MessageEvent<unknown>) => {
      if (epoch.current !== id) return;
      const event = parsePreviewMessage(message.data);
      if (!event) return;
      heartbeat.current = Date.now();
      if (event.type === "ready") {
        channel.port1.postMessage({ type: "configure", mode: "browse", tool: "element" } satisfies PreviewAnnotationCommand);
      } else if (event.type === "configured") {
        pending.current = 0; setMode(event.mode); setTool(event.tool); setPhase("ready");
      }
      receiveRef.current(event, id);
    };
    channel.port1.onmessageerror = () => { if (epoch.current === id) setPhase("failed"); };
    channel.port1.start();
    // A port is transferred only to this frame; opaque origins cannot be authenticated with origin strings.
    target.postMessage({ protocol: PREVIEW_ANNOTATION_PROTOCOL, nextNumber: numberRef.current } satisfies PreviewAnnotationHandshake, "*", [channel.port2]);
  }, [close, source]);

  const send = (command: PreviewAnnotationCommand) => {
    if (!portRef.current || (phase !== "ready" && command.type !== "remove")) return;
    if (command.type === "configure") { pending.current = Date.now(); setPhase("switching"); }
    portRef.current.postMessage(command);
  };
  return { iframeRef, documentId, phase, mode, tool, connect, send };
}
