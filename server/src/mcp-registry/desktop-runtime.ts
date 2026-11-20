import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { NaviMcpEntry } from "./types.js";

export function desktopRuntimeMcp(codeDir: string, dataDir: string, url: string): NaviMcpEntry | null {
  if (process.platform !== "darwin") return null;
  try {
    const runtime = realpathSync(codeDir);
    const store = realpathSync(join(dataDir, ".mac-runtimes"));
    const id = basename(runtime);
    if (dirname(runtime) !== store || !/^[a-f0-9]{64}$/.test(id)) return null;
    const manifest = JSON.parse(readFileSync(join(runtime, ".runtime.json"), "utf8"));
    const launcher = join(store, "mcp.sh");
    if (manifest.format !== 1 || manifest.id !== id || !existsSync(launcher)) return null;
    return { command: "/bin/sh", args: [launcher], env: { NAVI_URL: url } };
  } catch { return null; }
}
