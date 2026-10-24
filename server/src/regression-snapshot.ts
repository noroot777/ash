import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RegressionSnapshot = { commit: string; tree: string };

export function regressionSnapshot(cwd: string): RegressionSnapshot | null {
  const temporary = mkdtempSync(join(tmpdir(), "ash-regression-index-"));
  try {
    const options = { cwd, encoding: "utf8" as const, windowsHide: true, timeout: 30_000,
      env: { ...process.env, GIT_INDEX_FILE: join(temporary, "index") } };
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], options).trim();
    const rooted = { ...options, cwd: root };
    const commit = execFileSync("git", ["rev-parse", "HEAD"], rooted).trim();
    execFileSync("git", ["read-tree", "HEAD"], rooted);
    execFileSync("git", ["-c", "core.splitIndex=false", "add", "--all", "--", "."], rooted);
    const tree = execFileSync("git", ["write-tree"], rooted).trim();
    return { commit, tree };
  } catch {
    return null;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
