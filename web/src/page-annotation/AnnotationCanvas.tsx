import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createClientId } from "../lib/clientId.ts";
import { imagePoint, type Annotation, type AnnotationTool, type Point } from "./model.ts";
import { drawAnnotations } from "./render.ts";

export type AnnotationCanvasProps = {
  imageUrl: string;
  width: number;
  height: number;
  annotations: Annotation[];
  tool: AnnotationTool;
  color: string;
  selectedId?: string | null;
  disabled?: boolean;
  actualSize?: boolean;
  onAdd: (annotation: Annotation) => void;
};

export function AnnotationCanvas({
  imageUrl, width, height, annotations, tool, color, selectedId, disabled, actualSize, onAdd,
}: AnnotationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<{ pointerId: number; annotation: Annotation } | null>(null);
  const [drawing, setDrawing] = useState<Annotation | null>(null);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    drawAnnotations(context, drawing ? [...annotations, drawing] : annotations, width, height, selectedId);
  }, [annotations, drawing, width, height, selectedId]);

  const pointOf = (event: PointerEvent<HTMLCanvasElement>): Point => imagePoint(
    { x: event.clientX, y: event.clientY },
    event.currentTarget.getBoundingClientRect(),
    { width, height },
  );
  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const point = pointOf(event);
    const points = current.annotation.points;
    if (current.annotation.tool === "pen") {
      const previous = points.at(-1)!;
      if (Math.hypot(point.x - previous.x, point.y - previous.y) < Math.max(1, width / 1000)) return;
    }
    current.annotation = {
      ...current.annotation,
      points: current.annotation.tool === "pen" ? [...points, point] : [points[0]!, point],
    };
    setDrawing(current.annotation);
  };
  const finish = (event: PointerEvent<HTMLCanvasElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    move(event);
    const annotation = gesture.current.annotation;
    gesture.current = null;
    setDrawing(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const start = annotation.points[0]!;
    const end = annotation.points.at(-1)!;
    if (annotation.tool === "pen" || Math.hypot(end.x - start.x, end.y - start.y) >= Math.max(3, width / 500)) {
      onAdd(annotation);
    }
  };

  return (
    <div className="annotation-viewport">
      <div className="annotation-sheet" style={{ width, maxWidth: actualSize ? "none" : "100%" }}>
        <img src={imageUrl} alt="待批注截图" width={width} height={height} draggable={false} />
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          aria-label="截图圈画区域，在图上拖动绘制，文字工具点击添加"
          onPointerDown={(event) => {
            if (disabled || event.button !== 0 || gesture.current) return;
            event.preventDefault();
            const point = pointOf(event);
            const annotation: Annotation = { id: createClientId(), tool, color, points: [point], label: "", target: "", comment: "" };
            if (tool === "text") {
              const margin = Math.max(28, width * 0.04);
              annotation.points = [{ x: Math.min(point.x, Math.max(0, width - margin)), y: Math.min(point.y, Math.max(0, height - margin)) }];
              onAdd(annotation);
              return;
            }
            event.currentTarget.setPointerCapture(event.pointerId);
            gesture.current = { pointerId: event.pointerId, annotation };
            setDrawing(annotation);
          }}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerCancel={() => { gesture.current = null; setDrawing(null); }}
          onLostPointerCapture={() => { gesture.current = null; setDrawing(null); }}
        />
      </div>
    </div>
  );
}
