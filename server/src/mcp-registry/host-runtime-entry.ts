import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CODE_DIR, DATA_DIR } from "../paths.js";
import { DESKTOP_APP } from "../local-only.js";
import type { NaviMcpEntry } from "./types.js";

const source = (() => {
  if (process.platform !== "darwin" || !DESKTOP_APP) return null;
  try {
    const origin = realpathSync(process.env.NAVI_MAC_SOURCE_RUNTIME!);
    const code = realpathSync(CODE_DIR);
    if (!origin.endsWith(".app/Contents/Resources/app") || dirname(code) !== realpathSync(join(DATA_DIR, ".runtimes"))) return null;
    const envelope = JSON.parse(readFileSync(join(origin, "runtime-manifest.json"), "utf8"));
    if (envelope.id !== basename(code) || createHash("sha256").update(envelope.payload).digest("hex") !== envelope.id) return null;
    return origin;
  } catch { return null; }
})();

export function hostRuntimeEntry(url: string): NaviMcpEntry | null {
  if (!source || !existsSync(join(source, "mcp/dist/index.js")) || !existsSync(join(source, "node/bin/node"))) return null;
  return { command: join(source, "node/bin/node"), args: [join(source, "mcp/dist/index.js")],
    env: { NAVI_URL: url, NAVI_DATA_DIR: DATA_DIR } };
}
