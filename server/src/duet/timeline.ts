import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerEvent } from "@harness/shared";
import { bus } from "../bus.js";
import { RUNS_DIR } from "../paths.js";
import { now } from "../util.js";

export function recordUserTurn(
  taskId: string,
  round: number,
  text: string,
  kind: "inject" | "ask",
  target?: "A" | "B",
) {
  const at = now();
  try {
    appendFileSync(
      join(RUNS_DIR, taskId, "transcript.jsonl"),
      JSON.stringify({ round, speaker: "user", text, at, target, kind }) + "\n",
    );
  } catch {
    /* best effort */
  }
  bus.publish({ type: "duet.user", taskId, round, text, at, target, kind });
}

export function recordGateEvent(event: Extract<ServerEvent, { type: "duet.gate" }>) {
  try {
    const runDir = join(RUNS_DIR, event.taskId);
    mkdirSync(runDir, { recursive: true });
    appendFileSync(join(runDir, "transcript.jsonl"), JSON.stringify(event) + "\n");
  } catch {
    /* best effort */
  }
  bus.publish(event);
}

export function recordTurnStart(event: Extract<ServerEvent, { type: "duet.progress" }> & { phase: "start" }) {
  try {
    const runDir = join(RUNS_DIR, event.taskId);
    mkdirSync(runDir, { recursive: true });
    appendFileSync(join(runDir, "transcript.jsonl"), JSON.stringify(event) + "\n");
  } catch {
    /* best effort */
  }
  bus.publish(event);
}
