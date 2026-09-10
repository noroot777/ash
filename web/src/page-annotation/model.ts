import type { ConversationItem } from "../task-detail/conversationModel.ts";
import { attachmentView } from "../task-detail/utils.ts";

export type AnnotationTool = "rectangle" | "arrow" | "pen" | "text";
export type Point = { x: number; y: number };
export type Annotation = {
  id: string;
  tool: AnnotationTool;
  points: Point[];
  color: string;
  label: string;
  target: string;
  comment: string;
};
export type AnnotationImage = {
  dataUrl: string;
  name: string;
  width: number;
  height: number;
  source: "paste" | "upload" | "attachment";
  sourcePath?: string;
};
export type ScreenshotDraft = { image: AnnotationImage; annotations: Annotation[] };
export type AnnotationReply = { text: string; attachments: string[] };
export type ScreenshotCandidate = { path: string; url: string; name: string };

export const TOOL_LABELS: Record<AnnotationTool, string> = {
  rectangle: "矩形", arrow: "箭头", pen: "画笔", text: "文字",
};
export const ANNOTATION_COLORS = ["#d93d4c", "#5e6ad2", "#168466", "#b57b00"];

export function annotationBounds(points: Point[]) {
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of points) {
    x = Math.min(x, point.x);
    y = Math.min(y, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return points.length ? { x, y, width: right - x, height: bottom - y } : { x: 0, y: 0, width: 0, height: 0 };
}

export function imagePoint(client: Point, rect: { left: number; top: number; width: number; height: number }, size: { width: number; height: number }): Point {
  return {
    x: Math.max(0, Math.min(size.width, (client.x - rect.left) * size.width / rect.width)),
    y: Math.max(0, Math.min(size.height, (client.y - rect.top) * size.height / rect.height)),
  };
}

export function positionDescription(annotation: Annotation): string {
  const point = (p: Point) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;
  const first = annotation.points[0]!;
  if (annotation.tool === "text") return `文字锚点 ${point(first)}`;
  if (annotation.tool === "arrow") return `箭头 ${point(first)} → ${point(annotation.points.at(-1)!)}（箭头终点为目标）`;
  const bounds = annotationBounds(annotation.points);
  return `区域左上角 ${point(bounds)}，宽 ${Math.round(bounds.width)} × 高 ${Math.round(bounds.height)} px`;
}

export function screenshotReplyText(draft: ScreenshotDraft, attachmentName: string): string {
  const { image, annotations } = draft;
  const source = image.source === "paste" ? "粘贴" : image.source === "upload" ? "上传" : "从本任务会话图片附件中选取";
  const quoted = (value: string) => JSON.stringify(value);
  return [
    "## 截图批注意见",
    "",
    `图像来源：用户提供的截图（${source}）。此图用于表达修改意见，不代表当前页面的实时状态。`,
    `原图名称：${quoted(image.name)}${image.sourcePath ? `；会话附件：${quoted(image.sourcePath)}` : ""}`,
    `标注图附件：${quoted(attachmentName)}；图像来源：上述用户提供的截图 + 用户圈画标注。`,
    `坐标基准：截图左上角为 (0, 0)，尺寸 ${image.width} × ${image.height} px；编号对应图上的标记。`,
    "",
    ...annotations.flatMap((annotation, index) => [
      `${index + 1}. ${TOOL_LABELS[annotation.tool]}标注`,
      `   - 位置：${positionDescription(annotation)}`,
      `   - 目标描述：${quoted(annotation.target.trim() || "见图中此编号标记的位置")}`,
      ...(annotation.tool === "text" ? [`   - 图中文字：${quoted(annotation.label.trim())}`] : []),
      `   - 用户意见：${quoted(annotation.comment.trim() || "未填写文字意见，请结合标注位置理解")}`,
      "",
    ]),
  ].join("\n").trim();
}

export function screenshotCandidates(items: ConversationItem[], extraPaths: string[] = []): ScreenshotCandidate[] {
  const paths = [...extraPaths, ...items.flatMap((item) => item.kind === "user"
    ? item.attachments
    : item.kind === "agent" ? item.segments.flatMap((segment) => segment.attachments) : [])];
  return [...new Set(paths)].flatMap((path) => {
    const view = attachmentView(path);
    return view.image && view.url ? [{ path, url: view.url, name: view.name }] : [];
  });
}
