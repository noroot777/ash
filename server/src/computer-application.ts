import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ComputerUseTarget } from "@navi/shared/task-runtime";
import { validComputerTarget } from "./executors/computer-targets.js";

export function computerApplicationCommand(target: ComputerUseTarget): { file: string; args: string[] } {
  if (!validComputerTarget(target)) throw new Error("电脑操作的目标应用无效");
  const bundle = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}$/.test(target.application);
  return { file: "/usr/bin/open", args: [bundle ? "-b" : "-a", target.application] };
}

export async function activateComputerApplication(target: ComputerUseTarget): Promise<void> {
  if (process.platform !== "darwin") throw new Error("当前仅支持在本机 macOS 切换电脑操作应用");
  const command = computerApplicationCommand(target);
  await promisify(execFile)(command.file, command.args, { timeout: 5000 });
}
