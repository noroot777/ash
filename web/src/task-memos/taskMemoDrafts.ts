// 还没保存的那几个字，**以及正在飞的那几发写**。跟 `lib/DraftStore.tsx` 同一条原则：
// 组件卸载不该把用户敲的字弄丢，存活范围是这一次会话（刷新即清空）。
//
// 备忘这一格尤其吃这条，有两条路都会把面板卸载掉，而且都不是用户按的：
//  · 激活哪一格由 `stateKey` 推（它含任务 status 和 reviewFocused）—— 任务一跑完、一进
//    审查焦点，右边就自己跳回「信息 / 审查」；
//  · `InspectorHost` 只渲染当前那一格，切走 = 卸载。
// 于是「编辑一条备忘、还没保存，任务这会儿结束了」就把几百字连同编辑态一起带走了
// （独立审查第 2 轮 F1 实测）。草稿挪到模块级之后，切走再切回来，字还在、还在编辑态。
//
// **在途写也必须住在这里，跟草稿同寿命** —— 这是第 3 轮 F1 的根因：草稿搬出来了，而
// 「正在保存」还是面板自己的 state。保存途中切走再回来，那个 state 重置成 false，用户
// 于是能在同一个框里接着写第二版；先前那一发回来时无条件清草稿，第二版当场消失，而且
// 没有恢复入口（实测：第一版 450 字存上、后写的 560 字一个字没留）。两件事放一起之后：
//  ① 在途期间框子一直是禁用的，不会出现「看着能写、写了白写」；
//  ② 清草稿要带上**提交那一刻的版本号**，版本变过（用户又写了）就不清。
// ② 不是 ① 的重复：同一个位置的写入口不止面板一处（会话浮条的「添加到备忘」直接进
// store），②​ 是不依赖 UI 的那道。判等用版本号而不是比对正文：改过又改回也算动过，
// 跟 `lib/DraftStore.tsx` 拿对象引用当版本标识是同一个取舍。
//
// **贴进来的图也是草稿的一部分**，在途的上传同理：传一张截图要几秒，这期间面板被切走
// 的话，传完那张图得落回原来那份草稿里，而不是跟着卸载的组件一起丢掉。传**失败**也一样
// 要落在这里：只记「成功 / 在途」的话，失败那张从在途里一摘就跟没选过一样（第 1 轮审查 F2）。
//
// 单独一份而不并进 `lib/DraftStore.tsx`：那份是 Context + Provider，形状按回复框/新建框
// 定（正文 + 附件 + 在途上传 + 随手记回链）；这里要的是「新建那条的草稿 + 哪几条在编辑
// + 哪几个位置有写在飞」。备忘的两个写入点本来就共用模块级 store（taskMemoStore.ts），
// 放一块更一致。
import { useCallback, useMemo, useSyncExternalStore, type SetStateAction } from "react";
import type { UploadingFile } from "../task-detail/Attachments.tsx";
import { createClientId } from "../lib/clientId.ts";

/**
 * 一个写入位置：`null` = 新建那条，字符串 = 那条备忘。
 *
 * 新建与某条备忘各占一格，所以内部键要隔开前缀 —— 直接用 `"new"` 当键的话，一个恰好
 * 叫 `new` 的 memoId 就会跟 composer 抢同一格。
 */
export type MemoSlot = string | null;

const keyOf = (slot: MemoSlot) => (slot === null ? "new" : `memo:${slot}`);

/** 一份草稿：正文 + 贴进来的附件路径。 */
export type MemoDraft = { text: string; attachments: readonly string[] };

/** 一张没传上去的。留着原文件，重试不用再选一遍。 */
export type MemoUploadFailure = { id: string; file: File; message: string };

/** 一格草稿 + 版本号。正文或附件每改一次版本 +1，提交时捕获、收尾时比对。 */
type DraftSlot = MemoDraft & { rev: number };

type Entry = {
  composing: DraftSlot | null;
  edits: Readonly<Record<string, DraftSlot>>;
  /** 有写在飞的位置（keyOf 后的键）。跨面板卸载活着 —— 这就是「在途保存的所有权」。 */
  pending: ReadonlySet<string>;
  /** 各位置在途的上传（keyOf 后的键）。同样跨卸载：传完要落回这一格的草稿。 */
  uploads: Readonly<Record<string, readonly UploadingFile[]>>;
  /** 各位置传失败的（keyOf 后的键）。用户重试或移除之前一直在，这一格因此存不了。 */
  failures: Readonly<Record<string, readonly MemoUploadFailure[]>>;
};

