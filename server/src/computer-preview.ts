import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@navi/shared";
import type { ComputerUseFrame } from "@navi/shared/task-runtime";
import { RUNS_DIR } from "./paths.js";

const frameFile = (taskId: string) => join(RUNS_DIR, taskId, "computer-preview.json");

export function recordComputerFrame(taskId: string, sessionId: string, turnStartedAt: string, at: string, event: AgentEvent): void {
  const activity = event.kind === "tool" && event.nativeWork?.type === "activity" ? event.nativeWork.event : event;
  if (activity.kind !== "attachment" || !activity.computer || !activity.path) return;
  const frame: ComputerUseFrame = { path: activity.path, tool: activity.computer, sessionId, turnStartedAt, at };
  const path = frameFile(taskId);
  mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(frame));
  renameSync(`${path}.tmp`, path);
}

export function computerUseFrame(taskId: string): ComputerUseFrame | null {
  try {
    const frame = JSON.parse(readFileSync(frameFile(taskId), "utf8")) as ComputerUseFrame;
    return [frame.path, frame.tool, frame.at, frame.sessionId, frame.turnStartedAt]
      .every((value) => typeof value === "string" && value.trim().length > 0) ? frame : null;
  } catch { return null; }
}

export function clearComputerFrame(taskId: string, sessionId: string): void {
  if (computerUseFrame(taskId)?.sessionId === sessionId) rmSync(frameFile(taskId), { force: true });
}
