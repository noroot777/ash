import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODE_DIR, DATA_DIR } from "./paths.js";

export function markRuntimeAdoption(): void {
  if (process.platform !== "darwin") return;
  const file = join(DATA_DIR, ".mac-runtime-recovery.json");
  if (!existsSync(file)) return;
  let record;
  try { record = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { console.warn("[navi] 忽略无法读取的运行时恢复记录", error); return; }
  if (!record || record.next !== realpathSync(CODE_DIR)) {
    console.warn("[navi] 忽略其他版本的运行时恢复记录");
    return;
  }
  const stage = `${file}.${process.pid}.partial`;
  writeFileSync(stage, JSON.stringify({ ...record, adopting: true }), { mode: 0o600 });
  renameSync(stage, file);
}