const EMPTY: Entry = { composing: null, edits: {}, pending: new Set(), uploads: {}, failures: {} };
const NO_UPLOADS: readonly UploadingFile[] = [];
const NO_FAILURES: readonly MemoUploadFailure[] = [];

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

function snapshot(taskId: string): Entry {
  return entries.get(taskId) ?? EMPTY;
}

function set(taskId: string, next: Entry): void {
  // 空了就把整条记录删掉：Map 不该随着翻过的任务一直长。在途的写和上传都要算进「空」的
  // 判据，否则一发飞着的任务会被当成没状态清掉，回来时占位已经没了。
  const empty = next.composing === null && !Object.keys(next.edits).length && !next.pending.size
    && !Object.keys(next.uploads).length && !Object.keys(next.failures).length;
  if (empty) entries.delete(taskId);
  else entries.set(taskId, next);
  for (const listener of listeners.get(taskId) ?? []) listener();
}

const slotOf = (entry: Entry, slot: MemoSlot): DraftSlot | undefined =>
  (slot === null ? entry.composing ?? undefined : entry.edits[slot]);

/** 设一格草稿。收起（null）时这一格的失败记录跟着清掉：草稿都不要了，那几张也没处落。 */
function withSlot(entry: Entry, slot: MemoSlot, next: DraftSlot | null): Entry {
  const base = next === null ? withFailures(entry, slot, []) : entry;
  if (slot === null) return { ...base, composing: next };
  const edits = { ...base.edits };
  if (next === null) delete edits[slot];
  else edits[slot] = next;
  return { ...base, edits };
}

function withFailures(entry: Entry, slot: MemoSlot, next: readonly MemoUploadFailure[]): Entry {
  const failures = { ...entry.failures };
  if (next.length) failures[keyOf(slot)] = next;
  else delete failures[keyOf(slot)];
  return { ...entry, failures };
}

function withUploads(entry: Entry, slot: MemoSlot, next: readonly UploadingFile[]): Entry {
  const uploads = { ...entry.uploads };
  if (next.length) uploads[keyOf(slot)] = next;
  else delete uploads[keyOf(slot)];
  return { ...entry, uploads };
}

/**
 * 设一格草稿。传 null = 收起这一格（取消、Esc，或者已经存上了）。
 *
 * 收起时这一格还在传的附件一并掐掉：草稿都不要了，传完也没处落；不掐的话它会在背后
 * 把一份已经关掉的草稿又撑出来。
 */
export function setMemoDraft(taskId: string, slot: MemoSlot, draft: MemoDraft | null): void {
  const current = snapshot(taskId);
  if (draft === null) {
    for (const upload of current.uploads[keyOf(slot)] ?? []) upload.abort();
    return void set(taskId, withUploads(withSlot(current, slot, null), slot, []));
  }
  const rev = (slotOf(current, slot)?.rev ?? 0) + 1;
  set(taskId, withSlot(current, slot, { text: draft.text, attachments: draft.attachments, rev }));
}

/** 只改这一格的附件（上传落地、摘掉一张）。这一格已经收起就什么都不做。 */
export function updateMemoAttachments(
  taskId: string,
  slot: MemoSlot,
  update: (current: readonly string[]) => readonly string[],
): void {
  const draft = slotOf(snapshot(taskId), slot);
  if (!draft) return;
  setMemoDraft(taskId, slot, { text: draft.text, attachments: update(draft.attachments) });
}

/** 这一格在途的上传。`useAttachments` 的 pending 受控于这里，所以面板卸载了也还在。 */
export function setMemoUploads(taskId: string, slot: MemoSlot, update: SetStateAction<UploadingFile[]>): void {
  const current = snapshot(taskId);
  const before = [...(current.uploads[keyOf(slot)] ?? NO_UPLOADS)];
  set(taskId, withUploads(current, slot, typeof update === "function" ? update(before) : update));
}

/**
 * 记下一张没传上去的。挂在 store 上而不是编辑框的 state 里：失败到达时编辑框可能已经卸载、
 * 甚至已经换成了重新挂载的另一个实例。这一格已经收起就不记（收起时在途的都被掐掉了）。
 */
