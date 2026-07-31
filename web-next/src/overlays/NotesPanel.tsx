import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Note, ProjectView } from "@harness/shared";
import { ArrowSquareOut, CheckCircle, CornersIn, CornersOut, File, MagnifyingGlass, NotePencil, Plus, Trash, X } from "@phosphor-icons/react";
import { ImagePreviewGroup, PreviewableImage } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { AttachmentPicker, UploadAttachmentList, useAttachments } from "../task-detail/Attachments.tsx";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { attachmentView } from "../task-detail/utils.ts";

const titleOf = (body: string) => body.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 42) || "无标题随手记";
const ordered = (rows: Note[]) => [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
const uniquePaths = (paths: string[]) => [...new Set(paths)];
const noteTime = (value: number) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

type NoteDraft = { id: string | null; body: string; attachments: string[] };
type SaveState = "saved" | "pending" | "saving" | "error";
type Position = { left: number; top: number };
type DragState = {
  pointerId: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  captureTarget: HTMLElement;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const clampPosition = (position: Position, width: number, height: number): Position => ({
  left: clamp(position.left, 0, Math.max(0, window.innerWidth - width)),
  top: clamp(position.top, 0, Math.max(0, window.innerHeight - height)),
});

function useMovableNotesPanel() {
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const positionRef = useRef<Position | null>(null);
  const [position, setPositionState] = useState<Position | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const setPosition = useCallback((next: Position | null) => {
    positionRef.current = next;
    setPositionState(next);
  }, []);

  const isPositioned = position !== null;
  useEffect(() => {
    if (isFullscreen || !isPositioned || !panelRef.current) return;
    const panel = panelRef.current;
    const keepInViewport = () => {
      if (!positionRef.current) return;
      const next = clampPosition(positionRef.current, panel.offsetWidth, panel.offsetHeight);
      if (next.left !== positionRef.current.left || next.top !== positionRef.current.top) setPosition(next);
    };
    keepInViewport();
    const resizeObserver = new ResizeObserver(keepInViewport);
    resizeObserver.observe(panel);
    window.addEventListener("resize", keepInViewport);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", keepInViewport);
    };
  }, [isFullscreen, isPositioned, setPosition]);

  const clearDrag = useCallback((pointerId?: number) => {
    const drag = dragRef.current;
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
    dragRef.current = null;
    try {
      if (drag.captureTarget.hasPointerCapture(drag.pointerId)) {
        drag.captureTarget.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // The element may have been detached or the browser may already have
      // released capture. Either way, the drag state is safely cleared.
    }
  }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      setPosition(clampPosition(
        { left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY },
        drag.width,
        drag.height,
      ));
      event.preventDefault();
    };
    const finishDrag = (event: PointerEvent) => clearDrag(event.pointerId);
    const cancelDrag = () => clearDrag();

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    window.addEventListener("blur", cancelDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      window.removeEventListener("blur", cancelDrag);
      clearDrag();
    };
  }, [clearDrag, setPosition]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (isFullscreen || event.button !== 0) return;
    if ((event.target as Element).closest("button, input, textarea, select, a, [role='button']")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      captureTarget: event.currentTarget,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Window-level listeners keep dragging working if capture is unavailable.
    }
    setPosition({ left: rect.left, top: rect.top });
    event.preventDefault();
  }, [isFullscreen, setPosition]);

  const toggleFullscreen = useCallback(() => {
    clearDrag();
    setIsFullscreen((current) => !current);
  }, [clearDrag]);

  const panelStyle: CSSProperties | undefined = isFullscreen
    ? {
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        maxWidth: "none",
        borderRadius: 0,
      }
    : position
      ? { position: "fixed", left: position.left, top: position.top }
      : undefined;

  return { panelRef, panelStyle, isFullscreen, toggleFullscreen, onPointerDown };
}

