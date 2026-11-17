import { parseArgs } from "node:util";

export function stopCommand(...args) {
  return ["node scripts/stop.mjs", ...args].join(" ");
}

export const STOP_USAGE = `用法: ${stopCommand()} [选项]

  --force      强制停止(会被打断的任务标为 failed;会被接管的照常保住)
  --wait       等会被打断的任务排空后再停止(--force 优先)
  --help, -h   显示帮助,不停止

以上 Node 命令适用于 PowerShell、cmd、Bash 和 zsh。
也可用 npm 启动: Windows 用 npm.cmd run stop -- [选项], macOS/Linux 用 npm run stop -- [选项]。
PowerShell 的 npm.ps1 可能吞掉 --,带选项时不要使用裸 npm。
仍兼容 FORCE、WAIT 环境变量(任意非空值启用)。
WAIT_TIMEOUT 环境变量可设置等待上限(秒)。`;

export function parseStopOptions(args = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      force: { type: "boolean" },
      wait: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  return {
    force: !!(values.force || env.FORCE),
    wait: !!(values.wait || env.WAIT),
    help: !!values.help,
  };
}
