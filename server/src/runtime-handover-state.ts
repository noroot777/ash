import { randomUUID } from "node:crypto";

export class RuntimeHandoverBlockedError extends Error {
  constructor() {
    super("正在切换新版服务，完成后重试此操作");
    this.name = "RuntimeHandoverBlockedError";
  }
}

let lease: { token: string; deadline: number } | null = null;
let expiry: ReturnType<typeof setTimeout> | null = null;
const waiting = new Set<() => void>();

function endLease(): void {
  lease = null;
  if (expiry) clearTimeout(expiry);
  expiry = null;
  const callbacks = [...waiting];
  waiting.clear();
  for (const callback of callbacks) {
    try { callback(); } catch (error) { console.error("[navi] runtime handover waiter failed:", error); }
  }
}

export function runtimeHandoverActive(): boolean {
  if (lease && Date.now() >= lease.deadline) endLease();
  return lease !== null;
}

export function reserveRuntimeHandover(): string | null {
  if (runtimeHandoverActive()) return null;
  lease = { token: randomUUID(), deadline: Date.now() + 60_000 };
  expiry = setTimeout(endLease, 60_000);
  expiry.unref();
  return lease.token;
}

export function releaseRuntimeHandover(token: string): boolean {
  if (!lease || lease.token !== token) return false;
  endLease();
  return true;
}

export function runtimeHandoverMatches(token: string): boolean {
  return runtimeHandoverActive() && lease?.token === token;
}

export function afterRuntimeHandover(callback: () => void): () => void {
  if (!runtimeHandoverActive()) { callback(); return () => {}; }
  waiting.add(callback);
  return () => { waiting.delete(callback); };
}
