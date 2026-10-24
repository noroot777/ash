import { parseArgs } from "node:util";

export const RESTART_USAGE = `用法: npm run restart -- [选项]

  --force      即使会打断任务也强制重启(被打断的任务标为 failed)
  --wait       等任务排空后再重启(--force 优先)
  --skip-mcp   不刷新 MCP,不打断正在使用 MCP 的会话
  --force-mcp  强制刷新 MCP(会掐断在跑的 agent 的 MCP 通道)
  --help, -h   显示帮助,不构建、不重启

以上参数适用于 PowerShell、cmd、Bash 和 zsh。
仍兼容 FORCE、WAIT、SKIP_MCP、FORCE_MCP 环境变量(任意非空值启用)。
WAIT_TIMEOUT 环境变量可设置等待上限(秒)。`;

export function parseRestartOptions(args = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      force: { type: "boolean" },
      wait: { type: "boolean" },
      "skip-mcp": { type: "boolean" },
      "force-mcp": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  return {
    force: !!(values.force || env.FORCE),
    wait: !!(values.wait || env.WAIT),
    skipMcp: !!(values["skip-mcp"] || env.SKIP_MCP),
    forceMcp: !!(values["force-mcp"] || env.FORCE_MCP),
    help: !!values.help,
  };
}
