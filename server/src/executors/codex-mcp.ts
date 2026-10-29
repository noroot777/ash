import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexInjectionTarget } from "../codex-toml.js";

const readConfig = (codexHome?: string): string => {
  const configPath = join(codexHome?.trim() || join(homedir(), ".codex"), "config.toml");
  try { return readFileSync(configPath, "utf8"); } catch { return ""; }
};

/**
 * 新安装统一叫 ash；尚未重跑 setup 的机器可能仍只有历史 harness 条目。
 * 判据和派审预检是同一份（`codex-toml.ts`）：预检说「接好了」的写法，这里一定认得出来。
 */
export function codexAshMcpServerName(codexHome = process.env.CODEX_HOME): string | null {
  return codexInjectionTarget(readConfig(codexHome));
}
