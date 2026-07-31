import { useEffect, useMemo, useState } from "react";
import type { Note, ProjectView } from "@harness/shared";
import { ArrowSquareOut, CheckCircle, File, MagnifyingGlass, NotePencil, Plus, Trash, X } from "@phosphor-icons/react";
import { ImagePreviewGroup, PreviewableImage } from "../components/ImagePreview.tsx";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { AttachmentPicker, UploadAttachmentList, useAttachments } from "../task-detail/Attachments.tsx";
import { attachmentView } from "../task-detail/utils.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

const titleOf = (body: string) => body.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 42) || "无标题随手记";
const ordered = (rows: Note[]) => [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
const uniquePaths = (paths: string[]) => [...new Set(paths)];
const noteTime = (value: number) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export type NoteTaskDraft = {
  body: string;
  attachments: string[];
  noteIds: string[];
};

export function NotesPanel({ project, initialNoteId, onClose, onTask, onConvert, notify }: {
  project: ProjectView;
  initialNoteId: string | null;
  onClose: () => void;
  onTask: (taskId: string) => void;
  onConvert: (draft: NoteTaskDraft) => void;
  notify: (message: string) => void;
}) {
  const [rows, setRows] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(initialNoteId);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [draftBody, setDraftBody] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<string[]>([]);
  const [newDraft, setNewDraft] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
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
      setPicked(new Set());
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
    setActiveId(note.id); setDraftBody(note.body); setDraftAttachments(note.attachments); setNewDraft(false);
  };
  const create = async () => {
    if (dirty && !await save()) return;
    setActiveId(null); setDraftBody(""); setDraftAttachments([]); setNewDraft(true);
  };
  const remove = async () => {
    if (!active) return;
    setBusy(true);
    try {
      await api.deleteNote(active.id);
      const remaining = rows.filter((note) => note.id !== active.id);
      setRows(remaining);
      setPicked((current) => {
        const nextPicked = new Set(current);
        nextPicked.delete(active.id);
        return nextPicked;
      });
      const next = remaining[0] ?? null;
      setActiveId(next?.id ?? null); setDraftBody(next?.body ?? ""); setDraftAttachments(next?.attachments ?? []); setNewDraft(!next);
      notify("随手记已删除");
    } catch (error) { notify(error instanceof Error ? error.message : "随手记删除失败"); }
    finally { setBusy(false); }
  };
  const togglePicked = (noteId: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  };
  const convert = async () => {
    if (busy) return;
    let currentRows = rows;
    let currentActive = active;
    if (dirty) {
      const saved = await save();
      if (!saved) return;
      currentRows = ordered(currentRows.some((note) => note.id === saved.id)
        ? currentRows.map((note) => note.id === saved.id ? saved : note)
        : [saved, ...currentRows]);
      currentActive = saved;
    }
    const selectedNotes = currentRows.filter((note) => picked.has(note.id));
    const notes = selectedNotes.length ? selectedNotes : currentActive ? [currentActive] : [];
    if (!notes.length) return;
    onConvert({
      body: notes.map((note) => note.body).join("\n\n---\n\n"),
      attachments: uniquePaths(notes.flatMap((note) => note.attachments)),
      noteIds: notes.map((note) => note.id),
    });
  };
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return q ? rows.filter((note) => note.body.toLocaleLowerCase().includes(q)) : rows;
  }, [query, rows]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (confirmDelete) return;
      if (event.key === "Escape") void close();
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return (
    <div className="overlay-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) void close(); }}>
      <section className="notes-panel" role="dialog" aria-modal="true" aria-label="随手记" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><NotePencil size={17} /><b>随手记</b><span>{project.name} · {rows.length} 条</span></div><button type="button" onClick={() => void close()} aria-label="关闭"><X size={17} /></button></header>
        <div className="notes-body">
          <aside className="notes-list"><div className="notes-list-tools"><label><MagnifyingGlass size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索随手记…" /></label><button type="button" onClick={() => void create()} aria-label="新建随手记"><Plus size={15} /></button></div><div className="notes-scroll" role="list" aria-label="随手记列表">
            {newDraft && <div className="note-row ui-selectable is-selected" role="listitem"><span className="note-pick-placeholder" /><button className="note-row-main" type="button"><b>{titleOf(draftBody)}</b><small>尚未保存</small></button></div>}
            {filtered.map((note) => <div className={`note-row ui-selectable${note.taskId ? " is-converted" : ""}${!newDraft && note.id === activeId ? " is-selected" : ""}`} key={note.id} role="listitem">
              <button className="note-pick" type="button" role="checkbox" aria-checked={picked.has(note.id)} aria-label={`选择 ${titleOf(note.body)}`} onClick={() => togglePicked(note.id)}><span className={`ui-checkbox${picked.has(note.id) ? " is-checked" : ""}`} aria-hidden="true" /></button>
              <button className="note-row-main" type="button" onClick={() => void select(note)}><b>{titleOf(note.body)}</b><small>{noteTime(note.updatedAt)}</small></button>
              {note.taskId && <button className="note-task-badge" type="button" title="打开关联任务" onClick={async () => { if (!dirty || await save()) onTask(note.taskId!); }}><CheckCircle size={12} weight="duotone" aria-hidden="true" /><span>已转任务</span><ArrowSquareOut className="note-task-arrow" size={11} aria-hidden="true" /></button>}
            </div>)}
            {loading && <p>读取中…</p>}{!loading && !filtered.length && !newDraft && <p>没有匹配的随手记</p>}
          </div></aside>
          <main className="note-editor">
            <div className="note-meta"><span>{newDraft ? "新随手记" : active ? `创建于 ${new Date(active.createdAt).toLocaleString("zh-CN")}` : "新随手记"}</span>{active?.taskId && <button type="button" onClick={async () => { if (!dirty || await save()) onTask(active.taskId!); }}>关联任务 ↗</button>}</div>
            <textarea autoFocus value={draftBody} onChange={(event) => setDraftBody(event.target.value)} onPaste={uploads.onPaste} placeholder="记下临时想法、路径、验证清单…" />
            <ImagePreviewGroup isolated>
              <div className="note-attachments">
                {draftAttachments.map((path) => { const view = attachmentView(path); return <div key={path}>{view.image && view.url ? <PreviewableImage src={view.url} alt={view.name} /> : <span><File size={16} />{view.name}</span>}<button type="button" onClick={() => setDraftAttachments((current) => current.filter((item) => item !== path))} aria-label={`移除 ${view.name}`}><X size={11} /></button></div>; })}
              </div>
              <UploadAttachmentList attachments={uploads.attachments} error={uploads.error} onRemove={uploads.remove} />
            </ImagePreviewGroup>
          </main>
        </div>
        <footer><span>{picked.size ? `已选择 ${picked.size} 条 · 将按列表顺序合并` : `${dirty ? "有未保存修改" : "已保存"} · 转任务后保留原随手记并写入回链`}</span><AttachmentPicker addFiles={uploads.addFiles} disabled={busy} />{active && <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash size={13} />删除</Button>}<Button variant={picked.size ? "primary" : "secondary"} disabled={busy || (!picked.size && !draftBody.trim())} onClick={() => void convert()}><NotePencil size={13} />{picked.size ? `创建任务（${picked.size}）` : "转为新任务"}</Button><Button variant={picked.size ? "secondary" : "primary"} disabled={!dirty || !draftBody.trim() || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</Button></footer>
      </section>
      {confirmDelete && active && <ConfirmDialog title="删除随手记" message={`确定删除“${titleOf(active.body)}”？此操作不可撤销。`} confirmLabel="删除" danger busy={busy} onClose={() => setConfirmDelete(false)} onConfirm={() => { setConfirmDelete(false); void remove(); }} />}
    </div>
  );
}
