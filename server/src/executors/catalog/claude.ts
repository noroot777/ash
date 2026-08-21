import { ClaudeExecutor } from "../claude.js";
import { resumeInner } from "../spawn.js";
import { relayRoot } from "../../llm.js";
import { claudeStreamJsonParser } from "./parsers.js";
import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS(bin 名逐个按官方文档核对过,2026-07)。
// 执行部分由 ClaudeExecutor 接管(常驻会话 openResident 只有它有),下面的 exec 只是
// 同一套参数的声明式副本:resume 展示与文档都读它,改 ClaudeExecutor 时同步这里。
export const claudeSpec: CliSpec = {
  key: "claude",
  name: "Claude Code",
  description: "Anthropic 官方 CLI",
  bins: ["claude"],
  docsUrl: "https://docs.claude.com/en/docs/claude-code/overview",
  installCommand: "npm install -g @anthropic-ai/claude-code",
  // npm 那条本来就跨平台,不用另给 Windows 版。这里只提 Git for Windows:
  // 官方 setup 页(2026-08-14 核对)说原生 Windows 上它是可选的,但装了才有 Bash 工具
  // (否则退到 PowerShell 工具);路径可用 CLAUDE_CODE_GIT_BASH_PATH 指定。ash 自己
  // 大量派 claude 干活,这条直接决定 agent 能不能跑 shell 命令,值得在界面上说一句。
  windowsNote: "可选装 Git for Windows:装了才有 Bash 工具(否则退到 PowerShell),路径可用 CLAUDE_CODE_GIT_BASH_PATH 指定。",
  factory: (opts) => new ClaudeExecutor(opts),
  exec: {
    // claude -p --output-format stream-json --verbose --include-partial-messages
    //        --dangerously-skip-permissions (--session-id|--resume) [--model m]
    baseArgs: [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
    ],
    prompt: { via: "stdin" },
    model: { flag: "--model" },
    reasoningEffort: { flag: "--effort" },
    // 1.5x:headless 下开 fast mode 的唯一官方通道(无 --fast flag)。
    fastArgs: ["--settings", '{"fastMode": true}'],
    session: {
      newIdFlag: "--session-id",
      resumeArgs: (id) => ["--resume", id],
      interactive: resumeInner.claude,
    },
    parser: claudeStreamJsonParser,
    // 供应商:BASE_URL 指到根地址(SDK 自己补 /v1,库里那份带了 /v1 得剥掉,
    // 否则打到 /v1/v1);key 只走 env,绝不进 argv。
    relay: (r) => ({
      env: { ANTHROPIC_BASE_URL: relayRoot(r.baseUrl), ANTHROPIC_AUTH_TOKEN: r.apiKey },
      envHint: `ANTHROPIC_BASE_URL=${relayRoot(r.baseUrl)} ANTHROPIC_AUTH_TOKEN=<你的key> `,
    }),
  },
};
