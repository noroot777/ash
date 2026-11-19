import { parseArgs } from "node:util";

export function stopCommand(...args) {
  return ["node scripts/stop.mjs", ...args].join(" ");
}

export const STOP_USAGE = `用法: ${stopCommand()} [选项]

  --force      强制停止(会被打断的任务标为 failed;会被接管的照常保住)
  --pid <n> --born <t>
               只结束这一个没在应答的服务进程(升级打印的退回命令里用,两个值照抄),等它真的退出才算完;
               出生时刻对得上、确实在跑服务入口才动手。等满 STOP_PID_TIMEOUT 秒(默认 60)还不退时,加 --force 强行结束
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
      pid: { type: "string" },
      born: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.pid !== undefined && !(/^\d+$/.test(values.pid) && Number(values.pid) > 1)) throw new Error(`--pid 要一个进程号,收到的是 ${values.pid}`);
  if ((values.pid === undefined) !== (values.born === undefined)) throw new Error("--pid 和 --born 要一起给(照抄升级打印的那一行)");
  if (values.born !== undefined && !/^w?\d+$/.test(values.born)) throw new Error(`--born 要升级记下的出生时刻,收到的是 ${values.born}`);
  return {
    force: !!(values.force || env.FORCE),
    wait: !!(values.wait || env.WAIT),
    pid: values.pid === undefined ? null : Number(values.pid),
    born: values.born ?? null,
    help: !!values.help,
  };
}
