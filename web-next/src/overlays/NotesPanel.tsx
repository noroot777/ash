import { useEffect, useMemo, useState } from "react";
import type { Note, ProjectView } from "@harness/shared";
import { ArrowLeft, ArrowRight, File, MagnifyingGlass, NotePencil, Plus, Trash, X } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { AttachmentPicker, UploadAttachmentList, useAttachments } from "../task-detail/Attachments.tsx";
import { attachmentView } from "../task-detail/utils.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

const titleOf = (body: string) => body.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 42) || "无标题随手记";
const ordered = (rows: Note[]) => [...rows].sort((a, b) => b.updatedAt - a.updatedAt);

function ImageLightbox({ images, index, onIndex, onClose }: {
  images: { url: string; name: string }[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") onIndex((index - 1 + images.length) % images.length);
      if (event.key === "ArrowRight") onIndex((index + 1) % images.length);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [images.length, index, onClose, onIndex]);
  const image = images[index];
  if (!image) return null;
  return <div className="notes-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onMouseDown={onClose}><button type="button" aria-label="关闭预览"><X size={18} /></button>{images.length > 1 && <button className="is-prev" type="button" aria-label="上一张" onMouseDown={(event) => event.stopPropagation()} onClick={() => onIndex((index - 1 + images.length) % images.length)}><ArrowLeft size={20} /></button>}<img src={image.url} alt={image.name} onMouseDown={(event) => event.stopPropagation()} />{images.length > 1 && <button className="is-next" type="button" aria-label="下一张" onMouseDown={(event) => event.stopPropagation()} onClick={() => onIndex((index + 1) % images.length)}><ArrowRight size={20} /></button>}<span>{index + 1} / {images.length} · {image.name}</span></div>;
}

export function NotesPanel({ project, initialNoteId, onClose, onTask, onConvert, notify }: {
  project: ProjectView;
  initialNoteId: string | null;
  onClose: () => void;
  onTask: (taskId: string) => void;
  onConvert: (note: Note) => void;
  notify: (message: string) => void;
}) {
  const [rows, setRows] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(initialNoteId);
  const [draftBody, setDraftBody] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<string[]>([]);
  const [newDraft, setNewDraft] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const uploads = useAttachments();
  const active = rows.find((note) => note.id === activeId) ?? null;
  const dirty = newDraft ? !!draftBody.trim() || !!draftAttachments.length : !!active && (draftBody !== active.body || draftAttachments.join("\n") !== active.attachments.join("\n"));

  useEffect(() => {
    api.notes(project.id).then((notes) => {
      const next = ordered(notes);
      setRows(next);
      const startNew = initialNoteId === "__new__";
      const first = startNew ? null : (initialNoteId ? next.find((note) => note.id === initialNoteId) : undefined) ?? next[0] ?? null;
      setActiveId(first?.id ?? null);
      setDraftBody(first?.body ?? "");
      setDraftAttachments(first?.attachments ?? []);
      setNewDraft(startNew || !first);
    }).catch((error) => notify(error instanceof Error ? error.message : "随手记读取失败")).finally(() => setLoading(false));
  }, [initialNoteId, notify, project.id]);

  useEffect(() => {
    if (!uploads.attachments.length) return;
    setDraftAttachments((current) => [...new Set([...current, ...uploads.attachments.map((item) => item.path)])]);
    uploads.clear();
  }, [uploads.attachments, uploads.clear]);

  const save = async (): Promise<Note | null> => {
    if (!draftBody.trim()) { notify("随手记内容不能为空"); return null; }
    if (!dirty && active) return active;
    setBusy(true);
    try {
      const saved = newDraft
        ? await api.createNote({ projectId: project.id, body: draftBody, attachments: draftAttachments })
        : await api.patchNote(activeId!, { body: draftBody, attachments: draftAttachments });
      setRows((current) => ordered(current.some((note) => note.id === saved.id) ? current.map((note) => note.id === saved.id ? saved : note) : [saved, ...current]));
      setActiveId(saved.id);
      setNewDraft(false);
      notify("随手记已保存");
      return saved;
    } catch (error) {
      notify(error instanceof Error ? error.message : "随手记保存失败");
      return null;
    } finally { setBusy(false); }
  };
  const close = async () => {
    if (dirty && draftBody.trim() && !await save()) return;
    onClose();
  };

  const select = async (note: Note) => {
    if (note.id === activeId && !newDraft) return;
    if (dirty && !await save()) return;
    setActiveId(note.id); setDraftBody(note.body); setDraftAttachments(note.attachments); setNewDraft(false); setPreview(null);
  };
  const create = async () => {
    if (dirty && !await save()) return;
    setActiveId(null); setDraftBody(""); setDraftAttachments([]); setNewDraft(true); setPreview(null);
  };
  const remove = async () => {
    if (!active) return;
    setBusy(true);
    try {
      await api.deleteNote(active.id);
      const remaining = rows.filter((note) => note.id !== active.id);
      setRows(remaining);
      const next = remaining[0] ?? null;
      setActiveId(next?.id ?? null); setDraftBody(next?.body ?? ""); setDraftAttachments(next?.attachments ?? []); setNewDraft(!next);
      notify("随手记已删除");
    } catch (error) { notify(error instanceof Error ? error.message : "随手记删除失败"); }
    finally { setBusy(false); }
  };
  const convert = async () => { const note = await save(); if (note) onConvert(note); };
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return q ? rows.filter((note) => note.body.toLocaleLowerCase().includes(q)) : rows;
  }, [query, rows]);
  const images = useMemo(() => draftAttachments.map(attachmentView).filter((view): view is { name: string; url: string; image: true } => !!view.url && view.image).map(({ name, url }) => ({ name, url })), [draftAttachments]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (preview !== null || confirmDelete) return;
      if (event.key === "Escape") void close();
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  return (
    <div className="overlay-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) void close(); }}>
      <section className="notes-panel" role="dialog" aria-modal="true" aria-label="随手记" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><NotePencil size={17} /><b>随手记</b><span>{project.name} · {rows.length} 条</span></div><button type="button" onClick={() => void close()} aria-label="关闭"><X size={17} /></button></header>
        <div className="notes-body">
          <aside className="notes-list"><div className="notes-list-tools"><label><MagnifyingGlass size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索随手记…" /></label><button type="button" onClick={() => void create()} aria-label="新建随手记"><Plus size={15} /></button></div><div className="notes-scroll">
            {newDraft && <button className="note-row ui-selectable" type="button" aria-selected="true"><span><b>{titleOf(draftBody)}</b><small>尚未保存</small></span></button>}
            {filtered.map((note) => <button className="note-row ui-selectable" type="button" key={note.id} aria-selected={!newDraft && note.id === activeId} onClick={() => void select(note)}><span><b>{titleOf(note.body)}</b><small>{new Date(note.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}{note.taskId ? " · 已转任务" : ""}</small></span></button>)}
            {loading && <p>读取中…</p>}{!loading && !filtered.length && !newDraft && <p>没有匹配的随手记</p>}
          </div></aside>
          <main className="note-editor">
            <div className="note-meta"><span>{newDraft ? "新随手记" : active ? `创建于 ${new Date(active.createdAt).toLocaleString("zh-CN")}` : "新随手记"}</span>{active?.taskId && <button type="button" onClick={async () => { if (!dirty || await save()) onTask(active.taskId!); }}>关联任务 ↗</button>}</div>
            <textarea autoFocus value={draftBody} onChange={(event) => setDraftBody(event.target.value)} onPaste={uploads.onPaste} placeholder="记下临时想法、路径、验证清单…" />
            <div className="note-attachments">
              {draftAttachments.map((path) => { const view = attachmentView(path); return <div key={path}>{view.image && view.url ? <button type="button" onClick={() => setPreview(images.findIndex((image) => image.url === view.url))}><img src={view.url} alt={view.name} /></button> : <span><File size={16} />{view.name}</span>}<button type="button" onClick={() => setDraftAttachments((current) => current.filter((item) => item !== path))} aria-label={`移除 ${view.name}`}><X size={11} /></button></div>; })}
            </div>
            <UploadAttachmentList attachments={uploads.attachments} error={uploads.error} onRemove={uploads.remove} />
          </main>
        </div>
        <footer><span>{dirty ? "有未保存修改" : "已保存"} · 转任务后保留原随手记并写入回链</span><AttachmentPicker addFiles={uploads.addFiles} disabled={busy} />{active && <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash size={13} />删除</Button>}<Button disabled={!draftBody.trim() || busy} onClick={() => void convert()}>转为新任务</Button><Button variant="primary" disabled={!dirty || !draftBody.trim() || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</Button></footer>
      </section>
      {preview !== null && <ImageLightbox images={images} index={preview} onIndex={setPreview} onClose={() => setPreview(null)} />}
      {confirmDelete && active && <ConfirmDialog title="删除随手记" message={`确定删除“${titleOf(active.body)}”？此操作不可撤销。`} confirmLabel="删除" danger busy={busy} onClose={() => setConfirmDelete(false)} onConfirm={() => { setConfirmDelete(false); void remove(); }} />}
    </div>
  );
}
