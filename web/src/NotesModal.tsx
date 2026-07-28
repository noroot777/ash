import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Note, ProjectView } from "@harness/shared";
import { ArrowSquareOut, NotePencil, Plus, Trash } from "@phosphor-icons/react";
import { api } from "./api";
import { Markdown } from "./Markdown";
import { ConfirmModal, Modal, primaryCls } from "./Modal";
import { AttachmentDisplay } from "./messageAttachments";
import { AttachButton, AttachmentChips, usePasteAttachments } from "./pasteAttachments";
import { toast } from "./toast";
import { Kbd, submitShortcutTitle } from "./ui";

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
  const closeRef = useRef(onClose);
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
      overlayClassName="z-[70]"
      footer={(close) => {
        closeRef.current = close;
        return <>
          <AttachButton
            addFiles={addFiles}
            className="mr-auto grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink"
            title="添加图片或文件"
          />
          <button onClick={close} className="px-3 py-1.5 text-[13px] text-muted">取消</button>
          <button
            disabled={!body.trim() || busy}
            onClick={() => void save(close)}
            title={submitShortcutTitle("保存随手记")}
            className={`${primaryCls} inline-flex items-center gap-1.5`}
          >
            {busy ? "保存中…" : "保存"} <Kbd />
          </button>
        </>;
      }}
    >
      <textarea
        autoFocus
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onPaste={onPaste}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void save(closeRef.current);
        }}
        placeholder="记下临时想法…"
        className="min-h-[220px] w-full resize-y bg-transparent text-[14px] leading-relaxed text-ink outline-none placeholder:text-faint"
      />
      <AttachmentChips attachments={attachments} onRemove={remove} error={error} />
    </Modal>
  );
}

type NoteDraft = { id: string; body: string; attachments: string[] };
type SaveState = "saved" | "pending" | "saving" | "error";

// 列表内新建:先插入一条占位草稿,写出内容后 flushDraft 首存(createNote)
// 时原位替换成真条目;一直空着就随离开/关闭静默丢弃,不落库。
const NEW_NOTE_ID = "__new__";

