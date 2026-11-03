import { KEY_CHORD_TIMEOUT_MS } from "../lib/keyChord.ts";

// 面板里某一节的直达键（`I Q` 后续追问）：Host 先把那一格面板切到前台，再按节 id 喊一声，
// 怎么展开、滚到哪由面板自己定 —— Host 不知道也不该知道节长什么样。
//
// 喊的那一刻面板未必挂着：Inspector 收着、或者前台是别的格，那一格要等这次切换渲染完才
// 挂上来（Host 只渲染前台那一格）。所以没人接的请求先挂着，同名节一挂上就领走。挂着的
// 请求放不久：切换本该在同一轮渲染里落地，过了一个和弦超时还没人领，说明那一格没开成，
// 不能留着让之后哪次碰巧挂上的同名节无故自己展开。

export interface InspectorSection<Key extends string = string> {
  id: string;
  shortcut: Key;
}

const PENDING_TTL_MS = KEY_CHORD_TIMEOUT_MS;

const listeners = new Map<string, () => void>();
let pending: { id: string; at: number } | null = null;

export function requestInspectorSection(id: string, now = Date.now()): void {
  const reveal = listeners.get(id);
  if (reveal) {
    pending = null;
    reveal();
    return;
  }
  pending = { id, at: now };
}

/** 面板挂载时登记自己那一节；返回值当 effect 的清理函数用。 */
export function subscribeInspectorSection(id: string, reveal: () => void, now = Date.now()): () => void {
  listeners.set(id, reveal);
  if (pending?.id === id) {
    const fresh = now - pending.at <= PENDING_TTL_MS;
    pending = null;
    if (fresh) reveal();
  }
  return () => {
    if (listeners.get(id) === reveal) listeners.delete(id);
  };
}
