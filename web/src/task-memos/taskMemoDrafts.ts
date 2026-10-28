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
// 单独一份而不并进 `lib/DraftStore.tsx`：那份是 Context + Provider，形状按回复框/新建框
// 定（正文 + 附件 + 在途上传 + 随手记回链）；这里要的是「新建那条的草稿 + 哪几条在编辑
// + 哪几个位置有写在飞」。备忘的两个写入点本来就共用模块级 store（taskMemoStore.ts），
// 放一块更一致。
import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * 一个写入位置：`null` = 新建那条，字符串 = 那条备忘。
 *
 * 新建与某条备忘各占一格，所以内部键要隔开前缀 —— 直接用 `"new"` 当键的话，一个恰好
 * 叫 `new` 的 memoId 就会跟 composer 抢同一格。
 */
export type MemoSlot = string | null;

const keyOf = (slot: MemoSlot) => (slot === null ? "new" : `memo:${slot}`);

/** 一格草稿：正文 + 版本号。每改一次版本 +1，提交时捕获、收尾时比对。 */
type DraftSlot = { text: string; rev: number };

type Entry = {
  composing: DraftSlot | null;
  edits: Readonly<Record<string, DraftSlot>>;
  /** 有写在飞的位置（keyOf 后的键）。跨面板卸载活着 —— 这就是「在途保存的所有权」。 */
  pending: ReadonlySet<string>;
};

const EMPTY: Entry = { composing: null, edits: {}, pending: new Set() };

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

function snapshot(taskId: string): Entry {
  return entries.get(taskId) ?? EMPTY;
}

function set(taskId: string, next: Entry): void {
  // 空了就把整条记录删掉：Map 不该随着翻过的任务一直长。在途集合也要算进「空」的判据，
  // 否则一发写飞着的任务会被当成没状态清掉，回来时占位已经没了。
  const empty = next.composing === null && !Object.keys(next.edits).length && !next.pending.size;
  if (empty) entries.delete(taskId);
  else entries.set(taskId, next);
  for (const listener of listeners.get(taskId) ?? []) listener();
}

/** 下一个版本号。同一格每次改动都 +1，不复用旧号。 */
const bump = (current: DraftSlot | undefined, text: string): DraftSlot => ({
  text,
  rev: (current?.rev ?? 0) + 1,
});

/** 新建那条的草稿。传 null = 收起 composer（取消，或者已经存上了）。 */
export function setMemoComposerDraft(taskId: string, text: string | null): void {
  const current = snapshot(taskId);
  set(taskId, { ...current, composing: text === null ? null : bump(current.composing ?? undefined, text) });
}

/** 某条的编辑草稿。传 null = 退出这条的编辑态（取消、Esc，或者已经存上了）。 */
export function setMemoEditDraft(taskId: string, memoId: string, text: string | null): void {
  const current = snapshot(taskId);
  const edits = { ...current.edits };
  if (text === null) delete edits[memoId];
  else edits[memoId] = bump(current.edits[memoId], text);
  set(taskId, { ...current, edits });
}

const slotRev = (entry: Entry, slot: MemoSlot): number =>
  (slot === null ? entry.composing?.rev : entry.edits[slot]?.rev) ?? 0;

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
  if (!mine) return void set(taskId, { ...current, pending });
  if (slot === null) return void set(taskId, { ...current, pending, composing: null });
  const edits = { ...current.edits };
  delete edits[slot];
  set(taskId, { ...current, pending, edits });
}

export type TaskMemoDrafts = {
  /** 新建那条的草稿。null = composer 没开；`""` = 开着但还没打字。 */
  composing: string | null;
  /** memoId → 这条正在编辑的草稿。不在表里 = 这条是读态。 */
  edits: Readonly<Record<string, string>>;
  /** 有任何一发写在飞 —— 面板据此整体禁用（口径同原来的 busy，只是寿命跨卸载）。 */
  busy: boolean;
  /** 这个位置上有写在飞。 */
  pendingOn: (slot: MemoSlot) => boolean;
};

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
  // 版本号是内部记账，不往组件里漏：它们只要正文。
  return useMemo(() => ({
    composing: entry.composing?.text ?? null,
    edits: Object.fromEntries(Object.entries(entry.edits).map(([memoId, slot]) => [memoId, slot.text])),
    busy: entry.pending.size > 0,
    pendingOn: (slot: MemoSlot) => entry.pending.has(keyOf(slot)),
  }), [entry]);
}
