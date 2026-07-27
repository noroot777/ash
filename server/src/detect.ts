import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentType } from "@harness/shared";
import { resolveExecutorFor } from "./executors/index.js";

const exec = promisify(execFile);

export interface DetectedAgent {
  type: AgentType;
  bin: string;
  available: boolean;
  path: string | null;
  version: string | null;
  /** 支持常驻会话(openResident)——只有这类 CLI 能当 /team 的调度者。 */
  resident: boolean;
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

// Detect which known agent CLIs are installed locally (DESIGN.md §5/§0)。
// `resident` 直接问执行器本人有没有 openResident —— 「谁能当调度者」只有这一个
// 真相来源,前端照着过滤就行,不用在 shared 里再抄一张名单出来漂移。
export async function detectLocalAgents(): Promise<DetectedAgent[]> {
  return Promise.all(
    CANDIDATES.map(async ({ type, bin }) => {
      const path = await which(bin);
      // 没装的 CLI 不去解析执行器(resolveExecutor 对无内置解析器的类型会 throw),
      // 直接算它不支持常驻 —— 反正启动器只在 available 的里面挑。
      return {
        type,
        bin,
        available: !!path,
        path,
        version: path ? await version(bin) : null,
        resident: path ? !!(await resolveExecutorFor({ type }).then((e) => e.openResident, () => null)) : false,
      };
    }),
  );
}
