import { randomUUID } from "node:crypto";

let lease: { token: string; deadline: number } | null = null;

export function runtimeHandoverActive(): boolean {
  if (lease && Date.now() >= lease.deadline) lease = null;
  return lease !== null;
}

export function reserveRuntimeHandover(): string | null {
  if (runtimeHandoverActive()) return null;
  lease = { token: randomUUID(), deadline: Date.now() + 60_000 };
  return lease.token;
}

export function releaseRuntimeHandover(token: string): boolean {
  if (!lease || lease.token !== token) return false;
  lease = null;
  return true;
}

export function runtimeHandoverMatches(token: string): boolean {
  return runtimeHandoverActive() && lease?.token === token;
}
