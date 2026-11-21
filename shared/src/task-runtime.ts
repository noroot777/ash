import type { FreeWorkflowPreviewState } from "./free-workflow.ts";

export type BrowserControl = "agent" | "user";
export type BrowserDisplayMode = "responsive" | "scaled";
export interface ComputerUseFrame {
  path: string;
  tool: string;
  at: string;
  sessionId: string;
  turnStartedAt: string;
}
export interface BrowserTarget {
  ref: string;
  role: string;
  name: string;
  value?: string;
}

export interface TaskBrowserState {
  id: string;
  status: "starting" | "ready" | "closed" | "failed";
  control: BrowserControl;
  url: string;
  title: string;
  width: number;
  height: number;
  revision: number;
  updatedAt: string;
  hasFrame: boolean;
  error: string | null;
  activity: { at: string; action: string; error?: string }[];
  display?: { mode: BrowserDisplayMode; width: number; height: number };
}

export type BrowserAction =
  | { action: "open"; path?: string; width?: number; height?: number }
  | { action: "snapshot" | "close" | "reload" | "back" | "forward" }
  | { action: "navigate"; path: string }
  | { action: "click"; ref: string }
  | { action: "fill"; ref: string; text: string }
  | { action: "select"; ref: string; value: string }
  | { action: "press"; key: string }
  | { action: "scroll"; direction: "up" | "down" }
  | { action: "resize"; width: number; height: number };

export type BrowserUserAction = BrowserAction
  | { action: "viewport"; width: number; height: number; mode: BrowserDisplayMode }
  | { action: "takeover" | "release" }
  | { action: "pointer"; x: number; y: number }
  | { action: "type"; text: string };

export interface BrowserObservation {
  state: TaskBrowserState;
  text: string;
  targets: BrowserTarget[];
  image?: string;
}

export interface TaskRuntimeState {
  service: FreeWorkflowPreviewState | null;
  browser: TaskBrowserState | null;
  computer?: ComputerUseFrame | null;
}

export function parseBrowserAction(value: unknown): BrowserUserAction {
  if (!value || typeof value !== "object") throw new Error("浏览器操作无效");
  const body = value as Record<string, unknown>;
  const text = (key: string, limit = 12_000) => {
    if (typeof body[key] !== "string" || (body[key] as string).length > limit) throw new Error(`浏览器操作 ${key} 无效`);
    return body[key] as string;
  };
  const size = () => {
    if (!Number.isInteger(body.width) || !Number.isInteger(body.height)) throw new Error("浏览器尺寸必须是整数");
    return { width: body.width as number, height: body.height as number };
  };
  switch (body.action) {
    case "open": return { action: "open", ...(body.path === undefined ? {} : { path: text("path", 4000) }),
      ...(body.width === undefined && body.height === undefined ? {} : size()) };
    case "snapshot": case "close": case "reload": case "back": case "forward": case "takeover": case "release": return { action: body.action };
    case "navigate": return { action: "navigate", path: text("path", 4000) };
    case "click": return { action: "click", ref: text("ref", 80) };
    case "fill": return { action: "fill", ref: text("ref", 80), text: text("text") };
    case "select": return { action: "select", ref: text("ref", 80), value: text("value") };
    case "press": return { action: "press", key: text("key", 80) };
    case "type": return { action: "type", text: text("text") };
    case "scroll":
      if (body.direction !== "up" && body.direction !== "down") throw new Error("滚动方向无效");
      return { action: "scroll", direction: body.direction };
    case "resize": return { action: "resize", ...size() };
    case "viewport":
      if (body.mode !== "responsive" && body.mode !== "scaled") throw new Error("浏览器显示模式无效");
      return { action: "viewport", mode: body.mode, ...size() };
    case "pointer":
      if (typeof body.x !== "number" || typeof body.y !== "number") throw new Error("点击位置无效");
      return { action: "pointer", x: body.x, y: body.y };
    default: throw new Error("不支持的浏览器操作");
  }
}
