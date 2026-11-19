import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskBrowserState } from "@ash/shared/task-runtime";
import { RUNS_DIR } from "./paths.js";

export const browserFile = (taskId: string, extension: "json" | "png") => join(RUNS_DIR, taskId, `browser.${extension}`);

export function saveBrowser(taskId: string, state: TaskBrowserState): void {
  mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
  const path = browserFile(taskId, "json");
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}

export function lastBrowser(taskId: string): TaskBrowserState | null {
  try {
    const state = JSON.parse(readFileSync(browserFile(taskId, "json"), "utf8")) as TaskBrowserState;
    return state?.id && typeof state.url === "string" ? state : null;
  } catch { return null; }
}

export function browserFrame(taskId: string): Buffer | null {
  try { return readFileSync(browserFile(taskId, "png")); } catch { return null; }
}
