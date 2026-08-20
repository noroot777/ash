import { homedir } from "node:os";
import { join } from "node:path";
import { splitProfileExtraArgs } from "@harness/shared/cli-args";

// 拆词那一半住在 shared/src/cli-args.ts —— 前端要用同一份判「这条额外参数会不会顶掉
// harness 写进去的配置」。这里只补 server 才做得了的那一半：`~` 展开(要读 homedir)。
function expandLocalHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function normalizeProfileExtraArgs(values: unknown): string[] {
  return splitProfileExtraArgs(values).map(expandLocalHome);
}
