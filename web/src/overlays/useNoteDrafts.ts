// 随手记的「草稿 + 落盘」那一层。从 NotesPanel 里拆出来，是因为这里反复栽在同一个坑上：
// **同一件事存了好几份，然后靠人手同步**。曾经并存的有「服务端那份」的副本
// （savedDraftRef）、界面状态（saveState）、当前选中 id（activeId），以及一个看不出
// 主语的在途 Promise。每多一份，就得在每个使用点上补一次「这份是不是过期了 / 是不是
// 在说另一条」的判断，漏一个就出一类 bug：
//
// · 迟到的保存回包把**别人**的「已存内容」写成基准 → 下一次比对凭空判出有改动，白存一遍
// · 迟到的保存回包把刚删掉的那条塞回列表 → 用户看到「已删除」，它又自己冒出来
// · 删除期间有五条来路可以起保存（自动保存、⌘/Ctrl+回车、保存按钮、各出口、卸载清理），
//   在任何一条上单独设闸都会漏掉其余几条
//
// 所以这一层只留**两份真相**：`rows`（服务端已知的那些笔记）和 `draft`（正在编的那一份）。
// 其余全部推导：服务端那份 = `rows` 里同 id 的那行；脏不脏 = 两者比对；界面那句话 =
// `noteSaveState()`。在途的保存**自己带着主语**。于是「这份回包该不该动界面」不再是
// 散落各处的判断，而是推导的自然结果 —— 根本没有第二份状态可写错。
import { useCallback, useEffect, useRef, useState } from "react";
import type { Note } from "@ash/shared";
import { api } from "../lib/api.ts";

export type NoteDraft = { id: string | null; body: string; attachments: string[] };

/**
 * 一次落盘的三种结局。**「存不下去」和「不许走」是两件事**：
 *
 * · `saved`     —— 落盘了，或者本来就没有需要落盘的东西
 * · `unsavable` —— 正文被清空了，服务端不收空正文（`POST/PATCH /notes` 一律 400）；
 *                  这条的原文一个字没动地留在服务端那份里，没有可丢的东西
 * · `failed`    —— 请求被拒或网断了，草稿里有内容会丢
 *
 * 曾经这里只回一个 boolean，「正文空」和「真失败」都是 `false`，而面板里每个「要离开
 * 当前草稿」的动作（关闭 / Esc / 点遮罩 / 换一条 / 新建 / 删除 / 转任务）都拿它当放行
 * 条件 —— 于是「把一条已存在的随手记正文全删掉」会把整个面板焊死：删也删不掉，关也关
 * 不上。保护的本意是「别把用户的编辑弄丢」，而空正文根本没有可丢的编辑。
 */
export type FlushResult = "saved" | "unsavable" | "failed";

/** 界面上那句「存没存上」。**推导出来的**，不单独存一份 —— 见 `noteSaveState`。 */
export type SaveState = "saved" | "pending" | "saving" | "empty" | "error";

/**
 * 一次保存落在谁头上。已有笔记就是它的 id，新建草稿是 `"new"`（同一时刻只会有一份）。
 *
 * 在途的保存**必须自己带着主语**：以前它只是个光秃秃的 Promise，谁都看不出它在存哪一条，
 * 于是回包落地时只能在每个使用点上重新比一次 id。
 */
type Subject = string | "new";
const subjectOf = (draft: NoteDraft): Subject => draft.id ?? "new";

/** 删除意图。**按下删除就立起来**（不是等确认），确认之后 `confirmed` 变 true。 */
export type PendingDelete = { noteId: string; confirmed: boolean };

