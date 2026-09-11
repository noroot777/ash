import type { PreviewAnnotationEvent } from "@ash/shared/page-annotation";
import { parsePreviewMessage as parseAnnotationMessage } from "@ash/shared/page-annotation-parse";

export type WorkspaceAnnotationEvent = PreviewAnnotationEvent | { type: "undo" | "escape" };

export function parsePreviewMessage(value: unknown): WorkspaceAnnotationEvent | null {
  if (value && typeof value === "object" && !Array.isArray(value) && "type" in value && (value.type === "undo" || value.type === "escape")) return { type: value.type };
  return parseAnnotationMessage(value);
}
