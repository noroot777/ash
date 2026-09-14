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
export const sideRequestKey = (scope: string) => `ash:side-chat:send:${scope}`;
export const newSideChatScope = (taskId: string) => `new:${taskId}`;
