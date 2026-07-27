import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DATA_DIR } from "../paths.js";

export function resolveHarnessDbFile() {
  return resolve(process.env.HARNESS_DB ?? join(DATA_DIR, "harness.db"));
}

export function ensureHarnessDbDir(dbFile = resolveHarnessDbFile()) {
  mkdirSync(dirname(dbFile), { recursive: true });
}
