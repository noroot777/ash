import type { PreviewAnnotationEvent } from "@ash/shared/page-annotation";
import { parsePreviewMessage as parseAnnotationMessage } from "@ash/shared/page-annotation-parse";

export type WorkspaceAnnotationEvent = PreviewAnnotationEvent | { type: "undo" };

export function parsePreviewMessage(value: unknown): WorkspaceAnnotationEvent | null {
  if (value && typeof value === "object" && !Array.isArray(value) && "type" in value && value.type === "undo") return { type: "undo" };
  return parseAnnotationMessage(value);
}
