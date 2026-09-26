// 预览子进程的**环境卫生**与启动包装。从 preview-start.ts 搬出来，因为现在有两个人要用
// 同一份：正式预览（preview-start.ts）和「AI 协助」的试跑（preview-trial.ts）。抄成两份的
// 代价不是重复代码，是下面这几条来之不易的判断只会在其中一份里生效——而漏掉的那一份
// 恰恰是「看起来起来了、实际连着另一台 ash」这种最难查的症状。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { userShellLaunch } from "./platform.js";
import { augmentedEnv, withoutForeignNodeBins } from "./executors/spawn.js";
import { previewShell } from "./preview-shell.js";

/**
 * 预览子进程的基座环境。
 *
 * 除了去掉别人家的 `node_modules/.bin`（见 withoutForeignNodeBins），还要**擦掉从宿主 ash
 * 进程继承下来的这三个**：`ASH_PROXY`、它的旧名 `HARNESS_PROXY`（scripts/env.mjs 会把
 * `HARNESS_*` 提升成 `ASH_*`，留着等于绕道）、以及 `ASH_HOST_API`（嵌套预览时那份指的是外层
 * 那台 ash）。
 *
 * 因为「/api 打哪台」这件事上，**继承来的值一个都不是当事人的意思**：ash 是被谁怎么起的
 * （`ASH_PROXY=… npm run start`、systemd 里带一行、上一层预览传下来的）跟这次预览要连谁
 * 毫无关系。dev.mjs 又只看得见环境变量、分不清哪份是命令现场写的，于是照它的顺序，
 * 一个遗留值就能压掉我们确知的监听端口：默认「只起前端」的 /api 整个打去别处——端口关着
 * 是一页 500，端口上坐着另一台 ash 就是拿用户的身份静默读写错实例（第 7 轮审查 P1）。
 *
 * 擦掉不影响脚本自己写的那份：`ASH_PROXY=$URL2 npm run dev` 是 shell 在命令现场重新设的，
 * 照旧最大（第 6 轮审查 P1）。名字按大小写不敏感比对——Windows 的环境变量本来就不分大小写。
 *
 * **这一遍只够挡住直接继承**：POSIX 上命令还要过一层登录 shell，profile 能把同一个变量再
 * 写回来，所以擦第二遍的是下面的 afterLoginShell()。
 */
export function previewBaseEnv(cwd: string): NodeJS.ProcessEnv {
  const env = withoutForeignNodeBins(augmentedEnv(), cwd);
  for (const key of Object.keys(env)) {
    if (INHERITED_API_TARGETS.has(key.toUpperCase())) delete env[key];
  }
  return env;
}

const INHERITED_API_TARGETS = new Set(["ASH_PROXY", "HARNESS_PROXY", "ASH_HOST_API"]);

/**
 * 同样三个变量，**在登录 shell 读完用户 profile 之后**再擦一遍，然后把这次的 `ASH_HOST_API`
 * 重新交代一次；用户那条命令排在这些之后，照旧压得住（`ASH_PROXY=$URL2 npm run dev`）。
 *
 * previewBaseEnv() 那一遍擦不到这里：预览命令是 `sh -lc` 跑的，`-l` 是有意的（用户的 PATH
 * 常常靠 nvm/rbenv 在 `.profile` 里撑起来，见 platform.ts 的 userShellLaunch），而登录 shell
 * 会**在我们擦完之后**去读 `/etc/profile`、`~/.profile`。谁为日常开发在 profile 里写了一行
 * `export ASH_PROXY=…`，它就原样复活，dev.mjs 那边照样分不清是不是命令现场写的——默认
 * 「只起前端」的 /api 又整个打去那个地址（第 8 轮审查 P1，症状同第 7 轮：一页 500，或者
 * 静默读写另一台 ash）。
 *
 * 只管 POSIX：Windows 那条是 `cmd /d`，`/d` 明着跳过 AutoRun，cmd 也没有 profile 这种东西，
 * 没有「擦完之后又冒出来」的口子；win32 分支不看真机不改（根 AGENTS.md）。
 */
export function afterLoginShell(command: string, hostApiUrl: string | null): string {
  if (process.platform === "win32") return command;
  const lines = [`unset ${[...INHERITED_API_TARGETS].join(" ")}`];
  if (hostApiUrl) lines.push(`export ASH_HOST_API=${previewShell().quote(hostApiUrl)}`);
  return [...lines, command].join("\n");
}

export function previewScriptLaunch(command: string, dir: string, key: string) {
  if (process.platform !== "win32" || !/[\r\n]/.test(command)) return userShellLaunch(command);
  const path = join(dir, `preview-${key}.cmd`);
  writeFileSync(path, `@echo off\r\n@chcp 65001 >nul\r\n${command.replace(/\r\n?|\n/g, "\r\n")}\r\n`);
  return userShellLaunch(`call ${previewShell().quote(path)}`);
}
