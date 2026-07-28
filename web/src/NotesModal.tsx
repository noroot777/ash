import { useEffect, useMemo, useState } from "react";
import type { Note, ProjectView } from "@harness/shared";
import { ArrowSquareOut, FloppyDisk, NotePencil, PencilSimple, Trash } from "@phosphor-icons/react";
import { api } from "./api";
import { Markdown } from "./Markdown";
import { ConfirmModal, Modal, primaryCls } from "./Modal";
import { AttachmentDisplay } from "./messageAttachments";
import { AttachButton, AttachmentChips, usePasteAttachments } from "./pasteAttachments";
import { toast } from "./toast";

export type NoteTaskDraft = {
  noteIds: string[];
  body: string;
  attachments: string[];
};

const noteTitle = (body: string) =>
  body.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 36) || "无标题随手记";

const noteTime = (value: number) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const newestFirst = (rows: Note[]) => [...rows].sort((a, b) => b.updatedAt - a.updatedAt);

export function NewNoteModal({ project, onClose }: { project: ProjectView; onClose: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const { attachments, onPaste, addFiles, remove, error } = usePasteAttachments();

  const save = async (close: () => void) => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await api.createNote({ projectId: project.id, body, attachments: attachments.map((item) => item.path) });
      toast("随手记已保存");
      close();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`新建随手记 · ${project.name}`}
      onClose={onClose}
      width={620}
      footer={(close) => (
        <>
          <AttachButton
            addFiles={addFiles}
            className="mr-auto grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink"
            title="添加图片或文件"
          />
          <button onClick={close} className="px-3 py-1.5 text-[13px] text-muted">取消</button>
          <button disabled={!body.trim() || busy} onClick={() => void save(close)} className={primaryCls}>
            {busy ? "保存中…" : "保存"}
          </button>
        </>
      )}
    >
      <textarea
        autoFocus
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onPaste={onPaste}
        placeholder="记下临时想法…"
        className="min-h-[220px] w-full resize-y bg-transparent text-[14px] leading-relaxed text-ink outline-none placeholder:text-faint"
      />
      <AttachmentChips attachments={attachments} onRemove={remove} error={error} />
    </Modal>
  );
}

