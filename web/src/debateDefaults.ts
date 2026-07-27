import type { DebateConfig } from "@harness/shared";
import { DEBATE_DEFAULTS, normalizeDebateConfig } from "@harness/shared";

// Per-slot defaults persist in localStorage so "设为默认" survives reloads
// (DESIGN.md §7 — the slot popover's "设为默认" action).
const KEY = "harness.debateDefaults";

export function loadDefaults(): DebateConfig {
  try {
    return normalizeDebateConfig(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    return { ...DEBATE_DEFAULTS };
  }
}

export function saveDefault<K extends keyof DebateConfig>(key: K, value: DebateConfig[K]) {
  saveDefaults({ [key]: value } as Partial<DebateConfig>);
}

export function saveDefaults(patch: Partial<DebateConfig>) {
  const cur = loadDefaults();
  const next = { ...cur, ...patch };
  // never persist the topic as a default
  delete (next as Partial<DebateConfig>).topic;
  localStorage.setItem(KEY, JSON.stringify(normalizeDebateConfig(next)));
}
