const fallback = new Map<string, string>();

export function readSideStorage(key: string): string | null {
  if (fallback.has(key)) return fallback.get(key)!;
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writeSideStorage(key: string, value: string) {
  try { localStorage.setItem(key, value); fallback.delete(key); }
  catch { fallback.set(key, value); }
}

export const sideDraftKey = (scope: string) => `ash:side-chat:draft:${scope}`;
/** 草稿正文的版本（同主会话 DraftStore 的 textVersion）：正文一变、「改了再发」一认领就换一个。 */
export const sideDraftVersionKey = (scope: string) => `ash:side-chat:draft-version:${scope}`;
export const sideRequestKey = (scope: string) => `ash:side-chat:send:${scope}`;
/** 草稿里已经传上去的附件。跟正文同一个 scope，切走再切回来还在原处。 */
export const sideAttachmentsKey = (scope: string) => `ash:side-chat:files:${scope}`;
export const newSideChatScope = (taskId: string) => `new:${taskId}`;
