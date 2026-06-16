import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentType } from "@harness/shared";

const exec = promisify(execFile);

export interface DetectedAgent {
  type: AgentType;
  bin: string;
  available: boolean;
  path: string | null;
  version: string | null;
}

const CANDIDATES: { type: AgentType; bin: string }[] = [
  { type: "claude", bin: "claude" },
  { type: "codex", bin: "codex" },
  { type: "antigravity", bin: "antigravity" },
];

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await exec("which", [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function version(bin: string): Promise<string | null> {
  try {
    const { stdout } = await exec(bin, ["--version"], { timeout: 4000 });
    return (stdout.split("\n")[0] || "").trim() || null;
  } catch {
    return null;
  }
}

// Detect which known agent CLIs are installed locally (DESIGN.md §5/§0).
export async function detectLocalAgents(): Promise<DetectedAgent[]> {
  return Promise.all(
    CANDIDATES.map(async ({ type, bin }) => {
      const path = await which(bin);
      return { type, bin, available: !!path, path, version: path ? await version(bin) : null };
    }),
  );
}
