import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ArrowCounterClockwise, PencilSimple, Rectangle, TextT, Trash } from "@phosphor-icons/react";
import { AnnotationCanvas } from "./AnnotationCanvas.tsx";
import { ANNOTATION_COLORS, TOOL_LABELS, positionDescription, type Annotation, type AnnotationTool } from "./model.ts";
import "./annotation.css";

const TOOLS = [
  { tool: "rectangle", icon: Rectangle },
  { tool: "arrow", icon: ArrowUpRight },
  { tool: "pen", icon: PencilSimple },
  { tool: "text", icon: TextT },
] as const;
const COLOR_NAMES = ["红色", "紫色", "绿色", "金色"];

export function AnnotationEditor({ imageUrl, width, height, annotations, onChange, disabled = false }: {
  imageUrl: string;
  width: number;
  height: number;
  annotations: Annotation[];
  onChange: (annotations: Annotation[]) => void;
  disabled?: boolean;
}) {
  const [tool, setTool] = useState<AnnotationTool>("rectangle");
  const [color, setColor] = useState(ANNOTATION_COLORS[0]!);
  const [selectedId, setSelectedId] = useState<string | null>(annotations.at(-1)?.id ?? null);
  const [actualSize, setActualSize] = useState(false);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const focusNew = useRef(false);
  const selected = annotations.find((annotation) => annotation.id === selectedId);

  useEffect(() => {
    if (!focusNew.current || !selected) return;
    focusNew.current = false;
    if (selected.tool === "text") labelRef.current?.focus();
    else commentRef.current?.focus();
  }, [selected]);

  const update = (patch: Partial<Pick<Annotation, "label" | "target" | "comment">>) => {
    if (disabled) return;
    onChange(annotations.map((annotation) => annotation.id === selectedId ? { ...annotation, ...patch } : annotation));
  };
  const remove = (id: string) => {
    if (disabled) return;
    const next = annotations.filter((annotation) => annotation.id !== id);
    onChange(next);
    setSelectedId(next.at(-1)?.id ?? null);
  };

  return (
    <div className="annotation-editor">
      <div className="annotation-toolbar" role="group" aria-label="圈画工具">
        {TOOLS.map(({ tool: next, icon: Icon }) => (
          <button key={next} type="button" aria-pressed={tool === next} disabled={disabled} onClick={() => setTool(next)}>
            <Icon size={16} /><span>{TOOL_LABELS[next]}</span>
          </button>
        ))}
        <div className="annotation-colors" role="group" aria-label="标注颜色">
          {ANNOTATION_COLORS.map((value, index) => (
            <button key={value} type="button" className="annotation-color" style={{ backgroundColor: value }} aria-label={COLOR_NAMES[index]} aria-pressed={color === value} disabled={disabled} onClick={() => setColor(value)} />
          ))}
        </div>
        <button type="button" disabled={disabled || !annotations.length} onClick={() => remove(annotations.at(-1)!.id)}>
          <ArrowCounterClockwise size={16} />撤销上一笔
        </button>
        <button type="button" aria-pressed={actualSize} onClick={() => setActualSize(!actualSize)}>{actualSize ? "适应宽度" : "原始大小"}</button>
      </div>
      <div className="annotation-workspace">
        <AnnotationCanvas imageUrl={imageUrl} width={width} height={height} annotations={annotations} tool={tool} color={color} selectedId={selectedId} disabled={disabled} actualSize={actualSize} onAdd={(annotation) => {
          if (disabled) return;
          focusNew.current = true;
          onChange([...annotations, annotation]);
          setSelectedId(annotation.id);
        }} />
        <aside className="annotation-notes" aria-label="批注意见清单">
          <div className="annotation-notes-heading"><h3>意见清单</h3><span>{annotations.length} 条</span></div>
          {!annotations.length && <p className="annotation-empty">在图上拖动圈画，或用文字工具点击。每一笔都有编号，可在这里补充修改意见。</p>}
          <ol className="annotation-list">
            {annotations.map((annotation, index) => (
              <li key={annotation.id}>
                <button type="button" className="annotation-note-select" aria-pressed={selectedId === annotation.id} onClick={() => setSelectedId(annotation.id)}>
                  <b style={{ backgroundColor: annotation.color }}>{index + 1}</b>
                  <span><strong>{annotation.target || (annotation.tool === "text" && annotation.label) || `${TOOL_LABELS[annotation.tool]}标注`}</strong><small>{annotation.comment || "可补充修改意见"}</small></span>
                </button>
              </li>
            ))}
          </ol>
          {selected && (
            <div className="annotation-note-fields">
              <p className="annotation-position">{positionDescription(selected)}</p>
              {selected.tool === "text" && <label>图中文字<input ref={labelRef} value={selected.label} maxLength={100} disabled={disabled} placeholder="输入要写在图上的标签" onChange={(event) => update({ label: event.target.value })} /></label>}
              <label>目标描述（选填）<input value={selected.target} maxLength={300} disabled={disabled} placeholder="例如：右上角的保存按钮" onChange={(event) => update({ target: event.target.value })} /></label>
              <label>修改意见（选填）<textarea ref={commentRef} rows={4} value={selected.comment} maxLength={5000} disabled={disabled} placeholder="这个位置希望怎么改？" onChange={(event) => update({ comment: event.target.value })} /></label>
              <button className="annotation-delete" type="button" disabled={disabled} onClick={() => remove(selected.id)}><Trash size={14} />删除这条批注</button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
