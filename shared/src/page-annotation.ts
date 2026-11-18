import type { AnnotationMatch } from "./page-annotation-review.ts";

import { LEGACY_PREVIEW_ANNOTATION_PROTOCOL } from "./legacy-names.ts";

export const PREVIEW_ANNOTATION_PROTOCOL = "navi-preview-annotation-v1";
/** 预览页里的批注脚本认的协议名：升级前打开、还没刷新的主界面发的是旧名，一并认。 */
export const PREVIEW_ANNOTATION_PROTOCOLS = [PREVIEW_ANNOTATION_PROTOCOL, LEGACY_PREVIEW_ANNOTATION_PROTOCOL] as const;

export type PreviewAnnotationMode = "browse" | "annotate";
export type PreviewAnnotationTool = "element" | "rectangle" | "pen" | "pin";
export type PreviewPoint = { x: number; y: number };
export type PreviewRect = PreviewPoint & { width: number; height: number };

export interface PreviewPageContext {
  route: string;
  scroll: PreviewPoint;
  viewport: { width: number; height: number; scale: number };
  capturedAt: number;
}

export interface PreviewElementCard {
  selectors: string[];
  tag: string;
  text: string;
  role: string;
  rect: PreviewRect;
  outerHTML: string;
  computedStyle: Record<string, string>;
  ancestors: Array<{ tag: string; selector: string; role: string }>;
}

export interface PreviewAnnotation {
  id: string;
  number: number;
  tool: PreviewAnnotationTool;
  points: PreviewPoint[];
  element: PreviewElementCard | null;
  context: PreviewPageContext;
}

export interface PreviewPageImage {
  capturedAt: number;
  dataUrl?: string;
  missing: string[];
}

export type PreviewAnnotationCommand =
  | { type: "configure"; mode: PreviewAnnotationMode; tool: PreviewAnnotationTool }
  | { type: "locate"; annotation: PreviewAnnotation; requestId: string }
  | { type: "clear-review" }
  | { type: "parent" }
  | { type: "focus"; id: string }
  | { type: "remove"; id: string }
  | { type: "clear" }
  | { type: "disconnect" };

export type PreviewAnnotationEvent =
  | { type: "match"; match: AnnotationMatch }
  | { type: "ready"; context: PreviewPageContext }
  | { type: "configured"; mode: PreviewAnnotationMode; tool: PreviewAnnotationTool }
  | { type: "context"; context: PreviewPageContext }
  | { type: "annotation"; annotation: PreviewAnnotation; canSelectParent: boolean }
  | { type: "image"; id: string; image: PreviewPageImage }
  | { type: "selection"; id: string | null; canSelectParent: boolean }
  | { type: "error"; message: string };

export type PreviewAnnotationHandshake = { protocol: typeof PREVIEW_ANNOTATION_PROTOCOL; nextNumber: number };