const sameDraft = (left: NoteDraft, right: NoteDraft) => left.id === right.id
  && left.body === right.body
  && left.attachments.length === right.attachments.length
  && left.attachments.every((path, index) => path === right.attachments[index]);

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
  const emptyDraft = (): NoteDraft => ({ id: null, body: "", attachments: [] });
  const initialDraft = emptyDraft();
  const [rows, setRows] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<NoteDraft>(initialDraft);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const movable = useMovableNotesPanel();
  const uploads = useAttachments();
  const rowsRef = useRef<Note[]>([]);
  const draftRef = useRef<NoteDraft>(initialDraft);
  const savedDraftRef = useRef<NoteDraft>(initialDraft);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);

  const updateRows = useCallback((update: (current: Note[]) => Note[]) => {
    const next = update(rowsRef.current);
    rowsRef.current = next;
    setRows(next);
  }, []);
  const updateDraft = useCallback((next: NoteDraft) => {
    draftRef.current = next;
    setDraft(next);
    setSaveState(sameDraft(next, savedDraftRef.current) ? "saved" : "pending");
  }, []);

  const flushDraft = useCallback(async (): Promise<boolean> => {
    while (true) {
      if (saveInFlightRef.current) {
        if (!await saveInFlightRef.current) return false;
        continue;
      }
      const snapshot = draftRef.current;
      if (sameDraft(snapshot, savedDraftRef.current)) return true;
      const isNew = snapshot.id === null;
      if (!snapshot.body.trim()) {
        if (isNew) return true;
        setSaveState("error");
        notify("随手记内容不能为空");
        return false;
      }
      setSaveState("saving");
      let request: Promise<boolean>;
      const persist = isNew
        ? api.createNote({ projectId: project.id, body: snapshot.body, attachments: snapshot.attachments })
        : api.patchNote(snapshot.id!, { body: snapshot.body, attachments: snapshot.attachments });
      request = persist.then(
        (saved) => {
          updateRows((current) => ordered(current.some((note) => note.id === saved.id)
            ? current.map((note) => note.id === saved.id ? saved : note)
            : [saved, ...current]));
          if (isNew && draftRef.current.id === null) {
            const promoted = { ...draftRef.current, id: saved.id };
            draftRef.current = promoted;
            setDraft(promoted);
            setActiveId(saved.id);
          }
          savedDraftRef.current = { id: saved.id, body: saved.body, attachments: saved.attachments };
          setSaveState(sameDraft(draftRef.current, savedDraftRef.current) ? "saved" : "pending");
          return true;
        },
        (reason: unknown) => {
          setSaveState("error");
          notify(reason instanceof Error ? reason.message : "随手记保存失败");
          return false;
        },
      ).finally(() => {
        if (saveInFlightRef.current === request) saveInFlightRef.current = null;
      });
      saveInFlightRef.current = request;
      if (!await request) return false;
    }
  }, [notify, project.id, updateRows]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void api.notes(project.id).then((notes) => {
      if (!alive) return;
      const nextRows = ordered(notes);
      const startNew = initialNoteId === "__new__";
      const first = startNew ? null : (initialNoteId ? nextRows.find((note) => note.id === initialNoteId) : undefined) ?? nextRows[0] ?? null;
      const nextDraft = first ? { id: first.id, body: first.body, attachments: first.attachments } : emptyDraft();
      rowsRef.current = nextRows;
      draftRef.current = nextDraft;
      savedDraftRef.current = nextDraft;
      setRows(nextRows);
      setActiveId(first?.id ?? null);
      setDraft(nextDraft);
      setPicked(new Set());
      setSaveState("saved");
      setEditing(startNew || !first);
      uploads.clear();
    }).catch((reason: unknown) => {
      if (alive) notify(reason instanceof Error ? reason.message : "随手记读取失败");
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [initialNoteId, notify, project.id, uploads.clear]);

  useEffect(() => {
    if (sameDraft(draft, savedDraftRef.current)) return;
    const timer = window.setTimeout(() => { void flushDraft(); }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, flushDraft]);

  useEffect(() => {
    if (!uploads.attachments.length) return;
    const attachments = uniquePaths([...draftRef.current.attachments, ...uploads.attachments.map((item) => item.path)]);
    updateDraft({ ...draftRef.current, attachments });
    uploads.clear();
  }, [updateDraft, uploads.attachments, uploads.clear]);

  useEffect(() => () => { void flushDraft(); }, [flushDraft]);

  const active = rows.find((note) => note.id === activeId) ?? null;
  const dirty = !sameDraft(draft, savedDraftRef.current);
  const newDraft = draft.id === null;
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return rows;
    return rows.filter((note) => (note.id === draft.id ? draft.body : note.body).toLocaleLowerCase().includes(keyword));
  }, [draft.body, draft.id, query, rows]);
  const saveStatus = newDraft && !draft.body.trim() && !draft.attachments.length ? "输入后自动保存"
    : saveState === "saving" ? "正在保存…"
      : saveState === "pending" ? "等待自动保存"
        : saveState === "error" ? "保存失败，可重试"
          : "已自动保存";
  const saveButtonLabel = !draft.body.trim() ? "保存"
    : saveState === "saving" ? "保存中…"
      : saveState === "error" ? "重试保存"
        : saveState === "pending" ? "立即保存"
          : "已保存";

  const close = useCallback(async () => {
    if (await flushDraft()) onClose();
  }, [flushDraft, onClose]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (confirmDelete) return;
      if (event.key === "Escape") void close();
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void flushDraft();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [close, confirmDelete, flushDraft]);

  const select = async (note: Note) => {
    if (note.id === draftRef.current.id || !await flushDraft()) return;
    const target = rowsRef.current.find((item) => item.id === note.id);
    if (!target) return;
    const next = { id: target.id, body: target.body, attachments: target.attachments };
    savedDraftRef.current = next;
    draftRef.current = next;
    setActiveId(target.id);
    setDraft(next);
    setSaveState("saved");
    setEditing(false);
    uploads.clear();
  };
  const create = async () => {
    if (!await flushDraft()) return;
    const next = emptyDraft();
    savedDraftRef.current = next;
    draftRef.current = next;
    setActiveId(null);
    setDraft(next);
    setSaveState("saved");
    setEditing(true);
    setQuery("");
    uploads.clear();
  };
  const remove = async () => {
    const targetId = draftRef.current.id;
    if (!targetId) return;
    setDeleting(true);
    try {
      await api.deleteNote(targetId);
      const remaining = rowsRef.current.filter((note) => note.id !== targetId);
      updateRows(() => remaining);
      setPicked((current) => {
        const nextPicked = new Set(current);
        nextPicked.delete(targetId);
        return nextPicked;
      });
      const first = remaining[0] ?? null;
      const nextDraft = first ? { id: first.id, body: first.body, attachments: first.attachments } : emptyDraft();
      savedDraftRef.current = nextDraft;
      draftRef.current = nextDraft;
      setActiveId(first?.id ?? null);
      setDraft(nextDraft);
      setSaveState("saved");
      setEditing(!first);
      uploads.clear();
      notify("随手记已删除");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "随手记删除失败");
    } finally {
      setDeleting(false);
    }
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
    if (deleting || !await flushDraft()) return;
    const selectedNotes = rowsRef.current.filter((note) => picked.has(note.id));
    const current = rowsRef.current.find((note) => note.id === draftRef.current.id) ?? null;
    const notes = selectedNotes.length ? selectedNotes : current ? [current] : [];
    if (!notes.length) return;
    onConvert({
      body: notes.map((note) => note.body).join("\n\n---\n\n"),
      attachments: uniquePaths(notes.flatMap((note) => note.attachments)),
      noteIds: notes.map((note) => note.id),
    });
  };
  return (
    <div className="overlay-scrim notes-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) void close(); }}>
      <section
        ref={movable.panelRef}
        className={`notes-panel${movable.isFullscreen ? " is-fullscreen" : ""}`}
        style={movable.panelStyle}
        role="dialog"
        aria-modal="true"
        aria-label="随手记"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={movable.isFullscreen ? "is-fullscreen" : "is-draggable"} onPointerDown={movable.onPointerDown}>
          <div><NotePencil size={17} /><b>随手记</b><span>{project.name} · {rows.length} 条</span></div>
          <div className="notes-header-actions">
            <button type="button" aria-pressed={movable.isFullscreen} onClick={movable.toggleFullscreen} aria-label={movable.isFullscreen ? "还原窗口" : "全屏显示"} title={movable.isFullscreen ? "还原窗口" : "全屏显示"}>
              {movable.isFullscreen ? <CornersIn size={17} /> : <CornersOut size={17} />}
            </button>
            <button type="button" onClick={() => void close()} aria-label="关闭"><X size={17} /></button>
          </div>
        </header>
        <div className="notes-body">
          <aside className="notes-list"><div className="notes-list-tools"><label><MagnifyingGlass size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索随手记…" /></label><button type="button" onClick={() => void create()} aria-label="新建随手记"><Plus size={15} /></button></div><div className="notes-scroll" role="list" aria-label="随手记列表">
            {!loading && newDraft && <div className="note-row ui-selectable is-selected" role="listitem"><span className="note-pick-placeholder" /><button className="note-row-main" type="button" onClick={() => setEditing(true)}><b>{titleOf(draft.body)}</b><small>{draft.body.trim() ? saveStatus : "尚未保存"}</small></button></div>}
            {filtered.map((note) => <div className={`note-row ui-selectable${note.taskId ? " is-converted" : ""}${note.id === draft.id ? " is-selected" : ""}`} key={note.id} role="listitem">
              <button className="note-pick" type="button" role="checkbox" aria-checked={picked.has(note.id)} aria-label={`选择 ${titleOf(note.body)}`} onClick={() => togglePicked(note.id)}><span className={`ui-checkbox${picked.has(note.id) ? " is-checked" : ""}`} aria-hidden="true" /></button>
              <button className="note-row-main" type="button" onClick={() => void select(note)}><b>{titleOf(note.id === draft.id ? draft.body : note.body)}</b><small>{noteTime(note.updatedAt)}</small></button>
              {note.taskId && <button className="note-task-badge" type="button" title="打开关联任务" onClick={async () => { if (await flushDraft()) onTask(note.taskId!); }}><CheckCircle size={12} weight="duotone" aria-hidden="true" /><span>已转任务</span><ArrowSquareOut className="note-task-arrow" size={11} aria-hidden="true" /></button>}
            </div>)}
            {loading && <p>读取中…</p>}{!loading && !filtered.length && !newDraft && <p>没有匹配的随手记</p>}
          </div></aside>
          <main className="note-editor">
            <div className="note-meta"><span>{newDraft ? "新随手记" : active ? `创建于 ${new Date(active.createdAt).toLocaleString("zh-CN")} · ${saveStatus}` : "新随手记"}</span>{active?.taskId && <button type="button" onClick={async () => { if (await flushDraft()) onTask(active.taskId!); }}>关联任务 ↗</button>}</div>
            {editing ? (
              <textarea autoFocus value={draft.body} onChange={(event) => updateDraft({ ...draftRef.current, body: event.target.value })} onPaste={uploads.onPaste} onBlur={() => setEditing(false)} placeholder="记下临时想法、路径、验证清单…" />
            ) : (
              <div
                className="note-editor-preview"
                role="textbox"
                tabIndex={0}
                aria-label="随手记正文，点击编辑"
                onClick={(event) => {
                  if ((event.target as Element).closest("a, button, [role='button']")) return;
                  setEditing(true);
                }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                  event.preventDefault();
                  setEditing(true);
                }}
              >
                {draft.body ? <MarkdownBody text={draft.body} /> : <p className="note-editor-placeholder">点击继续编辑随手记</p>}
              </div>
            )}
            <ImagePreviewGroup isolated>
              <div className="note-attachments">
                {draft.attachments.map((path) => { const view = attachmentView(path); return <div key={path}>{view.image && view.url ? <PreviewableImage src={view.url} alt={view.name} /> : <span><File size={16} />{view.name}</span>}<button type="button" onClick={() => updateDraft({ ...draftRef.current, attachments: draftRef.current.attachments.filter((item) => item !== path) })} aria-label={`移除 ${view.name}`}><X size={11} /></button></div>; })}
              </div>
              <UploadAttachmentList attachments={uploads.attachments} error={uploads.error} onRemove={uploads.remove} />
            </ImagePreviewGroup>
          </main>
        </div>
        <footer>
          <span>{picked.size ? `已选择 ${picked.size} 条 · 将按列表顺序合并` : `${saveStatus} · 正文失焦后显示 Markdown`}</span>
          <div className="notes-footer-actions">
            <AttachmentPicker addFiles={uploads.addFiles} disabled={deleting} />
            {active && <Button variant="danger" disabled={deleting} onClick={async () => { if (await flushDraft()) setConfirmDelete(true); }}><Trash size={13} />删除</Button>}
            <Button variant={picked.size ? "primary" : "secondary"} disabled={deleting || (!picked.size && !draft.body.trim())} onClick={() => void convert()}><NotePencil size={13} />{picked.size ? `创建任务（${picked.size}）` : "转为新任务"}</Button>
            <Button variant={picked.size ? "secondary" : "primary"} disabled={!dirty || !draft.body.trim() || deleting || saveState === "saving"} onClick={() => { void flushDraft().then((saved) => { if (saved) notify("随手记已保存"); }); }}>{saveButtonLabel}</Button>
          </div>
        </footer>
      </section>
      {confirmDelete && active && <ConfirmDialog title="删除随手记" message={`确定删除“${titleOf(active.body)}”？此操作不可撤销。`} confirmLabel="删除" danger busy={deleting} onClose={() => setConfirmDelete(false)} onConfirm={() => { setConfirmDelete(false); void remove(); }} />}
    </div>
  );
}
