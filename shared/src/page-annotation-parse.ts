import type { PreviewAnnotationEvent, PreviewElementCard, PreviewPageContext, PreviewPoint } from "./page-annotation.ts";

type Data = Record<string, unknown>;
const object = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15;
const point = (value: unknown): value is PreviewPoint => object(value) && number(value.x) && number(value.y);
const context = (value: unknown): value is PreviewPageContext => object(value) && text(value.route, 500)
  && point(value.scroll) && number(value.capturedAt) && object(value.viewport)
  && number(value.viewport.width) && number(value.viewport.height) && number(value.viewport.scale);
const element = (value: unknown): value is PreviewElementCard => object(value)
  && Array.isArray(value.selectors) && value.selectors.length <= 6 && value.selectors.every((item) => text(item, 1000))
  && text(value.tag, 100) && text(value.text, 240) && text(value.role, 60) && text(value.outerHTML, 1800)
  && object(value.rect) && number(value.rect.width) && number(value.rect.height) && point(value.rect)
  && object(value.computedStyle) && Object.keys(value.computedStyle).length <= 30
  && Object.entries(value.computedStyle).every(([key, item]) => text(key, 60) && text(item, 120))
  && Array.isArray(value.ancestors) && value.ancestors.length <= 4
  && value.ancestors.every((item) => object(item) && text(item.tag, 100) && text(item.selector, 1000) && text(item.role, 60));

export function parsePreviewMessage(value: unknown): PreviewAnnotationEvent | null {
  if (!object(value)) return null;
  if ((value.type === "ready" || value.type === "context") && context(value.context)) return value as PreviewAnnotationEvent;
  if (value.type === "image" && text(value.id, 160) && object(value.image) && number(value.image.capturedAt)
    && (value.image.dataUrl === undefined || (text(value.image.dataUrl, 2_800_000) && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.image.dataUrl)))
    && Array.isArray(value.image.missing) && value.image.missing.length <= 20 && value.image.missing.every((item) => text(item, 300))) return value as PreviewAnnotationEvent;
  if (value.type === "configured" && (value.mode === "browse" || value.mode === "annotate")
    && ["element", "rectangle", "pen", "pin"].includes(String(value.tool))) return value as PreviewAnnotationEvent;
  if (value.type === "error" && text(value.message, 300)) return value as PreviewAnnotationEvent;
  if (value.type === "selection" && (value.id === null || text(value.id, 160)) && typeof value.canSelectParent === "boolean") return value as PreviewAnnotationEvent;
  if (value.type !== "annotation" || !object(value.annotation) || typeof value.canSelectParent !== "boolean") return null;
  const item = value.annotation;
  return text(item.id, 160) && item.id.length > 0 && Number.isSafeInteger(item.number) && number(item.number) && item.number > 0
    && ["element", "rectangle", "pen", "pin"].includes(String(item.tool)) && context(item.context)
    && Array.isArray(item.points) && item.points.length > 0 && item.points.length <= 1000 && item.points.every(point)
    && (item.element === null || element(item.element)) ? value as PreviewAnnotationEvent : null;
}
