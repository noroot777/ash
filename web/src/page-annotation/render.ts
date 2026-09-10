import { annotationBounds, type Annotation, type Point } from "./model.ts";

export function annotationMetrics(width: number) {
  const unit = Math.max(1, width / 1000);
  return { stroke: 3 * unit, font: 18 * unit, radius: 12 * unit, unit };
}

function line(context: CanvasRenderingContext2D, points: Point[]) {
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.stroke();
}

function textLabel(context: CanvasRenderingContext2D, annotation: Annotation, width: number, height: number) {
  const { font, unit } = annotationMetrics(width);
  const first = annotation.points[0]!;
  const padding = 4 * unit;
  const available = Math.max(font, Math.min(width - padding * 2, Math.max(font * 8, width * 0.45)));
  context.font = `600 ${font}px sans-serif`;
  context.textBaseline = "top";
  const lines: string[] = [];
  let current = "";
  for (const character of annotation.label.trim() || "文字") {
    if (current && context.measureText(current + character).width > available) {
      lines.push(current);
      current = "";
    }
    current += character;
  }
  if (current) lines.push(current);
  const boxWidth = Math.max(...lines.map((text) => context.measureText(text).width)) + padding * 2;
  const boxHeight = lines.length * font * 1.4 + padding * 2;
  const x = Math.max(0, Math.min(width - boxWidth, first.x));
  const y = Math.max(0, Math.min(height - boxHeight, first.y));
  context.fillStyle = "#fff";
  context.fillRect(x, y, boxWidth, boxHeight);
  context.fillStyle = annotation.color;
  lines.forEach((text, index) => context.fillText(text, x + padding, y + padding + index * font * 1.4));
}

export function drawAnnotations(
  context: CanvasRenderingContext2D,
  annotations: Annotation[],
  width: number,
  height: number,
  selectedId?: string | null,
) {
  const { stroke, font, radius, unit } = annotationMetrics(width);
  annotations.forEach((annotation, index) => {
    if (!annotation.points.length) return;
    const first = annotation.points[0]!;
    const last = annotation.points.at(-1)!;
    const bounds = annotationBounds(annotation.points);
    context.save();
    context.strokeStyle = annotation.color;
    context.fillStyle = annotation.color;
    context.lineWidth = stroke;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.shadowColor = "#fff";
    context.shadowBlur = unit * 2;
    if (annotation.tool === "rectangle") {
      context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    } else if (annotation.tool === "arrow") {
      line(context, [first, last]);
      const angle = Math.atan2(last.y - first.y, last.x - first.x);
      const length = Math.min(18 * unit, Math.hypot(last.x - first.x, last.y - first.y) / 2);
      line(context, [
        { x: last.x - length * Math.cos(angle - Math.PI / 6), y: last.y - length * Math.sin(angle - Math.PI / 6) },
        last,
        { x: last.x - length * Math.cos(angle + Math.PI / 6), y: last.y - length * Math.sin(angle + Math.PI / 6) },
      ]);
    } else if (annotation.tool === "pen") {
      line(context, annotation.points);
      if (annotation.points.length === 1) {
        context.beginPath();
        context.arc(first.x, first.y, stroke / 2, 0, Math.PI * 2);
        context.fill();
      }
    } else {
      textLabel(context, annotation, width, height);
    }
    context.shadowBlur = 0;
    if (annotation.id === selectedId) {
      context.strokeStyle = "#5e6ad2";
      context.lineWidth = unit;
      context.setLineDash([4 * unit, 4 * unit]);
      context.strokeRect(bounds.x - 6 * unit, bounds.y - 6 * unit, Math.max(bounds.width, font) + 12 * unit, Math.max(bounds.height, font) + 12 * unit);
      context.setLineDash([]);
    }
    const badgeX = Math.max(radius + 2, Math.min(width - radius - 2, first.x - radius));
    const badgeY = Math.max(radius + 2, Math.min(height - radius - 2, first.y - radius));
    context.fillStyle = annotation.color;
    context.strokeStyle = "#fff";
    context.lineWidth = 2 * unit;
    context.beginPath();
    context.arc(badgeX, badgeY, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = "#fff";
    context.font = `700 ${14 * unit}px sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(index + 1), badgeX, badgeY);
    context.restore();
  });
}
