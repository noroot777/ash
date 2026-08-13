import { homedir } from "node:os";
import { join } from "node:path";
import { splitProfileExtraArgs } from "@harness/shared/cli-args";
import type { ExecTarget } from "@harness/shared";

// 拆词那一半住在 shared/src/cli-args.ts —— 前端要用同一份判「这条额外参数会不会顶掉
// harness 写进去的配置」。这里只补 server 才做得了的那一半：`~` 展开(要读 homedir,
// 而且只对本机 target 成立,远端的家目录不是这台机器的)。
function expandLocalHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function normalizeProfileExtraArgs(values: unknown, target: ExecTarget): string[] {
  return splitProfileExtraArgs(values).map((value) =>
    target.kind === "local" ? expandLocalHome(value) : value,
  );
}
