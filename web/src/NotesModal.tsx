import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Note, ProjectView } from "@harness/shared";
import { ArrowSquareOut, MagnifyingGlass, NotePencil, Plus, Trash, X } from "@phosphor-icons/react";
import { api } from "./api";
import { Markdown } from "./Markdown";
import { ConfirmModal, Modal, primaryCls } from "./Modal";
import { AttachmentDisplay } from "./messageAttachments";
import { AttachButton, AttachmentChips, usePasteAttachments } from "./pasteAttachments";
import { toast } from "./toast";
import { ModalFullscreenButton, useMovableModal } from "./useMovableModal";

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
  const [query, setQuery] = useState("");
  const movable = useMovableModal();
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
  const filteredRows = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return rows;
    return rows.filter((note) => {
      const body = note.id === draft?.id ? draft.body : note.body;
      return body.toLocaleLowerCase().includes(keyword);
    });
  }, [draft, query, rows]);
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
    setQuery("");
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
        cardRef={movable.cardRef}
        cardStyle={movable.cardStyle}
        headerProps={movable.headerProps}
        headerActions={(
          <ModalFullscreenButton isFullscreen={movable.isFullscreen} onToggle={movable.toggleFullscreen} />
        )}
        contentClassName="min-h-0 overflow-hidden p-0"
        footer={selectedNotes.length ? (
          <button disabled={handoff} onClick={() => { void createTask(); }} className={`${primaryCls} inline-flex items-center gap-1.5`}>
            <NotePencil size={15} /> 创建任务（{selectedNotes.length}）
          </button>
        ) : undefined}
      >
        <div className={`grid min-h-[360px] grid-cols-[minmax(190px,260px)_minmax(0,1fr)] ${movable.isFullscreen ? "h-full" : "h-[58vh]"}`}>
          <aside className="flex min-w-0 flex-col overflow-hidden border-r border-line bg-canvas/70">
            <div className="relative mx-2 mt-2">
              <MagnifyingGlass size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                type="text"
                role="searchbox"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索正文…"
                aria-label="搜索随手记"
                className="w-full rounded-md border border-line bg-panel py-1.5 pl-8 pr-8 text-[12px] text-ink outline-none placeholder:text-faint focus:border-accent"
              />
              {query && (
                <button
                  type="button"
                  aria-label="清空搜索"
                  onClick={() => setQuery("")}
                  className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-faint hover:bg-raised hover:text-ink"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <button
              onClick={() => { void startNewNote(); }}
              className="mt-1 flex w-full shrink-0 items-center gap-1.5 border-b border-line px-3 py-2 text-[12px] font-medium text-muted transition-colors hover:bg-panel/70 hover:text-ink"
            >
              <Plus size={14} /> 新建随手记
            </button>
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {loading && <p className="px-3 py-6 text-center text-[12px] text-faint">加载中…</p>}
              {!loading && !rows.length && (
                <div className="px-5 py-12 text-center">
                  <NotePencil size={24} className="mx-auto mb-2 text-faint" />
                  <p className="text-[12px] text-muted">这个项目还没有随手记</p>
                </div>
              )}
              {!loading && rows.length > 0 && !filteredRows.length && (
                <div className="px-5 py-12 text-center">
                  <MagnifyingGlass size={22} className="mx-auto mb-2 text-faint" />
                  <p className="text-[12px] text-muted">没有匹配“{query.trim()}”的随手记</p>
                </div>
              )}
              {filteredRows.map((note) => (
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
            </div>
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