const uniquePaths = (paths: string[]) => [...new Set(paths)];
const sameDraft = (left: NoteDraft | null, right: NoteDraft | null) =>
  left?.id === right?.id
  && left?.body === right?.body
  && left?.attachments.length === right?.attachments.length
  && left?.attachments.every((path, index) => path === right?.attachments[index]);

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
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [bodyFocused, setBodyFocused] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [deleting, setDeleting] = useState<Note | null>(null);
  const [handoff, setHandoff] = useState(false);
  const uploaded = usePasteAttachments();
  const rowsRef = useRef<Note[]>([]);
  const draftRef = useRef<NoteDraft | null>(null);
  const savedDraftRef = useRef<NoteDraft | null>(null);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);

  const updateRows = useCallback((update: (current: Note[]) => Note[]) => {
    setRows((current) => {
      const next = update(current);
      rowsRef.current = next;
      return next;
    });
  }, []);
  const updateDraft = useCallback((next: NoteDraft | null) => {
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
      if (!snapshot || sameDraft(snapshot, savedDraftRef.current)) return true;
      const isNew = snapshot.id === NEW_NOTE_ID;
      if (!snapshot.body.trim()) {
        if (isNew) return true;
        setSaveState("error");
        toast("随手记内容不能为空");
        return false;
      }
      setSaveState("saving");
      let request: Promise<boolean>;
      const persist = isNew
        ? api.createNote({ projectId: project.id, body: snapshot.body, attachments: snapshot.attachments })
        : api.patchNote(snapshot.id, { body: snapshot.body, attachments: snapshot.attachments });
      request = persist.then(
        (updated) => {
          updateRows((current) => current.map((note) => note.id === snapshot.id ? updated : note));
          if (isNew) {
            if (draftRef.current?.id === NEW_NOTE_ID) {
              draftRef.current = { ...draftRef.current, id: updated.id };
              setDraft(draftRef.current);
            }
            setActiveId((prev) => prev === NEW_NOTE_ID ? updated.id : prev);
          }
          savedDraftRef.current = { id: updated.id, body: updated.body, attachments: updated.attachments };
          setSaveState(sameDraft(draftRef.current, savedDraftRef.current) ? "saved" : "pending");
          return true;
        },
        (err) => {
          setSaveState("error");
          toast(err instanceof Error ? err.message : String(err));
          return false;
        },
      ).finally(() => {
        if (saveInFlightRef.current === request) saveInFlightRef.current = null;
      });
      saveInFlightRef.current = request;
      if (!await request) return false;
    }
  }, [updateRows, project.id]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!await flushDraft() || !alive) return;
      setLoading(true);
      try {
        const sorted = newestFirst(await api.notes(project.id));
        if (!alive) return;
        const first = (initialNoteId && sorted.find((note) => note.id === initialNoteId)) || sorted[0] || null;
        rowsRef.current = sorted;
        setRows(sorted);
        setActiveId(first?.id ?? null);
        const next = first ? { id: first.id, body: first.body, attachments: first.attachments } : null;
        savedDraftRef.current = next;
        draftRef.current = next;
        setDraft(next);
        setSaveState("saved");
        setBodyFocused(false);
        uploaded.clear();
        setPicked(new Set());
        setLoading(false);
      } catch (err) {
        if (!alive) return;
        setLoading(false);
        toast(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { alive = false; };
  }, [project.id, initialNoteId, flushDraft, uploaded.clear]);

  const active = rows.find((note) => note.id === activeId) ?? null;
  useEffect(() => {
    if (!draft || sameDraft(draft, savedDraftRef.current)) return;
    const timer = window.setTimeout(() => { void flushDraft(); }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, flushDraft]);

  useEffect(() => {
    if (!uploaded.attachments.length || !draftRef.current) return;
    const paths = uniquePaths([...draftRef.current.attachments, ...uploaded.attachments.map((item) => item.path)]);
    if (paths.length === draftRef.current.attachments.length) return;
    updateDraft({ ...draftRef.current, attachments: paths });
  }, [uploaded.attachments, updateDraft]);

  useEffect(() => () => { void flushDraft(); }, [flushDraft]);

  const selectedNotes = useMemo(() => rows.filter((note) => picked.has(note.id)), [rows, picked]);
  const toggle = (noteId: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  };

  const discardNewDraft = useCallback(() => {
    updateRows((current) => current.filter((note) => note.id !== NEW_NOTE_ID));
  }, [updateRows]);

  const startNewNote = async () => {
    if (activeId === NEW_NOTE_ID) {
      setBodyFocused(true);
      return;
    }
    if (!await flushDraft()) return;
    const now = Date.now();
    const temp: Note = { id: NEW_NOTE_ID, projectId: project.id, body: "", attachments: [], taskId: null, createdAt: now, updatedAt: now };
    updateRows((current) => [temp, ...current.filter((note) => note.id !== NEW_NOTE_ID)]);
    const next = { id: NEW_NOTE_ID, body: "", attachments: [] };
    savedDraftRef.current = next;
    draftRef.current = next;
    setDraft(next);
    setActiveId(NEW_NOTE_ID);
    setSaveState("saved");
    setBodyFocused(true);
    uploaded.clear();
  };

  const selectNote = async (noteId: string) => {
    if (noteId === activeId || !await flushDraft()) return;
    // flush 之后草稿 id 还是占位符 = 内容为空没落库,离开时直接丢弃
    if (draftRef.current?.id === NEW_NOTE_ID) discardNewDraft();
    const note = rowsRef.current.find((item) => item.id === noteId);
    if (!note) return;
    const next = { id: note.id, body: note.body, attachments: note.attachments };
    setActiveId(note.id);
    savedDraftRef.current = next;
    draftRef.current = next;
    setDraft(next);
    setSaveState("saved");
    setBodyFocused(false);
    uploaded.clear();
  };

  const removeNote = async (note: Note) => {
    try {
      await api.deleteNote(note.id);
      const remaining = rowsRef.current.filter((item) => item.id !== note.id);
      rowsRef.current = remaining;
      setRows(remaining);
      setPicked((current) => {
        const next = new Set(current);
        next.delete(note.id);
        return next;
      });
      if (activeId === note.id) {
        const first = remaining[0] ?? null;
        const next = first ? { id: first.id, body: first.body, attachments: first.attachments } : null;
        setActiveId(first?.id ?? null);
        savedDraftRef.current = next;
        draftRef.current = next;
        setDraft(next);
        uploaded.clear();
      }
      toast("随手记已删除");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const createTask = async () => {
    if (!selectedNotes.length || handoff) return;
    if (!await flushDraft()) return;
    const notes = rowsRef.current.filter((note) => picked.has(note.id));
    const draft: NoteTaskDraft = {
      noteIds: notes.map((note) => note.id),
      body: notes.map((note) => note.body).join("\n\n---\n\n"),
      attachments: uniquePaths(notes.flatMap((note) => note.attachments)),
    };
    setHandoff(true);
    setTimeout(() => onCreateTask(draft), 170);
  };

  return (
    <>
      <Modal
        title={`随手记 · ${project.name}`}
        onClose={() => { if (!handoff) onClose(); }}
        beforeClose={flushDraft}
        width={940}
        overlayClassName="z-[70]"
        cardClassName={handoff ? "note-handoff-out" : ""}
        contentClassName="min-h-0 overflow-hidden p-0"
        footer={selectedNotes.length ? (
          <button disabled={handoff} onClick={() => { void createTask(); }} className={`${primaryCls} inline-flex items-center gap-1.5`}>
            <NotePencil size={15} /> 创建任务（{selectedNotes.length}）
          </button>
        ) : undefined}
      >
        <div className="grid h-[58vh] min-h-[360px] grid-cols-[minmax(170px,250px)_minmax(0,1fr)]">
          <aside className="min-w-0 overflow-y-auto border-r border-line bg-canvas/70 py-1">
            <button
              onClick={() => { void startNewNote(); }}
              className="flex w-full items-center gap-1.5 border-b border-line px-3 py-2 text-[12px] font-medium text-muted transition-colors hover:bg-panel/70 hover:text-ink"
            >
              <Plus size={14} /> 新建随手记
            </button>
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
                {note.id === NEW_NOTE_ID ? (
                  <span className="mt-0.5 w-[13px] shrink-0" />
                ) : (
                  <input
                    type="checkbox"
                    checked={picked.has(note.id)}
                    onChange={() => toggle(note.id)}
                    className="mt-0.5 accent-accent"
                    aria-label={`选择 ${noteTitle(note.body)}`}
                  />
                )}
                <button onClick={() => { void selectNote(note.id); }} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[13px] font-medium text-ink">
                    {noteTitle(note.id === draft?.id ? draft.body : note.body)}
                  </span>
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
            ) : draft ? (
              <div className="flex min-h-full flex-col">
                <div className="mb-4 flex items-center gap-1 border-b border-line pb-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-[15px] font-semibold text-ink">{noteTitle(draft.body)}</h3>
                    <p className="text-[11px] text-faint">
                      更新于 {noteTime(active.updatedAt)} · {active.id === NEW_NOTE_ID && !draft.body.trim() ? "输入后自动保存" : saveState === "saving" ? "正在保存…" : saveState === "pending" ? "等待自动保存" : saveState === "error" ? "保存失败" : "已自动保存"}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      void flushDraft().then((saved) => {
                        if (!saved) return;
                        if (draftRef.current?.id === NEW_NOTE_ID) {
                          // 空的新建草稿没落过库,丢弃即等于删除,不必确认
                          discardNewDraft();
                          const first = rowsRef.current.find((note) => note.id !== NEW_NOTE_ID) ?? null;
                          const next = first ? { id: first.id, body: first.body, attachments: first.attachments } : null;
                          setActiveId(first?.id ?? null);
                          savedDraftRef.current = next;
                          draftRef.current = next;
                          setDraft(next);
                          setSaveState("saved");
                          setBodyFocused(false);
                          uploaded.clear();
                          return;
                        }
                        // flush 可能刚把新草稿落成真条目,闭包里的 active 未必是最新 id
                        const target = rowsRef.current.find((note) => note.id === draftRef.current?.id) ?? active;
                        setDeleting(target);
                      });
                    }}
                    className="ml-auto grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-red-50 hover:text-red-600"
                    title="删除"
                  >
                    <Trash size={15} />
                  </button>
                </div>
                {active.taskId && (
                  <button
                    onClick={() => { void flushDraft().then((saved) => { if (saved) onOpenTask(active.taskId!); }); }}
                    className="mb-4 inline-flex w-fit items-center gap-1.5 rounded-md bg-raised px-2.5 py-1.5 text-[12px] text-muted hover:text-accent"
                  >
                    已转为任务 <ArrowSquareOut size={13} />
                  </button>
                )}
                {bodyFocused ? (
                <textarea
                  autoFocus
                  value={draft.body}
                  onChange={(event) => updateDraft({ ...draftRef.current!, body: event.target.value })}
                  onPaste={uploaded.onPaste}
                  onBlur={() => setBodyFocused(false)}
                  placeholder="记下临时想法…"
                  className="min-h-[220px] flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-ink outline-none placeholder:text-faint"
                />
                ) : (
                  <div
                    role="textbox"
                    tabIndex={0}
                    aria-label="随手记正文，点击编辑"
                    onClick={(event) => {
                      if ((event.target as Element).closest("a, button")) return;
                      setBodyFocused(true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") { event.preventDefault(); setBodyFocused(true); }
                    }}
                    className="min-h-[220px] flex-1 cursor-text rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <Markdown text={draft.body} />
                  </div>
                )}
                <AttachmentDisplay
                  paths={draft.attachments.filter((path) => !uploaded.attachments.some((item) => item.path === path))}
                  className="mt-3"
                  onRemove={(path) => updateDraft({ ...draftRef.current!, attachments: draftRef.current!.attachments.filter((item) => item !== path) })}
                />
                <AttachmentChips
                  attachments={uploaded.attachments}
                  onRemove={(path) => {
                    uploaded.remove(path);
                    updateDraft({ ...draftRef.current!, attachments: draftRef.current!.attachments.filter((item) => item !== path) });
                  }}
                  error={uploaded.error}
                />
                <div className="mt-4 flex items-center border-t border-line pt-3">
                  <AttachButton
                    addFiles={uploaded.addFiles}
                    className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink"
                    title="添加图片或文件"
                  />
                  <span className="ml-2 text-[11px] text-faint">正文失焦后显示 Markdown，修改会自动保存</span>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </Modal>
      {deleting && (
        <ConfirmModal
          title="删除随手记"
          message={`确定删除「${noteTitle(deleting.body)}」？此操作不可撤销。`}
          confirmLabel="删除"
          danger
          overlayClassName="z-[80]"
          onConfirm={() => void removeNote(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
