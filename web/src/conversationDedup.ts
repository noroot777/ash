import { parseSessionOutput } from "@harness/shared";
import type { LogLine } from "./Conversation";

type SnapshotEntry = { s: { id: string }; out: string };

const compact = (text: string) => text.replace(/\s+/g, "");

// A refresh replaces every live line before the captured cursor with the
// persisted snapshot. Output can keep streaming while the snapshot request is
// in flight, though, so remove only the tail prefix that the returned files
// already contain; later SSE chunks remain live.
export function dropSnapshotCoveredLogs(snapshot: SnapshotEntry[], logs: LogLine[]): LogLine[] {
  if (snapshot.length === 0 || logs.length === 0) return logs;

  const agentText = new Map<string, string>();
  const persistedTurns = new Map<string, number>();
  for (const { s, out } of snapshot) {
    const segs = parseSessionOutput(out);
    agentText.set(s.id, compact(segs.filter((seg) => seg.kind === "agent").map((seg) => seg.text).join("")));
    for (const seg of segs) {
      if (seg.kind === "agent") continue;
      const key = turnKey(seg.kind, seg.text, seg.kind === "system" ? s.id : undefined);
      persistedTurns.set(key, (persistedTurns.get(key) ?? 0) + 1);
    }
  }

  const liveText = new Map<string, string>();
  for (const line of logs) {
    if ((line.kind !== "text" && line.kind !== "thinking") || !line.sessionId) continue;
    liveText.set(line.sessionId, (liveText.get(line.sessionId) ?? "") + compact(line.text));
  }
  const coveredChars = new Map<string, number>();
  for (const [sessionId, text] of liveText) {
    coveredChars.set(sessionId, snapshotSuffixOverlap(agentText.get(sessionId) ?? "", text));
  }

  const consumedChars = new Map<string, number>();
  return logs.filter((line) => {
    if ((line.kind === "text" || line.kind === "thinking") && line.sessionId) {
      const length = compact(line.text).length;
      const consumed = consumedChars.get(line.sessionId) ?? 0;
      const next = consumed + length;
      consumedChars.set(line.sessionId, next);
      if (next <= (coveredChars.get(line.sessionId) ?? 0)) return false;
    }
    if (line.kind === "user" || line.kind === "system") {
      const key = turnKey(line.kind, line.text, line.kind === "system" ? line.sessionId : undefined);
      const count = persistedTurns.get(key) ?? 0;
      if (count > 0) {
        persistedTurns.set(key, count - 1);
        return false;
      }
    }
    return true;
  });
}

export function liveLogsAfterSnapshot(
  snapshot: SnapshotEntry[],
  logs: LogLine[],
  cutoff: number,
  dedupeThrough: number,
): LogLine[] {
  return [
    ...dropSnapshotReplacedPrefix(snapshot, logs.slice(0, cutoff)),
    ...dropSnapshotCoveredLogs(snapshot, logs.slice(cutoff, dedupeThrough)),
    ...logs.slice(dedupeThrough),
  ];
}

function dropSnapshotReplacedPrefix(snapshot: SnapshotEntry[], logs: LogLine[]): LogLine[] {
  if (snapshot.length === 0 || logs.length === 0) return logs;
  const sessionIds = new Set(snapshot.map(({ s }) => s.id));
  const persistedTurns = new Map<string, number>();
  for (const { s, out } of snapshot) {
    for (const seg of parseSessionOutput(out)) {
      if (seg.kind === "agent") continue;
      const key = turnKey(seg.kind, seg.text, seg.kind === "system" ? s.id : undefined);
      persistedTurns.set(key, (persistedTurns.get(key) ?? 0) + 1);
    }
  }
  return logs.filter((line) => {
    if (line.kind === "user" || line.kind === "system") {
      const key = turnKey(line.kind, line.text, line.kind === "system" ? line.sessionId : undefined);
      const count = persistedTurns.get(key) ?? 0;
      if (count > 0) {
        persistedTurns.set(key, count - 1);
        return false;
      }
      return true;
    }
    return !line.sessionId || !sessionIds.has(line.sessionId);
  });
}

function turnKey(kind: "user" | "system", text: string, sessionId?: string): string {
  return `${kind}\0${sessionId ?? ""}\0${compact(text)}`;
}

function snapshotSuffixOverlap(snapshotText: string, liveText: string): number {
  if (!snapshotText || !liveText) return 0;
  // KMP prefix table: longest prefix of the live tail that is also the suffix of
  // the fetched snapshot. Matching only at the snapshot boundary avoids hiding
  // later chunks merely because a short token appeared earlier in the run.
  const input = `${liveText}\0${snapshotText.slice(-liveText.length)}`;
  const prefix = new Array<number>(input.length).fill(0);
  for (let i = 1; i < input.length; i++) {
    let j = prefix[i - 1] ?? 0;
    while (j > 0 && input[i] !== input[j]) j = prefix[j - 1] ?? 0;
    if (input[i] === input[j]) j++;
    prefix[i] = j;
  }
  return Math.min(prefix[input.length - 1] ?? 0, liveText.length);
}
