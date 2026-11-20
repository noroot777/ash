import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODE_DIR, DATA_DIR } from "./paths.js";

export function markRuntimeAdoption(): void {
  if (process.platform !== "darwin") return;
  const file = join(DATA_DIR, ".runtime-recovery.json");
  if (!existsSync(file)) return;
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (record.next !== CODE_DIR.replace(/\/$/, "")) throw new Error("运行时恢复记录不属于本次启动");
  const stage = `${file}.${process.pid}.partial`;
  writeFileSync(stage, JSON.stringify({ ...record, adopting: true }), { mode: 0o600 });
  renameSync(stage, file);
}
