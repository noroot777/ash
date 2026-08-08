import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const entry = fileURLToPath(import.meta.resolve("node-pty"));
  const root = dirname(dirname(entry));
  const helper = join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
