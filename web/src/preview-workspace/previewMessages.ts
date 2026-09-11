import type { PreviewAnnotationEvent } from "@ash/shared/page-annotation";
import { parsePreviewMessage as parseAnnotationMessage } from "@ash/shared/page-annotation-parse";

export type WorkspaceAnnotationEvent = PreviewAnnotationEvent | { type: "undo" | "escape" } | { type: "gesture"; active: boolean };

export function parsePreviewMessage(value: unknown): WorkspaceAnnotationEvent | null {
  if (value && typeof value === "object" && !Array.isArray(value) && "type" in value && value.type === "gesture" && "active" in value && typeof value.active === "boolean") return { type: "gesture", active: value.active };
  if (value && typeof value === "object" && !Array.isArray(value) && "type" in value && (value.type === "undo" || value.type === "escape")) return { type: value.type };
  return parseAnnotationMessage(value);
}