export function NotesModal({
  project,
  initialNoteId,
  onClose,
  onOpenTask,
  onCreateTask,
}: {
  project: ProjectView;
  initialNoteId?: string | null;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
  onCreateTask: (draft: NoteTaskDraft) => void;
}) {
  const [rows, setRows] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(initialNoteId ?? null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState("");
  const [editPaths, setEditPaths] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Note | null>(null);
  const [handoff, setHandoff] = useState(false);
  const uploaded = usePasteAttachments();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.notes(project.id).then(
      (notes) => {
        if (!alive) return;
        const sorted = newestFirst(notes);
        setRows(sorted);
        setActiveId(initialNoteId && sorted.some((note) => note.id === initialNoteId) ? initialNoteId : sorted[0]?.id ?? null);
        setPicked(new Set());
        setLoading(false);
      },
      (err) => {
        if (!alive) return;
        setLoading(false);
        toast(err instanceof Error ? err.message : String(err));
      },
    );
    return () => { alive = false; };
  }, [project.id, initialNoteId]);

  const active = rows.find((note) => note.id === activeId) ?? null;
  useEffect(() => {
    setEditing(false);
    setEditBody(active?.body ?? "");
    setEditPaths(active?.attachments ?? []);
    uploaded.clear();
  }, [active?.id]);

  const selectedNotes = useMemo(() => rows.filter((note) => picked.has(note.id)), [rows, picked]);
  const toggle = (noteId: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  };

  const saveEdit = async () => {
    if (!active || !editBody.trim()) return;
    try {
      const paths = [...new Set([...editPaths, ...uploaded.attachments.map((item) => item.path)])];
      const updated = await api.patchNote(active.id, { body: editBody, attachments: paths });
      setRows((current) => newestFirst(current.map((note) => note.id === updated.id ? updated : note)));
      setEditing(false);
      uploaded.clear();
      toast("随手记已更新");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };
  const startEdit = () => {
    if (!active) return;
    setEditBody(active.body);
    setEditPaths(active.attachments);
    uploaded.clear();
    setEditing(true);
  };
  const cancelEdit = () => {
    if (active) {
      setEditBody(active.body);
      setEditPaths(active.attachments);
    }
    uploaded.clear();
    setEditing(false);
  };

  const removeNote = async (note: Note) => {
    try {
      await api.deleteNote(note.id);
      const remaining = rows.filter((item) => item.id !== note.id);
      setRows(remaining);
      setPicked((current) => {
        const next = new Set(current);
        next.delete(note.id);
        return next;
      });
      if (activeId === note.id) setActiveId(remaining[0]?.id ?? null);
      toast("随手记已删除");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const createTask = () => {
    if (!selectedNotes.length || handoff) return;
    const draft: NoteTaskDraft = {
      noteIds: selectedNotes.map((note) => note.id),
      body: selectedNotes.map((note) => note.body).join("\n\n---\n\n"),
      attachments: [...new Set(selectedNotes.flatMap((note) => note.attachments))],
    };
    setHandoff(true);
    setTimeout(() => onCreateTask(draft), 170);
  };

  return (
    <>
      <Modal
        title={`随手记 · ${project.name}`}
        onClose={() => { if (!handoff) onClose(); }}
        width={940}
        cardClassName={handoff ? "note-handoff-out" : ""}
        contentClassName="min-h-0 overflow-hidden p-0"
        footer={selectedNotes.length ? (
          <button disabled={handoff} onClick={createTask} className={`${primaryCls} inline-flex items-center gap-1.5`}>
            <NotePencil size={15} /> 创建任务（{selectedNotes.length}）
          </button>
        ) : undefined}
      >
        <div className="grid h-[58vh] min-h-[360px] grid-cols-[minmax(170px,250px)_minmax(0,1fr)]">
          <aside className="min-w-0 overflow-y-auto border-r border-line bg-canvas/70 py-1">
            {loading && <p className="px-3 py-6 text-center text-[12px] text-faint">加载中…</p>}
            {!loading && !rows.length && (
              <div className="px-5 py-12 text-center">
                <NotePencil size={24} className="mx-auto mb-2 text-faint" />
                <p className="text-[12px] text-muted">这个项目还没有随手记</p>
              </div>
            )}
            {rows.map((note) => (
              <div
                key={note.id}
                className={`flex w-full items-start gap-2 border-b border-line px-3 py-2.5 text-left transition-colors ${
                  note.id === activeId ? "bg-panel" : "hover:bg-panel/70"
                } ${note.taskId ? "opacity-60" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={picked.has(note.id)}
                  onChange={() => toggle(note.id)}
                  className="mt-0.5 accent-accent"
                  aria-label={`选择 ${noteTitle(note.body)}`}
                />
                <button onClick={() => setActiveId(note.id)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[13px] font-medium text-ink">{noteTitle(note.body)}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-faint">
                    {noteTime(note.updatedAt)}
                    {note.taskId && <span className="rounded bg-overlay px-1 py-0.5">已转任务</span>}
                  </span>
                </button>
              </div>
            ))}
          </aside>

          <section className="min-w-0 overflow-y-auto bg-panel p-5">
            {!active ? (
              <div className="grid h-full place-items-center text-[12px] text-faint">选择一条随手记查看详情</div>
            ) : editing ? (
              <div className="flex min-h-full flex-col">
                <textarea
                  autoFocus
                  value={editBody}
                  onChange={(event) => setEditBody(event.target.value)}
                  onPaste={uploaded.onPaste}
                  className="min-h-[220px] flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-ink outline-none"
                />
                <AttachmentDisplay
                  paths={editPaths}
                  className="mt-3"
                  onRemove={(path) => setEditPaths((paths) => paths.filter((item) => item !== path))}
                />
                <AttachmentChips attachments={uploaded.attachments} onRemove={uploaded.remove} error={uploaded.error} />
                <div className="mt-4 flex items-center gap-2 border-t border-line pt-3">
                  <AttachButton
                    addFiles={uploaded.addFiles}
                    className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink"
                    title="添加图片或文件"
                  />
                  <button onClick={cancelEdit} className="ml-auto px-3 py-1.5 text-[13px] text-muted">取消</button>
                  <button disabled={!editBody.trim()} onClick={() => void saveEdit()} className={`${primaryCls} inline-flex items-center gap-1.5`}>
                    <FloppyDisk size={14} /> 保存
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className="mb-4 flex items-center gap-1 border-b border-line pb-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-[15px] font-semibold text-ink">{noteTitle(active.body)}</h3>
                    <p className="text-[11px] text-faint">更新于 {noteTime(active.updatedAt)}</p>
                  </div>
                  <button onClick={startEdit} className="ml-auto grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink" title="编辑">
                    <PencilSimple size={15} />
                  </button>
                  <button onClick={() => setDeleting(active)} className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-red-50 hover:text-red-600" title="删除">
                    <Trash size={15} />
                  </button>
                </div>
                {active.taskId && (
                  <button
                    onClick={() => onOpenTask(active.taskId!)}
                    className="mb-4 inline-flex items-center gap-1.5 rounded-md bg-raised px-2.5 py-1.5 text-[12px] text-muted hover:text-accent"
                  >
                    已转为任务 <ArrowSquareOut size={13} />
                  </button>
                )}
                <Markdown text={active.body} />
                <AttachmentDisplay paths={active.attachments} className="mt-4" />
              </div>
            )}
          </section>
        </div>
      </Modal>
      {deleting && (
        <ConfirmModal
          title="删除随手记"
          message={`确定删除「${noteTitle(deleting.body)}」？此操作不可撤销。`}
          confirmLabel="删除"
          danger
          onConfirm={() => void removeNote(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