export function addMemoUploadFailure(taskId: string, slot: MemoSlot, file: File, message: string): void {
  const current = snapshot(taskId);
  if (!slotOf(current, slot)) return;
  const before = current.failures[keyOf(slot)] ?? NO_FAILURES;
  set(taskId, withFailures(current, slot, [...before, { id: createClientId(), file, message }]));
}

/** 摘掉一条失败记录（用户点了移除，或者拿它重试）。 */
export function dropMemoUploadFailure(taskId: string, slot: MemoSlot, id: string): void {
  const current = snapshot(taskId);
  const before = current.failures[keyOf(slot)] ?? NO_FAILURES;
  set(taskId, withFailures(current, slot, before.filter((item) => item.id !== id)));
}

const slotRev = (entry: Entry, slot: MemoSlot): number => slotOf(entry, slot)?.rev ?? 0;

/**
 * 占住一个位置准备写，返回**此刻的草稿版本号**（写完拿它调 `finishMemoWrite`）。
 *
 * 回 `null` = 这个位置已经有一发在飞，这一发不要发出去。调用点因此不必自己维护
 * 「重复提交」判断，而且这道闸在 store 层 —— UI 的 disabled 只挡住看得见的那颗按钮。
 */
export function beginMemoWrite(taskId: string, slot: MemoSlot): number | null {
  const current = snapshot(taskId);
  const key = keyOf(slot);
  if (current.pending.has(key)) return null;
  const pending = new Set(current.pending);
  pending.add(key);
  set(taskId, { ...current, pending });
  return slotRev(current, slot);
}

/**
 * 写完了（不论成败）：交还占位。
 *
 * `clearDraft` 为真**且草稿还是提交时那一版**才清掉它。版本变过说明用户在这一发飞着的
 * 时候又写了新的，清掉等于把新写的几百字吃掉（第 3 轮 F1）。失败时一律不清 —— 那几百
 * 字得留在框里（第 1 轮 F2）。
 */
export function finishMemoWrite(taskId: string, slot: MemoSlot, rev: number, clearDraft: boolean): void {
  const current = snapshot(taskId);
  const pending = new Set(current.pending);
  pending.delete(keyOf(slot));
  // 「这一版是我提交的那一版」才轮得到我清。
  const mine = clearDraft && slotRev(current, slot) === rev;
  set(taskId, mine ? withSlot({ ...current, pending }, slot, null) : { ...current, pending });
}

export type TaskMemoDrafts = {
  /** 新建那条的草稿。null = composer 没开；正文 `""` = 开着但还没打字。 */
  composing: MemoDraft | null;
  /** memoId → 这条正在编辑的草稿。不在表里 = 这条是读态。 */
  edits: Readonly<Record<string, MemoDraft>>;
  /** 有任何一发写在飞 —— 面板据此整体禁用（口径同原来的 busy，只是寿命跨卸载）。 */
  busy: boolean;
  /** 这个位置上有写在飞。 */
  pendingOn: (slot: MemoSlot) => boolean;
  /** 这个位置上在途的上传。 */
  uploadsOn: (slot: MemoSlot) => readonly UploadingFile[];
  /** 这个位置上传失败、还没处理的。 */
  failuresOn: (slot: MemoSlot) => readonly MemoUploadFailure[];
};

const draftOf = ({ text, attachments }: DraftSlot): MemoDraft => ({ text, attachments });

export function useTaskMemoDrafts(taskId: string): TaskMemoDrafts {
  const entry = useSyncExternalStore(
    useCallback((listener: () => void) => {
      const set = listeners.get(taskId) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(taskId, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(taskId);
      };
    }, [taskId]),
    () => snapshot(taskId),
    () => EMPTY,
  );
  // 版本号是内部记账，不往组件里漏：它们只要正文和附件。
  return useMemo(() => ({
    composing: entry.composing ? draftOf(entry.composing) : null,
    edits: Object.fromEntries(Object.entries(entry.edits).map(([memoId, slot]) => [memoId, draftOf(slot)])),
    busy: entry.pending.size > 0,
    pendingOn: (slot: MemoSlot) => entry.pending.has(keyOf(slot)),
    uploadsOn: (slot: MemoSlot) => entry.uploads[keyOf(slot)] ?? NO_UPLOADS,
    failuresOn: (slot: MemoSlot) => entry.failures[keyOf(slot)] ?? NO_FAILURES,
  }), [entry]);
}
