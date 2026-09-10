import { useRef, useState } from "react";
import { Image as ImageIcon, PencilSimple, SpinnerGap, UploadSimple } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { useTaskReplyDraft } from "../lib/DraftStore.tsx";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { AnnotationDialog } from "./AnnotationDialog.tsx";
import { AnnotationEditor } from "./AnnotationEditor.tsx";
import { exportScreenshot, loadScreenshot } from "./image.ts";
import { screenshotReplyText, type AnnotationImage, type AnnotationReply, type ScreenshotCandidate, type ScreenshotDraft } from "./model.ts";
import "./annotation.css";

export function ScreenshotAnnotation({ taskId, candidates, disabled, queueing, executorLabel, onSend, triggerLabel }: {
  triggerLabel?: string;
  taskId: string;
  candidates: ScreenshotCandidate[];
  disabled: boolean;
  queueing: boolean;
  executorLabel: string;
  onSend: (reply: AnnotationReply) => Promise<boolean>;
}) {
  const { screenshot: draft, setScreenshot } = useTaskReplyDraft(taskId);
  const [open, setOpen] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploaded = useRef<{ draft: ScreenshotDraft; reply: AnnotationReply } | null>(null);
  const close = () => {
    if (inFlight.current) return;
    setOpen(false);
    triggerRef.current?.focus();
  };
  const selectImage = async (input: File | ScreenshotCandidate, source: AnnotationImage["source"]) => {
    if (inFlight.current || draft || disabled) return;
    inFlight.current = true;
    setBusy(true);
    setProgress("正在读取图片…");
    setError(null);
    try {
      const image = await loadScreenshot(input, source);
      setScreenshot({ image, annotations: [] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const send = async () => {
    if (inFlight.current || disabled || !draft?.annotations.length) return;
    if (draft.annotations.some((annotation) => annotation.tool === "text" && !annotation.label.trim())) {
      setError("请填写文字标注的图中文字，或删除空白文字标注");
      return;
    }
    const snapshot = draft;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (uploaded.current?.draft !== snapshot) {
        setProgress("正在生成标注图片…");
        const rendered = await exportScreenshot(snapshot);
        const name = `截图批注-${Date.now()}.${rendered.extension}`;
        setProgress("正在上传标注图片 0%…");
        const attachment = await api.uploadFile(rendered.dataUrl, name, {
          onProgress: (fraction) => setProgress(`正在上传标注图片 ${Math.min(99, Math.round(fraction * 100))}%…`),
        });
        uploaded.current = { draft: snapshot, reply: { text: screenshotReplyText(snapshot, name), attachments: [attachment.path] } };
      }
      setProgress("正在发送批注…");
      const sent = await onSend(uploaded.current.reply);
      if (!sent) { setError("本次未发送，批注已保留，可继续修改或重试。"); return; }
      setScreenshot((current) => current === snapshot ? null : current);
      uploaded.current = null;
      setOpen(false);
      triggerRef.current?.focus();
    } catch (reason) {
      setError(`发送失败：${reason instanceof Error ? reason.message : String(reason)}。批注已保留，可重试。`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const replace = () => {
    if (busy) return;
    setScreenshot(null);
    uploaded.current = null;
    setError(null);
    setReplacing(false);
  };

  return (
    <>
      <button className="screenshot-annotation-trigger" ref={triggerRef} type="button" disabled={disabled} onClick={() => setOpen(true)}>
        <PencilSimple size={15} />{triggerLabel ?? (draft ? "继续批注" : "截图批注")}
      </button>
      {open && <AnnotationDialog busy={busy} onClose={close} onPaste={(event) => {
        if (draft || busy || disabled) return;
        const file = Array.from(event.clipboardData.items ?? []).find((item) => item.type.startsWith("image/"))?.getAsFile()
          ?? Array.from(event.clipboardData.files ?? []).find((item) => item.type.startsWith("image/"));
        if (file) { event.preventDefault(); event.stopPropagation(); void selectImage(file, "paste"); }
      }} footer={
        <>
          <div className="annotation-send-summary">
            {error && <p role="alert" className="annotation-error">{error}</p>}
            {busy ? <p role="status"><SpinnerGap size={14} className="is-spinning" />{progress}</p>
              : <p>{draft ? `${draft.annotations.length} 条意见 + 1 张标注图，将单独回复给 ${executorLabel}` : "支持粘贴、上传，或选择会话中的图片"}</p>}
            {draft && <small>关闭后保留草稿，切换任务可继续；刷新页面会清空。</small>}
          </div>
          <button type="button" disabled={busy} onClick={close}>{draft ? "暂存并关闭" : "关闭"}</button>
          {draft && <button className="is-primary" type="button" disabled={busy || disabled || !draft.annotations.length} onClick={() => void send()}>{busy ? "处理中…" : queueing ? "排队发送批注" : "发送批注"}</button>}
        </>
      }>
        {draft ? <>
          <div className="annotation-source-info">
            <span>用户提供的截图 · {draft.image.name} · {draft.image.width} × {draft.image.height}</span>
            <button type="button" disabled={busy} onClick={() => draft.annotations.length ? setReplacing(true) : replace()}>重新选图</button>
          </div>
          <AnnotationEditor imageUrl={draft.image.dataUrl} width={draft.image.width} height={draft.image.height} annotations={draft.annotations} disabled={busy || disabled} onChange={(annotations) => {
            setScreenshot((current) => current ? { ...current, annotations } : current);
            setError(null);
          }} />
          <details className="annotation-reply-preview"><summary>查看将发送的意见清单</summary><pre>{screenshotReplyText(draft, "标注后的截图（发送时生成）")}</pre></details>
        </> : <div className="annotation-source-picker">
          <div className="annotation-upload-area">
            <ImageIcon size={36} weight="duotone" />
            <h3>选一张截图，开始圈画</h3>
            <p>直接粘贴图片（⌘V / Ctrl+V），或从电脑上传。</p>
            <button type="button" disabled={busy || disabled} onClick={() => inputRef.current?.click()}><UploadSimple size={16} />选择图片</button>
            <input ref={inputRef} className="task-visually-hidden" type="file" accept="image/*" disabled={busy || disabled} onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void selectImage(file, "upload");
            }} />
          </div>
          <h3>本任务的图片附件 <span>{candidates.length}</span></h3>
          {candidates.length ? <div className="annotation-source-grid">
            {candidates.map((candidate) => <button key={candidate.path} type="button" disabled={busy || disabled} onClick={() => void selectImage(candidate, "attachment")}>
              <img src={candidate.url} alt={candidate.name} loading="lazy" /><span>{candidate.name}</span>
            </button>)}
          </div> : <p className="annotation-empty">会话中还没有可选的图片附件。</p>}
        </div>}
        {replacing && <ConfirmDialog title="重新选择截图" message="重新选图会清除当前图片上的全部批注。" confirmLabel="清除并选图" onConfirm={replace} onClose={() => setReplacing(false)} />}
      </AnnotationDialog>}
    </>
  );
}