export const emptyDraft = (): NoteDraft => ({ id: null, body: "", attachments: [] });
export const ordered = (rows: Note[]) => [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
export const uniquePaths = (paths: string[]) => [...new Set(paths)];
export const sameAttachments = (left: NoteDraft, right: NoteDraft) => left.attachments.length === right.attachments.length
  && left.attachments.every((path, index) => path === right.attachments[index]);
export const sameDraft = (left: NoteDraft, right: NoteDraft) => left.id === right.id
  && left.body === right.body
  && sameAttachments(left, right);
const draftOf = (note: Note): NoteDraft => ({ id: note.id, body: note.body, attachments: note.attachments });

/**
 * 服务端那份。**`rows` 是唯一真相**：草稿脏不脏、存不存得上，一律跟它比。
 *
 * 回 `null` = 列表里没有这条，它已经不在了（在这边或别处被删掉了）。这一路顺带把
 * 「删完之后还能不能往它身上写」问死了：没有对象，就没什么可落盘的。
 */
const serverCopy = (rows: Note[], id: string | null): NoteDraft | null => {
  if (id === null) return emptyDraft();
  const row = rows.find((note) => note.id === id);
  return row ? draftOf(row) : null;
};

export function noteSaveState(
  draft: NoteDraft,
  rows: Note[],
  saving: Subject | null,
  failed: Subject | null,
): SaveState {
  // 正文空，服务端不收。已有笔记被清空、或者新草稿只有附件没正文，都存不上，照实说 ——
  // 别让界面说「等待自动保存」然后永远不保存。
  if (!draft.body.trim() && (draft.id !== null || draft.attachments.length > 0)) return "empty";
  const subject = subjectOf(draft);
  if (saving === subject) return "saving";
  if (failed === subject) return "error";
  const server = serverCopy(rows, draft.id);
  return !server || sameDraft(draft, server) ? "saved" : "pending";
}

/**
 * 把调用方传进来的函数钉成稳定身份。**不这么做就会出事**：没被 `useCallback` 稳住的
 * 函数（而「弹一句提示」这件事本身常常就会让调用方重渲染）会让下面「读取随手记」那个
 * effect 跟着每次渲染重跑 —— 弹一句提示就把列表重新拉一遍，把用户正在编的草稿冲掉。
 * 这一层对外的函数入口一律过这里，调用方怎么传都不影响。
 */
function useStable<A extends unknown[]>(fn: (...args: A) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

export function useNoteDrafts({ projectId, initialNoteId, notify, onLoaded }: {
  projectId: string;
  initialNoteId: string | null;
  notify: (message: string) => void;
  /** 读完一次之后告诉调用方「开在空白新建上没有」，由它决定正文是编辑态还是预览态。 */
  onLoaded: (blank: boolean) => void;
}) {
  const say = useStable(notify);
  const settle = useStable(onLoaded);

  const [rows, setRows] = useState<Note[]>([]);
  const [draft, setDraft] = useState<NoteDraft>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  // 在途与失败都只记**主语**，不记内容：内容归 rows 和 draft，这里只回答「谁正在存」
  // 和「谁上次存失败了」。界面那句话由 noteSaveState 拿它们和当前草稿一比就出来。
  const [saving, setSaving] = useState<Subject | null>(null);
  const [failed, setFailed] = useState<Subject | null>(null);

  // 异步续跑里要读「此刻最新的那份」，所以每份真相配一个镜像 ref，并且**只许经由下面
  // 这几个 write* 改**（一处同时写两边，两边不会漂）。
  const rowsRef = useRef(rows);
  const draftRef = useRef(draft);
  const pendingDeleteRef = useRef(pendingDelete);
  const savingRef = useRef<{ subject: Subject; done: Promise<FlushResult> } | null>(null);

  const writeRows = useCallback((update: (current: Note[]) => Note[]) => {
    rowsRef.current = update(rowsRef.current);
    setRows(rowsRef.current);
  }, []);
  const writeDraft = useCallback((update: (current: NoteDraft) => NoteDraft) => {
    draftRef.current = update(draftRef.current);
    setDraft(draftRef.current);
  }, []);
  const writePendingDelete = useCallback((next: PendingDelete | null) => {
    pendingDeleteRef.current = next;
    setPendingDelete(next);
  }, []);

  const edit = useCallback((update: (current: NoteDraft) => NoteDraft) => {
    writeDraft(update);
    // 这一条的上次失败不再成立了：用户已经改过内容，接下来是新的一次尝试。
    setFailed((current) => current === subjectOf(draftRef.current) ? null : current);
  }, [writeDraft]);

  /**
   * 把当前草稿落盘，回报**当前草稿**的处境。
   *
   * **「这次请求存了什么」和「当前草稿还有没有要存的东西」是两个判据。** 一次落盘要走
   * 一个网络往返，这期间用户完全可能又打了字 —— 尤其是「清空正文、改了附件」那一路：
   * 附件那半边单独落盘的结论是 `unsavable`，可等它回来时正文早已经写上新内容了。所以
   * 每一轮等待结束都回到循环顶上**重新看一遍当前草稿**，绝不拿上一次请求的结论代表它。
   * 真失败是唯一的例外：那说明确实有内容没存住，得当场留住用户。
   */
  const flush = useCallback(async (): Promise<FlushResult> => {
    // 这一轮里刚成功存过的那份内容，只用来兜住「服务端把内容规范化成了别的样子」——
    // 那种情况草稿会一直判成脏的，同一份再发一遍还是同一份，会原地打转。
    let persisted: NoteDraft | null = null;
    while (true) {
      const running = savingRef.current;
      if (running) {
        // 别人的请求（甚至是别条笔记的请求）结束了：回头重新判，不接管它的结论。
        if (await running.done === "failed") return "failed";
        continue;
      }
      const sent = draftRef.current;
      // 用户已经按过删除了：这条不值得再往服务端写。判据放在**起保存的这一处**，于是
      // 自动保存、⌘/Ctrl+回车、保存按钮、各出口的 leave()、卸载清理全都走这同一道闸，
      // 不必各自记得加判断（漏一条就是一个竞态）。
      if (sent.id !== null && pendingDeleteRef.current?.noteId === sent.id) return "saved";
      const server = serverCopy(rowsRef.current, sent.id);
      // 列表里没有这条 = 它已经不在了，没什么可落盘的。
      if (!server || sameDraft(sent, server)) return "saved";
      const blank = !sent.body.trim();
      // 新建的空草稿压根没落过盘：没东西可存，也没有「原内容」可提。（这种草稿带着附件
      // 时附件会被丢掉，基线就是这样 —— `POST /notes` 没有「只存附件」这一路。）
      if (blank && sent.id === null) return "saved";
      // 「正文空」证明不了「这份草稿没有要紧东西」：附件可能刚变过（传了新的、摘掉了
      // 旧的）。`PATCH /notes/:id` 不带 body 时服务端跳过空正文校验（server/src/notes.ts），
      // 所以附件那半边照旧单独落盘 —— 否则用户刚传完的那张图一离开就只剩 uploads 里
      // 一个没人认领的文件，摘掉附件的那一下同样白做。
      if (blank && sameAttachments(sent, server)) return "unsavable";
      // 同一份内容刚存过、回来还判成脏的，只能是服务端把它规范化成了别的样子。等用户
      // 下次真的改动再说，别拿同一份去撞第二次。
      if (persisted && sameDraft(sent, persisted)) return blank ? "unsavable" : "saved";
      const subject = subjectOf(sent);
      const record: { subject: Subject; done: Promise<FlushResult> } = { subject, done: Promise.resolve("saved") };
      record.done = (sent.id === null
        ? api.createNote({ projectId, body: sent.body, attachments: sent.attachments })
        : api.patchNote(sent.id, blank
          ? { attachments: sent.attachments }
          : { body: sent.body, attachments: sent.attachments })
      ).then(
        (saved): FlushResult => {
          // 回包只做两件事，各自认 id：新建的那条**插进**列表，已有的那条**替换**列表里
          // 同 id 的那行。「替换不到就不插」是硬规矩 —— 替换不到只能说明它在这次请求在途
          // 期间被删了，插回去就成了「提示过已删除、它又自己冒出来」。
          writeRows((current) => sent.id === null
            ? ordered([saved, ...current])
            : current.some((note) => note.id === saved.id)
              ? ordered(current.map((note) => note.id === saved.id ? saved : note))
              : current);
          // 新建的那条拿到 id 了，草稿跟着升级 —— 除非用户已经切走了。
          if (sent.id === null && draftRef.current.id === null) writeDraft((current) => ({ ...current, id: saved.id }));
          setFailed((current) => current === subject ? null : current);
          // 正文空的那一半仍然没落盘：附件存住了，正文留着服务端那份。
          return blank ? "unsavable" : "saved";
        },
        (reason: unknown): FlushResult => {
          setFailed(subject);
          say(reason instanceof Error ? reason.message : "随手记保存失败");
          return "failed";
        },
      ).finally(() => {
        if (savingRef.current === record) {
          savingRef.current = null;
          setSaving(null);
        }
      });
      savingRef.current = record;
      setSaving(subject);
      if (await record.done === "failed") return "failed";
      persisted = sent;
      // 这里**故意不回报结论**：存完了也要回到循环顶上重新判当前草稿 —— 请求期间它可能
      // 又被改过（那就再存一轮），也可能只剩「正文空存不上」这件事要作为结论回出去。
    }
  }, [projectId, say, writeDraft, writeRows]);

  /**
   * 「要离开当前草稿」统一过这一关。**只有真失败才留住用户** —— 正文清空了存不下去的，
   * 服务端那份原文还在，把人挡在这里只会让删除、关闭、换一条全都点不动。
   */
  const leave = useCallback(async (): Promise<boolean> => {
    const result = await flush();
    if (result === "unsavable") say("随手记不能为空，原内容已保留");
    return result !== "failed";
  }, [flush, say]);

  const openNote = useCallback(async (noteId: string): Promise<boolean> => {
    if (noteId === draftRef.current.id || !await leave()) return false;
    const target = rowsRef.current.find((note) => note.id === noteId);
    if (!target) return false;
    writeDraft(() => draftOf(target));
    return true;
  }, [leave, writeDraft]);

  const openNew = useCallback(async (): Promise<boolean> => {
    if (!await leave()) return false;
    writeDraft(emptyDraft);
    return true;
  }, [leave, writeDraft]);

  const askDelete = useCallback(() => {
    const noteId = draftRef.current.id;
    if (noteId) writePendingDelete({ noteId, confirmed: false });
  }, [writePendingDelete]);
  const cancelDelete = useCallback(() => writePendingDelete(null), [writePendingDelete]);

  /**
   * 确认删除。**不先落盘**：这条记马上要被销毁，存一遍毫无意义，而「存不下去就不许删」
   * 正是「清空正文后删除按钮点不动」的来由 —— 删除意图从 `askDelete` 那一刻就立着，
   * 上面 flush 的那道闸已经保证这期间没人再往它身上写。
   */
  const confirmDelete = useCallback(async (): Promise<{ deleted: string | null; blank: boolean }> => {
    const pending = pendingDeleteRef.current;
    if (!pending || pending.confirmed) return { deleted: null, blank: false };
    writePendingDelete({ ...pending, confirmed: true });
    try {
      // 已经在途的那次保存要等完才发 DELETE。它的回包已经动不了列表（替换按 id、替换
      // 不到就不插），但两个请求抢同一条记录时若 DELETE 先落地，那次 PATCH 会在服务端
      // 扑空 —— 用户就会在「已删除」之后又收到一句莫名的保存失败。
      while (savingRef.current) await savingRef.current.done;
      await api.deleteNote(pending.noteId);
      const remaining = rowsRef.current.filter((note) => note.id !== pending.noteId);
      writeRows(() => remaining);
      const next = remaining[0] ?? null;
      writeDraft(() => next ? draftOf(next) : emptyDraft());
      say("随手记已删除");
      return { deleted: pending.noteId, blank: !next };
    } catch (reason) {
      say(reason instanceof Error ? reason.message : "随手记删除失败");
      return { deleted: null, blank: false };
    } finally {
      // 删成了：这条已经不在 rows 里，serverCopy 回 null，谁也存不动它了。
      // 删失败了：它还在，用户可以接着编辑和重试，保存得放开。
      writePendingDelete(null);
    }
  }, [say, writeDraft, writePendingDelete, writeRows]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void api.notes(projectId).then((notes) => {
      if (!alive) return;
      const nextRows = ordered(notes);
      const startNew = initialNoteId === "__new__";
      const first = startNew
        ? null
        : (initialNoteId ? nextRows.find((note) => note.id === initialNoteId) : undefined) ?? nextRows[0] ?? null;
      writeRows(() => nextRows);
      writeDraft(() => first ? draftOf(first) : emptyDraft());
      writePendingDelete(null);
      setSaving(null);
      setFailed(null);
      settle(startNew || !first);
    }).catch((reason: unknown) => {
      if (alive) say(reason instanceof Error ? reason.message : "随手记读取失败");
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [initialNoteId, projectId, say, settle, writeDraft, writePendingDelete, writeRows]);

  // 脏了就排一次自动保存。**判据只看「草稿和服务端那份不一样」**：正文空也照排 —— 正文
  // 存不上，但附件那半边要存。能不能写、该不该写（正在删的那条就不该）全归 flush 自己判，
  // 这里不重复一遍，免得两处判据日后漂开。
  useEffect(() => {
    const server = serverCopy(rows, draft.id);
    if (!server || sameDraft(draft, server)) return;
    // `pendingDelete` 必须进依赖 —— 它是**调度触发器**，不是在这儿重复一道闸。删除意图
    // 立起来的时候这个定时器本来就该撤掉（马上要删的东西不值得存），而取消确认或者删除
    // 失败之后得有人**重新排一次**：少了这一下，草稿就一直停在「等待自动保存」，用户不
    // 手动点一下永远不落盘。准入（flush 那道闸）和调度（这里）必须成对出现。
    if (pendingDelete) return;
    const timer = window.setTimeout(() => { void flush(); }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, flush, pendingDelete, rows]);

  useEffect(() => () => { void flush(); }, [flush]);

  /**
   * 读「此刻最新的」那份。**`await` 之后只能用这个**：渲染时闭包捕获的 `rows`/`draft`
   * 可能已经被一次落盘更新过了。
   */
  const latest = useCallback(() => ({ rows: rowsRef.current, draft: draftRef.current }), []);

  const server = serverCopy(rows, draft.id);
  // 返回的每个函数都是稳定身份（useCallback，依赖全是稳定值），这样调用方可以把它们直接
  // 写进 effect 依赖。**别把整个返回对象写进依赖** —— 它每次渲染都是新的。
  return {
    rows,
    draft,
    loading,
    pendingDelete,
    deleting: pendingDelete?.confirmed === true,
    /** 当前草稿对应的那条服务端记录；新建草稿没有。列表标题、创建时间、回链都读它。 */
    active: draft.id === null ? null : rows.find((note) => note.id === draft.id) ?? null,
    dirty: !!server && !sameDraft(draft, server),
    saveState: noteSaveState(draft, rows, saving, failed),
    edit,
    flush,
    leave,
    openNote,
    openNew,
    askDelete,
    cancelDelete,
    confirmDelete,
    latest,
  };
}
