import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { CODE_DIR, DATA_DIR } from "./paths.js";

export type RuntimeCompatibility = { protocol: number; schema: string };

export function runtimeCompatibility(): RuntimeCompatibility {
  const root = realpathSync(CODE_DIR);
  if (dirname(root) !== realpathSync(join(DATA_DIR, ".mac-runtimes"))) throw new Error("服务不是本数据根的受管运行时");
  const manifest = JSON.parse(readFileSync(join(root, ".runtime.json"), "utf8"));
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  if (manifest.format !== 1 || manifest.id !== basename(root) || manifest.id !== digest(JSON.stringify(manifest.entries))) throw new Error("运行时版本身份不符");
  const text = readFileSync(join(root, ".handover.json"), "utf8");
  if (!manifest.entries.some((entry: unknown[]) => entry[0] === ".handover.json" && entry[1] === "file" && entry[3] === digest(text))) throw new Error("运行时协议身份不符");
  const compatibility = JSON.parse(text);
  if (compatibility.protocol !== 1 || !/^[a-f0-9]{64}$/.test(compatibility.schema)) throw new Error("运行时协议不兼容");
  return compatibility;
}

export function assertRuntimeCompatibility(current: RuntimeCompatibility, next: Partial<RuntimeCompatibility>, active: boolean): void {
  if (next.protocol !== 1 || current.protocol !== next.protocol || !/^[a-f0-9]{64}$/.test(next.schema ?? "")) throw new Error("接管协议不兼容");
  if (active && current.schema !== next.schema) throw new Error("迁移兼容性不明，等待任务结束后再迁移");
}
