import { parseArgs } from "node:util";
import { DB_FILE_NAME } from "./db-file.mjs";
import { LEGACY_DB_FILE } from "./legacy-names.mjs";

export function upgradeCommand(...args) {
  return ["node scripts/upgrade.mjs", ...args].join(" ");
}

export const UPGRADE_USAGE = `用法: ${upgradeCommand()} [选项]

把这份检出升到远端最新:拉代码 → 停服务 → 备份库 → 装依赖、构建 → 库改名成 ${DB_FILE_NAME} → 起服务 → 核对数据。
第一次(改名之前的版本还没有这条命令)先 git pull,再 npm run upgrade;以后只跑 npm run upgrade。

  --wait          有任务在跑或排队时,等它们跑完再升(--force 优先)
  --force         明知有任务在跑也要升(在跑的任务交给新版接管,这条路没在真机上验过)
  --keep-db-name  不把 ${LEGACY_DB_FILE} 改成 ${DB_FILE_NAME}(想留着随时退回改名之前的版本时用;以后去掉它再跑一次就会改)
  --skip-mcp      不动各家 CLI 里的 MCP 登记,也不收旧的 MCP 进程
  --help, -h      显示帮助,什么都不做

按启动服务时那套环境变量跑:PORT(不设就按锁文件里记的端口,服务停着就按上次升级记下的,都没有才是 4317)、
NAVI_DATA_DIR、NAVI_DB(旧名 ASH_* 也认)。
有任务在跑或排队、工作区有没提交的改动、分支不能快进、远端拉不动、Node/npm 版本不够、数据目录认不准,
都在停服务之前拦下,什么都不改。重复跑是安全的:已是最新就说一句,不重启服务;上次做到一半的接着做完。

退出码:0 升好了 / 已是最新;1 中途失败(怎么接着做、怎么退回打在最后);2 拦下了,什么都没改;3 --wait 等超时。
以上 Node 命令适用于 PowerShell、cmd、Bash 和 zsh。
也可用 npm 启动: Windows 用 npm.cmd run upgrade -- [选项], macOS/Linux 用 npm run upgrade -- [选项]。
仍兼容 FORCE、WAIT、SKIP_MCP 环境变量(任意非空值启用);WAIT_TIMEOUT 设等待上限(秒)。`;

/**
 * `--continue` / `--pulled-from` 是自己给自己的:第一段拉完代码,用磁盘上那份**新的**升级脚本接着跑第二段
 * (内存里这份是旧的)。--pulled-from 是这一次拉之前的提交 —— 第二段在动服务之前被拦下时据此退回去。
 */
export function parseUpgradeOptions(args = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      force: { type: "boolean" },
      wait: { type: "boolean" },
      "keep-db-name": { type: "boolean" },
      "skip-mcp": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      continue: { type: "boolean" },
      "pulled-from": { type: "string" },
    },
  });
  if (values["pulled-from"] !== undefined && !/^[0-9a-f]{7,64}$/.test(values["pulled-from"])) {
    throw new Error(`--pulled-from 要一个提交号:${values["pulled-from"]}`);
  }
  return {
    force: !!(values.force || env.FORCE),
    wait: !!(values.wait || env.WAIT),
    keepDbName: !!values["keep-db-name"],
    skipMcp: !!(values["skip-mcp"] || env.SKIP_MCP),
    help: !!values.help,
    continue: !!values.continue,
    pulledFrom: values["pulled-from"] ?? null,
  };
}

/** 第二段要原样带上的用户选项(内部那两个不算)。 */
export function userArgs(args = process.argv.slice(2)) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--continue") continue;
    if (args[i] === "--pulled-from") { i += 1; continue; }
    if (args[i].startsWith("--pulled-from=")) continue;
    out.push(args[i]);
  }
  return out;
}
